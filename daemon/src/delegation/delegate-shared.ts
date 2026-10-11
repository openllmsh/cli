/**
 * Shared per-delegate wiring that used to be copy-pasted into each
 * subscription provider. Data in, closures out — no inheritance.
 *
 * Lives in its own module (not `util.ts`) so `login-flow` / `refresh` /
 * `auth-config` can keep importing `./util` without a cycle.
 */
import { cliInstallState } from "../cli-install";
import type { TCliProvider } from "../cli-paths";
import { cliBin, cliEnv } from "../cli-paths";
import { ensureAuthConfig } from "./auth-config";
import type { TLoginSlot } from "./login-flow";
import { loginSlot } from "./login-flow";
import type { TRefreshSpawnMeta } from "./refresh";
import {
  makeRefresher,
  REFRESH_COOLDOWN_MS,
  withRefreshCaller,
} from "./refresh";

export const cliLaunch = (
  provider: TCliProvider,
  extraEnv?: Record<string, string>,
): {
  readonly bin: () => string;
  readonly env: () => Record<string, string>;
} => ({
  bin: (): string => cliBin(provider),
  env: (): Record<string, string> =>
    extraEnv === undefined
      ? cliEnv(provider)
      : { ...cliEnv(provider), ...extraEnv },
});

export const nativeRefresher = (opts: {
  readonly slug: string;
  readonly label: string;
  readonly leewayMs: number;
  // biome-ignore lint/suspicious/noConfusingVoidType: matches makeRefresher
  readonly trigger: () => Promise<void | TRefreshSpawnMeta>;
}): ReturnType<typeof makeRefresher> =>
  makeRefresher({
    slug: opts.slug,
    label: opts.label,
    leewayMs: opts.leewayMs,
    cooldownMs: REFRESH_COOLDOWN_MS,
    trigger: opts.trigger,
  });

export type TLoginWiring<
  TConnected extends string | undefined = undefined,
  TProgress extends string | undefined = undefined,
> = {
  readonly installHint: string;
  readonly connectedDetail: TConnected;
  readonly inProgressDetail: TProgress;
  readonly isInstalled: () => Promise<boolean>;
  readonly isConnected: () => Promise<boolean>;
  readonly refreshConfig: () => void;
  readonly slot: TLoginSlot;
};

/**
 * Login constants + the four closures every delegate wires the same way.
 * `connectedDetail` / `inProgressDetail` stay optional so a provider that
 * never had one does not get a string invented for it. `isConnected` may
 * be overridden (claude prefers `claude auth status` over the store).
 */
export const loginWiring = <
  TConnected extends string | undefined = undefined,
  TProgress extends string | undefined = undefined,
>(opts: {
  readonly provider: TCliProvider;
  readonly installHint: string;
  readonly connectedDetail?: TConnected;
  readonly inProgressDetail?: TProgress;
  readonly readToken: () => Promise<unknown>;
  readonly isConnected?: () => Promise<boolean>;
}): TLoginWiring<TConnected, TProgress> => ({
  installHint: opts.installHint,
  connectedDetail: opts.connectedDetail as TConnected,
  inProgressDetail: opts.inProgressDetail as TProgress,
  // Demand: gates the CONNECT flow (a direct user action), so a manager-
  // shimmed CLI that has never been resolved yet gets resolved now instead
  // of failing closed forever — an absent cache must not be permanently
  // unusable.
  isInstalled: async (): Promise<boolean> =>
    (await cliInstallState(opts.provider, { demand: true })).installed,
  isConnected: async (): Promise<boolean> =>
    withRefreshCaller("login", async (): Promise<boolean> => {
      if (opts.isConnected !== undefined) return opts.isConnected();
      return (await opts.readToken()) !== null;
    }),
  refreshConfig: (): void => {
    void ensureAuthConfig(opts.provider, { force: true }).catch(() => {});
  },
  slot: loginSlot(opts.provider),
});
