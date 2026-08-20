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
  "hermes",
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

/** The daemon broker's session vocabulary for launchable clients.
 *  Mirrors DeviceSessionCli in packages/protocol/daemon.ts — this compiled
 *  binary carries no workspace deps, so the set is restated here once and
 *  every CLI-side consumer imports THIS alias. */
export const DAEMON_CLIS = [
  "claude_code",
  "chatgpt",
  "grok",
  "opencode",
] as const;
export type TDaemonCli = (typeof DAEMON_CLIS)[number];

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
  /** Daemon broker's DeviceSessionCli vocabulary for this client. */
  readonly daemonCli?: TDaemonCli;
  /** Client argv markers that select a non-interactive mode. */
  readonly nonInteractiveMarkers?: readonly string[];
  /** Whether this client needs a live model catalog (and under which id the
   *  gateway serves it — the historical slug, which may differ from `id`). */
  readonly catalogSlug?: string;
  /** Platforms the client runs on; empty = every supported OS. */
  readonly os?: readonly ("darwin" | "linux")[];
  /**
   * This client's own "skip every approval prompt" flag, which `-d` translates
   * to. Every client spells it differently, so `-d` is OUR stable spelling and
   * this is the mapping. Undefined = the client has no equivalent, and `-d`
   * errors rather than silently launching WITH prompts (a false sense of
   * yolo-mode is worse than a clear refusal).
   */
  readonly dangerousFlag?: string;
  /** One-line note. Rendered as a `# …` comment inside the dashboard's
   *  terminal block and in `openllm <client> -h`, so keep it short and
   *  period-free — it has to read as a shell comment. */
  readonly note: string;
};

export const CLIENTS: Readonly<Record<TClientId, TClient>> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    mode: "session",
    strategy: "flags",
    daemonCli: "claude_code",
    nonInteractiveMarkers: ["-p", "--print"],
    bin: "claude",
    binPaths: ["~/.local/bin/claude"],
    installHint: "https://claude.ai/install.sh",
    dangerousFlag: "--dangerously-skip-permissions",
    note: "your ~/.claude config is never modified",
  },
  codex: {
    id: "codex",
    name: "Codex",
    mode: "session",
    strategy: "config-overrides",
    daemonCli: "chatgpt",
    nonInteractiveMarkers: ["exec"],
    bin: "codex",
    binPaths: ["~/.local/bin/codex", "~/.codex/bin/codex"],
    installHint: "https://chatgpt.com/codex/install.sh",
    catalogSlug: "codex",
    dangerousFlag: "--dangerously-bypass-approvals-and-sandbox",
    note: "your ~/.codex/config.toml is never modified",
  },
  grok: {
    id: "grok",
    name: "Grok Build",
    mode: "session",
    strategy: "config-dir",
    daemonCli: "grok",
    nonInteractiveMarkers: ["-p", "--print"],
    bin: "grok",
    binPaths: ["~/.grok/bin/grok", "~/.local/bin/grok"],
    installHint: "https://x.ai/cli/install.sh",
    catalogSlug: "grok-build",
    dangerousFlag: "--always-approve",
    note: "your ~/.grok config and auth.json are never modified",
  },
  hermes: {
    id: "hermes",
    name: "Hermes",
    mode: "always-on",
    strategy: "config-dir",
    nonInteractiveMarkers: ["-z", "run", "cron", "webhook", "gateway"],
    bin: "hermes",
    binPaths: ["~/.hermes/bin/hermes", "~/.local/bin/hermes"],
    installHint: "https://hermes-agent.nousresearch.com/install.sh",
    dangerousFlag: "--yolo",
    note: "clones a sticky openllm profile; default ~/.hermes config is never edited",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    mode: "session",
    strategy: "config-file",
    daemonCli: "opencode",
    nonInteractiveMarkers: ["run", "serve", "--print"],
    bin: "opencode",
    binPaths: ["~/.opencode/bin/opencode", "~/.local/bin/opencode"],
    installHint: "https://opencode.ai/install",
    catalogSlug: "opencode",
    note: "your ~/.config/opencode config is never modified",
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
    note: "Raycast runs continuously, so this applies to its config once",
  },
} as const;

export const isClientId = (value: string): value is TClientId =>
  (CLIENT_IDS as readonly string[]).includes(value);

/** Verbs an always-on client reserves; everything else forwards to the client. */
export const ALWAYS_ON_VERBS = ["uninstall", "status"] as const;
export type TAlwaysOnVerb = (typeof ALWAYS_ON_VERBS)[number];

export const isAlwaysOnVerb = (value: string): value is TAlwaysOnVerb =>
  (ALWAYS_ON_VERBS as readonly string[]).includes(value);

/**
 * OpenLLM-level flags, which sit BEFORE the client name:
 *
 *   openllm -d -r claude --resume
 *           ^^^^^ ours    ^^^^^^^^ the client's, untouched
 *
 * Position is load-bearing, not stylistic. `-d` and `-r` are already taken by
 * the clients themselves — claude has `-d`=--debug and `-r`=--resume, grok has
 * `-r`=--resume — so consuming them AFTER the client name would silently steal
 * a flag the user meant for the client. Putting them where openllm's own flags
 * live means everything after the client name is unambiguously the client's,
 * now and as clients add flags.
 */
export type TClientFlags = {
  /** `-d` — translate to the client's own skip-all-approvals flag. */
  readonly dangerous: boolean;
  /** `-r` — point the session at the CLOUD gateway instead of this machine's
   *  daemon, so subscription hops take the cloud's 307-redirect path. */
  readonly remote: boolean;
  /** `--new` — always start a fresh session; never offer to attach to one
   *  already running on this machine. */
  readonly fresh: boolean;
  /**
   * `--attach [id]` — attach to a running session without being asked. An id
   * (or unique prefix) picks one; a bare `--attach` takes the best match for
   * this client and directory. Null means the flag was absent.
   */
  readonly attach: string | null;
  /** Incompatible session-selection flags detected before client dispatch. */
  readonly sessionSelectionError?: string;
  /** Everything from the client name onward, in order and untouched. */
  readonly rest: readonly string[];
};

/**
 * Split our flags off the front of `openllm`'s OWN argv — i.e. the arguments
 * that appear before the client name. Stops at the first token that isn't one
 * of ours, which is the client name itself.
 *
 * `rest` therefore begins with the client name (when one was given), and
 * everything after it is forwarded to the client verbatim — we never inspect,
 * reorder, or rewrite a single client argument.
 */
export const parseClientFlags = (args: readonly string[]): TClientFlags => {
  let dangerous = false;
  let remote = false;
  let fresh = false;
  let attach: string | null = null;
  let sessionSelectionError: string | undefined;
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-d") {
      dangerous = true;
      continue;
    }
    if (arg === "-r") {
      remote = true;
      continue;
    }
    // Long-form on purpose: `-n`/`-a` would be plausible client flags, and
    // these live in the same position as `-d`/`-r`, so a collision would be
    // silent. Session selection is rare enough that spelling it out is fine.
    if (arg === "--new") {
      fresh = true;
      if (attach !== null)
        sessionSelectionError = "--new cannot be combined with --attach";
      continue;
    }
    if (arg === "--attach") {
      if (fresh)
        sessionSelectionError = "--new cannot be combined with --attach";
      // A bare `--attach` means "best match"; an id may follow. The next token
      // is only consumed when it cannot be the client name or another flag.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-") && !isClientId(next)) {
        // Session ids are uuids; a prefix is only usable at 4+ chars anyway.
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,}$/.test(next)) {
          sessionSelectionError = `invalid --attach selector: ${next}`;
          break;
        }
        attach = next;
        i += 1;
        continue;
      }
      attach = "";
      continue;
    }
    // Combined short form (`-dr`), since these are ours and take no values.
    if (/^-[dr]+$/.test(arg)) {
      dangerous = dangerous || arg.includes("d");
      remote = remote || arg.includes("r");
      continue;
    }
    break; // the client name (or an unknown flag) — everything from here is not ours
  }
  return {
    dangerous,
    remote,
    fresh,
    attach,
    ...(sessionSelectionError === undefined ? {} : { sessionSelectionError }),
    rest: args.slice(i),
  };
};
