/**
 * Antigravity through the official `agy` CLI: whether it is signed in, its
 * quota and its models — all from documented `agy` surfaces, never by reading
 * its token or calling Google's endpoints ourselves.
 *
 *   signed in  — metadata only: the isolated keychain lists a `gemini` item
 *                (macOS; readiness-gated so nothing can prompt) or `agy`'s own
 *                token file exists (its file store). Never spawns `agy`.
 *   usage      — `agy -p "/usage" --output-format json`: print mode answers
 *                read-only slash commands without a model call (agy changelog).
 *   models     — `agy models`: one `id<TAB>name` row per model.
 *
 * Every spawn runs under the isolated HOME with the keychain gate `present`
 * and the daemon sandbox wrap, like inference (`antigravity-headless.ts`).
 */

import { rmSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  TProviderUsageSnapshot,
  TProviderUsageWindow,
} from "@openllmsh/sdk/protocol";
import { antigravitySpawnEnv } from "../native-runtime/antigravity-env";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapAntigravityCliSpawn } from "../sandbox/policy";
import { daemonTempDir } from "../sandbox/working-set";
import {
  ANTIGRAVITY_PLANS_URL,
  antigravityQuotaSnapshot,
  summaryWindows,
} from "./antigravity-usage";
import type { TStoreRead } from "./util";
import {
  ensureKeychainReady,
  findKeychainServices,
  observeKeychainReady,
} from "./util";

/** The keychain service `agy` saves its sign-in under. */
export const AGY_KEYCHAIN_SERVICE = "gemini";

/** `agy`'s file-store token (used when the keychain is unavailable). */
export const agyTokenFilePath = (home: string): string =>
  join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");

export type TAgyKeychain = {
  readonly observe: (home: string) => Promise<TStoreRead<void>>;
  readonly ensure: (home: string) => Promise<TStoreRead<void>>;
  readonly services: (
    home: string,
    prefix: string,
  ) => Promise<TStoreRead<ReadonlyArray<string>>>;
};

const defaultKeychain: TAgyKeychain = {
  observe: (home) => observeKeychainReady(home),
  ensure: (home) => ensureKeychainReady(home),
  services: (home, prefix) => findKeychainServices(home, prefix),
};

/**
 * Is `agy` signed in under `home`? Metadata only and never spawns. The
 * keychain is only listed when the passive readiness check reports it
 * unlocked, so a locked keychain can never raise a dialog.
 */
export const agyCliSignedIn = async (
  home: string,
  keychain: TAgyKeychain = defaultKeychain,
): Promise<boolean> => {
  try {
    const file = statSync(agyTokenFilePath(home));
    if (file.isFile() && file.size > 0) return true;
  } catch {
    // no file store
  }
  if ((await keychain.observe(home)).kind !== "present") return false;
  const services = await keychain.services(home, AGY_KEYCHAIN_SERVICE);
  return (
    services.kind === "present" && services.value.includes(AGY_KEYCHAIN_SERVICE)
  );
};

// ─── One-shot agy commands ─────────────────────────────────────────────────

export type TAgyRun = (args: {
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly timeoutMs: number;
}) => Promise<{ readonly code: number | null; readonly stdout: string }>;

const defaultRun: TAgyRun = async (args) => {
  const proc = Bun.spawn([...args.argv], {
    cwd: args.cwd,
    env: args.env,
    stdin: "ignore",
    stdout: "pipe",
    // Native stderr is not a safe diagnostic channel (may carry secrets).
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), args.timeoutMs);
  try {
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    return { code: await proc.exited, stdout };
  } finally {
    clearTimeout(timer);
  }
};

export type TAgyCliDeps = {
  readonly bin: string;
  /** Isolated run env (`cliEnv("antigravity")`). */
  readonly env: Record<string, string>;
  readonly keychain?: TAgyKeychain;
  readonly run?: TAgyRun;
  readonly wrapArgv?: (argv: string[]) => string[];
  readonly timeoutMs?: number;
};

const AGY_COMMAND_TIMEOUT_MS = 30_000;

type TRunOutcome =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "unavailable"; readonly reason: string };

const runAgy = async (
  deps: TAgyCliDeps,
  args: ReadonlyArray<string>,
): Promise<TRunOutcome> => {
  const home = deps.env.HOME;
  if (home === undefined || home.length === 0 || home === homedir()) {
    return { kind: "unavailable", reason: "no isolated HOME" };
  }
  const ready = await (deps.keychain ?? defaultKeychain).ensure(home);
  if (ready.kind !== "present") {
    return { kind: "unavailable", reason: "isolated keychain not ready" };
  }
  const wrap =
    deps.wrapArgv ??
    ((argv: string[]): string[] =>
      sandboxSpawnArgs(argv, { probe: unwrapAntigravityCliSpawn() }));
  let cwd: string;
  try {
    cwd = await mkdtemp(join(daemonTempDir(), "agy-cmd-"));
  } catch {
    // Every failure here is "unavailable", never a rejection.
    return { kind: "unavailable", reason: "scratch dir unavailable" };
  }
  try {
    const result = await (deps.run ?? defaultRun)({
      argv: wrap([deps.bin, ...args]),
      env: antigravitySpawnEnv(deps.env),
      cwd,
      timeoutMs: deps.timeoutMs ?? AGY_COMMAND_TIMEOUT_MS,
    });
    return result.code === 0
      ? { kind: "ok", stdout: result.stdout }
      : { kind: "unavailable", reason: `agy exited ${result.code ?? "?"}` };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

// ─── Usage ─────────────────────────────────────────────────────────────────

/**
 * `agy -p "/usage" --output-format json` → windows. Its buckets carry the same
 * fields as Google's quota summary, so the shared mapping keeps the window
 * labels and meter ids identical to the token-based reader's.
 */
export const agyUsageWindows = (
  stdout: string,
): ReadonlyArray<TProviderUsageWindow> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const result = parsed as {
    readonly status?: unknown;
    readonly command?: {
      readonly name?: unknown;
      readonly data?: {
        readonly groups?: ReadonlyArray<{
          readonly name?: unknown;
          readonly buckets?: ReadonlyArray<{
            readonly id?: unknown;
            readonly name?: unknown;
            readonly window?: unknown;
            readonly remaining_fraction?: unknown;
            readonly reset_time?: unknown;
          }>;
        }>;
      };
    };
  } | null;
  if (result?.status !== "SUCCESS" || result.command?.name !== "usage") {
    return null;
  }
  // Shape checked at runtime: anything unexpected is "unavailable", never
  // a throw out of the usage read.
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  const groups = result.command.data?.groups ?? [];
  if (!Array.isArray(groups)) return null;
  const mapped = [];
  for (const group of groups as ReadonlyArray<unknown>) {
    if (!isObject(group)) return null;
    const buckets = group.buckets ?? [];
    if (!Array.isArray(buckets)) return null;
    const out = [];
    for (const bucket of buckets as ReadonlyArray<unknown>) {
      if (!isObject(bucket)) return null;
      out.push({
        bucketId: bucket.id,
        displayName: bucket.name,
        window: bucket.window,
        remainingFraction: bucket.remaining_fraction,
        resetTime: bucket.reset_time,
        disabled: bucket.disabled,
      });
    }
    mapped.push({ displayName: group.name, buckets: out });
  }
  return summaryWindows({ groups: mapped });
};

export const readAgyUsage = async (
  deps: TAgyCliDeps,
): Promise<TProviderUsageSnapshot> => {
  const out = await runAgy(deps, ["-p", "/usage", "--output-format", "json"]);
  const windows = out.kind === "ok" ? agyUsageWindows(out.stdout) : null;
  if (windows === null) {
    return {
      kind: "unavailable",
      reason: "Antigravity limits unavailable.",
      link: ANTIGRAVITY_PLANS_URL,
    };
  }
  return antigravityQuotaSnapshot(windows);
};

// ─── Models ────────────────────────────────────────────────────────────────

export type TAgyModelRow = {
  readonly value: string;
  readonly name: string | null;
};

/** `agy models` → rows (`id<TAB>display name`); the progress line and any
 *  other noise are ignored. */
export const agyModelRows = (stdout: string): ReadonlyArray<TAgyModelRow> =>
  stdout.split("\n").flatMap((line) => {
    const [id, name] = line.split("\t");
    const value = id?.trim() ?? "";
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || name === undefined) {
      return [];
    }
    const display = name.trim();
    return [{ value, name: display.length > 0 ? display : null }];
  });

export const readAgyModels = async (
  deps: TAgyCliDeps,
): Promise<ReadonlyArray<TAgyModelRow> | null> => {
  const out = await runAgy(deps, ["models"]);
  if (out.kind !== "ok") return null;
  const rows = agyModelRows(out.stdout);
  return rows.length > 0 ? rows : null;
};

// ─── Sign-out ──────────────────────────────────────────────────────────────

/** The account name `agy` saves its keychain item under. */
export const AGY_KEYCHAIN_ACCOUNT = "antigravity";

export type TSecurityRun = (args: {
  readonly argv: ReadonlyArray<string>;
  readonly home: string;
}) => Promise<number | null>;

const defaultSecurityRun: TSecurityRun = async ({ argv, home }) => {
  const proc = Bun.spawn([...argv], {
    env: { ...process.env, HOME: home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
};

/**
 * Remove `agy`'s sign-in from the daemon's OWN isolated stores: its token
 * file, and (macOS) the `gemini`/`antigravity` item in the isolated keychain
 * named by explicit path — never the user's login keychain. Gated on the
 * keychain being ready so nothing can prompt. `agy`'s interactive `/logout`
 * is not used: its screen first runs a first-run wizard whose Terms /
 * data-use consent page the daemon must not answer. Like ACP's logout this
 * clears the local sign-in; it does not revoke the grant at Google.
 *
 * Off macOS the token file is the whole store: `cliEnv` hands `agy` no
 * `DBUS_SESSION_BUS_ADDRESS`, so it cannot reach a desktop keyring.
 */
export const removeAgySignIn = async (
  home: string,
  deps: {
    readonly keychain?: TAgyKeychain;
    readonly security?: TSecurityRun;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<boolean> => {
  const keychain = deps.keychain ?? defaultKeychain;
  rmSync(agyTokenFilePath(home), { force: true });
  if ((deps.platform ?? process.platform) === "darwin") {
    if ((await keychain.ensure(home)).kind !== "present") return false;
    const code = await (deps.security ?? defaultSecurityRun)({
      argv: [
        "/usr/bin/security",
        "delete-generic-password",
        "-s",
        AGY_KEYCHAIN_SERVICE,
        "-a",
        AGY_KEYCHAIN_ACCOUNT,
        join(home, "Library", "Keychains", "login.keychain-db"),
      ],
      home,
    });
    // 0 = deleted, 44 = no such item: both leave it signed out.
    if (code !== 0 && code !== 44) return false;
  }
  return !(await agyCliSignedIn(home, keychain));
};
