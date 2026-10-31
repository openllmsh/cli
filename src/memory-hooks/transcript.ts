import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { LEGACY_RECALL_MARKER, RECALL_MARKER } from "./env";
import { recordOf } from "./transport";

export type TTranscriptTurn = { role: "user" | "assistant"; text: string };

export const slugify = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);

export const memoryProject = (cwd: string, override?: string): string => {
  const explicit = override ? slugify(override) : "";
  if (explicit) return explicit;
  try {
    const root = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const project = slugify(basename(root));
    if (project) return project;
  } catch {
    /* Not a git checkout or git unavailable: cwd remains useful. */
  }
  return slugify(basename(cwd)) || "default";
};

/** Text the harness injects into a user-role entry, not words the user typed. */
const SYSTEM_INJECTED_PREFIXES = [
  "<task-notification>",
  "[SYSTEM NOTIFICATION",
  "<local-command-",
  "<command-name>",
] as const;

/**
 * True for user-role entries the user didn't write: background-task results,
 * hook output and other system prompts. Saving these as "the user said"
 * turns an agent's status report into a durable fact.
 */
const isSystemInjected = (
  entry: Record<string, unknown>,
  text: string,
): boolean =>
  entry.isMeta === true ||
  entry.promptSource === "system" ||
  recordOf(entry.origin)?.kind === "task-notification" ||
  SYSTEM_INJECTED_PREFIXES.some((prefix) =>
    text.trimStart().startsWith(prefix),
  );

const claudeEntry = (
  entry: Record<string, unknown>,
): TTranscriptTurn | null => {
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  const message = recordOf(entry.message);
  const role = message?.role ?? entry.type;
  if (role !== "user" && role !== "assistant") return null;
  const content = message?.content;
  if (typeof content === "string") {
    if (role === "user" && isSystemInjected(entry, content)) return null;
    return { role, text: content };
  }
  if (!Array.isArray(content)) return null;
  const chunks: string[] = [];
  for (const value of content) {
    const block = recordOf(value);
    if (block?.type === "text" && typeof block.text === "string")
      chunks.push(block.text);
    else if (block?.type === "tool_use")
      chunks.push(
        `[tool_use:${typeof block.name === "string" ? block.name : "tool"}]`,
      );
    else if (block?.type === "tool_result") chunks.push("[tool_result]");
  }
  const text = chunks.join("\n");
  if (role === "user" && isSystemInjected(entry, text)) return null;
  return { role, text };
};

const grokEntry = (entry: Record<string, unknown>): TTranscriptTurn | null => {
  const update = recordOf(recordOf(entry.params)?.update);
  if (!update) return null;
  if (update.sessionUpdate === "tool_call")
    return {
      role: "assistant",
      text: `[tool_use:${typeof update.title === "string" ? update.title : "tool"}]`,
    };
  const role =
    update.sessionUpdate === "user_message_chunk"
      ? "user"
      : update.sessionUpdate === "agent_message_chunk"
        ? "assistant"
        : null;
  const text = recordOf(update.content)?.text;
  return role && typeof text === "string" ? { role, text } : null;
};

export const recentTurns = (path: string, limit: number): TTranscriptTurn[] => {
  const turns: TTranscriptTurn[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let entry: Record<string, unknown> | null;
    try {
      entry = recordOf(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    const parsed = claudeEntry(entry) ?? grokEntry(entry);
    const text = parsed?.text.trim();
    if (
      !parsed ||
      !text ||
      text.startsWith("<system-reminder>") ||
      text.startsWith(RECALL_MARKER) ||
      text.startsWith(LEGACY_RECALL_MARKER)
    )
      continue;
    const previous = turns.at(-1);
    if (previous?.role === parsed.role)
      previous.text = `${previous.text}\n${text}`;
    else turns.push({ ...parsed, text });
  }
  return turns.slice(-limit).map((turn) => ({
    ...turn,
    text: turn.text.length > 2000 ? `${turn.text.slice(0, 2000)}…` : turn.text,
  }));
};
