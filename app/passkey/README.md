# Passkey Module

Answers WebAuthn ceremonies from a local passkey provider.

## Why this exists

Linux has no platform authenticator. When Entra reaches its passkey page
("Face, fingerprint, PIN or security key" → "Your device will open a security
window"), Chromium's own WebAuthn handler has nothing to offer and the sign-in
stalls with no error.

A password manager on the machine may hold the credential and be able to sign
the assertion. In a browser it does this through an extension; that route is
closed here twice over — this app loads no extensions, and the extension's
transport (`chrome.runtime.sendNativeMessage`) does not exist in Electron. So
the ceremony is answered from inside the app instead.

## Layout

| File | Process | Responsibility |
|------|---------|----------------|
| `webauthnShim.js` | page world | Wraps `navigator.credentials.get/create` |
| `index.js` | main | IPC handlers; binds the ceremony to the frame's origin |
| `ceremony.js` | main | rpId validation and clientData construction (pure) |
| `arcaClient.js` | main | Arca's loopback bridge: discovery, transport, protocol |

## The two things that make this safe

**The origin never comes from the page.** A provider binds `rp_id` to `origin`
as an anti-phishing check, and with `contextIsolation: false` everything the
page hands the preload is page-controlled. The origin is therefore read from
`event.senderFrame.url` in the main process — the *frame*, not the window,
because Entra runs the ceremony inside an iframe and the top-level URL would be
the wrong binding. The page supplies only the challenge and the credential
filters. `resolveRpId` then requires the requested `rpId` to be that frame's
host or a registrable parent of it.

**The credential handed back is a real `PublicKeyCredential`.** An object
literal carrying the right fields passes every field check and still breaks the
relying party: modern RP code calls `toJSON()` and tests `instanceof`, and Entra
does both. The failure is vicious — the ceremony completes, everything reports
success, and the *site* throws while handling the answer. `shapeAs()` therefore
sets the real prototype and shadows every member along the chain with an own
property, because those members are brand-checked accessors that throw on an
object the authenticator did not produce.

## Behaviour

Every failure falls back to Chromium's real handler, so a machine with no
provider behaves exactly as it did before. The single exception is `excluded`,
which WebAuthn requires the page to see as a `DOMException` named
`InvalidStateError`.

Modal ceremonies are answered; `conditional` and `silent` mediation are passed
through untouched. Conditional mediation is autofill UI, which this app has no
way to present. There is no gesture ledger: in a dedicated Teams client the
threat model is narrower than a browser's, and the provider prompts for the
master password on every assertion regardless, so an unwanted ceremony costs a
prompt rather than a credential.

`passkey.enabled` gates the integration in the **main process**, not the
preload. The preload shares the page's world, and a switch the page can reach
is not a switch.

## Injection timing

The shim is installed from the preload's top level, which under
`contextIsolation: false` is the page's own world and runs before any page
script. This was verified against a cross-origin navigation, which is what the
sign-in flow does: it moves from `login.microsoftonline.com` to
`login.microsoft.com` and the ceremony fires on load.

Anywhere later is too late. The main-world agent
(`app/browser/bridge/mainWorldAgent.js`) injects on `DOMContentLoaded`, after
the page's own scripts have already captured `navigator.credentials`.

**This matters for ADR 020 stage 5.** When `contextIsolation` becomes `true` the
preload is no longer the page's world and the shim must move into the main-world
agent — which needs an earlier injection point first, not merely a relocation.
`buildShimSource()` exists for that move and is unused today.

## Tests

- `tests/unit/passkeyCeremony.test.js` — rpId validation, clientData/hash
- `tests/unit/passkeyHandlers.test.js` — origin binding, fallback classification
- `tests/unit/passkeyShim.test.js` — prototype shaping against brand-checked
  fakes, mediation policy, fallback paths
- `tests/unit/arcaClient.test.js` — the wire protocol, against a real loopback
  server
