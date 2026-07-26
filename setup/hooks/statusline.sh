#!/usr/bin/env bash
# Claude Code statusline: directory + context-usage meter.
#
# Claude spawns this on every render and pipes the session JSON on STDIN;
# whatever we write to STDOUT becomes the statusline (ANSI honored). Two rules
# follow from that, and both are load-bearing:
#
#   1. NEVER fail loudly. A non-zero exit or a stray stderr line is a broken
#      statusline on every single render, so every step degrades to "print less"
#      rather than erroring.
#   2. NEVER hang. This runs on each render; a blocking read would wedge the UI.
#      `read -t` bounds the stdin wait.
#
# Pure POSIX-ish bash + sed: no node, no jq. The gateway already ships this
# binary-free, and a statusline that depends on a runtime the user may not have
# is a statusline that silently doesn't render.
set -u

# Bound the stdin read so a stalled pipe can't wedge the render. `read -d ''`
# consumes the whole blob (it has no NUL), returning non-zero at EOF — expected,
# so it is not treated as failure.
payload=""
IFS= read -r -d '' -t 3 payload 2>/dev/null || true
[ -n "$payload" ] || exit 0

# Scalar field extractor. Matches "key": <number|null|"string"> and takes the
# LAST match, so a nested duplicate of a name can't shadow the outer one.
json_field() {
    printf '%s' "$payload" |
        sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" |
        tail -n 1
}

dir="$(json_field current_dir)"
[ -n "$dir" ] || dir="$PWD"
dirname="${dir##*/}"

# `used_percentage` is null until the first API response lands (a fresh session
# reports null, not 0) — show just the directory rather than a bogus 0% meter.
used_pct="$(json_field used_percentage)"
case "$used_pct" in
    ''|null) printf '\033[2m%s\033[0m' "$dirname"; exit 0 ;;
esac

total_ctx="$(json_field context_window_size)"
case "$total_ctx" in ''|null|*[!0-9]*) total_ctx=1000000 ;; esac

# Claude reserves a slice of the window for autocompaction that you cannot
# actually use, so the RAW percentage understates how full the context is: it
# reads ~16% "remaining" when there is effectively no room left. Rescale to the
# USABLE range, so 100% here means "autocompact is next", not "window full".
#
# The reserve is CLAUDE_CODE_AUTO_COMPACT_WINDOW tokens when set; otherwise
# 16.5% is a hardcoded guess at Anthropic's default and will drift silently if
# they change it. Set that env var to make this exact.
acw="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-0}"
case "$acw" in *[!0-9]*) acw=0 ;; esac

# Integer math in tenths of a percent throughout — bash has no floats, and
# shelling out to bc/awk on every render is a process we don't need to spawn.
if [ "$acw" -gt 0 ] && [ "$total_ctx" -gt 0 ]; then
    buffer_tenths=$(( acw * 1000 / total_ctx ))
    [ "$buffer_tenths" -gt 999 ] && buffer_tenths=999
else
    buffer_tenths=165
fi

# Round the incoming percentage to tenths without floats: strip to <int><frac>.
used_tenths="$(printf '%s' "$used_pct" |
    sed -n 's/^\([0-9]\{1,\}\)\(\.\([0-9]\)\)\{0,1\}.*/\1\3/p')"
case "$used_tenths" in
    ''|*[!0-9]*) printf '\033[2m%s\033[0m' "$dirname"; exit 0 ;;
esac
# A whole number lost its tenths digit in the capture above — restore the scale.
case "$used_pct" in *.*) ;; *) used_tenths=$(( used_tenths * 10 )) ;; esac

remaining_tenths=$(( 1000 - used_tenths ))
usable_span=$(( 1000 - buffer_tenths ))
[ "$usable_span" -gt 0 ] || usable_span=1

usable_remaining=$(( (remaining_tenths - buffer_tenths) * 1000 / usable_span ))
[ "$usable_remaining" -lt 0 ] && usable_remaining=0

# Round to the nearest whole percent, then clamp.
used=$(( (1000 - usable_remaining + 5) / 10 ))
[ "$used" -lt 0 ] && used=0
[ "$used" -gt 100 ] && used=100

filled=$(( used / 10 ))
[ "$filled" -gt 10 ] && filled=10
bar=""
i=0
while [ "$i" -lt 10 ]; do
    if [ "$i" -lt "$filled" ]; then bar="${bar}█"; else bar="${bar}░"; fi
    i=$(( i + 1 ))
done

# The window size, abbreviated: 1000000 -> 1M, 200000 -> 200k. Shown next to the
# percentage so "57%" is readable as a share of a known total — the same
# percentage means very different headroom at 200k vs 1M.
if [ "$total_ctx" -ge 1000000 ]; then
    whole=$(( total_ctx / 1000000 ))
    frac=$(( (total_ctx % 1000000) / 100000 ))
    if [ "$frac" -gt 0 ]; then ctx_label="${whole}.${frac}M"; else ctx_label="${whole}M"; fi
elif [ "$total_ctx" -ge 1000 ]; then
    ctx_label="$(( total_ctx / 1000 ))k"
else
    ctx_label="$total_ctx"
fi

# Green → yellow → orange → red.
if [ "$used" -lt 50 ]; then
    color='32'
elif [ "$used" -lt 65 ]; then
    color='33'
elif [ "$used" -lt 80 ]; then
    color='38;5;208'
else
    color='31'
fi

meter="$(printf ' \033[%sm%s %d%%\033[0m \033[2m%s\033[0m' \
    "$color" "$bar" "$used" "$ctx_label")"

printf '\033[2m%s\033[0m%s' "$dirname" "$meter"
