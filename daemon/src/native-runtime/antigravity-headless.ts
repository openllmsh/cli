/**
 * Google Antigravity over the official `agy` CLI in headless stream-json mode
 * (`--input-format stream-json --output-format stream-json`). Documented at
 * antigravity.google/docs/cli/headless; no token reads, no direct endpoint
 * calls — the CLI does its own auth and inference.
 *
 * `agy` is the single source of truth for Antigravity sign-in; this mode and
 * `agy acp` (`antigravity-acp.ts`) share it under the same isolated HOME.
 * Why headless leads: measured back to back on the same model, ACP releases
 * the reply only once it is complete (first text ≈ the headless run's LAST
 * text), while this mode streams ~25 ms text deltas from ~1.8 s after the
 * prompt. See docs/plans/antigravity-headless-transport.md.
 *
 * Protocol (agy 1.3.x), one NDJSON object per line:
 *   stdin   {"event":"user","message":{"content":"…"}}       one per turn
 *   stdout  {"event":"init","conversation_id","init":{model,cwd,tools,…}}
 *           — emitted at start-up, BEFORE any input
 *           {"event":"step_update","step_update":{step_index,state,
 *             step_type,text_delta?,thinking_delta?}}
 *           {"event":"result","result":{status,response,error,usage:{
 *             input_tokens,output_tokens,thinking_tokens,total_tokens}}}
 *
 * One process holds ONE conversation, so a process is never handed to an
 * unrelated request. Start-up (~3.7 s) completes before input, so a fresh
 * SPARE process may be started for the next request — only right after a real
 * request used one, never in the background on its own (see the spare rules).
 *
 * Scope: plain text turns. Client tools and images decline with
 * {@link ANTIGRAVITY_HEADLESS_FALLBACK} so `serve.ts` runs `agy acp`, which
 * serves them. Spawn / start-up / write failures and a native-tool step carry
 * the same marker (an unanticipated failure falls back to ACP). A sign-in miss
 * does NOT: ACP uses the same sign-in, so it declines with an `auth` cooldown.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { TChatCompletionChunk } from "@openllmsh/sdk/protocol";
import { agyVersionUsable, cachedCliVersion } from "../agy-version";
import { killHard } from "../delegation/antigravity-cli-login";
import type { TStoreRead } from "../delegation/util";
import { ensureKeychainReady } from "../delegation/util";
import { logError } from "../logger";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapAntigravityCliSpawn } from "../sandbox/policy";
import { daemonTempDir } from "../sandbox/working-set";
import {
  ANTIGRAVITY_CLI_AGENT_NAME,
  prepareAntigravityCliProfile,
} from "./antigravity-cli-settings";
import { antigravitySpawnEnv } from "./antigravity-env";
import { createAcpTurnState } from "./cursor-acp";
import type { TNativeRunResult } from "./types";
import { PRE_COMMIT_TIMEOUT_MS } from "./types";

/** Decline reason prefix that tells `serve.ts` to run the ACP bridge instead. */
export const ANTIGRAVITY_HEADLESS_FALLBACK = "antigravity-headless-fallback";

export const ANTIGRAVITY_HEADLESS_TURN_TIMEOUT_MS = 180_000;
export const ANTIGRAVITY_HEADLESS_IDLE_TIMEOUT_MS = 60_000;
/** How long `init` may take before the process is treated as broken. */
export const ANTIGRAVITY_HEADLESS_INIT_TIMEOUT_MS = 30_000;
/** A spare process is killed after this long unused. */
export const ANTIGRAVITY_HEADLESS_SPARE_TTL_MS = 120_000;
/** At most this many spares across all keys. */
export const ANTIGRAVITY_HEADLESS_SPARE_MAX = 2;

/** Step types that are the model talking to the user — anything else is a
 *  native tool / agent action, which never runs here. */
const RESPONSE_STEP_TYPES: ReadonlySet<string> = new Set([
  "user_input",
  "agent_response",
  "planner_response",
  "ephemeral_message",
  "checkpoint",
]);

/** Includes print mode's own refusal, "Run 'agy' to log in". */
const SIGN_IN_RE =
  /not logged in|to log in|sign in|signed out|authentication failed/i;
const QUOTA_RE = /quota|exhausted|rate.?limit|resource.?exhausted|429/i;
const PLAN_RE = /subscription|not eligible|tier|upgrade|license/i;

// ─── Binary ────────────────────────────────────────────────────────────────

/** The `agy` CLI: explicit override, the official installer's launcher, PATH. */
export const resolveAntigravityCli = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
  versionOf: (path: string) => string | null = cachedCliVersion,
): string | null => {
  // An executable FILE at or above 1.5.1 (`agy acp`, every model): a file that can't run,
  // or an older build, must not take the route (and Connect). The version is
  // read once per binary stamp.
  const usable = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      if (!statSync(path).isFile()) return false;
    } catch {
      return false;
    }
    return agyVersionUsable(path, versionOf);
  };
  const override = env.OPENLLM_AGY_BIN;
  if (override !== undefined && override.length > 0) {
    // Absolute: `agy` is launched from scratch directories, where a relative
    // path would name something else.
    const absolute = resolvePath(override);
    return usable(absolute) ? absolute : null;
  }
  // The home launcher decides when it is there (the installer replaces an
  // old one there); a copy on PATH serves only without it.
  const launcher = join(home, ".local", "bin", "agy");
  if (existsSync(launcher)) return usable(launcher) ? launcher : null;
  const onPath = Bun.which("agy");
  return onPath !== null && usable(onPath) ? onPath : null;
};

export const antigravityHeadlessArgv = (
  bin: string,
  model: string,
): string[] => [
  bin,
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--model",
  model,
  "--agent",
  ANTIGRAVITY_CLI_AGENT_NAME,
  "--disable-slash-commands",
];

// ─── Event parsing (pure) ──────────────────────────────────────────────────

/** `result.usage` as `agy` reports it. `input` EXCLUDES cache reads (the
 *  total is input + output), unlike OpenAI's `prompt_tokens`. */
export type THeadlessUsage = {
  readonly input: number;
  readonly output: number;
  readonly thinking: number;
  readonly cacheRead: number;
};

/** How long an exit waits for stdout already written to be read. */
export const ANTIGRAVITY_HEADLESS_EXIT_DRAIN_MS = 1_000;

/** Chunks a turn holds for a reader that stopped reading; past this the
 *  turn fails instead of buffering without bound. */
export const ANTIGRAVITY_HEADLESS_MAX_QUEUED = 50_000;

/** Longest stdout line kept while waiting for its newline (4 MiB). */
export const ANTIGRAVITY_HEADLESS_MAX_LINE_CHARS = 4 * 1024 * 1024;

const count = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;

/** `agy` usage → the OpenAI usage row the daemon records: cached tokens are
 *  part of `prompt_tokens`. `output_tokens` already includes thinking
 *  (`total_tokens` = input + output in agy's own result), so thinking is
 *  never added a second time. */
export const openAiUsageOf = (
  u: THeadlessUsage,
): {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly prompt_tokens_details: { readonly cached_tokens: number };
} => {
  const prompt = u.input + u.cacheRead;
  const completion = u.output;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: u.cacheRead },
  };
};

/** One turn's usage from a session-cumulative result (never negative). */
export const turnUsageOf = (
  cumulative: THeadlessUsage,
  baseline: THeadlessUsage | null,
): THeadlessUsage =>
  baseline === null
    ? cumulative
    : {
        input: Math.max(0, cumulative.input - baseline.input),
        output: Math.max(0, cumulative.output - baseline.output),
        thinking: Math.max(0, cumulative.thinking - baseline.thinking),
        cacheRead: Math.max(0, cumulative.cacheRead - baseline.cacheRead),
      };

export type THeadlessEvent =
  | { readonly kind: "init"; readonly conversationId: string | null }
  | {
      readonly kind: "step";
      readonly stepType: string;
      readonly textDelta: string | null;
      readonly thinkingDelta: string | null;
    }
  | {
      readonly kind: "result";
      readonly ok: boolean;
      readonly error: string | null;
      readonly response: string | null;
      readonly totalTokens: number | null;
      readonly usage: THeadlessUsage | null;
    }
  | { readonly kind: "other" };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One stdout line → event; null for non-JSON noise. */
export const parseHeadlessLine = (line: string): THeadlessEvent | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const event = str(obj.event) ?? str(obj.type);
  if (event === "init") {
    return { kind: "init", conversationId: str(obj.conversation_id) };
  }
  if (event === "step_update") {
    const s = (obj.step_update ?? {}) as Record<string, unknown>;
    return {
      kind: "step",
      stepType: (str(s.step_type) ?? "").toLowerCase(),
      textDelta: str(s.text_delta),
      thinkingDelta: str(s.thinking_delta),
    };
  }
  if (event === "result") {
    const r = (obj.result ?? {}) as Record<string, unknown>;
    const usage = (r.usage ?? {}) as Record<string, unknown>;
    const total = usage.total_tokens;
    const parsedUsage: THeadlessUsage = {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      thinking: count(usage.thinking_tokens),
      cacheRead: count(usage.cache_read_tokens),
    };
    const hasUsage =
      parsedUsage.input + parsedUsage.output + parsedUsage.cacheRead > 0;
    return {
      kind: "result",
      ok: str(r.status)?.toUpperCase() === "SUCCESS",
      error: str(r.error),
      response: str(r.response),
      totalTokens:
        typeof total === "number" && Number.isSafeInteger(total) && total > 0
          ? total
          : null,
      usage: hasUsage ? parsedUsage : null,
    };
  }
  return { kind: "other" };
};

export type THeadlessFailure = {
  readonly reason: string;
  readonly cooldown?: "auth" | "quota_exhausted" | "payment";
  /** Retry on the ACP bridge rather than failing the hop. */
  readonly fallback: boolean;
};

/** Classify a non-SUCCESS `result` error. A sign-in miss is an `auth`
 *  cooldown (ACP shares the sign-in, so it cannot help); no failure here falls
 *  back — those are the account's. */
export const classifyHeadlessFailure = (
  error: string | null,
): THeadlessFailure => {
  const msg = error ?? "antigravity turn failed";
  if (SIGN_IN_RE.test(msg)) {
    return {
      reason: "antigravity: Google sign-in required",
      cooldown: "auth",
      fallback: false,
    };
  }
  if (QUOTA_RE.test(msg)) {
    return {
      reason: `antigravity: ${msg}`,
      cooldown: "quota_exhausted",
      fallback: false,
    };
  }
  if (PLAN_RE.test(msg)) {
    return {
      reason: `antigravity: ${msg}`,
      cooldown: "payment",
      fallback: false,
    };
  }
  return { reason: `antigravity: ${msg}`, fallback: false };
};

// ─── Process ───────────────────────────────────────────────────────────────

type TListener = (event: THeadlessEvent) => void;

/** One `agy` stream-json process (one conversation). */
class HeadlessProcess {
  readonly key: string;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private listener: TListener | null = null;
  private exitedFlag = false;
  readonly initialized: Promise<boolean>;
  /** The conversation this process holds (from `init`). */
  conversationId: string | null = null;
  /** `agy`'s `result.usage` ACCUMULATES over a stream-json session (Google's
   *  headless docs); the last result's counters, so a reused process reports
   *  each turn's own usage. */
  usageBaseline: THeadlessUsage | null = null;
  /** A result came without usable usage: the baseline no longer marks the
   *  previous turn, so the next delta would span two turns — that turn is
   *  estimated, and exact deltas resume from the one after. */
  usageBaselineStale = false;
  /** The current turn's exit handler — one slot, replaced each turn, so a
   *  parked, reused process never accumulates past turns' callbacks. */
  private exitHandler: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    key: string,
    argv: string[],
    env: Record<string, string>,
    readonly cwd: string,
    initTimeoutMs: number,
  ) {
    this.key = key;
    this.proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      // Native stderr is not a safe diagnostic channel (may carry secrets).
      stderr: "ignore",
    });
    let resolveInit: (ok: boolean) => void = () => {};
    this.initialized = new Promise<boolean>((resolve): void => {
      resolveInit = resolve;
    });
    const initTimer = setTimeout((): void => resolveInit(false), initTimeoutMs);
    this.listener = (e): void => {
      if (e.kind === "init") {
        this.conversationId = e.conversationId;
        clearTimeout(initTimer);
        resolveInit(true);
      }
    };
    const pumped = this.pump(this.proc.stdout as ReadableStream<Uint8Array>);
    void this.proc.exited.then(async () => {
      this.exitedFlag = true;
      clearTimeout(initTimer);
      resolveInit(false);
      // Deliver every line already written (a final result can still be
      // unread when the process exits) before the turn hears of the exit —
      // bounded, since a grandchild could hold stdout open.
      await Promise.race([
        pumped,
        Bun.sleep(ANTIGRAVITY_HEADLESS_EXIT_DRAIN_MS),
      ]);
      this.exitHandler?.();
      this.exitHandler = null;
    });
  }

  /** Run `handler` when the process exits (now, if it already has). */
  onExit(handler: (() => void) | null): void {
    if (handler !== null && this.exitedFlag) {
      handler();
      return;
    }
    this.exitHandler = handler;
  }

  get alive(): boolean {
    return !this.exitedFlag;
  }

  /** Resolves when the process exits. */
  get exited(): Promise<unknown> {
    return this.proc.exited;
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          // A complete line over the limit is as bad as an unfinished one.
          if (nl > ANTIGRAVITY_HEADLESS_MAX_LINE_CHARS) {
            this.dispose();
            return;
          }
          const event = parseHeadlessLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (event !== null) this.listener?.(event);
        }
        // A line that never ends must not grow without bound: end the
        // process (the turn then fails as an exit mid-turn).
        if (buf.length > ANTIGRAVITY_HEADLESS_MAX_LINE_CHARS) {
          this.dispose();
          return;
        }
      }
    } catch {
      // Exit is observed through `proc.exited`.
    }
  }

  /** Route events to the leasing turn (null detaches). */
  route(listener: TListener | null): void {
    this.listener = listener;
  }

  /** Write one user turn. A synchronous throw propagates; a pending write
   *  that later rejects (EPIPE when agy closed stdin) reaches `onError`. */
  send(text: string, onError: (error: unknown) => void): void {
    const stdin = this.proc.stdin as {
      write: (s: string) => unknown;
      flush?: () => unknown;
    };
    const observe = (result: unknown): void => {
      if (result instanceof Promise) result.catch(onError);
    };
    observe(
      stdin.write(
        `${JSON.stringify({ event: "user", message: { content: text } })}\n`,
      ),
    );
    observe(stdin.flush?.());
  }

  /** Kill-after-idle timer for a parked or spare process. */
  armIdleTimer(ms: number, onExpire: () => void): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(onExpire, ms);
  }

  disarmIdleTimer(): void {
    clearTimeout(this.idleTimer);
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    this.listener = null;
    if (!this.exitedFlag) killHard(this.proc);
    rm(this.cwd, { recursive: true, force: true }).catch((error: unknown) =>
      logError("antigravity-headless", error),
    );
  }
}

// ─── Spares ────────────────────────────────────────────────────────────────
//
// A spare is a process that has started (or is starting) and holds NO
// conversation yet. An unused spare looks upstream like someone opening the
// CLI and closing it (loadCodeAssist + fetchAvailableModels, no generation),
// so the rules keep that rare and always tied to real use:
//   - Started only right after a real request leased a process for the same
//     key, AND only when that key already had another request within the
//     spare TTL — a one-off request never leaves a process behind, and an
//     unused daemon never spawns anything.
//   - Never replaced: an expired spare is not restarted, and when the pool is
//     full no new spare is made (no spare is ever killed to make room).
//   - Keyed by binary + model + the COMPLETE spawn env (sha256; the raw env
//     may carry secrets and is never stored or logged), so another account
//     slot or override never shares one.
//   - Exclusive: leased by exactly one request, then it is that request's
//     conversation and is disposed when the turn ends.
//   - Bounded: at most ANTIGRAVITY_HEADLESS_SPARE_MAX, each killed after
//     ANTIGRAVITY_HEADLESS_SPARE_TTL_MS unused, all killed on daemon exit.

const spares: HeadlessProcess[] = [];
/** Spares decided but still starting: they hold a pool slot from the moment
 *  they are decided, so two close requests can never both pass the room
 *  check and start one more than the pool holds. */
let reservedSpares = 0;
/** Bumped by a full disposal: a spare still starting from before it is
 *  disposed on arrival instead of joining the pool. */
let sparesEpoch = 0;
/** When each key last served a real request (ms epoch). */
const lastRequestAt = new Map<string, number>();

/** Record a real request on `key`; true when a spare is warranted (the key
 *  was already active within `ttlMs` and the pool has room). A true answer
 *  reserves the slot — settle it with {@link addSpare} or
 *  {@link releaseSpareReservation}. */
const noteRequestAndWantSpare = (
  key: string,
  ttlMs: number,
  now: number = Date.now(),
): boolean => {
  const previous = lastRequestAt.get(key);
  // Keys idle past the window can never warrant a spare again: drop them.
  for (const [k, at] of lastRequestAt) {
    if (now - at > ttlMs) lastRequestAt.delete(k);
  }
  lastRequestAt.set(key, now);
  const active = previous !== undefined && now - previous <= ttlMs;
  if (!active) return false;
  if (spares.length + reservedSpares >= ANTIGRAVITY_HEADLESS_SPARE_MAX) {
    return false;
  }
  reservedSpares += 1;
  return true;
};

const releaseSpareReservation = (): void => {
  reservedSpares = Math.max(0, reservedSpares - 1);
};

export const antigravityHeadlessKey = (
  bin: string,
  model: string,
  env: Readonly<Record<string, string>>,
): string => {
  const h = createHash("sha256");
  h.update(bin);
  h.update("\0");
  h.update(model);
  for (const k of Object.keys(env).sort()) {
    h.update("\0");
    h.update(k);
    h.update("=");
    h.update(env[k] ?? "");
  }
  return h.digest("hex");
};

const takeSpare = (key: string): HeadlessProcess | null => {
  const i = spares.findIndex((p) => p.key === key && p.alive);
  if (i < 0) return null;
  const [spare] = spares.splice(i, 1);
  // Leased: its pool expiry must never fire on the request now using it.
  spare?.disarmIdleTimer();
  return spare ?? null;
};

/** Settle a reservation with the started spare (its slot is already held). */
const addSpare = (
  proc: HeadlessProcess,
  ttlMs: number,
  epoch: number,
): void => {
  if (epoch !== sparesEpoch) {
    // The pool was disposed while this one was starting; its reservation
    // was cleared with that pool and is not this epoch's to release.
    proc.dispose();
    return;
  }
  releaseSpareReservation();
  spares.push(proc);
  // A spare that dies while waiting gives its pool slot back at once (a
  // leased one gets its turn's own exit handler instead).
  proc.onExit((): void => {
    const i = spares.indexOf(proc);
    if (i >= 0) spares.splice(i, 1);
    proc.dispose();
  });
  proc.armIdleTimer(ttlMs, () => {
    const i = spares.indexOf(proc);
    if (i >= 0) spares.splice(i, 1);
    proc.dispose();
  });
};

// ─── Parked conversations ──────────────────────────────────────────────────
//
// After a clean turn the process keeps its conversation and is parked under
// that conversation's id, so the client's next message (which resends the
// whole history) is fed as just the new turn on a live process — no start-up,
// and Google's prompt cache is warm (a resumed-by-id process re-sends the
// history: measured 4.2k uncached vs cache reads on a live one).
//   - Keyed by conversation id and checked against the request key (binary +
//     model + env), so another account slot or model never takes it.
//   - Exclusive: leaving the pool for a turn; failures dispose it.
//   - Bounded: ANTIGRAVITY_HEADLESS_PARK_MAX, each killed after
//     ANTIGRAVITY_HEADLESS_PARK_TTL_MS idle. Evicting kills an idle process
//     that served real traffic; it never starts anything.

export const ANTIGRAVITY_HEADLESS_PARK_TTL_MS = 300_000;
export const ANTIGRAVITY_HEADLESS_PARK_MAX = 4;

const parked = new Map<string, HeadlessProcess>();

const takeParked = (
  key: string,
  conversationId: string,
): HeadlessProcess | null => {
  const proc = parked.get(conversationId);
  if (proc === undefined) return null;
  parked.delete(conversationId);
  proc.disarmIdleTimer();
  if (!proc.alive || proc.key !== key) {
    proc.dispose();
    return null;
  }
  return proc;
};

const park = (proc: HeadlessProcess, ttlMs: number): void => {
  const conversationId = proc.conversationId;
  if (conversationId === null || !proc.alive) {
    proc.dispose();
    return;
  }
  proc.route(null);
  parked.get(conversationId)?.dispose();
  parked.delete(conversationId);
  while (parked.size >= ANTIGRAVITY_HEADLESS_PARK_MAX) {
    const oldest = parked.keys().next().value;
    if (oldest === undefined) break;
    parked.get(oldest)?.dispose();
    parked.delete(oldest);
  }
  parked.set(conversationId, proc);
  proc.armIdleTimer(ttlMs, () => {
    if (parked.get(conversationId) === proc) parked.delete(conversationId);
    proc.dispose();
  });
};

export const antigravityHeadlessParkedCount = (): number => parked.size;

export const disposeAntigravityHeadlessSpares = (): void => {
  for (const proc of parked.values()) proc.dispose();
  parked.clear();
  for (const proc of spares.splice(0)) proc.dispose();
  lastRequestAt.clear();
  reservedSpares = 0;
  sparesEpoch += 1;
};

export const antigravityHeadlessSpareCount = (): number => spares.length;

/** Spare starts still between their decision and joining the pool. */
const pendingSpareStarts = new Set<Promise<void>>();

/** Resolves once every spare start already begun has settled (joined the
 *  pool or been disposed) — for shutdown and tests that must see them. */
export const settleAntigravityHeadlessSpareStarts = async (): Promise<void> => {
  await Promise.all([...pendingSpareStarts]);
};

/** The pool's account epoch: bumped by every disposal (sign-in, logout), so
 *  conversations keyed with it never continue across an account change. */
export const antigravityHeadlessEpoch = (): number => sparesEpoch;

process.once("exit", disposeAntigravityHeadlessSpares);

// ─── Turn ──────────────────────────────────────────────────────────────────

export type TAntigravityHeadlessParams = {
  /** The `agy` CLI ({@link resolveAntigravityCli}). */
  readonly bin: string;
  /** Isolated run env (`cliEnv("antigravity")`). */
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly systemText: string | null;
  readonly userText: string;
  readonly hasImages: boolean;
  readonly hasTools: boolean;
  readonly signal: AbortSignal;
  /** Start a spare for the next request after this one leases (default on). */
  readonly spare?: boolean;
  /** Continue this `agy` conversation: a parked process, else
   *  `--conversation <id>`. `userText` is then only the new turn. */
  readonly conversationId?: string | null;
  /** The account epoch the conversation was looked up under
   *  ({@link antigravityHeadlessEpoch}). A sign-in or logout during setup
   *  makes the leased conversation the old account's: start fresh, seeded. */
  readonly epoch?: number;
  /** Told the account epoch the serving process started under, so the
   *  caller publishes the conversation under that generation. */
  readonly onServingEpoch?: (epoch: number) => void;
  /** Told once the turn's prompt has been written to `agy`: from then on
   *  `agy` may hold the turn, even if the run later declines. */
  readonly onPromptSent?: () => void;
  /** Sent instead of `userText` when the conversation could not be resumed
   *  (the full transcript seed). */
  readonly seedText?: string;
  readonly parkTtlMs?: number;
  /** Test overrides. */
  readonly argv?: (bin: string, model: string) => string[];
  /** Profile prep: tool deny rules + tool-less agent (default
   *  {@link prepareAntigravityCliProfile}). */
  readonly ensureSettings?: (home: string) => boolean;
  /** Keychain readiness gate (default {@link ensureKeychainReady}). */
  readonly ensureKeychain?: (home: string) => Promise<TStoreRead<void>>;
  /** Wrap the argv for the daemon sandbox (default {@link sandboxSpawnArgs}
   *  with {@link unwrapAntigravityCliSpawn}). */
  readonly wrapArgv?: (argv: string[]) => string[];
  readonly precommitMs?: number;
  readonly idleMs?: number;
  readonly turnTimeoutMs?: number;
  readonly initTimeoutMs?: number;
  readonly spareTtlMs?: number;
};

/**
 * A decline that sends the request on to `agy acp` (it carries
 * {@link ANTIGRAVITY_HEADLESS_FALLBACK}): what headless can't serve (images,
 * client tools) and unanticipated failures — spawn, start-up, a lost write,
 * an account change while `agy` started. Every other decline (a sign-in
 * miss, quota, a turn that failed after its prompt) is final for this hop:
 * `agy acp` shares the same sign-in, so it would fail the same way.
 */
const fallback = (why: string): TNativeRunResult => ({
  kind: "declined",
  reason: `${ANTIGRAVITY_HEADLESS_FALLBACK}: ${why}`,
});

export const isAntigravityHeadlessFallback = (reason: string): boolean =>
  reason.startsWith(ANTIGRAVITY_HEADLESS_FALLBACK);

/**
 * One turn on a fresh conversation: lease a spare (or spawn one), wait for
 * `init`, send the flattened prompt, stream text deltas. Commit on first
 * output; any pre-commit failure declines (sign-in misses and unsupported
 * shapes decline with {@link ANTIGRAVITY_HEADLESS_FALLBACK}).
 */
export const runAntigravityHeadless = async (
  params: TAntigravityHeadlessParams,
): Promise<TNativeRunResult> => {
  if (params.hasTools) return fallback("client tools");
  if (params.hasImages) return fallback("images");
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  // Never run against the user's real HOME: the isolated home is what keeps
  // the daemon's Google sign-in separate from the user's own `agy`.
  const home = params.env.HOME;
  if (home === undefined || home.length === 0 || home === homedir()) {
    return fallback("no isolated HOME");
  }
  // macOS: `agy` reaches the isolated login keychain through
  // `/usr/bin/security`. A missing keychain raises "Keychain Not Found" and a
  // locked one asks for its password, so nothing spawns unless the readiness
  // gate created/unlocked it on THIS call (spares included). Linux: no-op.
  const keychain = await (params.ensureKeychain ?? ensureKeychainReady)(home);
  if (keychain.kind !== "present") {
    return fallback(`isolated keychain not ready (${keychain.kind})`);
  }
  // The tool-less agent and the tool deny rules must be in place first.
  if (!(params.ensureSettings ?? prepareAntigravityCliProfile)(home)) {
    return fallback("agy settings could not be locked down");
  }
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  const model = params.providerModelId.trim();
  const spawnEnv = antigravitySpawnEnv(params.env);
  const key = antigravityHeadlessKey(params.bin, model, spawnEnv);
  const argvOf = params.argv ?? antigravityHeadlessArgv;
  const wrap =
    params.wrapArgv ??
    ((argv: string[]): string[] =>
      sandboxSpawnArgs(argv, { probe: unwrapAntigravityCliSpawn() }));
  const initTimeoutMs =
    params.initTimeoutMs ?? ANTIGRAVITY_HEADLESS_INIT_TIMEOUT_MS;
  const spawn = async (
    extra: ReadonlyArray<string> = [],
  ): Promise<HeadlessProcess> => {
    const cwd = await mkdtemp(join(daemonTempDir(), "agy-h-"));
    try {
      return new HeadlessProcess(
        key,
        wrap([...argvOf(params.bin, model), ...extra]),
        spawnEnv,
        cwd,
        initTimeoutMs,
      );
    } catch (error) {
      // No process owns the scratch dir: remove it, keep the spawn error.
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  };

  const requestedId = params.conversationId ?? null;
  const accountChanged =
    params.epoch !== undefined && params.epoch !== sparesEpoch;
  const resumeId = accountChanged ? null : requestedId;
  // The account this process starts under: a change while it starts means
  // it may hold the old account's sign-in or conversation.
  const spawnEpoch = sparesEpoch;
  params.onServingEpoch?.(spawnEpoch);
  let proc: HeadlessProcess;
  try {
    proc =
      resumeId !== null
        ? (takeParked(key, resumeId) ??
          (await spawn(["--conversation", resumeId])))
        : (takeSpare(key) ?? (await spawn()));
  } catch (error) {
    return fallback(
      `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // This request used a process: when the key is in active use, start the
  // next one now so the following request skips start-up (spare rules above).
  const spareTtlMs = params.spareTtlMs ?? ANTIGRAVITY_HEADLESS_SPARE_TTL_MS;
  // Spares serve NEW conversations only; a continuing one has its own process.
  if (
    resumeId === null &&
    params.spare !== false &&
    noteRequestAndWantSpare(key, spareTtlMs)
  ) {
    const epoch = sparesEpoch;
    const start = spawn().then(
      (next) => addSpare(next, spareTtlMs, epoch),
      () => {
        if (epoch === sparesEpoch) releaseSpareReservation();
      },
    );
    pendingSpareStarts.add(start);
    void start.finally(() => pendingSpareStarts.delete(start));
  }

  type TItem =
    | TChatCompletionChunk
    | "end"
    | { readonly failure: THeadlessFailure };
  const queue: TItem[] = [];
  let wake: (() => void) | null = null;
  const push = (item: TItem): void => {
    // A reader that stopped reading: end the turn rather than buffer the
    // rest of the reply in memory.
    // (Terminal items arrive after `ended` is set: they always fit, so a
    // full queue never swallows the final usage chunk.)
    if (
      !ended &&
      typeof item === "object" &&
      !("failure" in item) &&
      queue.length >= ANTIGRAVITY_HEADLESS_MAX_QUEUED
    ) {
      fail({ reason: "antigravity reader stopped reading", fallback: false });
      return;
    }
    queue.push(item);
    wake?.();
    wake = null;
  };
  let ended = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  /** `keep`: the turn ended cleanly — park the process with its
   *  conversation. Anything else disposes it. */
  const settle = (keep: boolean): void => {
    clearTimeout(idleTimer);
    clearTimeout(turnTimer);
    params.signal.removeEventListener("abort", abort);
    // A sign-in or logout during the turn: the process is the old
    // account's, so it never parks.
    if (keep && spawnEpoch === sparesEpoch) {
      park(proc, params.parkTtlMs ?? ANTIGRAVITY_HEADLESS_PARK_TTL_MS);
    } else proc.dispose();
  };
  const end = (items: ReadonlyArray<TItem>, keep = false): void => {
    if (ended) return;
    ended = true;
    proc.onExit(null);
    for (const item of items) push(item);
    settle(keep);
  };
  const fail = (failure: THeadlessFailure): void => end([{ failure }]);
  const abort = (): void => fail({ reason: "client aborted", fallback: false });
  params.signal.addEventListener("abort", abort, { once: true });
  // The client may have gone while the process was being spawned.
  if (params.signal.aborted) abort();

  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => fail({ reason: "antigravity turn idle timeout", fallback: false }),
      params.idleMs ?? ANTIGRAVITY_HEADLESS_IDLE_TIMEOUT_MS,
    );
  };

  const ready = await proc.initialized;
  // A sign-in or logout during start-up: this process may hold the old
  // account's conversation. Never serve on it.
  if (ready && !ended && spawnEpoch !== sparesEpoch) {
    ended = true;
    proc.onExit(null);
    // settle(false) disposes the process AND drops the abort listener.
    settle(false);
    return fallback("account changed while agy started");
  }
  if (!ready || ended) {
    if (!ended) {
      ended = true;
      settle(false);
    }
    return params.signal.aborted
      ? { kind: "declined", reason: "client aborted" }
      : fallback("agy did not start");
  }

  // A resume that came back as another conversation lost the history: send
  // the full seed instead of only the new turn.
  const resumed = resumeId !== null && proc.conversationId === resumeId;
  const userText =
    requestedId !== null && !resumed
      ? (params.seedText ?? params.userText)
      : params.userText;
  const promptText =
    params.systemText !== null && !resumed
      ? `${params.systemText}\n\n${userText}`
      : userText;
  const turn = createAcpTurnState({
    providerModelId: params.providerModelId,
    promptText,
  });

  // Whether answer TEXT streamed (thinking alone does not count): a result's
  // `response` is used only when it did not.
  let sawText = false;
  proc.route((event) => {
    if (ended) return;
    armIdle();
    if (event.kind === "step") {
      if (!RESPONSE_STEP_TYPES.has(event.stepType)) {
        // The agent reached for one of ITS tools — never let it run.
        fail({
          reason: `${ANTIGRAVITY_HEADLESS_FALLBACK}: agy attempted a native tool (${event.stepType})`,
          fallback: true,
        });
        return;
      }
      if (event.thinkingDelta) {
        const chunk = turn.handleUpdate({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: event.thinkingDelta },
        });
        if (chunk !== null) push(chunk);
      }
      if (event.textDelta) {
        sawText = true;
        const chunk = turn.handleUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.textDelta },
        });
        if (chunk !== null) push(chunk);
      }
      return;
    }
    if (event.kind === "result") {
      if (!event.ok) {
        fail(classifyHeadlessFailure(event.error));
        return;
      }
      // A reply with no streamed text (none, or thinking only) still carries
      // its answer here.
      if (!sawText && event.response) {
        const chunk = turn.handleUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.response },
        });
        if (chunk !== null) push(chunk);
      }
      if (!turn.sawOutput()) {
        fail({
          reason: "antigravity turn ended before producing output",
          fallback: false,
        });
        return;
      }
      // This turn's own usage: the session total minus the previous result's.
      const usage =
        event.usage === null || proc.usageBaselineStale
          ? null
          : turnUsageOf(event.usage, proc.usageBaseline);
      if (event.usage !== null) {
        proc.usageBaseline = event.usage;
        proc.usageBaselineStale = false;
      } else if (proc.usageBaseline !== null) {
        proc.usageBaselineStale = true;
      }
      if (usage !== null) {
        turn.handleUpdate({
          sessionUpdate: "usage_update",
          used: usage.input + usage.cacheRead + usage.output,
        });
      } else if (event.totalTokens !== null && proc.usageBaseline === null) {
        turn.handleUpdate({
          sessionUpdate: "usage_update",
          used: event.totalTokens,
        });
      }
      const terminal = turn.finish("end_turn");
      // The exact split `agy` reported (cache reads, thinking) replaces the
      // shared turn state's total-only estimate on the terminal chunk.
      const exact =
        usage === null
          ? terminal
          : terminal.map((chunk) =>
              "usage" in chunk && chunk.usage !== undefined
                ? ({
                    ...chunk,
                    usage: openAiUsageOf(usage),
                  } as TChatCompletionChunk)
                : chunk,
            );
      end([...exact, "end"], true);
    }
  });
  // Exit mid-turn surfaces as a failure rather than a hang.
  proc.onExit(() => {
    if (!ended) fail({ reason: "agy exited mid-turn", fallback: false });
  });

  // Only a write that never reached agy may fall back to ACP: once the
  // prompt was handed off, agy may hold the turn, and ACP running it again
  // would answer it twice.
  let handedOff = false;
  const writeFailed = (error: unknown): void => {
    const why = error instanceof Error ? error.message : String(error);
    if (handedOff) {
      fail({ reason: `antigravity write failed: ${why}`, fallback: false });
      return;
    }
    fail({
      reason: `${ANTIGRAVITY_HEADLESS_FALLBACK}: write failed: ${why}`,
      fallback: true,
    });
  };
  if (!ended) {
    try {
      proc.send(promptText, writeFailed);
      handedOff = true;
      params.onPromptSent?.();
    } catch (error) {
      writeFailed(error);
    }
  }
  // A turn that already ended (exit, abort, write failure) arms nothing.
  if (!ended) {
    armIdle();
    turnTimer = setTimeout(
      () => fail({ reason: "antigravity turn timed out", fallback: false }),
      params.turnTimeoutMs ?? ANTIGRAVITY_HEADLESS_TURN_TIMEOUT_MS,
    );
  }

  const next = async (): Promise<TItem> => {
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) return item;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  let precommitTimer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    next(),
    new Promise<"timeout">((resolve) => {
      precommitTimer = setTimeout(
        () => resolve("timeout"),
        params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS,
      );
    }),
  ]);
  clearTimeout(precommitTimer);
  if (first === "timeout") {
    fail({ reason: "antigravity produced no output in time", fallback: false });
    return {
      kind: "declined",
      reason:
        "antigravity headless produced no output before the pre-commit deadline",
    };
  }
  if (first === "end" || "failure" in first) {
    const failure =
      first === "end"
        ? {
            reason: "antigravity turn ended before producing output",
            fallback: false,
          }
        : first.failure;
    const raw =
      "cooldown" in failure && failure.cooldown !== undefined
        ? failure.cooldown
        : undefined;
    // Any failure (auth, quota, payment) from a process started under a
    // superseded sign-in is the old account's: it never cools the hop the
    // new account serves.
    const cooldown = spawnEpoch !== sparesEpoch ? undefined : raw;
    return {
      kind: "declined",
      reason: failure.reason,
      ...(cooldown !== undefined ? { cooldownReason: cooldown } : {}),
    };
  }

  const chunks = new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      const item = await next();
      if (item === "end") controller.close();
      else if ("failure" in item)
        controller.error(new Error(item.failure.reason));
      else controller.enqueue(item);
    },
    cancel() {
      abort();
    },
  });
  return {
    kind: "committed",
    chunks,
    sessionId: () => proc.conversationId,
  };
};
