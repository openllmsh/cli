/**
 * Per-provider AUTH CONFIG — a `config.json` sidecar next to the isolated CLI
 * (`<cliRoot>/config.json`) that caches:
 *
 *   - `upstream_url` — the genuine inference endpoint the vendor CLI POSTs to,
 *     CAPTURED from a real headless `exec` request (it drifts on CLI updates —
 *     e.g. codex's `/backend-api/codex/responses` host moved — and can't be
 *     hardcoded). The capture KILLS the CLI before anything reaches the vendor
 *     (zero token cost, works offline).
 *   - `cli_version` — CLI meta, the capture freshness key.
 *
 * Token REFRESH is NOT done here — each delegate triggers its CLI's OWN native
 * refresh (see `delegation/refresh.ts`), so no OAuth `client_id`/`token_url` is
 * extracted or stored.
 *
 * Bright line (terms-compliance), amended for `claude_code` by
 * `docs/proposals/active-sub-method.md` §claude_code handrolled parity: for
 * every provider EXCEPT `claude_code`, nothing here is replayed as inference
 * identity — the daemon serves each request with the ORIGINATOR's own headers
 * (`@openllmsh/wire/lib/forwarded-headers`) + the injected bearer, and this
 * config supplies only the request TARGET URL. For `claude_code` the config
 * ALSO persists the isolated CLI's own IDENTITY HEADERS (`identity_headers`,
 * captured from the CLI's real request shape — killed before it reaches the
 * vendor, zero token cost) so the HANDROLLED transport presents the same
 * identity the BRIDGE (the genuine CLI) presents — a sub-method toggle must
 * never change which requests the vendor accepts. The daemon still genuinely
 * holds that CLI + its subscription credential, so this replays the daemon's
 * OWN identity, never a forged third-party one. The volatile/secret
 * `authorization` header is never captured or stored.
 *
 * Plain JSON (read via `readJsonFile`, written via `Bun.write` + `JSON.stringify`)
 * — always fresh on re-read after a re-capture, no runtime transpiler, works
 * identically in the compiled `--bytecode` binary.
 *
 * Supersedes the former `exec-fixture.ts` (URL+identity capture) — see
 * `docs/proposals/delegation-exec-fixtures.md` (amended) and
 * `docs/proposals/subscription-oauth-terms-compliance.md`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TCliProvider } from "../cli-paths";
import { cliBin, cliEnv, cliRoot } from "../cli-paths";
import { logDebug, logInfo } from "../logger";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import { isOtherKimiRegionOrigin, kimiEndpoints } from "./kimi-region";
import { cliVersion, ptyScriptArgv, readJsonFile } from "./util";

/** The persisted shape (all fields optional). */
export type TAuthConfig = {
  /** ORIGIN + the captured request path (e.g. `https://api.anthropic.com/v1/messages`). */
  readonly upstream_url?: string;
  /** The isolated binary's `--version` at capture time; a mismatch re-captures. */
  readonly cli_version?: string;
  /** Epoch ms of the last URL capture; older than the TTL re-captures. */
  readonly captured_at_ms?: number;
  /** The isolated CLI's own identity headers (filtered — never authorization /
   *  cookies / entity headers), captured from its real request shape by the
   *  SAME recorder run that captures the URL (one capture, one freshness key:
   *  `cli_version` + `captured_at_ms`). Replayed ONLY on the `claude_code`
   *  handrolled transport for bridge parity (see the bright-line note above).
   *  Absent for every other provider. */
  readonly identity_headers?: Readonly<Record<string, string>>;
};

/** Re-capture / re-extract once older than this, even when neither the CLI
 *  version nor the login changed (catches server-side identity rotations). */
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Hard cap on a capture run — the CLI should emit its first request in <1s; a
 *  CLI that errors before sending just times out and the caller falls back. */
const CAPTURE_TIMEOUT_MS = 20_000;

// ─── Persisted config.json sidecar (read/write/patch) ────────────────────────

const configPath = (provider: TCliProvider): string =>
  join(cliRoot(provider), "config.json");

const readConfig = (provider: TCliProvider): Promise<TAuthConfig | null> =>
  readJsonFile<TAuthConfig>(configPath(provider));

const writeConfig = async (
  provider: TCliProvider,
  config: TAuthConfig,
): Promise<void> => {
  await Bun.write(configPath(provider), JSON.stringify(config));
};

// Serialize read-modify-write per provider — the URL capture and the OAuth
// extraction both patch the ONE file; a per-provider queue stops them clobbering
// each other's sub-part.
const writeLocks = new Map<TCliProvider, Promise<void>>();
const patchConfig = async (
  provider: TCliProvider,
  patch: TAuthConfig,
): Promise<void> => {
  const prev = writeLocks.get(provider) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const cur = (await readConfig(provider)) ?? {};
      await writeConfig(provider, { ...cur, ...patch });
    });
  writeLocks.set(provider, next);
  await next;
};

// ─── URL capture (the genuine inference endpoint) ────────────────────────────

/**
 * Per-provider capture recipe. `origin` is the retained constant (the redirect
 * replaces it, so it can't be captured); `path` is only the PRE-capture fallback
 * (the live capture overrides it with the real path). `match` picks the
 * INFERENCE request out of the CLI's request stream — CLIs emit preamble calls
 * first, which the recorder forwards to the vendor so the CLI proceeds; only the
 * matching inference request is captured. `argv` + `env` point the headless CLI
 * at the loopback recorder — see `docs/proposals/delegation-exec-fixtures.md` §2.
 */
type TCaptureSpec = {
  readonly origin: string;
  readonly path: string;
  readonly match: (path: string) => boolean;
  readonly argv: (bin: string, base: string) => ReadonlyArray<string>;
  readonly env: (base: string) => Record<string, string>;
  /** Run the headless CLI under a pseudo-terminal (`script(1)`) — set for a CLI
   *  whose print/exec mode is gated on a real TTY (kimi's `-p`). */
  readonly usePty?: boolean;
  /** Capture + persist the CLI's IDENTITY HEADERS from the matched inference
   *  request (claude_code only — handrolled/bridge parity, see the bright-line
   *  note at the top). Orthogonal to `liveCapture` (which gates the URL
   *  capture): an identity capture spawns the same shape-only recorder run —
   *  the request is killed before it reaches the vendor — and is triggered by
   *  `resolveIdentityHeaders`, not by URL resolution. */
  readonly captureIdentity?: boolean;
  /** When `false`, NEVER spawn a live `-p ping` capture for this provider —
   *  serve the default endpoint verbatim instead. Set for a provider whose
   *  capture does more harm than good: the `-p ping` is a REAL inference, which
   *  makes the isolated CLI refresh + ROTATE its single-use OAuth refresh token
   *  behind the daemon's back. That rotation races the daemon's own self-refresh
   *  and stranded claude_code's credential (the CLI cleared the refresh token to
   *  `""` on a lost-race refresh → un-refreshable → re-login every ~8h). claude's
   *  `/v1/messages` has never drifted (every capture returned the default), so
   *  the capture was pure risk with no benefit. */
  readonly liveCapture?: boolean;
};

const CAPTURE: Readonly<Record<TCliProvider, TCaptureSpec>> = {
  claude_code: {
    origin: "https://api.anthropic.com",
    path: "/v1/messages",
    match: (p) => p.endsWith("/v1/messages"),
    // `-p/--print` = headless single-shot; ANTHROPIC_BASE_URL redirects it.
    // RETAINED for shape only — `liveCapture: false` means this is NEVER run:
    // a real `claude -p ping` would rotate the OAuth refresh token mid-capture
    // (see `liveCapture`). The default `/v1/messages` (stable) is served instead.
    argv: (bin) => [bin, "-p", "ping"],
    env: (base) => ({ ANTHROPIC_BASE_URL: base }),
    liveCapture: false,
    // Handrolled/bridge parity (active-sub-method.md): capture the CLI's own
    // identity headers so the manual transport presents what the genuine CLI
    // presents. The capture's `-p ping` never reaches the vendor (recorder
    // kills it at the matched request — zero token cost), and a mid-capture
    // token refresh is the CLI's OWN native refresh — the same mechanism
    // `delegation/refresh.ts` already spawns deliberately, so the old
    // rotation RACE (two competing refreshers) does not return: the CLI
    // remains the single refresher on every path.
    captureIdentity: true,
  },
  chatgpt: {
    // NOTE: codex's `/responses` endpoint genuinely DRIFTS on CLI updates
    // (unlike claude's stable `/v1/messages`), so we can't set
    // `liveCapture: false` here — the capture must keep running to track the
    // real endpoint. Codex's analogous refresh-token rotation race is instead
    // narrowed by the empty-token guard + atomic `auth.json` write in chatgpt.ts.
    origin: "https://chatgpt.com",
    path: "/backend-api/codex/responses",
    // Codex fires backend-api preamble (`/ps/plugins/installed`, `/wham/apps`,
    // analytics) before inference — match only the `/responses` call.
    match: (p) => p.endsWith("/responses"),
    // TWO redirects are required. `chatgpt_base_url` only covers the preamble;
    // the INFERENCE `/responses` call uses the model provider's base_url, which
    // under ChatGPT auth resolves to the hardcoded CHATGPT_CODEX_BASE_URL unless
    // `openai_base_url` overrides the built-in openai provider — the ONLY config
    // hook. WITHOUT it the inference hits the REAL endpoint and spends tokens;
    // WITH it the recorder intercepts `/responses` (codex opens it as a
    // WebSocket upgrade — the handshake's identity headers aren't replayed; only
    // the URL is captured). `--ephemeral` + bypass flags keep it non-interactive.
    argv: (bin, base) => [
      bin,
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "-c",
      `chatgpt_base_url=${base}/backend-api`,
      "-c",
      `openai_base_url=${base}/backend-api/codex`,
      "ping",
    ],
    env: () => ({}),
  },
  kimi_code: {
    // Region-dependent (global `api.kimi.ai` by default) — see `kimi-region.ts`.
    get origin(): string {
      return kimiEndpoints().apiOrigin;
    },
    // The managed "Kimi For Coding" subscription speaks the OpenAI wire
    // (`/coding/v1/chat/completions`) — the genuine endpoint the official
    // `kimi-code-cli` POSTs to. Captured live by driving `kimi -p ping` headless
    // against the recorder; `defaultUpstreamUrl` is the fallback.
    path: "/coding/v1/chat/completions",
    match: (p) => p.endsWith("/coding/v1/chat/completions"),
    // `-p/--prompt` = headless single-shot. The isolated home has only the
    // credential — no provisioned model — so the `KIMI_MODEL_*` trio synthesizes
    // an EPHEMERAL in-memory model (provider type `kimi`) pointed at the
    // recorder. The OpenAI SDK appends `/chat/completions` to the base, so the
    // base must NOT include it.
    argv: (bin) => [bin, "-p", "ping"],
    // CAPTURE FIXTURE — deliberately NOT catalog-owned, and not an exception
    // to "model-specific facts live in the catalog": none of this trio is a
    // model FACT. They exist only to make one `kimi -p ping` land in the local
    // recorder. `KIMI_MODEL_API_KEY` is a placeholder, `KIMI_MODEL_BASE_URL`
    // is the recorder, and `KIMI_MODEL_NAME` is not load-bearing either — the
    // recorder matches on PATH (`match` above), never on the model name. The
    // name merely coincides with the real catalog id `kimi_code/kimi-for-coding`.
    // Deriving it from the catalog would put a catalog read on the login path
    // (before bootstrap is even needed) for zero behavioural gain, and would
    // make a catalog rename BREAK capture rather than be caught by it. A drift
    // guard here would assert a coincidence, not a contract.
    env: (base) => ({
      KIMI_MODEL_NAME: "kimi-for-coding",
      KIMI_MODEL_API_KEY: "sk-openllm-capture",
      KIMI_MODEL_BASE_URL: `${base}/coding/v1`,
    }),
    // `kimi -p` is gated on a real TTY (raw-mode detection) — run under a PTY.
    usePty: true,
  },
  grok: {
    // Grok Build's chat goes through the CLI chat proxy. Both Grok Build models
    // report `api_backend: "responses"` (via `/v1/models`), so the daemon POSTs
    // the OpenAI Responses wire to `cli-chat-proxy.grok.com/v1/responses`
    // (verified live — `/v1/responses` 405s on GET, i.e. it exists).
    origin: "https://cli-chat-proxy.grok.com",
    path: "/v1/responses",
    match: (p) => p.endsWith("/responses"),
    // Shape-only — NEVER run. Like claude_code, `liveCapture: false`: a live
    // capture would be a REAL `grok agent` turn that spends SuperGrok quota (and
    // grok's agent runs over a WS relay, not this HTTP recorder). The chat-proxy
    // endpoint is the stable CLI default, so we serve it verbatim; the override
    // env (GROK_CLI_CHAT_PROXY_BASE_URL) is retained for shape only.
    argv: (bin) => [bin, "agent", "headless", "ping"],
    env: (base) => ({ GROK_CLI_CHAT_PROXY_BASE_URL: base }),
    liveCapture: false,
  },
  // ⚠️ RESEARCH-UNVERIFIED: this is Cursor's dashboard host, not an inference
  // endpoint. Cursor inference is ACP-only; keep the target here only because
  // every isolated provider has an auth-config entry.
  cursor: {
    origin: "https://api2.cursor.sh",
    path: "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    match: () => false,
    argv: (bin) => [bin, "status"],
    env: () => ({}),
    liveCapture: false,
  },
  // Muse is bridge-only (official SDK/MSP). Shape-only auth-config entry so
  // `Record<TCliProvider, …>` stays exhaustive — never used for Meta Model API
  // HTTP with subscription credentials.
  muse: {
    origin: "https://dev.meta.ai",
    path: "/",
    match: () => false,
    argv: (bin) => [bin, "--version"],
    env: () => ({}),
    liveCapture: false,
  },
};

/** The default (pre-capture) upstream URL: ORIGIN + default PATH. The delegate
 *  passes this as the `resolveUpstreamUrl` fallback so no URL literal lives in
 *  the delegate handler itself. */
export const defaultUpstreamUrl = (provider: TCliProvider): string =>
  CAPTURE[provider].origin + CAPTURE[provider].path;

/** A stored URL is only servable if it IS the provider's inference endpoint
 *  (passes `spec.match`). Guards against a legacy/stale URL captured before the
 *  preamble-skip — e.g. codex's `/backend-api/ps/plugins/installed`, a GET-only
 *  endpoint that 405s the inference POST. A non-matching URL is treated as
 *  absent so it's never served and gets re-captured. */
const urlIsInference = (provider: TCliProvider, url: string): boolean => {
  try {
    const parsed = new URL(url);
    // A capture from the OTHER Kimi region (before a mainland → global switch)
    // is stale; any other host change is a vendor migration and is followed.
    if (provider === "kimi_code" && isOtherKimiRegionOrigin(parsed.origin)) {
      return false;
    }
    return CAPTURE[provider].match(parsed.pathname);
  } catch {
    return false;
  }
};

/** Race a promise against a timeout, resolving the fallback if it elapses OR if
 *  `p` rejects (capture failure → fallback, never an unhandled rejection). */
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });

/**
 * Headers the identity capture RETAINS — a strict ALLOWLIST of the known
 * Claude CLI identity set, so a credential-bearing or unrecognized header
 * (`authorization`, `proxy-authorization`, `cookie`, a future vendor token)
 * is never persisted or replayed, even one we didn't foresee. Deliberately
 * NOT here: `anthropic-beta` (composed separately by the wire builder —
 * `buildUpstreamHeaders` merges the OAuth beta + the client's inbound beta,
 * so replaying a captured copy would fight it) and every transport/entity
 * header (the rebuilt request derives its own).
 */
const IDENTITY_ALLOW: ReadonlySet<string> = new Set([
  "user-agent",
  "x-app",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
]);
/** The SDK's telemetry family (`x-stainless-lang`, `-os`, `-arch`,
 *  `-runtime`, `-package-version`, …) — allowlisted by prefix. */
const IDENTITY_ALLOW_PREFIX = "x-stainless-";

/**
 * Filter a captured request's headers down to the CLI's IDENTITY set — the
 * allowlist above, lower-cased; everything else is rejected. Exported for
 * the parity tests.
 */
export const filterIdentityHeaders = (
  headers: Headers,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (!IDENTITY_ALLOW.has(name) && !name.startsWith(IDENTITY_ALLOW_PREFIX))
      return;
    out[name] = value;
  });
  return out;
};

type TCapturedRequest = {
  readonly path: string;
  readonly identityHeaders: Readonly<Record<string, string>>;
};

type TRecorder = {
  readonly base: string;
  readonly first: Promise<TCapturedRequest>;
  readonly stop: () => void;
};

/**
 * A loopback HTTP recorder bound to an ephemeral 127.0.0.1 port. It resolves
 * `first` with the PATH of the first request whose path passes `spec.match` (the
 * INFERENCE call) — replying 204, after which the caller kills the CLI. Every
 * OTHER (preamble) request is FORWARDED to the real vendor so the CLI proceeds
 * far enough to issue its inference call. The inference request itself is
 * captured-then-killed and never forwarded, so it never reaches the vendor. The
 * request PATH is read, plus — for `captureIdentity` providers — the FILTERED
 * identity headers (allowlist-only; see `IDENTITY_ALLOW`). URL-only captures
 * discard the header set.
 */
const startRecorder = (spec: TCaptureSpec): TRecorder => {
  let resolveFirst!: (v: TCapturedRequest) => void;
  let captured = false;
  const first = new Promise<TCapturedRequest>((resolve) => {
    resolveFirst = resolve;
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (!captured && spec.match(url.pathname)) {
        captured = true;
        resolveFirst({
          path: url.pathname,
          identityHeaders:
            spec.captureIdentity === true
              ? filterIdentityHeaders(req.headers)
              : {},
        });
        return new Response(null, { status: 204 });
      }
      // Preamble — forward to the real vendor so the CLI continues to the
      // inference call. Strip `host` so fetch sets it for the real origin.
      try {
        const fwd = new Headers(req.headers);
        fwd.delete("host");
        return await fetch(spec.origin + url.pathname + url.search, {
          method: req.method,
          headers: fwd,
          body:
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : await req.arrayBuffer(),
        });
      } catch {
        return new Response(null, { status: 502 });
      }
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    first,
    stop: () => server.stop(true),
  };
};

/**
 * Run the CLI's headless `exec` against the recorder, capture the INFERENCE
 * request (preamble calls forwarded so the CLI gets there), and return the
 * full upstream URL + the filtered identity headers (empty unless the
 * provider declares `captureIdentity`). Null on any failure (CLI absent,
 * never issued a matching request within the timeout, spawn error) — the
 * caller falls back to the default URL / no identity.
 */
const captureInferenceRequest = async (
  provider: TCliProvider,
): Promise<{
  readonly url: string;
  readonly identityHeaders: Readonly<Record<string, string>>;
} | null> => {
  const spec = CAPTURE[provider];
  const bin = cliBin(provider);
  const recorder = startRecorder(spec);
  const cmdArgv = [...spec.argv(bin, recorder.base)];
  const spawnArgv =
    spec.usePty === true
      ? (ptyScriptArgv(cmdArgv, "/dev/null") ?? cmdArgv)
      : cmdArgv;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    // claude's identity capture runs the CLI's `exec`, which reads the isolated
    // keychain credential; unconfined on macOS for the keychain providers,
    // confined otherwise — `sandbox/policy.ts`.
    proc = Bun.spawn(
      sandboxSpawnArgs(spawnArgv, { probe: unwrapKeychainSpawn(provider) }),
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        cwd: tmpdir(),
        env: {
          ...process.env,
          ...cliEnv(provider),
          ...spec.env(recorder.base),
        },
      },
    );
  } catch (err) {
    recorder.stop();
    logDebug("auth-config", `capture spawn failed for ${provider}`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Resolve as soon as the inference request is captured, OR the CLI exits — a
  // CLI that errors before issuing its request is never going to send one.
  const captured = await withTimeout(
    Promise.race([
      recorder.first,
      proc.exited.then(() => null as TCapturedRequest | null),
    ]),
    CAPTURE_TIMEOUT_MS,
    null as TCapturedRequest | null,
  );
  proc.kill();
  recorder.stop();

  if (captured === null) {
    logDebug("auth-config", `capture yielded no request for ${provider}`);
    return null;
  }
  return {
    url: spec.origin + captured.path,
    identityHeaders: captured.identityHeaders,
  };
};

// ONE capture in flight per provider — URL and identity callers share the same
// recorder run rather than racing it; the run patches every field the
// provider's spec captures under the ONE freshness key.
const captureInFlight = new Map<
  TCliProvider,
  Promise<{
    readonly url: string;
    readonly identityHeaders: Readonly<Record<string, string>>;
  } | null>
>();

const runCaptureOnce = (
  provider: TCliProvider,
): Promise<{
  readonly url: string;
  readonly identityHeaders: Readonly<Record<string, string>>;
} | null> => {
  const existing = captureInFlight.get(provider);
  if (existing !== undefined) return existing;
  const spec = CAPTURE[provider];
  const run = (async () => {
    const captured = await captureInferenceRequest(provider);
    if (captured === null) return null;
    const ver = await cliVersion(cliBin(provider), cliEnv(provider));
    await patchConfig(provider, {
      // `liveCapture: false` providers keep their URL policy (serve the
      // stable default) — a run for them exists for IDENTITY only, so no
      // URL is persisted that `ensureUpstreamUrl` would then start serving.
      ...(spec.liveCapture !== false ? { upstream_url: captured.url } : {}),
      // ALWAYS written on a successful capture (even `{}`): an empty set
      // means the CLI genuinely sent no allowlisted identity headers, and a
      // stale non-empty fixture must be CLEARED, not kept.
      ...(spec.captureIdentity === true
        ? { identity_headers: captured.identityHeaders }
        : {}),
      cli_version: ver ?? "",
      captured_at_ms: Date.now(),
    });
    logInfo("auth-config", `captured ${provider} inference request`, {
      url: captured.url,
      ...(spec.captureIdentity === true
        ? {
            identity: Object.keys(captured.identityHeaders).sort().join(","),
          }
        : {}),
    });
    return captured;
  })().finally(() => captureInFlight.delete(provider));
  captureInFlight.set(provider, run);
  return run;
};

/** Version match + within TTL — the shared freshness of the last capture. */
const captureFresh = (cfg: TAuthConfig, cliVer: string | null): boolean =>
  cfg.cli_version === (cliVer ?? "") &&
  typeof cfg.captured_at_ms === "number" &&
  Date.now() - cfg.captured_at_ms < TTL_MS;

const urlFresh = (cfg: TAuthConfig, cliVer: string | null): boolean =>
  cfg.upstream_url !== undefined && captureFresh(cfg, cliVer);

/**
 * Ensure (and return) the captured upstream URL for a provider: the stored URL
 * if fresh (version match AND within TTL AND a valid inference path), else a
 * freshly captured one. Returns the stale stored URL (or null) if capture fails
 * so serving never hard-breaks. `force` bypasses the freshness cache (used
 * right after a re-login) and recaptures **only** when capture is allowed.
 * `captureIfMissing: false` is a hard read-only gate: it NEVER spawns the CLI
 * (`--version` or capture) and **wins over `force`** — the combo still serves
 * the best stored URL (even stale) or null. Callers that previously passed
 * both flags are tolerated; this does not throw. Use `force` alone to recapture.
 */
const ensureUpstreamUrl = async (
  provider: TCliProvider,
  opts?: { readonly force?: boolean; readonly captureIfMissing?: boolean },
): Promise<string | null> => {
  const cfg = (await readConfig(provider)) ?? {};
  const stored =
    cfg.upstream_url !== undefined && urlIsInference(provider, cfg.upstream_url)
      ? cfg.upstream_url
      : null;
  // Providers flagged `liveCapture: false` NEVER spawn a `-p ping` capture (it
  // would rotate their OAuth refresh token behind the daemon's back). Short-
  // circuit to the stored URL (or null → the stable default via
  // `resolveUpstreamUrl`) BEFORE the `cliVersion` probe below, so a legacy
  // stored URL can't trigger a pointless `claude --version` spawn either. For
  // claude_code the only other isolated-CLI call the daemon makes is
  // `claude auth status`, a pure local READ (verified — no token refresh), so
  // with the capture gone the daemon is the SOLE refresher (no rotation race).
  if (CAPTURE[provider].liveCapture === false) return stored;
  // Hard read-only: wins over `force`. Auto discoverModels / usage / a
  // logged-out box must not spawn `--version` or recapture.
  if (opts?.captureIfMissing === false) return stored;
  if (opts?.force !== true && stored !== null) {
    const ver = await cliVersion(cliBin(provider), cliEnv(provider));
    if (urlFresh(cfg, ver)) return stored;
  }
  const captured = await runCaptureOnce(provider);
  return captured?.url ?? stored;
};

/**
 * The isolated CLI's own identity headers for a HANDROLLED hop — the stored
 * set if fresh (the shared `cli_version` + TTL key), else re-captured by the
 * SAME shape-only recorder run the URL capture uses (killed before the
 * vendor; zero token cost; shared single-flight). Returns null for providers
 * without `captureIdentity` (everyone but claude_code — their handrolled hops
 * keep pure originator passthrough), and the stale/absent stored value on
 * capture failure (the hop then serves originator-only, today's pre-parity
 * behavior — never a hard break). `force` bypasses freshness (post-re-login).
 */
export const resolveIdentityHeaders = async (
  provider: TCliProvider,
  opts?: { readonly force?: boolean },
): Promise<Readonly<Record<string, string>> | null> => {
  if (CAPTURE[provider].captureIdentity !== true) return null;
  const cfg = (await readConfig(provider)) ?? {};
  const stored = cfg.identity_headers ?? null;
  if (opts?.force !== true && stored !== null) {
    // Stamp-keyed `cliVersion` — this runs per hop and must not spawn
    // `--version` each time for an unchanged binary.
    const ver = await cliVersion(cliBin(provider), cliEnv(provider));
    if (captureFresh(cfg, ver)) return stored;
  }
  const captured = await runCaptureOnce(provider);
  // Capture FAILED → the stale-but-present fixture beats nothing. Capture
  // SUCCEEDED with an empty set → the CLI sent no allowlisted identity;
  // resolve null (originator-only) rather than replaying a stale fixture
  // the persistence above just cleared.
  if (captured === null) return stored;
  return Object.keys(captured.identityHeaders).length > 0
    ? captured.identityHeaders
    : null;
};

/**
 * Resolve the upstream URL for a served hop — the captured URL, or the
 * delegate's default when none exists. `opts` forwarded to {@link
 * ensureUpstreamUrl}.
 */
export const resolveUpstreamUrl = async (
  provider: TCliProvider,
  opts?: { readonly captureIfMissing?: boolean },
): Promise<string> => {
  const url = await ensureUpstreamUrl(provider, opts).catch(() => null);
  return url ?? defaultUpstreamUrl(provider);
};

/**
 * Build a URL for a sibling endpoint on the SAME host as a provider's captured
 * inference endpoint — e.g. the vendor usage endpoint. The HOST is taken from
 * the captured `upstream_url` (falling back to the default origin), so a vendor
 * host migration — the exact drift that bit the token host — is auto-tracked
 * with no hardcoded origin; only the stable leaf `path` (e.g. `/api/oauth/usage`)
 * is a constant. NEVER spawns a capture (`captureIfMissing:false`) — callers
 * (usage reads) must not trigger a CLI spawn.
 */
export const resolveProviderUrl = async (
  provider: TCliProvider,
  path: string,
): Promise<string> => {
  // Enforce the same-host contract: `path` must be an absolute PATH on the
  // captured host. An absolute (`https://…`) or protocol-relative (`//host`)
  // value would let `new URL(path, origin)` OVERRIDE the origin and silently
  // point off-host — refuse it.
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(
      `resolveProviderUrl: path must be a same-origin absolute path, got "${path}"`,
    );
  }
  const base = await resolveUpstreamUrl(provider, { captureIfMissing: false });
  return new URL(path, new URL(base).origin).toString();
};

// ─── Combined entry (post-login / -relogin re-capture) ───────────────────────

/**
 * Re-capture a provider's upstream URL — called after a fresh login, when the
 * identity / CLI may have changed. Best-effort. Token REFRESH is the CLI's own
 * job (see `delegation/refresh.ts`), so the URL is all there is to refresh here.
 * `captureIfMissing: false` remains hard read-only and wins over `force`
 * (same precedence as {@link ensureUpstreamUrl}).
 */
export const ensureAuthConfig = async (
  provider: TCliProvider,
  opts?: { readonly force?: boolean; readonly captureIfMissing?: boolean },
): Promise<void> => {
  await ensureUpstreamUrl(provider, opts).catch(() => null);
  // Refresh the identity fixture on the same trigger (a re-login may change
  // the CLI's identity). Never spawns for providers without `captureIdentity`,
  // and respects `captureIfMissing: false` (a possibly logged-out CLI must not
  // be spawned).
  if (opts?.captureIfMissing !== false) {
    await resolveIdentityHeaders(provider, { force: opts?.force }).catch(
      () => null,
    );
  }
};
