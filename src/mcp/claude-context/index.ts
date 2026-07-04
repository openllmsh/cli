#!/usr/bin/env bun

/**
 * Entry point — runs in one of two modes:
 *   - MCP server (no argv)  — stdio MCP protocol, used by Claude Code as an MCP plugin
 *   - CLI (index|search|status subcommand) — used by hooks (session-start, prompt-search)
 *
 * Identity is derived from git on every call (origin remote → codebaseId,
 * HEAD → branch). The CLI silently exits when a path has no origin remote;
 * the MCP tools surface the same condition as an error because the model
 * invoked them explicitly.
 *
 * All state lives in the gateway — no local snapshot files.
 */

import * as fs from "node:fs";
import {
  buildSearchRefs,
  claudeContextToolDefs,
  collectionName,
  handleClaudeContextTool,
  resolveGitIdentity,
  runSync,
  syncSubmodules,
} from "./tools/claude-context";
import {
  deriveDocsBase,
  docsContextToolDefs,
  handleDocsContextTool,
  resolveCanonicalDocsBase,
  runDocsSync,
} from "./tools/docs-context";

// Auto-index fires on every session start. When a sync keeps failing (bad
// creds, a poison file, a down gateway) we must NOT re-attempt on every
// session — that's the "it keeps retrying even though it fails every time"
// loop. After a failure we back off for a cooldown window; a manual `--force`
// always bypasses it. Override with CLAUDE_CONTEXT_RETRY_COOLDOWN_MS (ms).
const FAILED_RETRY_COOLDOWN_MS = ((): number => {
  const raw = Number(process.env.CLAUDE_CONTEXT_RETRY_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60 * 60 * 1000; // 1h default
})();

// ── Gateway credentials ───────────────────────────────────────────────────────

function resolveGatewayConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.GATEWAY_URL || process.env.LLM_GATEWAY_URL;
  const apiKey = process.env.GATEWAY_API_KEY || process.env.LLM_GATEWAY_API_KEY;
  if (!baseUrl || !apiKey) {
    process.stderr.write(
      "[ERR] Missing required env: GATEWAY_URL (or LLM_GATEWAY_URL) and GATEWAY_API_KEY (or LLM_GATEWAY_API_KEY)\n",
    );
    process.exit(1);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const allToolDefs = [...claudeContextToolDefs, ...docsContextToolDefs];

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  config: { baseUrl: string; apiKey: string },
) {
  if (claudeContextToolDefs.some((t) => t.name === name)) {
    return handleClaudeContextTool(name, args, config);
  }
  if (docsContextToolDefs.some((t) => t.name === name)) {
    return handleDocsContextTool(name, args, config);
  }
  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

// ── CLI mode (hooks) ──────────────────────────────────────────────────────────
//
// stdout is machine-readable JSON (piped through jq by hooks).
// stderr carries progress / debug.

async function runCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  const args: Record<string, string | number | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--path") args.path = argv[++i];
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--query") args.query = argv[++i];
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--force") args.force = true;
  }

  const config = resolveGatewayConfig();
  const log = (m: string) => process.stderr.write(`[cli] ${m}\n`);
  const emit = (obj: unknown) =>
    process.stdout.write(`${JSON.stringify(obj)}\n`);

  // The index-docs subcommand is its own short path: hook hands us a URL,
  // we run a one-shot sync against the docs-context plugin, exit. No git
  // identity needed, so we branch out before the path-required guard below.
  if (sub === "index-docs") {
    const url = String(args.url ?? "");
    if (!url) {
      log("index-docs: --url required");
      process.exit(1);
    }
    const rawBase = deriveDocsBase(url);
    if (!rawBase) {
      log(`index-docs: '${url}' is not a recognizable docs URL — skipping`);
      process.exit(0);
    }
    // Canonicalize the identity (redirect + <link rel=canonical>) so a docs
    // site reachable from two domains is indexed once, not once per domain.
    const base = await resolveCanonicalDocsBase(rawBase);

    if (args.force) {
      await fetch(
        `${config.baseUrl}/api/plugins/docs-context/jobs?sourceId=${encodeURIComponent(base.sourceId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${config.apiKey}` },
        },
      ).catch(() => {});
    } else {
      const existing = await gatewayGet(
        config,
        `/api/plugins/docs-context/jobs?sourceId=${encodeURIComponent(base.sourceId)}&ref=latest`,
      );
      if (existing.ok) {
        const job = (await existing.json()) as {
          status: string;
          updated_at?: number;
          error?: string;
        };
        if (job.status === "indexing") {
          emit({
            skipped: true,
            reason: "already_indexing",
            sourceId: base.sourceId,
          });
          return;
        }
        if (job.status === "indexed") {
          // Already indexed and clean — short-circuit so the hook doesn't
          // re-crawl on every prompt that mentions the same URL.
          emit({
            skipped: true,
            reason: "already_indexed",
            sourceId: base.sourceId,
          });
          return;
        }
        if (job.status === "failed") {
          const age = Date.now() - (job.updated_at ?? 0);
          if (age < FAILED_RETRY_COOLDOWN_MS) {
            log(
              `last docs sync failed ${Math.round(age / 60000)}m ago (${job.error ?? "unknown"}); ` +
                `within ${Math.round(FAILED_RETRY_COOLDOWN_MS / 60000)}m cooldown — skipping (use --force to retry now)`,
            );
            emit({
              skipped: true,
              reason: "failed_cooldown",
              sourceId: base.sourceId,
              error: job.error ?? null,
            });
            return;
          }
        }
      }
    }

    log(`docs sync ${base.sourceId} (base ${base.baseUrl})`);
    try {
      const result = await runDocsSync(config, base);
      log(
        `synced ${base.sourceId}: ${result.embeddedChunks} embedded, ${result.reusedChunks} reused, ${result.totalPages} pages`,
      );
      emit({ done: true, sourceId: base.sourceId, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await fetch(`${config.baseUrl}/api/plugins/docs-context/jobs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceId: base.sourceId,
          ref: "latest",
          collection: collectionName(base.sourceId),
          baseUrl: base.baseUrl,
          status: "failed",
          error: msg,
        }),
      }).catch(() => {});
      emit({ error: msg });
      process.exit(1);
    }
    return;
  }

  if (!args.path) {
    log(`${sub}: --path required`);
    process.exit(1);
  }
  const absPath = String(args.path);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    log(`${sub}: '${absPath}' is not a directory`);
    process.exit(1);
  }

  // Resolve identity once up front. No origin → silent exit for every subcommand;
  // hooks must never block on this or emit noise when run in a non-git repo.
  const identity = resolveGitIdentity(absPath);
  if (!identity) {
    log(
      `${absPath}: no git origin remote — skipping (shared index requires a stable upstream URL)`,
    );
    if (sub === "search") process.exit(2); // prompt-search.sh treats 2 as not-indexed / silent
    process.exit(0);
  }

  try {
    if (sub === "index") {
      log(
        `sync ${identity.codebaseId}@${identity.branch} (head ${identity.headCommit.slice(0, 8)}${identity.isDirty ? ", dirty" : ""})`,
      );

      if (args.force) {
        await fetch(
          `${config.baseUrl}/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${config.apiKey}` },
          },
        ).catch(() => {});
      } else {
        const existing = await gatewayGet(
          config,
          `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
        );
        if (existing.ok) {
          const job = (await existing.json()) as {
            status: string;
            updated_at?: number;
            error?: string;
          };
          if (job.status === "indexing") {
            emit({ skipped: true, reason: "already_indexing" });
            return;
          }
          if (job.status === "failed") {
            const age = Date.now() - (job.updated_at ?? 0);
            if (age < FAILED_RETRY_COOLDOWN_MS) {
              log(
                `last sync failed ${Math.round(age / 60000)}m ago (${job.error ?? "unknown"}); ` +
                  `within ${Math.round(FAILED_RETRY_COOLDOWN_MS / 60000)}m cooldown — skipping (use --force to retry now)`,
              );
              emit({
                skipped: true,
                reason: "failed_cooldown",
                error: job.error ?? null,
              });
              return;
            }
          }
        }
      }

      // Signal handlers: flip the job to "failed" on clean termination so the
      // next run isn't blocked waiting for the gateway's staleness reaper.
      const collection = collectionName(identity.codebaseId);
      let interrupted = false;
      const markFailed = (reason: string): void => {
        if (interrupted) return;
        interrupted = true;
        gatewayPost(config, "/api/plugins/claude-context/jobs", {
          codebaseId: identity.codebaseId,
          branch: identity.branch,
          collection,
          status: "failed",
          error: reason,
        })
          .catch(() => {})
          .finally(() => process.exit(130));
      };
      const onSignal = (sig: NodeJS.Signals): void =>
        markFailed(`interrupted by ${sig}`);
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);

      try {
        const result = await runSync(config, absPath, identity);
        if (result.shortCircuit) {
          log(
            `up-to-date (head ${identity.headCommit.slice(0, 8)}) — skipping`,
          );
        } else {
          log(
            `synced ${identity.codebaseId}@${identity.branch}: ` +
              `${result.embeddedChunks} embedded, ${result.reusedChunks} reused, ${result.totalFiles} files`,
          );
        }

        // Cascade into submodules so each gets its own codebaseId/collection.
        // A submodule shared by multiple parents is embedded exactly once.
        const visited = new Set<string>([identity.codebaseId]);
        const submoduleReports = await syncSubmodules(
          config,
          absPath,
          identity.codebaseId,
          visited,
          (sm, smIdentity) =>
            log(
              `sync ${smIdentity.codebaseId}@${smIdentity.branch} (submodule at ${sm.relPath}, head ${smIdentity.headCommit.slice(0, 8)}${smIdentity.isDirty ? ", dirty" : ""})`,
            ),
        );
        for (const r of submoduleReports) {
          if (r.skipped) {
            log(`  skipped submodule ${r.relPath}: ${r.skipped}`);
          } else if (r.error) {
            log(`  submodule ${r.relPath} failed: ${r.error}`);
          } else if (r.result) {
            if (r.result.shortCircuit) {
              log(`  submodule ${r.codebaseId}@${r.branch} up-to-date`);
            } else {
              log(
                `  submodule ${r.codebaseId}@${r.branch}: ` +
                  `${r.result.embeddedChunks} embedded, ${r.result.reusedChunks} reused, ${r.result.totalFiles} files`,
              );
            }
          }
        }

        if (result.shortCircuit) {
          emit({
            done: true,
            shortCircuit: true,
            submodules: submoduleReports,
          });
        } else {
          emit({ done: true, ...result, submodules: submoduleReports });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Flip the parent job to "failed" so the UI doesn't sit on a stale
        // "indexing" bar waiting for the 120s heartbeat reaper.
        await gatewayPost(config, "/api/plugins/claude-context/jobs", {
          codebaseId: identity.codebaseId,
          branch: identity.branch,
          collection,
          status: "failed",
          error: message,
        }).catch(() => {});
        emit({ error: message });
        process.exit(1);
      }
      return;
    }

    if (sub === "search") {
      if (!args.query) {
        log("search: --query required");
        process.exit(1);
      }

      // Check parent job exists first — hook expects exit 2 when not indexed.
      const statusRes = await gatewayGet(
        config,
        `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
      );
      if (statusRes.status === 404) {
        log(`search: '${identity.codebaseId}@${identity.branch}' not indexed`);
        process.exit(2);
      }

      // Fan out across parent + any indexed submodules.
      const refs = await buildSearchRefs(config, absPath, identity);
      const searchRes = await gatewayPost(
        config,
        "/api/plugins/claude-context/search",
        {
          refs,
          query: args.query,
          limit: args.limit ?? 5,
        },
      );
      if (!searchRes.ok) {
        log(`search: gateway returned ${searchRes.status}`);
        process.exit(2);
      }
      const data = (await searchRes.json()) as {
        results: Array<{
          document: {
            content: string;
            relativePath: string;
            startLine: number;
            endLine: number;
            fileExtension: string;
          };
          score: number;
        }>;
      };
      emit({
        results: data.results.map((r) => ({
          relativePath: r.document.relativePath,
          startLine: r.document.startLine,
          endLine: r.document.endLine,
          language: r.document.fileExtension.replace(/^\./, ""),
          score: r.score,
          content: r.document.content,
        })),
      });
      return;
    }

    if (sub === "status") {
      const res = await gatewayGet(
        config,
        `/api/plugins/claude-context/jobs?codebaseId=${encodeURIComponent(identity.codebaseId)}&branch=${encodeURIComponent(identity.branch)}`,
      );
      if (res.status === 404) {
        emit({ status: "not_found" });
        return;
      }
      emit(await res.json());
      return;
    }

    process.stderr.write(
      `Usage: bun src/index.ts {index|search|status} --path P [--query Q] [--limit N] [--force]\n`,
    );
    process.exit(1);
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function gatewayGet(
  config: { baseUrl: string; apiKey: string },
  path: string,
): Promise<Response> {
  return fetch(`${config.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
}

async function gatewayPost(
  config: { baseUrl: string; apiKey: string },
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// ── Composition exports ───────────────────────────────────────────────────────
//
// This module no longer self-executes: the ONE `openllmc` entry
// (`src/main.ts`) owns dispatch — `openllmc mcp` composes the tool group
// below into the unified server (`../server.ts`), and `openllmc ctx …`
// forwards the hook subcommands to `runClaudeContextCli`.

// `collectionName` intentionally re-exported so downstream scripts can still
// derive the shared collection from a codebaseId without reaching into tools/.
void collectionName;

/** Hook subcommands this group serves (`openllmc ctx <sub> …`). */
export const CLAUDE_CONTEXT_CLI_SUBCOMMANDS = [
  "index",
  "search",
  "status",
  "index-docs",
] as const;

/** The composed tool defs (code + docs pipelines — one group). */
export const claudeContextGroupToolDefs = allToolDefs;

/** Dispatch one tool call from the unified MCP server. */
export const handleClaudeContextGroupTool = (
  name: string,
  args: Record<string, unknown>,
  config: { baseUrl: string; apiKey: string },
): ReturnType<typeof dispatchTool> => dispatchTool(name, args, config);

/** Whether a tool name belongs to this group. */
export const isClaudeContextGroupTool = (name: string): boolean =>
  allToolDefs.some((t) => t.name === name);

/** Run the hook-facing CLI (`index` / `search` / `status` / `index-docs`). */
export const runClaudeContextCli = (argv: string[]): Promise<void> =>
  runCli(argv);
