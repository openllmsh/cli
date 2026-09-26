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

# The one remaining replacement refusal: an installed build NEWER than the
# advertised CLI release. Fail closed with the manual remedy printed (DR-1).
assert_no_downgrade() {
  local binary="$1" output installed
  [ -x "$binary" ] || return 0
  probe_version "$binary"
  output="$PROBE_OUTPUT"
  if [[ "$output" =~ (^|[^[:alnum:].+_-])v?([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?)([^[:alnum:].+-]|$) ]]; then
    installed="${BASH_REMATCH[2]}"
  else
    die "could not parse installed CLI version at $binary; refusing to overwrite it"
  fi
  [ "$(semver_cmp "$installed" "$CLI_VERSION")" != "1" ] || die "installed $binary is $installed, newer than the advertised release $CLI_VERSION — refusing to downgrade.
  To force the advertised version, remove $binary and re-run this installer."
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

has_command curl || die "curl is required"
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
assert_no_downgrade "$DEST"
assert_no_downgrade "$BIN_DIR/openllmc"

mkdir -p "$BIN_DIR"

URL="$ORIGIN/api/cli/binary/$TARGET"
STAMP="$BIN_DIR/.openllm.sha256.stamp"

PUBLISHED="$(curl "${CURL_SCHEME[@]}" -fsSL "$URL.sha256" 2>/dev/null | cut -d' ' -f1 || true)"
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
  # Download+verify+swap in a SUBSHELL: its EXIT trap (temp-file cleanup) stays
  # scoped and can never replace — or erase with `trap - EXIT` — an outer EXIT
  # trap if this script is ever embedded in a wrapper.
  (
    trap 'rm -f "$DL" "$BIN"' EXIT
    if [ -t 2 ]; then
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
    ACTUAL="$(sha256_of "$BIN")"
    [ -n "$ACTUAL" ] || die "could not hash the download"
    [ "$ACTUAL" = "$PUBLISHED" ] \
      || die "checksum mismatch (expected $PUBLISHED, got $ACTUAL) — refusing to install"
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
    # The installed executable may have changed while the download was in flight.
    assert_no_downgrade "$DEST"
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
# `start` is the owner's `ps -o lstart=` identity under LC_ALL=C TZ=UTC
# with whitespace collapsed to single spaces — the same value the daemon's
# `processStartIdentity` reads. It distinguishes a LIVE-but-reused pid from
# the real owner (PID reuse). `-` records an owner that could not read its
# own identity.
#
# A held lock is STALE only when its marked owner names a dead pid, or a
# live pid whose current start identity differs. A dir with no, unreadable
# or unmarked owner is HELD — the one exception is a dir older than the
# stale window that still has no complete owner (a holder killed between
# `mkdir` and publish), which may be reclaimed.
#
# Reclaim is an atomic `mv .lock.d .lock.stale.<pid>.<nonce>` — exactly one
# contender wins the rename. The winner re-reads the owner INSIDE the
# quarantine: if it turns out to be live after all it is moved back, but
# only when `.lock.d` still does not exist (no-replace); otherwise it stays
# quarantined. Acquisition is retried either way. Quarantine dirs older
# than the stale window are swept when their contents are only `owner.tmp.*`
# publish residue (or empty — the crash-between-mkdir-and-publish shape) or
# a complete marked owner record.
#
# Release is `mv .lock.d .lock.rel.<pid>.<nonce>` first, then the record's
# nonce is verified before deleting — a holder whose lock was stolen or
# replaced finds a successor's record and puts it back instead of deleting.
#
# The pre-dir `.env.lock` FILE is still honoured for one release: HELD
# while its recorded pid is alive or its content is unparseable. A dead-pid
# record is reclaimed ONLY by atomic rename to a unique quarantine name —
# the live path is never unlinked directly — then re-read there: a record
# that turns out to be live is put back with a no-replace link, never over
# a successor lock file.
ENV_LOCK_STALE_SECS="${OPENLLM_ENV_LOCK_STALE_SECS:-600}"
ENV_LOCK_WAIT_SECS="${OPENLLM_ENV_LOCK_WAIT_SECS:-10}"
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
# processStartIdentity uses, whitespace collapsed to single spaces.
env_lock_start_identity() {
  local out
  out="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null)" || out=""
  out="$(printf '%s' "$out" | tr -s '[:space:]' ' ')"
  out="${out# }"
  out="${out% }"
  printf '%s' "$out"
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
  local mtime now
  mtime="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || true)"
  now="$(date +%s 2>/dev/null || true)"
  if [[ "$mtime" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]]; then
    printf '%s\n' $((10#$now - 10#$mtime))
  else
    printf '%s\n' -1
  fi
}

# The ONE staleness predicate — identical rules on the daemon side.
# $1 = the lock dir (or a quarantined dir).
env_lock_is_stale_dir() {
  local dir="$1" current age
  env_lock_read_owner "$dir"
  if [ "$ENV_LOCK_OWNER_STATE" = "marked" ]; then
    env_lock_pid_alive "$ENV_LOCK_OWNER_PID" || return 0
    if [ "$ENV_LOCK_OWNER_START" = "-" ]; then
      # The start identity can never be proven ("-"): the lock is held only
      # inside the same bounded window an ownerless dir gets — past it a
      # live-but-unidentifiable pid no longer wedges the lock.
      age="$(env_lock_dir_age_secs "$dir")"
      { [ "$age" -ge 0 ] && [ "$age" -ge "$ENV_LOCK_STALE_SECS" ]; }
      return
    fi
    current="$(env_lock_start_identity "$ENV_LOCK_OWNER_PID")"
    # PID reuse is proven ONLY by a live-but-different identity; anything
    # unreadable keeps the lock held.
    [ -n "$current" ] && [ "$current" != "$ENV_LOCK_OWNER_START" ]
    return
  fi
  # Unmarked: HELD unless old AND still unclaimed — and never while a
  # parseable pid inside it is still alive.
  age="$(env_lock_dir_age_secs "$dir")"
  { [ "$age" -ge 0 ] && [ "$age" -ge "$ENV_LOCK_STALE_SECS" ]; } || return 1
  if [[ "$ENV_LOCK_OWNER_PID" =~ ^[0-9]+$ ]] && env_lock_pid_alive "$ENV_LOCK_OWNER_PID"; then
    return 1
  fi
  return 0
}

# Reclaim = `mv .lock.d .lock.stale.<pid>.<nonce>` — atomic; exactly one
# contender wins the rename. A re-read owner that turns out to be live is
# restored, but never over an existing `.lock.d` (no-replace).
env_lock_quarantine() {
  local lockdir="$1" stem="$2" q
  q="$stem.stale.$$.$ENV_LOCK_NONCE"
  mv "$lockdir" "$q" 2>/dev/null || return 0
  env_lock_is_stale_dir "$q" && return 0
  if [ ! -e "$lockdir" ] && [ ! -L "$lockdir" ]; then
    mv "$q" "$lockdir" 2>/dev/null || true
  fi
  return 0
}

# Delete old quarantine/release dirs whose contents are only `owner.tmp.*`
# publish residue (or EMPTY — a holder killed between mkdir and publish,
# then quarantined) or a complete marked owner record. Anything foreign is
# kept.
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
        owner.tmp.*) ;;
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
    if [ "$age" -lt 0 ] || [ "$age" -lt "$ENV_LOCK_STALE_SECS" ]; then
      if ln "$q" "$legacy" 2>/dev/null; then
        rm -f "$q" 2>/dev/null || true
      elif (set -C; cat "$q" > "$legacy") 2>/dev/null; then
        rm -f "$q" 2>/dev/null || true
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
      # the bounded reclaim window (an unreadable age stays held); past it
      # we reclaim below like any stale dir.
      age="$(env_lock_dir_age_secs "$legacy")"
      if [ "$age" -lt 0 ] || [ "$age" -lt "$ENV_LOCK_STALE_SECS" ]; then
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
# rc 0 = published AND the live record still carries OUR nonce (the dir may
# be swapped even after a successful link — verify before believing the
# lock is held); 1 = did not acquire, the caller retries from the top;
# 2 = the tmp write itself failed, the caller drops its own dir.
env_lock_publish_owner() {
  local lockdir="$1" start
  start="$(env_lock_start_identity "$$")"
  [ -n "$start" ] || start="-"
  printf 'kind=openllm-env-lock/v1 pid=%s start=%s nonce=%s\n' \
    "$$" "$start" "$ENV_LOCK_NONCE" > "$lockdir/owner.tmp.$$" 2>/dev/null \
    || return 2
  if ln "$lockdir/owner.tmp.$$" "$lockdir/owner" 2>/dev/null \
    || (set -C; cat "$lockdir/owner.tmp.$$" > "$lockdir/owner") 2>/dev/null; then
    rm -f "$lockdir/owner.tmp.$$" 2>/dev/null
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
  local envfile="$1" stem lockdir deadline attempts pub_rc
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
        env_lock_publish_owner "$lockdir"
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
        env_lock_quarantine "$lockdir" "$stem"
      fi
    fi
    sleep 0.01 2>/dev/null || sleep 1
  done
  return 1
}

# Release OUR lock: move `.lock.d` to `.lock.rel.<pid>.<nonce>` first, then
# delete only when the owner record inside is provably ours — a stolen or
# replaced lock holds a successor's record, which is put back (no-replace)
# instead of deleted.
env_lock_release() {
  local lockdir="${ENV_LOCK_DIR:-}" stem rel
  [ -n "$lockdir" ] || return 0
  ENV_LOCK_DIR=""
  stem="${lockdir%.d}"
  rel="$stem.rel.$$.$ENV_LOCK_NONCE"
  if mv "$lockdir" "$rel" 2>/dev/null; then
    env_lock_read_owner "$rel"
    if [ "$ENV_LOCK_OWNER_STATE" = "marked" ] && [ "$ENV_LOCK_OWNER_NONCE" = "$ENV_LOCK_NONCE" ]; then
      local child
      for child in "$rel"/*; do rm -f "$child" 2>/dev/null || true; done
      rmdir "$rel" 2>/dev/null || true
    elif [ ! -e "$lockdir" ] && [ ! -L "$lockdir" ]; then
      mv "$rel" "$lockdir" 2>/dev/null || true
    fi
  fi
  return 0
}
# <<< openllm-env-lock/v1 <<<
(
  tmp="$ENV_FILE.tmp.$$"
  env_lock_acquire "$ENV_FILE" \
    || die "could not acquire config lock: $ENV_FILE.lock.d (remove it manually if no installer or daemon is running)"
  # Any exit while the lock is held — die, a set -e failure, Ctrl-C, SIGTERM —
  # must release the lock AND remove the temp file (it may carry the API key).
  # env_lock_release deletes only a dir that still holds OUR owner record.
  trap 'rm -f "${tmp:-}"; env_lock_release' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The subshell keeps the private creation mode out of later shell setup.
  umask 077
  : > "$tmp"
  wrote_origin=0
  wrote_key=0
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "${line%%=*}" in
        OPENLLM_CLOUD_ORIGIN)
          if [ "$wrote_origin" = 0 ]; then
            printf 'OPENLLM_CLOUD_ORIGIN=%s\n' "$ORIGIN" >> "$tmp"
            wrote_origin=1
          fi
          ;;
        OPENLLM_API_KEY)
          if [ -n "${OPENLLM_API_KEY:-}" ]; then
            if [ "$wrote_key" = 0 ]; then
              printf 'OPENLLM_API_KEY=%s\n' "$OPENLLM_API_KEY" >> "$tmp"
              wrote_key=1
            fi
          else
            printf '%s\n' "$line" >> "$tmp"
          fi
          ;;
        *) printf '%s\n' "$line" >> "$tmp" ;;
      esac
    done < "$ENV_FILE"
  fi
  if [ "$wrote_origin" = 0 ]; then printf 'OPENLLM_CLOUD_ORIGIN=%s\n' "$ORIGIN" >> "$tmp"; fi
  if [ -n "${OPENLLM_API_KEY:-}" ] && [ "$wrote_key" = 0 ]; then
    printf 'OPENLLM_API_KEY=%s\n' "$OPENLLM_API_KEY" >> "$tmp"
  fi
  chmod 0600 "$tmp"
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
