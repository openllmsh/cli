/**
 * Delete one Claude session's on-device history: its transcript
 * (`<config>/projects/<slug of its cwd>/<id>.jsonl`) and its lines in
 * `<config>/history.jsonl`, so the local-sessions index does not bring the
 * row back. Scoped hard: the id must be a Claude session id, the transcript
 * is resolved ONLY under the slug derived from that session's own cwd, and a
 * path that resolves anywhere else (symlink, traversal) is refused. Other
 * sessions' files and lines are never touched.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { claudeConfigDir } from "../local-sessions/paths";
import { claudeProjectSlug } from "./claude-transcript";

/** A Claude session id (a UUID); stricter than the wire's session id. */
export const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

export type TDeleteClaudeSessionResult =
  | {
      readonly ok: true;
      readonly transcriptRemoved: boolean;
      readonly historyLinesRemoved: number;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

const historyRowSessionId = (line: string): string | null => {
  try {
    const row: unknown = JSON.parse(line);
    if (row === null || typeof row !== "object") return null;
    const id = (row as Record<string, unknown>).sessionId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
};

/** The cwd this session's history lines record (newest wins), or null. */
export const claudeSessionCwdFromHistory = (
  sessionId: string,
  configDir: string = claudeConfigDir(),
): string | null => {
  const path = join(configDir, "history.jsonl");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let cwd: string | null = null;
  for (const line of text.split("\n")) {
    if (line.length === 0 || historyRowSessionId(line) !== sessionId) continue;
    try {
      const project = (JSON.parse(line) as Record<string, unknown>).project;
      if (typeof project === "string" && project.length > 0) cwd = project;
    } catch {}
  }
  return cwd;
};

/** Drop this session's lines from history.jsonl atomically (tmp + rename). */
export const removeClaudeHistoryLines = (
  sessionId: string,
  configDir: string = claudeConfigDir(),
): number => {
  const path = join(configDir, "history.jsonl");
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const kept = lines.filter(
    (line) => line.length === 0 || historyRowSessionId(line) !== sessionId,
  );
  const removed = lines.length - kept.length;
  if (removed === 0) return 0;
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, kept.join("\n"), { flag: "wx" });
    try {
      chmodSync(tmp, statSync(path).mode & 0o777);
    } catch {}
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return removed;
};

/**
 * Remove the session's transcript and history lines. `cwd` is the session's
 * working directory (the live session's, else history's); without one the
 * transcript cannot be located safely and is left alone.
 */
export const deleteClaudeSessionFiles = (args: {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly configDir?: string;
}): TDeleteClaudeSessionResult => {
  const { sessionId } = args;
  if (!CLAUDE_SESSION_ID_PATTERN.test(sessionId))
    return {
      ok: false,
      code: "invalid_session",
      message: "Invalid session id.",
    };
  const configDir = args.configDir ?? claudeConfigDir();
  const cwd = args.cwd ?? claudeSessionCwdFromHistory(sessionId, configDir);
  let transcriptRemoved = false;
  if (cwd !== null) {
    const projectsDir = join(configDir, "projects");
    const slugDir = join(projectsDir, claudeProjectSlug(cwd));
    const transcript = join(slugDir, `${sessionId}.jsonl`);
    if (existsSync(transcript)) {
      let inside = false;
      try {
        const realSlug = realpathSync(slugDir);
        const realProjects = realpathSync(projectsDir);
        inside =
          !lstatSync(transcript).isSymbolicLink() &&
          lstatSync(transcript).isFile() &&
          dirname(realpathSync(transcript)) === realSlug &&
          realSlug.startsWith(realProjects + sep);
      } catch {
        inside = false;
      }
      if (!inside)
        return {
          ok: false,
          code: "refused_path",
          message: "The session transcript is outside its project folder.",
        };
      unlinkSync(transcript);
      transcriptRemoved = true;
    }
  }
  const historyLinesRemoved = removeClaudeHistoryLines(sessionId, configDir);
  return { ok: true, transcriptRemoved, historyLinesRemoved };
};
