#!/usr/bin/env bun

/**
 * Generate the Claude prompt-prefix overlay file that is embedded in the CLI binary
 * and written into the per-launch run directory.
 *
 * The single source of truth lives in `packages/protocol/prompt-prefix.ts` and is
 * consumed by both gateway transports. This generator makes the Claude launch
 * overlay deterministic and keeps it in sync without adding a CLI runtime
 * dependency on the protocol package.
 */

import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_PROMPT_PREFIX } from "../../protocol/prompt-prefix";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(PKG_ROOT, "setup", "claude", "prompt-prefix.md");

/** Render the committed overlay used by every `openllm claude` session. */
export const renderPromptPrefixAsset = (prefix: string): string =>
  prefix.endsWith("\n") ? prefix : `${prefix}\n`;

if (import.meta.main) {
  fs.mkdirSync(dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, renderPromptPrefixAsset(GATEWAY_PROMPT_PREFIX));
  console.log(`[generate-prompt-prefix] wrote ${OUT_FILE}`);
}
