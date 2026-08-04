---
id: 021-snap-core24-migration
---

# ADR 021: Snap core24 Migration

## Status

Implemented --- all three architectures build

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

### armv7l needs a build environment like every other architecture

The `snap-armv7l` CI job ran without LXD, with a comment stating that
"electron-builder handles armv7l cross-compilation directly". That was accurate
for core22, which built through the app-builder Go binary and never invoked
snapcraft. core24 runs `snapcraft pack`, which needs a build environment, so the
job failed with:

```
Failed to install LXD: user must be manually added to 'lxd' group before using LXD.
```

snapcraft tried to install LXD itself and could not, because the runner user is
not in the `lxd` group. Adding `canonical/setup-lxd` and
`SNAPCRAFT_BUILD_ENVIRONMENT: lxd`, matching the other two jobs, resolved it.

armhf cross-compilation was expected to be the hard part --- core24 emits a
`platforms: { armhf: { build-on: amd64, build-for: armhf } }` block, and the
assumption was that this would additionally need qemu binfmt or a Launchpad
remote build. It did not. Once the build environment existed, snapcraft handled
the cross-build unaided, and the armv7l snap builds on a plain `ubuntu-latest`
runner. No qemu, no remote build, and no need to drop the architecture.

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

- The base moves from Ubuntu 22.04 to 24.04, so bundled system libraries
  change. A green build is not proof the snap works; see Verification status.
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

All three architectures now build and upload a `.snap` artifact
(x64 ~116 MB, arm64 ~110 MB, armv7l ~107 MB), confirmed against both the job
conclusions and the uploaded artifacts rather than a single signal.

Runtime behaviour is still unverified. The base moved from Ubuntu 22.04 to
24.04, so the system libraries under the app changed. Before promoting to
stable, install the artifact and check: launch, screen sharing on X11 and
Wayland, camera and microphone in a call, tray icon, and that the `plugs` list
still grants what it did under core22.

Worth checking explicitly that the sandbox survived packaging:

```bash
snap run --shell teams-for-linux -c 'grep -A2 "command:" $SNAP/meta/snap.yaml'
```

`--no-sandbox` must not appear.

## References

- Issue #16 --- follow-up tracking, with the full verification checklist
- `node_modules/app-builder-lib/out/targets/snap/core24.js` --- plug and command handling
- `node_modules/app-builder-lib/out/targets/LinuxTargetHelper.js` --- `getSnapCore()` strategy selection
- [snapcraft GNOME extension](https://snapcraft.io/docs/gnome-extension)
