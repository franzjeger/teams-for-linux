'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");

const { shimMain, buildShimSource } = require("../../app/passkey/webauthnShim");

/**
 * Stand-ins for the WebAuthn interfaces, with the property that makes this
 * whole exercise necessary: every prototype member is brand-checked and throws
 * on an object the authenticator did not produce. Nothing is ever added to
 * BRAND, so an unshadowed member is guaranteed to throw.
 */
const BRAND = new WeakSet();
const brandCheck = (self) => {
  if (!BRAND.has(self)) throw new TypeError("Illegal invocation");
};

class FakeAuthenticatorResponse {
  get clientDataJSON() { brandCheck(this); return null; }
}
class FakeAuthenticatorAssertionResponse extends FakeAuthenticatorResponse {
  get authenticatorData() { brandCheck(this); return null; }
  get signature() { brandCheck(this); return null; }
  get userHandle() { brandCheck(this); return null; }
}
class FakeAuthenticatorAttestationResponse extends FakeAuthenticatorResponse {
  get attestationObject() { brandCheck(this); return null; }
  getTransports() { brandCheck(this); return []; }
  getAuthenticatorData() { brandCheck(this); return null; }
  getPublicKey() { brandCheck(this); return null; }
  getPublicKeyAlgorithm() { brandCheck(this); return 0; }
}
class FakeCredential {
  get id() { brandCheck(this); return null; }
  get type() { brandCheck(this); return null; }
}
class FakePublicKeyCredential extends FakeCredential {
  get rawId() { brandCheck(this); return null; }
  get response() { brandCheck(this); return null; }
  get authenticatorAttachment() { brandCheck(this); return null; }
  getClientExtensionResults() { brandCheck(this); return {}; }
  toJSON() { brandCheck(this); return {}; }
}

const PAGE_GLOBALS = {
  PublicKeyCredential: FakePublicKeyCredential,
  AuthenticatorAssertionResponse: FakeAuthenticatorAssertionResponse,
  AuthenticatorAttestationResponse: FakeAuthenticatorAttestationResponse,
};

/**
 * Installs a page-like world, runs the shim in it, and restores the globals.
 *
 * `navigator` is a getter on globalThis in modern Node, so it has to be
 * redefined rather than assigned.
 */
async function withPageWorld(bridge, run) {
  const nativeCalls = [];
  const credentials = {
    get: async (options) => { nativeCalls.push(["get", options]); return "native-get"; },
    create: async (options) => { nativeCalls.push(["create", options]); return "native-create"; },
  };

  const saved = new Map();
  for (const [key, value] of Object.entries({ ...PAGE_GLOBALS, navigator: { credentials } })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  try {
    shimMain(null, bridge);
    // Awaited inside the try: a synchronous finally would tear the world down
    // while the ceremony was still running.
    return await run({ credentials, nativeCalls });
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

const ASSERTION = {
  ok: true,
  credentialId: [1, 2, 3],
  clientDataJSON: [123, 125],
  authenticatorData: [9, 8],
  signature: [7, 6],
  userHandle: [5],
};

const bridgeReturning = (reply, seen = []) => ({
  get: async (payload) => { seen.push(["get", payload]); return reply; },
  create: async (payload) => { seen.push(["create", payload]); return reply; },
});

const GET_OPTIONS = {
  publicKey: { challenge: Uint8Array.from([10, 20]), rpId: "login.microsoft.com" },
};

test("a serviced get produces a genuine PublicKeyCredential", async () => {
  await withPageWorld(bridgeReturning(ASSERTION), async ({ credentials }) => {
    const credential = await credentials.get(GET_OPTIONS);

    assert.ok(credential instanceof FakePublicKeyCredential, "instanceof must hold");
    // Every one of these would throw if the prototype member were not shadowed.
    assert.equal(credential.type, "public-key");
    assert.equal(credential.id, "AQID");
    assert.equal(credential.authenticatorAttachment, "cross-platform");
    assert.deepEqual([...new Uint8Array(credential.rawId)], [1, 2, 3]);
    assert.deepEqual(credential.getClientExtensionResults(), {});
  });
});

test("the assertion response is shaped too, including inherited members", async () => {
  await withPageWorld(bridgeReturning(ASSERTION), async ({ credentials }) => {
    const { response } = await credentials.get(GET_OPTIONS);

    assert.ok(response instanceof FakeAuthenticatorAssertionResponse);
    // clientDataJSON is inherited from AuthenticatorResponse, two levels up -
    // this is what the prototype-chain walk exists for.
    assert.deepEqual([...new Uint8Array(response.clientDataJSON)], [123, 125]);
    assert.deepEqual([...new Uint8Array(response.authenticatorData)], [9, 8]);
    assert.deepEqual([...new Uint8Array(response.signature)], [7, 6]);
    assert.deepEqual([...new Uint8Array(response.userHandle)], [5]);
  });
});

test("toJSON returns the base64url form relying parties expect", async () => {
  await withPageWorld(bridgeReturning(ASSERTION), async ({ credentials }) => {
    const credential = await credentials.get(GET_OPTIONS);
    assert.deepEqual(credential.toJSON(), {
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      authenticatorAttachment: "cross-platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: "e30",
        authenticatorData: "CQg",
        signature: "BwY",
        userHandle: "BQ",
      },
    });
  });
});

test("a null userHandle survives to both the object and the JSON", async () => {
  const reply = { ...ASSERTION, userHandle: null };
  await withPageWorld(bridgeReturning(reply), async ({ credentials }) => {
    const credential = await credentials.get(GET_OPTIONS);
    assert.equal(credential.response.userHandle, null);
    assert.equal(credential.toJSON().response.userHandle, null);
  });
});

test("the bridge is told the challenge and filters, never the origin", async () => {
  const seen = [];
  await withPageWorld(bridgeReturning(ASSERTION, seen), async ({ credentials }) => {
    await credentials.get({
      publicKey: {
        challenge: Uint8Array.from([10, 20]),
        rpId: "microsoft.com",
        allowCredentials: [{ id: Uint8Array.from([1]) }, { id: new ArrayBuffer(0) }, {}],
      },
    });
  });

  assert.deepEqual(seen, [
    ["get", { challenge: [10, 20], rpId: "microsoft.com", allowCredentials: [[1], []] }],
  ]);
  // The origin is the main process's business; the shim must not offer one.
  assert.ok(!Object.hasOwn(seen[0][1], "origin"));
});

test("excluded surfaces as InvalidStateError rather than falling back", async () => {
  const bridge = bridgeReturning({ ok: false, reason: "excluded", surfaceToPage: true });
  await withPageWorld(bridge, async ({ credentials, nativeCalls }) => {
    await assert.rejects(
      () => credentials.get(GET_OPTIONS),
      (error) => error instanceof DOMException && error.name === "InvalidStateError"
    );
    assert.deepEqual(nativeCalls, [], "must not also call the native handler");
  });
});

test("every other failure falls back to the native handler with the original options", async () => {
  for (const reply of [
    { ok: false, reason: "locked" },
    { ok: false, reason: "not_found" },
    { ok: false, reason: "disabled" },
    // A provider that claims surfaceToPage for something else is not obeyed.
    { ok: false, reason: "denied", surfaceToPage: true },
    null,
  ]) {
    await withPageWorld(bridgeReturning(reply), async ({ credentials, nativeCalls }) => {
      assert.equal(await credentials.get(GET_OPTIONS), "native-get");
      assert.deepEqual(nativeCalls, [["get", GET_OPTIONS]]);
    });
  }
});

test("a bridge that rejects falls back rather than failing the ceremony", async () => {
  const bridge = { get: async () => { throw new Error("no such channel"); } };
  await withPageWorld(bridge, async ({ credentials }) => {
    assert.equal(await credentials.get(GET_OPTIONS), "native-get");
  });
});

test("conditional and silent mediation are deferred to the browser", async () => {
  const seen = [];
  for (const mediation of ["conditional", "silent"]) {
    await withPageWorld(bridgeReturning(ASSERTION, seen), async ({ credentials }) => {
      assert.equal(await credentials.get({ ...GET_OPTIONS, mediation }), "native-get");
    });
  }
  assert.deepEqual(seen, [], "autofill flows must never reach the provider");
});

test("modal mediations are answered", async () => {
  for (const mediation of [undefined, "optional", "required"]) {
    await withPageWorld(bridgeReturning(ASSERTION), async ({ credentials }) => {
      const credential = await credentials.get({ ...GET_OPTIONS, mediation });
      assert.equal(credential.type, "public-key");
    });
  }
});

test("non-WebAuthn and challenge-less requests go straight to the browser", async () => {
  const seen = [];
  await withPageWorld(bridgeReturning(ASSERTION, seen), async ({ credentials }) => {
    assert.equal(await credentials.get({ password: true }), "native-get");
    assert.equal(await credentials.get({ publicKey: { rpId: "x.example" } }), "native-get");
  });
  assert.deepEqual(seen, []);
});

test("create produces a shaped attestation credential", async () => {
  const reply = { ok: true, credentialId: [1, 2, 3], clientDataJSON: [123, 125], attestationObject: [4] };
  await withPageWorld(bridgeReturning(reply), async ({ credentials }) => {
    const credential = await credentials.create({
      publicKey: {
        challenge: Uint8Array.from([1]),
        rp: { id: "microsoft.com" },
        user: { name: "someone", id: Uint8Array.from([2]) },
      },
    });

    assert.ok(credential instanceof FakePublicKeyCredential);
    assert.ok(credential.response instanceof FakeAuthenticatorAttestationResponse);
    assert.deepEqual([...new Uint8Array(credential.response.attestationObject)], [4]);
    assert.deepEqual([...new Uint8Array(credential.response.clientDataJSON)], [123, 125]);
    assert.deepEqual(credential.response.getTransports(), ["internal", "hybrid"]);
    assert.deepEqual(credential.toJSON().response, {
      clientDataJSON: "e30",
      attestationObject: "BA",
      transports: ["internal", "hybrid"],
    });
  });
});

test("create sends the registration filters and falls back on failure", async () => {
  const seen = [];
  await withPageWorld(bridgeReturning({ ok: false, reason: "locked" }, seen), async ({ credentials }) => {
    const result = await credentials.create({
      publicKey: {
        challenge: Uint8Array.from([1]),
        rp: { id: "microsoft.com" },
        user: { name: "someone", id: Uint8Array.from([2]) },
        excludeCredentials: [{ id: Uint8Array.from([3]) }],
      },
    });
    assert.equal(result, "native-create");
  });

  assert.deepEqual(seen[0][1], {
    challenge: [1],
    rpId: "microsoft.com",
    userName: "someone",
    userHandle: [2],
    excludeCredentials: [[3]],
  });
});

test("the shim leaves create alone when the bridge cannot register", async () => {
  const bridge = { get: async () => ASSERTION };
  await withPageWorld(bridge, async ({ credentials, nativeCalls }) => {
    assert.equal(await credentials.create({ publicKey: {} }), "native-create");
    assert.deepEqual(nativeCalls, [["create", { publicKey: {} }]]);
  });
});

test("the shim declines to install without a usable bridge", async () => {
  for (const bridge of [null, {}, { get: "not a function" }]) {
    await withPageWorld(bridge, async ({ credentials }) => {
      // Untouched: still the original stub, which ignores mediation entirely.
      assert.equal(await credentials.get({ ...GET_OPTIONS, mediation: "conditional" }), "native-get");
    });
  }
});

test("buildShimSource embeds the config safely and requires a channel", () => {
  const source = buildShimSource({ channel: "ch", note: "</script>" });
  assert.ok(source.startsWith("(function shimMain"));
  assert.ok(!source.includes("</script>"), "a literal < would close the host script tag");
  assert.ok(source.includes("\\u003c/script>"));
  assert.throws(() => buildShimSource({}), /channel is required/);
  assert.throws(() => buildShimSource({ channel: "" }), /channel is required/);
});
