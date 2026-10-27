#!/usr/bin/env bash
#
# install.sh — fetch and build `srtla_rec` for the srtla2platform agent.
#
# Clones https://github.com/irlserver/srtla (pinned to rev b8359bc by default,
# the same revision the OBS SRTLA input plugin embeds), builds `srtla_rec`
# with CMake, and installs it on $PATH so `srtla2platform.ts` can find it.
#
# Usage:
#   bash install.sh                  # build srtla_rec and install it
#   bash install.sh --install-deps   # also apt-install build deps (needs root)
#   bash install.sh --help
#
# Environment overrides:
#   SRTLA_REPO         git repo url (default: https://github.com/irlserver/srtla.git)
#   SRTLA_REF          git ref to build (default: b8359bc)
#   SRTLA_SRC_DIR      work dir for clone + build
#                      (default: ~/.cache/srtla2platform/srtla)
#   SRTLA_INSTALL_DIR  where to put the binary
#                      (default: /usr/local/bin as root, ~/.local/bin otherwise)

set -euo pipefail

SRTLA_REPO="${SRTLA_REPO:-https://github.com/irlserver/srtla.git}"
SRTLA_REF="${SRTLA_REF:-b8359bc}"
SRTLA_SRC_DIR="${SRTLA_SRC_DIR:-$HOME/.cache/srtla2platform/srtla}"
SRTLA_BUILD_DIR="$SRTLA_SRC_DIR/build"
INSTALL_DEPS=0

c_info() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; }
die()    { c_err "$*"; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --install-deps) INSTALL_DEPS=1 ;;
        --help|-h)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
    shift
done

have() { command -v "$1" >/dev/null 2>&1; }

# ── Dependencies ─────────────────────────────────────────────────────────────

missing=()
for tool in git cmake g++ make; do
    have "$tool" || missing+=("$tool")
done

if [ "${#missing[@]}" -gt 0 ]; then
    if [ "$INSTALL_DEPS" -eq 1 ] && [ "$(id -u)" -eq 0 ] && have apt-get; then
        c_info "installing missing build deps: ${missing[*]}"
        apt-get update -qq
        apt-get install -y -qq git build-essential cmake
    else
        die "missing build dependencies: ${missing[*]}.
  Debian/Ubuntu:  apt-get install git build-essential cmake   (or rerun with --install-deps as root)"
    fi
fi

# CMake >= 3.16 is required by the project.
cmake_ver=$(cmake --version | awk '/version/ {print $2; exit}')
cmin=$(printf '%s\n' "3.16" "$cmake_ver" | sort -V | head -n1)
[ "$cmin" = "3.16" ] || die "cmake >= 3.16 required (found $cmake_ver)"

# ── Fetch source ─────────────────────────────────────────────────────────────

if [ -d "$SRTLA_SRC_DIR/.git" ]; then
    remote=$(git -C "$SRTLA_SRC_DIR" remote get-url origin 2>/dev/null || true)
    if [ "$remote" != "$SRTLA_REPO" ]; then
        c_info "work dir $SRTLA_SRC_DIR points at $remote, removing"
        rm -rf "$SRTLA_SRC_DIR"
    fi
fi

if [ ! -d "$SRTLA_SRC_DIR/.git" ]; then
    c_info "cloning $SRTLA_REPO → $SRTLA_SRC_DIR"
    mkdir -p "$(dirname "$SRTLA_SRC_DIR")"
    git clone --quiet "$SRTLA_REPO" "$SRTLA_SRC_DIR"
fi

c_info "checking out ref: $SRTLA_REF"
if ! git -C "$SRTLA_SRC_DIR" checkout --quiet --force "$SRTLA_REF"; then
    # Ref not present in the clone (e.g. a tag/SHA not on the default branch).
    git -C "$SRTLA_SRC_DIR" fetch --quiet --force --tags origin
    git -C "$SRTLA_SRC_DIR" fetch --quiet --force origin '+refs/heads/*:refs/remotes/origin/*'
    git -C "$SRTLA_SRC_DIR" checkout --quiet --force "$SRTLA_REF" \
        || die "cannot checkout ref '$SRTLA_REF' (try SRTLA_REF=master or a full 40-char SHA)"
fi
c_info "initializing submodules (deps/argparse)"
git -C "$SRTLA_SRC_DIR" submodule update --init --recursive --quiet
c_info "building at commit: $(git -C "$SRTLA_SRC_DIR" rev-parse --short HEAD)"

# ── Build ────────────────────────────────────────────────────────────────────

c_info "configuring (CMake, Release)"
cmake -S "$SRTLA_SRC_DIR" -B "$SRTLA_BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
c_info "compiling srtla_rec"
cmake --build "$SRTLA_BUILD_DIR" --target srtla_rec --parallel "$(nproc)"

src_bin="$SRTLA_BUILD_DIR/srtla_rec"
[ -x "$src_bin" ] || die "build did not produce $src_bin"

# ── Install ──────────────────────────────────────────────────────────────────

if [ -z "${SRTLA_INSTALL_DIR:-}" ]; then
    if [ "$(id -u)" -eq 0 ]; then
        SRTLA_INSTALL_DIR=/usr/local/bin
    else
        SRTLA_INSTALL_DIR="$HOME/.local/bin"
    fi
fi

mkdir -p "$SRTLA_INSTALL_DIR"
install -m 0755 "$src_bin" "$SRTLA_INSTALL_DIR/srtla_rec"

# ── Verify ───────────────────────────────────────────────────────────────────

inst_bin="$SRTLA_INSTALL_DIR/srtla_rec"
if "$inst_bin" --help >/dev/null 2>&1; then
    c_info "verified: $inst_bin --help"
fi

c_info "done. srtla_rec installed at: $inst_bin"
case ":$PATH:" in
    *":$SRTLA_INSTALL_DIR:"*) ;;
    *)
        c_info "NOTE: $SRTLA_INSTALL_DIR is not on your PATH. Add it, e.g."
        c_info "  echo 'export PATH=\"$SRTLA_INSTALL_DIR:\$PATH\"' >> ~/.bashrc"
        ;;
esac
c_info "srtla2platform preflight now passes: $(command -v srtla_rec || echo "srtla_rec (not on PATH yet — see note above)")"
