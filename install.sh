#!/usr/bin/env bash
# OpenLLM CLI installer — installs `openllm` (plus the `ollm` alias) ONLY.
#
#   curl -fsSL https://raw.githubusercontent.com/openllmsh/cli/main/install.sh | bash
#
# Most people want the full install (daemon + CLI), which is:
#   curl -fsSL https://www.openllm.sh/install | bash
# Use THIS script when you want the CLI alone — to script against the gateway
# API, to run clients through OpenLLM without the local subscription daemon, or
# to pre-provision a machine.
#
# Env (all optional):
#   OPENLLM_CLOUD_ORIGIN   gateway origin (default https://www.openllm.sh).
#                          HTTPS only; http:// is refused. A loopback origin
#                          (127.0.0.1 / localhost / ::1) over http is allowed
#                          ONLY with OPENLLM_ALLOW_INSECURE_ORIGIN=1 (local dev).
#   OPENLLM_API_KEY        written to the shared ~/.openllm/.env when given
#
# It knows nothing about clients (claude / codex / grok / …) and never edits a
# third-party config — `openllm <client>` applies OpenLLM at run time instead.
set -euo pipefail

ORIGIN="${OPENLLM_CLOUD_ORIGIN:-https://www.openllm.sh}"
ORIGIN="${ORIGIN%/}"
OPENLLM_DIR="$HOME/.openllm"
BIN_DIR="$OPENLLM_DIR/bin"
ENV_FILE="$OPENLLM_DIR/.env"

has_command() { command -v "$1" >/dev/null 2>&1; }
die() { echo "Error: $*" >&2; exit 1; }

# --- arguments ---------------------------------------------------------------
# Private-prerelease path (NR2-3): `--from-file <path>` supplies a LOCAL CLI
# binary verified against the operator-provided `--sha256 <hex>` digest of
# THAT file (e.g. `sha256sum openllm-linux-x64-baseline`). When given, NOTHING
# is downloaded — no manifest, no .sha256, no binary fetch. All other
# arguments are rejected so a typo can never silently change an install.
FROM_FILE=""
FROM_SHA=""
usage() {
  cat <<'USAGE'
Usage: install.sh [options]
  --from-file <path>   install the openllm CLI binary from a local file
  --sha256 <hex>       sha256 digest of the --from-file file (required with it)
  -h, --help           show this text
USAGE
}
while [ $# -gt 0 ]; do
  case "$1" in
    --from-file)
      FROM_FILE="${2:-}"
      [ -n "$FROM_FILE" ] || die "--from-file needs a path"
      shift 2
      ;;
    --from-file=*) FROM_FILE="${1#*=}"; shift ;;
    --sha256)
      FROM_SHA="${2:-}"
      [ -n "$FROM_SHA" ] || die "--sha256 needs a hex digest"
      shift 2
      ;;
    --sha256=*) FROM_SHA="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (supported: --from-file, --sha256)" ;;
  esac
done
if [ -n "$FROM_FILE" ] || [ -n "$FROM_SHA" ]; then
  [ -n "$FROM_FILE" ] && [ -n "$FROM_SHA" ] \
    || die "--from-file and --sha256 must be given together"
fi

# Replacement policy: the version advertised by /api/install is the release of
# record — an advertised PRERELEASE is installable, and a prerelease install may
# move to a newer stable (or newer prerelease). The only refusal left is a
# DOWNGRADE: an installed build strictly newer than the advertised release.
DEST="$BIN_DIR/openllm"
# The --version probe bound (DR-7): TERM after VERSION_PROBE_TIMEOUT, then KILL
# after VERSION_PROBE_KILL_GRACE more, so a binary that ignores TERM can never
# hang the installer.
VERSION_PROBE_TIMEOUT=10
VERSION_PROBE_KILL_GRACE=2
probe_version() {
  local binary="$1" probe_file="${TMPDIR:-/tmp}/openllm-version-probe.$$" pid watchdog status
  "$binary" --version >"$probe_file" 2>/dev/null &
  pid=$!
  (
    trap 'kill "$timer" 2>/dev/null || true; exit 0' TERM INT
    sleep "$VERSION_PROBE_TIMEOUT" &
    local timer=$!
    wait "$timer"
    # The probe outlived its bound: TERM, then KILL after the grace window.
    kill -TERM "$pid" 2>/dev/null || true
    sleep "$VERSION_PROBE_KILL_GRACE" &
    timer=$!
    wait "$timer"
    kill -KILL "$pid" 2>/dev/null || true
  ) &
  watchdog=$!
  if wait "$pid"; then status=0; else status=$?; fi
  kill -TERM "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  PROBE_OUTPUT="$(cat "$probe_file" 2>/dev/null || true)"
  rm -f "$probe_file"
  [ "$status" -eq 0 ] \
    || die "version probe timed out or failed at $binary; refusing to overwrite it.
  To repair by hand: move the binary aside ('mv \"$binary\" \"$binary.bak\"') and re-run this installer."
}
# SemVer numeric-identifier predicate: a numeric identifier is `0` or digits
# with NO leading zero. An all-digit identifier WITH a leading zero ("01") is
# not valid numeric — SemVer treats it as alphanumeric — so it must never be
# compared numerically ("beta.01" sorts lexically; it does not equal "beta.1").
semver_num() { [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]; }

# Compare two dotted versions; prints -1, 0 or 1 (a<b, a==b, a>b). One leading
# `v` is stripped (a manifest may advertise "v2.8.0"); build metadata is
# ignored; a prerelease sorts below its release (2.8.0-beta.1 < 2.8.0).
semver_cmp() {
  local a="${1#v}" b="${2#v}" am bm ap bp i
  a="${a%%+*}"; b="${b%%+*}"
  am="${a%%-*}"; bm="${b%%-*}"
  case "$a" in *-*) ap="${a#*-}" ;; *) ap="" ;; esac
  case "$b" in *-*) bp="${b#*-}" ;; *) bp="" ;; esac
  local -a an bn
  IFS='.' read -r -a an <<<"$am"
  IFS='.' read -r -a bn <<<"$bm"
  for i in 0 1 2; do
    local x="${an[i]:-0}" y="${bn[i]:-0}"
    [[ "$x" =~ ^[0-9]+$ ]] || x=0
    [[ "$y" =~ ^[0-9]+$ ]] || y=0
    [ "$x" -lt "$y" ] && { echo -1; return; }
    [ "$x" -gt "$y" ] && { echo 1; return; }
  done
  [ -z "$ap" ] && [ -z "$bp" ] && { echo 0; return; }
  [ -z "$ap" ] && { echo 1; return; }
  [ -z "$bp" ] && { echo -1; return; }
  local -a pa pb
  IFS='.' read -r -a pa <<<"$ap"
  IFS='.' read -r -a pb <<<"$bp"
  local n=$(( ${#pa[@]} > ${#pb[@]} ? ${#pa[@]} : ${#pb[@]} ))
  for ((i = 0; i < n; i++)); do
    local x="${pa[i]:-}" y="${pb[i]:-}"
    [ -z "$x" ] && { echo -1; return; }
    [ -z "$y" ] && { echo 1; return; }
    if semver_num "$x" && semver_num "$y"; then
      [ "$x" -lt "$y" ] && { echo -1; return; }
      [ "$x" -gt "$y" ] && { echo 1; return; }
    elif semver_num "$x"; then
      echo -1; return
    elif semver_num "$y"; then
      echo 1; return
    elif [[ "$x" < "$y" ]]; then
      echo -1; return
    elif [[ "$x" != "$y" ]]; then
      echo 1; return
    fi
  done
  echo 0
}

# Extract the first dotted semver from --version output; empty on no match.
version_of_output() {
  local output="$1"
  if [[ "$output" =~ (^|[^[:alnum:].+_-])v?([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?)([^[:alnum:].+-]|$) ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
    return 0
  fi
  return 1
}

# The one remaining replacement refusal: an installed build NEWER than the
# reference version (the advertised CLI release, or the supplied file's own
# reported version for --from-file). Fail closed with the manual remedy
# printed (DR-1).
assert_no_downgrade() {
  local binary="$1" ref_version="$2" output installed
  [ -n "$ref_version" ] || return 0
  [ -x "$binary" ] || return 0
  probe_version "$binary"
  output="$PROBE_OUTPUT"
  if ! installed="$(version_of_output "$output")"; then
    die "could not parse installed CLI version at $binary; refusing to overwrite it"
  fi
  [ "$(semver_cmp "$installed" "$ref_version")" != "1" ] || die "installed $binary is $installed, newer than the install target $ref_version — refusing to downgrade.
  To force this version, remove $binary and re-run this installer."
}

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

if [ -z "$FROM_FILE" ]; then
  has_command curl || die "curl is required"
fi
if ! has_command shasum && ! has_command sha256sum; then
  die "shasum or sha256sum is required to verify the download"
fi

# HTTPS only (NET-4): the manifest, the .sha256 digest and the binary all come
# from this origin, and the persisted value later carries the API key on every
# call — a plain-http origin hands both to a network MITM. A loopback http
# origin is tolerated ONLY with the explicit dev opt-in.
INSECURE_DEV_ORIGIN=0
case "$ORIGIN" in
  https://*) ;;
  http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*|\
http://localhost|http://localhost:*|http://localhost/*|\
http://\[::1\]|http://\[::1\]:*|http://\[::1\]/*)
    if [ "${OPENLLM_ALLOW_INSECURE_ORIGIN:-}" = "1" ]; then
      INSECURE_DEV_ORIGIN=1
    else
      die "insecure origin $ORIGIN — http is refused except for loopback development; set OPENLLM_ALLOW_INSECURE_ORIGIN=1 to override"
    fi
    ;;
  *) die "insecure origin $ORIGIN — OPENLLM_CLOUD_ORIGIN must be an https:// origin" ;;
esac
# Belt-and-suspenders at the transport layer: every fetch is restricted to the
# allowed schemes so an https→http redirect can never be followed.
if [ "$INSECURE_DEV_ORIGIN" = 1 ]; then
  CURL_SCHEME=(--proto "=http,https" --proto-redir "=http,https")
else
  CURL_SCHEME=(--proto "=https" --proto-redir "=https")
fi
# And bound every call (NET-7): a stalled TCP connection must never hang the
# installer. The manifest, the digest fetch and the capability probe are tiny,
# so they get the short bound; the binary download gets the long one.
CURL_META=(--connect-timeout 10 --max-time 60)
CURL_GET=(--connect-timeout 10 --max-time 300)

CLI_VERSION=""
if [ -z "$FROM_FILE" ]; then
  # --proto/--proto-redir need a curl new enough to know the options (≈7.21):
  # an older system curl fails the FIRST fetch with an opaque option error, so
  # detect support once and fail with the upgrade remedy up front.
  curl "${CURL_SCHEME[@]}" "${CURL_META[@]}" -V >/dev/null 2>&1 \
    || die "this curl does not support --proto/--proto-redir — upgrade to curl 7.21.0 or newer and re-run"

  # /api/install validates the committed release pins server-side and fails
  # closed, so a mis-pinned or half-published release is refused before any
  # download. No query parameters.
  echo "Resolving the current OpenLLM CLI release..."
  MANIFEST="$(curl "${CURL_SCHEME[@]}" "${CURL_META[@]}" -fsSL "$ORIGIN/api/install" 2>/dev/null)" \
    || die "could not reach $ORIGIN/api/install — check OPENLLM_CLOUD_ORIGIN and your network"

  json_field() {
    printf '%s' "$MANIFEST" \
      | tr -d '\n' \
      | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
  }
  CLI_VERSION="$(json_field cli_version)"
  [ -n "$CLI_VERSION" ] || die "no CLI release is published yet"
  # Whatever /api/install advertises is the release of record — a PRERELEASE is
  # installable too (TCB-1/DR-1), and a prerelease install may move to a newer
  # stable. The only refusal is an actual DOWNGRADE of a managed binary — check
  # both the current and legacy CLI names.
  assert_no_downgrade "$DEST" "$CLI_VERSION"
  assert_no_downgrade "$BIN_DIR/openllmc" "$CLI_VERSION"
fi

mkdir -p "$BIN_DIR"

URL="$ORIGIN/api/cli/binary/$TARGET"
STAMP="$BIN_DIR/.openllm.sha256.stamp"

if [ -n "$FROM_FILE" ]; then
  # Private-prerelease path: the OPERATOR supplies both the bytes and the
  # digest — no network fetch of either. The checksum covers the file as
  # handed to us (a gzipped asset is decompressed after verification,
  # exactly like the download path).
  PUBLISHED="$(printf '%s' "$FROM_SHA" | tr '[:upper:]' '[:lower:]')"
  [[ "$PUBLISHED" =~ ^[0-9a-f]{64}$ ]] \
    || die "malformed --sha256 digest (expected 64 hex chars)"
  [ -f "$FROM_FILE" ] && [ -r "$FROM_FILE" ] \
    || die "--from-file path is not a readable regular file: $FROM_FILE"
else
  PUBLISHED="$(curl "${CURL_SCHEME[@]}" "${CURL_META[@]}" -fsSL "$URL.sha256" 2>/dev/null | cut -d' ' -f1 || true)"
  case "$PUBLISHED" in
    [0-9a-f]*) [ ${#PUBLISHED} -eq 64 ] || die "malformed published checksum" ;;
    *) die "no published binary for $TARGET yet" ;;
  esac
fi

# Skip the download when what's installed already matches (see the daemon
# installer for the macOS codesign/stamp rationale). NEVER in --from-file
# mode: the supplied file must always be hashed and verified — a shortcut
# here would accept a wrong local file whenever the installed binary
# already carries the expected digest.
SKIP=0
if [ -x "$DEST" ] && [ -z "$FROM_FILE" ]; then
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
  if [ -n "$FROM_FILE" ]; then
    echo "Installing openllm from $FROM_FILE..."
  else
    echo "Downloading openllm $CLI_VERSION ($TARGET)..."
  fi
  DL="$BIN_DIR/.openllm.download.$$"
  BIN="$BIN_DIR/.openllm.bin.$$"
  # Download+verify+swap in a SUBSHELL: its EXIT trap (temp-file cleanup) stays
  # scoped and can never replace — or erase with `trap - EXIT` — an outer EXIT
  # trap if this script is ever embedded in a wrapper.
  (
    trap 'rm -f "$DL" "$BIN"' EXIT
    if [ -n "$FROM_FILE" ]; then
      cp "$FROM_FILE" "$DL" || die "could not stage local binary: $FROM_FILE"
      # The operator's digest covers the FILE as supplied — verify BEFORE any
      # decompression so the gate is on exactly the bytes they checksummed.
      ACTUAL="$(sha256_of "$DL")"
      [ -n "$ACTUAL" ] || die "could not hash $FROM_FILE"
      [ "$ACTUAL" = "$PUBLISHED" ] \
        || die "checksum mismatch (expected $PUBLISHED, got $ACTUAL) — refusing to install"
    elif [ -t 2 ]; then
      curl "${CURL_SCHEME[@]}" "${CURL_GET[@]}" -fL --progress-bar "$URL" -o "$DL" || die "download failed: $URL"
    else
      curl "${CURL_SCHEME[@]}" "${CURL_GET[@]}" -fsSL "$URL" -o "$DL" || die "download failed: $URL"
    fi
    # The pinned digest is over the DECOMPRESSED binary.
    if gzip -t "$DL" >/dev/null 2>&1; then
      gzip -dc "$DL" > "$BIN" || die "could not decompress openllm"
    else
      mv "$DL" "$BIN"
    fi
    if [ -z "$FROM_FILE" ]; then
      ACTUAL="$(sha256_of "$BIN")"
      [ -n "$ACTUAL" ] || die "could not hash the download"
      [ "$ACTUAL" = "$PUBLISHED" ] \
        || die "checksum mismatch (expected $PUBLISHED, got $ACTUAL) — refusing to install"
    fi
    chmod 0755 "$BIN"
    # Preserve a valid Developer ID / notarized signature; only ad-hoc when invalid.
    if [ "$OS" = "darwin" ]; then
      xattr -d com.apple.quarantine "$BIN" >/dev/null 2>&1 || true
      if ! codesign --verify --strict "$BIN" >/dev/null 2>&1; then
        codesign --force --sign - "$BIN" >/dev/null 2>&1 \
          || die "could not sign openllm — refusing to install"
        codesign --verify --strict "$BIN" >/dev/null 2>&1 \
          || die "signature verification failed for openllm — refusing to install"
        printf '%s %s\n' "$PUBLISHED" "$(sha256_of "$BIN")" > "$STAMP" 2>/dev/null || true
      fi
    fi
    # The installed executable may have changed while the download was in
    # flight. For a local file there is no advertised release: the staged
    # binary's own reported version is the reference (the probe doubles as a
    # sanity check that the supplied file is really an openllm binary).
    CHECK_VERSION="$CLI_VERSION"
    if [ -n "$FROM_FILE" ]; then
      probe_version "$BIN"
      CHECK_VERSION="$(version_of_output "$PROBE_OUTPUT")" \
        || die "could not parse a version from $FROM_FILE — refusing to install"
    fi
    assert_no_downgrade "$DEST" "$CHECK_VERSION"
    mv -f "$BIN" "$DEST"
  ) || exit 1
  echo "  openllm installed → $DEST"
fi

# Record the gateway origin (and a key, when supplied) in the SHARED config file
# the daemon also boots from. Match its exclusive .lock + atomic rename protocol,
# and read only AFTER acquiring the lock. Preserve every unrelated setting and
# the latest device/key a concurrent daemon may have persisted during download.
# This installer owns the origin, and the key only when explicitly supplied.
ENV_LOCK_BINARY="${DEST:-}"
# >>> openllm-env-lock/v3 >>>
# The installed helper owns all lock metadata operations.
env_lock_acquire() {
  local target="$1" helper begin previous attempt code worker_pid
  ENV_LOCK_DIR=""
  helper="${LOCKLAB_HELPER_BIN:-${OPENLLM_LOCK_HELPER:-}}"
  if [ -z "$helper" ]; then
    helper="${ENV_LOCK_BINARY:-}"
  fi
  [ -n "$helper" ] && [ -x "$helper" ] || { echo 'lock helper is missing or incompatible' >&2; return 74; }
  worker_pid="${BASHPID:-$$}"
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
      worker_pid="$(ps -l -p "$worker_pid" 2>/dev/null | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "WINPID") column = i; next } column > 0 { print $column; exit }')" || return 74
      case "$worker_pid" in ''|0|*[!0-9]*) return 74 ;; esac
      ;;
  esac
  ENV_LOCK_CHANNEL="$(mktemp -d "${TMPDIR:-/tmp}/openllm-lock.XXXXXXXX")" || return 74
  chmod 700 "$ENV_LOCK_CHANNEL" || { rmdir "$ENV_LOCK_CHANNEL" 2>/dev/null || true; return 74; }
  "$helper" --internal-lock-control e "$target.lock.d" "$worker_pid" \
    "$ENV_LOCK_CHANNEL/request" "$ENV_LOCK_CHANNEL/response" </dev/null >/dev/null &
  ENV_LOCK_HELPER_PID=$!
  begin=$SECONDS
  previous=$SECONDS
  code=74
  for ((attempt=0; attempt<120; attempt++)); do
    if [ "$SECONDS" -lt "$previous" ] || [ "$((SECONDS - begin))" -ge 12 ]; then break; fi
    previous=$SECONDS
    if [ -f "$ENV_LOCK_CHANNEL/response" ]; then
      case "$(cat "$ENV_LOCK_CHANNEL/response")" in
        '{"version":3,"code":0}') ENV_LOCK_DIR="$target.lock.d"; return 0 ;;
        '{"version":3,"code":73}') code=73; break ;;
        *) break ;;
      esac
    fi
    kill -0 "$ENV_LOCK_HELPER_PID" 2>/dev/null || break
    sleep 0.1 || break
  done
  printf 'release\n' > "$ENV_LOCK_CHANNEL/request"
  wait "$ENV_LOCK_HELPER_PID" 2>/dev/null || true
  rm -f "$ENV_LOCK_CHANNEL/request" "$ENV_LOCK_CHANNEL/response"
  rmdir "$ENV_LOCK_CHANNEL" 2>/dev/null || true
  ENV_LOCK_HELPER_PID=""
  return "$code"
}
env_lock_release() {
  local result=0
  [ -n "${ENV_LOCK_HELPER_PID:-}" ] || return 0
  ENV_LOCK_DIR=""
  printf 'release\n' > "$ENV_LOCK_CHANNEL/request" || result=74
  wait "$ENV_LOCK_HELPER_PID" || result=$?
  ENV_LOCK_HELPER_PID=""
  rm -f "$ENV_LOCK_CHANNEL/request" "$ENV_LOCK_CHANNEL/response"
  rmdir "$ENV_LOCK_CHANNEL" 2>/dev/null || true
  return "$result"
}
# <<< openllm-env-lock/v3 <<<
# The env write runs in a subshell so the lock traps and private umask stay
# scoped — and every fallible step is guarded explicitly (`|| die`): a
# half-written tmp must never reach the rename, and a write failure must
# never let the installer announce success on a config it did not write.
(
  tmp="$ENV_FILE.tmp.$$"
  # An existing-but-unreadable env file would silently drop every preserved
  # key — fail loudly instead of merging against an empty read. Checked BEFORE
  # the lock: a die here must not strand a lock dir the EXIT trap isn't
  # installed yet to release.
  [ ! -f "$ENV_FILE" ] || [ -r "$ENV_FILE" ] \
    || die "cannot read existing config file: $ENV_FILE"
  env_lock_acquire "$ENV_FILE" || { lock_status=$?; exit "$lock_status"; }
  # Any exit while the lock is held — die, a set -e failure, Ctrl-C, SIGTERM —
  # must release the lock AND remove the temp file (it may carry the API key).
  # env_lock_release deletes only a dir that still holds OUR owner record.
  trap 'rm -f "${tmp:-}"; env_lock_release' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The subshell keeps the private creation mode out of later shell setup.
  umask 077 || die "could not tighten the umask"
  : > "$tmp" || die "could not create temp config file: $tmp"
  wrote_origin=0
  wrote_key=0
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "${line%%=*}" in
        OPENLLM_CLOUD_ORIGIN)
          if [ "$wrote_origin" = 0 ]; then
            printf 'OPENLLM_CLOUD_ORIGIN=%s\n' "$ORIGIN" >> "$tmp" || die "write failed: $tmp"
            wrote_origin=1
          fi
          ;;
        OPENLLM_API_KEY)
          if [ -n "${OPENLLM_API_KEY:-}" ]; then
            if [ "$wrote_key" = 0 ]; then
              printf 'OPENLLM_API_KEY=%s\n' "$OPENLLM_API_KEY" >> "$tmp" || die "write failed: $tmp"
              wrote_key=1
            fi
          else
            printf '%s\n' "$line" >> "$tmp" || die "write failed: $tmp"
          fi
          ;;
        *) printf '%s\n' "$line" >> "$tmp" || die "write failed: $tmp" ;;
      esac
    done < "$ENV_FILE" || die "could not read config file: $ENV_FILE"
  fi
  if [ "$wrote_origin" = 0 ]; then
    printf 'OPENLLM_CLOUD_ORIGIN=%s\n' "$ORIGIN" >> "$tmp" || die "write failed: $tmp"
  fi
  if [ -n "${OPENLLM_API_KEY:-}" ] && [ "$wrote_key" = 0 ]; then
    printf 'OPENLLM_API_KEY=%s\n' "$OPENLLM_API_KEY" >> "$tmp" || die "write failed: $tmp"
  fi
  chmod 0600 "$tmp" || die "could not chmod temp config file: $tmp"
  mv -f "$tmp" "$ENV_FILE" || die "could not write config file: $ENV_FILE"
)
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
