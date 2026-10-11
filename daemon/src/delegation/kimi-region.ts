/**
 * Kimi Code region — which vendor deployment the daemon logs into and calls.
 *
 * Verbatim from the official CLI (`packages/oauth` region.ts +
 * managed-kimi-code.ts): a region is a bundle of endpoints, and the credential
 * SLOT is derived from (oauthHost, baseUrl) — the mainland default keeps the
 * legacy `oauth/kimi-code` slot, every other environment gets a scoped
 * `oauth/kimi-code-env-<sha256[0..16]>` slot. Matching the CLI's derivation
 * keeps the daemon's credential file + `config.toml` readable by `kimi -p`.
 *
 * Resolution (first match wins):
 *   1. env override (`KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`)
 *   2. `<kimi home>/region` marker (`global` | `mainland-cn`) — written on
 *      every daemon login, and the documented manual switch
 *   3. a pre-existing legacy mainland credential with no global one — an
 *      account connected before global became the default stays connected
 *   4. default `global` (kimi.ai — the CLI itself defaults to mainland-cn)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliConfigDir } from "../cli-paths";

export type TKimiRegion = "mainland-cn" | "global";

type TKimiRegionProfile = {
  readonly oauthHost: string;
  readonly apiOrigin: string;
};

const PROFILES: Readonly<Record<TKimiRegion, TKimiRegionProfile>> = {
  "mainland-cn": {
    oauthHost: "https://auth.kimi.com",
    apiOrigin: "https://api.kimi.com",
  },
  global: {
    oauthHost: "https://auth.kimi.ai",
    apiOrigin: "https://api.kimi.ai",
  },
};

const LEGACY_OAUTH_KEY = "oauth/kimi-code"; // KIMI_CODE_OAUTH_KEY
const SCOPED_OAUTH_KEY_PREFIX = "oauth/kimi-code-env-";
const MARKER_FILENAME = "region";
const BASE_PATH = "/coding/v1";

const kimiHome = (): string => cliConfigDir("kimi_code");
const trimSlash = (value: string): string => value.trim().replace(/\/+$/, "");

const envOAuthHost = (): string | undefined => {
  const host = process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST;
  return host !== undefined && host.length > 0 ? trimSlash(host) : undefined;
};

const regionForHost = (host: string): TKimiRegion | undefined =>
  (Object.keys(PROFILES) as TKimiRegion[]).find(
    (region) => PROFILES[region].oauthHost === host,
  );

const readMarker = (): TKimiRegion | undefined => {
  try {
    const value = readFileSync(
      join(kimiHome(), MARKER_FILENAME),
      "utf-8",
    ).trim();
    return value === "global" || value === "mainland-cn" ? value : undefined;
  } catch {
    return undefined;
  }
};

/** `resolveKimiCodeOAuthKey` — the credential slot for an environment. */
const oauthKeyFor = (oauthHost: string, baseUrl: string): string =>
  oauthHost === PROFILES["mainland-cn"].oauthHost &&
  baseUrl === `${PROFILES["mainland-cn"].apiOrigin}${BASE_PATH}`
    ? LEGACY_OAUTH_KEY
    : `${SCOPED_OAUTH_KEY_PREFIX}${createHash("sha256")
        .update(JSON.stringify({ oauthHost, baseUrl }))
        .digest("hex")
        .slice(0, 16)}`;

/** `resolveKimiTokenStorageName` — `credentials/<name>.json`. */
const storageNameFor = (oauthKey: string): string =>
  oauthKey === LEGACY_OAUTH_KEY ? "kimi-code" : oauthKey.slice("oauth/".length);

const credentialFileFor = (region: TKimiRegion): string => {
  const p = PROFILES[region];
  const key = oauthKeyFor(p.oauthHost, `${p.apiOrigin}${BASE_PATH}`);
  return join(kimiHome(), "credentials", `${storageNameFor(key)}.json`);
};

export const resolveKimiRegion = (): TKimiRegion => {
  const host = envOAuthHost();
  if (host !== undefined) return regionForHost(host) ?? "mainland-cn";
  const marker = readMarker();
  if (marker !== undefined) return marker;
  if (
    existsSync(credentialFileFor("mainland-cn")) &&
    !existsSync(credentialFileFor("global"))
  ) {
    return "mainland-cn";
  }
  return "global";
};

export type TKimiEndpoints = {
  readonly region: TKimiRegion;
  /** Device-code OAuth host (env override honored verbatim). */
  readonly oauthHost: string;
  /** Inference/usage origin, e.g. `https://api.kimi.ai`. */
  readonly apiOrigin: string;
  /** `[providers.*.oauth] key` in config.toml. */
  readonly oauthKey: string;
  /** Absolute credential file path the CLI reads for this slot. */
  readonly credentialPath: string;
};

export const kimiEndpoints = (): TKimiEndpoints => {
  const region = resolveKimiRegion();
  const profile = PROFILES[region];
  const oauthHost = envOAuthHost() ?? profile.oauthHost;
  const oauthKey = oauthKeyFor(oauthHost, `${profile.apiOrigin}${BASE_PATH}`);
  return {
    region,
    oauthHost,
    apiOrigin: profile.apiOrigin,
    oauthKey,
    credentialPath: join(
      kimiHome(),
      "credentials",
      `${storageNameFor(oauthKey)}.json`,
    ),
  };
};

/** Pin the region the daemon just logged into, so the CLI (marker step of its
 *  own resolver) and every later daemon read agree on it. */
export const writeKimiRegionMarker = (region: TKimiRegion): void => {
  mkdirSync(kimiHome(), { recursive: true, mode: 0o700 });
  writeFileSync(join(kimiHome(), MARKER_FILENAME), `${region}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
};

/** True for a known Kimi API origin belonging to a region other than the
 *  active one — a stored capture there predates a region switch. */
export const isOtherKimiRegionOrigin = (origin: string): boolean => {
  const active = resolveKimiRegion();
  return (Object.keys(PROFILES) as TKimiRegion[]).some(
    (region) => region !== active && PROFILES[region].apiOrigin === origin,
  );
};
