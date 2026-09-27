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
VERSION_PROBE_TIMEOUT=3
probe_version() {
  local binary="$1" probe_file="${TMPDIR:-/tmp}/openllm-version-probe.$$" pid watchdog status
  "$binary" --version >"$probe_file" 2>/dev/null &
  pid=$!
  (
    sleep "$VERSION_PROBE_TIMEOUT" &
    local timer=$!
    trap 'kill "$timer" 2>/dev/null || true; exit 0' TERM INT
    wait "$timer"
    kill "$pid" 2>/dev/null || true
  ) &
  watchdog=$!
  if wait "$pid"; then status=0; else status=$?; fi
  kill -TERM "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  PROBE_OUTPUT="$(cat "$probe_file" 2>/dev/null || true)"
  rm -f "$probe_file"
  [ "$status" -eq 0 ] \
    || die "version probe timed out or failed at $binary; refusing to overwrite it"
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

CLI_VERSION=""
if [ -z "$FROM_FILE" ]; then
  # --proto/--proto-redir need a curl new enough to know the options (≈7.21):
  # an older system curl fails the FIRST fetch with an opaque option error, so
  # detect support once and fail with the upgrade remedy up front.
  curl "${CURL_SCHEME[@]}" -V >/dev/null 2>&1 \
    || die "this curl does not support --proto/--proto-redir — upgrade to curl 7.21.0 or newer and re-run"

  # /api/install validates the committed release pins server-side and fails
  # closed, so a mis-pinned or half-published release is refused before any
  # download. No query parameters.
  echo "Resolving the current OpenLLM CLI release..."
  MANIFEST="$(curl "${CURL_SCHEME[@]}" -fsSL "$ORIGIN/api/install" 2>/dev/null)" \
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
  PUBLISHED="$(curl "${CURL_SCHEME[@]}" -fsSL "$URL.sha256" 2>/dev/null | cut -d' ' -f1 || true)"
  case "$PUBLISHED" in
    [0-9a-f]*) [ ${#PUBLISHED} -eq 64 ] || die "malformed published checksum" ;;
    *) die "no published binary for $TARGET yet" ;;
  esac
fi

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
      curl "${CURL_SCHEME[@]}" -fL --progress-bar "$URL" -o "$DL" || die "download failed: $URL"
    else
      curl "${CURL_SCHEME[@]}" -fsSL "$URL" -o "$DL" || die "download failed: $URL"
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
# >>> openllm-env-lock/v1 (shared protocol — identical block in both >>>
# >>> installers; the SAME rules as packages/daemon/src/env.ts)        >>>
#
# The lock is the DIRECTORY "<envfile>.lock.d": `mkdir` is atomic on every
# POSIX filesystem (flock does not exist on macOS). Ownership is a record
# published atomically INSIDE the directory — written to `owner.tmp.$$`
# then renamed to `owner`:
#
#   kind=openllm-env-lock/v1 pid=<pid> start=<start identity> nonce=<hex>
#
# `start` is the owner's canonical start identity, the same value the
# daemon's `processStartIdentity` reads: on Linux the boot-scoped
# `boot:<boot_id>:<starttime ticks>` pair (built from
# /proc/sys/kernel/random/boot_id and field 22 of /proc/<pid>/stat, parsed
# after the last ') ' of the comm field); on macOS the `ps -o lstart=` text
# under LC_ALL=C TZ=UTC, whitespace collapsed to single spaces. It
# distinguishes a LIVE-but-reused pid from the real owner (PID reuse).
# Records written by older builds can carry the `ps lstart` text — a
# live-pid record in the other format is re-probed in the record's own
# format before it can convict — or `-` (an owner that could not read its
# own identity). `-` is never written by this build.
#
# A held lock is STALE only when its marked owner names a dead pid, or a
# live pid whose current start identity differs. A dir with no, unreadable
# or unmarked owner is HELD — but only inside a short "unproven" bound
# (OPENLLM_ENV_LOCK_ORPHAN_SECS, default 30 s): past it an ownerless dir
# (a holder killed between `mkdir` and publish) is reclaimed. A marked
# owner whose start is `-` can never be proven, so a live pid still holds
# it for the full stale window — a transient probe failure on the owner's
# side must never make a live lock reclaimable in seconds. The orphan bound
# still caps the legacy `.env.lock` FILE — an unprovable identity must not
# wedge the lock for the full stale window.
#
# Reclaim is MARK-FIRST. A contender that judges the dir stale drops a
# `steal.<pid>.<nonce>` marker INSIDE it (noclobber create), re-judges the
# SAME generation (inode match + the pre-mark mtime for the age term,
# since the marker create already bumped it), and only then `mv`s it to
# `.lock.stale.<pid>.<nonce>.<seq>`. The marker bridges the gap between the
# re-check and the move: a paused publisher that commits its owner record
# while a steal is in flight sees the marker (or the dir gone) and fails
# its own publish rather than holding a quarantined dir — two holders can
# never result. A steal that loses the rename (another contender moved
# first) or fails its re-check just drops its marker. Quarantine dirs are
# never moved back; a committed steal is final because publishers
# self-detect it. Old quarantine dirs are swept when their contents are
# only `owner.tmp.*`/`steal.*` residue (or empty) or a complete marked
# owner record.
#
# The publisher's veto is bound to the dir GENERATION, not the path: the
# inode of the just-`mkdir`'d dir is captured at acquire and re-stat'd
# after the record lands. A different inode — or a vanished dir — means
# this generation was quarantined and the path re-taken by a successor, so
# the publish drops its own record instead of writing into the
# successor's dir. A fresh unmarked dir is immovable (never stale, and a
# release only moves a dir that reads as its own), so the inode captured
# right after `mkdir` can only be ours.
#
# Release first reads the owner AT the live path and moves `.lock.d` to
# `.lock.rel.<pid>.<nonce>` ONLY when that record is marked with our nonce
# — a foreign marked owner (a successor that re-took the path after our
# dir was stolen) is never touched. The captured dir is then verified
# inside the quarantine: our nonce means delete; a foreign record means
# the path was swapped mid-move and the dir is put back NO-REPLACE — a
# fresh `mkdir` plus a verbatim copy of its flat files. `mv` could
# silently replace a successor's just-`mkdir`'d (still empty) dir that
# landed in the check->move gap; `mkdir` fails outright and the captured
# dir stays parked for the sweep instead.
#
# The pre-dir `.env.lock` FILE is still honoured for one release: HELD
# only inside the bounded orphan window — while a recorded pid is alive or
# its content is unparseable — and reclaimed past it even on a live pid.
# A dead-pid record is reclaimed ONLY by atomic rename to a unique
# quarantine name — the live path is never unlinked directly — then
# re-read there: a record that turns out to be live AND young is put back
# with a no-replace link, never over a successor lock file.
ENV_LOCK_STALE_SECS="${OPENLLM_ENV_LOCK_STALE_SECS:-600}"
ENV_LOCK_WAIT_SECS="${OPENLLM_ENV_LOCK_WAIT_SECS:-10}"
ENV_LOCK_ORPHAN_SECS="${OPENLLM_ENV_LOCK_ORPHAN_SECS:-30}"
# Same knob rule as the daemon: decimal digits AND > 0 — "0" or junk falls
# back to the defaults, never a zero-length window. Leading zeros are
# DECIMAL on the daemon side (Number("08") is 8) but invalid octal to
# [[ -gt ]]/$(( )) — canonicalise through 10# before the value is ever
# compared or added.
[[ "$ENV_LOCK_STALE_SECS" =~ ^[0-9]+$ ]] || ENV_LOCK_STALE_SECS=0
ENV_LOCK_STALE_SECS=$((10#$ENV_LOCK_STALE_SECS))
[ "$ENV_LOCK_STALE_SECS" -gt 0 ] || ENV_LOCK_STALE_SECS=600
[[ "$ENV_LOCK_WAIT_SECS" =~ ^[0-9]+$ ]] || ENV_LOCK_WAIT_SECS=0
ENV_LOCK_WAIT_SECS=$((10#$ENV_LOCK_WAIT_SECS))
[ "$ENV_LOCK_WAIT_SECS" -gt 0 ] || ENV_LOCK_WAIT_SECS=10
[[ "$ENV_LOCK_ORPHAN_SECS" =~ ^[0-9]+$ ]] || ENV_LOCK_ORPHAN_SECS=0
ENV_LOCK_ORPHAN_SECS=$((10#$ENV_LOCK_ORPHAN_SECS))
[ "$ENV_LOCK_ORPHAN_SECS" -gt 0 ] || ENV_LOCK_ORPHAN_SECS=30
ENV_LOCK_DIR=""
ENV_LOCK_NONCE=""
ENV_LOCK_QSEQ=0
ENV_LOCK_OWNER_STATE="" ENV_LOCK_OWNER_PID=""
ENV_LOCK_OWNER_START="" ENV_LOCK_OWNER_NONCE=""

# Liveness check — `kill -0 0` would probe the CALLER'S own process group
# (and report it alive), so a non-positive or non-decimal pid is never
# probed. Same rule as the daemon: pids must be positive integers.
env_lock_pid_alive() {
  # "08" is invalid octal to [[ -gt ]] but decimal pid 8 to the daemon's
  # Number() — validate digits, convert through 10#, compare in decimal [ ].
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  local pid=$((10#$1))
  [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null
}

# `ps -o lstart=` under the fixed locale/timezone the daemon's
# legacyProcessStartIdentity uses, whitespace collapsed to single spaces.
# This is the identity format records written by OLDER builds carry — used
# to re-probe a live pid in a record's own format before it can convict.
env_lock_legacy_start_identity() {
  local out
  out="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null)" || out=""
  out="$(printf '%s' "$out" | tr -s '[:space:]' ' ')"
  out="${out# }"
  out="${out% }"
  printf '%s' "$out"
}

# True when $1 is a post-RT-1 `boot:<boot_id>:<ticks>` start identity —
# the same shape the daemon's BOOT_IDENTITY_RE accepts.
env_lock_is_boot_identity() {
  local re='^boot:[0-9a-f-]{36}:[0-9]+$'
  [[ "$1" =~ $re ]]
}

# Collapse whitespace exactly like the daemon's normalizeProcessStartIdentity
# (`value.trim().split(/\s+/).join(" ")`) so a padded legacy record still
# compares equal.
env_lock_normalize_identity() {
  local out
  out="$(printf '%s' "$1" | tr -s '[:space:]' ' ')"
  out="${out# }"
  out="${out% }"
  printf '%s' "$out"
}

# The canonical start identity — the value the daemon's processStartIdentity
# reads for the same pid. On Linux that is `boot:<boot_id>:<ticks>`: the
# kernel boot id (both sides lowercased) plus /proc/<pid>/stat field 22 in
# USER_HZ ticks — parsed AFTER the last ") " because comm can hold spaces or
# a ')'. On macOS and other POSIX the `ps lstart` text above. Empty means
# unknown or dead — never a guess.
env_lock_start_identity() {
  local pid="$1" boot stat rest ticks
  if [ "$(uname -s 2>/dev/null)" = "Linux" ]; then
    boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)"
    boot="$(printf '%s' "$boot" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    local re='^[0-9a-f-]{36}$'
    [[ "$boot" =~ $re ]] || return 0
    stat="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
    [ -n "$stat" ] || return 0
    # Fields are numbered from the pid: dropping "<pid> (<comm>) " leaves
    # field 3 as index 0 — the daemon reads starttime (field 22) as index
    # 19. `${stat##*) }` cuts through the LAST ") " (comm can hold a ')');
    # a stat with no ") " at all degrades to `slice(1)` exactly like the
    # daemon's `lastIndexOf(") ")` fallback.
    rest="${stat##*) }"
    [ "$rest" = "$stat" ] && rest="${stat:1}"
    local -a f
    read -r -a f <<< "$rest"
    ticks="${f[19]:-}"
    [[ "$ticks" =~ ^[0-9]+$ && "$ticks" =~ [1-9] ]] || return 0
    printf 'boot:%s:%s' "$boot" "$((10#$ticks))"
    return 0
  fi
  env_lock_legacy_start_identity "$pid"
}

# Read <dir>/owner into ENV_LOCK_OWNER_{STATE,PID,START,NONCE}. STATE is
# "marked" (a complete v1 record) or "unmarked" (missing, unreadable or
# foreign — including the crash-between-mkdir-and-publish shape). The field
# rules are IDENTICAL to the daemon's parser: digit pid, NON-EMPTY start,
# hex-only nonce; an unmarked record surfaces a pid only as a
# whitespace-bounded `pid=<digits>` token or a leading bare pid.
env_lock_read_owner() {
  local dir="$1" line rest
  ENV_LOCK_OWNER_STATE="unmarked"
  ENV_LOCK_OWNER_PID="" ENV_LOCK_OWNER_START="" ENV_LOCK_OWNER_NONCE=""
  line="$(cat "$dir/owner" 2>/dev/null || true)"
  # The daemon trims the record before parsing — same here, so
  # leading/trailing whitespace cannot split the verdicts.
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  case "$line" in
    kind=openllm-env-lock/v1\ pid=*\ start=*\ nonce=*)
      rest="${line#kind=openllm-env-lock/v1 pid=}"
      ENV_LOCK_OWNER_PID="${rest%% *}"
      ENV_LOCK_OWNER_START="${rest#* start=}"
      ENV_LOCK_OWNER_START="${ENV_LOCK_OWNER_START% nonce=*}"
      ENV_LOCK_OWNER_NONCE="${rest##* nonce=}"
      if [[ "$ENV_LOCK_OWNER_PID" =~ ^[0-9]+$ ]] \
        && [ -n "$ENV_LOCK_OWNER_START" ] \
        && [[ "$ENV_LOCK_OWNER_START" != *$'\n'* \
          && "$ENV_LOCK_OWNER_START" != *$'\r'* ]] \
        && [[ "$ENV_LOCK_OWNER_NONCE" =~ ^[0-9a-fA-F]+$ ]]; then
        # Canonicalise to base-10 ("08" is pid 8 — the daemon's Number()).
        ENV_LOCK_OWNER_PID=$((10#$ENV_LOCK_OWNER_PID))
        ENV_LOCK_OWNER_STATE="marked"
      fi
      ;;
  esac
  if [ "$ENV_LOCK_OWNER_STATE" != "marked" ]; then
    ENV_LOCK_OWNER_PID="" ENV_LOCK_OWNER_START="" ENV_LOCK_OWNER_NONCE=""
    if [[ "$line" =~ (^|[[:space:]])pid=([0-9]+)([[:space:]]|$) ]]; then
      ENV_LOCK_OWNER_PID="${BASH_REMATCH[2]}"
    elif [[ "$line" =~ ^([0-9]+)([[:space:]]|$) ]]; then
      ENV_LOCK_OWNER_PID="${BASH_REMATCH[1]}"
    fi
    # A non-positive pid is no pid (the daemon returns null for it, and
    # `kill -0 0` would probe the wrong target anyway). Canonicalise to
    # base-10 first so "08" is pid 8 exactly like the daemon's Number().
    if [ -n "$ENV_LOCK_OWNER_PID" ]; then
      ENV_LOCK_OWNER_PID=$((10#$ENV_LOCK_OWNER_PID))
      [ "$ENV_LOCK_OWNER_PID" -gt 0 ] || ENV_LOCK_OWNER_PID=""
    fi
  fi
}

env_lock_dir_age_secs() {
  local mtime="${2:-}" now
  [[ "$mtime" =~ ^[0-9]+$ ]] || \
    mtime="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || true)"
  now="$(date +%s 2>/dev/null || true)"
  if [[ "$mtime" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]]; then
    printf '%s\n' $((10#$now - 10#$mtime))
  else
    printf '%s\n' -1
  fi
}

# Inode of a path (no deref — `stat` only dereferences under -L on both
# GNU and BSD, matching the daemon's lstatSync). The steal re-check uses
# it to prove the dir it marked is the SAME generation the staleness
# verdict was computed against.
env_lock_path_ino() {
  stat -c %i "$1" 2>/dev/null || stat -f %i "$1" 2>/dev/null || true
}

# The ONE staleness predicate — identical rules on the daemon side.
# $1 = the lock dir (or a quarantined dir); $2 = optional PRE-CAPTURED dir
# mtime used for the age terms (the steal re-check — our own `steal.*`
# marker create already bumped the dir's mtime).
env_lock_is_stale_dir() {
  local dir="$1" as_of="${2:-}" current bridged recorded age
  env_lock_read_owner "$dir"
  age="$(env_lock_dir_age_secs "$dir" "$as_of")"
  if [ "$ENV_LOCK_OWNER_STATE" = "marked" ]; then
    env_lock_pid_alive "$ENV_LOCK_OWNER_PID" || return 0
    # The daemon normalizes the recorded identity before comparing —
    # same collapse here so a padded legacy record still matches.
    recorded="$(env_lock_normalize_identity "$ENV_LOCK_OWNER_START")"
    if [ "$recorded" = "-" ]; then
      # The start identity can never be proven ("-": written only by
      # builds that latched a failed probe — this build never writes it):
      # the live pid holds for the full CONSERVATIVE stale window, never
      # the orphan bound — a transient probe failure on the owner's side
      # must not make a live lock reclaimable in seconds.
      { [ "$age" -ge 0 ] && [ "$age" -ge "$ENV_LOCK_STALE_SECS" ]; }
      return
    fi
    current="$(env_lock_start_identity "$ENV_LOCK_OWNER_PID")"
    if [ -z "$current" ]; then
      # The probe could not answer: re-check liveness — a dead pid is
      # stale, a live-but-unreadable identity stays held.
      if env_lock_pid_alive "$ENV_LOCK_OWNER_PID"; then return 1; else return 0; fi
    fi
    [ "$current" = "$recorded" ] && return 1
    # Same-format mismatch is proven PID reuse. A MIXED format pair is the
    # boundary case (XS-1): a record written in the legacy `ps lstart`
    # format by an older installer or daemon must be re-probed in its own
    # format before a live pid can convict it.
    env_lock_is_boot_identity "$current" || return 0
    env_lock_is_boot_identity "$recorded" && return 0
    bridged="$(env_lock_legacy_start_identity "$ENV_LOCK_OWNER_PID")"
    if [ -z "$bridged" ]; then
      if env_lock_pid_alive "$ENV_LOCK_OWNER_PID"; then return 1; else return 0; fi
    fi
    if [ "$bridged" = "$recorded" ]; then return 1; else return 0; fi
  fi
  # Unmarked: HELD unless past the short unproven bound AND still without
  # a complete owner — and never while a parseable pid in it is still
  # alive.
  { [ "$age" -ge 0 ] && [ "$age" -ge "$ENV_LOCK_ORPHAN_SECS" ]; } || return 1
  if [[ "$ENV_LOCK_OWNER_PID" =~ ^[0-9]+$ ]] && env_lock_pid_alive "$ENV_LOCK_OWNER_PID"; then
    return 1
  fi
  return 0
}

# Reclaim an apparently-stale lock dir — MARK-FIRST. Drop a
# `steal.<pid>.<nonce>` marker INSIDE the dir (noclobber create), re-judge
# the SAME generation (inode match + the pre-mark mtime for the age term),
# then `mv` it aside atomically — exactly one contender wins the rename.
# The marker bridges check->move: a publisher that commits its owner record
# while the steal is in flight sees the marker and fails its own publish,
# so a committed steal can never leave two holders. A committed quarantine
# is never moved back; the sweep removes it once it ages out.
env_lock_steal() {
  local lockdir="$1" stem="$2" marker q ino_before ino_after mtime
  ino_before="$(env_lock_path_ino "$lockdir")"
  mtime="$(stat -c %Y "$lockdir" 2>/dev/null || stat -f %m "$lockdir" 2>/dev/null || true)"
  [ -n "$ino_before" ] || return 0  # vanished — the outer acquire retries
  marker="$lockdir/steal.$$.$ENV_LOCK_NONCE"
  if ! (set -C; : > "$marker") 2>/dev/null; then
    # A plain FILE at the lock path can never gain an owner record — park
    # it like a stale dir. Anything else (dir vanished) retries at the top.
    if [ -f "$lockdir" ]; then
      ENV_LOCK_QSEQ=$((ENV_LOCK_QSEQ + 1))
      mv "$lockdir" "$stem.stale.$$.$ENV_LOCK_NONCE.$ENV_LOCK_QSEQ" \
        2>/dev/null || true
    fi
    return 0
  fi
  ino_after="$(env_lock_path_ino "$lockdir")"
  if [ -n "$ino_after" ] && [ "$ino_after" = "$ino_before" ] \
    && env_lock_is_stale_dir "$lockdir" "$mtime"; then
    ENV_LOCK_QSEQ=$((ENV_LOCK_QSEQ + 1))
    q="$stem.stale.$$.$ENV_LOCK_NONCE.$ENV_LOCK_QSEQ"
    if mv "$lockdir" "$q" 2>/dev/null; then
      return 0  # committed — the marker (and dir) are parked with it
    fi
  fi
  rm -f "$marker" 2>/dev/null || true
  return 0
}

# Delete old quarantine/release dirs whose contents are only `owner.tmp.*`
# publish residue or `steal.*` markers left by a steal committed
# mid-publish (or EMPTY — a holder killed between mkdir and publish, then
# quarantined) or a complete marked owner record. Anything foreign is kept.
env_lock_sweep() {
  local stem="$1" entry child age ok has_owner
  for entry in "$stem".stale.* "$stem".rel.*; do
    [ -d "$entry" ] || continue
    age="$(env_lock_dir_age_secs "$entry")"
    { [ "$age" -ge 0 ] && [ "$age" -ge "$ENV_LOCK_STALE_SECS" ]; } || continue
    ok=1
    has_owner=0
    for child in "$entry"/*; do
      [ -e "$child" ] || continue
      case "${child##*/}" in
        owner) has_owner=1 ;;
        owner.tmp.*|steal.*) ;;
        *) ok=0 ;;
      esac
    done
    [ "$ok" = 1 ] || continue
    if [ "$has_owner" = 1 ]; then
      env_lock_read_owner "$entry"
      [ "$ENV_LOCK_OWNER_STATE" = "marked" ] || continue
    fi
    for child in "$entry"/*; do rm -f "$child" 2>/dev/null || true; done
    rmdir "$entry" 2>/dev/null || true
  done
  return 0
}

# Adjudicate a legacy lock file ALREADY moved into quarantine: re-read the
# CAPTURED record (it may have been swapped between the caller's read and
# the rename). A live pid is restored NO-REPLACE — `ln` fails outright on an
# existing successor, and on filesystems without hardlinks a noclobber
# create (O_EXCL) carries the same guarantee where `mv`/rename would
# silently overwrite — but ONLY inside the bounded window: the record
# carries no provable start identity, so a live pid PAST the window is
# dropped like a dead one. A dead/unparseable record is deleted inside the
# quarantine, never on the live path. Returns 0 while the legacy path still
# blocks acquisition (a live record was found), 1 once clear.
env_lock_legacy_resolve() {
  local q="$1" legacy="$2" moved rest age
  moved=""
  read -r moved rest < "$q" 2>/dev/null || moved=""
  if [[ "$moved" =~ ^[0-9]+$ ]] && env_lock_pid_alive "$moved"; then
    age="$(env_lock_dir_age_secs "$q")"
    if [ "$age" -lt 0 ] || [ "$age" -lt "$ENV_LOCK_ORPHAN_SECS" ]; then
      if ln "$q" "$legacy" 2>/dev/null; then
        rm -f "$q" 2>/dev/null || true
      elif (set -C; : > "$legacy") 2>/dev/null; then
        # We claimed the name (noclobber create) — fill it and verify
        # before consuming the captured record: a short write must not
        # delete it. A mismatched file can only be OUR partial write —
        # drop it and keep the quarantine for a later pass.
        local l_sz q_sz
        cat "$q" >> "$legacy" 2>/dev/null || true
        l_sz="$(stat -c %s "$legacy" 2>/dev/null || stat -f %z "$legacy" 2>/dev/null || true)"
        q_sz="$(stat -c %s "$q" 2>/dev/null || stat -f %z "$q" 2>/dev/null || true)"
        if [ -n "$q_sz" ] && [ "$q_sz" = "$l_sz" ] \
          && [ "$(cat "$legacy" 2>/dev/null)" = "$(cat "$q" 2>/dev/null)" ]; then
          rm -f "$q" 2>/dev/null || true
        else
          rm -f "$legacy" 2>/dev/null || true
        fi
      elif [ -e "$legacy" ] || [ -L "$legacy" ]; then
        # A successor holds the path — the captured copy is obsolete.
        rm -f "$q" 2>/dev/null || true
      fi
      return 0
    fi
  fi
  rm -f "$q" 2>/dev/null || true
  return 1
}

# The legacy pre-dir `.env.lock` FILE: the record can never prove its
# owner's start identity, so it is HELD only inside the bounded reclaim
# window — while a recorded pid is alive or its content is unparseable —
# and reclaimed past the window even on a live pid. Reclaim is ONLY an
# atomic rename to a unique quarantine name — never an unlink of the live
# path — then {@link env_lock_legacy_resolve} re-reads the captured file.
# Returns 0 while it still blocks acquisition, 1 once clear.
env_lock_legacy_held() {
  local legacy="$1" lpid rest q attempt=0 age
  while [ -f "$legacy" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -gt 4 ] && return 0
    lpid=""
    read -r lpid rest < "$legacy" 2>/dev/null || lpid=""
    if [[ "$lpid" =~ ^[0-9]+$ ]] && ! env_lock_pid_alive "$lpid"; then
      : # a proven-dead pid is reclaimed regardless of the lock's age
    else
      # A live pid — or a record that cannot be parsed at all — can never
      # prove the owner's start identity, so the lock is held ONLY inside
      # the bounded orphan window (an unreadable age stays held); past it
      # we reclaim below like any stale dir.
      age="$(env_lock_dir_age_secs "$legacy")"
      if [ "$age" -lt 0 ] || [ "$age" -lt "$ENV_LOCK_ORPHAN_SECS" ]; then
        return 0
      fi
    fi
    # Reclaimable (dead pid, or a record past the bounded window): move the
    # file aside atomically — exactly one contender wins — then adjudicate
    # the CAPTURED record before deleting anything.
    ENV_LOCK_QSEQ=$((ENV_LOCK_QSEQ + 1))
    q="$legacy.stale.$$.$ENV_LOCK_NONCE.$ENV_LOCK_QSEQ"
    mv "$legacy" "$q" 2>/dev/null || continue
    env_lock_legacy_resolve "$q" "$legacy" && return 0
    # Verified dead and deleted — loop and re-check for a successor file.
  done
  return 1
}

# Publish OUR owner record inside the just-mkdir'd lock dir — NO-REPLACE:
# a publisher paused between the mkdir and here may have been quarantined
# and its path re-taken by a successor, and `mv` would silently stamp over
# the successor's record. `ln` fails outright on an existing owner; the
# noclobber create carries the same guarantee where hardlinks do not work.
# $2 = the inode of the just-`mkdir`'d dir, captured at acquire — empty
# means unknown and only the marker veto applies. rc 0 = published AND the
# live record still carries OUR nonce (the dir may be swapped even after a
# successful link — verify before believing the lock is held);
# 1 = did not acquire, the caller retries from the top; 2 = the tmp write
# itself failed, the caller drops its own dir.
env_lock_publish_owner() {
  local lockdir="$1" want_ino="${2:-}" start stolen same_gen marker now_ino
  start="$(env_lock_start_identity "$$")"
  if [ -z "$start" ]; then
    # A live owner MUST carry a provable start identity — `start=-` made a
    # held lock reclaimable by a third writer while the owner was still
    # alive (a transient probe failure used to be written as `-`). A failed
    # probe publishes NOTHING: drop the dir WE made — only while it is
    # still our generation — and report a retryable failure so the acquire
    # loop re-probes from the top.
    if [ -n "$want_ino" ] \
      && [ "$(env_lock_path_ino "$lockdir")" = "$want_ino" ]; then
      rmdir "$lockdir" 2>/dev/null || true
    fi
    return 1
  fi
  printf 'kind=openllm-env-lock/v1 pid=%s start=%s nonce=%s\n' \
    "$$" "$start" "$ENV_LOCK_NONCE" > "$lockdir/owner.tmp.$$" 2>/dev/null \
    || return 2
  if ln "$lockdir/owner.tmp.$$" "$lockdir/owner" 2>/dev/null \
    || (set -C; cat "$lockdir/owner.tmp.$$" > "$lockdir/owner") 2>/dev/null; then
    rm -f "$lockdir/owner.tmp.$$" 2>/dev/null
    # Generation + steal veto — checked AFTER our record lands: the dir at
    # the path must still be the SAME generation we `mkdir`'d (inode match
    # — a successor's dir carries no `steal.*` marker for OUR quarantined
    # generation) AND hold no steal marker. stolen=1 means the hold is
    # already lost: drop OUR record — only when it is still ours — and
    # report failure; the caller retries acquisition from the top. An
    # unknown want_ino falls back to the marker veto alone, exactly like
    # the daemon (expectedIno undefined → same generation assumed).
    stolen=1
    same_gen=0
    if [ -d "$lockdir" ]; then
      now_ino="$(env_lock_path_ino "$lockdir")"
      if [ -z "$want_ino" ] \
        || { [ -n "$now_ino" ] && [ "$now_ino" = "$want_ino" ]; }; then
        same_gen=1
        stolen=0
        for marker in "$lockdir"/steal.*; do
          if [ -e "$marker" ]; then stolen=1; break; fi
        done
      fi
    fi
    if [ "$stolen" = 1 ]; then
      env_lock_read_owner "$lockdir"
      if [ "$ENV_LOCK_OWNER_STATE" = "marked" ] \
        && [ "$ENV_LOCK_OWNER_NONCE" = "$ENV_LOCK_NONCE" ]; then
        rm -f "$lockdir/owner" 2>/dev/null
      fi
      # Only OUR generation is ours to remove — a successor's dir at the
      # same path is left for its real publisher.
      [ "$same_gen" = 1 ] && rmdir "$lockdir" 2>/dev/null || true
      return 1
    fi
    env_lock_read_owner "$lockdir"
    [ "$ENV_LOCK_OWNER_STATE" = "marked" ] \
      && [ "$ENV_LOCK_OWNER_NONCE" = "$ENV_LOCK_NONCE" ]
    return
  fi
  rm -f "$lockdir/owner.tmp.$$" 2>/dev/null
  return 1
}

# Acquire `<envfile>.lock.d` and publish our marked owner record. On
# success sets ENV_LOCK_DIR + ENV_LOCK_NONCE (env_lock_release consumes
# them) and returns 0.
env_lock_acquire() {
  local envfile="$1" stem lockdir deadline attempts pub_rc ino
  stem="$envfile.lock"
  lockdir="$stem.d"
  deadline=$((SECONDS + ENV_LOCK_WAIT_SECS))
  ENV_LOCK_NONCE="$(printf '%x%x%x' "$$" "$RANDOM" "$(date +%s 2>/dev/null || echo 0)")"
  attempts=0
  # Bounded cleanup once per acquire so quarantined residue cannot linger
  # until the next contested acquire (identical trigger in the daemon).
  env_lock_sweep "$stem"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! env_lock_legacy_held "$stem"; then
      if mkdir "$lockdir" 2>/dev/null; then
        # Pin the generation we created so the publish veto detects a
        # quarantine+path-reuse, not only an in-place steal marker.
        ino="$(env_lock_path_ino "$lockdir")"
        env_lock_publish_owner "$lockdir" "$ino"
        pub_rc=$?
        if [ "$pub_rc" = 0 ]; then
          ENV_LOCK_DIR="$lockdir"
          return 0
        elif [ "$pub_rc" = 2 ]; then
          # The tmp write failed — drop the dir WE made rather than hold it
          # unmarked.
          rm -f "$lockdir/owner.tmp.$$" 2>/dev/null
          rmdir "$lockdir" 2>/dev/null || true
          return 1
        fi
        # pub_rc=1 — a successor owns the dir at this path (or it was
        # swapped mid-publish): NOT ours to remove. Fall through to the
        # staleness pass and retry acquisition from the top.
      fi
      attempts=$((attempts + 1))
      [ $((attempts % 25)) -eq 0 ] && env_lock_sweep "$stem"
      if env_lock_is_stale_dir "$lockdir"; then
        env_lock_steal "$lockdir" "$stem"
      fi
    fi
    sleep 0.01 2>/dev/null || sleep 1
  done
  return 1
}

# Restore a quarantined lock dir at the live path — NO-REPLACE. `mv` would
# silently replace a successor's just-`mkdir`'d (still empty) dir that
# landed in the check->move gap; `mkdir` is the atomic no-replace claim —
# a re-taken path leaves the captured dir parked for the sweep. On a
# successful claim each regular file is copied VERIFIED — a noclobber
# create, then a byte-and-size compare against the source — and the
# quarantined source is deleted only after EVERY copy lands whole: a
# failed or partial copy rolls the fresh dir back to empty and keeps the
# captured dir intact for a later pass — the only valid owner record is
# never destroyed by an incomplete restore.
env_lock_restore_dir() {
  local rel="$1" lockdir="$2" child base dst ok=1 l_sz q_sz
  # "$@" accumulates the basenames this pass copied — arbitrary foreign
  # names (spaces, glob chars) cannot split or glob inside "$@".
  set --
  mkdir "$lockdir" 2>/dev/null || return 0
  for child in "$rel"/*; do
    [ -f "$child" ] || continue
    base="${child##*/}"
    dst="$lockdir/$base"
    # Noclobber-claim the destination name FIRST (set -C create), then fill
    # it — the claim distinguishes "a file THIS pass made" from a foreign
    # entry that landed first, which is never removed below. The fill uses
    # `>>` so a foreign swap can never be truncated by us.
    if (set -C; : > "$dst") 2>/dev/null; then
      cat "$child" >> "$dst" 2>/dev/null || true
      l_sz="$(stat -c %s "$dst" 2>/dev/null || stat -f %z "$dst" 2>/dev/null || true)"
      q_sz="$(stat -c %s "$child" 2>/dev/null || stat -f %z "$child" 2>/dev/null || true)"
      if [ -n "$q_sz" ] && [ "$q_sz" = "$l_sz" ] \
        && [ "$(cat "$child" 2>/dev/null)" = "$(cat "$dst" 2>/dev/null)" ]; then
        set -- "$@" "$base"
        continue
      fi
      # The copy failed or mis-verified: remove the file THIS pass made,
      # then abort — the quarantined source is preserved for a later pass.
      rm -f "$dst" 2>/dev/null || true
    fi
    ok=0
    break
  done
  if [ "$ok" = 1 ]; then
    # Flush the copied dir best-effort (no portable fsync exists in sh):
    # `sync` covers the file payloads where it is available.
    command -v sync >/dev/null 2>&1 && sync 2>/dev/null || true
  else
    # Roll the fresh dir back to its claimed-empty state — only the files
    # this pass copied — then drop the dir itself.
    for base in "$@"; do rm -f "$lockdir/$base" 2>/dev/null || true; done
    rmdir "$lockdir" 2>/dev/null || true
    return 0
  fi
  for base in "$@"; do rm -f "$rel/$base" 2>/dev/null || true; done
  # Any entry that survived (non-regular or foreign residue) keeps the
  # quarantine parked for the sweep instead of being lost.
  rmdir "$rel" 2>/dev/null || true
  return 0
}

# Release OUR lock: move `.lock.d` to `.lock.rel.<pid>.<nonce>` ONLY when
# the record at the live path still reads as ours — a foreign marked owner
# (a successor that re-took the path after our dir was stolen) is never
# touched. The captured dir is then verified inside the quarantine: our
# nonce means delete; a foreign record means the path was swapped mid-move
# and the dir is restored NO-REPLACE (env_lock_restore_dir), never
# `mv`'d over a successor's fresh dir.
env_lock_release() {
  local lockdir="${ENV_LOCK_DIR:-}" stem rel
  [ -n "$lockdir" ] || return 0
  ENV_LOCK_DIR=""
  stem="${lockdir%.d}"
  rel="$stem.rel.$$.$ENV_LOCK_NONCE"
  env_lock_read_owner "$lockdir"
  if [ "$ENV_LOCK_OWNER_STATE" = "marked" ] \
    && [ "$ENV_LOCK_OWNER_NONCE" = "$ENV_LOCK_NONCE" ]; then
    if mv "$lockdir" "$rel" 2>/dev/null; then
      env_lock_read_owner "$rel"
      if [ "$ENV_LOCK_OWNER_STATE" = "marked" ] && [ "$ENV_LOCK_OWNER_NONCE" = "$ENV_LOCK_NONCE" ]; then
        local child
        for child in "$rel"/*; do rm -f "$child" 2>/dev/null || true; done
        rmdir "$rel" 2>/dev/null || true
      else
        env_lock_restore_dir "$rel" "$lockdir"
      fi
    fi
  fi
  return 0
}
# <<< openllm-env-lock/v1 <<<
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
  env_lock_acquire "$ENV_FILE" \
    || die "could not acquire config lock: $ENV_FILE.lock.d (remove it manually if no installer or daemon is running)"
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
