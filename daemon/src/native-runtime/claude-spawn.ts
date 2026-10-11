/**
 * Shared `claude -p` argv + spawn owner for `claude-native.ts` and
 * `claude-capture.ts` — capture is a wrapper around the same invocation, never
 * a parallel one. Callers decide env policy (capture layers
 * `ANTHROPIC_BASE_URL` onto the cleaned env first); this module just spawns
 * with whatever final env it's given.
 */

import { spawnCwd } from "../delegation/util";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapKeychainSpawn } from "../sandbox/policy";

export type TClaudeCliArgvParams = {
  readonly bin: string;
  readonly providerModelId: string;
  /** Applied ONLY on a fresh session (a resumed session already carries it). */
  readonly systemText: string | null;
  /** Resume this session id (feed only the delta turn), or null → fresh session. */
  readonly resumeSessionId: string | null;
};

/** The one `claude -p …` argv both callers build. See `claude-native.ts`'s
 *  file doc for per-flag rationale (no `--bare`, `--max-turns 1`, …). */
export const buildClaudeCliArgv = (params: TClaudeCliArgvParams): string[] => [
  params.bin,
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--setting-sources",
  "",
  // Belt-and-suspenders with `--setting-sources ""`: never load an MCP server.
  "--strict-mcp-config",
  "--tools",
  "",
  "--max-turns",
  "1",
  "--model",
  params.providerModelId,
  // Resume feeds only the delta turn (session already has history + system
  // prompt); a fresh start applies the system prompt and seeds via stdin.
  ...(params.resumeSessionId !== null
    ? ["--resume", params.resumeSessionId]
    : params.systemText !== null
      ? ["--system-prompt", params.systemText]
      : []),
];

export type TSpawnClaudeCliParams = TClaudeCliArgvParams & {
  /** Fed over stdin: the delta turn on resume, or the seed prompt fresh. */
  readonly userText: string;
  /** Final env to spawn with — already cleaned (and, for capture, loopback-
   *  decorated) by the caller; `cwd` is derived from it via `spawnCwd`. */
  readonly finalEnv: Record<string, string>;
};

/** Build the argv and spawn the isolated `claude` CLI child. Throws whatever
 *  `Bun.spawn` throws; callers translate that into their own decline. */
export const spawnClaudeCli = (
  params: TSpawnClaudeCliParams,
): ReturnType<typeof Bun.spawn> => {
  const argv = buildClaudeCliArgv(params);
  return Bun.spawn(
    sandboxSpawnArgs(argv, { probe: unwrapKeychainSpawn("claude_code") }),
    {
      stdin: new TextEncoder().encode(params.userText),
      stdout: "pipe",
      stderr: "pipe",
      cwd: spawnCwd(params.finalEnv),
      env: params.finalEnv,
    },
  );
};

/**
 * A loopback MCP server exposing this turn's caller tools (schema only —
 * `claude-facade-mcp-server.ts`'s handler is inert), or `null` for a
 * tool-free turn. `--strict-mcp-config` (always passed below) means this is
 * the ONLY MCP source the facade child ever sees.
 */
export type TClaudeFacadeMcpServerRef = {
  readonly url: string;
  readonly headers: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
};

export type TClaudeFacadeCliArgvParams = {
  readonly bin: string;
  readonly providerModelId: string;
  /** Full system text for this turn — the facade replays whole history every
   *  turn (no vendor session to carry it), so this is never conditional on
   *  resume like {@link TClaudeCliArgvParams.systemText}. */
  readonly systemText: string | null;
  readonly mcpServer: TClaudeFacadeMcpServerRef | null;
};

const facadeMcpConfigJson = (server: TClaudeFacadeMcpServerRef): string =>
  JSON.stringify({
    mcpServers: {
      openllm: {
        type: "http",
        url: server.url,
        headers: Object.fromEntries(
          server.headers.map((h) => [h.name, h.value] as const),
        ),
      },
    },
  });

/**
 * The `claude -p --input-format stream-json --output-format stream-json …`
 * argv for the `sdk-facade` completion variant (H2/H3,
 * `docs/plan/bridge-variants-and-capture-adapters/12-hermes-adoption-plan.md`
 * §3.A/§5) — a SEPARATE invocation policy from {@link buildClaudeCliArgv}'s
 * single-shot text CLI, never a copy of it: the facade feeds FRAMED
 * bidirectional stream-json (full history replay every turn, no
 * `--resume`/session persistence — see `claude-sdk-facade.ts`) and may
 * declare caller tools via a loopback MCP server, both of which the plain
 * text variant structurally cannot do. `--tools ""` still disables every
 * BUILT-IN tool regardless of `mcpServer` — caller tools stay caller-owned
 * (00-requirements.md req. 6); `--disable-slash-commands` +
 * `--setting-sources ""` + `--strict-mcp-config` keep the turn hermetic;
 * `--no-session-persistence` matches the plan's "no parked native session"
 * principle (12-hermes-adoption-plan.md §3.E, §5/H2).
 */
export const buildClaudeFacadeArgv = (
  params: TClaudeFacadeCliArgvParams,
): string[] => [
  params.bin,
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--tools",
  "",
  "--max-turns",
  "1",
  "--permission-mode",
  "dontAsk",
  "--no-session-persistence",
  "--model",
  params.providerModelId,
  ...(params.systemText !== null ? ["--system-prompt", params.systemText] : []),
  ...(params.mcpServer !== null
    ? ["--mcp-config", facadeMcpConfigJson(params.mcpServer)]
    : []),
];

export type TSpawnClaudeFacadeCliParams = TClaudeFacadeCliArgvParams & {
  /** Final env — already cleaned (and, for `sdk-facade-capture`, loopback-
   *  decorated) by the caller, exactly like {@link TSpawnClaudeCliParams}. */
  readonly finalEnv: Record<string, string>;
};

/**
 * Spawn the facade's `claude` child with a WRITABLE stdin pipe — unlike
 * {@link spawnClaudeCli}'s one-shot buffered stdin, the facade writes framed
 * history turns incrementally and reads acknowledgments between writes (see
 * `claude-sdk-facade.ts`'s replay loop), so stdin must stay open as a stream
 * across multiple writes rather than being closed at spawn time.
 */
export const spawnClaudeFacadeCli = (
  params: TSpawnClaudeFacadeCliParams,
): ReturnType<typeof Bun.spawn> => {
  const argv = buildClaudeFacadeArgv(params);
  return Bun.spawn(
    sandboxSpawnArgs(argv, { probe: unwrapKeychainSpawn("claude_code") }),
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: spawnCwd(params.finalEnv),
      env: params.finalEnv,
    },
  );
};
