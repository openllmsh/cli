/**
 * claude-context tools: index_codebase, search_code, get_indexing_status, clear_index.
 *
 * Identity is derived from git on every invocation:
 *   - codebaseId = normalized `git remote get-url origin` → one collection per repo,
 *     shared across users/machines/checkouts.
 *   - branch     = `git rev-parse --abbrev-ref HEAD`.
 *   - The shared chunk store is overlaid with a per-branch ref in plugin_ref_chunks,
 *     so search results are always scoped to the caller's current branch.
 *
 * File I/O happens here (on the user's machine). Embedding, chunk storage, and
 * overlay state all live on the gateway.
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  chunkFile,
  chunksExists,
  EMBED_BATCH_SIZE,
  fetchOverlay,
  type GatewayConfig,
  gatewayFetch,
  MAX_FILE_BYTES,
  type OverlayEntry,
  type PendingChunk,
  PROGRESS_INTERVAL_MS,
  pushChunks,
  setOverlay,
  collectionName as sharedCollectionName,
} from "./shared/sync";

// ── Code-specific config ──────────────────────────────────────────────────────

// Path prefix for this plugin's gateway routes. Shared sync helpers are
// generic over this so the same code serves the docs-context plugin too.
const PLUGIN_PATH = "/api/plugins/claude-context";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".cc",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".proto",
  ".tf",
  ".hcl",
  ".vue",
  ".svelte",
]);

interface JobUpdate {
  codebaseId: string;
  branch: string;
  collection: string;
  status: "indexing" | "indexed" | "failed";
  percentage?: number;
  head_commit?: string | null;
  error?: string;
  total_files?: number;
  indexed_files?: number;
  total_chunks?: number;
}

async function upsertJob(config: GatewayConfig, job: JobUpdate): Promise<void> {
  await gatewayFetch(config, "POST", `${PLUGIN_PATH}/jobs`, job);
}

// ── Git identity resolution ────────────────────────────────────────────────────

export interface GitIdentity {
  codebaseId: string;
  branch: string;
  headCommit: string;
  isDirty: boolean;
}

function gitCmd(repo: string, args: string[]): string | null {
  try {
    return execSync(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
      cwd: repo,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse a git remote URL into a stable, lowercase `host/org/repo` identifier.
 * Returns null for anything we don't recognize or that doesn't look safe.
 *
 * Examples:
 *   git@github.com:org/repo.git        → github.com/org/repo
 *   https://github.com/org/repo        → github.com/org/repo
 *   https://user@gitlab.com/org/x.git  → gitlab.com/org/x
 *   ssh://git@host:22/~user/repo.git   → host/user/repo
 */
export function normalizeOrigin(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();

  // scp-like: git@host:path  →  host/path
  const scp = s.match(/^[^@:\s]+@([^:\s]+):(.+)$/);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z]+:\/\//i, ""); // strip scheme
    s = s.replace(/^[^@/\s]+@/, ""); // strip user@
  }
  s = s.replace(/:\d+\//, "/"); // strip :port
  s = s.replace(/\.git\/?$/i, "");
  s = s.replace(/\/+$/g, "");
  s = s.replace(/~/g, "");
  s = s.toLowerCase();

  if (!/^[a-z0-9][a-z0-9._/-]{2,199}$/.test(s)) return null;
  return s;
}

export function resolveGitIdentity(absPath: string): GitIdentity | null {
  const insideRepo = gitCmd(absPath, ["rev-parse", "--is-inside-work-tree"]);
  if (insideRepo !== "true") return null;

  const originRaw = gitCmd(absPath, ["remote", "get-url", "origin"]);
  if (!originRaw) return null;
  const codebaseId = normalizeOrigin(originRaw);
  if (!codebaseId) return null;

  const branchRaw = gitCmd(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headCommit = gitCmd(absPath, ["rev-parse", "HEAD"]);
  if (!headCommit) return null;

  let branch = branchRaw ?? "detached";
  if (branch === "HEAD" || branch === "detached") {
    branch = `detached@${headCommit.slice(0, 12)}`;
  }
  if (!/^[A-Za-z0-9_:./@-]{1,128}$/.test(branch)) return null;

  const dirty = gitCmd(absPath, ["status", "--porcelain"]);
  const isDirty = dirty !== null && dirty.length > 0;

  return { codebaseId, branch, headCommit, isDirty };
}

// ── File selection (git-driven) ────────────────────────────────────────────────

/**
 * Files tracked or untracked-but-not-ignored by git. Respects every .gitignore
 * layer, .git/info/exclude, and core.excludesFile — so no custom pattern matcher
 * is needed. `git ls-files` in a parent repo does NOT recurse into submodule
 * contents, which is exactly what we want: the parent owns only its own files,
 * and each submodule is indexed independently under its own codebaseId.
 */
function listTrackedFiles(absPath: string): string[] {
  const out = gitCmd(absPath, ["ls-files", "-co", "--exclude-standard"]);
  if (!out) return [];
  return out
    .split("\n")
    .filter((s) => s.length > 0)
    .filter((f) => SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()));
}

export interface Submodule {
  absPath: string;
  relPath: string;
}

/**
 * Foundry/Forge uses git submodules as its package manager — `lib/forge-std`,
 * `lib/openzeppelin-contracts`, etc. are dependencies, not first-party source.
 * When we see a `foundry.toml` at the repo root, treat every submodule as a
 * vendored dep and don't recurse.
 */
function isDependencyManagedByGitSubmodules(absPath: string): boolean {
  return fs.existsSync(path.join(absPath, "foundry.toml"));
}

/**
 * Parse .gitmodules and return each initialized submodule's checkout path.
 * Uninitialized submodules (missing .git) are skipped silently. Repos that
 * use git submodules as a dependency manager (Foundry) return [] — their
 * submodules are third-party deps and shouldn't be indexed as separate
 * codebases.
 */
export function listSubmodules(absPath: string): Submodule[] {
  if (isDependencyManagedByGitSubmodules(absPath)) return [];
  const raw = gitCmd(absPath, [
    "config",
    "--file",
    ".gitmodules",
    "--get-regexp",
    "path",
  ]);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      // format: "submodule.<name>.path <rel-path>"
      const relPath = line.split(/\s+/)[1];
      if (!relPath) return null;
      const abs = path.join(absPath, relPath);
      if (!fs.existsSync(path.join(abs, ".git"))) return null;
      return { absPath: abs, relPath };
    })
    .filter((s): s is Submodule => s !== null);
}

function sha256File(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`;
}

export interface SearchRef {
  codebaseId: string;
  branch: string;
}

/**
 * Build the ref list for a search at `absPath`: the parent, plus every
 * initialized submodule that has a gateway job row (so we don't issue
 * search requests against codebases the gateway has never heard of).
 *
 * Submodules without an origin remote, or with no job, are skipped.
 * Recurses so submodules-of-submodules are included.
 */
export async function buildSearchRefs(
  config: GatewayConfig,
  absPath: string,
  parentIdentity: GitIdentity,
): Promise<SearchRef[]> {
  const refs: SearchRef[] = [
    { codebaseId: parentIdentity.codebaseId, branch: parentIdentity.branch },
  ];
  const visited = new Set<string>([parentIdentity.codebaseId]);

  const collect = async (root: string): Promise<void> => {
    for (const sm of listSubmodules(root)) {
      const id = resolveGitIdentity(sm.absPath);
      if (!id) continue;
      if (visited.has(id.codebaseId)) continue;
      visited.add(id.codebaseId);

      const res = await gatewayFetch(
        config,
        "GET",
        `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(id.codebaseId)}&branch=${encodeURIComponent(id.branch)}`,
      ).catch(() => null);
      if (res?.ok) {
        refs.push({ codebaseId: id.codebaseId, branch: id.branch });
      }

      await collect(sm.absPath);
    }
  };

  await collect(absPath);
  return refs;
}

// `collectionName` is shared with the docs pipeline — both compute it from a
// SHA-256 of the codebaseId, so the table key stays stable when the same id
// shows up in either plugin's job table. Re-exported here for external callers
// (src/index.ts uses it for signal-handler bookkeeping during a sync).
export const collectionName = sharedCollectionName;

// ── Sync (diff-based indexing) ─────────────────────────────────────────────────

export interface SyncResult {
  shortCircuit: boolean;
  totalChunks: number;
  embeddedChunks: number;
  reusedChunks: number;
  totalFiles: number;
}

export interface SubmoduleSyncReport {
  codebaseId: string;
  branch: string;
  absPath: string;
  relPath: string;
  result?: SyncResult;
  skipped?: string;
  error?: string;
}

/**
 * Hash-carryover sync. Pulls the existing overlay from the gateway, hashes
 * each tracked file once, reuses chunk IDs verbatim for files whose hash
 * matches, and only reads + chunks + embeds files that actually changed.
 * Short-circuits when head_commit matches and the tree is clean.
 */
export async function runSync(
  config: GatewayConfig,
  absPath: string,
  identity: GitIdentity,
): Promise<SyncResult> {
  const { codebaseId, branch, headCommit, isDirty } = identity;
  const collection = collectionName(codebaseId);
  const now = () => Date.now();

  // Short-circuit: head hasn't moved and working tree is clean.
  const existingJob = await gatewayFetch(
    config,
    "GET",
    `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(codebaseId)}&branch=${encodeURIComponent(branch)}`,
  );
  if (existingJob.ok) {
    const job = (await existingJob.json()) as {
      status?: string;
      head_commit?: string | null;
    };
    if (
      job.status === "indexed" &&
      job.head_commit === headCommit &&
      !isDirty
    ) {
      return {
        shortCircuit: true,
        totalChunks: 0,
        embeddedChunks: 0,
        reusedChunks: 0,
        totalFiles: 0,
      };
    }
  }

  async function updateJob(fields: Partial<JobUpdate>): Promise<void> {
    try {
      await upsertJob(config, {
        codebaseId,
        branch,
        collection,
        status: "indexing",
        ...fields,
      });
    } catch {
      // progress updates are best-effort
    }
  }

  // Mark the job live but don't reset percentage/counts — the prior run's
  // numbers stay visible until this run has definitive replacements.
  await updateJob({});

  // Fetch the prior overlay so we can carry unchanged files forward without
  // reading them. Missing overlay (first index) just leaves the map empty.
  const prior = await fetchOverlay(
    config,
    PLUGIN_PATH,
    codebaseId,
    branch,
  ).catch(() => ({
    entries: [] as OverlayEntry[],
    headCommit: null as string | null,
  }));
  const priorByFile = new Map<string, OverlayEntry>();
  for (const e of prior.entries) priorByFile.set(e.filePath, e);

  const relFiles = listTrackedFiles(absPath);

  await updateJob({ total_files: relFiles.length });

  // Partition into (reused-verbatim) vs (needs-chunking). For the reused
  // side: no file read, no chunk+hash. For the changed side: read once, chunk,
  // and stage for the dedupe+embed pipeline.
  const overlayEntries: OverlayEntry[] = [];
  const changedChunks: PendingChunk[] = [];
  let reusedFromHash = 0;
  let indexedFiles = 0;
  let lastHashHeartbeat = now();

  for (let i = 0; i < relFiles.length; i++) {
    const relPath = relFiles[i];
    const filePath = path.join(absPath, relPath);
    const ext = path.extname(relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) continue;

    let fileHash: string;
    try {
      fileHash = sha256File(filePath);
    } catch {
      continue;
    }

    const priorEntry = priorByFile.get(relPath);
    if (
      priorEntry &&
      priorEntry.fileHash === fileHash &&
      priorEntry.chunkIds.length > 0
    ) {
      overlayEntries.push({
        filePath: relPath,
        chunkIds: priorEntry.chunkIds,
        fileHash,
      });
      reusedFromHash += priorEntry.chunkIds.length;
      indexedFiles++;
    } else {
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const chunks = chunkFile(relPath, content, ext);
      if (chunks.length === 0) continue;
      for (const c of chunks) changedChunks.push(c);
      overlayEntries.push({
        filePath: relPath,
        chunkIds: chunks.map((c) => c.id),
        fileHash,
      });
      indexedFiles++;
    }

    // Heartbeat so the gateway's 120s staleness reaper doesn't flip this job
    // to "failed" while we're grinding through a large repo's first sync.
    // Empty payload on purpose — prior run's indexed_files/total_chunks stay
    // visible until we have definitive new values after chunksExists.
    const t = now();
    if (t - lastHashHeartbeat >= PROGRESS_INTERVAL_MS) {
      await updateJob({});
      lastHashHeartbeat = t;
    }
  }

  // Only the chunks from changed files need a dedupe round-trip. Unchanged
  // files carry their overlay entries forward without touching the gateway.
  const existing = await chunksExists(
    config,
    PLUGIN_PATH,
    codebaseId,
    changedChunks.map((c) => c.id),
  );
  const missing = changedChunks.filter((c) => !existing.has(c.id));
  const reusedFromCollection = changedChunks.length - missing.length;
  const totalChunks = reusedFromHash + changedChunks.length;

  // Progress tracks chunk-level work: reused-from-hash + reused-from-collection
  // count as already-done, missing chunks are the remaining work. This means
  // a resumed sync (where a prior run already embedded most chunks and crashed
  // before writing the overlay) will jump to a high starting percentage
  // instead of falling back to 10%.
  const workDoneBefore = reusedFromHash + reusedFromCollection;
  const computePct = (embeddedSoFar: number): number => {
    if (totalChunks === 0) return 100;
    return Math.min(
      99,
      Math.round(((workDoneBefore + embeddedSoFar) / totalChunks) * 100),
    );
  };

  await updateJob({
    indexed_files: indexedFiles,
    total_chunks: totalChunks,
    percentage: computePct(0),
  });

  // Upload missing chunks in batches. The gateway embeds with host-paid
  // Bedrock Titan v2 before insert — the bundle never touches an embedding
  // endpoint, by design.
  let embedded = 0;
  let lastProgress = now();
  for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
    const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
    const docs = batch.map((c) => ({
      id: c.id,
      content: c.content,
      relativePath: c.relativePath,
      startLine: c.startLine,
      endLine: c.endLine,
      fileExtension: c.extension,
      metadata: {},
    }));
    await pushChunks(config, PLUGIN_PATH, codebaseId, docs);
    embedded += batch.length;

    const t = now();
    if (t - lastProgress >= PROGRESS_INTERVAL_MS) {
      await updateJob({ percentage: computePct(embedded) });
      lastProgress = t;
    }
  }

  // Atomically replace the overlay for this (codebase, branch). Files that
  // disappeared from the working tree drop out automatically.
  await setOverlay(config, PLUGIN_PATH, codebaseId, branch, overlayEntries);

  await upsertJob(config, {
    codebaseId,
    branch,
    collection,
    status: "indexed",
    percentage: 100,
    head_commit: headCommit,
    indexed_files: indexedFiles,
    total_chunks: totalChunks,
    total_files: relFiles.length,
  });

  return {
    shortCircuit: false,
    totalChunks,
    embeddedChunks: embedded,
    reusedChunks: reusedFromHash + reusedFromCollection,
    totalFiles: relFiles.length,
  };
}

/**
 * Walk submodules declared in .gitmodules (recursively) and sync each one
 * under its own codebaseId. A submodule shared between parents is embedded
 * exactly once because its codebaseId (its own origin remote) is what keys
 * the collection, not the parent's.
 *
 * Cycles are broken with a visited-set keyed on codebaseId. Submodules
 * without an origin remote are skipped quietly — same rule as the CLI
 * applies to the parent path.
 */
export async function syncSubmodules(
  config: GatewayConfig,
  absPath: string,
  parentCodebaseId: string,
  visited: Set<string>,
  onProgress?: (sm: Submodule, identity: GitIdentity) => void,
): Promise<SubmoduleSyncReport[]> {
  const reports: SubmoduleSyncReport[] = [];
  for (const sm of listSubmodules(absPath)) {
    const identity = resolveGitIdentity(sm.absPath);
    if (!identity) {
      reports.push({
        codebaseId: "",
        branch: "",
        absPath: sm.absPath,
        relPath: sm.relPath,
        skipped: "no origin remote",
      });
      continue;
    }
    if (
      identity.codebaseId === parentCodebaseId ||
      visited.has(identity.codebaseId)
    ) {
      reports.push({
        codebaseId: identity.codebaseId,
        branch: identity.branch,
        absPath: sm.absPath,
        relPath: sm.relPath,
        skipped: "already visited",
      });
      continue;
    }
    visited.add(identity.codebaseId);

    onProgress?.(sm, identity);

    const collection = collectionName(identity.codebaseId);
    try {
      await upsertJob(config, {
        codebaseId: identity.codebaseId,
        branch: identity.branch,
        collection,
        status: "indexing",
        percentage: 0,
      });
      const result = await runSync(config, sm.absPath, identity);
      reports.push({
        codebaseId: identity.codebaseId,
        branch: identity.branch,
        absPath: sm.absPath,
        relPath: sm.relPath,
        result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Flip the job to "failed" now so the UI stops showing a stuck
      // "indexing" bar — otherwise it sits there until the gateway's 120s
      // staleness reaper notices the missing heartbeats.
      await upsertJob(config, {
        codebaseId: identity.codebaseId,
        branch: identity.branch,
        collection,
        status: "failed",
        error: message,
      }).catch(() => {});
      reports.push({
        codebaseId: identity.codebaseId,
        branch: identity.branch,
        absPath: sm.absPath,
        relPath: sm.relPath,
        error: message,
      });
      continue;
    }

    // Recurse — submodules of submodules each get their own index.
    const child = await syncSubmodules(
      config,
      sm.absPath,
      identity.codebaseId,
      visited,
      onProgress,
    );
    reports.push(...child);
  }
  return reports;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const claudeContextToolDefs = [
  {
    name: "index_codebase",
    description:
      "Index a git repository for semantic search. Uses the origin remote as the codebase identity " +
      "(so a repo is indexed once across all users) and overlays a per-branch view of the working " +
      "tree. Unchanged files reuse existing embeddings — only changed content is re-embedded.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the local checkout. Must be inside a git repo with an 'origin' remote.",
        },
        force: {
          type: "boolean",
          description:
            "Force re-sync even if HEAD hasn't moved and the working tree is clean.",
          default: false,
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description:
      "PREFER THIS OVER Grep/Glob for any conceptual codebase question. Semantic search across " +
      "the current branch's working tree via local embeddings — finds code by meaning, not exact " +
      "string match. Results are scoped to the branch overlay (code on other branches won't appear).\n\n" +
      "USE THIS FIRST when:\n" +
      '  • exploring unfamiliar code ("where is auth handled?", "how does X flow work?")\n' +
      "  • the target is a concept, behavior, or pattern, not a known identifier\n" +
      "  • Grep would require you to guess the exact keyword\n" +
      "  • you want related code, not just literal matches\n\n" +
      "Use Grep/Glob INSTEAD when: you already know the exact identifier/string, you need regex, " +
      "or you're filtering by filename pattern.\n\n" +
      "Iterate: if the first query is off, refine and call again. Cheap and fast.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the local checkout.",
        },
        query: {
          type: "string",
          description:
            "Natural language query — describe what the code does, not how it's named.",
        },
        limit: {
          type: "number",
          default: 10,
          maximum: 50,
          description:
            "Top-K matches. Default 10 is usually right; raise to 20-30 for broad exploratory queries.",
        },
      },
      required: ["path", "query"],
    },
  },
  {
    name: "get_indexing_status",
    description:
      "Check indexing progress for the current branch of a codebase.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the local checkout.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "clear_index",
    description:
      "Remove the search index for a codebase. With scope='branch' (default) drops only the current " +
      "branch's overlay. With scope='codebase' drops the entire shared collection — affects all users.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the local checkout.",
        },
        scope: {
          type: "string",
          enum: ["branch", "codebase"],
          default: "branch",
        },
      },
      required: ["path"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

function identityErr(absPath: string): string {
  return (
    `'${absPath}' cannot be indexed: it must be inside a git repository with an 'origin' remote ` +
    `(run 'git remote -v' to check). Collection identity requires a stable upstream URL so the ` +
    `index can be shared across machines.`
  );
}

export async function handleClaudeContextTool(
  name: string,
  args: Record<string, unknown>,
  config: GatewayConfig,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const textRes = (t: string) => ({ content: [{ type: "text", text: t }] });
  const errRes = (t: string) => ({
    content: [{ type: "text", text: t }],
    isError: true,
  });

  switch (name) {
    case "index_codebase": {
      const absPath = args.path as string;
      const force = (args.force as boolean) ?? false;

      if (!absPath || typeof absPath !== "string")
        return errRes("path required");
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
        return errRes(`Path '${absPath}' is not a directory`);
      }

      const identity = resolveGitIdentity(absPath);
      if (!identity) return errRes(identityErr(absPath));

      const collection = collectionName(identity.codebaseId);

      if (force) {
        await gatewayFetch(
          config,
          "DELETE",
          `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
        ).catch(() => {});
      }

      const statusRes = await gatewayFetch(
        config,
        "GET",
        `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
      );
      if (statusRes.ok) {
        const existing = (await statusRes.json()) as { status?: string };
        if (existing.status === "indexing" && !force) {
          return errRes(
            `Already indexing '${identity.codebaseId}@${identity.branch}'. Use force=true to restart.`,
          );
        }
      }

      await upsertJob(config, {
        codebaseId: identity.codebaseId,
        branch: identity.branch,
        collection,
        status: "indexing",
        percentage: 0,
      });

      // Fire-and-forget background indexing — parent first, then submodules
      // each under their own codebaseId.
      (async () => {
        try {
          await runSync(config, absPath, identity);
          const visited = new Set<string>([identity.codebaseId]);
          await syncSubmodules(config, absPath, identity.codebaseId, visited);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(err);
          // Flip the parent job to "failed" so the dashboard surfaces the
          // reason instead of leaving it stuck at "indexing" until the
          // gateway's staleness reaper notices the missing heartbeats. The
          // CLI path and syncSubmodules already do this; the MCP background
          // path used to swallow the error with only console.error.
          await upsertJob(config, {
            codebaseId: identity.codebaseId,
            branch: identity.branch,
            collection,
            status: "failed",
            error: message,
          }).catch(() => {});
        }
      })();

      const smCount = listSubmodules(absPath).length;
      const smNote =
        smCount > 0
          ? ` (+${smCount} submodule${smCount === 1 ? "" : "s"} queued)`
          : "";
      return textRes(
        `Started sync for '${identity.codebaseId}@${identity.branch}'${smNote}. Use get_indexing_status to track progress.`,
      );
    }

    case "search_code": {
      const absPath = args.path as string;
      const query = args.query as string;
      const limit = (args.limit as number) ?? 10;

      if (!absPath) return errRes("path required");
      if (!query) return errRes("query required");

      const identity = resolveGitIdentity(absPath);
      if (!identity) return errRes(identityErr(absPath));

      const refs = await buildSearchRefs(config, absPath, identity);
      const res = await gatewayFetch(
        config,
        "POST",
        "/api/plugins/claude-context/search",
        {
          refs,
          query,
          limit,
        },
      );

      if (res.status === 404) {
        return errRes(
          `'${identity.codebaseId}@${identity.branch}' is not indexed. Run index_codebase first.`,
        );
      }
      if (!res.ok) return errRes(`Search failed: ${res.status}`);

      const data = (await res.json()) as {
        results: Array<{
          document: {
            relativePath: string;
            startLine: number;
            endLine: number;
            content: string;
            fileExtension: string;
          };
          score: number;
        }>;
        indexing: boolean;
      };

      if (data.results.length === 0) {
        const note = data.indexing
          ? " (indexing still in progress — more results may appear later)"
          : "";
        return textRes(`No results found for "${query}"${note}`);
      }

      const formatted = data.results
        .map((r, i) => {
          const lang = r.document.fileExtension.replace(".", "");
          return (
            `${i + 1}. ${r.document.relativePath}:${r.document.startLine}-${r.document.endLine}\n` +
            `\`\`\`${lang}\n${r.document.content}\n\`\`\``
          );
        })
        .join("\n\n");

      const note = data.indexing
        ? "\n\n⚠️ Indexing still in progress — results may be incomplete."
        : "";

      return textRes(
        `Found ${data.results.length} results for "${query}":\n\n${formatted}${note}`,
      );
    }

    case "get_indexing_status": {
      const absPath = args.path as string;
      if (!absPath) return errRes("path required");

      const identity = resolveGitIdentity(absPath);
      if (!identity) return errRes(identityErr(absPath));

      const res = await gatewayFetch(
        config,
        "GET",
        `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
      );

      if (res.status === 404) {
        return textRes(
          `'${identity.codebaseId}@${identity.branch}' is not indexed.`,
        );
      }
      if (!res.ok) return errRes(`Status check failed: ${res.status}`);

      const job = (await res.json()) as {
        status: string;
        percentage: number;
        head_commit?: string | null;
        indexed_files?: number;
        total_files?: number;
        total_chunks?: number;
        error?: string;
        updated_at: number;
      };

      const ago = Math.round((Date.now() - job.updated_at) / 1000);
      const since = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
      const label = `${identity.codebaseId}@${identity.branch}`;

      if (job.status === "indexed") {
        const headMatches = job.head_commit === identity.headCommit;
        const dirtyNote = identity.isDirty
          ? " (working tree dirty — re-sync recommended)"
          : "";
        const driftNote = !headMatches
          ? " (HEAD has moved since last sync — re-sync recommended)"
          : "";
        return textRes(
          `✅ '${label}' is indexed.\n` +
            `Files: ${job.indexed_files ?? "?"} | Chunks: ${job.total_chunks ?? "?"} | Updated ${since}${dirtyNote}${driftNote}`,
        );
      }
      if (job.status === "indexing") {
        const pct = Math.round(job.percentage);
        const progress = job.total_files
          ? ` (${job.indexed_files ?? 0}/${job.total_files} files)`
          : "";
        return textRes(
          `🔄 Indexing in progress: ${pct}%${progress} — last update ${since}`,
        );
      }
      if (job.status === "failed") {
        return textRes(
          `❌ Indexing failed: ${job.error ?? "unknown error"}\nRun index_codebase to retry.`,
        );
      }

      return textRes(`Unknown status: ${job.status}`);
    }

    case "clear_index": {
      const absPath = args.path as string;
      const scope = (args.scope as string) ?? "branch";
      if (!absPath) return errRes("path required");

      const identity = resolveGitIdentity(absPath);
      if (!identity) return errRes(identityErr(absPath));

      const qs =
        scope === "codebase"
          ? `codebaseId=${encodeURIComponent(identity.codebaseId)}`
          : `codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`;

      const res = await gatewayFetch(
        config,
        "DELETE",
        `/api/plugins/claude-context/jobs?${qs}`,
      );
      if (res.status === 404)
        return textRes(`'${identity.codebaseId}' is not indexed.`);
      if (!res.ok) return errRes(`Clear failed: ${res.status}`);

      return textRes(
        scope === "codebase"
          ? `Cleared entire index for '${identity.codebaseId}' (all branches).`
          : `Cleared branch overlay for '${identity.codebaseId}@${identity.branch}'.`,
      );
    }

    default:
      return errRes(`Unknown tool: ${name}`);
  }
}
