/**
 * Re-export of the protocol SSOT — kept as a stable CLI path so existing
 * `./setup-mode-contract` imports inside the binary keep working.
 */

export type { TSetupMode } from "@openllmsh/sdk/protocol";
export {
  DEFAULT_SETUP_MODE,
  parseSetupMode,
  SETUP_MODE_ENV,
  SETUP_MODES,
} from "@openllmsh/sdk/protocol";
