/**
 * `@openllmsh/cli` — the OpenLLM CLI.
 *
 * The single distribution vehicle for every gateway extension: one compiled,
 * source-free binary (`~/.openllm/bin/openllm`) that serves the unified MCP
 * server (`openllm mcp` — native gateway API tools from the generated SDK +
 * the openllm-context and openllm-memory tool groups) and the hook-support
 * subcommands the `openllm` plugin bundle's hooks shell out to.
 *
 * Like the daemon, the package barrel exports only the release manifest
 * surface — the runtime lives under `src/` and is consumed via the binary,
 * never imported by the gateway.
 */

export * from "./manifest";
export * from "./release-types";
