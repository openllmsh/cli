/**
 * Browser-safe product setup-mode contract.
 *
 * Shared by the CLI (`setup-mode.ts`) and the dashboard install one-liners
 * (`lib/install-setup-mode.ts`, `lib/device-sessions-command.ts`). Pure
 * constants + parse — no Node, no env-file I/O — so the compiled CLI stays
 * free of workspace-package imports while the UI reuses the SAME default and
 * type rather than duplicating them.
 */

/** Env-file / process-env / install-one-liner key. */
export const SETUP_MODE_ENV = "OPENLLM_SETUP_MODE";

export const SETUP_MODES = ["full", "minimal"] as const;
export type TSetupMode = (typeof SETUP_MODES)[number];

/** Fresh-install / omitted-option default. */
export const DEFAULT_SETUP_MODE: TSetupMode = "full";

/** Accept only the documented values; reject anything else (incl. install/update). */
export const parseSetupMode = (raw: string | undefined): TSetupMode | null => {
  const value = raw?.trim();
  if (value === "full" || value === "minimal") return value;
  return null;
};
