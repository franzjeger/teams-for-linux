'use strict';

/**
 * Arca Passkey Bridge Client
 *
 * Linux has no platform authenticator, so Chromium's own WebAuthn handler has
 * nothing to offer when Entra asks for a passkey. Arca holds the credential and
 * can sign the assertion; in a browser it does this through a Chrome extension,
 * which cannot help inside Electron - no extensions are loaded, and the
 * extension's transport (`chrome.runtime.sendNativeMessage`) does not exist here.
 *
 * This client talks to Arca's loopback bridge directly. The native-messaging
 * host that Chrome requires is only a stdio adapter; the main process has Node
 * and can open the socket itself.
 *
 * Protocol: TCP to 127.0.0.1, newline-delimited JSON, one object per line.
 * Authenticate with `hello`, then exactly one request and one response.
 * All byte fields are arrays of integers, not base64.
 */

const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

/** Discovery file, mode 0600, holding { port, token }. */
const BRIDGE_FILE = path.join(
  os.homedir(),
  ".local",
  "share",
  "no.sybr.vault",
  "native-bridge.json"
);

/**
 * A `passkey_get` blocks until the user types their master password in Arca's
 * window. The brief specifies up to 30 seconds; allow a little headroom so the
 * timeout attributable to us is clearly distinct from Arca's own.
 */
const REQUEST_TIMEOUT_MS = 35_000;
const CONNECT_TIMEOUT_MS = 3_000;

/**
 * Errors Arca can return. Every one means "we cannot service this", so the
 * caller falls back to Chromium's real handler - except `excluded`, which the
 * WebAuthn spec requires be surfaced to the page as InvalidStateError.
 */
const ARCA_ERRORS = new Set([
  "locked",
  "not_found",
  "denied",
  "origin_mismatch",
  "passkeys_disabled",
  "excluded",
  "internal",
]);

/** The only error that must reach the page rather than triggering fallback. */
const MUST_SURFACE = "excluded";

class ArcaUnavailableError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "ArcaUnavailableError";
    this.reason = reason;
  }
}

class ArcaRequestError extends Error {
  constructor(reason) {
    super(`arca: ${reason}`);
    this.name = "ArcaRequestError";
    this.reason = reason;
    /** True when the page must see a DOMException instead of a fallback. */
    this.surfaceToPage = reason === MUST_SURFACE;
  }
}

/**
 * Reads the discovery file.
 *
 * Absence is the normal case when Arca is not installed or not running, so it
 * is reported as unavailable rather than as an error worth logging loudly.
 */
async function readBridgeDescriptor(file = BRIDGE_FILE) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    throw new ArcaUnavailableError(
      "passkey bridge descriptor not readable",
      error.code === "ENOENT" ? "not-running" : "unreadable"
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArcaUnavailableError("passkey bridge descriptor is not JSON", "malformed");
  }

  const port = parsed?.port;
  const token = parsed?.token;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ArcaUnavailableError("passkey bridge port is invalid", "malformed");
  }
  if (typeof token !== "string" || token === "") {
    throw new ArcaUnavailableError("passkey bridge token is invalid", "malformed");
  }

  return { port, token };
}

/**
 * Opens a connection, authenticates, sends one request and resolves its reply.
 *
 * Kept to a single request per connection, matching the protocol, so a slow
 * ceremony cannot block an unrelated one.
 */
function sendRequest({ port, token, request, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("utf8");

    let buffer = "";
    let authenticated = false;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };

    const timer = setTimeout(
      () =>
        finish(
          reject,
          new ArcaUnavailableError("passkey bridge timed out", "timeout")
        ),
      timeoutMs
    );

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (!authenticated) {
        finish(
          reject,
          new ArcaUnavailableError("passkey bridge did not answer hello", "timeout")
        );
      }
    });

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "hello", token })}\n`);
    });

    socket.on("error", (error) => {
      finish(
        reject,
        new ArcaUnavailableError(`passkey bridge connection failed: ${error.code}`, "unreachable")
      );
    });

    socket.on("close", () => {
      finish(
        reject,
        new ArcaUnavailableError("passkey bridge closed the connection", "closed")
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk;

      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === "") continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(
            reject,
            new ArcaUnavailableError("passkey bridge sent malformed JSON", "malformed")
          );
          return;
        }

        if (message?.type === "error") {
          const reason = ARCA_ERRORS.has(message.message) ? message.message : "internal";
          finish(reject, new ArcaRequestError(reason));
          return;
        }

        if (!authenticated) {
          if (message?.type !== "ok") {
            finish(
              reject,
              new ArcaUnavailableError("passkey bridge rejected the token", "unauthorised")
            );
            return;
          }
          authenticated = true;
          // Clear the short connect timeout; the request itself may block on
          // the user typing their master password.
          socket.setTimeout(0);
          socket.write(`${JSON.stringify(request)}\n`);
          continue;
        }

        finish(resolve, message);
      }
    });
  });
}

/**
 * Requests an assertion.
 *
 * `origin` and `rpId` must come from the main process, never from the renderer.
 * Arca binds rpId to origin as an anti-phishing check, and with
 * contextIsolation disabled anything the page hands us is page-controlled.
 */
async function getAssertion({ origin, rpId, clientDataHash, allowCredentials = [] }, deps = {}) {
  const { readDescriptor = readBridgeDescriptor, send = sendRequest } = deps;
  const { port, token } = await readDescriptor();

  const response = await send({
    port,
    token,
    request: {
      type: "passkey_get",
      origin,
      rp_id: rpId,
      client_data_hash: clientDataHash,
      allow_credentials: allowCredentials,
    },
  });

  if (response?.type !== "passkey_assertion") {
    throw new ArcaUnavailableError(
      `unexpected reply '${response?.type}' to passkey_get`,
      "protocol"
    );
  }

  return {
    credentialId: response.credential_id,
    authenticatorData: response.authenticator_data,
    signature: response.signature,
    userHandle: response.user_handle ?? null,
  };
}

/**
 * Requests a new credential.
 */
async function createCredential(
  { origin, rpId, userName, userHandle, excludeCredentials = [] },
  deps = {}
) {
  const { readDescriptor = readBridgeDescriptor, send = sendRequest } = deps;
  const { port, token } = await readDescriptor();

  const response = await send({
    port,
    token,
    request: {
      type: "passkey_create",
      origin,
      rp_id: rpId,
      user_name: userName,
      user_handle: userHandle,
      exclude_credentials: excludeCredentials,
    },
  });

  if (response?.type !== "passkey_credential") {
    throw new ArcaUnavailableError(
      `unexpected reply '${response?.type}' to passkey_create`,
      "protocol"
    );
  }

  return {
    credentialId: response.credential_id,
    attestationObject: response.attestation_object,
  };
}

module.exports = {
  BRIDGE_FILE,
  ARCA_ERRORS,
  MUST_SURFACE,
  ArcaUnavailableError,
  ArcaRequestError,
  readBridgeDescriptor,
  sendRequest,
  getAssertion,
  createCredential,
};
