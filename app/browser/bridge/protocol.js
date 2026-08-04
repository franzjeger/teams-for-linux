'use strict';

/**
 * Bridge Protocol
 *
 * Message format and validation for the main-world agent bridge described in
 * ADR 020. Kept free of Electron and DOM APIs so the security-critical decisions
 * can be unit tested directly.
 *
 * Direction of travel:
 *
 *   isolated world (preload, owns ipcRenderer)
 *        │  request   ── "run this capability in the page world"
 *        ▼
 *   main-world agent (owns React internals and page globals)
 *        │  response  ── correlated answer to a request
 *        │  event     ── agent-initiated notification
 *        ▼
 *   isolated world
 *
 * WHAT THE SESSION ID IS AND IS NOT
 *
 * Every envelope carries a per-session random id. The agent runs in the page
 * world, so any script sharing that world can observe the traffic and read the
 * id. It is therefore NOT a secret and NOT an authentication token. It exists to
 * stop unrelated `postMessage` traffic - other embedders, extensions, Teams
 * itself - from being mistaken for bridge messages.
 *
 * The actual security controls are:
 *
 *   1. `acceptedChannels` - the isolated world only acts on channels it has
 *      explicitly opted into, and that set must stay narrower than the IPC
 *      surface behind it.
 *   2. `validators` - a per-channel payload check that runs before anything
 *      reaches `ipcRenderer`.
 *   3. `pendingIds` - a response is only honoured if it answers a request this
 *      side actually issued, so the page cannot inject unsolicited answers.
 *
 * Treating the session id as a security boundary would reproduce exactly the
 * failure ADR 020 warns about: a bridge that forwards unvalidated page messages
 * while looking secure.
 */

const PROTOCOL_VERSION = 1;
const MARKER = "__teamsForLinuxBridge";

const KIND_REQUEST = "request";
const KIND_RESPONSE = "response";
const KIND_EVENT = "event";

/** Kinds the isolated world is willing to receive from the page world. */
const INBOUND_KINDS = new Set([KIND_RESPONSE, KIND_EVENT]);

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Rejects payloads carrying keys that would pollute a prototype when merged.
 * structuredClone already strips functions, so only key names need checking.
 */
function hasUnsafeKeys(value, depth = 0) {
  if (depth > 10) return true;

  if (Array.isArray(value)) {
    return value.some((item) => hasUnsafeKeys(item, depth + 1));
  }
  if (!isPlainObject(value)) return false;

  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) return true;
    if (hasUnsafeKeys(value[key], depth + 1)) return true;
  }
  return false;
}

/**
 * Builds an envelope for sending. Callers are responsible for supplying an id
 * for requests and responses; events carry none.
 */
function createEnvelope({ sessionId, kind, id, channel, payload }) {
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("bridge: sessionId is required");
  }
  if (kind !== KIND_REQUEST && kind !== KIND_RESPONSE && kind !== KIND_EVENT) {
    throw new Error(`bridge: unknown kind '${kind}'`);
  }
  if (typeof channel !== "string" || channel === "") {
    throw new Error("bridge: channel is required");
  }
  if (kind !== KIND_EVENT && (typeof id !== "string" || id === "")) {
    throw new Error(`bridge: id is required for '${kind}'`);
  }

  const envelope = {
    [MARKER]: sessionId,
    v: PROTOCOL_VERSION,
    kind,
    channel,
    payload: payload === undefined ? null : payload,
  };
  if (kind !== KIND_EVENT) {
    envelope.id = id;
  }
  return envelope;
}

/**
 * Validates a message arriving in the isolated world from the page world.
 *
 * Checks run cheapest-and-most-discriminating first so ordinary unrelated
 * postMessage traffic is rejected without touching the payload.
 *
 * @param {unknown} message - the raw `event.data`
 * @param {object} options
 * @param {string} options.sessionId - id issued by this side at startup
 * @param {Set<string>|Array<string>} options.acceptedChannels
 * @param {Set<string>} [options.pendingIds] - ids of in-flight requests
 * @param {Record<string, (payload: unknown) => boolean>} [options.validators]
 * @returns {{ok: true, kind: string, channel: string, id: string|null, payload: unknown}
 *          |{ok: false, reason: string}}
 */
function validateInbound(message, options) {
  const {
    sessionId,
    acceptedChannels,
    pendingIds = new Set(),
    validators = {},
  } = options ?? {};

  if (!isPlainObject(message)) {
    return { ok: false, reason: "not a plain object" };
  }
  // Not a bridge message at all - the common case for unrelated traffic.
  if (message[MARKER] !== sessionId) {
    return { ok: false, reason: "session id mismatch" };
  }
  if (message.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: "protocol version mismatch" };
  }
  if (!INBOUND_KINDS.has(message.kind)) {
    return { ok: false, reason: `kind '${message.kind}' not accepted inbound` };
  }

  const channels =
    acceptedChannels instanceof Set ? acceptedChannels : new Set(acceptedChannels ?? []);
  if (typeof message.channel !== "string" || !channels.has(message.channel)) {
    return { ok: false, reason: "channel not accepted" };
  }

  let id = null;
  if (message.kind === KIND_RESPONSE) {
    if (typeof message.id !== "string" || message.id === "") {
      return { ok: false, reason: "response without an id" };
    }
    // Rejects answers to requests this side never made, including replays.
    if (!pendingIds.has(message.id)) {
      return { ok: false, reason: "response does not match a pending request" };
    }
    id = message.id;
  }

  if (hasUnsafeKeys(message.payload)) {
    return { ok: false, reason: "payload contains unsafe keys" };
  }

  const validator = Object.hasOwn(validators, message.channel)
    ? validators[message.channel]
    : null;
  if (typeof validator === "function") {
    let accepted;
    try {
      // Must be exactly true; a truthy value is not an approval.
      accepted = validator(message.payload) === true;
    } catch {
      return { ok: false, reason: "payload validator threw" };
    }
    if (!accepted) {
      return { ok: false, reason: "payload rejected by validator" };
    }
  }

  return {
    ok: true,
    kind: message.kind,
    channel: message.channel,
    id,
    payload: message.payload,
  };
}

/**
 * True when a MessageEvent originates from this page rather than an embedded
 * frame or another window. Separate from `validateInbound` because it needs the
 * event, not just the data.
 *
 * @param {{source: unknown, origin: string}} event
 * @param {{expectedSource: unknown, expectedOrigin: string}} options
 */
function isSameWindowEvent(event, { expectedSource, expectedOrigin }) {
  if (!event || event.source !== expectedSource) return false;
  // A sandboxed or data: document reports "null"; never treat that as our page.
  if (typeof event.origin !== "string" || event.origin === "" || event.origin === "null") {
    return false;
  }
  return event.origin === expectedOrigin;
}

module.exports = {
  PROTOCOL_VERSION,
  MARKER,
  KIND_REQUEST,
  KIND_RESPONSE,
  KIND_EVENT,
  createEnvelope,
  validateInbound,
  isSameWindowEvent,
  // Exported for tests
  isPlainObject,
  hasUnsafeKeys,
};
