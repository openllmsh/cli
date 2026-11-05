/**
 * Interactive OpenLLM OAuth login for the CLI: create a caller-bound pending
 * authorization, open/print the authorize URL, poll until approved, claim the
 * sealed API key, open it locally, and let the caller persist via
 * `persistClaimedApiKey` / `saveEnvVars`.
 *
 * Experience layer (`docs/plan/2026-11-02-cli-auth-ux.md`): the request is
 * labelled `<hostname> · <OS name> · openllm <version>` (D5); the server's
 * user code is printed beside the link (D1); a terminal opens the browser
 * only on Enter, `--no-browser` / `OPENLLM_NO_BROWSER=1` / SSH print a QR
 * instead (D3/D4); approval from another network makes the terminal type
 * back the browser's number (D18); network errors and 429 back off up to
 * 10 s (D21); `--non-interactive` hands the link off and `--resume` finishes
 * it (D19).
 *
 * No OAuth access/refresh tokens are retained — only the ordinary `sk-llm` key.
 * Crypto is local (`cli-auth-crypto.ts`); `@openllmsh/sdk/vault` is never imported.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import type { TCliAuthSealed } from "./cli-auth-crypto";
import {
  generateCliAuthKeypair,
  generateResumableCliAuthKeypair,
  importCliAuthPrivateKey,
  openCliAuthSealed,
  zero,
} from "./cli-auth-crypto";
import { CLI_VERSION } from "./cli-version";
import { daemonInvocation } from "./daemon-delegation";
import {
  ACCOUNT_EMAIL_ENV,
  apiKeyEnvVars,
  cliConfig,
  openllmDir,
  sharedFileConfig,
} from "./env";
import { saveEnvVars } from "./onboarding";
import { splitAnchoredApiKey } from "./runtime-contracts";
import type { TTermStyle } from "./term-style";
import {
  CLEAR_LINE,
  plainStyle,
  SPINNER_FRAMES,
  stderrColorEnabled,
  termStyle,
} from "./term-style";
import { encodeQr, renderQrHalfBlocks } from "./terminal-qr";
import { readTtyLine } from "./tty-line";

export const CLI_AUTH_POLL_MS = 2_000;
/** D21: ceiling for the network-error / 429 backoff. */
export const CLI_AUTH_MAX_BACKOFF_MS = 10_000;
/**
 * Mirrors `CLI_AUTH_LABEL_MAX` in `packages/schema/cli-auth.ts` — the binary
 * does not import the schema package; `tests/cli/cli-auth-login.test.ts`
 * pins the parity.
 */
export const CLI_AUTH_LABEL_MAX_LENGTH = 80;
/** Shape of the server's `user_code` — anything else is not printed. */
const USER_CODE_DISPLAY = /^[A-Z]{4}-[A-Z]{4}$/;

/** Poll delay after `failures` consecutive network errors / 429s (D21). */
export const cliAuthBackoffMs = (failures: number): number =>
  Math.min(CLI_AUTH_MAX_BACKOFF_MS, CLI_AUTH_POLL_MS * 2 ** failures);
/**
 * Local poll budget; server-side expiry arrives as `expired` / 410. The
 * server's TTL (10 min) plus its post-approval claim grace (2 min), so an
 * approval in the last seconds is still claimed. Kept local because the CLI
 * ships without workspace deps; `tests/cli/cli-auth-wait-parity.test.ts`
 * pins it to `packages/schema/cli-auth.ts`.
 */
export const CLI_AUTH_WAIT_MS = 12 * 60 * 1000;
/** Hard ceiling for one create/status/claim fetch or body read. */
export const CLI_AUTH_REQUEST_TIMEOUT_MS = 15_000;
/** Upper bound on one auth JSON response body. */
export const CLI_AUTH_MAX_BODY_BYTES = 64 * 1024;

/** Enough of `fetch` for the auth handshake; tests need not implement Bun extras. */
export type TCliAuthFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type TCliAuthLoginIo = {
  readonly write?: (message: string) => void;
  readonly openUrl?: (url: string) => Promise<boolean>;
  readonly fetch?: TCliAuthFetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Overall login budget (defaults to `CLI_AUTH_WAIT_MS`). */
  readonly waitMs?: number;
  /** Per-request fetch/body ceiling (defaults to `CLI_AUTH_REQUEST_TIMEOUT_MS`). */
  readonly requestTimeoutMs?: number;
  /** Max JSON body bytes (defaults to `CLI_AUTH_MAX_BODY_BYTES`). */
  readonly maxBodyBytes?: number;
  /**
   * A person is at a terminal: offer Enter-to-open and ask for the D18
   * number. Default false — a caller that knows it has a terminal says so.
   */
  readonly interactive?: boolean;
  /** `--no-browser`: print link + QR, never open. */
  readonly noBrowser?: boolean;
  /** Environment read for `SSH_CONNECTION` / `OPENLLM_NO_BROWSER` (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Resolves true on Enter; false when the terminal is gone or `signal` aborts. */
  readonly waitForEnter?: (signal: AbortSignal) => Promise<boolean>;
  /** Ask one line; null on EOF / abort. */
  readonly promptLine?: (
    question: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
  /** Override the request label (defaults to `defaultCliAuthLabel()`). */
  readonly label?: string;
  /**
   * Style the output (bold code, dim hints, a spinner while waiting).
   * Defaults to on only when writing to a real stderr terminal.
   */
  readonly color?: boolean;
};

export type TCliAuthLoginResult =
  | {
      readonly ok: true;
      readonly apiKey: string;
      /** Approving account, for "Signed in as" (absent from older servers). */
      readonly email?: string;
      readonly keyName?: string;
      /** The claimed key's id (never secret) — named in the revoke notice
       *  when the caller then fails to save the key. */
      readonly keyId?: string;
      /** False when the user handed over a key they already had — then a
       *  failed save leaves nothing new on the account to revoke. */
      readonly keyMinted?: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Printed after any failure once the server has answered a claim: it marked
 * the authorization claimed on that 200, so the key now lives on the account
 * (the expiry sweep revokes only UNclaimed mints) though this CLI never saved
 * it. Names the key by id only — never the secret.
 */
export const unsavedKeyNotice = (
  origin: string,
  keyId?: string,
  keyMinted?: boolean,
): string =>
  keyMinted === false
    ? ""
    : `[openllm] An API key${keyId === undefined ? "" : ` (id ${keyId})`} was already created on your account for this login but was not saved here. Revoke it under Connections (${origin.replace(/\/+$/, "")}/keys) unless it is a key you already use.\n`;

type TCreated = {
  readonly id: string;
  readonly user_code?: unknown;
  readonly poll_token: string;
  readonly authorize_url: string;
  readonly expires_at: string;
};

type TStatus = {
  readonly id: string;
  readonly status: string;
  readonly expires_at: string;
};

type TClaimed = {
  readonly id: string;
  readonly key_id: string;
  readonly user_id: string;
  readonly email?: unknown;
  readonly key_name?: unknown;
  readonly key_minted?: unknown;
  readonly sealed: string;
};

const OS_NAMES: Readonly<Record<string, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
};

/**
 * D5: `<hostname> · <OS name> · openllm <version>`, at most
 * `CLI_AUTH_LABEL_MAX_LENGTH`. A long hostname is shortened, never the
 * suffix; control characters are dropped.
 */
export const buildCliAuthLabel = (input: {
  readonly hostname: string;
  readonly platform: string;
  readonly version: string;
}): string => {
  const host = input.hostname.replace(/\p{Cc}/gu, "").trim() || "This computer";
  const suffix = ` · ${OS_NAMES[input.platform] ?? input.platform} · openllm ${input.version}`;
  const room = CLI_AUTH_LABEL_MAX_LENGTH - suffix.length;
  const shown =
    host.length <= room ? host : `${host.slice(0, Math.max(1, room - 1))}…`;
  return `${shown}${suffix}`.slice(0, CLI_AUTH_LABEL_MAX_LENGTH);
};

/** The name people gave the machine: macOS ComputerName, else the hostname. */
const machineName = (): string => {
  if (process.platform === "darwin") {
    try {
      const out = spawnSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const name = typeof out.stdout === "string" ? out.stdout.trim() : "";
      if (out.status === 0 && name.length > 0) return name;
    } catch {
      // fall through
    }
  }
  return osHostname().replace(/\.local$/, "");
};

export const defaultCliAuthLabel = (): string =>
  buildCliAuthLabel({
    hostname: machineName(),
    platform: process.platform,
    version: CLI_VERSION,
  });

/** D10: the terminal's success line — `✔ Connected as dou@gmail.com`. */
export const signedInLines = (
  who: {
    readonly email?: string;
    readonly keyName?: string;
  },
  style: TTermStyle = plainStyle,
): string => {
  const account = who.email !== undefined ? ` as ${style.bold(who.email)}` : "";
  const key =
    who.keyName !== undefined ? style.dim(` · key "${who.keyName}"`) : "";
  return `\n${style.green("✔")} Connected${account}${key}\n`;
};

type TTimedOut = { readonly kind: "timeout" };
type TAborted = { readonly kind: "aborted" };
type TNetwork = { readonly kind: "network" };
type THttp = { readonly kind: "http"; readonly response: Response };
type TFetchOutcome = TTimedOut | TAborted | TNetwork | THttp;

type TBodyOk<T> = { readonly kind: "ok"; readonly body: T };
type TBodyOutcome<T> =
  | TBodyOk<T>
  | TTimedOut
  | TAborted
  | { readonly kind: "invalid" };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sleep that wakes early when `signal` aborts. Without a signal, delegates to
 * `sleep`. Always resolves (never rejects) so the poll loop can cancelAuth.
 */
export const abortableSleep = async (
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<"slept" | "aborted"> => {
  if (signal?.aborted) return "aborted";
  if (signal === undefined) {
    await sleep(ms);
    return "slept";
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    sleep(ms).then(finish, finish);
  });
  return signal.aborted ? "aborted" : "slept";
};

export type TSignalProcess = {
  readonly on: (signal: NodeJS.Signals, listener: () => void) => unknown;
  readonly off: (signal: NodeJS.Signals, listener: () => void) => unknown;
};

/**
 * Abort `controller` on SIGINT/SIGTERM. Returns a disposer that removes the
 * listeners. Installing the listeners also suppresses Node's default exit so
 * the OAuth poll can still call cancelAuth.
 */
export const abortOnProcessSignals = (
  controller: AbortController,
  signalProcess: TSignalProcess = process,
): (() => void) => {
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  const onSigint = (): void => abort();
  const onSigterm = (): void => abort();
  signalProcess.on("SIGINT", onSigint);
  signalProcess.on("SIGTERM", onSigterm);
  return (): void => {
    signalProcess.off("SIGINT", onSigint);
    signalProcess.off("SIGTERM", onSigterm);
  };
};

const defaultOpenUrl = async (url: string): Promise<boolean> => {
  try {
    const cmd: readonly [string, ...string[]] =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    const [bin, ...args] = cmd;
    const proc = spawn(bin, args, {
      stdio: "ignore",
      detached: true,
    });
    // A missing opener (headless Linux, SSH) fails async via `error`, not a
    // throw — wait for spawn/error so the "open it on another device" hint shows.
    const started = await new Promise<boolean>((resolve) => {
      proc.once("spawn", () => resolve(true));
      proc.once("error", () => resolve(false));
    });
    proc.unref();
    return started;
  } catch {
    return false;
  }
};

type TResolvedIo = {
  readonly write: (message: string) => void;
  readonly openUrl: (url: string) => Promise<boolean>;
  readonly fetch: TCliAuthFetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal | undefined;
  readonly waitMs: number;
  readonly requestTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly interactive: boolean;
  readonly noBrowser: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly waitForEnter: (signal: AbortSignal) => Promise<boolean>;
  readonly promptLine: (
    question: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
  readonly style: TTermStyle;
  /** Show an animated wait line (styled terminals only); any write clears it. */
  readonly startSpinner: (text: string) => void;
  readonly stopSpinner: () => void;
  /** The user's Enter echoed a newline under the wait line: step back up. */
  readonly afterEnterEcho: () => void;
};

const defaultFetch: TCliAuthFetch = (input, init) => fetch(input, init);

const SPINNER_INTERVAL_MS = 80;

const resolveIo = (io: TCliAuthLoginIo): TResolvedIo => {
  const rawWrite =
    io.write ?? ((message: string) => process.stderr.write(message));
  const env = io.env ?? process.env;
  const style =
    (io.color ?? (io.write === undefined && stderrColorEnabled(env)))
      ? termStyle(true)
      : plainStyle;

  // The wait line animates in place, so anything else written while it
  // spins first erases it; a finished line (ending in a newline) brings it
  // back underneath, a prompt (no newline) leaves it off for the answer.
  let spinner: {
    readonly text: string;
    frame: number;
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  const drawSpinner = (): void => {
    if (spinner === null) return;
    const glyph = SPINNER_FRAMES[spinner.frame % SPINNER_FRAMES.length] ?? "";
    rawWrite(`${CLEAR_LINE}${style.dim(`${glyph} ${spinner.text}`)}`);
  };
  const stopSpinner = (): void => {
    if (spinner === null) return;
    clearInterval(spinner.timer);
    spinner = null;
    rawWrite(CLEAR_LINE);
  };
  const startSpinner = (text: string): void => {
    if (!style.enabled) {
      rawWrite(`${text}\n`);
      return;
    }
    stopSpinner();
    const timer = setInterval(() => {
      if (spinner === null) return;
      spinner.frame += 1;
      drawSpinner();
    }, SPINNER_INTERVAL_MS);
    // Never hold the process open just to animate.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    spinner = { text, frame: 0, timer };
    drawSpinner();
  };
  const write = (message: string): void => {
    if (spinner === null) {
      rawWrite(message);
      return;
    }
    const text = spinner.text;
    stopSpinner();
    rawWrite(message);
    if (message.endsWith("\n")) startSpinner(text);
  };

  return {
    write,
    openUrl: io.openUrl ?? defaultOpenUrl,
    fetch: io.fetch ?? defaultFetch,
    now: io.now ?? Date.now,
    sleep: io.sleep ?? defaultSleep,
    signal: io.signal,
    waitMs: io.waitMs ?? CLI_AUTH_WAIT_MS,
    requestTimeoutMs: io.requestTimeoutMs ?? CLI_AUTH_REQUEST_TIMEOUT_MS,
    maxBodyBytes: io.maxBodyBytes ?? CLI_AUTH_MAX_BODY_BYTES,
    interactive: io.interactive ?? false,
    noBrowser: io.noBrowser ?? false,
    env,
    waitForEnter:
      io.waitForEnter ??
      (async (signal: AbortSignal): Promise<boolean> =>
        (await readTtyLine(signal)) !== null),
    promptLine:
      io.promptLine ??
      ((question: string, signal: AbortSignal): Promise<string | null> => {
        write(question);
        return readTtyLine(signal);
      }),
    style,
    startSpinner,
    stopSpinner,
    afterEnterEcho: () => {
      if (spinner === null) return;
      rawWrite("\x1b[1A");
      drawSpinner();
    },
  };
};

const openUrlHint = (io: TResolvedIo): void => {
  io.write(
    "(Could not open a browser automatically — paste the link above.)\n",
  );
};

const cancelAuth = async (
  base: string,
  id: string,
  pollToken: string,
  io: TResolvedIo,
): Promise<void> => {
  try {
    await io.fetch(`${base}/api/cli/auth/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poll_token: pollToken }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // best-effort
  }
};

/** Transient statuses that are safe to retry against the same auth. */
export const isRetryableCliAuthHttpStatus = (status: number): boolean =>
  status === 408 ||
  status === 425 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504;

/** @deprecated Prefer `isRetryableCliAuthHttpStatus` (same predicate). */
export const isRetryableCliAuthClaimStatus = isRetryableCliAuthHttpStatus;

export const isAbortError = (error: unknown): boolean => {
  if (error === undefined || error === null || typeof error !== "object")
    return false;
  const name = "name" in error ? error.name : undefined;
  return name === "AbortError" || name === "TimeoutError";
};

export const remainingDeadlineMs = (
  deadlineMs: number,
  nowMs: number,
): number => Math.max(0, deadlineMs - nowMs);

export const requestBudgetMs = (
  deadlineMs: number,
  nowMs: number,
  perRequestCapMs: number = CLI_AUTH_REQUEST_TIMEOUT_MS,
): number => Math.min(perRequestCapMs, remainingDeadlineMs(deadlineMs, nowMs));

/**
 * Combine an optional caller signal with a timeout. Aborting either aborts
 * the returned signal; the timeout is cleared when `cleanup` runs.
 */
export const combineAbortSignals = (
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly cleanup: () => void } => {
  const controller = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = (): void => {
    if (settled) return;
    settled = true;
    controller.abort(
      caller?.reason instanceof Error
        ? caller.reason
        : new DOMException("Aborted", "AbortError"),
    );
  };
  const abortFromTimeout = (): void => {
    if (settled) return;
    settled = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  };
  if (caller?.aborted) {
    abortFromCaller();
    return { signal: controller.signal, cleanup: () => {} };
  }
  if (timeoutMs <= 0) {
    abortFromTimeout();
    return { signal: controller.signal, cleanup: () => {} };
  }
  if (caller !== undefined) caller.addEventListener("abort", abortFromCaller);
  timer = setTimeout(abortFromTimeout, timeoutMs);
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (caller !== undefined)
      caller.removeEventListener("abort", abortFromCaller);
  };
  return { signal: controller.signal, cleanup };
};

const fetchBounded = async (
  fetchImpl: TCliAuthFetch,
  input: string,
  init: RequestInit,
  deadlineMs: number,
  now: () => number,
  caller: AbortSignal | undefined,
  perRequestCapMs: number,
): Promise<TFetchOutcome> => {
  if (caller?.aborted) return { kind: "aborted" };
  const budget = requestBudgetMs(deadlineMs, now(), perRequestCapMs);
  if (budget <= 0) return { kind: "timeout" };
  const { signal, cleanup } = combineAbortSignals(caller, budget);
  try {
    const response = await fetchImpl(input, { ...init, signal });
    return { kind: "http", response };
  } catch (error) {
    if (caller?.aborted) return { kind: "aborted" };
    if (isAbortError(error)) {
      return caller?.aborted ? { kind: "aborted" } : { kind: "timeout" };
    }
    return { kind: "network" };
  } finally {
    cleanup();
  }
};

const abortOutcome = <T>(
  caller: AbortSignal | undefined,
): Extract<TBodyOutcome<T>, { readonly kind: "aborted" | "timeout" }> =>
  caller?.aborted ? { kind: "aborted" } : { kind: "timeout" };

/** Best-effort cancel that must not hang the login loop. */
const cancelReaderBestEffort = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void => {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // ignore
  }
};

const raceAgainstAbort = <T>(
  work: Promise<T>,
  signal: AbortSignal,
  caller: AbortSignal | undefined,
): Promise<
  | { readonly kind: "value"; readonly value: T }
  | Extract<TBodyOutcome<unknown>, { readonly kind: "aborted" | "timeout" }>
> => {
  if (signal.aborted) return Promise.resolve(abortOutcome(caller));
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(abortOutcome(caller));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "value", value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (caller?.aborted || isAbortError(error)) {
          resolve(abortOutcome(caller));
          return;
        }
        // Surface as timeout-equivalent failure for the body reader.
        resolve(abortOutcome(caller));
      },
    );
  });
};

const readJsonBounded = async <T>(
  res: Response,
  deadlineMs: number,
  now: () => number,
  caller: AbortSignal | undefined,
  perRequestCapMs: number,
  maxBytes: number,
): Promise<TBodyOutcome<T>> => {
  if (caller?.aborted) return { kind: "aborted" };
  const budget = requestBudgetMs(deadlineMs, now(), perRequestCapMs);
  if (budget <= 0) return { kind: "timeout" };
  const lengthHeader = res.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes)
      return { kind: "invalid" };
  }
  const { signal, cleanup } = combineAbortSignals(caller, budget);
  try {
    if (signal.aborted) return abortOutcome(caller);
    const reader = res.body?.getReader();
    if (reader === undefined) {
      // No stream (tests / synthetic Response) — still race json() against budget.
      const jsonPromise = res.json().then(
        (body): TBodyOutcome<T> => ({ kind: "ok", body: body as T }),
        (): TBodyOutcome<T> => ({ kind: "invalid" }),
      );
      const raced = await raceAgainstAbort(jsonPromise, signal, caller);
      if (raced.kind !== "value") return raced;
      return raced.value;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      if (signal.aborted) {
        cancelReaderBestEffort(reader);
        return abortOutcome(caller);
      }
      const raced = await raceAgainstAbort(reader.read(), signal, caller);
      if (raced.kind !== "value") {
        cancelReaderBestEffort(reader);
        return raced;
      }
      const { done, value } = raced.value;
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        if (total > maxBytes) {
          cancelReaderBestEffort(reader);
          return { kind: "invalid" };
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      // A `null`/array/scalar body would throw on field access below and skip
      // cancelAuth — treat it like any other malformed body.
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return { kind: "invalid" };
      return { kind: "ok", body: parsed as T };
    } catch {
      return { kind: "invalid" };
    }
  } catch (error) {
    if (caller?.aborted || isAbortError(error)) return abortOutcome(caller);
    return { kind: "invalid" };
  } finally {
    cleanup();
  }
};

export const terminalAuthHttpMessage = (
  phase: "start" | "status" | "claim",
  status: number,
): string => {
  if (status === 404) {
    return phase === "start"
      ? "[openllm] could not start login (missing).\n"
      : `[openllm] authorization was missing (${status}).\n`;
  }
  if (status === 410) return "[openllm] authorization expired.\n";
  if (status === 401 || status === 403) {
    return `[openllm] authorization was refused (${status}).\n`;
  }
  if (phase === "start") {
    return `[openllm] could not start login (${status}). Try again, or paste a key with \`openllm login --api-key\`.\n`;
  }
  if (phase === "claim") {
    return `[openllm] could not claim the key (${status}).\n`;
  }
  return `[openllm] authorization status failed (${status}).\n`;
};

const parseSealed = (raw: string): TCliAuthSealed | null => {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("v" in value) ||
      !("epk" in value) ||
      !("nonce" in value) ||
      !("ct" in value)
    ) {
      return null;
    }
    const envelope = value as {
      readonly v: unknown;
      readonly epk: unknown;
      readonly nonce: unknown;
      readonly ct: unknown;
    };
    if (
      envelope.v !== 1 ||
      typeof envelope.epk !== "string" ||
      typeof envelope.nonce !== "string" ||
      typeof envelope.ct !== "string"
    ) {
      return null;
    }
    return {
      v: 1,
      epk: envelope.epk,
      nonce: envelope.nonce,
      ct: envelope.ct,
    };
  } catch {
    return null;
  }
};

type TSession = {
  readonly base: string;
  readonly id: string;
  readonly pollToken: string;
  readonly authorizeUrl: string;
  readonly userCode: string | null;
  readonly publicKeyB64: string;
  readonly privateKey: CryptoKey;
};

type TCreateOutcome =
  | {
      readonly ok: true;
      readonly id: string;
      readonly pollToken: string;
      readonly authorizeUrl: string;
      readonly userCode: string | null;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly message: string };

const CANCELLED_MESSAGE = "[openllm] login cancelled.\n";

const startFailed = (reason: string): TCreateOutcome => ({
  ok: false,
  message: `[openllm] could not start login (${reason}). Try again, or paste a key with \`openllm login --api-key\`.\n`,
});

/** POST /api/cli/auth and validate what comes back. Never prints. */
const createCliAuth = async (
  base: string,
  r: TResolvedIo,
  publicKeyB64: string,
  label: string,
  deadline: number,
): Promise<TCreateOutcome> => {
  if (r.signal?.aborted) return { ok: false, message: CANCELLED_MESSAGE };
  const createOutcome = await fetchBounded(
    r.fetch,
    `${base}/api/cli/auth`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ caller_pubkey: publicKeyB64, label }),
    },
    deadline,
    r.now,
    r.signal,
    r.requestTimeoutMs,
  );
  if (createOutcome.kind === "aborted") {
    return { ok: false, message: CANCELLED_MESSAGE };
  }
  if (createOutcome.kind === "timeout") return startFailed("timed out");
  if (createOutcome.kind === "network") return startFailed("network error");
  if (!createOutcome.response.ok) {
    if (isRetryableCliAuthHttpStatus(createOutcome.response.status)) {
      return startFailed(String(createOutcome.response.status));
    }
    return {
      ok: false,
      message: terminalAuthHttpMessage("start", createOutcome.response.status),
    };
  }
  const createdBody = await readJsonBounded<TCreated>(
    createOutcome.response,
    deadline,
    r.now,
    r.signal,
    r.requestTimeoutMs,
    r.maxBodyBytes,
  );
  if (createdBody.kind === "aborted") {
    return { ok: false, message: CANCELLED_MESSAGE };
  }
  if (createdBody.kind === "timeout") return startFailed("timed out");
  if (createdBody.kind !== "ok") {
    return {
      ok: false,
      message: "[openllm] could not start login (bad response).\n",
    };
  }
  const id = createdBody.body.id;
  const pollToken = createdBody.body.poll_token;
  const authorizeUrl = createdBody.body.authorize_url;
  if (typeof id !== "string" || typeof pollToken !== "string") {
    return {
      ok: false,
      message: "[openllm] could not start login (bad response).\n",
    };
  }
  if (typeof authorizeUrl !== "string") {
    // Create succeeded — abandon the pending row so it does not count toward
    // the per-IP pending cap.
    await cancelAuth(base, id, pollToken, r);
    return {
      ok: false,
      message: "[openllm] could not start login (bad response).\n",
    };
  }
  let safeAuthorizeUrl: string;
  try {
    const url = new URL(authorizeUrl, base);
    if (
      url.origin !== new URL(base).origin ||
      url.pathname !== `/cli/authorize/${encodeURIComponent(id)}` ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    )
      throw new Error("invalid URL");
    // Print/open the validated canonical href — never the raw server string
    // (relative paths, surrounding whitespace).
    safeAuthorizeUrl = url.href;
  } catch {
    await cancelAuth(base, id, pollToken, r);
    return {
      ok: false,
      message: "[openllm] could not start login (invalid authorization URL).\n",
    };
  }
  const code = createdBody.body.user_code;
  return {
    ok: true,
    id,
    pollToken,
    authorizeUrl: safeAuthorizeUrl,
    // Display only: anything but the documented shape is dropped, never echoed.
    userCode:
      typeof code === "string" && USER_CODE_DISPLAY.test(code) ? code : null,
    expiresAt:
      typeof createdBody.body.expires_at === "string"
        ? createdBody.body.expires_at
        : "",
  };
};

/** True when the env says this shell is on the far end of SSH. */
const isRemoteSession = (
  env: Readonly<Record<string, string | undefined>>,
): boolean =>
  (env.SSH_CONNECTION ?? "").length > 0 || (env.SSH_TTY ?? "").length > 0;

const browserDisabled = (r: TResolvedIo): boolean =>
  r.noBrowser === true || r.env.OPENLLM_NO_BROWSER === "1";

const writeQr = (r: TResolvedIo, url: string): void => {
  const qr = encodeQr(url);
  if (qr === null) return;
  r.write(
    `\n  ${r.style.dim("Or scan this with your phone:")}\n${renderQrHalfBlocks(qr)}\n`,
  );
};

/** The wait line under the link (animated on a styled terminal). */
const WAITING_TEXT = "Waiting for you to approve in the browser…";

type TPresented = {
  /** Stop listening for Enter (the terminal is needed for something else). */
  readonly stop: () => void;
  /** Resolves once any open triggered by Enter has finished printing. */
  readonly settled: () => Promise<void>;
};

/**
 * Print the code + link, then decide how the browser gets opened (D3/D4):
 *   - `--no-browser`, `OPENLLM_NO_BROWSER=1` or SSH → print + QR, never open;
 *   - a terminal → "Press Enter to open", open on Enter (QR if that fails);
 *   - no terminal → print only.
 * Polling runs meanwhile, so approving on a phone never needs the Enter.
 *
 * Layout (the copy agreed in the CLI sign-in mockup):
 *
 *   Connect this computer to OpenLLM
 *
 *     Your code  WDJB-MJHT
 *     Press Enter to open the browser, or visit:
 *     https://openllm.sh/cli/authorize/…
 *
 *   ⠋ Waiting for you to approve in the browser…
 */
const presentAuthorizeLink = (
  session: TSession,
  r: TResolvedIo,
): TPresented => {
  const { bold, dim } = r.style;
  const noOpen = browserDisabled(r) || isRemoteSession(r.env);
  const hint = noOpen
    ? "Open this link on any device, a phone too:"
    : r.interactive
      ? "Press Enter to open the browser, or visit:"
      : "Open this link on any device to approve:";
  r.write(`\n${bold("Connect this computer to OpenLLM")}\n\n`);
  if (session.userCode !== null) {
    r.write(
      `  Your code  ${bold(session.userCode)}  ${dim("(the browser shows the same)")}\n`,
    );
  }
  r.write(`  ${dim(hint)}\n  ${session.authorizeUrl}\n`);
  const idle: TPresented = { stop: () => {}, settled: async () => {} };
  if (noOpen) {
    writeQr(r, session.authorizeUrl);
    r.write("\n");
    r.startSpinner(WAITING_TEXT);
    return idle;
  }
  r.write("\n");
  r.startSpinner(WAITING_TEXT);
  if (!r.interactive) return idle;
  const listening = new AbortController();
  let opening: Promise<void> = Promise.resolve();
  void r.waitForEnter(listening.signal).then((pressed) => {
    if (!pressed || listening.signal.aborted) return;
    r.afterEnterEcho();
    opening = r.openUrl(session.authorizeUrl).then((opened) => {
      if (opened || listening.signal.aborted) return;
      openUrlHint(r);
      writeQr(r, session.authorizeUrl);
    });
  });
  return {
    stop: () => listening.abort(),
    settled: () => opening,
  };
};

/**
 * Poll status until approved, then claim and open the sealed key. Shared by
 * the interactive login and `--resume`.
 */
const pollAndClaim = async (
  session: TSession,
  r: TResolvedIo,
  deadline: number,
  releaseTerminal: () => void,
): Promise<TCliAuthLoginResult> => {
  const { base, id, pollToken } = session;
  const pause = async (ms: number): Promise<"slept" | "aborted"> =>
    abortableSleep(ms, r.signal, r.sleep);

  // Set on the first claim 200: from then on every failure also says a key
  // exists on the account (cancel no longer revokes a claimed key).
  let issued = false;
  let issuedKeyId: string | undefined;
  let issuedKeyMinted: boolean | undefined;
  const failed = (message: string): TCliAuthLoginResult => ({
    ok: false,
    message: issued
      ? `${message}${unsavedKeyNotice(base, issuedKeyId, issuedKeyMinted)}`
      : message,
  });

  const cancelled = async (): Promise<TCliAuthLoginResult> => {
    await cancelAuth(base, id, pollToken, r);
    return failed(CANCELLED_MESSAGE);
  };

  // No clamp to `expires_at`: it is on the server's clock, and a local clock
  // running ahead would shorten (or zero) the poll window. The server reports
  // expiry itself (`status: "expired"` / 410); `waitMs` bounds the loop.
  // D21: network errors and 429 back off exponentially (cap 10 s); every
  // other wait is the plain poll interval.
  let failures = 0;
  const retryAfter = async (
    backoff: boolean,
  ): Promise<"continue" | "deadline" | "aborted"> => {
    failures = backoff ? failures + 1 : 0;
    const ms = backoff ? cliAuthBackoffMs(failures) : CLI_AUTH_POLL_MS;
    if (r.now() + ms >= deadline) return "deadline";
    return (await pause(ms)) === "aborted" ? "aborted" : "continue";
  };

  while (r.now() < deadline) {
    if (r.signal?.aborted) return cancelled();
    const statusOutcome = await fetchBounded(
      r.fetch,
      `${base}/api/cli/auth/${encodeURIComponent(id)}/status`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ poll_token: pollToken }),
      },
      deadline,
      r.now,
      r.signal,
      r.requestTimeoutMs,
    );
    if (statusOutcome.kind === "aborted") return cancelled();
    if (statusOutcome.kind === "timeout" || statusOutcome.kind === "network") {
      const next = await retryAfter(true);
      if (next === "aborted") return cancelled();
      if (next === "deadline") break;
      continue;
    }
    if (!statusOutcome.response.ok) {
      if (isRetryableCliAuthHttpStatus(statusOutcome.response.status)) {
        const next = await retryAfter(statusOutcome.response.status === 429);
        if (next === "aborted") return cancelled();
        if (next === "deadline") break;
        continue;
      }
      await cancelAuth(base, id, pollToken, r);
      return failed(
        terminalAuthHttpMessage("status", statusOutcome.response.status),
      );
    }
    const statusBody = await readJsonBounded<TStatus>(
      statusOutcome.response,
      deadline,
      r.now,
      r.signal,
      r.requestTimeoutMs,
      r.maxBodyBytes,
    );
    if (statusBody.kind === "aborted") return cancelled();
    if (statusBody.kind === "timeout" || statusBody.kind === "invalid") {
      const next = await retryAfter(false);
      if (next === "aborted") return cancelled();
      if (next === "deadline") break;
      continue;
    }
    const { status } = statusBody.body;
    if (status === "denied" || status === "cancelled") {
      return failed(`[openllm] authorization was ${status}.\n`);
    }
    if (status === "expired") {
      return failed(
        "[openllm] authorization expired. Run `openllm login` again for a new link.\n",
      );
    }
    if (status === "approved") {
      // Stop the concurrent Enter-to-open waiter before claiming.
      releaseTerminal();
      // Claim is same-caller idempotent until original expiry. Retry
      // transient network / retryable HTTP against THIS auth only —
      // never recreate. Abort during claim cancels and reports
      // cancellation; terminal failures best-effort cancel.
      while (r.now() < deadline) {
        if (r.signal?.aborted) return cancelled();
        const claimOutcome = await fetchBounded(
          r.fetch,
          `${base}/api/cli/auth/${encodeURIComponent(id)}/claim`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              poll_token: pollToken,
            }),
          },
          deadline,
          r.now,
          r.signal,
          r.requestTimeoutMs,
        );
        if (claimOutcome.kind === "aborted") return cancelled();
        if (
          claimOutcome.kind === "timeout" ||
          claimOutcome.kind === "network"
        ) {
          if (r.now() + CLI_AUTH_POLL_MS >= deadline) {
            await cancelAuth(base, id, pollToken, r);
            return failed(
              claimOutcome.kind === "timeout"
                ? "[openllm] could not claim the key (timed out).\n"
                : "[openllm] could not claim the key (network error).\n",
            );
          }
          if ((await pause(CLI_AUTH_POLL_MS)) === "aborted") return cancelled();
          continue;
        }
        if (!claimOutcome.response.ok) {
          const httpStatus = claimOutcome.response.status;
          if (isRetryableCliAuthHttpStatus(httpStatus)) {
            if (r.now() + CLI_AUTH_POLL_MS >= deadline) {
              await cancelAuth(base, id, pollToken, r);
              return failed(
                `[openllm] could not claim the key (${httpStatus}).\n`,
              );
            }
            if ((await pause(CLI_AUTH_POLL_MS)) === "aborted")
              return cancelled();
            continue;
          }
          await cancelAuth(base, id, pollToken, r);
          return failed(terminalAuthHttpMessage("claim", httpStatus));
        }
        issued = true;
        const claimed = await readJsonBounded<TClaimed>(
          claimOutcome.response,
          deadline,
          r.now,
          r.signal,
          r.requestTimeoutMs,
          r.maxBodyBytes,
        );
        if (claimed.kind === "aborted") return cancelled();
        if (claimed.kind === "timeout") {
          if (r.now() + CLI_AUTH_POLL_MS >= deadline) {
            await cancelAuth(base, id, pollToken, r);
            return failed("[openllm] could not claim the key (timed out).\n");
          }
          if ((await pause(CLI_AUTH_POLL_MS)) === "aborted") return cancelled();
          continue;
        }
        if (
          claimed.kind !== "ok" ||
          typeof claimed.body.user_id !== "string" ||
          claimed.body.user_id.length === 0 ||
          typeof claimed.body.sealed !== "string"
        ) {
          await cancelAuth(base, id, pollToken, r);
          return failed("[openllm] could not claim the key (bad response).\n");
        }
        if (typeof claimed.body.key_id === "string")
          issuedKeyId = claimed.body.key_id;
        if (typeof claimed.body.key_minted === "boolean")
          issuedKeyMinted = claimed.body.key_minted;
        const sealed = parseSealed(claimed.body.sealed);
        if (sealed === null) {
          await cancelAuth(base, id, pollToken, r);
          return failed(
            "[openllm] claimed payload was not a valid sealed key.\n",
          );
        }
        let plaintext: Uint8Array;
        try {
          plaintext = await openCliAuthSealed(
            {
              userId: claimed.body.user_id,
              authorizationId: id,
              recipientPublicKeyB64: session.publicKeyB64,
            },
            sealed,
            session.privateKey,
          );
        } catch {
          await cancelAuth(base, id, pollToken, r);
          return failed("[openllm] could not open the sealed key.\n");
        }
        try {
          const apiKey = new TextDecoder().decode(plaintext).trim();
          // Bare `sk-llm-…` or `sk-llm-….<anchor>` — the anchor rides when the
          // approving browser could derive it (device sessions).
          if (splitAnchoredApiKey(apiKey) === null) {
            await cancelAuth(base, id, pollToken, r);
            return failed("[openllm] claimed key format is invalid.\n");
          }
          const email = displayText(claimed.body.email);
          const keyName = displayText(claimed.body.key_name);
          return {
            ok: true,
            apiKey,
            keyId: issuedKeyId,
            ...(issuedKeyMinted !== undefined
              ? { keyMinted: issuedKeyMinted }
              : {}),
            ...(email !== null ? { email } : {}),
            ...(keyName !== null ? { keyName } : {}),
          };
        } finally {
          zero(plaintext);
        }
      }
      await cancelAuth(base, id, pollToken, r);
      return failed("[openllm] authorization timed out.\n");
    }
    const next = await retryAfter(false);
    if (next === "aborted") return cancelled();
    if (next === "deadline") break;
  }
  await cancelAuth(base, id, pollToken, r);
  return failed("[openllm] authorization timed out.\n");
};

/** A server string fit for one terminal line, or null. */
const displayText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\p{Cc}/gu, "").trim();
  return clean.length === 0 ? null : clean.slice(0, 200);
};

/**
 * Run the browser-handover login against `origin`. Returns the plaintext
 * API key on success (caller persists it). Never logs the key, poll token,
 * or sealed ciphertext — only the authorize URL (id only) and the user code.
 */
export const runCliAuthLogin = async (
  origin: string,
  io: TCliAuthLoginIo = {},
): Promise<TCliAuthLoginResult> => {
  const r = resolveIo(io);
  const base = origin.replace(/\/+$/, "");
  // Overall budget starts before create so a hanging create cannot outlive it.
  const deadline = r.now() + r.waitMs;
  const pair = await generateCliAuthKeypair();
  const created = await createCliAuth(
    base,
    r,
    pair.publicKeyB64,
    io.label ?? defaultCliAuthLabel(),
    deadline,
  );
  if (!created.ok) return created;
  const session: TSession = {
    base,
    id: created.id,
    pollToken: created.pollToken,
    authorizeUrl: created.authorizeUrl,
    userCode: created.userCode,
    publicKeyB64: pair.publicKeyB64,
    privateKey: pair.privateKey,
  };
  const presented = presentAuthorizeLink(session, r);
  try {
    return await pollAndClaim(session, r, deadline, presented.stop);
  } finally {
    presented.stop();
    await presented.settled();
    r.stopSpinner();
  }
};

// ─── D19: --non-interactive / --resume ────────────────────────────────

/** What `openllm login --non-interactive` prints (stdout JSON). */
export type TCliAuthHandoff = {
  readonly authorize_url: string;
  readonly code: string | null;
  readonly expires_in: number;
  readonly resume: string;
};

export type TCliAuthStartResult =
  | { readonly ok: true; readonly handoff: TCliAuthHandoff }
  | { readonly ok: false; readonly message: string };

/** Server ids are uuids; anything else never becomes a path. */
const RESUME_ID = /^[A-Za-z0-9-]{1,64}$/;

/** `~/.openllm/cli-auth/<id>.json` — 0600, deleted on resume. */
export const cliAuthStateFile = (id: string): string =>
  join(openllmDir(), "cli-auth", `${id}.json`);

type TResumeState = {
  readonly v: 1;
  readonly origin: string;
  readonly id: string;
  readonly poll_token: string;
  readonly authorize_url: string;
  readonly user_code: string | null;
  readonly public_key: string;
  readonly private_key_pkcs8: string;
};

/**
 * Create the request and hand it off instead of waiting: the private key and
 * poll token go to a 0600 state file, the link + code to the caller (an AI
 * agent hands them to a human). `resumeCliAuthLogin` finishes it.
 */
export const startCliAuthNonInteractive = async (
  origin: string,
  io: TCliAuthLoginIo = {},
): Promise<TCliAuthStartResult> => {
  const r = resolveIo(io);
  const base = origin.replace(/\/+$/, "");
  const pair = await generateResumableCliAuthKeypair();
  const created = await createCliAuth(
    base,
    r,
    pair.publicKeyB64,
    io.label ?? defaultCliAuthLabel(),
    r.now() + r.requestTimeoutMs,
  );
  if (!created.ok) return created;
  const state: TResumeState = {
    v: 1,
    origin: base,
    id: created.id,
    poll_token: created.pollToken,
    authorize_url: created.authorizeUrl,
    user_code: created.userCode,
    public_key: pair.publicKeyB64,
    private_key_pkcs8: pair.privateKeyPkcs8B64,
  };
  const file = cliAuthStateFile(created.id);
  try {
    if (!RESUME_ID.test(created.id)) throw new Error("bad id");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(state)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(file, 0o600);
  } catch {
    await cancelAuth(base, created.id, created.pollToken, r);
    return {
      ok: false,
      message:
        "[openllm] could not save the pending sign-in on this computer.\n",
    };
  }
  const expiresMs = Date.parse(created.expiresAt) - r.now();
  return {
    ok: true,
    handoff: {
      authorize_url: created.authorizeUrl,
      code: created.userCode,
      expires_in:
        Number.isFinite(expiresMs) && expiresMs > 0
          ? Math.round(expiresMs / 1000)
          : Math.round(CLI_AUTH_WAIT_MS / 1000),
      resume: `openllm login --resume ${created.id}`,
    },
  };
};

const readResumeState = (id: string): TResumeState | null => {
  try {
    const value: unknown = JSON.parse(
      readFileSync(cliAuthStateFile(id), "utf8"),
    );
    if (typeof value !== "object" || value === null) return null;
    const s = value as Record<string, unknown>;
    if (
      s.v !== 1 ||
      s.id !== id ||
      typeof s.origin !== "string" ||
      typeof s.poll_token !== "string" ||
      typeof s.authorize_url !== "string" ||
      typeof s.public_key !== "string" ||
      typeof s.private_key_pkcs8 !== "string"
    )
      return null;
    return {
      v: 1,
      origin: s.origin,
      id,
      poll_token: s.poll_token,
      authorize_url: s.authorize_url,
      user_code: typeof s.user_code === "string" ? s.user_code : null,
      public_key: s.public_key,
      private_key_pkcs8: s.private_key_pkcs8,
    };
  } catch {
    return null;
  }
};

const removeResumeState = (id: string): void => {
  try {
    unlinkSync(cliAuthStateFile(id));
  } catch {
    // already gone
  }
};

/**
 * `openllm login --resume <id>`: poll + claim a request started with
 * `--non-interactive`, against the origin it was created on. The state file
 * is removed whatever the outcome — every outcome either used the request
 * or ended it.
 */
export const resumeCliAuthLogin = async (
  id: string,
  io: TCliAuthLoginIo = {},
): Promise<TCliAuthLoginResult> => {
  if (!RESUME_ID.test(id)) {
    return { ok: false, message: "[openllm] that sign-in id is not valid.\n" };
  }
  const state = readResumeState(id);
  if (state === null) {
    return {
      ok: false,
      message: `[openllm] no pending sign-in ${id} on this computer. Start one with \`openllm login\`.\n`,
    };
  }
  const r = resolveIo(io);
  let privateKey: CryptoKey;
  try {
    privateKey = await importCliAuthPrivateKey(state.private_key_pkcs8);
  } catch {
    removeResumeState(id);
    return { ok: false, message: "[openllm] the saved sign-in is damaged.\n" };
  }
  const session: TSession = {
    base: state.origin,
    id,
    pollToken: state.poll_token,
    authorizeUrl: state.authorize_url,
    userCode: state.user_code,
    publicKeyB64: state.public_key,
    privateKey,
  };
  const { bold, dim } = r.style;
  if (state.user_code !== null) {
    r.write(`  Your code  ${bold(state.user_code)}\n`);
  }
  r.write(`  ${dim("Approve it at:")}\n  ${state.authorize_url}\n\n`);
  r.startSpinner(WAITING_TEXT);
  try {
    return await pollAndClaim(session, r, r.now() + r.waitMs, () => {});
  } finally {
    r.stopSpinner();
    removeResumeState(id);
  }
};

/** Install the trust anchor via `openllm daemon anchor` (stdin carries the
 *  anchored key — never argv). Same spawn as `openllm login`. */
const defaultAnchorDaemon = async (anchoredKey: string): Promise<number> => {
  try {
    const proc = Bun.spawn([...daemonInvocation(), "anchor"], {
      stdin: new TextEncoder().encode(anchoredKey),
      stdout: "ignore",
      stderr: "inherit",
    });
    return await proc.exited;
  } catch {
    return 1;
  }
};

export type TPersistClaimedApiKeyIo = {
  readonly anchorDaemon?: (anchoredKey: string) => Promise<number>;
};

/**
 * Persist a claimed key the same way `openllm login` does, then mirror into
 * process.env so the rest of this process sees it. Accepts a bare key or an
 * anchored `sk-llm-….<anchor>`: when an anchor is present, runs
 * `openllm daemon anchor` before saving so device sessions are installed.
 */
export const persistClaimedApiKey = async (
  apiKey: string,
  email?: string,
  io: TPersistClaimedApiKeyIo = {},
): Promise<boolean> => {
  const split = splitAnchoredApiKey(apiKey);
  if (split === null) return false;
  // Device sessions are optional (approve never fails over them either): a
  // failed anchor install still saves the claimed key, bare, so the login
  // never orphans a key that was already claimed.
  let anchored = false;
  if (split.anchor !== null) {
    const anchor = io.anchorDaemon ?? defaultAnchorDaemon;
    anchored = (await anchor(`${split.key}.${split.anchor}`)) === 0;
    if (!anchored) {
      process.stderr.write(
        "[openllm] Could not turn on device sessions; saving the key without them.\n",
      );
    }
  }
  // Anchored: `openllm daemon anchor` already wrote OPENLLM_DEVICE_ANCHOR.
  // Bare: blank a stale anchor that belongs to a different key id.
  const vars: Record<string, string> = anchored
    ? { OPENLLM_API_KEY: split.key }
    : apiKeyEnvVars(split.key);
  // Blank a stale account line: this key's account is only known when the
  // claim said so.
  if (
    email !== undefined ||
    (sharedFileConfig()[ACCOUNT_EMAIL_ENV] ?? "") !== ""
  )
    vars[ACCOUNT_EMAIL_ENV] = email ?? "";
  if (!saveEnvVars(vars)) return false;
  process.env.OPENLLM_API_KEY = split.key;
  return true;
};

export const cloudOriginForLogin = (): string => cliConfig().gatewayUrl;
