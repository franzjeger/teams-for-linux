#!/usr/bin/env bash
#
# Install Teams for Linux on Arch Linux from a pacman package.
#
# The package is produced by `npm run dist:linux:x64` (or the arm variants) and
# published as a build artifact. Installing through pacman rather than unpacking
# a tarball means the app is upgradable and removable like any other package,
# which is what makes `disableAutoUpdate` a sensible policy for a managed fleet:
# updates arrive through the package manager instead of the in-app updater.
#
# Usage:
#   sudo ./install-arch.sh teams-for-linux-2.8.0.pacman
#   sudo ./install-arch.sh --policy corp-policy.json teams-for-linux-2.8.0.pacman
#   ./install-arch.sh --check-only teams-for-linux-2.8.0.pacman
#
set -euo pipefail

POLICY_FILE=""
CHECK_ONLY=0
DRY_RUN=0
ASSUME_YES=0
PACKAGE=""

POLICY_DEST="/etc/teams-for-linux/config.json"

usage() {
  cat <<'EOF'
Install Teams for Linux on Arch Linux.

Usage:
  install-arch.sh [options] <package.pacman>

Options:
  --policy FILE   Install FILE as /etc/teams-for-linux/config.json. Use this to
                  deploy a managed policy; see the Managed Policy section of the
                  configuration docs. An existing file is backed up first.
  --check-only    Verify the package and its dependencies, then stop without
                  installing. Does not require root.
  --dry-run       Show what would happen without changing anything.
  --yes           Do not prompt for confirmation.
  -h, --help      Show this help.

Examples:
  sudo ./install-arch.sh teams-for-linux-2.8.0.pacman
  sudo ./install-arch.sh --policy /srv/teams-policy.json teams-for-linux-2.8.0.pacman
  ./install-arch.sh --check-only teams-for-linux-2.8.0.pacman
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

info() { echo "==> $*"; }
warn() { echo "warning: $*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --policy)
      [[ $# -ge 2 ]] || die "--policy needs a file argument"
      POLICY_FILE="$2"
      shift 2
      ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *)
      [[ -z "$PACKAGE" ]] || die "more than one package given: '$PACKAGE' and '$1'"
      PACKAGE="$1"
      shift
      ;;
  esac
done

[[ -n "$PACKAGE" ]] || { usage >&2; die "no package given"; }
[[ -f "$PACKAGE" ]] || die "package not found: $PACKAGE"
[[ -r "$PACKAGE" ]] || die "package not readable: $PACKAGE"

command -v pacman >/dev/null 2>&1 || die "pacman not found; this script is for Arch Linux and derivatives"

# ---------------------------------------------------------------------------
# Verify the package before touching the system.
# ---------------------------------------------------------------------------
info "Inspecting $PACKAGE"

PKG_INFO=""
if ! PKG_INFO="$(pacman -Qip "$PACKAGE" 2>/dev/null)"; then
  die "pacman could not read '$PACKAGE'; it does not look like a valid package"
fi

PKG_NAME="$(awk -F': *' '/^Name/ { print $2; exit }' <<<"$PKG_INFO")"
PKG_VERSION="$(awk -F': *' '/^Version/ { print $2; exit }' <<<"$PKG_INFO")"
PKG_ARCH="$(awk -F': *' '/^Architecture/ { print $2; exit }' <<<"$PKG_INFO")"

[[ "$PKG_NAME" == "teams-for-linux" ]] ||
  die "expected a teams-for-linux package, got '$PKG_NAME'"

info "Package:      $PKG_NAME $PKG_VERSION ($PKG_ARCH)"

# Refuse an obvious architecture mismatch rather than letting pacman fail later
# with a less clear message. "any" is accepted as architecture-independent.
HOST_ARCH="$(uname -m)"
if [[ "$PKG_ARCH" != "any" && "$PKG_ARCH" != "$HOST_ARCH" ]]; then
  die "package architecture '$PKG_ARCH' does not match this machine ('$HOST_ARCH')"
fi

# ---------------------------------------------------------------------------
# Dependency check.
#
# The package's dependency names are declared in package.json under
# build.pacman.depends. They are Arch package names, which differ from the
# deb/rpm names electron-builder uses by default, so this check is what catches
# a name that does not exist in the repos.
# ---------------------------------------------------------------------------
DEPENDS="$(awk -F': *' '/^Depends On/ { print $2; exit }' <<<"$PKG_INFO")"
if [[ -n "$DEPENDS" && "$DEPENDS" != "None" ]]; then
  info "Checking dependencies: $DEPENDS"
  # Split into an array: pacman -T takes one argument per dependency, so the
  # list cannot be passed as a single quoted word.
  read -ra DEP_LIST <<<"$DEPENDS"
  # pacman -T prints the dependencies that are NOT satisfied and exits non-zero.
  MISSING="$(pacman -T "${DEP_LIST[@]}" 2>/dev/null || true)"
  if [[ -n "$MISSING" ]]; then
    warn "the following dependencies are not installed:"
    while read -r dep; do
      [[ -n "$dep" ]] && echo "  - $dep" >&2
    done <<<"$MISSING"
    echo >&2
    echo "pacman will try to resolve these from your configured repositories." >&2
    echo "If any of them cannot be found, the name is wrong for Arch and should" >&2
    echo "be corrected in package.json under build.pacman.depends." >&2
  else
    info "All dependencies satisfied"
  fi
fi

if [[ -n "$POLICY_FILE" ]]; then
  [[ -f "$POLICY_FILE" ]] || die "policy file not found: $POLICY_FILE"
  # Validate the JSON before installing it. A malformed system config makes the
  # app fall back to defaults and show a dialog, which is a confusing failure to
  # debug on someone else's machine.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$POLICY_FILE" 2>/dev/null ||
      die "policy file is not valid JSON: $POLICY_FILE"
    info "Policy file is valid JSON"
  else
    warn "python3 not available; skipping JSON validation of the policy file"
  fi
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  info "Check complete; nothing installed (--check-only)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Install.
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" -eq 0 && "$EUID" -ne 0 ]]; then
  die "installing requires root; re-run with sudo (or use --check-only)"
fi

PACMAN_ARGS=(-U "$PACKAGE")
[[ "$ASSUME_YES" -eq 1 ]] && PACMAN_ARGS+=(--noconfirm)

if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] would run: pacman ${PACMAN_ARGS[*]}"
  [[ -n "$POLICY_FILE" ]] && info "[dry-run] would install $POLICY_FILE to $POLICY_DEST"
  exit 0
fi

info "Installing $PKG_NAME $PKG_VERSION"
pacman "${PACMAN_ARGS[@]}"

# ---------------------------------------------------------------------------
# Managed policy.
#
# Deliberately installed after the package: pacman owns /opt/teams-for-linux,
# but the system config lives outside the package so an upgrade never overwrites
# a deployed policy.
# ---------------------------------------------------------------------------
if [[ -n "$POLICY_FILE" ]]; then
  install -d -m 0755 -o root -g root /etc/teams-for-linux

  if [[ -f "$POLICY_DEST" ]]; then
    BACKUP="${POLICY_DEST}.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$POLICY_DEST" "$BACKUP"
    info "Existing policy backed up to $BACKUP"
  fi

  # 0644: readable by the app running as the user, writable only by root. The
  # policy is a manageability control, not a secret, but it must not be
  # user-writable or the locked settings could simply be edited.
  install -m 0644 -o root -g root "$POLICY_FILE" "$POLICY_DEST"
  info "Managed policy installed to $POLICY_DEST"
fi

info "Done"
echo
echo "Launch with:  teams-for-linux"
if [[ -n "$POLICY_FILE" ]]; then
  echo "Locked settings take effect on next start. Override attempts are logged"
  echo "with a [POLICY] prefix."
fi
