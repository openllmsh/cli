import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { userHome } from "../env";
import { tryHookLock } from "../hook-helpers";
import type { THookDiagnostic } from "./transport";
import { recordOf } from "./transport";

type THealthOutcome = "failure" | "success" | "saved" | "noop";
type TComponent = "extract" | "recall";
type TComponentHealth = {
  failures: number;
  outcome: THealthOutcome;
  ts: number;
  lastSuccess: number;
  lastSave: number;
};
type THealthState = {
  extract?: TComponentHealth;
  recall?: TComponentHealth;
  noticeTs?: number;
};
export type TExtractionState = {
  size?: number;
  ts: number;
  attemptTs: number;
  failed: boolean;
};

export const numeric = (
  value: unknown,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const parsed =
    typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
};

const privateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
};

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

const readState = (path: string): Record<string, unknown> => {
  try {
    return recordOf(JSON.parse(readFileSync(path, "utf8"))) ?? {};
  } catch {
    return {};
  }
};

const writeState = (path: string, value: unknown): void => {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* Renamed or not created. */
    }
  }
};

const healthOf = (value: unknown): TComponentHealth | undefined => {
  const data = recordOf(value);
  if (!data) return undefined;
  const outcome = data.outcome;
  if (
    outcome !== "failure" &&
    outcome !== "success" &&
    outcome !== "saved" &&
    outcome !== "noop"
  )
    return undefined;
  return {
    outcome,
    failures: numeric(data.failures, 0, 0, 100),
    ts: numeric(data.ts, 0),
    lastSave: numeric(data.lastSave, 0),
    lastSuccess: numeric(data.lastSuccess, 0),
  };
};

export class MemoryHookState {
  readonly root: string;
  constructor(
    origin: string,
    apiKey: string,
    private readonly component: TComponent,
  ) {
    const parent =
      process.env.SUPERMEMORY_AUTO_LOG_DIR ||
      join(userHome(), ".claude/plugin-state/supermemory");
    privateDirectory(parent);
    const scopes = join(parent, "scopes");
    privateDirectory(scopes);
    this.root = join(scopes, hash(`${origin}\0${apiKey}`));
    privateDirectory(this.root);
  }

  session(
    sessionId: string,
    transcript: string,
  ): { path: string; release: () => void; previous: TExtractionState } | null {
    const dir = join(this.root, "sessions");
    privateDirectory(dir);
    const path = join(dir, `${hash(`${sessionId}\0${transcript}`)}.json`);
    const release = tryHookLock(`${path}.lock.sqlite`);
    if (!release) return null;
    const data = readState(path);
    return {
      path,
      release,
      previous: {
        ...(typeof data.size === "number" ? { size: data.size } : {}),
        ts: numeric(data.ts, 0),
        attemptTs: numeric(data.attemptTs, 0),
        failed: data.failed === true,
      },
    };
  }

  stamp(path: string, state: TExtractionState): void {
    writeState(path, state);
  }

  diagnostic(detail: THookDiagnostic): void {
    this.log({ outcome: "failure", ...detail });
  }

  log(
    fields:
      | THookDiagnostic
      | {
          outcome: THealthOutcome | "recall";
          saved?: number;
          forgotten?: number;
          duplicates?: number;
          errors?: number;
          hits?: number;
        },
  ): void {
    const path = join(
      this.root,
      this.component === "extract" ? "auto-save.log" : "recall.log",
    );
    try {
      if (
        statSync(path, { throwIfNoEntry: false })?.size &&
        statSync(path).size > 64 * 1024
      )
        renameSync(path, `${path}.1`);
      appendFileSync(
        path,
        `${JSON.stringify({ ts: Date.now(), ...fields })}\n`,
        { mode: 0o600 },
      );
      chmodSync(path, 0o600);
    } catch {
      /* Diagnostics must never block the conversation. */
    }
  }

  health(outcome: THealthOutcome, saved = 0): void {
    this.updateHealth((state): void => {
      const previous = state[this.component];
      const now = Date.now();
      state[this.component] = {
        outcome,
        ts: now,
        failures:
          outcome === "failure"
            ? Math.min(100, (previous?.failures ?? 0) + 1)
            : 0,
        lastSuccess: outcome === "failure" ? (previous?.lastSuccess ?? 0) : now,
        lastSave: saved > 0 ? now : (previous?.lastSave ?? 0),
      };
    });
  }

  notice(): string | undefined {
    let notice: string | undefined;
    this.updateHealth((state): void => {
      const degraded = (["extract", "recall"] as const).filter(
        (name) =>
          (state[name]?.failures ?? 0) >= 2 &&
          !(name === "extract" && process.env.SUPERMEMORY_AUTO_SAVE === "0"),
      );
      const now = Date.now();
      if (!degraded.length || now - (state.noticeTs ?? 0) < 60 * 60 * 1000)
        return;
      state.noticeTs = now;
      const activity =
        degraded.length === 2
          ? "saving and recall"
          : degraded[0] === "extract"
            ? "saving"
            : "recall";
      notice = `OpenLLM memory: automatic ${activity} has repeatedly failed. Work can continue; check the private supermemory hook logs and gateway/daemon connection.`;
    });
    return notice;
  }

  private updateHealth(update: (state: THealthState) => void): void {
    let release: (() => void) | null = null;
    try {
      release = tryHookLock(join(this.root, "health.lock.sqlite"));
      if (!release) return;
      const path = join(this.root, "health.json");
      const raw = readState(path);
      const state: THealthState = {
        extract: healthOf(raw.extract),
        recall: healthOf(raw.recall),
        noticeTs: numeric(raw.noticeTs, 0),
      };
      update(state);
      writeState(path, state);
    } catch {
      /* Foreground prompts stay fail-open on unwritable state. */
    } finally {
      release?.();
    }
  }
}
