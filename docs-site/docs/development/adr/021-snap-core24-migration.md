---
id: 021-snap-core24-migration
---

# ADR 021: Snap core24 Migration

## Status

Implemented (x64, arm64) --- armv7l unresolved, see Consequences

## Context

All snap builds were failing:

```
Command failed: snapcraft snap --output out.snap
The 'snap' command was renamed to 'pack'.
```

app-builder-lib rewrote its snap support between 26.8.1 and 26.15.x:

- **26.8.1** built snaps with `executeAppBuilder`, the app-builder Go binary. It
  never invoked the `snapcraft` CLI, so the CLI's interface was irrelevant.
- **26.15.x** replaced that with `out/targets/snap/`, which shells out to
  `snapcraft`. It has two strategies: a core24 path
  (`snapcraftBuilder.js`, uses `pack`) and a legacy path for core18/20/22
  (`coreLegacy.js`, still passes the removed `snap` subcommand).

`"base": "core22"` routed to the legacy path, which is broken against current
snapcraft and remains broken through 26.15.7. The dependency bump that surfaced
this came from clearing 19 npm advisories, so reverting it was not attractive.

electron-builder also warns on every build:

```
please consider migrating `snap` configuration to `snapcraft.<core>`
reason=`snap` configuration is deprecated
```

## Decision

Move the snap configuration from the deprecated `snap` key to
`snapcraft.core24` and set `snapcraft.base: "core24"`.

`LinuxTargetHelper.getSnapCore()` selects the strategy from `snapcraft.base`
and reads per-core options from `snapcraft[base]`. Note that `publish` is read
from `snapcraft.publish` --- the root of the `snapcraft` block, not from inside
`core24`.

Electron 41 satisfies core24's requirement (25 minimum, 28 recommended).

### The `browser-support` plug is load-bearing

core24 injects `browser-support` with `allow-sandbox: true` **only when the
project supplies no custom `plugs`**:

```js
// core24.js
if (!options.plugs) {
  rootPlugs = { ...rootPlugs, "browser-support": { interface: "browser-support", "allow-sandbox": true } }
  ...
}
if (isElectronVersionGreaterOrEqualThan("5.0.0") && !isBrowserSandboxAllowed(rootPlugs)) {
  extraArgs.push("--no-sandbox")   // <-- appended to the snap's command
}
```

This project does supply custom plugs, so the injection is skipped and
electron-builder appends `--no-sandbox` to the launch command instead. Verified
by generating the descriptor both ways:

| Config | Generated `command` |
|---|---|
| plugs without `browser-support` | `app/teams-for-linux --ozone-platform=x11 --no-sandbox` |
| plugs with `browser-support` | `app/teams-for-linux --ozone-platform=x11` |

Shipping the first would disable Chromium's sandbox in every snap install. The
plug list therefore ends with an explicit descriptor object:

```json
{ "browser-support": { "interface": "browser-support", "allow-sandbox": true } }
```

**Do not remove this entry** when editing the plug list. It looks redundant
next to the string plugs, but dropping it silently re-adds `--no-sandbox`.
electron-builder's own comment explains why the plug is needed at all: without
`allow-sandbox: true` under strict confinement, Chromium cannot create user
namespaces and the app dies with `FATAL: Permission denied (13)` in
`credentials.cc`.

### What core24 changes for free

The generated descriptor now sets `extensions: [gnome]`, which supplies the
GTK/icon/sound themes and the GNOME platform content snaps that previously had
to be wired up by hand. The `"default"` keyword in the plug list expands to
core24's own default set, which adds `wayland` and `opengl` compared to the
core22 defaults.

## Consequences

### Positive

- Snap builds take the maintained code path instead of one that cannot work.
- Keeps the dependency security fixes rather than pinning back to 26.8.1.
- Removes the deprecation warning.
- The GNOME extension replaces manual theme and platform plumbing.

### Negative / unresolved

- **armv7l is unresolved.** The `snap-armv7l` CI job deliberately runs without
  LXD, on the premise that "electron-builder handles armv7l cross-compilation
  directly" --- true of the old Go-binary path, not of core24, which must run
  `snapcraft pack`. core24 emits a `platforms: { armhf: { build-on: amd64 } }`
  block for cross-arch builds, but cross-building armhf on an amd64 runner needs
  either an armhf container with qemu binfmt or a Launchpad remote build.
  Neither is configured. x64 and arm64 are unaffected --- both run on native
  runners (`ubuntu-latest` and `ubuntu-24.04-arm`).
- The base moves from Ubuntu 22.04 to 24.04, so bundled system libraries change.
  This needs runtime verification, not just a successful build.
- `--no-sandbox` regression risk is now a standing trap for anyone editing the
  plug list; hence this ADR.

### Verification status

Confirmed locally by generating and inspecting the descriptor
(`base: core24`, root `browser-support` plug present, no `--no-sandbox`, all 21
plugs resolved, `extensions: [gnome]`). The build cannot be completed in a
sandbox without snapcraft and LXD, so per-architecture packaging and runtime
behaviour --- screen sharing, camera and microphone, tray icon, Wayland and X11
--- must be checked against CI artifacts and a real install.

## References

- Issue #16 --- follow-up tracking, with the full verification checklist
- `node_modules/app-builder-lib/out/targets/snap/core24.js` --- plug and command handling
- `node_modules/app-builder-lib/out/targets/LinuxTargetHelper.js` --- `getSnapCore()` strategy selection
- [snapcraft GNOME extension](https://snapcraft.io/docs/gnome-extension)
