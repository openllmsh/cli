/**
 * Re-export of the protocol client registry SSOT — kept as a stable CLI path
 * so `openllm <client>` dispatch and help keep working without rewriting every
 * import inside the binary.
 */

export * from "@openllmsh/sdk/protocol/client-registry";
