/**
 * Google Antigravity over the official `agy` CLI in headless stream-json mode
 * (`--input-format stream-json --output-format stream-json`). Documented at
 * antigravity.google/docs/cli/headless; no token reads, no direct endpoint
 * calls — the CLI does its own auth and inference.
 *
 * Why not ACP (`agy_acp_server`, `antigravity-acp.ts`): measured back to back
 * on the same model, ACP releases the reply only once it is complete (the
 * harness holds it; first text ≈ the headless run's LAST text), while this
 * mode streams ~25 ms text deltas from ~1.8 s after the prompt. See
 * docs/plans/antigravity-headless-transport.md.
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
 * Phase 1 scope: plain text turns. Client tools and images decline with
 * {@link ANTIGRAVITY_HEADLESS_FALLBACK} so `serve.ts` runs the ACP bridge.
 * Any native-tool step cancels the turn the same way.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TChatCompletionChunk } from "@openllmsh/sdk/protocol";
import type { TStoreRead } from "../delegation/util";
import { ensureKeychainReady } from "../delegation/util";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapAntigravityCliSpawn } from "../sandbox/policy";
import { daemonTempDir } from "../sandbox/working-set";
import { antigravitySpawnEnv } from "./antigravity-acp";
import { ensureAntigravityCliSettings } from "./antigravity-cli-settings";
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

const SIGN_IN_RE = /not logged in|sign in|signed out|authentication failed/i;
const QUOTA_RE = /quota|exhausted|rate.?limit|resource.?exhausted|429/i;
const PLAN_RE = /subscription|not eligible|tier|upgrade|license/i;

// ─── Binary ────────────────────────────────────────────────────────────────

/** The `agy` CLI: explicit override, the official installer's launcher, PATH. */
export const resolveAntigravityCli = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string | null => {
  const override = env.OPENLLM_AGY_BIN;
  if (override !== undefined && override.length > 0) {
    return existsSync(override) ? override : null;
  }
  const launcher = join(home, ".local", "bin", "agy");
  if (existsSync(launcher)) return launcher;
  return Bun.which("agy");
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
  "--disable-slash-commands",
];

// ─── Event parsing (pure) ──────────────────────────────────────────────────

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
    return {
      kind: "result",
      ok: str(r.status)?.toUpperCase() === "SUCCESS",
      error: str(r.error),
      response: str(r.response),
      totalTokens:
        typeof total === "number" && Number.isSafeInteger(total) && total > 0
          ? total
          : null,
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

/** Classify a non-SUCCESS `result` error. A sign-in miss falls back to ACP
 *  (its own sign-in may be live) — every other failure is the account's. */
export const classifyHeadlessFailure = (
  error: string | null,
): THeadlessFailure => {
  const msg = error ?? "antigravity turn failed";
  if (SIGN_IN_RE.test(msg)) {
    return {
      reason: `${ANTIGRAVITY_HEADLESS_FALLBACK}: agy CLI not signed in`,
      fallback: true,
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
  private spareTimer: ReturnType<typeof setTimeout> | undefined;

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
    this.initialized = new Promise<boolean>((resolve) => {
      resolveInit = resolve;
    });
    const initTimer = setTimeout(() => resolveInit(false), initTimeoutMs);
    this.listener = (e) => {
      if (e.kind === "init") {
        clearTimeout(initTimer);
        resolveInit(true);
      }
    };
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>);
    void this.proc.exited.then(() => {
      this.exitedFlag = true;
      clearTimeout(initTimer);
      resolveInit(false);
    });
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
          const event = parseHeadlessLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (event !== null) this.listener?.(event);
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

  send(text: string): void {
    const stdin = this.proc.stdin as {
      write: (s: string) => void;
      flush?: () => void;
    };
    stdin.write(
      `${JSON.stringify({ event: "user", message: { content: text } })}\n`,
    );
    stdin.flush?.();
  }

  armSpareTimer(ms: number, onExpire: () => void): void {
    clearTimeout(this.spareTimer);
    this.spareTimer = setTimeout(onExpire, ms);
  }

  dispose(): void {
    clearTimeout(this.spareTimer);
    this.listener = null;
    if (!this.exitedFlag) this.proc.kill();
    void rm(this.cwd, { recursive: true, force: true });
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
  return spare ?? null;
};

/** Settle a reservation with the started spare (its slot is already held). */
const addSpare = (
  proc: HeadlessProcess,
  ttlMs: number,
  epoch: number,
): void => {
  releaseSpareReservation();
  if (epoch !== sparesEpoch) {
    // The pool was disposed while this one was starting.
    proc.dispose();
    return;
  }
  spares.push(proc);
  proc.armSpareTimer(ttlMs, () => {
    const i = spares.indexOf(proc);
    if (i >= 0) spares.splice(i, 1);
    proc.dispose();
  });
};

export const disposeAntigravityHeadlessSpares = (): void => {
  for (const proc of spares.splice(0)) proc.dispose();
  lastRequestAt.clear();
  reservedSpares = 0;
  sparesEpoch += 1;
};

export const antigravityHeadlessSpareCount = (): number => spares.length;

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
  /** Test overrides. */
  readonly argv?: (bin: string, model: string) => string[];
  /** Tool lockdown (default {@link ensureAntigravityCliSettings}). */
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
  // `agy`'s built-in tools must be denied before it starts.
  if (!(params.ensureSettings ?? ensureAntigravityCliSettings)(home)) {
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
  const spawn = async (): Promise<HeadlessProcess> => {
    const cwd = await mkdtemp(join(daemonTempDir(), "agy-h-"));
    return new HeadlessProcess(
      key,
      wrap(argvOf(params.bin, model)),
      spawnEnv,
      cwd,
      initTimeoutMs,
    );
  };

  let proc: HeadlessProcess;
  try {
    proc = takeSpare(key) ?? (await spawn());
  } catch (error) {
    return fallback(
      `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // This request used a process: when the key is in active use, start the
  // next one now so the following request skips start-up (spare rules above).
  const spareTtlMs = params.spareTtlMs ?? ANTIGRAVITY_HEADLESS_SPARE_TTL_MS;
  if (params.spare !== false && noteRequestAndWantSpare(key, spareTtlMs)) {
    const epoch = sparesEpoch;
    void spawn().then(
      (next) => addSpare(next, spareTtlMs, epoch),
      () => releaseSpareReservation(),
    );
  }

  const promptText =
    params.systemText !== null
      ? `${params.systemText}\n\n${params.userText}`
      : params.userText;
  const turn = createAcpTurnState({
    providerModelId: params.providerModelId,
    promptText,
  });

  type TItem =
    | TChatCompletionChunk
    | "end"
    | { readonly failure: THeadlessFailure };
  const queue: TItem[] = [];
  let wake: (() => void) | null = null;
  const push = (item: TItem): void => {
    queue.push(item);
    wake?.();
    wake = null;
  };
  let ended = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (): void => {
    clearTimeout(idleTimer);
    clearTimeout(turnTimer);
    params.signal.removeEventListener("abort", abort);
    // One conversation per process: it never serves another request.
    proc.dispose();
  };
  const end = (items: ReadonlyArray<TItem>): void => {
    if (ended) return;
    ended = true;
    for (const item of items) push(item);
    settle();
  };
  const fail = (failure: THeadlessFailure): void => end([{ failure }]);
  const abort = (): void => fail({ reason: "client aborted", fallback: false });
  params.signal.addEventListener("abort", abort, { once: true });

  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => fail({ reason: "antigravity turn idle timeout", fallback: false }),
      params.idleMs ?? ANTIGRAVITY_HEADLESS_IDLE_TIMEOUT_MS,
    );
  };

  const ready = await proc.initialized;
  if (!ready || ended) {
    if (!ended) {
      ended = true;
      settle();
    }
    return params.signal.aborted
      ? { kind: "declined", reason: "client aborted" }
      : fallback("agy did not start");
  }

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
      // A reply with no streamed deltas still carries its text here.
      if (!turn.sawOutput() && event.response) {
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
      if (event.totalTokens !== null) {
        turn.handleUpdate({
          sessionUpdate: "usage_update",
          used: event.totalTokens,
        });
      }
      end([...turn.finish("end_turn"), "end"]);
    }
  });
  // Exit mid-turn surfaces as a failure rather than a hang.
  void proc.exited.then(() => {
    if (!ended) fail({ reason: "agy exited mid-turn", fallback: false });
  });

  try {
    proc.send(promptText);
  } catch (error) {
    fail({
      reason: `${ANTIGRAVITY_HEADLESS_FALLBACK}: write failed: ${error instanceof Error ? error.message : String(error)}`,
      fallback: true,
    });
  }
  armIdle();
  turnTimer = setTimeout(
    () => fail({ reason: "antigravity turn timed out", fallback: false }),
    params.turnTimeoutMs ?? ANTIGRAVITY_HEADLESS_TURN_TIMEOUT_MS,
  );

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
    return {
      kind: "declined",
      reason: failure.reason,
      ...("cooldown" in failure && failure.cooldown !== undefined
        ? { cooldownReason: failure.cooldown }
        : {}),
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
  return { kind: "committed", chunks, sessionId: () => null };
};
