import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { userHome } from "../env";
import {
  hookWorkerInvocation,
  startHookWorker,
  tryHookLock,
} from "../hook-helpers";

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const stateDirectory = (env: NodeJS.ProcessEnv): string =>
  env.CLAUDE_CONTEXT_STATE_DIR ||
  join(env.HOME || userHome(), ".claude/plugin-state/claude-context");
const enabled = (env: NodeJS.ProcessEnv, key: string): boolean =>
  (env[key] ?? "1") === "1";

/** Git is the only external dependency. No credential resolution in the parent. */
const repository = (cwd: string): string | null => {
  const git = (args: string[]): string | null => {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 3_000,
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  };
  const root = git(["rev-parse", "--show-toplevel"]);
  return root && git(["remote", "get-url", "origin"])
    ? realpathSync(root)
    : null;
};

const launchIndex = async (input: unknown, state: string): Promise<boolean> => {
  const fd = openSync(join(state, "auto-index.log"), "a", 0o600);
  try {
    return await startHookWorker(
      input,
      hookWorkerInvocation(
        process.execPath,
        process.argv[1],
        "ctx",
        "index-worker",
      ),
      fd,
    );
  } finally {
    closeSync(fd);
  }
};

/** The detached worker owns the lock, including throttle admission and sync. */
export const runIndexWorker = async (
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  index: (root: string) => Promise<void> = async (root): Promise<void> => {
    const { runClaudeContextCli } = await import("../mcp/claude-context");
    await runClaudeContextCli(["index", "--path", root]);
  },
): Promise<void> => {
  const event = recordOf(input);
  const trigger = event.trigger;
  if (trigger !== "session-start" && trigger !== "reindex-on-edit") return;
  if (
    !enabled(env, "CLAUDE_CONTEXT_AUTO_INDEX") ||
    (trigger === "reindex-on-edit" &&
      !enabled(env, "CLAUDE_CONTEXT_REINDEX_ON_EDIT"))
  )
    return;
  const root = text(event.root);
  if (!root || repository(root) !== root) return;
  const state = stateDirectory(env);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const marker = join(state, `reindex.${key}`);
  // Old shell .lock paths are directories; never reuse them as databases.
  const release = tryHookLock(`${marker}.lock.sqlite`);
  if (!release) return;
  try {
    if (trigger === "reindex-on-edit") {
      const raw = env.CLAUDE_CONTEXT_REINDEX_INTERVAL ?? "120";
      const interval =
        /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
          ? Number(raw)
          : 120;
      const previous = statSync(marker, { throwIfNoEntry: false });
      if (
        previous &&
        Math.floor(Date.now() / 1000) - Math.floor(previous.mtimeMs / 1000) <
          interval
      )
        return;
      writeFileSync(marker, "", { mode: 0o600 });
    }
    await index(root);
  } finally {
    release();
  }
};

export const runContextHook = async (
  verb: string,
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  launch?: (input: unknown) => Promise<boolean>,
): Promise<string | null> => {
  const event = recordOf(input);
  if (verb === "grep-nudge") {
    if (!enabled(env, "CLAUDE_CONTEXT_GREP_NUDGE")) return null;
    const tool = text(event.tool_name ?? event.toolName);
    const command = text(recordOf(event.tool_input ?? event.toolInput).command);
    if (
      !["Grep", "Glob", "grep", "list_dir"].includes(tool) &&
      !(
        ["Bash", "run_terminal_command"].includes(tool) &&
        /(^|[|&;\s])(grep|rg|ag|ack)(\s|$)/.test(command)
      )
    )
      return null;
    if (!repository(text(event.cwd) || env.CLAUDE_PROJECT_DIR || process.cwd()))
      return null;
    const state = stateDirectory(env);
    mkdirSync(state, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(state)) {
      if (!name.startsWith("grep-nudge.")) continue;
      try {
        if (
          Date.now() - statSync(join(state, name)).mtimeMs >=
          8 * 24 * 60 * 60 * 1000
        )
          unlinkSync(join(state, name));
      } catch {
        /* Opportunistic pruning; another hook may have pruned it. */
      }
    }
    const session =
      text(event.session_id ?? event.sessionId) || `ppid-${process.ppid}`;
    const key = session.replace(/[^A-Za-z0-9._-]/g, "_");
    try {
      closeSync(openSync(join(state, `grep-nudge.${key}`), "wx", 0o600));
    } catch {
      return null;
    }
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `claude-context: this repo is indexed for semantic search. If this ${tool} is answering a conceptual question ("where is X handled", "how does Y work", "what implements Z") rather than matching a known identifier/regex/filename, prefer \`mcp__openllm__search_code\` — it finds code by meaning and often lands in one call. Grep/Glob remain right for exact strings. This nudge fires once per session.`,
      },
    });
  }
  if (verb !== "session-start" && verb !== "reindex-on-edit") return null;
  if (
    !enabled(env, "CLAUDE_CONTEXT_AUTO_INDEX") ||
    (verb === "reindex-on-edit" &&
      !enabled(env, "CLAUDE_CONTEXT_REINDEX_ON_EDIT"))
  )
    return null;
  const root = repository(
    env.CLAUDE_PROJECT_DIR || text(event.cwd) || process.cwd(),
  );
  if (!root) return null;
  const state = stateDirectory(env);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const payload = { root, trigger: verb };
  const started = await (launch
    ? launch(payload)
    : launchIndex(payload, state));
  if (verb === "reindex-on-edit") return null;
  return started
    ? `This repository supports semantic search (claude-context MCP).\nIndexing/syncing ${root} scheduled in background (log: ${join(state, "auto-index.log")}).`
    : "OpenLLM context: automatic indexing could not start. Work can continue; check the OpenLLM CLI installation.";
};
