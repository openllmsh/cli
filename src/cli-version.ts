/**
 * Compile-time CLI version identity. Isolated so `--version` / `-v` / `version`
 * can print without importing env, argv parsing, clients, or daemon delegation.
 *
 * Baked at compile (`__OPENLLM_CLI_VERSION__`); source runs use `0.0.0-dev`.
 */

declare const __OPENLLM_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __OPENLLM_CLI_VERSION__ === "string"
    ? __OPENLLM_CLI_VERSION__
    : "0.0.0-dev";
