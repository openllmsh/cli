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

const readJson = async <T>(
  res: Response,
): Promise<
  { readonly ok: true; readonly body: T } | { readonly ok: false }
> => {
  try {
    const body = (await res.json()) as T;
    return { ok: true, body };
  } catch {
    return { ok: false };
  }
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
  const resolved: TResolvedIo = {
    write,
    openUrl,
    fetch: fetchImpl,
    now,
    sleep,
    signal,
  };

  const base = origin.replace(/\/+$/, "");
  const pair = await generateCliAuthKeypair();
  const label = `openllm on ${process.platform}`;
  let createRes: Response;
  try {
    createRes = await fetchImpl(`${base}/api/cli/auth`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        caller_pubkey: pair.publicKeyB64,
        label,
      }),
      signal,
    });
  } catch {
    return {
      ok: false,
      message:
        "[openllm] could not start login (network error). Try again, or paste a key with `openllm login --api-key`.\n",
    };
  }
  if (!createRes.ok) {
    return {
      ok: false,
      message: `[openllm] could not start login (${createRes.status}). Try again, or paste a key with \`openllm login --api-key\`.\n`,
    };
  }
  const created = await readJson<TCreated>(createRes);
  if (
    !created.ok ||
    typeof created.body.id !== "string" ||
    typeof created.body.poll_token !== "string" ||
    typeof created.body.authorize_url !== "string"
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
  } = created.body;
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

  const expiresAt = Date.parse(created.body.expires_at);
  const deadline = Math.min(
    Number.isFinite(expiresAt) ? expiresAt : Infinity,
    now() + CLI_AUTH_WAIT_MS,
  );

  while (now() < deadline) {
    if (signal?.aborted) {
      await cancelAuth(base, id, pollToken, resolved);
      return { ok: false, message: "[openllm] login cancelled.\n" };
    }
    let statusRes: Response;
    try {
      statusRes = await fetchImpl(
        `${base}/api/cli/auth/${encodeURIComponent(id)}/status`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ poll_token: pollToken }),
          signal,
        },
      );
    } catch {
      await sleep(CLI_AUTH_POLL_MS);
      continue;
    }
    if (statusRes.ok) {
      const statusBody = await readJson<TStatus>(statusRes);
      if (statusBody.ok) {
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
          let claimRes: Response;
          try {
            claimRes = await fetchImpl(
              `${base}/api/cli/auth/${encodeURIComponent(id)}/claim`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json",
                },
                body: JSON.stringify({ poll_token: pollToken }),
                signal,
              },
            );
          } catch {
            return {
              ok: false,
              message: "[openllm] could not claim the key (network error).\n",
            };
          }
          if (!claimRes.ok) {
            return {
              ok: false,
              message: `[openllm] could not claim the key (${claimRes.status}).\n`,
            };
          }
          const claimed = await readJson<TClaimed>(claimRes);
          if (
            !claimed.ok ||
            typeof claimed.body.user_id !== "string" ||
            claimed.body.user_id.length === 0 ||
            typeof claimed.body.sealed !== "string"
          ) {
            return {
              ok: false,
              message: "[openllm] could not claim the key (bad response).\n",
            };
          }
          const sealed = parseSealed(claimed.body.sealed);
          if (sealed === null) {
            return {
              ok: false,
              message:
                "[openllm] claimed payload was not a valid sealed key.\n",
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
            return {
              ok: false,
              message: "[openllm] could not open the sealed key.\n",
            };
          }
          try {
            const apiKey = new TextDecoder().decode(plaintext);
            if (!isUsableOpenllmApiKey(apiKey)) {
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
      }
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
