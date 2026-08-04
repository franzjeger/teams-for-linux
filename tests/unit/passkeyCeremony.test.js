'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  toByteArray,
  base64url,
  resolveRpId,
  buildClientData,
  normaliseCredentialList,
} = require("../../app/passkey/ceremony");

test("resolveRpId defaults to the frame host when the page names nothing", () => {
  assert.equal(resolveRpId("https://login.microsoft.com", undefined), "login.microsoft.com");
  assert.equal(resolveRpId("https://login.microsoft.com", null), "login.microsoft.com");
  assert.equal(resolveRpId("https://login.microsoft.com", ""), "login.microsoft.com");
});

test("resolveRpId accepts the host itself, case-insensitively", () => {
  assert.equal(resolveRpId("https://Login.Microsoft.com", "login.microsoft.com"), "login.microsoft.com");
  assert.equal(resolveRpId("https://login.microsoft.com", "LOGIN.MICROSOFT.COM"), "login.microsoft.com");
});

test("resolveRpId accepts a registrable parent domain", () => {
  assert.equal(resolveRpId("https://login.microsoft.com", "microsoft.com"), "microsoft.com");
});

test("resolveRpId rejects an unrelated domain", () => {
  // The attack this exists to stop: a page naming someone else's relying party.
  assert.throws(
    () => resolveRpId("https://evil.example", "login.microsoft.com"),
    /not valid for this origin/
  );
});

test("resolveRpId rejects a suffix that is not a domain boundary", () => {
  // "notmicrosoft.com" must not be able to claim "microsoft.com".
  assert.throws(
    () => resolveRpId("https://notmicrosoft.com", "microsoft.com"),
    /not valid for this origin/
  );
});

test("resolveRpId rejects a bare public suffix", () => {
  assert.throws(() => resolveRpId("https://login.microsoft.com", "com"), /not valid/);
});

test("resolveRpId rejects a child of the frame host", () => {
  // Scoping down is not permitted; only up to a registrable parent.
  assert.throws(
    () => resolveRpId("https://microsoft.com", "login.microsoft.com"),
    /not valid for this origin/
  );
});

test("resolveRpId requires a secure origin, with localhost excepted", () => {
  assert.throws(() => resolveRpId("http://login.microsoft.com"), /secure origin/);
  assert.equal(resolveRpId("http://localhost:3000"), "localhost");
});

test("resolveRpId rejects a non-URL origin and a non-string rpId", () => {
  assert.throws(() => resolveRpId("not a url"), /not a valid URL/);
  assert.throws(() => resolveRpId("https://login.microsoft.com", 42), /must be a string/);
});

test("buildClientData produces a hash over exactly the JSON it returns", () => {
  const challenge = [1, 2, 3, 4];
  const { clientDataJSON, clientDataHash } = buildClientData(
    "webauthn.get",
    challenge,
    "https://login.microsoft.com"
  );

  const json = Buffer.from(clientDataJSON).toString("utf8");
  const expected = crypto.createHash("sha256").update(Buffer.from(clientDataJSON)).digest();

  assert.deepEqual(clientDataHash, Array.from(expected));
  assert.deepEqual(JSON.parse(json), {
    type: "webauthn.get",
    challenge: base64url(challenge),
    origin: "https://login.microsoft.com",
    crossOrigin: false,
  });
});

test("buildClientData encodes the challenge as unpadded base64url", () => {
  const { clientDataJSON } = buildClientData("webauthn.create", [251, 255, 190], "https://x.example");
  const parsed = JSON.parse(Buffer.from(clientDataJSON).toString("utf8"));
  assert.equal(parsed.challenge, "-_--");
  assert.ok(!parsed.challenge.includes("="));
});

test("buildClientData rejects an unknown type and an empty challenge", () => {
  assert.throws(() => buildClientData("webauthn.sign", [1], "https://x.example"), /unknown ceremony/);
  assert.throws(() => buildClientData("webauthn.get", [], "https://x.example"), /challenge is required/);
  assert.throws(() => buildClientData("webauthn.get", null, "https://x.example"), /challenge is required/);
});

test("toByteArray normalises the shapes that cross IPC", () => {
  assert.deepEqual(toByteArray(Uint8Array.from([1, 2])), [1, 2]);
  assert.deepEqual(toByteArray([1, 2]), [1, 2]);
  assert.deepEqual(toByteArray(Uint8Array.from([1, 2]).buffer), [1, 2]);
  assert.equal(toByteArray("nope"), null);
  assert.equal(toByteArray(undefined), null);
});

test("toByteArray masks out-of-range integers to a byte", () => {
  assert.deepEqual(toByteArray([256, -1, 300]), [0, 255, 44]);
});

test("normaliseCredentialList keeps only the raw ids", () => {
  const list = normaliseCredentialList([
    { id: [1, 2], type: "public-key", transports: ["usb"] },
    { id: Uint8Array.from([3]) },
    { id: [] },
    { id: "not bytes" },
    null,
  ]);
  assert.deepEqual(list, [[1, 2], [3]]);
});

test("normaliseCredentialList tolerates a missing or non-array list", () => {
  assert.deepEqual(normaliseCredentialList(undefined), []);
  assert.deepEqual(normaliseCredentialList("nope"), []);
});
