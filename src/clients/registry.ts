/**
 * The client registry — the SINGLE source of truth for which clients
 * `openllm <client>` supports, how each one is reached, and which mode it runs
 * in. `commands.ts` derives help + completion from this, the dashboard renders
 * one instruction card per entry, and dispatch in `main.ts` switches on it, so
 * none of those can drift from the actual supported set.
 *
 * Two modes (docs/proposals/remove-registry-runtime-config-merge.md §3.4):
 *
 *   session   — the client is launched per task and can be pointed at an
 *               overlay we own (a flag, a `-c` override, or a private config
 *               dir). We merge in memory, write only into an ephemeral
 *               ~/.openllm/run/<client>/<pid>/, exec the real binary, and
 *               never touch the user's config. No uninstall exists because
 *               nothing was installed.
 *
 *   always-on — the client is a long-lived app with a fixed config path and no
 *               per-invocation overlay hook (Raycast). `openllm <client>`
 *               applies the overlay to the host config IN PLACE and
 *               `openllm <client> uninstall` reverses exactly that, tracked by
 *               an ownership ledger under ~/.openllm/clients/.
 */

export const CLIENT_IDS = [
  "claude",
  "codex",
  "grok",
  "opencode",
  "raycast",
] as const;
export type TClientId = (typeof CLIENT_IDS)[number];

export type TClientMode = "session" | "always-on";

/**
 * How a session client is pointed at our overlay. Each strategy is the
 * client's OWN documented mechanism — we never redirect a config dir when a
 * narrower hook exists, because a full redirect would also displace the user's
 * credentials and history.
 */
export type TSessionStrategy =
  /** Extra CLI flags referencing run-local files (Claude: --settings/--mcp-config). */
  | "flags"
  /** `-c key=value` overrides layered on the user's config (Codex). */
  | "config-overrides"
  /** A private config dir env var over a symlink farm of the real one (Grok). */
  | "config-dir"
  /** A single config-file env var (OpenCode). */
  | "config-file";

export type TClient = {
  readonly id: TClientId;
  /** Human label for help text + the dashboard card. */
  readonly name: string;
  readonly mode: TClientMode;
  /** Binary we exec, and the candidate paths to find it at. */
  readonly bin: string;
  readonly binPaths: readonly string[];
  /** Official install docs, printed when the binary is missing. */
  readonly installHint: string;
  /** Session clients only: how the overlay reaches the client. */
  readonly strategy?: TSessionStrategy;
  /** Whether this client needs a live model catalog (and under which id the
   *  gateway serves it — the historical slug, which may differ from `id`). */
  readonly catalogSlug?: string;
  /** Platforms the client runs on; empty = every supported OS. */
  readonly os?: readonly ("darwin" | "linux")[];
  /** One-line note rendered under the dashboard card. */
  readonly note: string;
};

export const CLIENTS: Readonly<Record<TClientId, TClient>> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    mode: "session",
    strategy: "flags",
    bin: "claude",
    binPaths: ["~/.local/bin/claude"],
    installHint: "https://claude.ai/install.sh",
    note: "Your ~/.claude config is never modified.",
  },
  codex: {
    id: "codex",
    name: "Codex",
    mode: "session",
    strategy: "config-overrides",
    bin: "codex",
    binPaths: ["~/.local/bin/codex", "~/.codex/bin/codex"],
    installHint: "https://chatgpt.com/codex/install.sh",
    catalogSlug: "codex",
    note: "Your ~/.codex/config.toml is never modified.",
  },
  grok: {
    id: "grok",
    name: "Grok Build",
    mode: "session",
    strategy: "config-dir",
    bin: "grok",
    binPaths: ["~/.grok/bin/grok", "~/.local/bin/grok"],
    installHint: "https://x.ai/cli/install.sh",
    catalogSlug: "grok-build",
    note: "Your ~/.grok config and auth.json are never modified.",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    mode: "session",
    strategy: "config-file",
    bin: "opencode",
    binPaths: ["~/.opencode/bin/opencode", "~/.local/bin/opencode"],
    installHint: "https://opencode.ai/install",
    catalogSlug: "opencode",
    note: "Your ~/.config/opencode config is never modified.",
  },
  raycast: {
    id: "raycast",
    name: "Raycast",
    mode: "always-on",
    bin: "",
    binPaths: [],
    installHint: "https://raycast.com",
    catalogSlug: "raycast",
    os: ["darwin"],
    note: "Raycast runs continuously, so OpenLLM is applied to its config once. Remove it with `openllm raycast uninstall`.",
  },
} as const;

export const isClientId = (value: string): value is TClientId =>
  (CLIENT_IDS as readonly string[]).includes(value);

/** Verbs an always-on client reserves; everything else forwards to the client. */
export const ALWAYS_ON_VERBS = ["uninstall", "status"] as const;
export type TAlwaysOnVerb = (typeof ALWAYS_ON_VERBS)[number];

export const isAlwaysOnVerb = (value: string): value is TAlwaysOnVerb =>
  (ALWAYS_ON_VERBS as readonly string[]).includes(value);
