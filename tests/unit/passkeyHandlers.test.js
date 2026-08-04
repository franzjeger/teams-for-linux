'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  handleGet,
  handleCreate,
  frameOrigin,
  registerPasskeyHandlers,
  GET_CHANNEL,
  CREATE_CHANNEL,
} = require("../../app/passkey");
const { ArcaRequestError, ArcaUnavailableError } = require("../../app/passkey/arcaClient");

const eventFrom = (url) => ({ senderFrame: { url } });

const ASSERTION = {
  credentialId: [1],
  authenticatorData: [2],
  signature: [3],
  userHandle: [4],
};

/** Captures what the client was asked for without opening a socket. */
function recordingClient(result = ASSERTION) {
  const calls = [];
  return {
    calls,
    fn: async (request) => {
      calls.push(request);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("the origin comes from the frame, not from the payload", async () => {
  const arca = recordingClient();
  const reply = await handleGet(
    eventFrom("https://login.microsoft.com/common/login?x=1"),
    {
      challenge: [1, 2],
      // A compromised page trying to name its own relying party.
      origin: "https://evil.example",
      rpId: "login.microsoft.com",
    },
    { getAssertion: arca.fn }
  );

  assert.equal(reply.ok, true);
  assert.equal(arca.calls[0].origin, "https://login.microsoft.com");
  assert.equal(arca.calls[0].rpId, "login.microsoft.com");
});

test("the frame's own URL wins even when it is an iframe on another host", async () => {
  // Entra runs the ceremony inside an iframe, so the top-level URL would be the
  // wrong binding entirely.
  const arca = recordingClient();
  await handleGet(
    eventFrom("https://login.microsoftonline.com/frame.html"),
    { challenge: [1] },
    { getAssertion: arca.fn }
  );
  assert.equal(arca.calls[0].origin, "https://login.microsoftonline.com");
  assert.equal(arca.calls[0].rpId, "login.microsoftonline.com");
});

test("an rpId the frame cannot claim is refused before the provider is contacted", async () => {
  const arca = recordingClient();
  const reply = await handleGet(
    eventFrom("https://evil.example"),
    { challenge: [1], rpId: "login.microsoft.com" },
    { getAssertion: arca.fn }
  );

  assert.deepEqual(reply, { ok: false, reason: "invalid-request" });
  assert.deepEqual(arca.calls, [], "the provider must never see the request");
});

test("an insecure or unparseable frame is refused", async () => {
  const arca = recordingClient();
  for (const url of ["http://login.microsoft.com", "about:blank", ""]) {
    const reply = await handleGet(eventFrom(url), { challenge: [1] }, { getAssertion: arca.fn });
    assert.equal(reply.ok, false, url);
    assert.equal(reply.reason, "invalid-request", url);
  }
  const gone = await handleGet({ senderFrame: null }, { challenge: [1] }, { getAssertion: arca.fn });
  assert.equal(gone.reason, "invalid-request");
  assert.deepEqual(arca.calls, []);
});

test("clientDataJSON is returned and its hash is what the provider signs", async () => {
  const arca = recordingClient();
  const reply = await handleGet(
    eventFrom("https://login.microsoft.com/x"),
    { challenge: [9, 9, 9] },
    { getAssertion: arca.fn }
  );

  const json = Buffer.from(reply.clientDataJSON);
  assert.deepEqual(JSON.parse(json.toString("utf8")), {
    type: "webauthn.get",
    challenge: "CQkJ",
    origin: "https://login.microsoft.com",
    crossOrigin: false,
  });
  assert.deepEqual(
    arca.calls[0].clientDataHash,
    Array.from(crypto.createHash("sha256").update(json).digest())
  );
});

test("a serviced get returns the assertion the shim expects", async () => {
  const arca = recordingClient();
  const reply = await handleGet(
    eventFrom("https://login.microsoft.com"),
    { challenge: [1], allowCredentials: [{ id: [7] }, { id: [] }] },
    { getAssertion: arca.fn }
  );

  assert.equal(reply.ok, true);
  assert.deepEqual(reply.credentialId, [1]);
  assert.deepEqual(reply.authenticatorData, [2]);
  assert.deepEqual(reply.signature, [3]);
  assert.deepEqual(reply.userHandle, [4]);
  assert.deepEqual(arca.calls[0].allowCredentials, [[7]]);
});

test("a missing userHandle is normalised to null", async () => {
  const arca = recordingClient({ ...ASSERTION, userHandle: undefined });
  const reply = await handleGet(
    eventFrom("https://login.microsoft.com"),
    { challenge: [1] },
    { getAssertion: arca.fn }
  );
  assert.equal(reply.userHandle, null);
});

test("excluded is the one failure the page is told about", async () => {
  const arca = recordingClient(new ArcaRequestError("excluded"));
  const reply = await handleCreate(
    eventFrom("https://login.microsoft.com"),
    { challenge: [1], userName: "someone", userHandle: [2] },
    { createCredential: arca.fn }
  );
  assert.deepEqual(reply, { ok: false, reason: "excluded", surfaceToPage: true });
});

test("every other provider failure becomes a plain fallback", async () => {
  for (const reason of ["locked", "not_found", "denied", "origin_mismatch", "internal"]) {
    const arca = recordingClient(new ArcaRequestError(reason));
    const reply = await handleGet(
      eventFrom("https://login.microsoft.com"),
      { challenge: [1] },
      { getAssertion: arca.fn }
    );
    assert.deepEqual(reply, { ok: false, reason }, reason);
  }
});

test("an absent provider is a fallback, not an error", async () => {
  const arca = recordingClient(new ArcaUnavailableError("not there", "not-running"));
  const reply = await handleGet(
    eventFrom("https://login.microsoft.com"),
    { challenge: [1] },
    { getAssertion: arca.fn }
  );
  assert.deepEqual(reply, { ok: false, reason: "not-running" });
});

test("an unexpected failure does not leak its message to the page", async () => {
  const arca = recordingClient(new Error("connect ECONNREFUSED 127.0.0.1:41234"));
  const reply = await handleGet(
    eventFrom("https://login.microsoft.com"),
    { challenge: [1] },
    { getAssertion: arca.fn }
  );
  assert.deepEqual(reply, { ok: false, reason: "unavailable" });
});

test("create forwards the registration fields and returns the attestation", async () => {
  const arca = recordingClient({ credentialId: [1], attestationObject: [5] });
  const reply = await handleCreate(
    eventFrom("https://login.microsoft.com"),
    {
      challenge: [1],
      rpId: "microsoft.com",
      userName: "someone",
      userHandle: [2],
      excludeCredentials: [{ id: [3] }],
    },
    { createCredential: arca.fn }
  );

  assert.equal(reply.ok, true);
  assert.deepEqual(reply.attestationObject, [5]);
  assert.deepEqual(arca.calls[0], {
    origin: "https://login.microsoft.com",
    rpId: "microsoft.com",
    userName: "someone",
    userHandle: [2],
    excludeCredentials: [[3]],
  });

  const parsed = JSON.parse(Buffer.from(reply.clientDataJSON).toString("utf8"));
  assert.equal(parsed.type, "webauthn.create");
  assert.equal(parsed.origin, "https://login.microsoft.com");
});

test("create tolerates a payload with no user fields", async () => {
  const arca = recordingClient({ credentialId: [1], attestationObject: [5] });
  await handleCreate(
    eventFrom("https://login.microsoft.com"),
    { challenge: [1] },
    { createCredential: arca.fn }
  );
  assert.equal(arca.calls[0].userName, "");
  assert.deepEqual(arca.calls[0].userHandle, []);
});

test("registerPasskeyHandlers claims both channels", () => {
  const handlers = new Map();
  registerPasskeyHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {});
  assert.deepEqual([...handlers.keys()], [GET_CHANNEL, CREATE_CHANNEL]);
});

test("passkey.enabled=false short-circuits both channels", async () => {
  const handlers = new Map();
  registerPasskeyHandlers(
    { handle: (channel, fn) => handlers.set(channel, fn) },
    { passkey: { enabled: false } }
  );

  const event = eventFrom("https://login.microsoft.com");
  for (const channel of [GET_CHANNEL, CREATE_CHANNEL]) {
    assert.deepEqual(await handlers.get(channel)(event, { challenge: [1] }), {
      ok: false,
      reason: "disabled",
    });
  }
});

test("frameOrigin strips everything after the origin", () => {
  assert.equal(
    frameOrigin(eventFrom("https://login.microsoft.com:443/common/oauth2?code=secret#frag")),
    "https://login.microsoft.com"
  );
});
