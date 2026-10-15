/**
 * Read-only "is the user already signed in to this vendor CLI on this
 * machine?" hint for the status snapshot (`host_signed_in`).
 *
 * The daemon runs every vendor CLI in its OWN isolated home
 * (`<state>/cli/<provider>/home`, see `cli-paths.ts`) and never reads, copies
 * or imports the user's personal `~/.claude` / `~/.codex` / `~/.kimi-code` /
 * `~/.grok` / `~/.config/cursor` credentials. This module does not change
 * that: it only answers whether the user's own vendor store looks signed in,
 * so onboarding can put that provider first with a one-tap Connect (which
 * still runs the normal vendor login in the isolated home).
 *
 * Rules every probe follows:
 *   - Plain file reads only. NO `security` / keychain call of any kind — a
 *     provider whose host store lives in the macOS keychain (Claude's token,
 *     Cursor, Muse, Antigravity) is answered from a non-keychain file or left
 *     unknown, so this can never raise a SecurityAgent prompt.
 *   - Nothing read leaves the function: a store is parsed only to test that a
 *     login field is a non-empty string, and the result is one boolean. No
 *     value, path or file content is logged or put on the wire.
 *   - `false` only for a definite answer (the store is absent, or holds no
 *     login). An unreadable / oversized / mid-write store is `undefined`
 *     (unknown), never `false`.
 *
 * Probes run inside status computation, so results are cached per provider
 * for {@link HOST_SIGN_IN_TTL_MS}; a status tick costs a map lookup. Reads are
 * async: `~/.claude.json` carries project history and can be tens of MB for a
 * heavy user, and a synchronous read of it would stall the daemon's event
 * loop — every in-flight proxied stream with it — once a minute.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { stateScoped } from "./state-scoped";

/** How long one provider's answer is reused before the files are re-read. */
export const HOST_SIGN_IN_TTL_MS = 60_000;

/** Larger than any credential file; `~/.claude.json` carries project history
 *  and can reach a few MB. Anything bigger is treated as unknown. */
const MAX_STORE_BYTES = 32 * 1024 * 1024;

/** Where the probe looks: the user's real home, OS and environment. */
export type THostSignInContext = {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
};

/** `$HOME` first, like the vendor CLIs themselves resolve `~` (and Node's
 *  `os.homedir()`; Bun's reads the passwd entry instead). */
const defaultContext = (): THostSignInContext => {
  const home = process.env.HOME;
  return {
    home: home !== undefined && home.length > 0 ? home : homedir(),
    platform: platform(),
    env: process.env,
  };
};

type TRead<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly value: T }
  | { readonly kind: "unknown" };

const ABSENT: TRead<never> = { kind: "absent" };
const UNKNOWN: TRead<never> = { kind: "unknown" };

const isMissing = (err: unknown): boolean => {
  const code = (err as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** Read + parse a JSON store. Missing → absent; anything else odd → unknown. */
const readJson = async (path: string): Promise<TRead<unknown>> => {
  try {
    const st = await stat(path);
    if (!st.isFile()) return UNKNOWN;
    if (st.size === 0) return ABSENT;
    if (st.size > MAX_STORE_BYTES) return UNKNOWN;
  } catch (err) {
    return isMissing(err) ? ABSENT : UNKNOWN;
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return isMissing(err) ? ABSENT : UNKNOWN;
  }
  try {
    return { kind: "present", value: JSON.parse(text) as unknown };
  } catch {
    // Possibly caught mid-write by the vendor CLI — not evidence either way.
    return UNKNOWN;
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): boolean =>
  typeof value === "string" && value.length > 0;

/** Any of `keys` on `obj` is a non-empty string (presence only, never read). */
const hasAnyString = (obj: unknown, keys: ReadonlyArray<string>): boolean =>
  isRecord(obj) && keys.some((k) => nonEmptyString(obj[k]));

const envDir = (ctx: THostSignInContext, name: string): string | undefined => {
  const value = ctx.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
};

/** Combine two required signals: definite false wins over unknown. */
const both = (
  a: boolean | undefined,
  b: boolean | undefined,
): boolean | undefined =>
  a === false || b === false
    ? false
    : a === true && b === true
      ? true
      : undefined;

const verdict = async <T>(
  pending: Promise<TRead<T>>,
  test: (value: T) => boolean,
): Promise<boolean | undefined> => {
  const read = await pending;
  return read.kind === "absent"
    ? false
    : read.kind === "present"
      ? test(read.value)
      : undefined;
};

type TProbeResult = Promise<boolean | undefined>;

/**
 * Claude Code. The account the CLI is signed in to is recorded in its global
 * config (`~/.claude.json` → `oauthAccount.accountUuid`; inside
 * `$CLAUDE_CONFIG_DIR` when that is set) — a plain file on every OS. The OAuth
 * token itself is in the macOS keychain (service "Claude Code-credentials"),
 * which is deliberately NOT queried; on Linux/Windows it is the file
 * `<config>/.credentials.json`, whose existence is additionally required there.
 */
const probeClaude = async (ctx: THostSignInContext): TProbeResult => {
  const configDir = envDir(ctx, "CLAUDE_CONFIG_DIR");
  const globalConfig =
    configDir !== undefined
      ? join(configDir, ".claude.json")
      : join(ctx.home, ".claude.json");
  const account = await verdict(readJson(globalConfig), (cfg) =>
    isRecord(cfg) ? hasAnyString(cfg.oauthAccount, ["accountUuid"]) : false,
  );
  if (ctx.platform === "darwin") return account;
  const credentials = await verdict(
    readJson(join(configDir ?? join(ctx.home, ".claude"), ".credentials.json")),
    (store) =>
      isRecord(store) &&
      hasAnyString(store.claudeAiOauth, ["refreshToken", "accessToken"]),
  );
  return both(account, credentials);
};

/**
 * Codex (ChatGPT). `$CODEX_HOME/auth.json` (default `~/.codex`). A ChatGPT
 * sign-in writes `tokens`; an API-key-only setup writes `OPENAI_API_KEY` with
 * no tokens, which is not a subscription login.
 */
const probeCodex = (ctx: THostSignInContext): TProbeResult => {
  const codexHome = envDir(ctx, "CODEX_HOME") ?? join(ctx.home, ".codex");
  return verdict(readJson(join(codexHome, "auth.json")), (store) =>
    isRecord(store)
      ? hasAnyString(store.tokens, ["refresh_token", "access_token"])
      : false,
  );
};

/** Kimi's token slots: `credentials/kimi-code.json` (legacy / mainland) or
 *  `credentials/kimi-code-env-<16 hex>.json` (scoped, e.g. global). */
const KIMI_SLOT = /^kimi-code(?:-env-[0-9a-f]{16})?\.json$/;

/** Kimi Code. `$KIMI_CODE_HOME/credentials/<slot>.json` (default `~/.kimi-code`). */
const probeKimi = async (ctx: THostSignInContext): TProbeResult => {
  const kimiHome =
    envDir(ctx, "KIMI_CODE_HOME") ?? join(ctx.home, ".kimi-code");
  const dir = join(kimiHome, "credentials");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    return isMissing(err) ? false : undefined;
  }
  let unknown = false;
  for (const name of names) {
    if (!KIMI_SLOT.test(name)) continue;
    const signedIn = await verdict(readJson(join(dir, name)), (token) =>
      hasAnyString(token, ["refresh_token", "access_token"]),
    );
    if (signedIn === true) return true;
    if (signedIn === undefined) unknown = true;
  }
  return unknown ? undefined : false;
};

/** Grok Build. `~/.grok/auth.json`: a map of sessions, each carrying `key`
 *  (the access token) and `refresh_token`. */
const probeGrok = (ctx: THostSignInContext): TProbeResult =>
  verdict(readJson(join(ctx.home, ".grok", "auth.json")), (store) =>
    isRecord(store)
      ? Object.values(store).some((session) =>
          hasAnyString(session, ["key", "refresh_token"]),
        )
      : false,
  );

/** Cursor. Linux keeps the token in `$XDG_CONFIG_HOME/cursor/auth.json`
 *  (default `~/.config`); macOS keeps it in the keychain → unknown. */
const probeCursor = async (ctx: THostSignInContext): TProbeResult => {
  if (ctx.platform === "darwin") return undefined;
  const xdg = envDir(ctx, "XDG_CONFIG_HOME") ?? join(ctx.home, ".config");
  return verdict(readJson(join(xdg, "cursor", "auth.json")), (store) =>
    hasAnyString(store, [
      "accessToken",
      "access_token",
      "refreshToken",
      "refresh_token",
    ]),
  );
};

/**
 * Per-provider probe. Providers absent from this table (Muse, Antigravity —
 * keychain-backed or unverified host stores) always report unknown.
 */
const PROBES: Readonly<
  Record<string, (ctx: THostSignInContext) => TProbeResult>
> = {
  claude_code: probeClaude,
  chatgpt: probeCodex,
  kimi_code: probeKimi,
  grok: probeGrok,
  cursor: probeCursor,
};

/**
 * Uncached probe of one provider. `true` = signed in to the vendor CLI in the
 * user's own home; `false` = definitely not; `undefined` = unknown.
 */
export const probeHostSignIn = async (
  provider: string,
  context: THostSignInContext = defaultContext(),
): TProbeResult => {
  const probe = PROBES[provider];
  if (probe === undefined) return undefined;
  try {
    return await probe(context);
  } catch {
    // Status must never throw on a hint.
    return undefined;
  }
};

export type THostSignInProbe = {
  /** Cached answer for `provider` (see {@link probeHostSignIn}). */
  readonly read: (provider: string) => TProbeResult;
};

export type THostSignInProbeOptions = {
  readonly context?: () => THostSignInContext;
  readonly nowMs?: () => number;
};

/** A probe that re-reads each provider's files at most once per
 *  {@link HOST_SIGN_IN_TTL_MS}. */
export const createHostSignInProbe = (
  options?: THostSignInProbeOptions,
): THostSignInProbe => {
  const context = options?.context ?? defaultContext;
  const nowMs = options?.nowMs ?? Date.now;
  // The PROMISE is cached, not the value: the providers' rows are computed
  // in parallel and a status burst can ask twice before a read settles, so
  // concurrent askers share one read rather than each starting their own.
  const cache = new Map<
    string,
    { readonly at: number; readonly value: TProbeResult }
  >();
  return {
    read: (provider: string): TProbeResult => {
      const now = nowMs();
      const hit = cache.get(provider);
      if (hit !== undefined && now - hit.at < HOST_SIGN_IN_TTL_MS)
        return hit.value;
      const value = probeHostSignIn(provider, context());
      cache.set(provider, { at: now, value });
      return value;
    },
  };
};

/** One cache per daemon state dir (see {@link stateScoped}). */
const defaultProbe = stateScoped(() => createHostSignInProbe());

type THostSignInCarrier = {
  readonly provider: string;
  readonly host_signed_in?: boolean;
};

/**
 * Attach `host_signed_in` to a status connection. An unknown answer removes
 * the field rather than publishing a guess.
 */
export const attachHostSignIn = async <T extends THostSignInCarrier>(
  conn: T,
  probe: THostSignInProbe = defaultProbe(),
): Promise<T> => {
  const value = await probe.read(conn.provider);
  if (value === undefined) {
    if (conn.host_signed_in === undefined) return conn;
    const { host_signed_in: _drop, ...rest } = conn;
    return rest as T;
  }
  return { ...conn, host_signed_in: value };
};
