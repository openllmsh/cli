/**
 * Always-on client dispatch. Every always-on client (Raycast, the ChatGPT Mac
 * app) registers its command runner and uninstaller here, keyed by registry id,
 * so `cli-dispatch.ts` and `uninstall-cmd.ts` stay on the registry SSOT.
 */

import { runChatgptCommand, uninstallChatgpt } from "./chatgpt";
import { runRaycastCommand, uninstallRaycast } from "./raycast";
import type { TAlwaysOnClientId, TClientFlags } from "./registry";
import { ALWAYS_ON_CLIENT_IDS } from "./registry";

type TAlwaysOnHandler = (
  args: readonly string[],
  flags?: TClientFlags,
) => Promise<number>;

const ALWAYS_ON_COMMANDS: {
  readonly [K in TAlwaysOnClientId]: TAlwaysOnHandler;
} = {
  chatgpt: runChatgptCommand,
  raycast: runRaycastCommand,
};

const ALWAYS_ON_UNINSTALL: {
  readonly [K in TAlwaysOnClientId]: () => number;
} = {
  chatgpt: uninstallChatgpt,
  raycast: uninstallRaycast,
};

export const isAlwaysOnClientId = (id: string): id is TAlwaysOnClientId =>
  (ALWAYS_ON_CLIENT_IDS as readonly string[]).includes(id);

export const runAlwaysOnCommand = (
  id: TAlwaysOnClientId,
  args: readonly string[],
  flags?: TClientFlags,
): Promise<number> => ALWAYS_ON_COMMANDS[id](args, flags);

/** Reverse an always-on client's ledger-tracked wiring. Idempotent. */
export const uninstallAlwaysOnClient = (id: TAlwaysOnClientId): number =>
  ALWAYS_ON_UNINSTALL[id]();
