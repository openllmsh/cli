/**
 * Interactive OpenLLM OAuth login for the CLI: create a caller-bound pending
 * authorization, open/print the authorize URL, poll until approved, claim the
 * sealed API key, open it locally, and let the caller persist via
 * `persistClaimedApiKey` / `saveEnvVars`.
 *
 * No OAuth access/refresh tokens are retained — only the ordinary `sk-llm` key.
 * Crypto is local (`cli-auth-crypto.ts`); `@openllm/vault` is never imported.
 */

import { spawn } from "node:child_process";
import type { TCliAuthSealed } from "./cli-auth-crypto";
import {
  generateCliAuthKeypair,
  openCliAuthSealed,
  zero,
} from "./cli-auth-crypto";
import {
  cliConfig,
  DEVICE_ANCHOR_ENV,
  envFileHasDeviceAnchor,
  sharedFileConfig,
} from "./env";
import { saveEnvVars } from "./onboarding";
import { isUsableOpenllmApiKey, parseApiKeyId } from "./runtime-contracts";

export const CLI_AUTH_POLL_MS = 2_000;
/** Fallback wait when create response lacks a parseable expires_at. */
export const CLI_AUTH_WAIT_MS = 10 * 60 * 1000;
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
};

export type TCliAuthLoginResult =
  | { readonly ok: true; readonly apiKey: string }
  | { readonly ok: false; readonly message: string };

type TCreated = {
  readonly id: string;
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
  readonly sealed: string;
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
    proc.on("error", () => {});
    proc.unref();
    return true;
  } catch {
    return false;
  }
};

type TResolvedIo = TCliAuthLoginIo & {
  readonly write: (message: string) => void;
  readonly openUrl: (url: string) => Promise<boolean>;
  readonly fetch: TCliAuthFetch;
};

const defaultFetch: TCliAuthFetch = (input, init) => fetch(input, init);

const defaultIo = (): TResolvedIo => ({
  write: (message) => process.stderr.write(message),
  openUrl: defaultOpenUrl,
  fetch: defaultFetch,
  sleep: defaultSleep,
});

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
      const body = JSON.parse(new TextDecoder().decode(bytes)) as T;
      return { kind: "ok", body };
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

/**
 * Run the browser-handover login against `origin`. Returns the plaintext
 * API key on success (caller persists it). Never logs the key, poll token,
 * or sealed ciphertext — only the authorize URL (id only).
 */
export const runCliAuthLogin = async (
  origin: string,
  io: TCliAuthLoginIo = {},
): Promise<TCliAuthLoginResult> => {
  const defaults = defaultIo();
  const write = io.write ?? defaults.write;
  const openUrl = io.openUrl ?? defaults.openUrl;
  const fetchImpl = io.fetch ?? defaults.fetch;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? defaults.sleep ?? defaultSleep;
  const signal = io.signal;
  const waitMs = io.waitMs ?? CLI_AUTH_WAIT_MS;
  const requestTimeoutMs = io.requestTimeoutMs ?? CLI_AUTH_REQUEST_TIMEOUT_MS;
  const maxBodyBytes = io.maxBodyBytes ?? CLI_AUTH_MAX_BODY_BYTES;
  const resolved: TResolvedIo = {
    write,
    openUrl,
    fetch: fetchImpl,
    now,
    sleep,
    signal,
  };

  const base = origin.replace(/\/+$/, "");
  // Overall budget starts before create so a hanging create cannot outlive it.
  let deadline = now() + waitMs;
  const pair = await generateCliAuthKeypair();
  const label = `openllm on ${process.platform}`;

  if (signal?.aborted) {
    return { ok: false, message: "[openllm] login cancelled.\n" };
  }

  const createOutcome = await fetchBounded(
    fetchImpl,
    `${base}/api/cli/auth`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        caller_pubkey: pair.publicKeyB64,
        label,
      }),
    },
    deadline,
    now,
    signal,
    requestTimeoutMs,
  );
  if (createOutcome.kind === "aborted") {
    return { ok: false, message: "[openllm] login cancelled.\n" };
  }
  if (createOutcome.kind === "timeout") {
    return {
      ok: false,
      message:
        "[openllm] could not start login (timed out). Try again, or paste a key with `openllm login --api-key`.\n",
    };
  }
  if (createOutcome.kind === "network") {
    return {
      ok: false,
      message:
        "[openllm] could not start login (network error). Try again, or paste a key with `openllm login --api-key`.\n",
    };
  }
  if (!createOutcome.response.ok) {
    if (isRetryableCliAuthHttpStatus(createOutcome.response.status)) {
      return {
        ok: false,
        message: `[openllm] could not start login (${createOutcome.response.status}). Try again, or paste a key with \`openllm login --api-key\`.\n`,
      };
    }
    return {
      ok: false,
      message: terminalAuthHttpMessage("start", createOutcome.response.status),
    };
  }
  const createdBody = await readJsonBounded<TCreated>(
    createOutcome.response,
    deadline,
    now,
    signal,
    requestTimeoutMs,
    maxBodyBytes,
  );
  if (createdBody.kind === "aborted") {
    return { ok: false, message: "[openllm] login cancelled.\n" };
  }
  if (createdBody.kind === "timeout") {
    return {
      ok: false,
      message:
        "[openllm] could not start login (timed out). Try again, or paste a key with `openllm login --api-key`.\n",
    };
  }
  if (
    createdBody.kind !== "ok" ||
    typeof createdBody.body.id !== "string" ||
    typeof createdBody.body.poll_token !== "string" ||
    typeof createdBody.body.authorize_url !== "string"
  ) {
    return {
      ok: false,
      message: "[openllm] could not start login (bad response).\n",
    };
  }
  const {
    id,
    poll_token: pollToken,
    authorize_url: authorizeUrl,
  } = createdBody.body;
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
  } catch {
    return {
      ok: false,
      message: "[openllm] could not start login (invalid authorization URL).\n",
    };
  }
  write(
    `Open this link to authorize this CLI (works on another device too):\n  ${authorizeUrl}\n`,
  );
  const opened = await openUrl(authorizeUrl);
  if (!opened) openUrlHint(resolved);
  write("Waiting for approval…\n");

  const expiresAt = Date.parse(createdBody.body.expires_at);
  deadline = Math.min(
    deadline,
    Number.isFinite(expiresAt) ? expiresAt : Infinity,
  );

  while (now() < deadline) {
    if (signal?.aborted) {
      await cancelAuth(base, id, pollToken, resolved);
      return { ok: false, message: "[openllm] login cancelled.\n" };
    }
    const statusOutcome = await fetchBounded(
      fetchImpl,
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
      now,
      signal,
      requestTimeoutMs,
    );
    if (statusOutcome.kind === "aborted") {
      await cancelAuth(base, id, pollToken, resolved);
      return { ok: false, message: "[openllm] login cancelled.\n" };
    }
    if (statusOutcome.kind === "timeout") {
      if (now() + CLI_AUTH_POLL_MS >= deadline) break;
      await sleep(CLI_AUTH_POLL_MS);
      continue;
    }
    if (statusOutcome.kind === "network") {
      if (now() + CLI_AUTH_POLL_MS >= deadline) break;
      await sleep(CLI_AUTH_POLL_MS);
      continue;
    }
    if (!statusOutcome.response.ok) {
      if (isRetryableCliAuthHttpStatus(statusOutcome.response.status)) {
        if (now() + CLI_AUTH_POLL_MS >= deadline) break;
        await sleep(CLI_AUTH_POLL_MS);
        continue;
      }
      await cancelAuth(base, id, pollToken, resolved);
      return {
        ok: false,
        message: terminalAuthHttpMessage(
          "status",
          statusOutcome.response.status,
        ),
      };
    }
    const statusBody = await readJsonBounded<TStatus>(
      statusOutcome.response,
      deadline,
      now,
      signal,
      requestTimeoutMs,
      maxBodyBytes,
    );
    if (statusBody.kind === "aborted") {
      await cancelAuth(base, id, pollToken, resolved);
      return { ok: false, message: "[openllm] login cancelled.\n" };
    }
    if (statusBody.kind === "timeout" || statusBody.kind === "invalid") {
      if (now() + CLI_AUTH_POLL_MS >= deadline) break;
      await sleep(CLI_AUTH_POLL_MS);
      continue;
    }
    const { status } = statusBody.body;
    if (status === "denied" || status === "cancelled") {
      return {
        ok: false,
        message: `[openllm] authorization was ${status}.\n`,
      };
    }
    if (status === "expired") {
      return { ok: false, message: "[openllm] authorization expired.\n" };
    }
    if (status === "approved") {
      // Claim is same-caller idempotent until original expiry. Retry
      // transient network / retryable HTTP against THIS auth only —
      // never recreate. Abort during claim cancels and reports
      // cancellation; terminal failures best-effort cancel.
      while (now() < deadline) {
        if (signal?.aborted) {
          await cancelAuth(base, id, pollToken, resolved);
          return { ok: false, message: "[openllm] login cancelled.\n" };
        }
        const claimOutcome = await fetchBounded(
          fetchImpl,
          `${base}/api/cli/auth/${encodeURIComponent(id)}/claim`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ poll_token: pollToken }),
          },
          deadline,
          now,
          signal,
          requestTimeoutMs,
        );
        if (claimOutcome.kind === "aborted") {
          await cancelAuth(base, id, pollToken, resolved);
          return { ok: false, message: "[openllm] login cancelled.\n" };
        }
        if (
          claimOutcome.kind === "timeout" ||
          claimOutcome.kind === "network"
        ) {
          if (now() + CLI_AUTH_POLL_MS >= deadline) {
            await cancelAuth(base, id, pollToken, resolved);
            return {
              ok: false,
              message:
                claimOutcome.kind === "timeout"
                  ? "[openllm] could not claim the key (timed out).\n"
                  : "[openllm] could not claim the key (network error).\n",
            };
          }
          await sleep(CLI_AUTH_POLL_MS);
          continue;
        }
        if (!claimOutcome.response.ok) {
          if (isRetryableCliAuthHttpStatus(claimOutcome.response.status)) {
            if (now() + CLI_AUTH_POLL_MS >= deadline) {
              await cancelAuth(base, id, pollToken, resolved);
              return {
                ok: false,
                message: `[openllm] could not claim the key (${claimOutcome.response.status}).\n`,
              };
            }
            await sleep(CLI_AUTH_POLL_MS);
            continue;
          }
          await cancelAuth(base, id, pollToken, resolved);
          return {
            ok: false,
            message: terminalAuthHttpMessage(
              "claim",
              claimOutcome.response.status,
            ),
          };
        }
        const claimed = await readJsonBounded<TClaimed>(
          claimOutcome.response,
          deadline,
          now,
          signal,
          requestTimeoutMs,
          maxBodyBytes,
        );
        if (claimed.kind === "aborted") {
          await cancelAuth(base, id, pollToken, resolved);
          return { ok: false, message: "[openllm] login cancelled.\n" };
        }
        if (claimed.kind === "timeout") {
          if (now() + CLI_AUTH_POLL_MS >= deadline) {
            await cancelAuth(base, id, pollToken, resolved);
            return {
              ok: false,
              message: "[openllm] could not claim the key (timed out).\n",
            };
          }
          await sleep(CLI_AUTH_POLL_MS);
          continue;
        }
        if (
          claimed.kind !== "ok" ||
          typeof claimed.body.user_id !== "string" ||
          claimed.body.user_id.length === 0 ||
          typeof claimed.body.sealed !== "string"
        ) {
          await cancelAuth(base, id, pollToken, resolved);
          return {
            ok: false,
            message: "[openllm] could not claim the key (bad response).\n",
          };
        }
        const sealed = parseSealed(claimed.body.sealed);
        if (sealed === null) {
          await cancelAuth(base, id, pollToken, resolved);
          return {
            ok: false,
            message: "[openllm] claimed payload was not a valid sealed key.\n",
          };
        }
        let plaintext: Uint8Array;
        try {
          plaintext = await openCliAuthSealed(
            {
              userId: claimed.body.user_id,
              authorizationId: id,
              recipientPublicKeyB64: pair.publicKeyB64,
            },
            sealed,
            pair.privateKey,
          );
        } catch {
          await cancelAuth(base, id, pollToken, resolved);
          return {
            ok: false,
            message: "[openllm] could not open the sealed key.\n",
          };
        }
        try {
          const apiKey = new TextDecoder().decode(plaintext);
          if (!isUsableOpenllmApiKey(apiKey)) {
            await cancelAuth(base, id, pollToken, resolved);
            return {
              ok: false,
              message: "[openllm] claimed key format is invalid.\n",
            };
          }
          return { ok: true, apiKey: apiKey.trim() };
        } finally {
          zero(plaintext);
        }
      }
      await cancelAuth(base, id, pollToken, resolved);
      return { ok: false, message: "[openllm] authorization timed out.\n" };
    }
    await sleep(CLI_AUTH_POLL_MS);
  }
  await cancelAuth(base, id, pollToken, resolved);
  return { ok: false, message: "[openllm] authorization timed out.\n" };
};

/**
 * Persist a claimed key the same way `openllm login` does, then mirror into
 * process.env so the rest of this process sees it.
 */
export const persistClaimedApiKey = (apiKey: string): boolean => {
  if (!isUsableOpenllmApiKey(apiKey)) return false;
  const trimmed = apiKey.trim();
  const vars: Record<string, string> = { OPENLLM_API_KEY: trimmed };
  const savedKey = sharedFileConfig().OPENLLM_API_KEY;
  if (
    envFileHasDeviceAnchor() &&
    (savedKey === undefined ||
      parseApiKeyId(savedKey) === null ||
      parseApiKeyId(savedKey) !== parseApiKeyId(trimmed))
  )
    vars[DEVICE_ANCHOR_ENV] = "";
  if (!saveEnvVars(vars)) return false;
  process.env.OPENLLM_API_KEY = trimmed;
  return true;
};

export const cloudOriginForLogin = (): string => cliConfig().gatewayUrl;
