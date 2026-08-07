#!/usr/bin/env bash
# OpenLLM CLI installer — installs `openllm` (plus the `ollm` alias) ONLY.
#
#   curl -fsSL https://raw.githubusercontent.com/openllmsh/cli/main/install.sh | bash
#
# Most people want the full install (daemon + CLI), which is:
#   curl -fsSL https://openllm.sh/install | bash
# Use THIS script when you want the CLI alone — to script against the gateway
# API, to run clients through OpenLLM without the local subscription daemon, or
# to pre-provision a machine.
#
# Env (all optional):
#   OPENLLM_CLOUD_ORIGIN   gateway origin (default https://openllm.sh)
#   OPENLLM_API_KEY        written to the shared ~/.openllm/.env when given
#
# It knows nothing about clients (claude / codex / grok / …) and never edits a
# third-party config — `openllm <client>` applies OpenLLM at run time instead.
set -euo pipefail

ORIGIN="${OPENLLM_CLOUD_ORIGIN:-https://openllm.sh}"
ORIGIN="${ORIGIN%/}"
OPENLLM_DIR="$HOME/.openllm"
BIN_DIR="$OPENLLM_DIR/bin"
ENV_FILE="$OPENLLM_DIR/.env"

has_command() { command -v "$1" >/dev/null 2>&1; }
die() { echo "Error: $*" >&2; exit 1; }

sha256_of() {
  if has_command shasum; then shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif has_command sha256sum; then sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  fi
}

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *) die "unsupported OS $(uname -s) — OpenLLM supports macOS and Linux" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64-baseline" ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
TARGET="${OS}-${ARCH}"

has_command curl || die "curl is required"
if ! has_command shasum && ! has_command sha256sum; then
  die "shasum or sha256sum is required to verify the download"
fi

mkdir -p "$BIN_DIR"

# /api/install validates the committed release pins server-side and fails
# closed, so a mis-pinned or half-published release is refused before any
# download. No query parameters.
echo "Resolving the current OpenLLM CLI release..."
MANIFEST="$(curl -fsSL "$ORIGIN/api/install" 2>/dev/null)" \
  || die "could not reach $ORIGIN/api/install — check OPENLLM_CLOUD_ORIGIN and your network"

json_field() {
  printf '%s' "$MANIFEST" \
    | tr -d '\n' \
    | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}
CLI_VERSION="$(json_field cli_version)"
[ -n "$CLI_VERSION" ] || die "no CLI release is published yet"

DEST="$BIN_DIR/openllm"
URL="$ORIGIN/api/cli/binary/$TARGET"
STAMP="$BIN_DIR/.openllm.sha256.stamp"

PUBLISHED="$(curl -fsSL "$URL.sha256" 2>/dev/null | cut -d' ' -f1 || true)"
case "$PUBLISHED" in
  [0-9a-f]*) [ ${#PUBLISHED} -eq 64 ] || die "malformed published checksum" ;;
  *) die "no published binary for $TARGET yet" ;;
esac

# Skip the download when what's installed already matches (see the daemon
# installer for the macOS codesign/stamp rationale).
SKIP=0
if [ -x "$DEST" ]; then
  INSTALLED="$(sha256_of "$DEST" || true)"
  if [ -n "$INSTALLED" ]; then
    if [ "$INSTALLED" = "$PUBLISHED" ]; then
      SKIP=1
    elif [ -f "$STAMP" ]; then
      read -r SP SI < "$STAMP" || true
      [ "$SP" = "$PUBLISHED" ] && [ "$SI" = "$INSTALLED" ] && SKIP=1
    fi
  fi
fi

if [ "$SKIP" = "1" ]; then
  echo "  openllm is already up to date"
else
  echo "Downloading openllm $CLI_VERSION ($TARGET)..."
  DL="$BIN_DIR/.openllm.download.$$"
  BIN="$BIN_DIR/.openllm.bin.$$"
  trap 'rm -f "$DL" "$BIN"' EXIT
  if [ -t 2 ]; then
    curl -fL --progress-bar "$URL" -o "$DL" || die "download failed: $URL"
  else
    curl -fsSL "$URL" -o "$DL" || die "download failed: $URL"
  fi
  # The pinned digest is over the DECOMPRESSED binary.
  if gzip -t "$DL" >/dev/null 2>&1; then
    gzip -dc "$DL" > "$BIN" || die "could not decompress openllm"
  else
    mv "$DL" "$BIN"
  fi
  ACTUAL="$(sha256_of "$BIN")"
  [ -n "$ACTUAL" ] || die "could not hash the download"
  [ "$ACTUAL" = "$PUBLISHED" ] \
    || die "checksum mismatch (expected $PUBLISHED, got $ACTUAL) — refusing to install"
  chmod 0755 "$BIN"
  mv -f "$BIN" "$DEST"
  # Preserve a valid Developer ID / notarized signature; only ad-hoc when invalid.
  if [ "$OS" = "darwin" ]; then
    xattr -d com.apple.quarantine "$DEST" >/dev/null 2>&1 || true
    if ! codesign --verify "$DEST" >/dev/null 2>&1; then
      codesign --force --sign - "$DEST" >/dev/null 2>&1 || true
      printf '%s %s\n' "$PUBLISHED" "$(sha256_of "$DEST")" > "$STAMP" 2>/dev/null || true
    fi
  fi
  echo "  openllm installed → $DEST"
fi

# Record the gateway origin (and a key, when supplied) in the SHARED config file
# the daemon also boots from. Never clobber an existing key with nothing.
# Always refresh OPENLLM_CLOUD_ORIGIN so origin changes are propagated.
EXISTING_KEY=""
EXISTING_DEVICE_ID=""
if [ -f "$ENV_FILE" ]; then
  EXISTING_KEY="$(sed -n 's/^OPENLLM_API_KEY=//p' "$ENV_FILE" | head -1)"
  EXISTING_DEVICE_ID="$(sed -n 's/^OPENLLM_DEVICE_ID=//p' "$ENV_FILE" | head -1)"
fi
API_KEY="${OPENLLM_API_KEY:-$EXISTING_KEY}"
# umask in a SUBSHELL: this write is now unconditional, so a bare `umask 077`
# would leak owner-only mode into everything after it — including the rc file
# `$DEST setup` appends to.
(
  umask 077
  {
    echo "OPENLLM_CLOUD_ORIGIN=$ORIGIN"
    [ -n "$API_KEY" ] && echo "OPENLLM_API_KEY=$API_KEY"
    [ -n "$EXISTING_DEVICE_ID" ] && echo "OPENLLM_DEVICE_ID=$EXISTING_DEVICE_ID"
  } > "$ENV_FILE"
)
chmod 0600 "$ENV_FILE"
echo "  gateway config written → $ENV_FILE"

# PATH symlinks (openllm + ollm), the marked rc block, and completion for both
# names — the same code path a human runs as `openllm setup`.
"$DEST" setup || echo "  note: run '$DEST setup' yourself to finish shell setup"

cat <<EOF

The OpenLLM CLI is installed.

  openllm claude           run Claude Code through OpenLLM
  ollm codex               (short alias) run Codex through OpenLLM
  openllm --help           everything else

Open a new shell (or source your rc) so \`openllm\` and \`ollm\` are on PATH.
Subscription providers (Claude / Codex / Kimi) need the local daemon too:
  curl -fsSL $ORIGIN/install | bash
EOF
