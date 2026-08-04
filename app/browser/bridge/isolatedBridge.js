'use strict';

/**
 * Isolated-World Bridge
 *
 * Runs in the preload. Owns `ipcRenderer` and never exposes it. Injects the
 * main-world agent as a script element, then exchanges correlated messages with
 * it over `window.postMessage`.
 *
 * See ADR 020 for why this indirection exists: under `contextIsolation: true`
 * the preload cannot see page-world state such as React's `_reactRootContainer`
 * expando, and cannot patch page globals like `getUserMedia`. Code that must
 * touch those things has to run in the page world, which in turn cannot reach
 * `ipcRenderer`.
 *
 * Nothing uses this yet. It is stage 2 of the migration and ships inert on
 * purpose, so the protocol can be reviewed and tested before any tool depends
 * on it.
 */

const {
  KIND_REQUEST,
  KIND_RESPONSE,
  KIND_EVENT,
  createEnvelope,
  validateInbound,
  isSameWindowEvent,
} = require("./protocol");

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

class IsolatedBridge {
  #sessionId;
  #window;
  #acceptedChannels;
  #validators;
  #eventHandlers = new Map();
  #pending = new Map();
  #started = false;
  #messageListener = null;
  #requestCounter = 0;

  /**
   * @param {object} options
   * @param {Window} options.window - the preload's window
   * @param {string} options.sessionId - random id, see protocol.js on what it does not do
   * @param {string[]} [options.acceptedChannels] - channels the agent may send on
   * @param {Record<string, Function>} [options.validators] - per-channel payload checks
   */
  constructor({ window, sessionId, acceptedChannels = [], validators = {} }) {
    if (!window) throw new Error("bridge: window is required");
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error("bridge: sessionId is required");
    }
    this.#window = window;
    this.#sessionId = sessionId;
    this.#acceptedChannels = new Set(acceptedChannels);
    this.#validators = validators;
  }

  get sessionId() {
    return this.#sessionId;
  }

  /** Channels the agent is currently allowed to send on. */
  get acceptedChannels() {
    return new Set(this.#acceptedChannels);
  }

  /**
   * Registers a handler for an agent-initiated event.
   * The channel must already be accepted, so the allowlist stays the single
   * place that decides what this side will act on.
   */
  on(channel, handler) {
    if (!this.#acceptedChannels.has(channel)) {
      throw new Error(`bridge: channel '${channel}' is not accepted`);
    }
    if (typeof handler !== "function") {
      throw new Error("bridge: handler must be a function");
    }
    this.#eventHandlers.set(channel, handler);
  }

  start() {
    if (this.#started) return;
    this.#messageListener = (event) => this.#onMessage(event);
    this.#window.addEventListener("message", this.#messageListener);
    this.#started = true;
  }

  stop() {
    if (!this.#started) return;
    this.#window.removeEventListener("message", this.#messageListener);
    this.#messageListener = null;
    this.#started = false;

    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("bridge: stopped"));
    }
    this.#pending.clear();
  }

  /**
   * Asks the agent to run a capability and waits for its correlated response.
   *
   * @returns {Promise<unknown>}
   */
  request(channel, payload, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (!this.#started) {
      return Promise.reject(new Error("bridge: not started"));
    }

    const id = `${this.#sessionId}:${++this.#requestCounter}`;
    const envelope = createEnvelope({
      sessionId: this.#sessionId,
      kind: KIND_REQUEST,
      id,
      channel,
      payload,
    });

    return new Promise((resolve, reject) => {
      // Deliberately not unref'd: in the renderer setTimeout returns a number
      // and unref does not exist, while under Node it would stop the timer
      // holding the loop and the timeout would never fire.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`bridge: request '${channel}' timed out`));
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer, channel });

      try {
        // targetOrigin is the page's own origin; the agent shares this window.
        this.#window.postMessage(envelope, this.#window.location.origin);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #onMessage(event) {
    if (
      !isSameWindowEvent(event, {
        expectedSource: this.#window,
        expectedOrigin: this.#window.location?.origin,
      })
    ) {
      return;
    }

    const result = validateInbound(event.data, {
      sessionId: this.#sessionId,
      acceptedChannels: this.#acceptedChannels,
      pendingIds: new Set(this.#pending.keys()),
      validators: this.#validators,
    });

    if (!result.ok) {
      // Unrelated postMessage traffic is normal and must not be noisy. Only
      // messages that claimed to be ours but failed a later check are worth
      // reporting, and never with the payload attached.
      if (result.reason !== "session id mismatch" && result.reason !== "not a plain object") {
        console.warn("[BRIDGE] Rejected inbound message", { reason: result.reason });
      }
      return;
    }

    if (result.kind === KIND_RESPONSE) {
      this.#resolvePending(result);
      return;
    }

    if (result.kind === KIND_EVENT) {
      const handler = this.#eventHandlers.get(result.channel);
      if (!handler) return;
      try {
        handler(result.payload);
      } catch (error) {
        console.error("[BRIDGE] Event handler threw", {
          channel: result.channel,
          message: error.message,
        });
      }
    }
  }

  #resolvePending({ id, channel, payload }) {
    const pending = this.#pending.get(id);
    if (!pending) return;

    // An id is only ever valid for the channel it was issued on, so a response
    // cannot be redirected to a different capability's handler.
    if (pending.channel !== channel) {
      console.warn("[BRIDGE] Response channel does not match request", { channel });
      return;
    }

    clearTimeout(pending.timer);
    this.#pending.delete(id);

    if (isPlainErrorPayload(payload)) {
      pending.reject(new Error(String(payload.error).slice(0, 500)));
      return;
    }
    pending.resolve(payload);
  }
}

function isPlainErrorPayload(payload) {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof payload.error === "string"
  );
}

/**
 * Injects the agent into the page world.
 *
 * A script element is used rather than `executeJavaScript` because the preload
 * has no way to reach the main world directly. The element is removed once it
 * has run; the code it defined stays resident.
 *
 * @param {Document} document
 * @param {string} source - agent source, already parameterised with the session id
 */
function injectAgent(document, source) {
  const script = document.createElement("script");
  script.textContent = source;
  const parent = document.head || document.documentElement;
  if (!parent) {
    throw new Error("bridge: no document element to inject into");
  }
  parent.appendChild(script);
  script.remove();
}

module.exports = {
  IsolatedBridge,
  injectAgent,
  KIND_REQUEST,
  KIND_RESPONSE,
  KIND_EVENT,
  DEFAULT_REQUEST_TIMEOUT_MS,
};
