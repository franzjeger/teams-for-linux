# Main-World Bridge

Infrastructure for stage 2 of the [context isolation
migration](../../../docs-site/docs/development/adr/020-context-isolation-migration.md).

**Nothing uses this yet.** It ships inert on purpose so the protocol can be
reviewed and tested before any tool depends on it.

## Why it exists

Under `contextIsolation: true` the preload runs in an isolated world. DOM nodes
are shared with the page, but JavaScript properties that page scripts attach to
them are not. `ReactHandler` reads `_reactRootContainer`, an expando React
writes from the page world, so an isolated preload sees `undefined`. The same
applies to patching page globals: `getUserMedia` patched from an isolated world
patches that world's copy, and the page keeps calling the original.

Code that must touch page state therefore has to run in the page world — which
in turn cannot reach `ipcRenderer`. The bridge connects the two halves.

```
main process
     │  ipcMain (allowlisted channels)
     ▼
preload / isolated world          ── owns ipcRenderer, never exposes it
     │  window.postMessage, correlated request/response
     ▼
main-world agent                  ── owns React internals and page globals
     ▼
Teams page
```

## Files

| File | World | Purpose |
|---|---|---|
| `protocol.js` | neither | Message format and validation. No Electron or DOM, so the security decisions are directly unit testable. |
| `isolatedBridge.js` | isolated | Owns `ipcRenderer`, injects the agent, correlates requests with responses. |
| `mainWorldAgent.js` | page | Agent runtime. Its source is stringified and injected; it is never `require`d by the preload. |

## What the session id is not

Every envelope carries a per-session random id. The agent runs in the page
world, so any script sharing that world can observe the traffic and read it. It
is **not** a secret and **not** authentication. It exists only to stop unrelated
`postMessage` traffic being mistaken for bridge messages.

The real controls are:

1. **`acceptedChannels`** — the isolated world only acts on channels it has
   explicitly opted into. This set must stay narrower than the IPC surface
   behind it.
2. **`validators`** — a per-channel payload check that runs before anything
   reaches `ipcRenderer`.
3. **`pendingIds`** — a response is honoured only if it answers a request this
   side actually issued, and only on the channel that request used.

Treating the session id as a security boundary would reproduce exactly the
failure ADR 020 warns about: a bridge that forwards unvalidated page messages
while looking secure.

## Adding a capability

Both halves must agree, so a capability cannot be reached by changing only one
side.

```js
// page world — inside the agent bundle
agent.register("camera-settings", async (payload) => {
  const track = findVideoTrack(payload.deviceId);
  return track.getSettings();
});
```

```js
// isolated world — preload
const bridge = new IsolatedBridge({
  window,
  sessionId,
  acceptedChannels: ["camera-settings"],
  validators: {
    "camera-settings": (p) => typeof p?.width === "number",
  },
});
bridge.start();

const settings = await bridge.request("camera-settings", { deviceId });
```

Keep `acceptedChannels` minimal. Every entry widens what page script can reach
through the isolated world.

## Testing

- `tests/unit/bridgeProtocol.test.js` — validation rules in isolation
- `tests/unit/isolatedBridge.test.js` — correlation, timeouts, hostile inbound traffic
- `tests/unit/bridgeInterop.test.js` — the real agent source running in a VM
  context, wired to a real bridge

The interop suite is the one that matters. The two halves are written against
the same protocol but never import each other, so only a round trip proves they
actually agree.

Two things that harness gets right, and that are easy to get wrong when
extending it:

- **Structured clone.** Real `postMessage` clones its argument, and the clone is
  created in the receiving realm. Passing references instead makes the agent's
  replies keep the VM realm's `Object.prototype`, which the bridge correctly
  rejects — a test artefact that looks like a real defect.
- **`globalThis` identity.** Inside a vm context `globalThis` is a proxy, not the
  object handed to `createContext`. Setting a `globalThis` own property on that
  object shadows the real one and breaks the agent's `event.source` check.
