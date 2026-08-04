'use strict';

/**
 * WebAuthn Page-World Shim
 *
 * Installed from the preload's top level, which under `contextIsolation: false`
 * is the page's own JavaScript world and runs before any page script. Verified:
 * a page's first inline script already sees the wrapped function, including
 * after a cross-origin navigation, which matters because the sign-in flow
 * navigates from login.microsoftonline.com to login.microsoft.com and the
 * ceremony fires on load.
 *
 * NOTE FOR ADR 020 STAGE 5: when `contextIsolation` becomes true the preload is
 * no longer the page's world and this shim must move into the main-world agent.
 * The agent's current injection point (DOMContentLoaded) is too late - it runs
 * after the page's own scripts - so that stage needs an earlier injection, not
 * merely a relocation.
 *
 * Gesture policy: modal ceremonies are answered, conditional and silent ones are
 * deferred to the browser. In a dedicated Teams client the threat model is
 * narrower than a browser's, and Arca prompts for the master password on every
 * assertion regardless, so an unwanted modal ceremony costs a prompt rather than
 * a credential. Conditional mediation is autofill UI, which we have no way to
 * present, so passing it through is both safer and more correct.
 */

/**
 * Wraps `navigator.credentials` in whatever world this is called from.
 *
 * The preload calls it directly and hands in the bridge, so nothing privileged
 * is published to the page global. The stringified form used by
 * `buildShimSource` has no such luxury and reads the bridge from
 * `globalThis[channel]`; that path exists for ADR 020 stage 5.
 *
 * @param {{channel?: string}} config
 * @param {{get: Function, create?: Function}} [injectedBridge]
 */
function shimMain(config, injectedBridge) {
  const { channel } = config ?? {};

  const credentials = globalThis.navigator?.credentials;
  if (!credentials || typeof credentials.get !== "function") return;

  const nativeGet = credentials.get.bind(credentials);
  const nativeCreate =
    typeof credentials.create === "function" ? credentials.create.bind(credentials) : null;

  // Read once. A page script that later swaps the global cannot redirect a
  // ceremony that is already wired to the real bridge.
  const bridge = injectedBridge ?? globalThis[channel];
  if (!bridge || typeof bridge.get !== "function") return;

  const toUint8 = (value) =>
    value instanceof Uint8Array
      ? value
      : Array.isArray(value)
        ? Uint8Array.from(value)
        : new Uint8Array(value ?? []);

  const toBuffer = (value) => toUint8(value).buffer;

  const base64url = (value) => {
    const bytes = toUint8(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis
      .btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  };

  const bytesFrom = (value) => {
    if (value == null) return null;
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    if (Array.isArray(value)) return value;
    return null;
  };

  /**
   * Produces a genuine PublicKeyCredential rather than a look-alike.
   *
   * An object literal carrying the right fields passes every field check and
   * still breaks the relying party: modern RP code calls toJSON() (WebAuthn L3)
   * and tests instanceof, and Entra does both. The failure is vicious - the
   * ceremony completes, everything reports success, and the site throws while
   * handling the answer.
   *
   * Two things are therefore required. The real prototype, so instanceof holds;
   * and every prototype member shadowed by an own property, because the
   * prototype's accessors are brand-checked and throw when invoked on an object
   * that was not produced by the real authenticator.
   */
  const define = (target, props) =>
    Object.defineProperties(
      target,
      Object.fromEntries(
        Object.entries(props).map(([key, value]) => [
          key,
          { value, enumerable: true, configurable: true, writable: false },
        ])
      )
    );

  const shapeAs = (proto, ownProps) => {
    const target = define({}, ownProps);
    if (!proto) return target;

    // Shadow every accessor and method the chain defines, up to but not
    // including Object.prototype. The chain matters: PublicKeyCredential gets
    // `id` and `type` from Credential, and the assertion response gets
    // `clientDataJSON` from AuthenticatorResponse. An unshadowed getter runs
    // against a foreign `this` and throws.
    for (let level = proto; level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
      for (const key of Object.getOwnPropertyNames(level)) {
        if (key === "constructor" || Object.hasOwn(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(level, key);
        if (!descriptor) continue;
        if (typeof descriptor.value === "function") {
          Object.defineProperty(target, key, {
            value: () => undefined,
            enumerable: false,
            configurable: true,
          });
        } else if (descriptor.get) {
          Object.defineProperty(target, key, {
            value: undefined,
            enumerable: true,
            configurable: true,
          });
        }
      }
    }

    // Re-apply the real values last so the shadowing loop cannot clobber them.
    define(target, ownProps);
    Object.setPrototypeOf(target, proto);
    return target;
  };

  const assertionResponse = ({ clientDataJSON, authenticatorData, signature, userHandle }) =>
    shapeAs(globalThis.AuthenticatorAssertionResponse?.prototype, {
      clientDataJSON: toBuffer(clientDataJSON),
      authenticatorData: toBuffer(authenticatorData),
      signature: toBuffer(signature),
      userHandle: userHandle ? toBuffer(userHandle) : null,
    });

  const attestationResponse = ({ clientDataJSON, attestationObject }) =>
    shapeAs(globalThis.AuthenticatorAttestationResponse?.prototype, {
      clientDataJSON: toBuffer(clientDataJSON),
      attestationObject: toBuffer(attestationObject),
      getTransports: () => ["internal", "hybrid"],
      getAuthenticatorData: () => new ArrayBuffer(0),
      getPublicKey: () => null,
      getPublicKeyAlgorithm: () => -7,
    });

  const shapedCredential = (rawId, response, toJSON) =>
    shapeAs(globalThis.PublicKeyCredential?.prototype, {
      id: base64url(rawId),
      rawId: toBuffer(rawId),
      type: "public-key",
      authenticatorAttachment: "cross-platform",
      response,
      getClientExtensionResults: () => ({}),
      toJSON,
    });

  /** Arca could not service the request; let the browser try. */
  const FALLBACK = Symbol("fallback");

  async function ask(kind, payload) {
    let reply;
    try {
      reply = await bridge[kind](payload);
    } catch {
      return FALLBACK;
    }

    if (!reply || reply.ok !== true) {
      // `excluded` is the one reason WebAuthn requires be visible to the page.
      if (reply?.surfaceToPage && reply?.reason === "excluded") {
        throw new DOMException(
          "A credential matching an excluded descriptor already exists.",
          "InvalidStateError"
        );
      }
      return FALLBACK;
    }
    return reply;
  }

  credentials.get = async function get(options) {
    const publicKey = options?.publicKey;

    // Conditional and silent mediation are autofill flows we cannot present.
    if (!publicKey || (options?.mediation && options.mediation !== "optional" &&
        options.mediation !== "required")) {
      return nativeGet(options);
    }

    const payload = {
      challenge: bytesFrom(publicKey.challenge),
      rpId: publicKey.rpId,
      allowCredentials: (publicKey.allowCredentials ?? [])
        .map((entry) => bytesFrom(entry?.id))
        .filter(Boolean),
    };
    if (!payload.challenge) return nativeGet(options);

    const reply = await ask("get", payload);
    if (reply === FALLBACK) return nativeGet(options);

    const rawId = reply.credentialId;
    const response = assertionResponse(reply);

    return shapedCredential(rawId, response, () => ({
      id: base64url(rawId),
      rawId: base64url(rawId),
      type: "public-key",
      authenticatorAttachment: "cross-platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(reply.clientDataJSON),
        authenticatorData: base64url(reply.authenticatorData),
        signature: base64url(reply.signature),
        userHandle: reply.userHandle ? base64url(reply.userHandle) : null,
      },
    }));
  };

  if (nativeCreate && typeof bridge.create === "function") {
    credentials.create = async function create(options) {
      const publicKey = options?.publicKey;
      if (!publicKey) return nativeCreate(options);

      const payload = {
        challenge: bytesFrom(publicKey.challenge),
        rpId: publicKey.rp?.id,
        userName: publicKey.user?.name,
        userHandle: bytesFrom(publicKey.user?.id),
        excludeCredentials: (publicKey.excludeCredentials ?? [])
          .map((entry) => bytesFrom(entry?.id))
          .filter(Boolean),
      };
      if (!payload.challenge) return nativeCreate(options);

      const reply = await ask("create", payload);
      if (reply === FALLBACK) return nativeCreate(options);

      const rawId = reply.credentialId;
      const response = attestationResponse(reply);

      return shapedCredential(rawId, response, () => ({
        id: base64url(rawId),
        rawId: base64url(rawId),
        type: "public-key",
        authenticatorAttachment: "cross-platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64url(reply.clientDataJSON),
          attestationObject: base64url(reply.attestationObject),
          transports: ["internal", "hybrid"],
        },
      }));
    };
  }
}

/**
 * Serialises the shim for evaluation in the page world.
 * Config is JSON-encoded so a value cannot break out of the literal.
 */
function buildShimSource(config) {
  if (typeof config?.channel !== "string" || config.channel === "") {
    throw new Error("passkey shim: channel is required");
  }
  const encoded = JSON.stringify(config).replaceAll("<", "\\u003c");
  return `(${shimMain.toString()})(${encoded});`;
}

module.exports = { shimMain, buildShimSource };
