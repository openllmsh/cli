/**
 * CLI-local project identity for automatic team-memory bucketing.
 * Duplicates the remote URL parser from `@openllm/api` — the CLI must not
 * import that package.
 */

import { execFileSync } from "node:child_process";

export type TProjectRef = {
  readonly slug: string;
  readonly remote_owner?: string;
  readonly remote_repo?: string;
};

const normalizeRemotePart = (raw: string): string => raw.trim().toLowerCase();

/**
 * Parse `git remote get-url origin` into owner/repo.
 * Accepts https (with optional userinfo), ssh (`git@host:owner/repo`), and
 * `ssh://` forms. Never returns credentials — userinfo is stripped.
 */
export const parseGitRemoteUrl = (
  raw: string,
): { readonly owner: string; readonly repo: string } | null => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let owner = "";
  let repo = "";

  // URL forms only when `://` is present — `github.com:owner/repo` must not
  // be mistaken for a scheme.
  if (trimmed.includes("://")) {
    try {
      const stripped = trimmed.replace(
        /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i,
        "$1",
      );
      const url = new URL(stripped);
      const parts = url.pathname
        .replace(/^\//, "")
        .replace(/\.git$/i, "")
        .split("/")
        .filter(Boolean);
      if (parts.length >= 2) {
        owner = parts[parts.length - 2] ?? "";
        repo = parts[parts.length - 1] ?? "";
      }
    } catch {
      /* fall through */
    }
  }
  if (!owner || !repo) {
    const sshScp = trimmed.match(
      /^(?:[^@/\s]+@)?([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    );
    if (sshScp) {
      owner = sshScp[2] ?? "";
      repo = sshScp[3] ?? "";
    }
  }

  owner = owner.trim();
  repo = repo.trim().replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  if (owner.includes("@") || repo.includes("@")) return null;
  return {
    owner: normalizeRemotePart(owner),
    repo: normalizeRemotePart(repo),
  };
};

const originCache = new Map<string, string | null>();

const originRemoteUrl = (cwd: string): string | null => {
  const cached = originCache.get(cwd);
  if (cached !== undefined) return cached;
  try {
    const url = execFileSync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const value = url === "" ? null : url;
    originCache.set(cwd, value);
    return value;
  } catch {
    originCache.set(cwd, null);
    return null;
  }
};

/** Build the project_ref the gateway matcher expects. Failures are silent. */
export const buildProjectRef = (cwd: string, slug: string): TProjectRef => {
  const trimmed = slug.trim().toLowerCase();
  const remote = originRemoteUrl(cwd);
  const parsed = remote ? parseGitRemoteUrl(remote) : null;
  return {
    slug: trimmed || "default",
    ...(parsed ? { remote_owner: parsed.owner, remote_repo: parsed.repo } : {}),
  };
};
