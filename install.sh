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
OPENLLM_PRERELEASE_TAG=''
PRERELEASE_OPT=""
PRERELEASE_SEEN=0
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
  [ -z "$FROM_FILE" ] && [ -z "$FROM_SHA" ] \
    || die "--prerelease cannot be combined with --from-file/--sha256"
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

mkdir -p "$BIN_DIR"

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
    if gzip -t "$DL" >/dev/null 2>&1; then
      gzip -dc "$DL" > "$BIN" || die "could not decompress openllm"
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
  local pid=$((10#$1)) stat state
  if [ -r "/proc/$pid/stat" ]; then
    stat="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
    stat="${stat##*) }"
    read -r state _ <<< "$stat"
    [ "$state" = "Z" ] && return 1
  fi
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
      # An unproven identity is held. Only a fresh probe that proves the
      # recorded owner is dead may make a marked lock stale.
      return 1
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
# is restored if a new owner record appears before the rename.
env_lock_steal() {
  local lockdir="$1" stem="$2" marker q ino_before ino_after q_ino mtime before_owner after_owner
  ino_before="$(env_lock_path_ino "$lockdir")"
  mtime="$(stat -c %Y "$lockdir" 2>/dev/null || stat -f %m "$lockdir" 2>/dev/null || true)"
  [ -n "$ino_before" ] || return 0  # vanished — the outer acquire retries
  before_owner="$(cat "$lockdir/owner" 2>/dev/null || true)"
  marker="$lockdir/steal.$$.$ENV_LOCK_NONCE"
  # Do not put a marker in a successor that took this path.
  [ "$(env_lock_path_ino "$lockdir")" = "$ino_before" ] || return 0
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
  after_owner="$(cat "$lockdir/owner" 2>/dev/null || true)"
  if [ -n "$ino_after" ] && [ "$ino_after" = "$ino_before" ] \
    && [ "$after_owner" = "$before_owner" ] \
    && env_lock_is_stale_dir "$lockdir" "$mtime"; then
    ENV_LOCK_QSEQ=$((ENV_LOCK_QSEQ + 1))
    q="$stem.stale.$$.$ENV_LOCK_NONCE.$ENV_LOCK_QSEQ"
    if mv "$lockdir" "$q" 2>/dev/null; then
      q_ino="$(env_lock_path_ino "$q")"
      if [ "$q_ino" != "$ino_before" ] \
        || { [ -e "$q/owner" ] \
          && [ "$(cat "$q/owner" 2>/dev/null || true)" != "$before_owner" ]; }; then
        # A new owner record means publication raced the rename.
        # Restore only at a free path. Keep a blocked quarantine.
        env_lock_restore_dir "$q" "$lockdir"
        rm -f "$marker" "$q/steal.$$.$ENV_LOCK_NONCE" 2>/dev/null || true
        return 0  # Retry acquisition. This steal did not claim the lock.
      fi
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
  for marker in "$lockdir"/steal.*; do
    [ -e "$marker" ] && return 1
  done
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
        # quarantine+path-reuse, not only an in-place steal marker. When
        # the inode cannot be captured, publish NOTHING: a blind publish
        # could stamp into a successor's claim. Remove this empty generation
        # and retry immediately so the next attempt re-proves its own inode.
        ino="$(env_lock_path_ino "$lockdir")"
        if [ -z "$ino" ]; then
          rmdir "$lockdir" 2>/dev/null || true
          continue
        fi
        env_lock_publish_owner "$lockdir" "$ino"
        pub_rc=$?
        if [ "$pub_rc" = 0 ]; then
          ENV_LOCK_DIR="$lockdir"
          return 0
        elif [ "$pub_rc" = 2 ]; then
          # The tmp write failed — drop the dir WE made rather than hold it
          # unmarked, but ONLY while the path still proves OUR generation:
          # an inode that no longer matches (or was never captured) means a
          # successor may own this dir now — nothing inside it is ours to
          # remove (identical guard in the daemon and CLI code).
          if [ -n "$ino" ] && [ "$(env_lock_path_ino "$lockdir")" = "$ino" ]; then
            rm -f "$lockdir/owner.tmp.$$" 2>/dev/null
            rmdir "$lockdir" 2>/dev/null || true
          fi
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
