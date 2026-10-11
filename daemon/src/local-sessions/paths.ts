/**
 * Real-user paths for local session readers. Always the OS home — never
 * the daemon's isolated `~/.openllm/cli/<provider>/home` (that's for
 * subscription inference only).
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { stateDir } from "../env";
import type { TOpenllmClientId } from "./types";

export const userHome = (): string => homedir();

export const claudeConfigDir = (): string => join(userHome(), ".claude");
export const claudeHistoryPath = (): string =>
  join(claudeConfigDir(), "history.jsonl");
export const claudeSessionsDir = (): string =>
  join(claudeConfigDir(), "sessions");

export const codexHome = (): string => join(userHome(), ".codex");
export const codexStateDbPath = (): string =>
  join(codexHome(), "state_5.sqlite");
export const codexSessionsDir = (): string => join(codexHome(), "sessions");

export const grokHome = (): string => join(userHome(), ".grok");
export const grokSessionsDir = (): string => join(grokHome(), "sessions");

export const opencodeDataDir = (): string => {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg))
    return join(xdg, "opencode");
  return join(userHome(), ".local", "share", "opencode");
};
export const opencodeDbPath = (): string =>
  join(opencodeDataDir(), "opencode.db");

/** `~/.openllm/run` — shared with the openllm CLI's ephemeral overlays. */
export const runRoot = (): string => join(stateDir(), "run");
export const runClientRoot = (client: TOpenllmClientId): string =>
  join(runRoot(), client);
