#!/usr/bin/env bash
# Shared config loader — SOURCED by the hooks that call the gateway directly.
# The ONE OpenLLM config file is ~/.openllm/.env (written by the daemon
# installer/pairing and the plugin install; read by the daemon and the openllm CLI),
# so hooks never need secrets baked into settings.json. Process env still
# wins: an explicit OPENLLM_CLOUD_ORIGIN / OPENLLM_API_KEY (e.g. a per-project
# override) is respected; the file only fills what's unset.
#
# POSIX-safe line parse (KEY=VALUE, # comments, optional single/double quotes)
# — mirrors the CLI's parseEnvFile (packages/cli/src/env.ts).

openllm_load_env() {
    _env_file="${OPENLLM_ENV_FILE:-$HOME/.openllm/.env}"
    [ -f "$_env_file" ] || return 0
    while IFS= read -r _line || [ -n "$_line" ]; do
        case "$_line" in ''|\#*) continue ;; esac
        case "$_line" in *=*) ;; *) continue ;; esac
        _k="${_line%%=*}"
        _v="${_line#*=}"
        # trim surrounding whitespace on the key, strip one layer of quotes
        _k="$(printf '%s' "$_k" | tr -d '[:space:]')"
        _v="${_v#"${_v%%[![:space:]]*}"}"
        _v="${_v%"${_v##*[![:space:]]}"}"
        case "$_v" in
            \"*\") _v="${_v#\"}"; _v="${_v%\"}" ;;
            \'*\') _v="${_v#\'}"; _v="${_v%\'}" ;;
        esac
        case "$_k" in
            OPENLLM_CLOUD_ORIGIN)
                [ -z "${OPENLLM_CLOUD_ORIGIN:-}" ] && OPENLLM_CLOUD_ORIGIN="$_v" ;;
            OPENLLM_API_KEY)
                [ -z "${OPENLLM_API_KEY:-}" ] && OPENLLM_API_KEY="$_v" ;;
        esac
    done < "$_env_file"
    return 0
}

openllm_load_env
