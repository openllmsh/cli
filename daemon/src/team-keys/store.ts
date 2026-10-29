/**
 * Device-local custody of team keys (T) for team tunnels' PSK handshake
 * (docs/proposals/team-tunnel-e2e-psk.md, phase 2 "Key custody").
 *
 * One file per team at `<stateDir>/team-keys/<team_id>.json` (0600, atomic
 * tmp + rename), written only by `set_team_key` after opening the browser's
 * sealed box and removed by `delete_team_key`. The key is never logged or
 * pushed — status carries `{ team_id, epoch }` only.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TEAM_KEY_ID_PATTERN } from "@openllmsh/protocol";
import { stateDir } from "../env";
import { readJsonStateFile, writeJsonStateAtomic } from "../json-state-cache";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 4 * 1024;
/** T is 32 bytes; base64 of that plus slack bounds the file. */
const MAX_KEY_LENGTH = 512;
const PERSIST_ERROR = "failed to persist team key";

export type TTeamKey = {
  readonly team_id: string;
  readonly epoch: number;
  readonly key: string;
  readonly stored_at_ms: number;
};

export type TTeamKeyEpoch = {
  readonly team_id: string;
  readonly epoch: number;
};

export type TTeamKeyWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

const storeDir = (home?: string): string => join(stateDir(home), "team-keys");

export const teamKeyStorePath = (teamId: string, home?: string): string =>
  join(storeDir(home), `${teamId}.json`);

const isTeamId = (teamId: string): boolean => TEAM_KEY_ID_PATTERN.test(teamId);

/** Untrusted file → key, or null when it doesn't match the expected team. */
const parseTeamKey = (raw: unknown, teamId: string): TTeamKey | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== STORE_VERSION || r.team_id !== teamId) return null;
  if (
    typeof r.epoch !== "number" ||
    !Number.isSafeInteger(r.epoch) ||
    r.epoch < 0
  ) {
    return null;
  }
  if (
    typeof r.key !== "string" ||
    r.key.length === 0 ||
    r.key.length > MAX_KEY_LENGTH
  ) {
    return null;
  }
  const stored =
    typeof r.stored_at_ms === "number" && Number.isFinite(r.stored_at_ms)
      ? r.stored_at_ms
      : 0;
  return { team_id: teamId, epoch: r.epoch, key: r.key, stored_at_ms: stored };
};

/** The stored T for `teamId`, or null. Never log the key. */
export const readTeamKey = (teamId: string, home?: string): TTeamKey | null => {
  if (!isTeamId(teamId)) return null;
  return parseTeamKey(
    readJsonStateFile(teamKeyStorePath(teamId, home), MAX_STORE_BYTES),
    teamId,
  );
};

/** Apply one `set_team_key`: replace this team's key. An older epoch than the
 *  one stored is refused, so a delayed command can't roll a rotation back. */
export const setTeamKey = (
  args: {
    readonly teamId: string;
    readonly epoch: number;
    readonly key: string;
  },
  home?: string,
): TTeamKeyWriteResult => {
  if (!isTeamId(args.teamId)) return { ok: false, error: "invalid team id" };
  const key = args.key.trim();
  if (key.length === 0) return { ok: false, error: "team key is empty" };
  if (key.length > MAX_KEY_LENGTH) {
    return { ok: false, error: "team key is too long" };
  }
  const current = readTeamKey(args.teamId, home);
  if (current !== null && args.epoch < current.epoch) {
    return { ok: false, error: "team key epoch is older than the stored one" };
  }
  const written = writeJsonStateAtomic(
    storeDir(home),
    teamKeyStorePath(args.teamId, home),
    {
      version: STORE_VERSION,
      team_id: args.teamId,
      epoch: args.epoch,
      key,
      stored_at_ms: Date.now(),
    },
  );
  return written ? { ok: true } : { ok: false, error: PERSIST_ERROR };
};

/** Apply one `delete_team_key`. Removing an absent key succeeds. */
export const deleteTeamKey = (
  teamId: string,
  home?: string,
): TTeamKeyWriteResult => {
  if (!isTeamId(teamId)) return { ok: false, error: "invalid team id" };
  try {
    rmSync(teamKeyStorePath(teamId, home), { force: true });
    return { ok: true };
  } catch {
    return { ok: false, error: PERSIST_ERROR };
  }
};

/** Every team this device holds a key for, as the status push reports it. */
export const teamKeyEpochs = (home?: string): readonly TTeamKeyEpoch[] => {
  const dir = storeDir(home);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: TTeamKeyEpoch[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const stored = readTeamKey(name.slice(0, -".json".length), home);
    if (stored !== null) {
      out.push({ team_id: stored.team_id, epoch: stored.epoch });
    }
  }
  return out.sort((a, b) => a.team_id.localeCompare(b.team_id));
};
