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
# Publish-time tag binding: the release pipeline stamps the ONE literal below
# into the published copy of this script before it serves a prerelease tag.
# It is a fixed per-invocation assignment, NOT an environment default.
OPENLLM_PRERELEASE_TAG='v2.8.0-beta.4'
PRERELEASE_OPT=""
PRERELEASE_SEEN=0
LOCAL_FILE_SEEN=0
usage() {
  cat <<'USAGE'
Usage: install.sh [options]
  --from-file <path>   install the openllm CLI binary from a local file
  --sha256 <hex>       sha256 digest of the --from-file file (required with it)
  --prerelease <tag>   install the published prerelease tag (vX.Y.Z-label.N)
  -h, --help           show this text
USAGE
}
while [ $# -gt 0 ]; do
  case "$1" in
    --from-file)
      LOCAL_FILE_SEEN=1
      FROM_FILE="${2:-}"
      [ -n "$FROM_FILE" ] || die "--from-file needs a path"
      shift 2
      ;;
    --from-file=*) LOCAL_FILE_SEEN=1; FROM_FILE="${1#*=}"; shift ;;
    --sha256)
      LOCAL_FILE_SEEN=1
      FROM_SHA="${2:-}"
      [ -n "$FROM_SHA" ] || die "--sha256 needs a hex digest"
      shift 2
      ;;
    --sha256=*) LOCAL_FILE_SEEN=1; FROM_SHA="${1#*=}"; shift ;;
    --prerelease)
      [ "$PRERELEASE_SEEN" = 0 ] || die "--prerelease must not be repeated"
      PRERELEASE_SEEN=1
      PRERELEASE_OPT="${2:-}"
      [ -n "$PRERELEASE_OPT" ] || die "--prerelease needs a tag"
      shift 2
      ;;
    --prerelease=*)
      [ "$PRERELEASE_SEEN" = 0 ] || die "--prerelease must not be repeated"
      PRERELEASE_SEEN=1
      PRERELEASE_OPT="${1#*=}"
      [ -n "$PRERELEASE_OPT" ] || die "--prerelease needs a tag"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (supported: --from-file, --sha256, --prerelease)" ;;
  esac
done
if [ "$PRERELEASE_SEEN" = 1 ] && [ "$LOCAL_FILE_SEEN" = 1 ]; then
  die "--prerelease cannot be combined with --from-file/--sha256"
fi
if [ -n "$FROM_FILE" ] || [ -n "$FROM_SHA" ]; then
  [ -n "$FROM_FILE" ] && [ -n "$FROM_SHA" ] \
    || die "--from-file and --sha256 must be given together"
fi

# --- prerelease tag selection ----------------------------------------------
# Tag grammar: vMAJOR.MINOR.PATCH-LABEL.N. Numeric fields are `0` or digits
# with NO leading zero. LABEL starts with a letter and holds only ASCII
# letters, digits or hyphens. A stable tag (vX.Y.Z) is NOT a prerelease tag —
# grammar and shape reject whitespace, paths, queries and shell syntax too.
is_prerelease_tag() {
  [[ "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-[A-Za-z][A-Za-z0-9-]*\.(0|[1-9][0-9]*)$ ]]
}
# The selected prerelease tag, or "" for the normal stable flow. A resolved
# embedded marker supplies the default; an explicit --prerelease must equal it.
# Local-file mode never selects the marker.
PRERELEASE_TAG=""
if [ "$PRERELEASE_SEEN" = 1 ]; then
  is_prerelease_tag "$PRERELEASE_OPT" \
    || die "not a prerelease tag: $PRERELEASE_OPT (want vMAJOR.MINOR.PATCH-LABEL.N, e.g. v2.8.0-beta.3)"
  if [ -n "$OPENLLM_PRERELEASE_TAG" ]; then
    is_prerelease_tag "$OPENLLM_PRERELEASE_TAG" \
      || die "this script's embedded prerelease tag is invalid: $OPENLLM_PRERELEASE_TAG"
    [ "$PRERELEASE_OPT" = "$OPENLLM_PRERELEASE_TAG" ] \
      || die "--prerelease $PRERELEASE_OPT does not match this script's published tag $OPENLLM_PRERELEASE_TAG"
  fi
  PRERELEASE_TAG="$PRERELEASE_OPT"
elif [ -z "$FROM_FILE" ] && [ -z "$FROM_SHA" ] && [ -n "$OPENLLM_PRERELEASE_TAG" ]; then
  is_prerelease_tag "$OPENLLM_PRERELEASE_TAG" \
    || die "this script's embedded prerelease tag is invalid: $OPENLLM_PRERELEASE_TAG"
  PRERELEASE_TAG="$OPENLLM_PRERELEASE_TAG"
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
# Bounded --version probe: TERM after VERSION_PROBE_TIMEOUT, then KILL after
# VERSION_PROBE_KILL_GRACE more. Sets PROBE_STATUS (exit code) and PROBE_OUTPUT
# (stdout). Never dies — the caller chooses the failure.
bounded_version_probe() {
  local binary="$1" probe_file="${TMPDIR:-/tmp}/openllm-version-probe.$$" pid watchdog
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
  if wait "$pid"; then PROBE_STATUS=0; else PROBE_STATUS=$?; fi
  kill -TERM "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  PROBE_OUTPUT="$(cat "$probe_file" 2>/dev/null || true)"
  rm -f "$probe_file"
}
probe_version() {
  local binary="$1"
  bounded_version_probe "$binary"
  [ "$PROBE_STATUS" -eq 0 ] \
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

# Limit each output to 512 MiB. Release binaries are about 100 MiB.
is_gzip_asset() {
  LC_ALL=C head -c 2 "$1" | LC_ALL=C grep -q $'\x1f\x8b'
}

decompress_asset() {
  local input="$1" output="$2" name="$3"
  local max_bytes=536870912 status=0 size
  gzip -dc "$input" | head -c "$max_bytes" > "$output" || status=$?
  size="$(stat -c %s "$output" 2>/dev/null || stat -f %z "$output")" \
    || die "could not measure the decompressed $name"
  if [ "$size" -ge "$max_bytes" ]; then
    rm -f "$output"
    die "$name decompressed asset reaches the 512 MiB limit — refusing to install"
  fi
  if [ "$status" -ne 0 ]; then
    rm -f "$output"
    die "could not decompress $name: invalid gzip asset or output write failure"
  fi
}

# >>> openllm-prerelease/v1 (identical block in both shell installers) >>>>>>>
# Public-prerelease resolution. The manifest and the asset come from the SAME
# tag on the component's own repository: the manifest is tagged source, the
# asset is that tag's published release file. The digest gate is the manifest
# sha256 of the DECOMPRESSED bytes.
#
#   manifest:  https://raw.githubusercontent.com/<repo>/<tag>/manifest.ts
#   asset:     https://github.com/<repo>/releases/download/<tag>/<asset>
#
# OPENLLM_PRERELEASE_BASE_URL is a test-only override: it must parse to an
# http URL on a loopback host (127.0.0.1, localhost or [::1]); redirects are
# refused and the value is never persisted. The scheme list carries the
# redirect bound: production follows at most five, loopback follows none.
PRE_BASE=""
PR_SCHEME=(--proto "=https" --proto-redir "=https" --max-redirs 5)

# $1 = repository (openllmsh/daemon or openllmsh/cli), $2 = file in the tag's
# source tree. Prints the URL for that tagged file.
prerelease_repo_url() {
  if [ -n "$PRE_BASE" ]; then
    printf '%s/%s/%s/%s' "$PRE_BASE" "$1" "$PRERELEASE_TAG" "$2"
  else
    printf 'https://raw.githubusercontent.com/%s/%s/%s' "$1" "$PRERELEASE_TAG" "$2"
  fi
}

# $1 = repository, $2 = asset basename. Prints the release-asset URL.
prerelease_asset_url() {
  if [ -n "$PRE_BASE" ]; then
    prerelease_repo_url "$1" "$2"
  else
    printf 'https://github.com/%s/releases/download/%s/%s' "$1" "$PRERELEASE_TAG" "$2"
  fi
}

# Fetch one repository's tagged manifest and print the sha256 digest it pins
# for the host TARGET. Dies on any fetch, parse or content failure — the
# caller never picks another tag to recover.
prerelease_manifest_digest() {
  local repo="$1" export_name="$2" url body digest body_end
  url="$(prerelease_repo_url "$repo" manifest.ts)"
  # The trailing 'x' sentinel keeps command substitution from stripping the
  # manifest's final newlines, so the parser sees the exact served bytes.
  # Cap the pipe before Bash reads it. Older curl cannot cap chunked bodies.
  body="$(curl "${PR_SCHEME[@]}" "${CURL_META[@]}" --max-filesize 65536 -fsSL "$url" 2>/dev/null | head -c 65537 || exit; printf x)" \
    || die "could not fetch the $repo manifest for $PRERELEASE_TAG (manifest limit: 64 KiB)"
  body="${body%x}"
  [ "$(printf %s "$body" | LC_ALL=C wc -c)" -le 65536 ] \
    || die "manifest exceeds 64 KiB"
  # body_end tells the lexer whether the input ended in a newline — the
  # per-record buffer rebuild below hides one, which would let a `//` comment
  # cut off at EOF pass as terminated.
  body_end=0
  case "$body" in *$'\n') body_end=1 ;; esac
  digest="$(printf '%s' "$body" | LC_ALL=C awk \
    -v want_export="$export_name" -v want_repo="$repo" \
    -v want_tag="$PRERELEASE_TAG" -v want_target="$TARGET" \
    -v body_end="$body_end" '
function die(m) { printf "manifest: %s\n", m > "/dev/stderr"; exit 1 }
function hex2num(h,   i, v) {
  v = 0
  for (i = 1; i <= length(h); i++)
    v = v * 16 + index("0123456789abcdef", tolower(substr(h, i, 1))) - 1
  return v
}
function parse_object(   key, k2) {
  if (typ[p] != "{") die("release must be an object")
  p++
  while (1) {
    if (p > nt) die("unterminated object")
    if (typ[p] == "}") { p++; break }
    if (typ[p] != "id" && typ[p] != "str") die("bad field name")
    key = val[p]; p++
    if (typ[p] != ":") die("field " key " needs :")
    p++
    if (key == "repo" || key == "tag") {
      if (typ[p] != "str") die(key " must be a string")
      if (key == "repo") { if (f_repo++) die("duplicate repo"); v_repo = val[p] }
      else { if (f_tag++) die("duplicate tag"); v_tag = val[p] }
      p++
    } else if (key == "targets") {
      if (f_targets++) die("duplicate targets")
      if (typ[p] != "[") die("targets must be an array")
      p++
      while (1) {
        if (p > nt) die("unterminated targets")
        if (typ[p] == "]") { p++; break }
        if (typ[p] != "str") die("target must be a string")
        if (val[p] in targ) die("duplicate target " val[p])
        targ[val[p]] = 1; p++
        if (typ[p] == ",") { p++; continue }
        if (typ[p] == "]") { p++; break }
        die("bad targets array")
      }
    } else if (key == "sha256") {
      if (f_sha++) die("duplicate sha256")
      if (typ[p] != "{") die("sha256 must be an object")
      p++
      while (1) {
        if (p > nt) die("unterminated sha256")
        if (typ[p] == "}") { p++; break }
        if (typ[p] != "str") die("sha256 keys must be strings")
        k2 = val[p]; p++
        if (typ[p] != ":") die("sha256 field needs :")
        p++
        if (typ[p] != "str") die("sha256 value must be a string")
        if (k2 in dig) die("duplicate sha256 key " k2)
        if (length(val[p]) != 64 || val[p] !~ /^[0-9A-Fa-f]+$/)
          die("bad sha256 for " k2)
        dig[k2] = tolower(val[p]); p++
        if (typ[p] == ",") { p++; continue }
        if (typ[p] == "}") { p++; break }
        die("bad sha256 object")
      }
    } else die("unknown field " key)
    if (p > nt) die("unterminated object")
    if (typ[p] == ",") { p++; continue }
    if (typ[p] == "}") { p++; break }
    die("expected , or } after " key)
  }
}
{ buf = buf (NR == 1 ? "" : "\n") $0 }
END {
  s = buf
  if (body_end) s = s "\n"
  if (length(s) > 65536) die("manifest exceeds 64 KiB")
  if (substr(s, 1, 3) == sprintf("%c%c%c", 239, 187, 191)) s = substr(s, 4)
  n = length(s); i = 1; nt = 0
  while (i <= n) {
    c = substr(s, i, 1)
    if (c ~ /[[:space:]]/) { i++; continue }
    if (c == "/") {
      d = substr(s, i + 1, 1)
      if (d == "/") {
        j = index(substr(s, i + 2), "\n")
        if (j == 0) die("unterminated comment")
        i += j + 2; continue
      }
      if (d == "*") {
        j = index(substr(s, i + 2), "*/")
        if (j == 0) die("unterminated comment")
        i += j + 3; continue
      }
      die("unexpected /")
    }
    if (c == "\"") {
      i++; v = ""
      while (1) {
        if (i > n) die("unterminated string")
        c = substr(s, i, 1)
        if (c == "\"") { i++; break }
        if (c == "\n" || c == "\r") die("unterminated string")
        if (c == "\\") {
          e = substr(s, i + 1, 1)
          if (index("\"\\/", e) > 0) { v = v e; i += 2; continue }
          if (e == "n") { v = v "\n"; i += 2; continue }
          if (e == "t") { v = v "\t"; i += 2; continue }
          if (e == "r") { v = v "\r"; i += 2; continue }
          if (e == "b") { v = v "\b"; i += 2; continue }
          if (e == "f") { v = v "\f"; i += 2; continue }
          if (e == "u") {
            h = substr(s, i + 2, 4)
            if (length(h) != 4 || h !~ /^[0-9a-fA-F]+$/) die("bad \\u escape")
            cp = hex2num(h)
            if (cp < 32 || cp > 126) die("unsupported \\u escape")
            v = v sprintf("%c", cp); i += 6; continue
          }
          die("bad string escape")
        }
        v = v c; i++
      }
      nt++; typ[nt] = "str"; val[nt] = v; continue
    }
    if (c ~ /[A-Za-z_$]/) {
      j = i
      while (j <= n && substr(s, j, 1) ~ /[A-Za-z0-9_$]/) j++
      nt++; typ[nt] = "id"; val[nt] = substr(s, i, j - i); i = j; continue
    }
    if (index("{}[]:,;=", c) > 0) { nt++; typ[nt] = c; val[nt] = ""; i++; continue }
    die("unexpected character")
  }
  p = 1; seen = 0
  while (p <= nt) {
    if (typ[p] == "id" && val[p] == "import") {
      p++
      if (!(typ[p] == "id" && val[p] == "type")) die("only type imports are allowed")
      p++
      if (typ[p] == "{") {
        p++
        while (1) {
          if (p > nt) die("unterminated import")
          if (typ[p] == "}") { p++; break }
          if (typ[p] != "id") die("bad import")
          p++
          if (typ[p] == ",") { p++; continue }
          if (typ[p] == "}") { p++; break }
          die("bad import")
        }
      } else if (typ[p] == "id") {
        p++
      } else die("bad import")
      if (!(typ[p] == "id" && val[p] == "from")) die("import needs from")
      p++
      if (typ[p] != "str") die("import path must be a string")
      p++
      if (typ[p] == ";") p++
      continue
    }
    if (typ[p] == "id" && val[p] == "export") {
      p++
      if (!(typ[p] == "id" && val[p] == "const")) die("only const exports are allowed")
      p++
      if (typ[p] != "id") die("export needs a name")
      if (val[p] != want_export) die("unexpected export " val[p])
      p++
      if (seen) die("duplicate " want_export)
      seen = 1
      if (typ[p] != ":") die("export needs a type annotation")
      p++
      if (typ[p] != "id") die("export type must be a name")
      p++
      if (typ[p] != "=") die("export needs a value")
      p++
      parse_object()
      if (typ[p] == ";") p++
      continue
    }
    die("unexpected statement")
  }
  if (!seen) die("no " want_export " export")
  if (!f_repo || !f_tag || !f_targets || !f_sha) die("incomplete release record")
  if (v_repo != want_repo) die("repo is " v_repo ", want " want_repo)
  if (v_tag != want_tag) die("tag is " v_tag ", want " want_tag)
  if (!(want_target in targ)) die("no target " want_target " in targets")
  if (!(want_target in dig)) die("no sha256 for " want_target)
  for (k in dig) if (!(k in targ)) die("sha256 for undeclared target " k)
  print dig[want_target]
}')" || die "the $repo manifest for $PRERELEASE_TAG has no usable $TARGET digest"
  printf '%s' "$digest"
}

# Read 4 bytes at offset $2 of file $1 as a hex string, then as a number.
_pr_hex4() { od -An -tx1 -j "$2" -N 4 "$1" 2>/dev/null | tr -d ' \n'; }
_be32() {
  local h; h="$(_pr_hex4 "$1" "$2")"
  [[ "$h" =~ ^[0-9a-f]{8}$ ]] || die "short read checking the executable format"
  printf '%d' "$((16#$h))"
}
_le32() {
  local h; h="$(_pr_hex4 "$1" "$2")"
  [[ "$h" =~ ^[0-9a-f]{8}$ ]] || die "short read checking the executable format"
  printf '%d' "$((16#${h:6:2}${h:4:2}${h:2:2}${h:0:2}))"
}

# Executable-format check for a verified staged download: the published POSIX
# assets are 64-bit ELF (Linux/WSL2) or 64-bit Mach-O (macOS) matching the host
# architecture. Anything else — a script, a PE file, a truncated download — is
# refused before it is ever executed. On macOS this gate is also what makes the
# codesign step safe: only a Mach-O file ever reaches it.
verify_exec_format() {
  local file="$1" magic cls enc lo hi machine want_m ct ct_want nfat i esz
  magic="$(od -An -tx1 -N4 "$file" 2>/dev/null | tr -d ' \n')"
  case "$OS" in
    linux)
      [ "$magic" = "7f454c46" ] || die "downloaded $file is not an ELF executable for $TARGET"
      cls="$(od -An -tx1 -j4 -N1 "$file" 2>/dev/null | tr -d ' \n')"
      [ "$cls" = "02" ] || die "downloaded $file is not a 64-bit executable"
      enc="$(od -An -tx1 -j5 -N1 "$file" 2>/dev/null | tr -d ' \n')"
      lo="$(od -An -tx1 -j18 -N1 "$file" 2>/dev/null | tr -d ' \n')"
      hi="$(od -An -tx1 -j19 -N1 "$file" 2>/dev/null | tr -d ' \n')"
      case "$enc" in
        01) machine=$((16#${hi}${lo})) ;;
        02) machine=$((16#${lo}${hi})) ;;
        *) die "downloaded $file has an invalid ELF encoding" ;;
      esac
      # e_machine: x86-64 = 62, AArch64 = 183.
      if [ "$ARCH" = "x64-baseline" ]; then want_m=62; else want_m=183; fi
      [ "$machine" = "$want_m" ] \
        || die "downloaded $file is built for ELF machine $machine, not $TARGET"
      ;;
    darwin)
      # cputype: x86_64 = 0x01000007, arm64 = 0x0100000c.
      if [ "$ARCH" = "x64-baseline" ]; then ct_want=16777223; else ct_want=16777228; fi
      case "$magic" in
        cffaedfe) ct="$(_le32 "$file" 4)" ;;   # 64-bit Mach-O, little-endian
        feedfacf) ct="$(_be32 "$file" 4)" ;;   # 64-bit Mach-O, big-endian
        cafebabe|cafebabf)
          # Fat/universal header: scan the arch list for the host slice.
          nfat="$(_be32 "$file" 4)"
          ct=-1; i=0; esz=20
          [ "$magic" = "cafebabf" ] && esz=32
          while [ "$i" -lt "$nfat" ] && [ "$i" -lt 64 ]; do
            ct="$(_be32 "$file" $((8 + i * esz)))"
            [ "$ct" = "$ct_want" ] && break
            i=$((i + 1))
          done
          ;;
        bebafeca|bfbafeca)
          nfat="$(_le32 "$file" 4)"
          ct=-1; i=0; esz=20
          [ "$magic" = "bfbafeca" ] && esz=32
          while [ "$i" -lt "$nfat" ] && [ "$i" -lt 64 ]; do
            ct="$(_le32 "$file" $((8 + i * esz)))"
            [ "$ct" = "$ct_want" ] && break
            i=$((i + 1))
          done
          ;;
        *) die "downloaded $file is not a Mach-O executable for $TARGET" ;;
      esac
      [ "$ct" = "$ct_want" ] \
        || die "downloaded $file has no $TARGET slice"
      ;;
  esac
}
# <<< openllm-prerelease/v1 <<<

# Bounded --version probe for a staged prerelease download: the binary must
# exit 0 and report EXACTLY the selected version — never an older manifest pin.
probe_staged_version() {
  local binary="$1" want="$2" got=""
  bounded_version_probe "$binary"
  [ "$PROBE_STATUS" -eq 0 ] \
    || die "the downloaded $binary failed its --version probe — refusing to install"
  got="$(version_of_output "$PROBE_OUTPUT")" || got=""
  [ "$got" = "$want" ] \
    || die "the downloaded $binary reports '${got:-no parseable version}', not $want — refusing to install"
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
# Public-prerelease transport (P): fixed GitHub URLs over HTTPS with at most
# five redirects. OPENLLM_PRERELEASE_BASE_URL is a test-only override — it must
# parse to an http URL on a loopback host, refuses redirects, and is never
# persisted. Checked BEFORE the first fetch so a bad value fails early.
if [ -n "$PRERELEASE_TAG" ]; then
  has_command awk || die "awk is required to parse the release manifest"
  has_command gzip || die "gzip is required to unpack the release asset"
  has_command od || die "od is required to check the executable format"
  if [ -n "${OPENLLM_PRERELEASE_BASE_URL:-}" ]; then
    pre_authority="${OPENLLM_PRERELEASE_BASE_URL#http://}"
    [ "$pre_authority" != "$OPENLLM_PRERELEASE_BASE_URL" ] \
      || die "OPENLLM_PRERELEASE_BASE_URL must be an http:// URL on a loopback host (127.0.0.1, localhost or [::1])"
    pre_authority="${pre_authority%%[/?#]*}"
    case "$pre_authority" in
      127.0.0.1|localhost|\[::1\]) ;;
      \[::1\]:*)
        # The port follows `]:` — ${var#*:} would stop at the first ':' INSIDE
        # the brackets and reject the documented [::1]:port form.
        pre_port="${pre_authority#*\]:}"
        [[ "$pre_port" =~ ^[0-9]+$ ]] \
          || die "OPENLLM_PRERELEASE_BASE_URL has a bad port" ;;
      127.0.0.1:*|localhost:*)
        pre_port="${pre_authority#*:}"
        [[ "$pre_port" =~ ^[0-9]+$ ]] \
          || die "OPENLLM_PRERELEASE_BASE_URL has a bad port" ;;
      *) die "OPENLLM_PRERELEASE_BASE_URL must be an http:// URL on a loopback host (127.0.0.1, localhost or [::1])" ;;
    esac
    PRE_BASE="${OPENLLM_PRERELEASE_BASE_URL%/}"
    PR_SCHEME=(--proto "=http" --proto-redir "=http" --max-redirs 0)
  fi
fi

# Use a separate lock for binary replacement. Keep config lock state unchanged.
# >>> openllm-binary-lock/v1 >>>
BINARY_LOCK_STALE_SECS="${OPENLLM_BINARY_LOCK_STALE_SECS:-600}"
BINARY_LOCK_WAIT_SECS="${OPENLLM_BINARY_LOCK_WAIT_SECS:-10}"
BINARY_LOCK_ORPHAN_SECS="${OPENLLM_BINARY_LOCK_ORPHAN_SECS:-30}"
[[ "$BINARY_LOCK_STALE_SECS" =~ ^[0-9]+$ ]] || BINARY_LOCK_STALE_SECS=0
BINARY_LOCK_STALE_SECS=$((10#$BINARY_LOCK_STALE_SECS))
[ "$BINARY_LOCK_STALE_SECS" -gt 0 ] || BINARY_LOCK_STALE_SECS=600
[[ "$BINARY_LOCK_WAIT_SECS" =~ ^[0-9]+$ ]] || BINARY_LOCK_WAIT_SECS=0
BINARY_LOCK_WAIT_SECS=$((10#$BINARY_LOCK_WAIT_SECS))
[ "$BINARY_LOCK_WAIT_SECS" -gt 0 ] || BINARY_LOCK_WAIT_SECS=10
[[ "$BINARY_LOCK_ORPHAN_SECS" =~ ^[0-9]+$ ]] || BINARY_LOCK_ORPHAN_SECS=0
BINARY_LOCK_ORPHAN_SECS=$((10#$BINARY_LOCK_ORPHAN_SECS))
[ "$BINARY_LOCK_ORPHAN_SECS" -gt 0 ] || BINARY_LOCK_ORPHAN_SECS=30
BINARY_LOCK_DIR=""
BINARY_LOCK_NONCE=""
BINARY_LOCK_QSEQ=0
BINARY_LOCK_OWNER_STATE="" BINARY_LOCK_OWNER_PID=""
BINARY_LOCK_OWNER_START="" BINARY_LOCK_OWNER_NONCE=""

binary_lock_pid_alive() {
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  local pid=$((10#$1)) stat state
  if [ -r "/proc/$pid/stat" ]; then
    stat="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
    stat="${stat##*) }"
    read -r state _ <<< "$stat"
    [ "$state" = "Z" ] && return 1
  fi
  [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null
}

binary_lock_legacy_start_identity() {
  local out
  out="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null)" || out=""
  out="$(printf '%s' "$out" | tr -s '[:space:]' ' ')"
  out="${out# }"
  out="${out% }"
  printf '%s' "$out"
}

binary_lock_is_boot_identity() {
  local re='^boot:[0-9a-f-]{36}:[0-9]+$'
  [[ "$1" =~ $re ]]
}

binary_lock_normalize_identity() {
  local out
  out="$(printf '%s' "$1" | tr -s '[:space:]' ' ')"
  out="${out# }"
  out="${out% }"
  printf '%s' "$out"
}

binary_lock_start_identity() {
  local pid="$1" boot stat rest ticks
  if [ "$(uname -s 2>/dev/null)" = "Linux" ]; then
    boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)"
    boot="$(printf '%s' "$boot" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    local re='^[0-9a-f-]{36}$'
    [[ "$boot" =~ $re ]] || return 0
    stat="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
    [ -n "$stat" ] || return 0
    rest="${stat##*) }"
    [ "$rest" = "$stat" ] && rest="${stat:1}"
    local -a f
    read -r -a f <<< "$rest"
    ticks="${f[19]:-}"
    [[ "$ticks" =~ ^[0-9]+$ && "$ticks" =~ [1-9] ]] || return 0
    printf 'boot:%s:%s' "$boot" "$((10#$ticks))"
    return 0
  fi
  binary_lock_legacy_start_identity "$pid"
}

binary_lock_read_owner() {
  local dir="$1" line rest
  BINARY_LOCK_OWNER_STATE="unmarked"
  BINARY_LOCK_OWNER_PID="" BINARY_LOCK_OWNER_START="" BINARY_LOCK_OWNER_NONCE=""
  line="$(cat "$dir/owner" 2>/dev/null || true)"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  case "$line" in
    kind=openllm-binary-lock/v1\ pid=*\ start=*\ nonce=*)
      rest="${line#kind=openllm-binary-lock/v1 pid=}"
      BINARY_LOCK_OWNER_PID="${rest%% *}"
      BINARY_LOCK_OWNER_START="${rest#* start=}"
      BINARY_LOCK_OWNER_START="${BINARY_LOCK_OWNER_START% nonce=*}"
      BINARY_LOCK_OWNER_NONCE="${rest##* nonce=}"
      if [[ "$BINARY_LOCK_OWNER_PID" =~ ^[0-9]+$ ]] \
        && [ -n "$BINARY_LOCK_OWNER_START" ] \
        && [[ "$BINARY_LOCK_OWNER_START" != *$'\n'* \
          && "$BINARY_LOCK_OWNER_START" != *$'\r'* ]] \
        && [[ "$BINARY_LOCK_OWNER_NONCE" =~ ^[0-9a-fA-F]+$ ]]; then
        BINARY_LOCK_OWNER_PID=$((10#$BINARY_LOCK_OWNER_PID))
        BINARY_LOCK_OWNER_STATE="marked"
      fi
      ;;
  esac
  if [ "$BINARY_LOCK_OWNER_STATE" != "marked" ]; then
    BINARY_LOCK_OWNER_PID="" BINARY_LOCK_OWNER_START="" BINARY_LOCK_OWNER_NONCE=""
    if [[ "$line" =~ (^|[[:space:]])pid=([0-9]+)([[:space:]]|$) ]]; then
      BINARY_LOCK_OWNER_PID="${BASH_REMATCH[2]}"
    elif [[ "$line" =~ ^([0-9]+)([[:space:]]|$) ]]; then
      BINARY_LOCK_OWNER_PID="${BASH_REMATCH[1]}"
    fi
    if [ -n "$BINARY_LOCK_OWNER_PID" ]; then
      BINARY_LOCK_OWNER_PID=$((10#$BINARY_LOCK_OWNER_PID))
      [ "$BINARY_LOCK_OWNER_PID" -gt 0 ] || BINARY_LOCK_OWNER_PID=""
    fi
  fi
}

binary_lock_dir_age_secs() {
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

binary_lock_path_ino() {
  stat -c %d:%i "$1" 2>/dev/null || stat -f %d:%i "$1" 2>/dev/null || true
}

binary_lock_is_stale_dir() {
  local dir="$1" as_of="${2:-}" current bridged recorded age
  binary_lock_read_owner "$dir"
  age="$(binary_lock_dir_age_secs "$dir" "$as_of")"
  if [ "$BINARY_LOCK_OWNER_STATE" = "marked" ]; then
    binary_lock_pid_alive "$BINARY_LOCK_OWNER_PID" || return 0
    recorded="$(binary_lock_normalize_identity "$BINARY_LOCK_OWNER_START")"
    if [ "$recorded" = "-" ]; then
      return 1
    fi
    current="$(binary_lock_start_identity "$BINARY_LOCK_OWNER_PID")"
    if [ -z "$current" ]; then
      if binary_lock_pid_alive "$BINARY_LOCK_OWNER_PID"; then return 1; else return 0; fi
    fi
    [ "$current" = "$recorded" ] && return 1
    binary_lock_is_boot_identity "$current" || return 0
    binary_lock_is_boot_identity "$recorded" && return 0
    bridged="$(binary_lock_legacy_start_identity "$BINARY_LOCK_OWNER_PID")"
    if [ -z "$bridged" ]; then
      if binary_lock_pid_alive "$BINARY_LOCK_OWNER_PID"; then return 1; else return 0; fi
    fi
    if [ "$bridged" = "$recorded" ]; then return 1; else return 0; fi
  fi
  { [ "$age" -ge 0 ] && [ "$age" -ge "$BINARY_LOCK_ORPHAN_SECS" ]; } || return 1
  if [[ "$BINARY_LOCK_OWNER_PID" =~ ^[0-9]+$ ]] && binary_lock_pid_alive "$BINARY_LOCK_OWNER_PID"; then
    return 1
  fi
  return 0
}

binary_lock_steal() {
  local lockdir="$1" stem="$2" marker q ino_before ino_after q_ino mtime before_owner after_owner
  ino_before="$(binary_lock_path_ino "$lockdir")"
  mtime="$(stat -c %Y "$lockdir" 2>/dev/null || stat -f %m "$lockdir" 2>/dev/null || true)"
  [ -n "$ino_before" ] || return 0  # vanished — the outer acquire retries
  before_owner="$(cat "$lockdir/owner" 2>/dev/null || true)"
  marker="$lockdir/steal.$$.$BINARY_LOCK_NONCE"
  [ "$(binary_lock_path_ino "$lockdir")" = "$ino_before" ] || return 0
  if ! (set -C; : > "$marker") 2>/dev/null; then
    if [ -f "$lockdir" ]; then
      BINARY_LOCK_QSEQ=$((BINARY_LOCK_QSEQ + 1))
      mv "$lockdir" "$stem.stale.$$.$BINARY_LOCK_NONCE.$BINARY_LOCK_QSEQ" \
        2>/dev/null || true
    fi
    return 0
  fi
  ino_after="$(binary_lock_path_ino "$lockdir")"
  after_owner="$(cat "$lockdir/owner" 2>/dev/null || true)"
  if [ -n "$ino_after" ] && [ "$ino_after" = "$ino_before" ] \
    && [ "$after_owner" = "$before_owner" ] \
    && binary_lock_is_stale_dir "$lockdir" "$mtime"; then
    BINARY_LOCK_QSEQ=$((BINARY_LOCK_QSEQ + 1))
    q="$stem.stale.$$.$BINARY_LOCK_NONCE.$BINARY_LOCK_QSEQ"
    if mv "$lockdir" "$q" 2>/dev/null; then
      q_ino="$(binary_lock_path_ino "$q")"
      if [ "$q_ino" != "$ino_before" ] \
        || { [ -e "$q/owner" ] \
          && [ "$(cat "$q/owner" 2>/dev/null || true)" != "$before_owner" ]; }; then
        binary_lock_restore_dir "$q" "$lockdir"
        rm -f "$marker" "$q/steal.$$.$BINARY_LOCK_NONCE" 2>/dev/null || true
        return 0  # Retry acquisition. This steal did not claim the lock.
      fi
      return 0  # committed — the marker (and dir) are parked with it
    fi
  fi
  rm -f "$marker" 2>/dev/null || true
  return 0
}

binary_lock_sweep() {
  local stem="$1" entry child age ok has_owner
  for entry in "$stem".stale.* "$stem".rel.*; do
    [ -d "$entry" ] || continue
    age="$(binary_lock_dir_age_secs "$entry")"
    { [ "$age" -ge 0 ] && [ "$age" -ge "$BINARY_LOCK_STALE_SECS" ]; } || continue
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
      binary_lock_read_owner "$entry"
      [ "$BINARY_LOCK_OWNER_STATE" = "marked" ] || continue
    fi
    for child in "$entry"/*; do rm -f "$child" 2>/dev/null || true; done
    rmdir "$entry" 2>/dev/null || true
  done
  return 0
}

binary_lock_legacy_resolve() {
  local q="$1" legacy="$2" moved rest age
  moved=""
  read -r moved rest < "$q" 2>/dev/null || moved=""
  if [[ "$moved" =~ ^[0-9]+$ ]] && binary_lock_pid_alive "$moved"; then
    age="$(binary_lock_dir_age_secs "$q")"
    if [ "$age" -lt 0 ] || [ "$age" -lt "$BINARY_LOCK_ORPHAN_SECS" ]; then
      if ln "$q" "$legacy" 2>/dev/null; then
        rm -f "$q" 2>/dev/null || true
      elif (set -C; : > "$legacy") 2>/dev/null; then
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
        rm -f "$q" 2>/dev/null || true
      fi
      return 0
    fi
  fi
  rm -f "$q" 2>/dev/null || true
  return 1
}

binary_lock_legacy_held() {
  local legacy="$1" lpid rest q attempt=0 age
  while [ -f "$legacy" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -gt 4 ] && return 0
    lpid=""
    read -r lpid rest < "$legacy" 2>/dev/null || lpid=""
    if [[ "$lpid" =~ ^[0-9]+$ ]] && ! binary_lock_pid_alive "$lpid"; then
      : # a proven-dead pid is reclaimed regardless of the lock's age
    else
      age="$(binary_lock_dir_age_secs "$legacy")"
      if [ "$age" -lt 0 ] || [ "$age" -lt "$BINARY_LOCK_ORPHAN_SECS" ]; then
        return 0
      fi
    fi
    BINARY_LOCK_QSEQ=$((BINARY_LOCK_QSEQ + 1))
    q="$legacy.stale.$$.$BINARY_LOCK_NONCE.$BINARY_LOCK_QSEQ"
    mv "$legacy" "$q" 2>/dev/null || continue
    binary_lock_legacy_resolve "$q" "$legacy" && return 0
  done
  return 1
}

binary_lock_publish_owner() {
  local lockdir="$1" want_ino="${2:-}" start stolen same_gen marker now_ino
  for marker in "$lockdir"/steal.*; do
    [ -e "$marker" ] && return 1
  done
  start="$(binary_lock_start_identity "$$")"
  if [ -z "$start" ]; then
    if [ -n "$want_ino" ] \
      && [ "$(binary_lock_path_ino "$lockdir")" = "$want_ino" ]; then
      rmdir "$lockdir" 2>/dev/null || true
    fi
    return 1
  fi
  printf 'kind=openllm-binary-lock/v1 pid=%s start=%s nonce=%s\n' \
    "$$" "$start" "$BINARY_LOCK_NONCE" > "$lockdir/owner.tmp.$$" 2>/dev/null \
    || return 2
  if ln "$lockdir/owner.tmp.$$" "$lockdir/owner" 2>/dev/null \
    || (set -C; cat "$lockdir/owner.tmp.$$" > "$lockdir/owner") 2>/dev/null; then
    rm -f "$lockdir/owner.tmp.$$" 2>/dev/null
    stolen=1
    same_gen=0
    if [ -d "$lockdir" ]; then
      now_ino="$(binary_lock_path_ino "$lockdir")"
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
      binary_lock_read_owner "$lockdir"
      if [ "$BINARY_LOCK_OWNER_STATE" = "marked" ] \
        && [ "$BINARY_LOCK_OWNER_NONCE" = "$BINARY_LOCK_NONCE" ]; then
        rm -f "$lockdir/owner" 2>/dev/null
      fi
      [ "$same_gen" = 1 ] && rmdir "$lockdir" 2>/dev/null || true
      return 1
    fi
    binary_lock_read_owner "$lockdir"
    [ "$BINARY_LOCK_OWNER_STATE" = "marked" ] \
      && [ "$BINARY_LOCK_OWNER_NONCE" = "$BINARY_LOCK_NONCE" ]
    return
  fi
  rm -f "$lockdir/owner.tmp.$$" 2>/dev/null
  return 1
}

binary_lock_acquire() {
  local envfile="$1" stem lockdir deadline attempts pub_rc ino
  stem="$envfile.lock"
  lockdir="$stem.d"
  deadline=$((SECONDS + BINARY_LOCK_WAIT_SECS))
  BINARY_LOCK_NONCE="$(printf '%x%x%x' "$$" "$RANDOM" "$(date +%s 2>/dev/null || echo 0)")"
  attempts=0
  binary_lock_sweep "$stem"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! binary_lock_legacy_held "$stem"; then
      if mkdir "$lockdir" 2>/dev/null; then
        ino="$(binary_lock_path_ino "$lockdir")"
        if [ -z "$ino" ]; then
          rmdir "$lockdir" 2>/dev/null || true
          continue
        fi
        binary_lock_publish_owner "$lockdir" "$ino"
        pub_rc=$?
        if [ "$pub_rc" = 0 ]; then
          BINARY_LOCK_DIR="$lockdir"
          return 0
        elif [ "$pub_rc" = 2 ]; then
          if [ -n "$ino" ] && [ "$(binary_lock_path_ino "$lockdir")" = "$ino" ]; then
            rm -f "$lockdir/owner.tmp.$$" 2>/dev/null
            rmdir "$lockdir" 2>/dev/null || true
          fi
          return 1
        fi
      fi
      attempts=$((attempts + 1))
      [ $((attempts % 25)) -eq 0 ] && binary_lock_sweep "$stem"
      if binary_lock_is_stale_dir "$lockdir"; then
        binary_lock_steal "$lockdir" "$stem"
      fi
    fi
    sleep 0.01 2>/dev/null || sleep 1
  done
  return 1
}

binary_lock_restore_dir() {
  local rel="$1" lockdir="$2" child base dst ok=1 l_sz q_sz
  set --
  mkdir "$lockdir" 2>/dev/null || return 0
  for child in "$rel"/*; do
    [ -f "$child" ] || continue
    base="${child##*/}"
    dst="$lockdir/$base"
    if (set -C; : > "$dst") 2>/dev/null; then
      cat "$child" >> "$dst" 2>/dev/null || true
      l_sz="$(stat -c %s "$dst" 2>/dev/null || stat -f %z "$dst" 2>/dev/null || true)"
      q_sz="$(stat -c %s "$child" 2>/dev/null || stat -f %z "$child" 2>/dev/null || true)"
      if [ -n "$q_sz" ] && [ "$q_sz" = "$l_sz" ] \
        && [ "$(cat "$child" 2>/dev/null)" = "$(cat "$dst" 2>/dev/null)" ]; then
        set -- "$@" "$base"
        continue
      fi
      rm -f "$dst" 2>/dev/null || true
    fi
    ok=0
    break
  done
  if [ "$ok" = 1 ]; then
    command -v sync >/dev/null 2>&1 && sync 2>/dev/null || true
  else
    for base in "$@"; do rm -f "$lockdir/$base" 2>/dev/null || true; done
    rmdir "$lockdir" 2>/dev/null || true
    return 0
  fi
  for base in "$@"; do rm -f "$rel/$base" 2>/dev/null || true; done
  rmdir "$rel" 2>/dev/null || true
  return 0
}

binary_lock_release() {
  local lockdir="${BINARY_LOCK_DIR:-}" stem rel
  [ -n "$lockdir" ] || return 0
  BINARY_LOCK_DIR=""
  stem="${lockdir%.d}"
  rel="$stem.rel.$$.$BINARY_LOCK_NONCE"
  binary_lock_read_owner "$lockdir"
  if [ "$BINARY_LOCK_OWNER_STATE" = "marked" ] \
    && [ "$BINARY_LOCK_OWNER_NONCE" = "$BINARY_LOCK_NONCE" ]; then
    if mv "$lockdir" "$rel" 2>/dev/null; then
      binary_lock_read_owner "$rel"
      if [ "$BINARY_LOCK_OWNER_STATE" = "marked" ] && [ "$BINARY_LOCK_OWNER_NONCE" = "$BINARY_LOCK_NONCE" ]; then
        local child
        for child in "$rel"/*; do rm -f "$child" 2>/dev/null || true; done
        rmdir "$rel" 2>/dev/null || true
      else
        binary_lock_restore_dir "$rel" "$lockdir"
      fi
    fi
  fi
  return 0
}
# <<< openllm-binary-lock/v1 <<<

# Installer-owned directories are private state. A permissive caller umask
# (or a group-writable ~/.openllm left by an older build) would otherwise make
# the lock parent writable by another user, which the lock protocol refuses.
# Create under a private umask; with repair=1 (the default) also chmod a
# directory the invoking user owns — never a symlink or a foreign directory.
# A tightened dir is reported with one "note: tightened" line on stderr.
private_dir() {
  local d="$1" repair="${2:-1}" was
  [ -d "$d" ] || (umask 077 && mkdir -p "$d") \
    || die "could not create directory: $d"
  if [ "$repair" = "1" ] && [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; then
    was="$(ls -ld "$d" 2>/dev/null | cut -c1-10)"
    if [ "$was" != "drwx------" ]; then
      # A shared dir may have had foreign entries planted while it was
      # group/other-writable. Refuse to seal them inside private state.
      foreign="$(find "$d" -xdev ! -user "$(id -u)" -print -quit 2>/dev/null || true)"
      if [ -n "$foreign" ]; then
        die "refusing to tighten $d: $foreign is owned by another user; remove it, then re-run"
      fi
      chmod 700 "$d" || die "could not secure directory: $d"
      echo "  note: tightened $d from ${was#d} to 0700 (OpenLLM keeps its state private)" >&2
    fi
  fi
}

# Keep the caller's traps while the binary transaction owns the install lock.
install_lock_acquire() {
  local saved_exit
  INSTALL_SAVED_TRAPS="$(trap -p EXIT INT TERM)"
  saved_exit="$(trap -p EXIT)"
  INSTALL_SAVED_EXIT=""
  INSTALL_ROLLBACK=""
  if [ -n "$saved_exit" ]; then
    saved_exit="${saved_exit#trap -- }"
    saved_exit="${saved_exit% EXIT}"
    # Bash supplies this quoted command. It does not come from a manifest.
    eval "INSTALL_SAVED_EXIT=$saved_exit"
  fi
  binary_lock_acquire "$OPENLLM_DIR/install" \
    || die "could not acquire install lock: $OPENLLM_DIR/install.lock.d"
  trap 'install_lock_exit $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

install_lock_exit() {
  local status="$1"
  trap - EXIT
  if [ -n "$INSTALL_ROLLBACK" ]; then "$INSTALL_ROLLBACK"; fi
  binary_lock_release
  # Supply the original exit status to the caller's saved EXIT command.
  (exit "$status") && :
  eval "$INSTALL_SAVED_EXIT"
  exit "$status"
}

install_lock_release() {
  binary_lock_release
  trap - EXIT INT TERM
  eval "$INSTALL_SAVED_TRAPS"
}

private_dir "$OPENLLM_DIR"
private_dir "$BIN_DIR"
install_lock_acquire

CLI_VERSION=""
PRE_PUBLISHED=""
if [ -n "$PRERELEASE_TAG" ]; then
  # --proto/--proto-redir need a curl new enough to know the options (≈7.21).
  curl "${PR_SCHEME[@]}" "${CURL_META[@]}" -V >/dev/null 2>&1 \
    || die "this curl does not support --proto/--proto-redir — upgrade to curl 7.21.0 or newer and re-run"
  CLI_VERSION="${PRERELEASE_TAG#v}"
  # The requested version is known without the network — refuse a downgrade of
  # a managed binary before any fetch (current and legacy CLI names).
  assert_no_downgrade "$DEST" "$CLI_VERSION"
  assert_no_downgrade "$BIN_DIR/openllmc" "$CLI_VERSION"
  # The tag's own CLI manifest pins the digest — never a stable checksum route.
  echo "Resolving the OpenLLM CLI prerelease $PRERELEASE_TAG..."
  PRE_PUBLISHED="$(prerelease_manifest_digest openllmsh/cli CLI_RELEASE)" || exit 1
elif [ -z "$FROM_FILE" ]; then
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

private_dir "$OPENLLM_DIR"
private_dir "$BIN_DIR"

if [ -n "$PRERELEASE_TAG" ]; then
  URL="$(prerelease_asset_url openllmsh/cli "openllm-$TARGET.gz")"
else
  URL="$ORIGIN/api/cli/binary/$TARGET"
fi
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
elif [ -n "$PRERELEASE_TAG" ]; then
  PUBLISHED="$PRE_PUBLISHED"
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
  if [ -n "$PRERELEASE_TAG" ]; then
    probe_staged_version "$DEST" "$CLI_VERSION"
  fi
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
    elif [ -n "$PRERELEASE_TAG" ]; then
      # The same-tag release asset over the prerelease scheme (HTTPS with a
      # bounded redirect count, or redirect-free loopback in test mode).
      if [ -t 2 ]; then
        curl "${PR_SCHEME[@]}" "${CURL_GET[@]}" -fL --progress-bar "$URL" -o "$DL" || die "download failed: $URL"
      else
        curl "${PR_SCHEME[@]}" "${CURL_GET[@]}" -fsSL "$URL" -o "$DL" || die "download failed: $URL"
      fi
    elif [ -t 2 ]; then
      curl "${CURL_SCHEME[@]}" "${CURL_GET[@]}" -fL --progress-bar "$URL" -o "$DL" || die "download failed: $URL"
    else
      curl "${CURL_SCHEME[@]}" "${CURL_GET[@]}" -fsSL "$URL" -o "$DL" || die "download failed: $URL"
    fi
    # The pinned digest is over the DECOMPRESSED binary. A published
    # prerelease asset is ALWAYS gzip — a plain or empty response is a bad
    # release, never a format to pass through.
    if is_gzip_asset "$DL"; then
      decompress_asset "$DL" "$BIN" openllm
    elif [ -n "$PRERELEASE_TAG" ]; then
      die "the $PRERELEASE_TAG asset is not gzip data — refusing to install"
    else
      mv "$DL" "$BIN"
    fi
    if [ -z "$FROM_FILE" ]; then
      ACTUAL="$(sha256_of "$BIN")"
      [ -n "$ACTUAL" ] || die "could not hash the download"
      [ "$ACTUAL" = "$PUBLISHED" ] \
        || die "checksum mismatch (expected $PUBLISHED, got $ACTUAL) — refusing to install"
    fi
    if [ -n "$PRERELEASE_TAG" ]; then verify_exec_format "$BIN"; fi
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
    elif [ -n "$PRERELEASE_TAG" ]; then
      # The staged binary must execute and report EXACTLY the selected
      # version — a stale or foreign asset is refused before it lands.
      probe_staged_version "$BIN" "$CLI_VERSION"
    fi
    assert_no_downgrade "$DEST" "$CHECK_VERSION"
    mv -f "$BIN" "$DEST"
  ) || exit 1
  echo "  openllm installed → $DEST"
fi

install_lock_release

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

if [ -n "$PRERELEASE_TAG" ]; then
  # The daemon half comes from the SAME tag — print the bounded bootstrap the
  # release docs publish, not the stable /install route.
  cat <<EOF

The OpenLLM CLI prerelease $PRERELEASE_TAG is installed.

  openllm claude           run Claude Code through OpenLLM
  ollm codex               (short alias) run Codex through OpenLLM
  openllm --help           everything else

Open a new shell (or source your rc) so \`openllm\` and \`ollm\` are on PATH.
Subscription providers (Claude / Codex / Kimi) need the local daemon from the
same prerelease tag:
  ( f=\$(mktemp) && trap 'rm -f "\$f"' EXIT && curl --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 --max-redirs 5 -fsSL -o "\$f" https://raw.githubusercontent.com/openllmsh/daemon/$PRERELEASE_TAG/install.sh && bash "\$f" --prerelease $PRERELEASE_TAG )
EOF
else
cat <<EOF

The OpenLLM CLI is installed.

  openllm claude           run Claude Code through OpenLLM
  ollm codex               (short alias) run Codex through OpenLLM
  openllm --help           everything else

Open a new shell (or source your rc) so \`openllm\` and \`ollm\` are on PATH.
Subscription providers (Claude / Codex / Kimi) need the local daemon too:
  curl -fsSL $ORIGIN/install | bash
EOF
fi
