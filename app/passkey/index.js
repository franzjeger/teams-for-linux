'use strict';

/**
 * Passkey Bridge IPC Handlers
 *
 * The main-process half of the WebAuthn shim. The renderer supplies only a
 * challenge and the credential filters; everything that authenticates the
 * ceremony - the origin, and the rpId derived from it - is taken from the
 * sending frame's URL here.
 *
 * That split is the whole point. Arca binds `rp_id` to `origin` as an
 * anti-phishing check, and with `contextIsolation` disabled anything the page
 * hands us is page-controlled. If the renderer could name its own origin, a
 * compromised page could have Arca sign for any relying party it liked.
 *
 * Failures return `{ ok: false }` rather than rejecting, so the shim can fall
 * back to Chromium's own handler. The single exception is `excluded`, which
 * WebAuthn requires the page to see as InvalidStateError.
 */

const ceremony = require("./ceremony");
const arca = require("./arcaClient");

const GET_CHANNEL = "passkey-get";
const CREATE_CHANNEL = "passkey-create";

/** No origins, rpIds or credential ids in logs - all of them identify a tenant. */
function logFallback(kind, reason) {
  console.debug("[PASSKEY] Falling back to the browser handler", { kind, reason });
}

/**
 * Derives the ceremony origin from the frame that asked, never from its payload.
 *
 * Entra runs the ceremony inside an iframe, so the top-level window URL is the
 * wrong binding; `senderFrame` is the frame that actually called
 * navigator.credentials.
 */
function frameOrigin(event) {
  const url = event?.senderFrame?.url;
  if (typeof url !== "string" || url === "") {
    throw new ceremony.CeremonyError("passkey: sender frame has no URL");
  }
  try {
    // The origin, not the full URL: it is what clientData carries and what
    // Arca's anti-phishing check compares against.
    return new URL(url).origin;
  } catch {
    throw new ceremony.CeremonyError("passkey: sender frame URL is not parseable");
  }
}

/** Everything the two ceremonies share: origin, rpId and clientData. */
function prepare(event, payload, type) {
  const origin = frameOrigin(event);
  const rpId = ceremony.resolveRpId(origin, payload?.rpId);
  const { clientDataJSON, clientDataHash } = ceremony.buildClientData(
    type,
    payload?.challenge,
    origin
  );
  return { origin, rpId, clientDataJSON, clientDataHash };
}

/**
 * Turns any failure into the reply shape the shim expects.
 *
 * Arca's `excluded` is the one reason a page is entitled to; every other
 * failure - locked vault, no matching credential, user declined, Arca not
 * running, a malformed request - is indistinguishable to the page from "this
 * provider had nothing", which is exactly what fallback means.
 */
function toFailure(kind, error) {
  if (error instanceof arca.ArcaRequestError && error.surfaceToPage) {
    return { ok: false, reason: error.reason, surfaceToPage: true };
  }
  const reason = error?.reason ?? "unavailable";
  if (error instanceof ceremony.CeremonyError) {
    // A rejected rpId is the shape a phishing attempt takes, so it is worth a
    // warning rather than a debug line. The message names no origin or rpId.
    console.warn("[PASSKEY] Rejected a malformed ceremony request", { kind });
  } else {
    logFallback(kind, reason);
  }
  return { ok: false, reason };
}

async function handleGet(event, payload, deps = {}) {
  const { getAssertion = arca.getAssertion } = deps;
  try {
    const { origin, rpId, clientDataJSON, clientDataHash } = prepare(
      event,
      payload,
      "webauthn.get"
    );

    const assertion = await getAssertion({
      origin,
      rpId,
      clientDataHash,
      allowCredentials: ceremony.normaliseCredentialList(payload?.allowCredentials),
    });

    return {
      ok: true,
      credentialId: assertion.credentialId,
      clientDataJSON,
      authenticatorData: assertion.authenticatorData,
      signature: assertion.signature,
      userHandle: assertion.userHandle ?? null,
    };
  } catch (error) {
    return toFailure("get", error);
  }
}

async function handleCreate(event, payload, deps = {}) {
  const { createCredential = arca.createCredential } = deps;
  try {
    // Arca's passkey_create takes no client_data_hash - it is not signed over
    // in the attestation - but the clientDataJSON still has to be built here so
    // the page receives the same origin Arca was told about.
    const { origin, rpId, clientDataJSON } = prepare(event, payload, "webauthn.create");

    const credential = await createCredential({
      origin,
      rpId,
      userName: typeof payload?.userName === "string" ? payload.userName : "",
      userHandle: ceremony.toByteArray(payload?.userHandle) ?? [],
      excludeCredentials: ceremony.normaliseCredentialList(payload?.excludeCredentials),
    });

    return {
      ok: true,
      credentialId: credential.credentialId,
      clientDataJSON,
      attestationObject: credential.attestationObject,
    };
  } catch (error) {
    return toFailure("create", error);
  }
}

/**
 * Registers the two ceremony channels.
 *
 * The `enabled` gate lives here rather than in the preload because the preload
 * shares the page's world: a switch the page can reach is not a switch. Leaving
 * the handlers registered and returning a failure keeps the disabled path on
 * the same fallback route as "Arca is not running".
 */
function registerPasskeyHandlers(ipcMain, config) {
  // Channel names are spelled out at the registrations below rather than passed
  // as constants, because scripts/generateIpcDocs.js scans for string literals.
  // The exported constants are asserted against them in the unit tests.
  const enabled = config?.passkey?.enabled !== false;
  if (!enabled) {
    console.info("[PASSKEY] Bridge disabled by configuration");
  }

  // Request a WebAuthn assertion from the local passkey provider
  ipcMain.handle("passkey-get", (event, payload) =>
    enabled ? handleGet(event, payload) : { ok: false, reason: "disabled" }
  );

  // Request a new WebAuthn credential from the local passkey provider
  ipcMain.handle("passkey-create", (event, payload) =>
    enabled ? handleCreate(event, payload) : { ok: false, reason: "disabled" }
  );
}

module.exports = {
  GET_CHANNEL,
  CREATE_CHANNEL,
  registerPasskeyHandlers,
  handleGet,
  handleCreate,
  frameOrigin,
};
