/**
 * Headless paste-back login (Claude remote). Split out of `util.ts`
 * (which re-exports everything here — import from either).
 *
 * `claude auth login --claudeai` with DISPLAY unset prints a hosted-callback
 * authorize URL (platform.claude.com) + a `Paste code here if prompted >`
 * prompt, holds an in-process PKCE verifier, and consumes the pasted code on
 * stdin (a bad paste re-prompts; the process stays alive). Verified live
 * against claude v2.1.185. See
 * `docs/proposals/headless-claude-login-paste-back.md`.
 *
 * Ownership: `superviseSpawn` + one operation deadline (`DEFAULT_LOGIN_TIMEOUT_MS`
 * unless the caller injects `timeoutMs`). Completion is the URL, an invalid-code
 * line, or child exit — not a phase timer. The same deadline reaps an abandoned
 * post-URL child; it is not rearmed.
 */
import { chmodSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TReapOutcome, TSupervisedChild } from "../child-supervisor";
import { superviseSpawn } from "../child-supervisor";
import { createDeadlineBudget, splitReapBudget } from "../deadline-budget";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { daemonTempDir } from "../sandbox/working-set";
import type { TChildCleanupOutcome } from "./spawn";
import {
  bindAbort,
  childCleanupOutcome,
  DEFAULT_LOGIN_TIMEOUT_MS,
  spawnCwd,
  spawnEnv,
  stripAnsi,
} from "./spawn";

/** Parse the authorize URL the CLI prints for the no-browser fallback. */
const HEADLESS_URL_RE = /If the browser didn't open, visit:\s*(\S+)/;
/** The CLI's inline reject on a wrong/partial paste — it stays alive to retry. */
const HEADLESS_INVALID_RE = /Invalid code\b/i;

export type THeadlessLogin = {
  /** The authorize URL to surface to the caller's browser (hosted-callback). */
  readonly url: string;
  /** Write a pasted authorization code to the live CLI's stdin and await the
   *  outcome. `ok:false` (e.g. an `Invalid code` reject) leaves the process
   *  ALIVE for a retry; `ok:true` means the CLI exchanged + exited. */
  readonly submitCode: (code: string) => Promise<{
    readonly ok: boolean;
    readonly detail: string;
  }>;
  /** Resolves when the login process exits (success, cancel, or expiry). */
  readonly done: Promise<void>;
  /** Kill the login process (cancel an in-flight paste-back). */
  readonly cancel: () => void;
  readonly whenReleased: Promise<TReapOutcome>;
};

export type THeadlessLoginMiss = {
  readonly error: string;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly crashed: boolean;
  readonly exitCode: number | null;
  readonly cleanup: TChildCleanupOutcome;
  readonly whenReleased: Promise<TReapOutcome>;
};

export type THeadlessLoginOpts = {
  /** Whole-operation safety budget. Tests inject a short ceiling. */
  readonly timeoutMs?: number;
  /** Alias for {@link THeadlessLoginOpts.timeoutMs} (existing tests). */
  readonly urlTimeoutMs?: number;
  readonly probe?: boolean;
  /** Pre-spawn cancel owner. Abort terminates the group; do not pass observer abort. */
  readonly signal?: AbortSignal;
  /** Fired immediately after a supervised child exists (before URL wait). */
  readonly onSpawned?: (child: TSupervisedChild) => void;
};

const writeStdin = (
  proc: ReturnType<typeof Bun.spawn>,
  line: string,
): boolean => {
  const stdin = proc.stdin;
  if (typeof stdin !== "object" || stdin === null || !("write" in stdin)) {
    return false;
  }
  const sink = stdin as { write: (chunk: string) => number; flush: () => void };
  try {
    sink.write(`${line}\n`);
    sink.flush();
    return true;
  } catch {
    return false;
  }
};

let noBrowserShimDir: string | null | undefined;
/**
 * A directory holding no-op `open` / `xdg-open` scripts to PREPEND to a login
 * child's PATH so it can't pop a browser tab on the daemon's own machine
 * (claude opens via a PATH lookup — verified interceptable, unlike codex).
 * Best-effort: returns null if it can't be created (the login still works —
 * the printed URL + paste prompt are unaffected; at worst a tab opens on a
 * remote GUI box). Cached after the first success.
 */
const ensureNoBrowserShimDir = async (): Promise<string | null> => {
  if (noBrowserShimDir !== undefined) return noBrowserShimDir;
  try {
    const dir = join(daemonTempDir(), "no-browser");
    await mkdir(dir, { recursive: true });
    for (const name of ["open", "xdg-open"]) {
      const p = join(dir, name);
      await Bun.write(p, "#!/bin/sh\nexit 0\n");
      chmodSync(p, 0o755);
    }
    noBrowserShimDir = dir;
  } catch {
    noBrowserShimDir = null;
  }
  return noBrowserShimDir;
};

/**
 * Spawn `claude auth login --claudeai` (DISPLAY-stripped, browser suppressed)
 * for a REMOTE/headless box, parse the authorize URL it prints, and hold the
 * process open on a WRITABLE stdin so the pasted code can be fed back later.
 * Returns a miss when no URL arrives before child exit, cancel, or the operation
 * deadline.
 */
export const spawnHeadlessLogin = async (
  argv: ReadonlyArray<string>,
  env: Record<string, string>,
  opts?: THeadlessLoginOpts,
): Promise<THeadlessLogin | THeadlessLoginMiss> => {
  const shimDir = await ensureNoBrowserShimDir();
  const baseEnv = spawnEnv(env) ?? { ...process.env };
  const childEnv: Record<string, string | undefined> = { ...baseEnv };
  // No GUI → the printed URL is the hosted-callback (platform.claude.com) one
  // the user can complete from another machine; also makes any browser-open a
  // no-op fallback.
  delete childEnv.DISPLAY;
  delete childEnv.WAYLAND_DISPLAY;
  if (shimDir !== null) {
    childEnv.PATH = `${shimDir}:${baseEnv.PATH ?? process.env.PATH ?? ""}`;
  }

  const timeoutMs =
    opts?.timeoutMs ?? opts?.urlTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const budget = createDeadlineBudget(timeoutMs, opts?.signal);
  const child = superviseSpawn(sandboxSpawnArgs(argv, { probe: opts?.probe }), {
    kind: "login",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: spawnCwd(env),
    env: childEnv,
  });
  opts?.onSpawned?.(child);

  const proc = child.subprocess;
  let terminatePromise: Promise<TReapOutcome> | null = null;
  const requestTerminate = (): Promise<TReapOutcome> => {
    if (terminatePromise === null) {
      terminatePromise = child.terminate(splitReapBudget(budget.remainingMs()));
    }
    return terminatePromise;
  };
  let settleUrl: ((v: string | null) => void) | null = null;
  const unbindAbort = bindAbort(budget.signal, () => {
    settleUrl?.(null);
    void requestTerminate();
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  const combinedDiagnostics = (): string => `${stdoutBuf}${stderrBuf}`;
  const matchAuthorizeUrl = (): string | undefined => {
    const clean = (raw: string | undefined): string | undefined => {
      if (raw === undefined) return undefined;
      const url = raw.replace(/�+$/g, "");
      return url.length > 0 ? url : undefined;
    };
    const fromStdout = clean(stripAnsi(stdoutBuf).match(HEADLESS_URL_RE)?.[1]);
    if (fromStdout !== undefined) return fromStdout;
    return clean(stripAnsi(stderrBuf).match(HEADLESS_URL_RE)?.[1]);
  };
  const pump = async (
    stream: ReadableStream<Uint8Array>,
    into: "stdout" | "stderr",
  ): Promise<void> => {
    const dec = new TextDecoder();
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          const chunk = dec.decode(value, { stream: true });
          if (into === "stdout") stdoutBuf += chunk;
          else stderrBuf += chunk;
        }
      }
    } finally {
      const rest = dec.decode();
      if (into === "stdout") stdoutBuf += rest;
      else stderrBuf += rest;
      reader.releaseLock();
    }
  };
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  if (typeof stdout !== "object" || stdout === null) {
    const reap = await requestTerminate();
    unbindAbort();
    budget.release();
    return {
      error: "login spawn produced no stdout",
      cancelled: opts?.signal?.aborted === true,
      timedOut: budget.expired() && opts?.signal?.aborted !== true,
      crashed: false,
      exitCode: proc.exitCode,
      cleanup: childCleanupOutcome(reap, opts?.signal?.aborted === true),
      whenReleased: child.whenReleased,
    };
  }
  void pump(stdout, "stdout");
  if (typeof stderr === "object" && stderr !== null) {
    void pump(stderr, "stderr");
  }
  const done = proc.exited.then(() => {});

  const url = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(v);
    };
    settleUrl = finish;
    const poll = setInterval(() => {
      const found = matchAuthorizeUrl();
      if (found !== undefined) finish(found);
    }, 50);
    void proc.exited.then(() => finish(null));
  });

  const cancelled = opts?.signal?.aborted === true;
  const timedOut = !cancelled && budget.expired();

  if (url === null) {
    const reap = await requestTerminate();
    unbindAbort();
    budget.release();
    const exitCode = proc.exitCode;
    const sample = stripAnsi(combinedDiagnostics())
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    const crashed =
      !cancelled && !timedOut && exitCode !== null && exitCode !== 0;
    return {
      error:
        sample.length > 0
          ? sample
          : "claude auth login emitted no authorize URL",
      cancelled,
      timedOut,
      crashed,
      exitCode,
      cleanup: childCleanupOutcome(reap, cancelled),
      whenReleased: child.whenReleased,
    };
  }

  const submitCode = (
    code: string,
  ): Promise<{ ok: boolean; detail: string }> => {
    const stdoutMark = stdoutBuf.length;
    const stderrMark = stderrBuf.length;
    if (!writeStdin(proc, code)) {
      return Promise.resolve({
        ok: false,
        detail: "login process is no longer accepting input",
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: { ok: boolean; detail: string }): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        resolve(r);
      };
      // Invalid paste is an event on stdout; a valid code exits the child.
      // The operation deadline (not a per-submit ceiling) reaps a hung exchange.
      const poll = setInterval(() => {
        const out = stripAnsi(stdoutBuf.slice(stdoutMark));
        const err = stripAnsi(stderrBuf.slice(stderrMark));
        if (HEADLESS_INVALID_RE.test(out) || HEADLESS_INVALID_RE.test(err)) {
          finish({
            ok: false,
            detail:
              "Invalid code — copy the full code from the page and paste it again.",
          });
        }
      }, 50);
      void proc.exited.then(() =>
        finish(
          proc.exitCode === 0
            ? { ok: true, detail: "signed in" }
            : { ok: false, detail: `login exited ${proc.exitCode ?? -1}` },
        ),
      );
    });
  };

  const cancel = (): void => {
    void requestTerminate();
  };

  void proc.exited.then(() => {
    unbindAbort();
    budget.release();
  });

  return {
    url,
    submitCode,
    done,
    cancel,
    whenReleased: child.whenReleased,
  };
};
