/**
 * Transport-neutral device-session state machine.
 *
 * Owns PTY session state, stream fan-out, scrollback, replay, lag control, and
 * idle reaping. Transport adapters turn their own protocol into TSessionStream
 * or call openSession; this module never imports relay frame types.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type {
  TDeviceSessionCli,
  TSessionStreamOpenPayload,
} from "@openllmsh/protocol";
import {
  DANGEROUS_SESSION_CLIS,
  parseStreamCtrlPayload,
  SESSION_ID_PATTERN,
} from "@openllmsh/protocol";
import { decodeJsonPayload, encodeJsonPayload } from "@openllmsh/tunnel/codec";
import { Terminal } from "@xterm/headless";
import { sessionEnv } from "./cli-paths";
import { resolveOpenllmCli } from "./cli-self-update";
import { spawnEnv } from "./delegation/spawn";
import { loadEnvFile } from "./env";
import {
  openllmClientIdOf,
  pushDeviceCliResumeArgs,
} from "./local-sessions/types";
import { logDebug, logInfo, logWarn } from "./logger";
import { serializeScreenBytes } from "./session-screen";

/** Max concurrently-LIVE PTYs in one session-host process. */
const MAX_LIVE_SESSIONS = 4;

/** Retained dead (resumable) session records cap — evict oldest beyond this. */
const MAX_RETAINED_SESSIONS = 32;

/** Vendor session ids accepted for cold resume: url-safe, no leading dash. */
export const RESUME_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

/** Scrollback ring cap — enough to repaint a screenful+history on attach
 *  without unbounded memory. */
const SCROLLBACK_MAX_BYTES = 1024 * 1024;

/** One stalled viewer must not retain unbounded PTY output. */
const CONSUMER_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

/** Reaped children get time to flush their transcript before forcible exit. */
const REAP_KILL_GRACE_MS = 10_000;

/** Shared emulator scrollback (rows). The durable screen for attach replay. */
const EMULATOR_SCROLLBACK_ROWS = 5000;

// The PTY has ONE size, so with several viewers attached one of them has to
// decide it. That is the PRIMARY, and primacy moves on exactly two signals:
// a `focus` claim, and an explicit `resize`. Both are deliberate acts on a
// specific viewer.
//
// Typing deliberately does NOT move it. It used to — the input path re-ran
// election on every keystroke, guarded by a shrink rule, a "did these dims come
// from a real resize" flag, and a debounce window. Between two attached viewers
// that alternated the canonical size as you typed, so the PTY was re-sized and
// the passive viewer re-serialized mid-keystroke. The guards were all attempts
// to tame a signal that should not have been driving size in the first place.

/** Coalescing window for the manual SIGWINCH fan-out. A drag-resize emits many
 *  resize CTRLs per second; the child only needs the final geometry. */
const WINCH_DEBOUNCE_MS = 40;

/** Refresh the process tree less often than resize events. */
const WINCH_PROCESS_TREE_REFRESH_MS = 1_000;

/** Detached idle timeout. Zero deliberately restores never-reap behavior. */
const DEFAULT_SESSION_IDLE_TIMEOUT_MIN = 60;

const sessionIdleTimeoutMs = (): number => {
  loadEnvFile();
  const raw = process.env.OPENLLM_SESSION_IDLE_TIMEOUT_MIN;
  if (raw === undefined) return DEFAULT_SESSION_IDLE_TIMEOUT_MIN * 60_000;
  const minutes = Number(raw.trim());
  return Number.isFinite(minutes) && minutes >= 0
    ? Math.floor(minutes * 60_000)
    : DEFAULT_SESSION_IDLE_TIMEOUT_MIN * 60_000;
};

// ─── PTY abstraction (injectable for CI — no PTY there) ──────────────

export type TPtyLike = {
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  readonly pid?: number;
};

export type TPtySpawnArgs = {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
  readonly onData: (chunk: Uint8Array) => void;
  readonly onExit: (exitCode?: number) => void;
};

export type TPtySpawner = (args: TPtySpawnArgs) => TPtyLike;

/**
 * Transport-neutral endpoint of a device session. Keeping this structural means
 * the local broker can reuse the exact mux lifecycle without becoming mux wire.
 */
export type TSessionStream = {
  readonly write: (bytes: Uint8Array) => Promise<void>;
  readonly sendCtrl: (payload: Uint8Array) => void;
  readonly reset: (payload?: Uint8Array) => void;
  readonly end: () => void;
  readonly onData: (handler: (payload: Uint8Array) => unknown) => () => void;
  readonly onCtrl: (handler: (payload: Uint8Array) => unknown) => () => void;
  readonly onReset: (handler: (payload: Uint8Array) => unknown) => () => void;
  readonly onEnd: (handler: () => void) => () => void;
};

/**
 * Argv for a device "Terminal" session. Login+interactive (`-il`) so profile
 * PATH loads and bash/zsh treat stdin as a tty. `fish` is already interactive
 * on a tty; `-il` is not its flag set.
 */
export const shellSessionArgv = (shellPath: string): readonly string[] => {
  const name = basename(shellPath).toLowerCase();
  if (name === "fish") return [shellPath, "-l"];
  return [shellPath, "-il"];
};

/** Production spawner over Bun's built-in PTY. */
const bunPtySpawner: TPtySpawner = (args) => {
  const terminal = new Bun.Terminal({
    cols: args.cols,
    rows: args.rows,
    name: "xterm-256color",
    data: (_t, chunk) => args.onData(chunk),
  });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...args.argv], {
      cwd: args.cwd,
      env: spawnEnv(args.env),
      terminal,
      // New session + process-group leader so the PTY can become the
      // controlling tty (TIOCSCTTY). Without this, bash -il prints
      // "cannot set terminal process group" / "no job control".
      detached: true,
    });
  } catch (err) {
    // Spawn threw (ENOENT etc.) — the terminal was already created above;
    // close it so the failed attempt doesn't leak a PTY fd.
    terminal.close();
    throw err;
  }
  void proc.exited.then((exitCode) => {
    try {
      args.onExit(exitCode);
    } finally {
      // A throwing exit handler must never leak the PTY fd.
      terminal.close();
    }
  });
  return {
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: (signal = "SIGTERM") => {
      try {
        proc.kill(signal);
      } catch {
        /* already gone */
      }
    },
    pid: proc.pid,
  };
};

let spawner: TPtySpawner = bunPtySpawner;
export const setPtySpawner = (fn: TPtySpawner | null): void => {
  spawner = fn ?? bunPtySpawner;
};

export const ptySupported = (): boolean => process.platform !== "win32";

// ─── session state ───────────────────────────────────────────────────

type TAttachedConsumer = {
  readonly stream: TSessionStream;
  /** Removes this consumer's transport event bindings on detach. */
  readonly unsubscribe: Array<() => void>;
  writeTail: Promise<void>;
  queuedBytes: number;
  exitHandler: ((code: number) => void) | null;
  /** This consumer's viewport size (may differ from the canonical PTY size). */
  cols: number;
  rows: number;
  /** When this consumer last focused or resized. Only used to pick a successor
   *  when the primary leaves — the most recently focused viewer takes over. */
  lastActiveAtMs: number;
};

export type TSession = {
  readonly id: string;
  readonly cli: TDeviceSessionCli;
  /** Absolute cwd the CLI was (last) spawned in. */
  cwd: string;
  /** Vendor resume id when known (cold resume / continue). */
  vendorSessionId: string | null;
  pty: TPtyLike | null; // null = dead (continue-able)
  scrollback: Uint8Array[];
  scrollbackBytes: number;
  /** Shared source-of-truth screen (the canonical-size emulator). Created
   *  lazily on first PTY spawn; disposed on PTY exit. Null on no-PTY paths. */
  emulator: Terminal | null;
  /** Canonical size — == the primary consumer's size == PTY winsize ==
   *  shared emulator size. */
  canonicalCols: number;
  canonicalRows: number;
  /** The consumer driving the PTY size: whichever viewer focused or resized
   *  most recently. Input never changes this. */
  primaryConsumer: TAttachedConsumer | null;
  /** Every active mux or broker consumer. */
  consumers: Set<TAttachedConsumer>;
  outSeq: number;
  startedAtMs: number;
  detachedAtMs: number | null;
  lastOutputAtMs: number;
  lastBusyAtMs: number;
  busy: boolean;
  title: string | null;
  pid: number | null;
  /** Daemon-minted monotonically increasing value for successful opens. */
  generation: number;
  /** Terminal state retained so a later attach can explain why it cannot resume. */
  lastExitReason: "evicted" | "reaped" | "done" | "killed" | null;
  /** Child status, when Bun's PTY-backed process supplied one. */
  exitCode: number | null;
};

const sessions = new Map<string, TSession>();
let nextSessionGeneration = 0;

type TSessionLifecycleHooks = {
  readonly onSpawn: (session: TSession) => void;
  readonly onEnd: (session: TSession) => void;
};

let lifecycleHooks: TSessionLifecycleHooks = {
  onSpawn: () => {},
  onEnd: () => {},
};

/** Adapter seam for daemon pidfiles or standalone-host persistence. */
export const setSessionLifecycleHooks = (
  hooks: TSessionLifecycleHooks | null,
): void => {
  lifecycleHooks = hooks ?? { onSpawn: () => {}, onEnd: () => {} };
};

type TActivityProbe = (rootPids: ReadonlySet<number>) => Promise<Set<number>>;
let activityProbe: TActivityProbe | null = null;
let activityHook: (() => void) | null = null;

export const setActivityProbe = (probe: TActivityProbe | null): void => {
  activityProbe = probe;
};

/** Optional hook fired when a detached session transitions busy → quiet.
 *  Used for status push refresh. */
export const setSessionActivityHook = (hook: (() => void) | null): void => {
  activityHook = hook;
};

const probeActivity = async (
  rootPids: ReadonlySet<number>,
): Promise<Set<number>> => {
  if (activityProbe !== null) return activityProbe(rootPids);
  const proc = Bun.spawn(["ps", "-Ao", "pid=,ppid=,pcpu="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("ps exited nonzero");
  const rows = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/));
  const parent = new Map<number, number>();
  const cpu = new Map<number, number>();
  for (const row of rows) {
    const [pidText, parentText, cpuText] = row;
    const pid = Number(pidText);
    const ppid = Number(parentText);
    const percent = Number(cpuText);
    if (
      !Number.isInteger(pid) ||
      !Number.isInteger(ppid) ||
      !Number.isFinite(percent)
    )
      throw new Error("unparseable ps output");
    parent.set(pid, ppid);
    cpu.set(pid, percent);
  }
  const busy = new Set<number>();
  for (const root of rootPids) {
    let total = 0;
    for (const [pid, percent] of cpu) {
      let current: number | undefined = pid;
      let hops = 0;
      const visited = new Set<number>();
      while (
        current !== undefined &&
        current !== 0 &&
        hops < 4_096 &&
        !visited.has(current)
      ) {
        if (current === root) {
          total += percent;
          break;
        }
        visited.add(current);
        const next = parent.get(current);
        if (next === current) break;
        current = next;
        hops += 1;
      }
    }
    if (total > 1) busy.add(root);
  }
  return busy;
};

const isAttached = (session: TSession): boolean => session.consumers.size > 0;

const scheduleReapKill = (session: TSession, pty: TPtyLike): void => {
  const timer = setTimeout(() => {
    if (session.pty !== pty) return;
    try {
      pty.kill("SIGKILL");
    } catch {
      // The child generally exits after SIGTERM; escalation is best-effort.
    }
  }, REAP_KILL_GRACE_MS);
  timer.unref?.();
};

const reapIdleSession = (session: TSession): void => {
  const pty = session.pty;
  if (
    pty === null ||
    isAttached(session) ||
    session.lastExitReason === "reaped"
  )
    return;
  session.lastExitReason = "reaped";
  try {
    pty.kill("SIGTERM");
  } catch {
    // A raced exit will be reconciled by its onExit callback.
  }
  scheduleReapKill(session, pty);
  logDebug("session", "session reaped after detached idle timeout", {
    id: session.id,
  });
};

/** Poll detached process trees and reap only detached, output-quiet, non-busy sessions. */
export const pollSessionActivity = async (now = Date.now()): Promise<void> => {
  const dormant = [...sessions.values()].filter(
    (session) => session.pty !== null && !isAttached(session),
  );
  if (dormant.length === 0) return;
  const pids = new Set<number>();
  for (const session of dormant) {
    // A dormant session without a known pid can't be probed — mark it busy
    // (conservative: never reaped on unknown) but keep probing the rest.
    if (session.pid === null) {
      session.busy = true;
      session.lastBusyAtMs = now;
      continue;
    }
    pids.add(session.pid);
  }
  if (pids.size === 0) return;
  let busyPids: Set<number>;
  try {
    busyPids = await probeActivity(pids);
  } catch (error) {
    logWarn(
      "session",
      `activity probe failed; retaining sessions: ${error instanceof Error ? error.message : String(error)}`,
    );
    for (const session of dormant) {
      session.busy = true;
      session.lastBusyAtMs = now;
    }
    return;
  }
  const timeoutMs = sessionIdleTimeoutMs();
  for (const session of dormant) {
    if (session.pid === null) continue; // already marked busy above
    const isBusy = busyPids.has(session.pid);
    if (isBusy) session.lastBusyAtMs = now;
    if (session.busy && !isBusy) activityHook?.();
    session.busy = isBusy;
    if (
      timeoutMs > 0 &&
      !isBusy &&
      !isAttached(session) &&
      now - session.lastOutputAtMs > timeoutMs &&
      now - session.lastBusyAtMs > timeoutMs
    ) {
      reapIdleSession(session);
    }
  }
};

/** Status report for `DaemonStatus.sessions`. */
export const sessionStatusReport = (): Array<{
  id: string;
  cli: TDeviceSessionCli;
  started_at_ms: number;
  attached: boolean;
  live: boolean;
  busy: boolean;
  title?: string;
  last_exit_reason?: "evicted" | "reaped" | "done" | "killed";
  vendor_session_id?: string | null;
}> =>
  [...sessions.values()]
    .sort((a, b) => b.startedAtMs - a.startedAtMs)
    .slice(0, 12)
    .map((s) => ({
      id: s.id,
      cli: s.cli,
      started_at_ms: s.startedAtMs,
      attached: isAttached(s),
      live: s.pty !== null,
      busy: s.busy,
      ...(s.title === null ? {} : { title: s.title.slice(0, 80) }),
      ...(s.lastExitReason === null
        ? {}
        : { last_exit_reason: s.lastExitReason }),
      ...(s.vendorSessionId === null
        ? {}
        : { vendor_session_id: s.vendorSessionId }),
    }));

/**
 * Snapshot of in-memory device PTYs for `list_local_sessions` merge.
 * Exported so the control command can join vendor history with live PTYs.
 */
export const deviceSessionsForList = (): ReadonlyArray<{
  readonly id: string;
  readonly cli: TDeviceSessionCli;
  readonly live: boolean;
  readonly title: string | null;
  readonly vendor_session_id: string | null;
  readonly cwd: string;
  readonly started_at_ms: number;
}> =>
  [...sessions.values()].map((s) => ({
    id: s.id,
    cli: s.cli,
    live: s.pty !== null,
    title: s.title,
    vendor_session_id: s.vendorSessionId,
    cwd: s.cwd,
    started_at_ms: s.startedAtMs,
  }));

const liveCount = (): number =>
  [...sessions.values()].filter((s) => s.pty !== null).length;

/**
 * Device CLI → `openllm <client>` id. Only clients the openllm CLI hosts
 * are mappable; others fall back to the host vendor binary.
 *
 * Precondition guard: only reached after `argvFor` early-returns for `shell`.
 * The throw is the unreachable-shell contract; `openllmClientIdOf` is total.
 */
const openllmClientId = (cli: TDeviceSessionCli): string => {
  const id = openllmClientIdOf(cli);
  if (id === null) throw new Error("shell is not an openllm client");
  return id;
};

/**
 * Whether `openllm -d <client>` is meaningful. Reuses the canonical
 * `DANGEROUS_SESSION_CLIS` set from protocol so the daemon and picker share
 * ONE membership list (claude/codex/grok — not opencode).
 */
export const sessionSupportsDangerous = (cli: TDeviceSessionCli): boolean =>
  DANGEROUS_SESSION_CLIS.has(cli);

/** Resolve the openllm CLI binary (dev override, then current, then legacy). */
const openllmBin = (): string | null => resolveOpenllmCli();

/** Append vendor cold-resume flags for a known session id. */
const pushResumeArgs = (
  args: string[],
  cli: TDeviceSessionCli,
  vendorSessionId: string,
): void => {
  pushDeviceCliResumeArgs(args, cli, vendorSessionId);
};

/**
 * The CLI's argv for a session start.
 *
 * Preferred path: `openllm [-d] <client> [resume flags]` so device sessions
 * get the same overlay/gateway wiring as a local `openllm claude` launch.
 * Cold resume uses vendor resume-by-id; continue without a known id falls
 * back to claude `--continue` only.
 */
const argvFor = (
  cli: TDeviceSessionCli,
  mode: "spawn" | "continue",
  dangerous: boolean,
  vendorSessionId: string | null,
  vendorArgs: readonly string[] = [],
): ReadonlyArray<string> => {
  if (cli === "shell") {
    const shell =
      process.env.SHELL ??
      (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    if (!existsSync(shell))
      throw new Error(`login shell does not exist: ${shell}`);
    return shellSessionArgv(shell);
  }
  const clientId = openllmClientId(cli);
  const bin = openllmBin();
  const canDangerous = dangerous && sessionSupportsDangerous(cli);
  // Preferred path: openllm wrapper when installed. An injected (test) spawner
  // never execs the argv, so it stands in for the missing binary — the real
  // spawner is gated on an installed CLI at the call site.
  if (bin === null && spawner === bunPtySpawner) {
    // A direct vendor launch would bypass OpenLLM's gateway/catalog/config
    // overlay. Callers reject the missing CLI binary before this can run.
    throw new Error("OpenLLM CLI is not installed");
  }
  const args: string[] = bin === null ? [] : [bin];
  if (canDangerous) args.push("-d");
  args.push(clientId);
  if (vendorSessionId !== null) {
    pushResumeArgs(args, cli, vendorSessionId);
  } else if (mode === "continue" && cli === "claude_code") {
    args.push("--continue");
  } else if (cli === "hermes" && vendorSessionId === null) {
    args.push("--tui");
  }
  args.push(...vendorArgs);
  return args;
};

/**
 * Resolve the spawn cwd. New sessions → `$HOME`. Resume may pass an absolute
 * existing directory; relative / missing / non-dir paths fall back to `$HOME`.
 */
export const resolveSessionCwd = (requested: string | undefined): string => {
  const home = homedir();
  if (requested === undefined || requested.length === 0) return home;
  if (!isAbsolute(requested)) return home;
  // Reject path traversal / non-directories without following untrusted
  // symlink escapes outside what realpath reports.
  try {
    const abs = resolve(requested);
    const real = realpathSync(abs);
    if (!statSync(real).isDirectory()) return home;
    return real;
  } catch {
    return home;
  }
};

/** Env for a device PTY: real HOME + device-session markers for live.json.
 *  Provider-agnostic — every device CLI (incl. opencode) shares one env. */
const deviceSessionEnv = (
  _cli: TDeviceSessionCli,
  openllmSessionId: string,
  title: string | null,
): Record<string, string> => {
  const base = sessionEnv();
  return {
    ...base,
    OPENLLM_DEVICE_SESSION_ID: openllmSessionId,
    ...(title !== null && title.length > 0
      ? { OPENLLM_DEVICE_TITLE: title.slice(0, 80) }
      : {}),
  };
};

const pushScrollback = (s: TSession, chunk: Uint8Array): void => {
  s.scrollback.push(chunk);
  s.scrollbackBytes += chunk.length;
  while (s.scrollbackBytes > SCROLLBACK_MAX_BYTES && s.scrollback.length > 1) {
    const dropped = s.scrollback.shift();
    if (dropped !== undefined) s.scrollbackBytes -= dropped.length;
  }
};

const detachConsumer = (
  session: TSession,
  consumer: TAttachedConsumer,
): void => {
  if (!session.consumers.delete(consumer)) return;
  consumer.exitHandler = null;
  consumer.queuedBytes = 0;
  for (const unsubscribe of consumer.unsubscribe) unsubscribe();
  // A departing primary hands the PTY size to the most recently focused
  // survivor. Leaving it vacant would strand the remaining viewers rendering
  // at a size nobody is looking at any more — and since input no longer
  // re-elects, nothing else would ever reclaim it.
  if (session.primaryConsumer === consumer) promoteSuccessorPrimary(session);
  if (!isAttached(session)) {
    session.detachedAtMs = Date.now();
    logDebug("session", "session detached", { id: session.id });
  }
};

const resetLaggingConsumer = (
  session: TSession,
  consumer: TAttachedConsumer,
): void => {
  if (!session.consumers.has(consumer)) return;
  detachConsumer(session, consumer);
  try {
    consumer.stream.reset(
      encodeJsonPayload({
        code: "lagging",
        message: "session output exceeded the consumer queue limit",
      }),
    );
  } catch {
    // A failed reset is still safely detached from the PTY fan-out.
  }
};

/** Queue output on one consumer without making peers wait for it. */
const writeConsumer = (
  session: TSession,
  consumer: TAttachedConsumer,
  chunk: Uint8Array,
): void => {
  if (!session.consumers.has(consumer)) return;
  if (consumer.queuedBytes + chunk.length > CONSUMER_MAX_QUEUED_BYTES) {
    resetLaggingConsumer(session, consumer);
    return;
  }
  consumer.queuedBytes += chunk.length;
  consumer.writeTail = consumer.writeTail
    .then(() => consumer.stream.write(chunk))
    .then(
      () => {
        if (session.consumers.has(consumer))
          consumer.queuedBytes -= chunk.length;
      },
      () => {
        resetLaggingConsumer(session, consumer);
      },
    )
    .catch(() => {});
};

/** Fan out one out-direction chunk to every attached consumer — byte-identical.
 *
 *  Consumers all render the PTY's grid, so there is nothing to reflow per
 *  viewer and nothing to re-serialize. Each viewer used to keep a private
 *  emulator at its own size and receive a FULL-SCREEN repaint per output chunk,
 *  which is what made a second viewer flash back to an older frame: the repaint
 *  is a clear plus a redraw of a screen reconstructed a step behind the raw
 *  stream. A viewer larger than the PTY now simply leaves margin; a smaller one
 *  wraps until it takes focus, at which point the PTY fits it. */
const fanOut = (session: TSession, chunk: Uint8Array): void => {
  for (const consumer of session.consumers)
    writeConsumer(session, consumer, chunk);
};

/** Fan out one out-direction chunk to every attached transport-neutral consumer. */
const sendOut = (session: TSession, chunk: Uint8Array): void => {
  if (isAttached(session)) fanOut(session, chunk);
};

/** Paint the current screen for a newly attached consumer: one serialize of the
 *  shared emulator, which is the same grid every consumer renders. */
const paintInitialScreen = (
  session: TSession,
  consumer: TAttachedConsumer,
): void => {
  if (session.emulator === null) {
    // Legacy / no-PTY path: raw scrollback replay at capture width.
    writeConsumer(session, consumer, new TextEncoder().encode("\x1b[2J\x1b[H"));
    for (const chunk of session.scrollback)
      writeConsumer(session, consumer, chunk);
    return;
  }
  writeConsumer(session, consumer, serializeScreenBytes(session.emulator));
};

/**
 * Hand primacy to the viewer that just focused or resized. Unconditional: this
 * is a deliberate act on a specific viewer, and there is nothing to arbitrate.
 */
const claimPrimary = (
  session: TSession,
  consumer: TAttachedConsumer,
  now: number,
): void => {
  consumer.lastActiveAtMs = now;
  session.primaryConsumer = consumer;
};

/**
 * The primary left. Hand the PTY size to the most recently focused survivor so
 * the remaining viewers are not stranded rendering at a departed viewer's size.
 */
const promoteSuccessorPrimary = (session: TSession): void => {
  let successor: TAttachedConsumer | null = null;
  for (const consumer of session.consumers) {
    if (
      successor === null ||
      consumer.lastActiveAtMs > successor.lastActiveAtMs
    )
      successor = consumer;
  }
  session.primaryConsumer = successor;
  if (successor === null) return;
  if (
    session.canonicalCols !== successor.cols ||
    session.canonicalRows !== successor.rows
  ) {
    applyCanonicalResize(session, successor.cols, successor.rows);
  }
};

/**
 * Collect a pid and every descendant of it from one `ps` snapshot. Returns an
 * EMPTY set when the root is not present in the snapshot, so a stale pid can
 * never be mistaken for a live process and signalled.
 */
const processTree = async (rootPid: number): Promise<ReadonlySet<number>> => {
  const proc = Bun.spawn(["ps", "-Ao", "pid=,ppid="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return new Set();
  const children = new Map<number, number[]>();
  let rootSeen = false;
  for (const line of text.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (pid === rootPid) rootSeen = true;
    const siblings = children.get(ppid);
    if (siblings === undefined) children.set(ppid, [pid]);
    else siblings.push(pid);
  }
  if (!rootSeen) return new Set();
  const tree = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const child of children.get(current) ?? []) {
      // A pid cannot be its own ancestor, so `tree` also bounds the walk.
      if (tree.has(child)) continue;
      tree.add(child);
      queue.push(child);
    }
  }
  return tree;
};

type TWinchProcessTree = {
  pids: ReadonlySet<number>;
  refreshedAtMs: number;
  refresh: Promise<void> | null;
};

const winchProcessTrees = new Map<string, TWinchProcessTree>();

const refreshWinchProcessTree = (session: TSession): void => {
  const rootPid = session.pid;
  if (rootPid === null) return;
  const cached = winchProcessTrees.get(session.id);
  if (cached?.refresh !== null && cached !== undefined) return;
  const tree: TWinchProcessTree = cached ?? {
    pids: new Set(),
    refreshedAtMs: 0,
    refresh: null,
  };
  const refresh = processTree(rootPid)
    .then((pids) => {
      tree.pids = pids;
      tree.refreshedAtMs = Date.now();
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGWINCH");
        } catch {
          // Raced exit — the remaining tree still gets the signal.
        }
      }
    })
    .catch(() => {
      tree.pids = new Set();
      tree.refreshedAtMs = Date.now();
    })
    .finally(() => {
      tree.refresh = null;
    });
  tree.refresh = refresh;
  winchProcessTrees.set(session.id, tree);
};

const cachedWinchProcessTree = (session: TSession): ReadonlySet<number> => {
  const cached = winchProcessTrees.get(session.id);
  if (
    cached === undefined ||
    Date.now() - cached.refreshedAtMs >= WINCH_PROCESS_TREE_REFRESH_MS
  )
    refreshWinchProcessTree(session);
  return cached?.pids ?? new Set();
};

/**
 * Deliver SIGWINCH to a session's whole process tree after a PTY resize.
 *
 * `Bun.spawn({ terminal })` does NOT make the PTY slave the child's CONTROLLING
 * terminal (`ps` reports `TTY ??`, `SESS 0`), so the kernel's TIOCSWINSZ-driven
 * SIGWINCH — which targets the tty's foreground process group — reaches nobody.
 * `pty.resize()` updates the winsize correctly, but a TUI that only re-measures
 * on SIGWINCH (Ink/Claude Code, codex, …) keeps rendering at its BIRTH size,
 * which is the mid-session "crumbled output" symptom. So we signal it ourselves.
 *
 * The whole TREE, not just the root: the PTY runs `openllm <cli>`, which spawns
 * the vendor CLI as a GRANDCHILD with inherited stdio. And a pid-by-pid walk,
 * not `kill(-pid)`: the child inherits the host's process group, so a negative
 * pid would signal the daemon itself.
 */
const deliverWinch = (session: TSession): void => {
  if (session.pid === null || session.pty === null) return;
  for (const pid of cachedWinchProcessTree(session)) {
    try {
      process.kill(pid, "SIGWINCH");
    } catch {
      // Raced exit — the remaining tree still gets the signal.
    }
  }
};

/** Pending debounced SIGWINCH fan-outs, keyed by session id. */
const winchTimers = new Map<string, ReturnType<typeof setTimeout>>();

const cancelWinch = (id: string): void => {
  const timer = winchTimers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  winchTimers.delete(id);
};

/** Queue a coalesced SIGWINCH fan-out for this session. Only the real Bun PTY
 *  spawner needs it — an injected test spawner owns no OS process tree, and
 *  signalling its synthetic pids could hit unrelated processes. */
const scheduleWinch = (session: TSession): void => {
  if (spawner !== bunPtySpawner || !ptySupported()) return;
  if (session.pid === null || winchTimers.has(session.id)) return;
  const timer = setTimeout(() => {
    winchTimers.delete(session.id);
    const current = sessions.get(session.id);
    if (current !== undefined) deliverWinch(current);
  }, WINCH_DEBOUNCE_MS);
  timer.unref?.();
  winchTimers.set(session.id, timer);
};

/** Resize the canonical PTY + shared emulator to the given size and re-sync
 *  every consumer's view against the new canonical size. */
const applyCanonicalResize = (
  session: TSession,
  cols: number,
  rows: number,
): void => {
  session.canonicalCols = cols;
  session.canonicalRows = rows;
  session.pty?.resize(cols, rows);
  // The winsize ioctl alone does not wake the child — see deliverWinch.
  if (session.pty !== null) scheduleWinch(session);
  session.emulator?.resize(cols, rows);
};

/**
 * Record a consumer's viewport, and resize the PTY when that consumer is the
 * primary — the one that last actually took focus.
 *
 * Only the primary's size reaches the PTY. Everyone else just has their number
 * remembered, for when they take focus.
 */
const setConsumerViewport = (
  session: TSession,
  consumer: TAttachedConsumer,
  cols: number,
  rows: number,
): void => {
  consumer.cols = cols;
  consumer.rows = rows;
  if (session.primaryConsumer !== consumer) return;
  if (
    session.canonicalCols !== cols ||
    session.canonicalRows !== rows ||
    session.emulator === null
  ) {
    applyCanonicalResize(session, cols, rows);
  }
};

const terminalClose = (session: TSession): void => {
  const consumers = [...session.consumers];
  // Exit codes are delivered on natural exits before each local broker stream
  // closes. An explicit kill intentionally has no late exit envelope.
  for (const consumer of consumers) {
    if (session.exitCode !== null) {
      try {
        consumer.exitHandler?.(session.exitCode);
      } catch {
        // The local socket may already be gone; close remains terminal.
      }
    }
    detachConsumer(session, consumer);
    try {
      consumer.stream.end();
    } catch {
      // Closing one broken stream must not prevent peers from closing.
    }
  }
};

const endPty = (
  s: TSession,
  reason: "evicted" | "reaped" | "done" | "killed",
  kill = true,
): void => {
  s.lastExitReason = reason;
  cancelWinch(s.id);
  winchProcessTrees.delete(s.id);
  if (kill) s.pty?.kill();
  s.pty = null;
  s.pid = null;
  // Release the scrollback ring — a dead session can't be attached, so its
  // buffered output is dead weight until the row itself is evicted.
  s.scrollback.length = 0;
  s.scrollbackBytes = 0;
  // Dispose the shared screen emulator; a dead session has no durable screen.
  s.emulator?.dispose();
  s.emulator = null;
  s.primaryConsumer = null;
  lifecycleHooks.onEnd(s);
};

/** Bound retained dead session rows: evict the oldest non-live records beyond
 *  MAX_RETAINED_SESSIONS so a long-lived daemon can't accumulate them without
 *  limit. Live and attached sessions are never evicted. */
const evictStaleDeadSessions = (): void => {
  const dead = [...sessions.values()]
    .filter((s) => s.pty === null && !isAttached(s))
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
  const excess = dead.length - MAX_RETAINED_SESSIONS;
  for (let i = 0; i < excess; i += 1) {
    const victim = dead[i];
    if (victim !== undefined) sessions.delete(victim.id);
  }
};

export const detachSession = (id: string): void => {
  const session = sessions.get(id);
  if (session === undefined) return;
  for (const consumer of [...session.consumers])
    detachConsumer(session, consumer);
  if (!isAttached(session)) session.detachedAtMs = Date.now();
};

/** Kill a live device PTY by its OpenLLM session id for the local broker. */
export const killSession = (id: string): boolean => {
  const session = sessions.get(id);
  if (session === undefined || session.pty === null) return false;
  endPty(session, "killed");
  logDebug("session", "session closed", { id, reason: "kill" });
  return true;
};

/** Kill all local PTYs and close their transport-neutral consumers. */
export const killAllSessions = (): void => {
  for (const session of sessions.values()) {
    cancelWinch(session.id);
    if (session.pty !== null) {
      try {
        session.pty.kill();
      } catch {
        /* already gone */
      }
      session.pty = null;
      session.pid = null;
    }
    for (const consumer of [...session.consumers]) {
      session.consumers.delete(consumer);
      try {
        consumer.stream.end();
      } catch {
        /* already gone */
      }
    }
    lifecycleHooks.onEnd(session);
  }
};

/** Write input bytes from a transport-neutral session attachment. */
export const writeSessionInput = (id: string, bytes: Uint8Array): void => {
  sessions.get(id)?.pty?.write(bytes);
};

/** Resize the PTY from a transport-neutral session attachment. Authoritative
 *  override: sets the canonical size directly (PTY + shared emulator + every
 *  consumer view), independent of primary election. */
export const resizeSession = (id: string, cols: number, rows: number): void => {
  const session = sessions.get(id);
  if (session === undefined || session.pty === null) return;
  applyCanonicalResize(session, cols, rows);
};

/** End a session now and close any attached transport-neutral consumers. */
export const closeSession = (id: string): boolean => {
  const session = sessions.get(id);
  if (session === undefined) return false;
  endPty(session, "killed");
  terminalClose(session);
  logDebug("session", "session closed", { id, reason: "close" });
  return true;
};

/** Per-client dangerous bypass flags (mirrors the CLI registry's
 *  `dangerousFlag` values). Vendor args may not smuggle these — the dangerous
 *  grant travels ONLY on `frame.dangerous`, which the picker/CLI gate. */
const DANGEROUS_VENDOR_FLAGS: ReadonlySet<string> = new Set([
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--always-approve",
]);

const isDangerousVendorFlag = (arg: string): boolean =>
  [...DANGEROUS_VENDOR_FLAGS].some((flag) => arg.startsWith(flag));

const validVendorArgs = (
  vendorArgs: readonly string[] | undefined,
  dangerousGranted: boolean,
): boolean =>
  vendorArgs === undefined ||
  (vendorArgs.length <= 64 &&
    vendorArgs.every(
      (arg) =>
        typeof arg === "string" &&
        arg.length >= 1 &&
        arg.length <= 512 &&
        !arg.includes("\0") &&
        (dangerousGranted || !isDangerousVendorFlag(arg)),
    ));

export type TSessionOpen = {
  readonly session_id: string;
  readonly cli: TDeviceSessionCli;
  readonly cols: number;
  readonly rows: number;
  readonly mode: "spawn" | "attach" | "continue";
  readonly title?: string;
  readonly dangerous?: boolean;
  readonly resume_session_id?: string;
  readonly cwd?: string;
};

export type TSessionOpenAck =
  | {
      readonly ok: true;
      readonly live: boolean;
      readonly generation: number;
    }
  | {
      readonly ok: false;
      readonly error:
        | "pty_unsupported"
        | "cli_not_installed"
        | "session_not_found"
        | "session_busy"
        | "overloaded"
        | "spawn_failed";
      readonly lastExitReason?: "evicted" | "reaped" | "done" | "killed";
    };

export type TOpenSessionOptions = {
  readonly vendorArgs?: readonly string[];
  readonly onSessionReady?: (session: TSession) => void;
  readonly onAck: (ack: TSessionOpenAck) => void;
};

export const openSession = (
  frame: TSessionOpen,
  options: TOpenSessionOptions,
): void => {
  const { vendorArgs, onSessionReady, onAck } = options;
  const nack = (
    error:
      | "pty_unsupported"
      | "cli_not_installed"
      | "session_not_found"
      | "session_busy"
      | "overloaded"
      | "spawn_failed",
    lastExitReason?: "evicted" | "reaped" | "done" | "killed" | null,
  ): void => {
    // Every refusal surfaces as user-facing copy in the browser, so it must be
    // greppable here too — a nack used to return before the first log line,
    // which made "couldn't open this session" invisible daemon-side.
    logInfo("session", "session open refused", {
      id: frame.session_id,
      mode: frame.mode,
      error,
      ...(lastExitReason === undefined || lastExitReason === null
        ? {}
        : { last_exit_reason: lastExitReason }),
    });
    onAck({
      ok: false,
      error,
      ...(lastExitReason === undefined || lastExitReason === null
        ? {}
        : { lastExitReason }),
    });
  };
  // Outer guard: pre-spawn helpers (cwd resolution, binary lookup, …) used
  // to sit outside the spawn try/catch. An unexpected throw there left the
  // browser waiting on open_ack until its 15s timeout. Always nack.
  try {
    if (
      !validVendorArgs(
        vendorArgs,
        frame.dangerous === true && sessionSupportsDangerous(frame.cli),
      )
    ) {
      nack("spawn_failed");
      return;
    }
    if (!ptySupported()) {
      nack("pty_unsupported");
      return;
    }
    if (!SESSION_ID_PATTERN.test(frame.session_id)) {
      nack("spawn_failed");
      return;
    }
    const cli: TDeviceSessionCli = frame.cli;
    const existing = sessions.get(frame.session_id);
    if (existing !== undefined && existing.cli !== cli) {
      nack("spawn_failed");
      return;
    }
    const rawResumeId =
      typeof frame.resume_session_id === "string" &&
      frame.resume_session_id.length > 0
        ? frame.resume_session_id
        : null;
    // Only accept a vendor session id that is a plain url-safe token: never a
    // value that could be read as a flag (leading "-") when appended to argv.
    if (rawResumeId !== null && !RESUME_ID_PATTERN.test(rawResumeId)) {
      nack("spawn_failed");
      return;
    }
    const resumeId = rawResumeId;
    if (cli === "shell" && resumeId !== null) {
      nack("spawn_failed");
      return;
    }

    // ── attach: re-bind a live PTY ────────────────────────────────────
    if (frame.mode === "attach") {
      if (existing === undefined) {
        nack("session_not_found");
        return;
      }
      if (existing.pty === null) {
        // Dead — the consumer should re-open with mode:"continue".
        nack("session_not_found", existing.lastExitReason);
        return;
      }
      existing.detachedAtMs = null;
      existing.generation = ++nextSessionGeneration;
      // A stream consumer registers here (onSessionReady) BEFORE the ack, so
      // its size + primary policy is applied in the caller's onAck where the
      // consumer object is in scope. The legacy JSON path has no consumer.
      onSessionReady?.(existing);
      onAck({ ok: true, live: true, generation: existing.generation });
      // Legacy JSON has no stream object in the consumer set, so it is the sole
      // viewer: authoritatively drive the PTY to its size and replay the
      // emulator's screen (or raw scrollback when no emulator exists).
      if (!isAttached(existing)) {
        applyCanonicalResize(existing, frame.cols, frame.rows);
        if (existing.emulator !== null) {
          sendOut(existing, serializeScreenBytes(existing.emulator));
        } else {
          sendOut(existing, new TextEncoder().encode("\x1b[2J\x1b[H"));
          for (const chunk of existing.scrollback) sendOut(existing, chunk);
        }
      }
      logDebug("session", "session re-attached", { id: existing.id });
      return;
    }

    // ── spawn / continue: start a CLI process ─────────────────────────
    if (existing !== undefined && existing.pty !== null) {
      nack("session_busy");
      return;
    }
    // At capacity: refuse the new spawn. Detached sessions stay alive until
    // the user explicitly ends them — never silently evict under pressure.
    if (liveCount() >= MAX_LIVE_SESSIONS) {
      nack("overloaded");
      return;
    }

    // Device sessions must launch through the OpenLLM CLI so the gateway,
    // catalog, config, and environment overlay is always applied. Only enforce
    // this for the real spawner — injected test spawners never exec a binary.
    if (cli !== "shell" && spawner === bunPtySpawner && openllmBin() === null) {
      nack("cli_not_installed");
      return;
    }

    // cwd: resume frame / prior session cwd / $HOME. No ~/.openllm/sessions.
    const cwd = resolveSessionCwd(
      frame.cwd ??
        (existing !== undefined ? existing.cwd : undefined) ??
        undefined,
    );
    const vendorSessionId =
      resumeId ?? (existing !== undefined ? existing.vendorSessionId : null);

    // `continue` after a daemon restart: no in-memory record — recreate it.
    const s: TSession = existing ?? {
      id: frame.session_id,
      cli,
      cwd,
      vendorSessionId,
      pty: null,
      scrollback: [],
      scrollbackBytes: 0,
      emulator: null,
      canonicalCols: frame.cols,
      canonicalRows: frame.rows,
      primaryConsumer: null,
      consumers: new Set(),
      outSeq: 0,
      startedAtMs: Date.now(),
      detachedAtMs: null,
      lastOutputAtMs: Date.now(),
      lastBusyAtMs: Date.now(),
      busy: true,
      title: frame.title ?? null,
      pid: null,
      generation: 0,
      lastExitReason: null,
      exitCode: null,
    };
    // Refresh resume metadata on every spawn/continue.
    s.cwd = cwd;
    s.vendorSessionId = vendorSessionId;
    if (frame.title !== undefined) s.title = frame.title;
    sessions.set(s.id, s);
    evictStaleDeadSessions();

    try {
      const argv = argvFor(
        cli,
        frame.mode === "continue" ? "continue" : "spawn",
        frame.dangerous === true,
        vendorSessionId,
        vendorArgs,
      );
      logDebug("session", "session open started", {
        id: s.id,
        cli,
        mode: frame.mode,
        cwd,
        argv: argv.join(" "),
      });
      const pendingOutput: Uint8Array[] = [];
      let ptyReady = false;
      const onData = (chunk: Uint8Array): void => {
        s.lastOutputAtMs = Date.now();
        // Keep raw scrollback for the no-stream fallback path, and feed the
        // shared emulator that backs per-consumer reflow + attach replay.
        pushScrollback(s, chunk);
        s.emulator?.write(chunk);
        if (!ptyReady) {
          pendingOutput.push(chunk);
          return;
        }
        sendOut(s, chunk);
      };
      // Shared source-of-truth screen, born at the consumer's real size. Fed
      // synchronously (fire-and-forget) as bytes arrive; xterm queues writes.
      s.emulator = new Terminal({
        cols: frame.cols,
        rows: frame.rows,
        scrollback: EMULATOR_SCROLLBACK_ROWS,
        allowProposedApi: true,
      });
      s.canonicalCols = frame.cols;
      s.canonicalRows = frame.rows;
      const pty = spawner({
        argv,
        cwd,
        // Real user HOME + PATH (via spawnEnv). Device markers let the
        // openllm CLI write host=device into ~/.openllm/run/.../live.json.
        env: deviceSessionEnv(cli, s.id, s.title),
        cols: frame.cols,
        rows: frame.rows,
        onData,
        onExit: (exitCode) => {
          s.exitCode = typeof exitCode === "number" ? exitCode : null;
          const reason = s.lastExitReason ?? "done";
          endPty(s, reason, false);
          terminalClose(s);
          logDebug("session", "session CLI exited", { id: s.id });
        },
      });
      s.pty = pty;
      s.pid = pty.pid ?? null;
      s.busy = true;
      s.lastBusyAtMs = Date.now();
      s.detachedAtMs = null;
      s.generation = ++nextSessionGeneration;
      s.lastExitReason = null;
      // A reused row may retain the prior child status. The newly spawned PTY
      // must not report that old exit code when it later closes.
      s.exitCode = null;
      // Lifecycle ownership stays injectable: the current daemon writes its
      // pidfile adapter, while the standalone host supplies its own persistence.
      // Run it only after all persisted metadata has its final spawn values.
      lifecycleHooks.onSpawn(s);
      onSessionReady?.(s);
      onAck({ ok: true, live: false, generation: s.generation });
      ptyReady = true;
      for (const chunk of pendingOutput) sendOut(s, chunk);
      pendingOutput.length = 0;
      logDebug("session", "session started", {
        id: s.id,
        cli,
        mode: frame.mode,
      });
    } catch (err) {
      s.emulator?.dispose();
      s.emulator = null;
      sessions.delete(s.id);
      logWarn(
        "session",
        `session spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      nack("spawn_failed");
    }
  } catch (err) {
    logWarn(
      "session",
      `session open failed: ${err instanceof Error ? err.message : String(err)}`,
      { id: frame.session_id, mode: frame.mode },
    );
    nack("spawn_failed");
  }
};

/** Bind a transport-neutral session stream without changing the legacy JSON state machine. */
export const bindSessionStream = (
  stream: TSessionStream,
  open: TSessionStreamOpenPayload,
  opts: {
    readonly vendorArgs?: readonly string[];
    readonly onExit?: (code: number) => void;
  } = {},
): void => {
  const consumer: TAttachedConsumer = {
    stream,
    unsubscribe: [],
    writeTail: Promise.resolve(),
    queuedBytes: 0,
    exitHandler: opts.onExit ?? null,
    cols: open.cols,
    rows: open.rows,
    lastActiveAtMs: Date.now(),
  };
  const registerConsumer = (session: TSession): void => {
    if (session.consumers.has(consumer)) return;
    session.consumers.add(consumer);
    session.detachedAtMs = null;
  };
  const onAck = (ack: TSessionOpenAck): void => {
    if (!ack.ok) {
      stream.reset(
        encodeJsonPayload({
          code: ack.error,
          ...(ack.lastExitReason === undefined
            ? {}
            : { last_exit_reason: ack.lastExitReason }),
        }),
      );
      return;
    }
    const session = sessions.get(open.session_id);
    if (session === undefined) {
      // No record for a successful open ack (raced teardown) — reset the
      // stream so the consumer settles instead of hanging on the channel.
      stream.reset(encodeJsonPayload({ code: "session_not_found" }));
      return;
    }
    registerConsumer(session);
    stream.sendCtrl(
      encodeJsonPayload({
        t: "open_ack",
        ok: true,
        live: ack.live,
        generation: ack.generation,
      }),
    );
    if (open.mode !== "attach") return;
    // Attaching does NOT steal the size from whoever is already driving it —
    // opening a second viewer must not resize the terminal someone is using.
    // It becomes primary only when the session has none (it is the first, or
    // the previous primary left); otherwise it gets a private view + a
    // serialized paint at its own size, and takes over when it focuses.
    if (
      session.primaryConsumer === null ||
      !session.consumers.has(session.primaryConsumer)
    ) {
      claimPrimary(session, consumer, consumer.lastActiveAtMs);
    }
    setConsumerViewport(session, consumer, open.cols, open.rows);
    // Every attach gets the current screen before live output. This consumer's
    // private write tail orders it ahead of subsequent output without delaying
    // the other viewers.
    paintInitialScreen(session, consumer);
    consumer.writeTail = consumer.writeTail
      .then(() => stream.sendCtrl(encodeJsonPayload({ t: "replay_done" })))
      .catch(() => detachConsumer(session, consumer));
  };

  let boundSession: TSession | undefined;
  openSession(open, {
    vendorArgs: opts.vendorArgs,
    onAck,
    onSessionReady: (session) => {
      boundSession = session;
      registerConsumer(session);
    },
  });
  const session = boundSession;
  // A refused open never became a consumer, so it must not leave four dormant
  // transport handlers behind. For accepted streams, keep every unsubscribe on
  // the consumer and release them together on reset/end/lagging/PTY teardown.
  if (session === undefined || consumer === undefined) return;
  consumer.unsubscribe.push(
    stream.onData((bytes) => {
      if (!session.consumers.has(consumer)) return;
      // Input is input. It does NOT move primacy and does NOT resize the PTY —
      // see the note on the primary at the top of this file. A keystroke is not
      // a viewport announcement, and treating it as one made the canonical size
      // alternate between two attached viewers as the user typed.
      session.pty?.write(bytes);
    }),
    stream.onCtrl((payload) => {
      if (!session.consumers.has(consumer)) return;
      const ctrl = parseStreamCtrlPayload(decodeJsonPayload(payload));
      if (ctrl?.t === "resize") {
        // Someone dragged THIS viewer's window. A deliberate act on a specific
        // viewer, so it takes the PTY size with it.
        claimPrimary(session, consumer, Date.now());
        setConsumerViewport(session, consumer, ctrl.cols, ctrl.rows);
      }
      if (ctrl?.t === "focus") {
        // The signal that decides who drives: tab focus, or a local attach
        // coming to the foreground. Carries the consumer's CURRENT dims, so a
        // pure focus never invents a size — and `setConsumerViewport` is a
        // no-op when those dims are already canonical.
        claimPrimary(session, consumer, Date.now());
        setConsumerViewport(session, consumer, consumer.cols, consumer.rows);
      }
      if (ctrl?.t === "close" && ctrl.intent === "kill") {
        endPty(session, "killed");
        // END is a clean terminal close to sessionStream.closed ("done").
        terminalClose(session);
      }
    }),
    stream.onReset(() => detachConsumer(session, consumer)),
    stream.onEnd(() => detachConsumer(session, consumer)),
  );
  // A stream can synchronously end while a transport registers a handler.
  // Avoid retaining subscriptions in that raced, already-detached consumer.
  if (!session.consumers.has(consumer)) {
    for (const unsubscribe of consumer.unsubscribe) unsubscribe();
  }
};

/** Test-only: reset all session state. */
export const resetSessionsForTest = (): void => {
  for (const s of sessions.values()) {
    cancelWinch(s.id);
    s.pty?.kill();
    lifecycleHooks.onEnd(s);
  }
  sessions.clear();
};
