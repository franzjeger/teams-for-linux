'use strict';

/**
 * WebAuthn Ceremony Helpers
 *
 * Pure logic for the main-process half of a passkey ceremony, kept free of
 * Electron so the security-relevant decisions are directly testable.
 *
 * The important property here is that the *origin* and the *clientData* are
 * built in the main process, never in the renderer. Arca binds `rp_id` to
 * `origin` as an anti-phishing check. With `contextIsolation` disabled anything
 * the page hands us is page-controlled, so a page that could choose its own
 * origin could have Arca sign for any relying party it liked.
 *
 * The renderer therefore supplies only the challenge and the credential
 * filters; everything that authenticates the request comes from the frame URL.
 */

const crypto = require("node:crypto");

/**
 * A request that never should have been made.
 *
 * Distinguished from "no provider available" so a rejected rpId - the shape a
 * phishing attempt would take - is logged as a security event rather than
 * disappearing into the ordinary fallback path.
 */
class CeremonyError extends Error {
  constructor(message) {
    super(message);
    this.name = "CeremonyError";
    this.reason = "invalid-request";
  }
}

/** Bytes cross IPC as arrays of integers, matching Arca's wire format. */
function toByteArray(value) {
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map((n) => n & 0xff);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  return null;
}

/** WebAuthn encodes binary fields as base64url without padding. */
function base64url(bytes) {
  return Buffer.from(Uint8Array.from(bytes))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * Validates a page-supplied rpId against the authoritative frame origin.
 *
 * WebAuthn allows a relying party to scope a credential to a registrable parent
 * domain, so `login.microsoft.com` may legitimately ask for `microsoft.com`.
 * It may not ask for an unrelated domain, and it may not ask for a bare public
 * suffix. Without this check a page could ask Arca to sign for any relying
 * party by simply naming it.
 *
 * @param {string} origin - from the frame URL, not the renderer
 * @param {string} [requestedRpId] - what the page asked for
 * @returns {string} the rpId to use
 */
function resolveRpId(origin, requestedRpId) {
  let host;
  let protocol;
  try {
    const url = new URL(origin);
    host = url.hostname.toLowerCase();
    protocol = url.protocol;
  } catch {
    throw new CeremonyError("passkey: frame origin is not a valid URL");
  }

  // WebAuthn is https-only, with localhost as the sole exception.
  if (protocol !== "https:" && host !== "localhost") {
    throw new CeremonyError("passkey: ceremonies require a secure origin");
  }

  if (requestedRpId === undefined || requestedRpId === null || requestedRpId === "") {
    return host;
  }
  if (typeof requestedRpId !== "string") {
    throw new CeremonyError("passkey: rpId must be a string");
  }

  const rpId = requestedRpId.toLowerCase();
  if (rpId === host) return rpId;

  // A registrable parent domain is allowed; an unrelated one is not.
  // "a.example.com" may claim "example.com" but not "example.co" or "com".
  if (host.endsWith(`.${rpId}`) && rpId.includes(".")) {
    return rpId;
  }

  throw new CeremonyError(`passkey: rpId '${requestedRpId}' is not valid for this origin`);
}

/**
 * Builds the clientDataJSON and its hash.
 *
 * Arca signs over the hash, and the relying party verifies the JSON, so the two
 * must be produced from the same bytes. Building both here keeps the origin the
 * page sees identical to the one Arca was told about.
 *
 * @param {"webauthn.get"|"webauthn.create"} type
 * @param {number[]} challenge
 * @param {string} origin
 * @returns {{clientDataJSON: number[], clientDataHash: number[]}}
 */
function buildClientData(type, challenge, origin) {
  if (type !== "webauthn.get" && type !== "webauthn.create") {
    throw new CeremonyError(`passkey: unknown ceremony type '${type}'`);
  }
  const bytes = toByteArray(challenge);
  if (!bytes || bytes.length === 0) {
    throw new CeremonyError("passkey: challenge is required");
  }

  const clientData = {
    type,
    challenge: base64url(bytes),
    origin,
    crossOrigin: false,
  };

  const json = Buffer.from(JSON.stringify(clientData), "utf8");
  const hash = crypto.createHash("sha256").update(json).digest();

  return {
    clientDataJSON: Array.from(json),
    clientDataHash: Array.from(hash),
  };
}

/**
 * Normalises the credential filters a page supplies.
 *
 * Only the raw ids matter to Arca; transports and other hints are dropped
 * rather than forwarded, so a page cannot smuggle extra fields through.
 */
function normaliseCredentialList(list) {
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const entry of list) {
    const bytes = toByteArray(entry?.id ?? entry);
    if (bytes && bytes.length > 0) result.push(bytes);
  }
  return result;
}

module.exports = {
  CeremonyError,
  toByteArray,
  base64url,
  resolveRpId,
  buildClientData,
  normaliseCredentialList,
};
