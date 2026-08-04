---
id: 021-snap-core24-migration
---

# ADR 021: Snap core24 Migration

## Status

Implemented --- armv7l outcome not yet established, see Consequences

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
| plugs without `browser-support` | `app/teams-for-linux --no-sandbox` |
| plugs with `browser-support` | `app/teams-for-linux` |

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

### `executableArgs` must be cleared, not emptied

snapcraft 9 rejects a `command` containing `=`:

```
app commands must consist of only alphanumeric characters, spaces, and the
following characters: / . _ # : $ -
(in field 'has-base.core24.apps.teams-for-linux.command',
 input: 'app/teams-for-linux --ozone-platform=x11')
```

core24 appends `executableArgs` directly into the app's `command`, so
`--ozone-platform=x11` made the descriptor invalid on **every** architecture.
The X11 preference therefore moves to an environment variable, which Electron
honours identically:

```json
"environment": { "ELECTRON_OZONE_PLATFORM_HINT": "x11" }
```

Removing it from `snapcraft.core24.executableArgs` alone is not enough. The
snap options are built as `deepAssign({}, snapLinuxOptions, options)` where
`snapLinuxOptions` carries the top-level `linux` block --- which also sets
`executableArgs: ["--ozone-platform=x11"]` for deb/rpm/AppImage/tar.gz. And
`deepAssign` **concatenates** arrays rather than replacing them:

| `snapcraft.core24.executableArgs` | Resulting args |
|---|---|
| `[]` | `["--ozone-platform=x11"]` (inherited) |
| `undefined` | `["--ozone-platform=x11"]` (inherited) |
| `["--x"]` | `["--ozone-platform=x11", "--x"]` (concatenated) |
| `null` | `[]` |

Only `null` replaces. Hence the literal `"executableArgs": null` in the config
--- it looks like a mistake, but an empty array silently inherits the very
argument that breaks the build. The top-level `linux.executableArgs` is left
alone so the other Linux package formats keep the flag.

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

- **armv7l outcome is not yet known.** It was predicted to fail on
  cross-compilation, but the first CI run never got that far: all three
  architectures died on the shared `command` schema error above, so armhf
  cross-building has still not actually been exercised. The concern remains
  real --- the `snap-armv7l` job deliberately runs without LXD, on the premise
  that "electron-builder handles armv7l cross-compilation directly", which was
  true of the old Go-binary path but not of core24, which must run
  `snapcraft pack`. core24 emits a `platforms: { armhf: { build-on: amd64 } }`
  block, but cross-building armhf on an amd64 runner needs either an armhf
  container with qemu binfmt or a Launchpad remote build, and neither is
  configured. If it does fail, the options are to configure `remoteBuild`, add
  qemu, or drop the armv7l snap target --- the last being a user-facing
  decision. x64 and arm64 build on native runners (`ubuntu-latest`,
  `ubuntu-24.04-arm`) and are not affected by this.
- The base moves from Ubuntu 22.04 to 24.04, so bundled system libraries change.
  This needs runtime verification, not just a successful build.
- `--no-sandbox` regression risk is now a standing trap for anyone editing the
  plug list; hence this ADR.

### Verification status

Descriptor verified locally (`base: core24`, root `browser-support` plug
present, no `--no-sandbox`, no `=` in the app command, all 21 plugs resolved,
`extensions: [gnome]`).

The first CI run caught what local inspection could not: the descriptor was
well-formed to electron-builder but rejected by snapcraft's own schema, failing
all three architectures identically. Local generation checks what
electron-builder emits; only a real `snapcraft` run checks whether snapcraft
accepts it. Treat a green local descriptor as necessary, not sufficient.

Per-architecture packaging and runtime behaviour --- screen sharing, camera and
microphone, tray icon, Wayland and X11 --- still need checking against CI
artifacts and a real install, since the base moved from Ubuntu 22.04 to 24.04.

## References

- Issue #16 --- follow-up tracking, with the full verification checklist
- `node_modules/app-builder-lib/out/targets/snap/core24.js` --- plug and command handling
- `node_modules/app-builder-lib/out/targets/LinuxTargetHelper.js` --- `getSnapCore()` strategy selection
- [snapcraft GNOME extension](https://snapcraft.io/docs/gnome-extension)
