/**
 * Local per-share monthly token counter for team grants. Origin already
 * reserves against `team_usage_counters`; this is the contributor daemon's
 * second line when a grant carries `cap_tokens`. Persisted under the daemon
 * state dir (same atomic JSON pattern as usage-cache).
 *
 * Charge only on successful completion (actual tokens). Admit-time checks
 * are soft (`canCharge`) and never permanently increment — failed/aborted
 * hops leave the counter untouched.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDevMode, stateDir } from "./env";

export type TTeamUsageDeps = {
  readonly now?: () => number;
  readonly stateFilePath?: () => string;
};

export type TTeamUsageTracker = {
  /** Tokens already counted for `shareId` in the calendar month of `now`. */
  readonly used: (shareId: string) => number;
  /**
   * Soft check: true when `used + tokens <= capTokens`. Does not persist —
   * concurrent admits may slightly overshoot; origin is authoritative.
   */
  readonly canCharge: (
    shareId: string,
    tokens: number,
    capTokens: number,
  ) => boolean;
  /**
   * Persist `used += tokens` after a successful hop. Always records actual
   * usage (including overshoot); returns false when the new total exceeds
   * `capTokens` so callers can report the overshoot.
   */
  readonly charge: (
    shareId: string,
    tokens: number,
    capTokens: number,
  ) => boolean;
};

type TTeamUsageFile = {
  readonly periods: Record<string, number>;
};

const periodKey = (shareId: string, atMs: number): string => {
  const d = new Date(atMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${shareId}:${y}-${m}`;
};

const defaultPath = (): string =>
  join(stateDir(), isDevMode() ? "team-usage.dev.json" : "team-usage.json");

const readFile = (path: string): TTeamUsageFile => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as TTeamUsageFile).periods !== "object" ||
      (raw as TTeamUsageFile).periods === null
    ) {
      return { periods: {} };
    }
    const periods: Record<string, number> = {};
    for (const [k, v] of Object.entries((raw as TTeamUsageFile).periods)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        periods[k] = v;
      }
    }
    return { periods };
  } catch {
    return { periods: {} };
  }
};

const writeFileAtomic = (path: string, data: TTeamUsageFile): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // parent may already exist
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
};

export const createTeamUsageTracker = (
  deps: TTeamUsageDeps = {},
): TTeamUsageTracker => {
  const now = deps.now ?? (() => Date.now());
  const pathOf = deps.stateFilePath ?? defaultPath;
  let cache: TTeamUsageFile | null = null;

  const load = (): TTeamUsageFile => {
    if (cache !== null) return cache;
    cache = readFile(pathOf());
    return cache;
  };

  return {
    used(shareId: string): number {
      const key = periodKey(shareId, now());
      return load().periods[key] ?? 0;
    },
    canCharge(shareId: string, tokens: number, capTokens: number): boolean {
      if (
        !Number.isFinite(tokens) ||
        tokens < 0 ||
        !Number.isFinite(capTokens) ||
        capTokens <= 0
      ) {
        return false;
      }
      const key = periodKey(shareId, now());
      const used = load().periods[key] ?? 0;
      return used + tokens <= capTokens;
    },
    charge(shareId: string, tokens: number, capTokens: number): boolean {
      if (
        !Number.isFinite(tokens) ||
        tokens <= 0 ||
        !Number.isFinite(capTokens) ||
        capTokens <= 0
      ) {
        return false;
      }
      const key = periodKey(shareId, now());
      const state = load();
      const used = state.periods[key] ?? 0;
      const next: TTeamUsageFile = {
        periods: { ...state.periods, [key]: used + tokens },
      };
      cache = next;
      writeFileAtomic(pathOf(), next);
      return used + tokens <= capTokens;
    },
  };
};

const defaultTracker = createTeamUsageTracker();

/** Process-wide tracker (production). Tests should inject via {@link createTeamUsageTracker}. */
export const teamUsageUsed = (shareId: string): number =>
  defaultTracker.used(shareId);

export const teamUsageCanCharge = (
  shareId: string,
  tokens: number,
  capTokens: number,
): boolean => defaultTracker.canCharge(shareId, tokens, capTokens);

export const teamUsageCharge = (
  shareId: string,
  tokens: number,
  capTokens: number,
): boolean => defaultTracker.charge(shareId, tokens, capTokens);
