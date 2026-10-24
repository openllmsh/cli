#!/usr/bin/env bash
# OpenLLM installer — installs the single `openllm` binary (the CLI, plus the
# `ollm` alias, AND the local daemon as `openllm daemon`). A daemon service starts only when a usable
# API key is already supplied or persisted. For a keyless install the script does
# not reimplement onboarding — on a controlling terminal it hands straight off to
# `openllm start` (whose credential gate prompts on /dev/tty); with no terminal it
# just prints the `openllm start` next step and exits zero.
#
#   curl -fsSL https://www.openllm.sh/install | bash
#
#   # with a key, so the daemon is paired immediately:
#   curl -fsSL https://www.openllm.sh/install | OPENLLM_API_KEY=sk-llm-... bash
#
#   # a strict machine: remote device sessions can only be enabled locally
#   curl -fsSL https://www.openllm.sh/install | OPENLLM_API_KEY=sk-llm-... bash -s -- --lock-device-sessions
#
# Options (after `bash -s --`):
#   --lock-device-sessions the daemon refuses a REMOTE enable of device (agent)
#                          sessions; only `openllm device enable` on this
#                          machine turns them on
#
# Env (all optional):
#   OPENLLM_CLOUD_ORIGIN   gateway origin (env → existing ~/.openllm/.env →
#                          default https://www.openllm.sh; a re-run keeps your origin)
#   OPENLLM_API_KEY        pair the daemon now; otherwise pair from the dashboard.
#                          The dashboard's command carries a device trust anchor
#                          after the key (`sk-llm-<key>.<anchor>`): it is split
#                          off here, pinned locally (state.json, 0600) and NEVER
#                          written to .env, logged, or sent — only the bare
#                          `sk-llm-<key>` is stored and used as the bearer
#   OPENLLM_DAEMON_PORT    local daemon port (default 8787; if unset AND
#                          nothing is already persisted, and 8787 is taken on
#                          this machine, the installer walks forward to the
#                          next free port nearby and persists that instead —
#                          an explicit or already-persisted port is never
#                          probed or changed)
#   OPENLLM_SKIP_SHELL_SETUP     set to skip `openllm setup` + completion install
#                                (PATH symlinks / shell rc / completion stay untouched)
#   OPENLLM_SKIP_VENDOR_CLIS     set to skip background vendor CLI provisioning
#   OPENLLM_ONLY_VENDOR_CLIS     comma-separated subscription slugs to provision
#                                (e.g. claude_code,chatgpt); unset = all vendors
#
# This is the ONLY shell installer. It also background-provisions
# any missing vendor subscription CLIs (claude / codex / kimi / grok / cursor-agent / muse) via each
# vendor's official installer — skip if already present. Google Antigravity has no
# installer script, so the latest official ACP agent release (resolved from the
# ACP registry) is downloaded and unpacked under ~/.openllm/vendor/antigravity. It never edits a
# third-party client config: `openllm <client>` applies OpenLLM at run time
# instead. The only files it writes outside ~/.openllm (besides what a vendor
# installer itself does) are the PATH symlinks and the ONE marked block in your
# shell rc that `openllm setup` / `openllm daemon completion` manage.
set -euo pipefail

# ORIGIN is resolved in preflight (env → existing ~/.openllm/.env → default),
# mirroring the CLI's cliConfig() precedence — see below.
OPENLLM_DIR="$HOME/.openllm"
BIN_DIR="$OPENLLM_DIR/bin"
ENV_FILE="${OPENLLM_DAEMON_ENV_FILE:-$OPENLLM_DIR/.env}"
# DAEMON_PORT is resolved in preflight (env → existing env-file value → default),
# once `env_file_value`/`die` are defined — see below.
# `install` (default) is a first-time install; `update` is a manual full-product
# rerun (`openllm update`). Update mode converges the verified binaries + config
# but must NOT repeat first-install side effects: no vendor-CLI provisioning, no
# shell/PATH/completion edits, and no teardown of an existing healthy service.
# (Validated in preflight, once `die` is defined.)
INSTALL_MODE="${OPENLLM_INSTALL_MODE:-install}"
# Space-delimited list of components whose on-disk bytes were actually replaced
# this run (see install_component). Update mode reads it to skip a pointless
# daemon restart when nothing changed.
INSTALLED_COMPONENTS=""

has_command() { command -v "$1" >/dev/null 2>&1; }

die() { echo "Error: $*" >&2; exit 1; }

# Installer options (`curl … | bash -s -- --lock-device-sessions`).
LOCK_DEVICE_SESSIONS=0
for arg in "$@"; do
  case "$arg" in
    --lock-device-sessions) LOCK_DEVICE_SESSIONS=1 ;;
    *) die "unknown installer option: $arg" ;;
  esac
done

# Can we prompt the human running this install? A piped `curl … | bash` leaves
# the script's own stdin as the download stream, but the user's terminal is still
# addressable as /dev/tty. `openllm start`'s credential gate reads the key from
# /dev/tty yet decides interactivity from stdin/stderr being TTYs — so we only
# hand off to it when stderr is a real terminal AND /dev/tty is openable. In a
# non-interactive install (CI, a pipe with no terminal) this is false and we fall
# back to printing the manual `openllm start` next step.
has_controlling_tty() {
  [ -t 2 ] || return 1
  { true < /dev/tty; } 2>/dev/null
}

# Bash strings cannot contain NUL bytes: command substitution and shell variables
# discard them before this script can inspect a value. Do not add `$'\0'` to this
# glob — Bash expands it to an empty string, turning the glob into `**` and
# matching every input.
has_line_break() { [[ "$1" == *$'\n'* || "$1" == *$'\r'* ]]; }

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Read one KEY's LAST-occurrence value from the shared env file, mirroring
# `parseEnvLines` (packages/cli/daemon/src/env.ts): trim the whole line, skip
# blank/`#` lines, split at the first `=`, trim both sides. `parseEnvLines`
# folds lines into a `Map` via `.set(key, value)`, so a later duplicate
# OVERWRITES an earlier one — the last matching line must win here too (the
# bug this replaces: every reader below used to return on its first match).
# No quote/comment stripping here — that's a per-caller decision below.
env_file_lookup() {
  local wanted="$1" line trimmed key value result="" found=0
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    trimmed="$(trim_whitespace "$line")"
    case "$trimmed" in ""|\#*) continue ;; esac
    case "$trimmed" in *=*) ;; *) continue ;; esac
    key="$(trim_whitespace "${trimmed%%=*}")"
    [ -n "$key" ] || continue
    [ "$key" = "$wanted" ] || continue
    value="$(trim_whitespace "${trimmed#*=}")"
    result="$value"
    found=1
  done < "$ENV_FILE"
  [ "$found" = 1 ] && printf '%s' "$result"
  return 0
}

# Read one KEY's value from the shared env file (last match wins — see
# `env_file_lookup`), additionally stripping one layer of surrounding quotes
# so it matches how the CLI resolves the same file (`parseEnvFile` in
# packages/cli/src/env.ts, which underlies `cliConfig()`). Used only to seed
# the effective origin below; empty/absent → empty string.
env_file_value() {
  local wanted="$1" value
  value="$(env_file_lookup "$wanted")"
  value="${value#[\"\']}"
  value="${value%[\"\']}"
  printf '%s' "$value"
}

# Read one KEY's RAW value from the shared env file (last match wins) —
# outer-whitespace trimmed only, no quote or comment stripping — for the
# port, whose protocol-compatible parsing (`normalize_daemon_port`) needs the
# untouched value: whether a comment sits inside or outside the quotes
# changes the correct strip order, so `env_file_value`'s single fixed order
# (quotes always stripped first) cannot be reused here.
env_file_raw_value() {
  env_file_lookup "$1"
}

is_usable_api_key() {
  local key="$1"
  # Minted keys are `sk-llm-` + a 10-byte base64url id (14 chars) + `.` +
  # a 32-byte base64url secret (43 chars). Restricting this shell boundary to
  # the wire grammar keeps values safe to persist in KEY=value config files.
  [[ "$key" =~ ^sk-llm-[A-Za-z0-9_-]{14}[.][A-Za-z0-9_-]{43}$ ]]
}

# A device trust anchor: base64url of 64 bytes (86 chars, unpadded).
is_device_anchor() {
  [[ "$1" =~ ^[A-Za-z0-9_-]{86}$ ]]
}

sha256_of() {
  if has_command shasum; then shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif has_command sha256sum; then sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  fi
}

# --- preflight -------------------------------------------------------------
# A custom env-file override must be absolute: the daemon + CLI only honour
# OPENLLM_DAEMON_ENV_FILE when it is absolute (see packages/cli/src/env.ts), so a
# relative value here would write config the runtime never reads. Validate this
# BEFORE reading the file for the origin fallback, so we never read a relative
# path resolved against the caller's cwd.
if [ -n "${OPENLLM_DAEMON_ENV_FILE:-}" ]; then
  case "$OPENLLM_DAEMON_ENV_FILE" in
    /*) ;;
    *) die "OPENLLM_DAEMON_ENV_FILE must be an absolute path" ;;
  esac
fi
# Effective origin — process env, else the origin already recorded in the shared
# env file, else the compiled production default. This mirrors the CLI's
# cliConfig() precedence (packages/cli/src/env.ts), so re-running the installer
# (or `openllm update`) from a preview/self-host origin does NOT silently reset a
# user's persisted OPENLLM_CLOUD_ORIGIN back to production. An explicit
# OPENLLM_CLOUD_ORIGIN in the environment still wins.
ORIGIN="${OPENLLM_CLOUD_ORIGIN:-}"
[ -n "$ORIGIN" ] || ORIGIN="$(env_file_value OPENLLM_CLOUD_ORIGIN)"
[ -n "$ORIGIN" ] || ORIGIN="https://www.openllm.sh"
ORIGIN="${ORIGIN%/}"
has_line_break "$ORIGIN" && die "OPENLLM_CLOUD_ORIGIN must not contain a line break"
[ -n "$ORIGIN" ] || die "OPENLLM_CLOUD_ORIGIN must not be empty"
# Effective port — explicit env, else the port already persisted in the shared
# env file, else the default. Mirrors the ORIGIN precedence above. A malformed
# selected value falls back to the default rather than partially parsing.
#
# `normalize_daemon_port` mirrors packages/protocol/daemon-port.ts's
# `parseOpenllmDaemonPort` byte-for-byte: strip an inline `# comment` and one
# layer of quotes, in the order that depends on whether the comment sits
# INSIDE or OUTSIDE the quotes (`"59321 # local"` vs `"59321" # local` vs a
# bare `59321 # local`), then require a plain decimal in 1-65535. No eval, no
# sourcing, no octal interpretation (a leading-zero string like `"08787"`
# still parses as decimal here, matching `Number.parseInt(_, 10)`), and the
# digit-count bound below keeps `[ ... -ge ... ]` from ever seeing a string
# long enough to trip a shell integer-overflow diagnostic.
normalize_daemon_port() {
  local raw="$1" trimmed value decommented stripped
  trimmed="$(trim_whitespace "$raw")"
  if [[ "$trimmed" =~ ^\".*\"$ || "$trimmed" =~ ^\'.*\'$ ]] && [ "${#trimmed}" -ge 2 ]; then
    value="${trimmed:1:${#trimmed}-2}"
    if [[ "$value" =~ ^(.*)[[:space:]]#.*$ ]]; then
      value="$(trim_whitespace "${BASH_REMATCH[1]}")"
    fi
  else
    decommented="$trimmed"
    if [[ "$trimmed" =~ ^(.*)[[:space:]]#.*$ ]]; then
      decommented="$(trim_whitespace "${BASH_REMATCH[1]}")"
    fi
    if { [[ "$decommented" =~ ^\".*\"$ || "$decommented" =~ ^\'.*\'$ ]] && [ "${#decommented}" -ge 2 ]; }; then
      value="${decommented:1:${#decommented}-2}"
    else
      value="$decommented"
    fi
  fi
  stripped="$(trim_whitespace "$value")"
  case "$stripped" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "${#stripped}" -le 7 ] || return 1
  { [ "$stripped" -ge 1 ] && [ "$stripped" -le 65535 ]; } || return 1
  printf '%s' "$stripped"
}

# Default port + the bounded range the auto-increment scan below may walk
# into (8787-8796) — only reached when no explicit/persisted port exists yet
# (see the DAEMON_PORT resolution below); an explicit or persisted port is
# never probed or reassigned.
DEFAULT_DAEMON_PORT=8787
PORT_SCAN_LIMIT=10

# Is 127.0.0.1:$port free to bind? Returns 0 free, 1 occupied, 2 unverifiable
# — a tier returns 2 (rather than falling through) the moment it gets an
# answer it cannot confidently classify, so a shaky result never gets
# silently reinterpreted as "free" by a later tier. No single tool is
# guaranteed present, so this tries, in order:
#   1. python3 — an actual bind() attempt; the only reliable tier. Its exit
#      code is explicit: 0 free, 1 EADDRINUSE (occupied), 2 any other error
#      (permission denied, missing socket support, …) — never guessed.
#   2. bash's /dev/tcp, bounded by `timeout` so a filtered/backlogged port
#      can't hang the install — skipped outright without `timeout`, since an
#      unbounded connect is not an acceptable fallback. A connect success or
#      a reset both mean something is already there (occupied); "Connection
#      refused" is the ordinary free-port result. Anything else (including a
#      build without /dev/tcp support) falls through to the next tier.
#   3. nc -z -v with a 1s timeout, tried only if 2 gave no answer. A ZERO
#      exit always means connected (occupied) regardless of output. A
#      nonzero exit is free ONLY on an explicit "Connection refused" in the
#      (C-locale, so the text is predictable) output; a reset is occupied;
#      anything else — timeout, an invalid flag this nc build rejected, a
#      permission failure — is unverifiable, NOT free.
#   4. no reliable probe at all — unverifiable; the caller refuses to
#      install rather than silently gamble.
# Every tier is TCP-only on 127.0.0.1 (never 0.0.0.0/UDP) and closes its probe
# socket immediately, so nothing here holds a port — a bind/start race
# against another process remains inherent to any check-then-act port pick.
port_is_free() {
  local port="$1"

  if has_command python3; then
    local py_rc
    # The heredoc runs as the tested command of this `if` so a nonzero exit
    # (1 = EADDRINUSE, 2 = any other error) is read via `$?` in the `else`
    # branch instead of tripping `set -e` — bash exempts the whole command a
    # conditional tests from errexit, including everything a function it
    # calls (here, none — it's a direct external command) runs.
    if python3 - "$port" >/dev/null 2>&1 <<'PY'
import errno
import socket
import sys

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError as e:
    sys.exit(1 if e.errno == errno.EADDRINUSE else 2)
else:
    sys.exit(0)
finally:
    s.close()
PY
    then
      py_rc=0
    else
      py_rc=$?
    fi
    case "$py_rc" in
      0) return 0 ;;
      1) return 1 ;;
      *) return 2 ;;
    esac
  fi

  if has_command timeout; then
    local probe
    probe="$(timeout 1 bash -c "exec 3<>'/dev/tcp/127.0.0.1/$port' && printf OK" 2>&1)" || true
    case "$probe" in
      OK) return 1 ;;
      *[Rr]efused*) return 0 ;;
      *"eset"*) return 1 ;;
    esac
  fi

  if has_command nc; then
    local out
    # Same if/else exit-code capture as the python3 tier above (a bare
    # failing assignment would otherwise trip `set -e` on the common "nc
    # exited nonzero because the port is free" case).
    if out="$(LC_ALL=C LANG=C nc -z -v -w 1 127.0.0.1 "$port" 2>&1)"; then
      return 1
    fi
    case "$out" in
      *"Connection refused"*) return 0 ;;
      *"onnection reset"*|*"eset by peer"*) return 1 ;;
    esac
    return 2
  fi

  return 2
}

# Bounded scan for a free port starting at $1, trying at most $2 candidates
# ($start, $start+1, … capped at 65535). Prints the first free port and
# returns 0; returns 1 once exhausted, or 2 the moment a probe can't verify.
find_available_port() {
  local start="$1" limit="$2" port attempt rc
  port="$start"
  attempt=0
  while [ "$attempt" -lt "$limit" ]; do
    port_is_free "$port"
    rc=$?
    [ "$rc" -eq 0 ] && { printf '%s' "$port"; return 0; }
    [ "$rc" -eq 2 ] && return 2
    attempt=$((attempt + 1))
    port=$((port + 1))
    [ "$port" -le 65535 ] || break
  done
  return 1
}

DAEMON_PORT="${OPENLLM_DAEMON_PORT:-}"
if [ -n "$DAEMON_PORT" ]; then
  if NORMALIZED_PORT="$(normalize_daemon_port "$DAEMON_PORT")"; then
    DAEMON_PORT="$NORMALIZED_PORT"
  else
    # Warn, but never echo the raw value: it is untrusted external input
    # (env var content) and could carry control/escape sequences into the
    # user's terminal.
    echo "Warning: ignoring an invalid OPENLLM_DAEMON_PORT (must be a plain port number 1-65535); falling back" >&2
    DAEMON_PORT=""
  fi
fi
if [ -z "$DAEMON_PORT" ]; then
  RAW_PERSISTED_PORT="$(env_file_raw_value OPENLLM_DAEMON_PORT)"
  if [ -n "$RAW_PERSISTED_PORT" ]; then
    NORMALIZED_PORT="$(normalize_daemon_port "$RAW_PERSISTED_PORT")" && DAEMON_PORT="$NORMALIZED_PORT"
  fi
fi
# Neither an explicit nor a persisted port exists yet — a genuinely
# first-ever choice, never a reassignment. Probe the default and, only here,
# walk forward to the next free port in a small bounded range.
if [ -z "$DAEMON_PORT" ]; then
  if RESOLVED_PORT="$(find_available_port "$DEFAULT_DAEMON_PORT" "$PORT_SCAN_LIMIT")"; then
    DAEMON_PORT="$RESOLVED_PORT"
  else
    SCAN_RC=$?
    if [ "$SCAN_RC" -eq 2 ]; then
      die "could not verify any port's availability near $DEFAULT_DAEMON_PORT (no python3, no timeout+/dev/tcp, no nc) — set OPENLLM_DAEMON_PORT to choose one explicitly"
    fi
    die "no free port found for the daemon in $DEFAULT_DAEMON_PORT-$((DEFAULT_DAEMON_PORT + PORT_SCAN_LIMIT - 1)) — set OPENLLM_DAEMON_PORT to choose one"
  fi
fi
case "$INSTALL_MODE" in
  install|update) ;;
  *) die "OPENLLM_INSTALL_MODE must be 'install' or 'update'" ;;
esac
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
# Checksum verification is mandatory — refuse rather than install unverified
# bytes.
if ! has_command shasum && ! has_command sha256sum; then
  die "shasum or sha256sum is required to verify the download"
fi

# Validate a supplied key before making the install directory or downloading either
# binary. Persisted values are deliberately read later, under the daemon's env-file
# lock: downloads can take long enough for the daemon or another installer to update
# the file in the meantime.
SUPPLIED_KEY="$(trim_whitespace "${OPENLLM_API_KEY:-}")"
SUPPLIED_ANCHOR=""
if [ -n "$SUPPLIED_KEY" ]; then
  has_line_break "$SUPPLIED_KEY" && die "OPENLLM_API_KEY must not contain a line break"
  # `sk-llm-<key>.<anchor>`: split on the LAST dot. The anchor never leaves this
  # machine — from here on SUPPLIED_KEY is the bare key, and the exported
  # OPENLLM_API_KEY every child process inherits is overwritten with it.
  if ! is_usable_api_key "$SUPPLIED_KEY"; then
    candidate_anchor="${SUPPLIED_KEY##*.}"
    candidate_key="${SUPPLIED_KEY%.*}"
    if is_usable_api_key "$candidate_key" && is_device_anchor "$candidate_anchor"; then
      SUPPLIED_ANCHOR="$candidate_anchor"
      SUPPLIED_KEY="$candidate_key"
    fi
    unset candidate_anchor candidate_key
  fi
  is_usable_api_key "$SUPPLIED_KEY" || die "OPENLLM_API_KEY has an invalid format"
  export OPENLLM_API_KEY="$SUPPLIED_KEY"
fi
API_KEY=""

mkdir -p "$BIN_DIR" "$(dirname "$ENV_FILE")"

# --- the ONE install entry point ------------------------------------------
# /api/install validates the committed daemon + CLI release pins in TypeScript
# (allow-listed repo, well-formed digests, a published tag for this target) and
# fails closed. Hitting it first means a mis-pinned or half-published release is
# refused BEFORE we download anything. No query parameters.
echo "Resolving the current OpenLLM release..."
MANIFEST="$(curl -fsSL "$ORIGIN/api/install" 2>/dev/null)" \
  || die "could not reach $ORIGIN/api/install — check OPENLLM_CLOUD_ORIGIN and your network"

# Extract one "key": "value" string field. The document is small, flat, and
# machine-generated by us, so a scoped sed is enough — no jq dependency on a
# fresh machine.
json_field() {
  printf '%s' "$MANIFEST" \
    | tr -d '\n' \
    | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

CLI_VERSION="$(json_field cli_version)"
[ -n "$CLI_VERSION" ] || die "no OpenLLM release is published yet"

# --- fetch + verify + install one component -------------------------------
# Bytes come from the per-component binary routes, which 302 to the pinned
# GitHub release asset and serve the committed digest as a `.sha256` sibling —
# the same pair the daemon's own self-update verifies against.
install_component() {
  local name="$1" route="$2" version="$3"
  local dest="$BIN_DIR/$name"
  local url="$ORIGIN/$route/$TARGET"
  local published installed stamp="$BIN_DIR/.$name.sha256.stamp"

  published="$(curl -fsSL "$url.sha256" 2>/dev/null | cut -d' ' -f1 || true)"
  case "$published" in
    [0-9a-f]*)
      [[ "$published" =~ ^[0-9a-f]{64}$ ]] || die "malformed checksum for $name"
      ;;
    *) die "no published checksum for $name ($TARGET) — nothing to install" ;;
  esac

  # Skip a tens-of-MB download when what's installed already matches.
  # Developer-ID-signed + notarized binaries keep their published digest on
  # disk (we no longer force ad-hoc re-sign when codesign --verify passes).
  # The stamp remains for the fallback ad-hoc path (unsigned/invalid) where
  # re-signing rewrites bytes after the published digest check.
  if [ -x "$dest" ]; then
    installed="$(sha256_of "$dest" || true)"
    if [ -n "$installed" ]; then
      if [ "$installed" = "$published" ]; then
        echo "  $name is already up to date"
        return 0
      fi
      if [ -f "$stamp" ]; then
        local sp si
        read -r sp si < "$stamp" || true
        if [ "$sp" = "$published" ] && [ "$si" = "$installed" ]; then
          echo "  $name is already up to date"
          return 0
        fi
      fi
    fi
  fi

  echo "Downloading $name ${version:+$version }($TARGET)..."
  # Stage inside $BIN_DIR: same filesystem as $dest (so the final mv is an
  # atomic rename, not a cross-device copy) and on the roomy root disk — minimal
  # cloud images mount a tiny RAM-backed /tmp where a download this size fails.
  local dl="$BIN_DIR/.$name.download.$$"
  local bin="$BIN_DIR/.$name.bin.$$"
  trap 'rm -f "$dl" "$bin"' RETURN
  if [ -t 2 ]; then
    curl -fL --progress-bar "$url" -o "$dl" || die "download failed: $url"
  else
    curl -fsSL "$url" -o "$dl" || die "download failed: $url"
  fi

  # Assets are gzipped; the pinned digest is over the DECOMPRESSED binary, so
  # the integrity gate is independent of gzip's non-determinism.
  if gzip -t "$dl" >/dev/null 2>&1; then
    gzip -dc "$dl" > "$bin" || die "could not decompress $name"
  else
    mv "$dl" "$bin"
  fi

  local actual
  actual="$(sha256_of "$bin")"
  [ -n "$actual" ] || die "could not hash the downloaded $name"
  if [ "$actual" != "$published" ]; then
    die "checksum mismatch for $name (expected $published, got $actual) — refusing to install"
  fi

  chmod 0755 "$bin"
  mv -f "$bin" "$dest"

  # macOS: strip quarantine. Preserve a valid Developer ID / notarized
  # signature (codesign --verify). Only ad-hoc sign when the signature is
  # missing/invalid — force ad-hoc would strip notarization and rewrite bytes.
  if [ "$OS" = "darwin" ]; then
    xattr -d com.apple.quarantine "$dest" >/dev/null 2>&1 || true
    if ! codesign --verify "$dest" >/dev/null 2>&1; then
      codesign --force --sign - "$dest" >/dev/null 2>&1 || true
      printf '%s %s\n' "$published" "$(sha256_of "$dest")" > "$stamp" 2>/dev/null || true
    fi
  fi
  echo "  $name installed → $dest"
  INSTALLED_COMPONENTS="$INSTALLED_COMPONENTS $name"
}

install_component openllm api/cli/binary "$CLI_VERSION"
# The pre-merge daemon name stays as a symlink: existing launchd/systemd units
# and scripts that exec `openllmd` keep working — the binary routes an
# `openllmd`-named invocation to its daemon half.
ln -sfn openllm "$BIN_DIR/openllmd"

# --- the shared config file ------------------------------------------------
# Re-read under the same exclusive `$ENV_FILE.lock` protocol as the daemon's
# writeEnvFileVars. Never rebuild this file from a pre-download snapshot: a daemon
# can mint a device id or update credentials while binaries are downloading.
# Delegates to `env_file_lookup` for the same last-match-wins, trim/skip
# semantics as `parseEnvLines` (packages/cli/daemon/src/env.ts) — the values read
# here (API key, device id, PTY flag) are exactly what that parser resolves
# on the daemon's own next boot.
read_env_value() {
  env_file_lookup "$1"
}

write_env_file() {
  local lock="$ENV_FILE.lock" attempt=0 acquired=0
  # `noclobber` opens with O_EXCL. This intentionally uses the daemon's lock-file
  # shape rather than flock, which is unavailable on some supported fresh installs.
  while [ "$attempt" -lt 500 ]; do
    if (set -C; : > "$lock") 2>/dev/null; then acquired=1; break; fi
    attempt=$((attempt + 1))
    sleep 0.01
  done
  [ "$acquired" = 1 ] || die "could not acquire config lock: $lock"

  local current_key current_device desired_key tmp line key
  current_key="$(trim_whitespace "$(read_env_value OPENLLM_API_KEY || true)")"
  current_device="$(read_env_value OPENLLM_DEVICE_ID || true)"
  if [ -n "$SUPPLIED_KEY" ]; then
    desired_key="$SUPPLIED_KEY"
  else
    desired_key="$current_key"
    if [ -n "$desired_key" ] && ! is_usable_api_key "$desired_key"; then
      echo "Ignoring the persisted API key because its format is invalid; OpenLLM will install without starting the daemon." >&2
      desired_key=""
    fi
  fi

  tmp="$ENV_FILE.tmp.$$"
  # Install the RETURN cleanup only after all nested reads have completed: Bash
  # runs a RETURN trap for nested functions too.
  trap 'rm -f "$tmp" "$lock"' RETURN
  # Tighten umask only for the temp-file creation window (closing the race
  # before `chmod 0600`), then restore it so later installer steps and child
  # processes keep the caller's umask.
  local saved_umask
  saved_umask="$(umask)"
  umask 077
  : > "$tmp"
  # Keep unrelated lines byte-for-byte, but replace every installer-owned key with
  # one canonical occurrence. An ignored invalid persisted key is therefore removed.
  local wrote_origin=0 wrote_port=0 wrote_key=0 wrote_device=0
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      key="${line%%=*}"
      case "$key" in
        OPENLLM_CLOUD_ORIGIN)
          [ "$wrote_origin" = 1 ] || { printf 'OPENLLM_CLOUD_ORIGIN=%s\n' "$ORIGIN" >> "$tmp"; wrote_origin=1; }
          ;;
        OPENLLM_DAEMON_PORT)
          [ "$wrote_port" = 1 ] || { printf 'OPENLLM_DAEMON_PORT=%s\n' "$DAEMON_PORT" >> "$tmp"; wrote_port=1; }
          ;;
        OPENLLM_API_KEY)
          if [ -n "$desired_key" ] && [ "$wrote_key" = 0 ]; then printf 'OPENLLM_API_KEY=%s\n' "$desired_key" >> "$tmp"; wrote_key=1; fi
          ;;
        OPENLLM_DEVICE_ID)
          if [ -n "$current_device" ] && [ "$wrote_device" = 0 ]; then printf 'OPENLLM_DEVICE_ID=%s\n' "$current_device" >> "$tmp"; wrote_device=1; fi
          ;;
        *) printf '%s\n' "$line" >> "$tmp" ;;
      esac
    done < "$ENV_FILE"
  fi
  [ "$wrote_origin" = 1 ] || printf 'OPENLLM_CLOUD_ORIGIN=%s\n' "$ORIGIN" >> "$tmp"
  [ "$wrote_port" = 1 ] || printf 'OPENLLM_DAEMON_PORT=%s\n' "$DAEMON_PORT" >> "$tmp"
  [ -z "$desired_key" ] || [ "$wrote_key" = 1 ] || printf 'OPENLLM_API_KEY=%s\n' "$desired_key" >> "$tmp"
  [ -z "$current_device" ] || [ "$wrote_device" = 1 ] || printf 'OPENLLM_DEVICE_ID=%s\n' "$current_device" >> "$tmp"
  chmod 0600 "$tmp"
  # Abort with a clear error if the atomic replace fails — never fall through to
  # announce success (or set API_KEY) on a config that was not written. The
  # RETURN trap still cleans up the temp file + lock.
  mv -f "$tmp" "$ENV_FILE" || die "could not write config file: $ENV_FILE"
  chmod 0600 "$ENV_FILE"
  umask "$saved_umask"
  rm -f "$lock"
  trap - RETURN
  API_KEY="$desired_key"
  echo "  gateway config written → $ENV_FILE"
}

write_env_file

# --- shell wiring ----------------------------------------------------------
# Delegated to the binaries themselves so the installer and a human run the
# SAME code path: `openllm setup` creates the openllm + ollm PATH symlinks,
# writes the one marked rc block (PATH + `alias ollm=openllm`), and installs
# completion for both names. Best-effort — a sandboxed or read-only environment
# leaves the binary usable by absolute path.
# First-install only: a manual update must not touch PATH symlinks, the shell
# rc block, or completion — those are the user's environment, already wired.
if [ "$INSTALL_MODE" != update ]; then
  # OPENLLM_SKIP_SHELL_SETUP — leave PATH symlinks, shell rc, and completion alone
  # (useful for CI / non-interactive hosts that already manage the environment).
  if [ -z "${OPENLLM_SKIP_SHELL_SETUP:-}" ]; then
    "$BIN_DIR/openllm" setup || echo "  note: run '$BIN_DIR/openllm setup' yourself to finish shell setup"
    "$BIN_DIR/openllm" daemon completion install >/dev/null 2>&1 || true
  fi
fi

# --- device trust anchor ---------------------------------------------------
# Pin the account device-control key from the anchor the dashboard put after
# the key — a local trust root, so the cloud never chooses it. The anchored key
# goes over stdin (never argv); the daemon prints only the bare key, discarded.
if [ -n "$SUPPLIED_ANCHOR" ]; then
  printf '%s.%s' "$SUPPLIED_KEY" "$SUPPLIED_ANCHOR" \
    | "$BIN_DIR/openllm" daemon anchor >/dev/null \
    || die "the device trust anchor was rejected — copy the install command from the dashboard again"
fi
SUPPLIED_ANCHOR=""
if [ "$LOCK_DEVICE_SESSIONS" = 1 ]; then
  "$BIN_DIR/openllm" daemon device lock >/dev/null \
    || die "could not lock remote device sessions"
fi

# --- start the service -----------------------------------------------------
# `openllm daemon start` owns service registration (launchd / systemd user unit,
# restart-on-crash, boot start, linger). With no persisted key the script never
# prompts inline — it either hands off to the gated `openllm start` on a
# controlling terminal (closing banner) or leaves no unpaired service behind.
reconcile_keyless_service() {
  # Older installers registered a daemon before the user had a usable key. Do
  # not merely skip `start` on upgrade: stop, disable, and remove that stale
  # registration so it cannot respawn later with an unpaired configuration.
  case "$OS" in
    darwin)
      local label="sh.openllm.daemon"
      local target="gui/${UID}/${label}"
      launchctl bootout "$target" >/dev/null 2>&1 || true
      launchctl disable "$target" >/dev/null 2>&1 || true
      rm -f "$HOME/Library/LaunchAgents/${label}.plist"
      ;;
    linux)
      systemctl --user disable --now openllmd.service >/dev/null 2>&1 || true
      rm -f "$HOME/.config/systemd/user/openllmd.service"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      ;;
  esac
}

if [ -n "$API_KEY" ]; then
  if [ "$INSTALL_MODE" = update ]; then
    # Only bounce the daemon when the binary actually changed. `restart` (and
    # even `start`) stop-then-start the running service, so an unconditional
    # restart would needlessly interrupt an already-current daemon on every
    # `openllm update` — the common no-op case. Credentials are already
    # persisted, so the restart never prompts.
    case " $INSTALLED_COMPONENTS " in
      *" openllm "*)
        echo "Restarting the daemon to pick up the new binary..."
        "$BIN_DIR/openllm" daemon restart || die "daemon restart failed — run '$BIN_DIR/openllm daemon status' to diagnose"
        ;;
      *)
        echo "  daemon already current — no restart needed"
        ;;
    esac
  else
    echo "Starting the daemon..."
    "$BIN_DIR/openllm" daemon start || die "daemon start failed — run '$BIN_DIR/openllm daemon status' to diagnose"
  fi
elif [ "$INSTALL_MODE" = update ]; then
  # Keyless update: converge binaries + config only. Never register/start an
  # unpaired daemon, and never tear down an existing service — that is a
  # first-install reconciliation, not an update action.
  echo "OpenLLM updated (no API key configured; daemon left as-is)."
else
  # Keyless first install: clear any stale unpaired registration now. The closing
  # banner then either runs the interactive credential gate (`openllm start` on a
  # controlling terminal) or prints the manual next step — see below.
  reconcile_keyless_service
fi

# --- provision the vendor subscription CLIs (background) -------------------
# The daemon RUNS the official vendor CLIs but never INSTALLS them (it runs
# under an OS sandbox that intentionally can't touch shell rc files). So THIS
# script — run by the user, unsandboxed, with a real HOME/PATH/rc — is where a
# missing CLI gets installed: fire-and-forget the official installer for each
# provider not already present. Each native installer does its own normal
# rc/PATH edit. The daemon only LINKS its isolated run-view to whatever lands
# (see cli-install.ts) — symlink self-heal is separate and needs no write grant
# on the host CLI dirs. Fully best-effort: guarded so a slow/failed vendor
# install never fails the daemon install, and logged to ~/.openllm/cli-install.log.
#
# Progress is tracked in per-provider JSON under
# `$OPENLLM_DIR/vendor-cli-install/<slug>.json` (protocol subscription slugs).
# Process identity / paths stay local; the daemon reader maps them to wire
# `cli_install` without PIDs or logs. Ownership locks are SEPARATE from
# `$ENV_FILE.lock` so installer concurrency never contends with config writes.
vendor_cli_now_ms() {
  # Bash 3.2 / macOS date has no %N — second resolution * 1000 is enough.
  # Inline arithmetic avoids a nested `$(date)` subshell on top of the caller's.
  local _secs
  _secs="$(date +%s)"
  echo $((_secs * 1000))
}

vendor_cli_json_escape() {
  # Values we emit are attempt ids / stages / ps lstart — keep escaping tight.
  # Pure parameter expansion (no sed fork) — hot path during progress writes.
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

vendor_cli_attempt_id() {
  # This id reaches the cloud; process identity belongs only in local fields.
  local _secs
  _secs="$(date +%s)"
  printf 'vci-%s-%s-%s-%s-%s' "$_secs" \
    "${RANDOM:-0}" "${RANDOM:-0}" "${RANDOM:-0}" "${RANDOM:-0}"
}

# Remove only the attempt-scoped handshake/pid pair passed in. Never a
# provider-wide path or glob — a completed worker must not wipe a newer attempt.
vendor_cli_cleanup_attempt_files() {
  local worker_pid_file="$1" handshake_file="$2"
  rm -f "$worker_pid_file" "$handshake_file" 2>/dev/null || true
}

vendor_cli_process_start() {
  local pid="$1" raw
  # Portable PID-reuse guard (same idea as daemon child-supervisor lstart).
  # Locale/TZ pinned: daemon processStartTime compares this from another env.
  raw="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null)" || return 0
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  printf '%s' "$raw"
}

vendor_cli_pid_live() {
  local pid="$1" expected_start="${2:-}" live_start
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -n "$expected_start" ]; then
    live_start="$(vendor_cli_process_start "$pid" || true)"
    [ -n "$live_start" ] || return 1
    [ "$live_start" = "$expected_start" ] || return 1
  fi
  return 0
}

# Cached once per process — every progress write used to re-printf + re-mkdir.
VENDOR_CLI_STATE_DIR=""
VENDOR_CLI_STATE_DIR_READY=0
vendor_cli_state_dir() {
  if [ -z "$VENDOR_CLI_STATE_DIR" ]; then
    VENDOR_CLI_STATE_DIR="$OPENLLM_DIR/vendor-cli-install"
  fi
  printf '%s' "$VENDOR_CLI_STATE_DIR"
}

vendor_cli_ensure_state_dir() {
  local dir
  dir="$(vendor_cli_state_dir)"
  if [ "$VENDOR_CLI_STATE_DIR_READY" = 1 ] && [ -d "$dir" ]; then
    printf '%s' "$dir"
    return 0
  fi
  mkdir -p "$dir" || return 1
  chmod 700 "$dir" 2>/dev/null || true
  VENDOR_CLI_STATE_DIR_READY=1
  printf '%s' "$dir"
}

# Atomic JSON replace for one provider. Returns nonzero on any write failure.
# Temp names use mktemp — NOT `$$` — because Bash 3.2 subshells share the
# parent's `$$`, so parent/worker handoff would clobber the same tmp path.
vendor_cli_write_state() {
  local slug="$1" json="$2"
  local dir tmp final saved_umask
  dir="$(vendor_cli_ensure_state_dir)" || return 1
  final="$dir/${slug}.json"
  saved_umask="$(umask)"
  umask 077
  tmp="$(mktemp "$dir/.${slug}.json.tmp.XXXXXX")" || {
    umask "$saved_umask"
    return 1
  }
  if ! printf '%s\n' "$json" >"$tmp"; then
    umask "$saved_umask"
    rm -f "$tmp"
    return 1
  fi
  # umask 077 already makes the tmp 0600 — skip an extra chmod fork.
  if ! mv -f "$tmp" "$final"; then
    umask "$saved_umask"
    rm -f "$tmp"
    return 1
  fi
  umask "$saved_umask"
  return 0
}

vendor_cli_read_field() {
  # Tiny key extractor — files are ours and bounded; no jq dependency.
  local file="$1" key="$2"
  [ -f "$file" ] || return 1
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

vendor_cli_read_num_field() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 1
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$file" | head -n 1
}

# True when an in-progress installer for this slug still owns a live worker.
vendor_cli_active_worker() {
  local slug="$1" file pid start stage
  file="$(vendor_cli_state_dir)/${slug}.json"
  [ -f "$file" ] || return 1
  stage="$(vendor_cli_read_field "$file" stage || true)"
  [ "$stage" = "installing" ] || return 1
  pid="$(vendor_cli_read_num_field "$file" pid || true)"
  start="$(vendor_cli_read_field "$file" process_start || true)"
  vendor_cli_pid_live "$pid" "$start"
}

# Per-provider launch lock via mkdir (atomic). Ownership is the `owner` file
# inside the lock dir (pid + lstart + token). Incomplete/missing owner is
# treated as INITIALIZING for a bounded mtime grace — never immediate reclaim
# (that stole locks while birth existed but owner was still unwritten). Stale
# reclaim takes an inner `reclaim/` mkdir sublock, re-validates owner+grace,
# then `mv`s the whole dir. release must match token.
VENDOR_CLI_LOCK_INIT_GRACE_SEC=45

vendor_cli_lock_dir() {
  printf '%s/%s.lock.d' "$(vendor_cli_state_dir)" "$1"
}

# Capture a single portable `stat` field without mixing Darwin/Linux stdout.
# GNU `stat -f %m` can print filesystem prose to stdout AND exit nonzero; a
# naive `stat -f … || stat -c …` then concatenates junk + epoch in one
# substitution. Try each form alone; accept only a pure positive integer.
vendor_cli_stat_uint() {
  local path="$1" darwin_fmt="$2" linux_fmt="$3" raw
  raw="$(stat -f "$darwin_fmt" "$path" 2>/dev/null)" && {
    raw="$(printf '%s' "$raw" | tr -d '[:space:]')"
    if [ -n "$raw" ] && [ "$raw" -gt 0 ] 2>/dev/null; then
      printf '%s' "$raw"
      return 0
    fi
  }
  raw="$(stat -c "$linux_fmt" "$path" 2>/dev/null)" && {
    raw="$(printf '%s' "$raw" | tr -d '[:space:]')"
    if [ -n "$raw" ] && [ "$raw" -gt 0 ] 2>/dev/null; then
      printf '%s' "$raw"
      return 0
    fi
  }
  return 1
}

# Fail-closed: unavailable/invalid mtime → age 0 (still in grace; never steal).
# (A literal mtime of 0 previously made age≈epoch and stole locks.)
vendor_cli_path_mtime_age_sec() {
  local path="$1" mtime now
  mtime="$(vendor_cli_stat_uint "$path" %m %Y || true)"
  if [ -z "$mtime" ] || ! [ "$mtime" -gt 0 ] 2>/dev/null; then
    echo 0
    return 0
  fi
  now="$(date +%s)"
  echo $((now - mtime))
}

# Prefer immutable birth time; a parent may die before writing it. Fall back
# to directory mtime, whose unavailable/invalid value still fails closed.
vendor_cli_lock_init_age_sec() {
  local lock="$1" created raw now
  created="$lock/created"
  if [ -f "$created" ]; then
    raw="$(head -n 1 "$created" 2>/dev/null || true)"
    raw="$(printf '%s' "$raw" | tr -d '[:space:]')"
    if [ -n "$raw" ] && [ "$raw" -gt 0 ] 2>/dev/null; then
      now="$(date +%s)"
      echo $((now - raw))
      return 0
    fi
  fi
  vendor_cli_path_mtime_age_sec "$lock"
}

# Portable inode identity; empty on failure (caller must not reclaim).
vendor_cli_lock_inode() {
  local path="$1"
  vendor_cli_stat_uint "$path" %i %i || true
}

# Drop an orphan `$lock/reclaim` left by a crashed reclaimer (mkdir succeeded,
# then SIGKILL before mv). Only when the reclaim dir itself is aged — never
# steal a live reclaimer's young sublock.
vendor_cli_clear_orphan_reclaim() {
  local lock="$1" reclaim_dir age
  reclaim_dir="$lock/reclaim"
  [ -d "$reclaim_dir" ] || return 0
  age="$(vendor_cli_path_mtime_age_sec "$reclaim_dir")"
  if [ "$age" -ge "$VENDOR_CLI_LOCK_INIT_GRACE_SEC" ]; then
    rm -rf "$reclaim_dir" 2>/dev/null || true
  fi
}

# True when owner file has pid + token (lstart may be empty on odd hosts).
vendor_cli_owner_complete() {
  local file="$1" pid token
  [ -f "$file" ] || return 1
  pid="$(head -n 1 "$file" 2>/dev/null || true)"
  token="$(sed -n '3p' "$file" 2>/dev/null || true)"
  [ -n "$pid" ] && [ -n "$token" ]
}

vendor_cli_acquire_lock() {
  local slug="$1" dir lock owner_file attempt=0
  local owner_pid owner_start reclaim age pre_age pre_inode post_inode
  local my_start my_token
  dir="$(vendor_cli_ensure_state_dir)" || return 1
  lock="$(vendor_cli_lock_dir "$slug")"
  owner_file="$lock/owner"
  my_start="$(vendor_cli_process_start "$$" || true)"
  my_token="$$.${RANDOM:-0}.$(vendor_cli_now_ms)"
  VENDOR_CLI_LOCK_TOKEN="$my_token"
  while [ "$attempt" -lt 400 ]; do
    if mkdir "$lock" 2>/dev/null; then
      # Immutable birth timestamp — reclaim/child ops must not reset init age.
      if ! printf '%s\n' "$(date +%s)" >"$lock/created"; then
        rm -rf "$lock" 2>/dev/null || true
        VENDOR_CLI_LOCK_TOKEN=""
        return 1
      fi
      if ! {
        printf '%s\n' "$$"
        printf '%s\n' "$my_start"
        printf '%s\n' "$my_token"
      } >"$owner_file"; then
        rm -rf "$lock" 2>/dev/null || true
        VENDOR_CLI_LOCK_TOKEN=""
        return 1
      fi
      # Failed owner write must not report success — re-read our token.
      if [ "$(sed -n '3p' "$owner_file" 2>/dev/null || true)" != "$my_token" ]; then
        rm -rf "$lock" 2>/dev/null || true
        VENDOR_CLI_LOCK_TOKEN=""
        return 1
      fi
      return 0
    fi

    # Contended. Live complete owner → give up (do not steal).
    if vendor_cli_owner_complete "$owner_file"; then
      owner_pid="$(head -n 1 "$owner_file" 2>/dev/null || true)"
      owner_start="$(sed -n '2p' "$owner_file" 2>/dev/null || true)"
      if vendor_cli_pid_live "$owner_pid" "$owner_start"; then
        VENDOR_CLI_LOCK_TOKEN=""
        return 1
      fi
    else
      # Missing/partial owner: INITIALIZING while birth age is young.
      age="$(vendor_cli_lock_init_age_sec "$lock")"
      if [ "$age" -lt "$VENDOR_CLI_LOCK_INIT_GRACE_SEC" ]; then
        attempt=$((attempt + 1))
        sleep 0.05
        continue
      fi
    fi

    # Clear aged orphan reclaim sublock (crashed reclaimer) before retrying.
    vendor_cli_clear_orphan_reclaim "$lock"

    # Snapshot birth-age + inode BEFORE mkdir reclaim (dir mtime may refresh).
    pre_age="$(vendor_cli_lock_init_age_sec "$lock")"
    pre_inode="$(vendor_cli_lock_inode "$lock")"
    if [ -z "$pre_inode" ]; then
      attempt=$((attempt + 1))
      sleep 0.05
      continue
    fi
    if ! vendor_cli_owner_complete "$owner_file"; then
      if [ "$pre_age" -lt "$VENDOR_CLI_LOCK_INIT_GRACE_SEC" ]; then
        attempt=$((attempt + 1))
        sleep 0.05
        continue
      fi
    fi

    # Inner reclaim sublock. If this lands in a replacement dir, inode check aborts.
    if ! mkdir "$lock/reclaim" 2>/dev/null; then
      vendor_cli_clear_orphan_reclaim "$lock"
      attempt=$((attempt + 1))
      sleep 0.05
      continue
    fi

    post_inode="$(vendor_cli_lock_inode "$lock")"
    if [ -z "$post_inode" ] || [ "$post_inode" != "$pre_inode" ]; then
      rmdir "$lock/reclaim" 2>/dev/null || true
      attempt=$((attempt + 1))
      sleep 0.02
      continue
    fi

    # Re-validate owner liveness; use PRE-reclaim birth age for incomplete grace.
    if vendor_cli_owner_complete "$owner_file"; then
      owner_pid="$(head -n 1 "$owner_file" 2>/dev/null || true)"
      owner_start="$(sed -n '2p' "$owner_file" 2>/dev/null || true)"
      if vendor_cli_pid_live "$owner_pid" "$owner_start"; then
        rmdir "$lock/reclaim" 2>/dev/null || true
        VENDOR_CLI_LOCK_TOKEN=""
        return 1
      fi
    elif [ "$pre_age" -lt "$VENDOR_CLI_LOCK_INIT_GRACE_SEC" ]; then
      rmdir "$lock/reclaim" 2>/dev/null || true
      attempt=$((attempt + 1))
      sleep 0.05
      continue
    fi

    reclaim="${lock}.stale.$$.${RANDOM:-0}"
    if mv "$lock" "$reclaim" 2>/dev/null; then
      rm -rf "$reclaim" 2>/dev/null || true
    else
      rmdir "$lock/reclaim" 2>/dev/null || true
    fi
    attempt=$((attempt + 1))
    sleep 0.02
  done
  VENDOR_CLI_LOCK_TOKEN=""
  return 1
}

vendor_cli_release_lock() {
  local slug="$1" lock owner_file token
  lock="$(vendor_cli_lock_dir "$slug")"
  owner_file="$lock/owner"
  token="${VENDOR_CLI_LOCK_TOKEN:-}"
  VENDOR_CLI_LOCK_TOKEN=""
  [ -n "$token" ] || return 0
  [ -d "$lock" ] || return 0
  # Only the acquiring token may remove the lock — never an unconditional unlink.
  if [ "$(sed -n '3p' "$owner_file" 2>/dev/null || true)" = "$token" ]; then
    rm -rf "$lock" 2>/dev/null || true
  fi
}

vendor_cli_build_json() {
  local attempt_id="$1" provider="$2" stage="$3" started="$4" updated="$5"
  local reason="${6:-}" pid="${7:-}" process_start="${8:-}" exit_code="${9:-}"
  local esc_attempt esc_provider esc_stage esc_reason esc_start
  esc_attempt="$(vendor_cli_json_escape "$attempt_id")"
  esc_provider="$(vendor_cli_json_escape "$provider")"
  esc_stage="$(vendor_cli_json_escape "$stage")"
  printf '{'
  printf '"attempt_id":"%s","provider":"%s","stage":"%s","started_at_ms":%s,"updated_at_ms":%s' \
    "$esc_attempt" "$esc_provider" "$esc_stage" "$started" "$updated"
  if [ -n "$reason" ]; then
    esc_reason="$(vendor_cli_json_escape "$reason")"
    printf ',"reason":"%s"' "$esc_reason"
  fi
  if [ -n "$pid" ]; then
    printf ',"pid":%s' "$pid"
  fi
  if [ -n "$process_start" ]; then
    esc_start="$(vendor_cli_json_escape "$process_start")"
    printf ',"process_start":"%s"' "$esc_start"
  fi
  if [ -n "$exit_code" ]; then
    printf ',"exit_code":%s' "$exit_code"
  fi
  printf '}'
}

# List direct children of a pid (macOS + Linux). Bash 3.2 portable.
vendor_cli_children() {
  local root="$1"
  # `ps -axo` works on Darwin; `-eo` on Linux. Prefer axo, fall back.
  (ps -axo pid=,ppid= 2>/dev/null || ps -eo pid=,ppid= 2>/dev/null || true) \
    | while read -r pid ppid; do
        pid="$(printf '%s' "$pid" | tr -d '[:space:]')"
        ppid="$(printf '%s' "$ppid" | tr -d '[:space:]')"
        [ "$ppid" = "$root" ] && [ -n "$pid" ] && printf '%s\n' "$pid"
      done
}

# Recursively TERM/KILL a process tree (children first, then root).
vendor_cli_stop_tree() {
  local root="$1" sig="${2:-TERM}" kid
  [ -n "$root" ] || return 0
  for kid in $(vendor_cli_children "$root"); do
    vendor_cli_stop_tree "$kid" "$sig"
  done
  kill "-$sig" "$root" 2>/dev/null || true
}

vendor_cli_reap_tree() {
  local root="$1" i
  [ -n "$root" ] || return 0
  vendor_cli_stop_tree "$root" TERM
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$root" 2>/dev/null || return 0
    sleep 0.05
  done
  vendor_cli_stop_tree "$root" KILL
  for i in 1 2 3 4 5; do
    kill -0 "$root" 2>/dev/null || return 0
    sleep 0.05
  done
}

# Args: display, command, slug, dest launcher, installer URL, run PATH, curl,
# and an OPTIONAL installer function. With the function set, the tracked worker
# runs `<fn> <curl> <url>` in a subshell instead of `curl <url> | bash` — every
# other step (lock, reservation, handshake, progress JSON, signal reaping) is
# shared, so a non-script vendor install is tracked exactly like the others.
launch_vendor_cli_install() {
  local name="$1" cmd="$2" slug="$3" dest="$4" url="$5" run_path="$6" curl_bin="$7"
  local installer_fn="${8:-}"
  local attempt_id started json worker_pid worker_start file
  local worker_pid_file handshake_file

  if ! vendor_cli_acquire_lock "$slug"; then
    echo "  $name CLI: installer already running — skipping duplicate."
    echo "$name CLI: duplicate launch skipped (live lock)." \
      >>"$OPENLLM_DIR/cli-install.log" 2>/dev/null || true
    return 0
  fi

  if vendor_cli_active_worker "$slug"; then
    echo "  $name CLI: installer already running — skipping duplicate."
    echo "$name CLI: duplicate launch skipped (live worker)." \
      >>"$OPENLLM_DIR/cli-install.log" 2>/dev/null || true
    vendor_cli_release_lock "$slug"
    return 0
  fi

  # A previous installing record whose worker is dead: mark interrupted before
  # starting a replacement so the UI never keeps a zombie "installing".
  file="$(vendor_cli_state_dir)/${slug}.json"
  if [ -f "$file" ]; then
    local prev_stage prev_attempt prev_started
    prev_stage="$(vendor_cli_read_field "$file" stage || true)"
    if [ "$prev_stage" = "installing" ]; then
      prev_attempt="$(vendor_cli_read_field "$file" attempt_id || true)"
      prev_started="$(vendor_cli_read_num_field "$file" started_at_ms || true)"
      if [ -n "$prev_attempt" ] && [ -n "$prev_started" ]; then
        json="$(vendor_cli_build_json "$prev_attempt" "$slug" interrupted "$prev_started" "$(vendor_cli_now_ms)" interrupted)"
        vendor_cli_write_state "$slug" "$json" || true
      fi
    fi
  fi

  attempt_id="$(vendor_cli_attempt_id)"
  started="$(vendor_cli_now_ms)"
  # Reserve BEFORE launch (no pid yet). A write failure must not start work.
  json="$(vendor_cli_build_json "$attempt_id" "$slug" installing "$started" "$started")"
  if ! vendor_cli_write_state "$slug" "$json"; then
    echo "  $name CLI: could not track install — skipping to avoid untracked work." >&2
    echo "$name CLI: state write failed before launch — skipped." \
      >>"$OPENLLM_DIR/cli-install.log" 2>/dev/null || true
    vendor_cli_release_lock "$slug"
    return 0
  fi

  echo "  $name CLI: installing in the background…"
  # Handshake/pid files are attempt-scoped. A completed older worker must not
  # `rm` a newer attempt's handshake (provider-only paths caused that race).
  worker_pid_file="$(vendor_cli_state_dir)/.${slug}.${attempt_id}.worker_pid"
  handshake_file="$(vendor_cli_state_dir)/.${slug}.${attempt_id}.handshake"
  vendor_cli_cleanup_attempt_files "$worker_pid_file" "$handshake_file"
  # Capture the launching shell's pid for the worker's parent-liveness guard
  # (Bash 3.2: `$$` inside `( )&` is still this value — pass it explicitly).
  local launcher_pid=$$
  (
    # Background worker: parent may exit; this job continues and owns terminal
    # state transitions. pipefail so a nonzero curl fails the pipeline.
    set -euo pipefail
    my_pid=""
    # Bounded wall deadline (~10s), not a fixed short iteration count — slow
    # parent `ps`/JSON write under load must still complete the handshake.
    _hs_deadline=$(($(date +%s) + 10))
    while [ "$(date +%s)" -lt "$_hs_deadline" ]; do
      if [ -f "$handshake_file" ] && [ -f "$worker_pid_file" ]; then
        my_pid="$(head -n 1 "$worker_pid_file" 2>/dev/null || true)"
        [ -n "$my_pid" ] && break
      fi
      # Abort early only when the launcher is gone AND handshake never arrived.
      # If handshake already landed, a later parent exit is fine.
      if [ -z "$my_pid" ] && ! kill -0 "$launcher_pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if [ -z "$my_pid" ]; then
      # No handshake — parent failed or died. Do NOT run the vendor installer
      # untracked, and do NOT invent a PPID identity.
      echo "$name CLI: missing handshake — worker exiting without vendor start." >&2
      exit 1
    fi
    my_start="$(vendor_cli_process_start "$my_pid" || true)"
    child_pid=""
    write_progress() {
      local stage="$1" reason="${2:-}" exit_code="${3:-}"
      local now payload
      now="$(vendor_cli_now_ms)"
      payload="$(vendor_cli_build_json "$attempt_id" "$slug" "$stage" "$started" "$now" "$reason" "$my_pid" "$my_start" "$exit_code")"
      vendor_cli_write_state "$slug" "$payload" || true
    }
    on_signal() {
      # Stop installer descendants BEFORE claiming interrupted / exiting, so a
      # duplicate launcher cannot observe "stopped" while curl|bash still runs.
      # Do NOT reap my_pid here — that would kill this trap before write_progress.
      if [ -n "${child_pid:-}" ]; then
        vendor_cli_reap_tree "$child_pid"
      else
        # Fallback: any children of this worker subshell (bash 3.2: use handshake pid).
        for _kid in $(vendor_cli_children "$my_pid"); do
          vendor_cli_reap_tree "$_kid"
        done
      fi
      write_progress interrupted interrupted
      vendor_cli_cleanup_attempt_files "$worker_pid_file" "$handshake_file"
      exit 130
    }
    trap on_signal HUP INT TERM
    set +e
    # Single waitable child wrapping the pipeline so signal cleanup has a root.
    if [ -n "$installer_fn" ]; then
      (
        set -euo pipefail
        PATH="$run_path"
        "$installer_fn" "$curl_bin" "$url"
      ) &
    else
      PATH="$run_path" bash -c '
        set -euo pipefail
        PATH="$1" "$2" -fsSL "$3" | PATH="$1" bash
      ' bash "$run_path" "$curl_bin" "$url" &
    fi
    child_pid=$!
    wait "$child_pid"
    rc=$?
    set -e
    trap - HUP INT TERM
    if [ "$rc" -eq 0 ]; then
      write_progress awaiting_detection
    elif [ "$rc" -ge 128 ]; then
      write_progress interrupted interrupted "$rc"
    else
      write_progress failed installer_failed "$rc"
    fi
    vendor_cli_cleanup_attempt_files "$worker_pid_file" "$handshake_file"
  ) >>"$OPENLLM_DIR/cli-install.log" 2>&1 &
  worker_pid=$!

  # Parent: persist pid-bearing installing JSON FIRST, then publish handshake.
  # Never handshake before JSON — a fast worker must not finish, then get
  # overwritten back to installing by a late parent write.
  worker_start="$(vendor_cli_process_start "$worker_pid" || true)"
  json="$(vendor_cli_build_json "$attempt_id" "$slug" installing "$started" "$(vendor_cli_now_ms)" "" "$worker_pid" "$worker_start")"
  if ! vendor_cli_write_state "$slug" "$json"; then
    echo "  $name CLI: lost track after launch — stopping untracked worker." >&2
    vendor_cli_reap_tree "$worker_pid"
    json="$(vendor_cli_build_json "$attempt_id" "$slug" interrupted "$started" "$(vendor_cli_now_ms)" interrupted)"
    vendor_cli_write_state "$slug" "$json" || true
    vendor_cli_cleanup_attempt_files "$worker_pid_file" "$handshake_file"
    vendor_cli_release_lock "$slug"
    return 0
  fi
  printf '%s\n' "$worker_pid" >"$worker_pid_file" || {
    vendor_cli_reap_tree "$worker_pid"
    json="$(vendor_cli_build_json "$attempt_id" "$slug" interrupted "$started" "$(vendor_cli_now_ms)" interrupted)"
    vendor_cli_write_state "$slug" "$json" || true
    vendor_cli_release_lock "$slug"
    return 0
  }
  # Handshake last — worker may proceed to curl only after this exists.
  : >"$handshake_file" || {
    vendor_cli_reap_tree "$worker_pid"
    json="$(vendor_cli_build_json "$attempt_id" "$slug" interrupted "$started" "$(vendor_cli_now_ms)" interrupted)"
    vendor_cli_write_state "$slug" "$json" || true
    vendor_cli_cleanup_attempt_files "$worker_pid_file" "$handshake_file"
    vendor_cli_release_lock "$slug"
    return 0
  }
  vendor_cli_release_lock "$slug"
}

# ── Google Antigravity (official ACP agent, latest release) ─────────────────
# Google ships no install script for `agy_acp_server`. The ACP registry's
# `antigravity-acp/agent.json` (main branch) names the current version and a
# per-platform zip on dl.google.com; we resolve it at install time so every
# install gets the latest release. The registry publishes no hashes, so
# integrity is HTTPS from dl.google.com (enforced) + a structural check (the
# zip must hold the agent and its harness); the daemon additionally checks the
# agent identifies as `antigravity-acp` before use. The release unpacks into a
# version dir; `current` points at the active one, and the daemon's host
# candidate is `current/agy_acp_server.par` (packages/cli/daemon/src/cli-paths.ts).
ANTIGRAVITY_DIR="$OPENLLM_DIR/vendor/antigravity"
ANTIGRAVITY_EXE="agy_acp_server.par"
ANTIGRAVITY_HARNESS="localharness_external"
ANTIGRAVITY_REGISTRY_URL="https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json"
# Free space needed: archive + unpacked agent (~1.4 GB on Linux).
ANTIGRAVITY_SPACE_NEED_KB=1572864

# Registry platform key for this host, or nothing when unsupported (Windows is
# not a daemon target; Intel macOS ships but is untested).
antigravity_platform_key() {
  case "$(uname -s 2>/dev/null)/$(uname -m 2>/dev/null)" in
    Darwin/arm64) echo darwin-aarch64 ;;
    Darwin/x86_64) echo darwin-x86_64 ;;
    Linux/x86_64|Linux/amd64) echo linux-x86_64 ;;
    Linux/aarch64|Linux/arm64) echo linux-aarch64 ;;
    *) ;;
  esac
}

# Prints `version|url` for this platform from registry JSON on stdin. Plain
# text scan (no jq dependency): the archive URL embeds both the platform's
# release-file suffix and the version, so we match the URL itself.
antigravity_parse_registry() {
  local key="$1" json suffix url version
  json="$(cat)"
  case "$key" in
    darwin-aarch64) suffix="darwin-arm64" ;;
    darwin-x86_64) suffix="darwin-x86_64" ;;
    linux-x86_64) suffix="linux-x86_64" ;;
    linux-aarch64) suffix="linux-arm64" ;;
    *) return 1 ;;
  esac
  url="$(printf '%s' "$json" | grep -oE "https://dl\.google\.com/agy-extensions/releases/[a-z]+/agy-acp-server-[0-9]+\.[0-9]+\.[0-9]+-${suffix}\.zip" | head -n 1)"
  [ -n "$url" ] || return 1
  version="$(printf '%s' "$url" | sed -E 's/.*agy-acp-server-([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/')"
  echo "$version|$url"
}

# Worker body (runs inside launch_vendor_cli_install's tracked subshell):
#   install_antigravity_release <curl> <registry-url>
# Any failure exits nonzero → the tracker records failed/installer_failed. The
# active pointer flips only after the checked pair + completion marker exist,
# so an interrupted install never leaves `current` at a half-written version.
install_antigravity_release() {
  local curl_bin="$1" registry="$2" key resolved version url
  key="$(antigravity_platform_key)"
  [ -n "$key" ] || { echo "Antigravity: unsupported platform." >&2; return 3; }
  resolved="$("$curl_bin" -fsSL --retry 2 "$registry" | antigravity_parse_registry "$key")" \
    || { echo "Antigravity: could not resolve the latest release." >&2; return 3; }
  IFS='|' read -r version url <<<"$resolved"
  case "$url" in
    https://dl.google.com/*) ;;
    *) echo "Antigravity: refusing non-Google download URL." >&2; return 3 ;;
  esac

  local versions="$ANTIGRAVITY_DIR/versions"
  local final="$versions/$version"
  mkdir -p "$versions" || return 6
  if [ -f "$final/.install-complete" ] && [ -x "$final/$ANTIGRAVITY_EXE" ] \
    && [ -x "$final/$ANTIGRAVITY_HARNESS" ]; then
    ln -sfn "versions/$version" "$ANTIGRAVITY_DIR/current" || return 6
    echo "Antigravity: release $version already unpacked — activated."
    return 0
  fi

  local avail_kb
  avail_kb="$(df -Pk "$versions" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  case "$avail_kb" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$avail_kb" -lt "$ANTIGRAVITY_SPACE_NEED_KB" ]; then
        echo "Antigravity: not enough disk space (need ${ANTIGRAVITY_SPACE_NEED_KB}KB, have ${avail_kb}KB)." >&2
        return 4
      fi
      ;;
  esac

  local staging rc=0
  staging="$(mktemp -d "$versions/.staging.XXXXXX")" || return 6
  [ -n "$staging" ] && [ -d "$staging" ] || return 6
  # Staging lives beside the target so the final `mv` is a same-filesystem
  # rename. The body runs in a subshell so staging is removed on every exit
  # path. It sits in a `|| rc=$?` context, where bash IGNORES `set -e`, so every
  # side-effecting step checks itself and exits nonzero — `current` only flips
  # after a complete, checked version is in place.
  (
    "$curl_bin" -fsSL --proto '=https' --retry 2 -o "$staging/download.zip" "$url" \
      || { echo "Antigravity: download failed." >&2; exit 6; }
    mkdir -p "$staging/runtime" || exit 6
    # Extract ONLY the two expected members — never anything else the archive holds.
    unzip -q -o "$staging/download.zip" "$ANTIGRAVITY_EXE" "$ANTIGRAVITY_HARNESS" \
      -d "$staging/runtime" \
      || { echo "Antigravity: could not unpack the release." >&2; exit 6; }
    for f in "$ANTIGRAVITY_EXE" "$ANTIGRAVITY_HARNESS"; do
      if [ ! -f "$staging/runtime/$f" ] || [ -L "$staging/runtime/$f" ]; then
        echo "Antigravity: archive is missing the agent or its harness." >&2
        exit 5
      fi
    done
    chmod 755 "$staging/runtime/$ANTIGRAVITY_EXE" "$staging/runtime/$ANTIGRAVITY_HARNESS" || exit 6
    printf '{"version":"%s"}\n' "$version" >"$staging/runtime/.install-complete" || exit 6
    rm -rf "$final" || exit 6
    mv "$staging/runtime" "$final" || exit 6
    ln -sfn "versions/$version" "$ANTIGRAVITY_DIR/current" || exit 6
  ) || rc=$?
  rm -rf "$staging"
  [ "$rc" -eq 0 ] || return "$rc"
  echo "Antigravity: installed release $version."
}

# Launch the tracked Antigravity install when this host can take it. Skips
# (with no progress record — nothing was started) on an unsupported platform
# or a host without `unzip`.
# OPENLLM_ONLY_VENDOR_CLIS — comma-separated subscription slugs to provision
# (e.g. claude_code,chatgpt). Unset/empty selects every vendor.
vendor_cli_selected() {
  [ -z "${OPENLLM_ONLY_VENDOR_CLIS:-}" ] && return 0
  case ",${OPENLLM_ONLY_VENDOR_CLIS}," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

provision_antigravity() {
  local run_path="$1" curl_bin="$2"
  local name="Google Antigravity" dest="$ANTIGRAVITY_DIR/current/$ANTIGRAVITY_EXE"
  if [ -x "$dest" ] && [ -x "$ANTIGRAVITY_DIR/current/$ANTIGRAVITY_HARNESS" ]; then
    echo "  $name agent: already installed."
    echo "$name agent: already installed ($dest) — skipping install." \
      >>"$OPENLLM_DIR/cli-install.log" 2>/dev/null || true
    return 0
  fi
  if [ -z "$(antigravity_platform_key)" ]; then
    echo "  $name agent: no supported release for this platform — skipping."
    return 0
  fi
  if ! PATH="$run_path" command -v unzip >/dev/null 2>&1; then
    echo "  $name agent: unzip not found — skipping (install unzip, then rerun the installer)."
    return 0
  fi
  launch_vendor_cli_install "$name" "$ANTIGRAVITY_EXE" antigravity "$dest" \
    "$ANTIGRAVITY_REGISTRY_URL" "$run_path" "$curl_bin" install_antigravity_release
}

provision_clis() {
  # display | command | protocol slug | dest launcher | official installer URL.
  # Dest launchers match VENDOR-DEFAULT `hostCliCandidates` in
  # packages/cli/daemon/src/cli-paths.ts; URLs match `VENDOR_CLI_INSTALL_CMD` in
  # lib/hooks/use-daemon.ts + `installHint` in packages/cli/src/clients/registry.ts.
  # Slugs are the protocol SubscriptionProviderSlug literals.
  local specs=(
    "Claude Code|claude|claude_code|$HOME/.local/bin/claude|https://claude.ai/install.sh"
    "Codex|codex|chatgpt|$HOME/.local/bin/codex|https://chatgpt.com/codex/install.sh"
    "Kimi|kimi|kimi_code|$HOME/.kimi-code/bin/kimi|https://code.kimi.com/kimi-code/install.sh"
    "Grok|grok|grok|$HOME/.grok/bin/grok|https://x.ai/cli/install.sh"
    # ⚠️ RESEARCH-UNVERIFIED: Cursor's official installer/launcher path.
    "Cursor Agent|cursor-agent|cursor|$HOME/.local/bin/cursor-agent|https://cursor.com/install"
    # Official Muse Code installer (https://dev.meta.ai/docs/muse-code/).
    "Muse Code|muse|muse|$HOME/.local/bin/muse|https://dev.meta.ai/install.sh"
  )
  # Build a PATH that (a) puts the STANDARD system dirs FIRST — covering
  # curl/bash/tar/gzip/uname/sed/grep on macOS AND Linux (all live in
  # /usr/bin + /bin on both) plus Homebrew — so a real `curl` always wins over
  # any shim the OUTER process prepended, and (b) APPENDS the caller's own
  # PATH so Homebrew/nix/snap tools a vendor installer needs stay reachable.
  # The backgrounded jobs outlive this script, so they must not depend on the
  # outer PATH: the dev dist-installer prepends an ephemeral `curl` shim it
  # deletes on exit, and a bare `curl` in a detached job would then resolve to
  # nothing (or a coreutils multicall). Resolving curl absolutely + running the
  # job under this PATH makes the primitive robust on every major platform.
  local sys_path="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:/opt/homebrew/bin"
  local run_path="${sys_path}:${PATH:-}"
  local curl_bin
  curl_bin="$(PATH="$run_path" command -v curl 2>/dev/null || true)"
  # Fallback: probe the canonical absolute locations directly (a pathological
  # PATH or a shell without a working `command -v` still resolves here).
  if [ -z "$curl_bin" ]; then
    local c
    for c in /usr/bin/curl /bin/curl /usr/local/bin/curl /opt/homebrew/bin/curl; do
      [ -x "$c" ] && { curl_bin="$c"; break; }
    done
  fi
  if [ -z "$curl_bin" ]; then
    echo "  Vendor CLIs: curl not found — install them by hand from their official installers." >&2
    return 0
  fi
  local spec name cmd slug dest url
  for spec in "${specs[@]}"; do
    IFS='|' read -r name cmd slug dest url <<<"$spec"
    vendor_cli_selected "$slug" || continue
    if has_command "$cmd" || [ -x "$dest" ]; then
      echo "  $name CLI: already installed."
      # Mirror the skip into the log too — previously only the backgrounded
      # installer output landed there, so a skipped provider left the log
      # silent about why nothing was installed. No progress record is written
      # for an already-present binary (do not invent a finished job).
      echo "$name CLI: already installed ($(command -v "$cmd" 2>/dev/null || echo "$dest")) — skipping install." \
        >>"$OPENLLM_DIR/cli-install.log" 2>/dev/null || true
      continue
    fi
    launch_vendor_cli_install "$name" "$cmd" "$slug" "$dest" "$url" "$run_path" "$curl_bin" || true
  done
  # Antigravity is behind a kill switch (off by default — not yet reliable).
  # `OPENLLM_ANTIGRAVITY=1` opts in and writes the marker the daemon reads
  # (packages/cli/daemon/src/antigravity-feature.ts); `=0` opts back out.
  case "${OPENLLM_ANTIGRAVITY:-}" in
    1) touch "$OPENLLM_DIR/antigravity-enabled" 2>/dev/null || true ;;
    0) rm -f "$OPENLLM_DIR/antigravity-enabled" 2>/dev/null || true ;;
  esac
  if [ -f "$OPENLLM_DIR/antigravity-enabled" ] && vendor_cli_selected antigravity; then
    provision_antigravity "$run_path" "$curl_bin" || true
  fi
}
# `|| true` + the subshell/background jobs keep this off the `set -euo
# pipefail` path — a vendor install can never abort the daemon install.
# Background jobs outlive this script. Skipped on a manual update: rerunning
# every vendor's installer is a first-install action the user didn't ask for.
if [ "$INSTALL_MODE" != update ]; then
  # OPENLLM_SKIP_VENDOR_CLIS — install only the openllm binary; skip background
  # vendor CLI downloads (claude / codex / kimi / grok / cursor-agent / muse).
  if [ -z "${OPENLLM_SKIP_VENDOR_CLIS:-}" ]; then
    provision_clis || true
  fi
fi

if [ "$INSTALL_MODE" = update ]; then
  # A manual update did no shell wiring or vendor provisioning — keep the closing
  # note to what actually happened.
  cat <<EOF

OpenLLM is up to date.

  openllm status           daemon service + run state
  openllm --help           everything else
EOF
else
  cat <<EOF

OpenLLM is installed.

  openllm status           daemon service + run state
  openllm claude           run Claude Code through OpenLLM
  ollm codex               (short alias) run Codex through OpenLLM
  openllm --help           everything else

Open a new shell (or source your rc) so \`openllm\` and \`ollm\` are on PATH.
Any missing vendor CLIs are installing in the background
(see ~/.openllm/cli-install.log). Open the dashboard's Providers tab to
connect each vendor once its CLI is ready.
EOF
  if [ -z "$API_KEY" ]; then
    if has_controlling_tty && [ -x "$BIN_DIR/openllm" ]; then
      # Single-step onboarding: hand straight to the gated `openllm start` instead
      # of asking the user to run a second command. Its credential gate prints the
      # sign-in guidance, reads the key hidden from /dev/tty, validates the format
      # (reprompting on a bad paste), persists it, then registers + starts the
      # service. We bind the child's stdin to /dev/tty so the gate sees an
      # interactive terminal even though this script's own stdin is the curl pipe.
      #
      # A cancel (Ctrl-C / empty paste) or any nonzero exit must NOT fail the
      # install — the binaries and config are already in place; we just point the
      # user back at the start command. `set -e` is suppressed by the `if`.
      echo
      if ! "$BIN_DIR/openllm" start < /dev/tty; then
        # `openllm start` already printed the specific reason to the terminal
        # (key cancelled, save failed, or a service-registration error). Do NOT
        # re-attribute every nonzero exit to a missing key — the failure may be
        # operational. Stay cause-neutral and point back at the one command that
        # finishes setup.
        cat <<EOF

The daemon isn't running yet. Finish setup any time with: openllm start
(If you still need an API key, sign in at $ORIGIN/sign-in.)
EOF
      fi
    else
      cat <<EOF

OpenLLM needs an API key before it can start.
Sign in at $ORIGIN/sign-in.
New users will receive a key during onboarding. Already have an account? Open Keys after signing in.
Then run: openllm start
EOF
    fi
  fi
fi
