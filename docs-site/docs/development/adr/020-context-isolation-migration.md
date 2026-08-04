---
id: 020-context-isolation-migration
---

# ADR 020: Context Isolation Migration

## Status

Accepted --- staged migration in progress (stages 1 and 2 shipped)

## Context

The main window runs with `contextIsolation: false` and `sandbox: false`
(`app/mainAppWindow/browserWindowManager.js`). The inline comment gives the
reason: "Required for ReactHandler DOM access". `app/security/ipcValidator.js`
describes itself as "a compensating control for disabled contextIsolation and
sandbox features".

This is the single largest finding in an enterprise security review of the
application. Electron's own security checklist treats context isolation as the
primary defence for any renderer that loads remote content, and this renderer
loads `teams.microsoft.com`.

### What the current setting actually exposes

With `contextIsolation: false`, the preload script and the page share one
JavaScript context. `nodeIntegration` is `false`, so the page cannot reach
`require` --- the module wrapper keeps it out of global scope. The page's entire
privileged surface is therefore whatever the preload assigns to `globalThis`.

That surface used to be a 22-entry `globalThis.electronAPI` object including
`graphApi.getMailMessages`, `graphApi.getUserProfile`, `getConfig`,
`setUserStatus`, `setBadgeCount` and the zoom controls. Any script running in
the Teams page --- Teams itself, an injected custom script, or anything achieved
through an XSS in Teams --- could call all of them. Reading the user's mail
through `graphApi.getMailMessages` required one line of page JavaScript.

The IPC allowlist does not help here. It validates *channel names*, not
*callers*. Every one of those calls used an allowlisted channel.

That surface has since been reduced to two functions (see "Work already
completed"), which removes the exfiltration path. Context isolation remains the
structural fix, because it removes the *category* rather than the instances.

### Why the flag cannot simply be flipped

`ReactHandler` reaches Teams' internals through an expando property React
attaches to a DOM node:

```js
// app/browser/tools/reactHandler.js
const internalRoot =
  reactElement?._reactRootContainer?._internalRoot ||
  reactElement?._reactRootContainer;
```

DOM *nodes* are shared between the isolated world and the main world.
JavaScript properties that page scripts attach to those nodes are not.
`_reactRootContainer` is written by React in the main world, so an isolated
preload sees `undefined`. Turning the flag on silently disables everything
downstream of `ReactHandler`.

The same applies to every tool that patches a page global. `getUserMedia`
patched from an isolated world patches the isolated world's copy; the page keeps
calling the original.

### Scope of the change

Of the 16 preload-loaded browser tools, these depend on main-world execution:

| Module | Main-world dependency |
|---|---|
| `reactHandler.js` | React internals via `_reactRootContainer` |
| `activityHub.js` | `reactHandler` |
| `settings.js` | `reactHandler` |
| `theme.js` | `reactHandler` |
| `timestampCopyOverride.js` | `reactHandler` |
| `tokenCache.js` | injects into Teams' MSAL auth provider |
| `mqttStatusMonitor.js` | `activityHub` |
| `notifications/activityManager.js` | `activityHub` |
| `speakingIndicator.js` | patches `RTCPeerConnection` |
| `cameraResolution.js`, `cameraAspectRatio.js` | patch `getUserMedia` |
| `disableAutogain.js` | patches `getUserMedia` |
| `preload.js` (Notification override) | replaces `globalThis.Notification` |

These are DOM-only and work unchanged under isolation: `zoom.js`,
`shortcuts.js`, `mutationTitle.js`, `trayIconRenderer.js`,
`navigationButtons.js`, `frameless.js`, `emulatePlatform.js`.

So roughly half the browser layer, including all of the fragile
Teams-internals code, has to move.

## Decision

Migrate in stages using a **main-world agent plus isolated-world bridge**, the
same pattern browser extensions use for `MAIN` world injection.

The application already runs one main-world agent:
`app/screenSharing/injectedScreenSharing.js` is delivered with
`webContents.executeJavaScript` and talks to the main process through
`globalThis.electronAPI`. The migration generalises that arrangement instead of
inventing a new one.

### Target architecture

```
main process
    │  ipcMain (allowlisted channels)
    ▼
preload (isolated world)          ── owns ipcRenderer
    │  contextBridge.exposeInMainWorld("teamsForLinuxBridge", …)
    │  window.postMessage, correlated request/response
    ▼
main-world agent (injected <script>) ── owns React internals, page globals
    ▼
Teams page
```

- The preload keeps `ipcRenderer` and never exposes it.
- `contextBridge.exposeInMainWorld` publishes a narrow, explicitly enumerated
  API. Only functions, never objects carrying prototypes.
- The agent bundle carries everything that must touch page state.
- The two halves exchange correlated messages.

### Message validation is mandatory

The page can forge any message the agent can send. Every message crossing into
the isolated world must be validated:

- `event.source === window` and `event.origin` matches the page origin
- a request id issued by the isolated world, so unsolicited replies are dropped
- a per-session nonce, so page scripts cannot guess the channel
- a schema check on the payload before it reaches `ipcRenderer`

A bridge that forwards unvalidated page messages to `ipcRenderer` is *worse*
than the current arrangement: it re-exposes the same surface while looking
secure.

### Staged plan

Each stage ships independently and is separately revertible. `contextIsolation`
stays `false` until stage 5.

1. **Shrink the exposed surface.** Remove everything from
   `globalThis.electronAPI` that is not consumed. Done --- see below.
2. **Build the bridge.** Agent loader, correlated messaging, validation, unit
   tests for the validation logic. No behaviour change; nothing uses it yet.
   Done --- see below.
3. **Migrate the page-global patchers.** `disableAutogain`, `cameraResolution`,
   `cameraAspectRatio`, `speakingIndicator`, the Notification override. These
   are self-contained and their failure modes are visible in ordinary use
   (camera, microphone, notifications), so they are the honest first test.
4. **Migrate the React-internals tools.** `reactHandler` and its dependants,
   then `tokenCache`. This is the risky stage: Teams' internals are
   undocumented and change without notice. Needs authenticated testing against a
   real tenant.
5. **Flip `contextIsolation: true`.** Only once stages 3 and 4 are verified
   against a real Teams session.
6. **Evaluate `sandbox: true`** separately. It additionally forbids Node APIs in
   the preload, so `require("electron-log")` and the `require`-based module
   loader must go first. Treat as a follow-up, not part of this migration.

### Verification requirements

Stages 3--5 cannot be validated against `about:blank` or a stub page, and the
existing unauthenticated E2E suite will pass whether or not Teams integration
works. Each of these stages requires the authenticated Playwright suite
(`npm run test:authenticated`) against a real tenant, covering at minimum:
sign-in, notification delivery, camera and microphone in a call, screen
sharing, tray badge counts, and idle/presence reporting.

## Consequences

### Positive

- Page script can no longer reach any privileged call it was not explicitly
  handed, structurally rather than by enumeration.
- The `ipcValidator` stops being a compensating control and becomes
  defence in depth.
- Removes the standing finding that blocks enterprise security review.
- Makes `sandbox: true` reachable later.

### Negative

- Large change to the most fragile part of the codebase. Teams' React internals
  are undocumented and already break on Teams-side changes.
- Adds a message hop to every main-world interaction; the tools involved are
  event-driven rather than hot paths, so the cost should not be observable, but
  it must be measured in stage 3.
- The bridge is itself security-sensitive. Done carelessly it reintroduces the
  exposure it removes.
- Requires authenticated test infrastructure that currently covers 6--7 tests.

### Rejected alternatives

**Move `ReactHandler` into the main process via `webContents.executeJavaScript`.**
Executes in the main world, so it works. Rejected: every call becomes an async
round trip returning only structured-cloneable values, the module structure is
lost to string-serialised scripts, and debugging becomes materially worse.

**Keep `contextIsolation: false` and rely on the IPC allowlist.**
This is the status quo. The allowlist validates channel names, not callers, so
it cannot distinguish the preload from the page. Not a substitute.

**Flip the flag and fix what breaks.**
Rejected: failures are silent. `ReactHandler` returns `null` and its callers
degrade quietly, so presence, tray counts, theme and token caching would break
in ways that reach users before anyone notices.

## Work already completed

Stage 1 shipped. `globalThis.electronAPI` went from 22 entries to 2:

- Removed as unused by any renderer code: `desktopCapture`, `getConfig`,
  `setBadgeCount`, `updateTray`, `onSystemThemeChanged`, `setUserStatus`,
  `getZoomLevel`, `saveZoomLevel`, `stopSharing`, `sendSelectSource`,
  `onSelectSource`, `openChatWithUser`, `sessionType`, and the whole `graphApi`
  group including `getMailMessages`.
- Moved into preload scope: `showNotification`, `playNotificationSound`,
  `sendNotificationToast`, used only by the Notification override, which shares
  the preload's context.
- Moved to direct `ipcRenderer`: the four navigation calls, by adding
  `navigationButtons` to `modulesRequiringIpc`.
- Retained: `sendScreenSharingStarted` and `sendScreenSharingStopped`, the only
  calls with a genuine main-world caller.

Quick Chat was unaffected: it is a separate window with its own isolated
preload using different channels (`graph-api-search-people`,
`graph-api-send-chat-message`).

Stage 2 shipped. `app/browser/bridge/` contains the three pieces the remaining
stages need:

- `protocol.js` --- message format and validation, free of Electron and DOM so
  the security decisions are directly testable.
- `isolatedBridge.js` --- runs in the preload, owns `ipcRenderer`, injects the
  agent, correlates requests with responses.
- `mainWorldAgent.js` --- the agent runtime, stringified and injected rather
  than required.

Nothing uses it yet; it ships inert so the protocol could be reviewed before a
tool depends on it. 67 unit tests cover the validation rules, request
correlation and hostile inbound traffic, plus an interop suite that runs the
real agent source in a vm context against a real bridge --- the two halves are
written against the same protocol but never import each other, so only a round
trip proves they agree.

One correction to the design sketched above: the per-session id is described
there as a nonce that stops page scripts guessing the channel. That
overstates it. The agent runs in the page world, so any script sharing that
world can read the id off the traffic. It prevents unrelated `postMessage`
traffic being mistaken for bridge messages, nothing more. The controls that
actually hold are the channel allowlist, the per-channel payload validators, and
refusing responses that do not answer an outstanding request on the same
channel. `app/browser/bridge/README.md` states this plainly so the id is not
mistaken for authentication later.

Related hardening shipped alongside: `webviewTag` is now `false` (no `<webview>`
exists in the application), and a `will-attach-webview` guard forces isolation
on should one ever be attached --- see `app/security/webContentsGuards.js`.

## References

- [Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- `app/security/webContentsGuards.js` --- permission, device and navigation guards
- `app/screenSharing/injectedScreenSharing.js` --- existing main-world agent
- ADR 002 --- Token Cache Secure Storage (`tokenCache.js`, affected by stage 4)
