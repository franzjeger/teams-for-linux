'use strict';

/**
 * Main-World Agent Runtime
 *
 * This module is not required by the preload. Its source is read from disk and
 * injected into the page world, where it runs with access to React internals
 * and page globals but with no access to `ipcRenderer` or Node.
 *
 * It is written as a single self-invoking function taking a config object so it
 * can be serialised with `buildAgentSource()` below.
 *
 * Capabilities are registered by name. The isolated world can only invoke a
 * capability that has been registered here AND allowlisted on its side, so both
 * halves have to agree before anything runs.
 */

/**
 * The agent body. Stringified, not called directly in the preload.
 *
 * @param {{sessionId: string, marker: string, version: number}} config
 */
function agentMain(config) {
  const { sessionId, marker, version } = config;

  const capabilities = new Map();

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function post(envelope) {
    globalThis.postMessage(envelope, globalThis.location.origin);
  }

  function reply(id, channel, payload) {
    post({ [marker]: sessionId, v: version, kind: "response", id, channel, payload });
  }

  function emit(channel, payload) {
    post({
      [marker]: sessionId,
      v: version,
      kind: "event",
      channel,
      payload: payload === undefined ? null : payload,
    });
  }

  async function handleRequest(message) {
    const { id, channel, payload } = message;
    const capability = capabilities.get(channel);

    if (!capability) {
      reply(id, channel, { error: `unknown capability '${channel}'` });
      return;
    }

    try {
      const result = await capability(payload);
      reply(id, channel, result === undefined ? null : result);
    } catch (error) {
      // Only the message crosses back; a stack could carry page internals.
      reply(id, channel, { error: String(error?.message ?? error).slice(0, 500) });
    }
  }

  globalThis.addEventListener("message", (event) => {
    if (event.source !== globalThis) return;
    const message = event.data;
    if (!isPlainObject(message)) return;
    if (message[marker] !== sessionId) return;
    if (message.v !== version) return;
    // The agent only ever acts on requests; it never consumes its own replies.
    if (message.kind !== "request") return;
    if (typeof message.id !== "string" || typeof message.channel !== "string") return;

    handleRequest(message);
  });

  const api = {
    /** Registers a capability the isolated world may invoke by name. */
    register(channel, handler) {
      if (typeof channel !== "string" || channel === "") {
        throw new Error("agent: channel must be a non-empty string");
      }
      if (typeof handler !== "function") {
        throw new Error("agent: handler must be a function");
      }
      capabilities.set(channel, handler);
    },
    /** Sends an agent-initiated notification to the isolated world. */
    emit,
    has(channel) {
      return capabilities.has(channel);
    },
  };

  // Namespaced under a session-specific key so page scripts cannot squat a
  // predictable global, and so two injections cannot collide.
  Object.defineProperty(globalThis, `__tflAgent_${sessionId}`, {
    value: api,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return api;
}

/**
 * Serialises the agent for injection.
 *
 * The config is JSON-encoded rather than interpolated as bare text so a value
 * containing quotes or a script-closing sequence cannot break out of the
 * literal.
 *
 * @param {{sessionId: string, marker: string, version: number}} config
 * @returns {string} source ready to be placed in a script element
 */
function buildAgentSource(config) {
  if (typeof config?.sessionId !== "string" || config.sessionId === "") {
    throw new Error("agent: sessionId is required");
  }
  if (typeof config.marker !== "string" || config.marker === "") {
    throw new Error("agent: marker is required");
  }
  if (!Number.isInteger(config.version)) {
    throw new Error("agent: version must be an integer");
  }

  const encoded = JSON.stringify(config).replaceAll("<", "\\u003c");
  return `(${agentMain.toString()})(${encoded});`;
}

module.exports = { agentMain, buildAgentSource };
