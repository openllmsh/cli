/**
 * Thin client over the gateway's OpenLLM Memory endpoints.
 *
 * Prefers `/api/integrations/memory/*` and falls back to the legacy
 * `/api/plugins/memory/*` alias so older gateways and installed CLIs
 * keep working. Embedding and scoping live server-side — this client
 * just forwards save/forget/search/match with the caller's API key.
 */

import type { TProjectRef } from "../../memory-hooks/project-ref";
import { MemoryHookFailure } from "../../memory-hooks/transport";
import type { THttpClientOptions } from "../../sdk/client";
import type { PluginConfig } from "./config";

// ── Domain types ──────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  memory: string;
  similarity: number;
  project?: string;
  createdAt?: string;
  team_id?: string | null;
  team_name?: string | null;
  author_user_id?: string | null;
  source?: string | null;
}

export interface SearchResult {
  results: Memory[];
  total: number;
  timing: number;
}

export interface WhoamiResult {
  email: string;
  role: string;
  teams: Array<{ id: string; name: string }>;
}

export interface MatchedTeam {
  id: string;
  slug: string;
  name: string;
}

export interface SaveOptions {
  /** Single project slug — merged with `projects` server-side. */
  project?: string;
  /** Multiple project slugs — chunk surfaces in every named bucket. */
  projects?: string[];
  /** Single team id — merged with `teams` server-side. Caller must be a member. */
  team?: string;
  /** Multiple team ids — chunk is shared with every listed team. */
  teams?: string[];
  /** Project identity for automatic team matching. */
  project_ref?: TProjectRef;
  /** Opaque metadata (e.g. `{ source: "hook" | "tool" }`). */
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  project?: string;
  projects?: string[];
  /** Restricts team-row search to matcher hits for this project. */
  project_ref?: TProjectRef;
}

// ── Client ────────────────────────────────────────────────────────────────

const MEMORY_ROOT_PRIMARY = "/api/integrations/memory";
const MEMORY_ROOT_LEGACY = "/api/plugins/memory";

/** Hook transport throws on non-OK; a 404 is a missing route, not a hard fault. */
const isRouteMissing = (error: unknown): boolean =>
  error instanceof MemoryHookFailure && error.diagnostic.status === 404;

export class MemoryClient {
  private baseUrl: string;
  private apiKey: string;
  /** Cached after the first successful response — prefers the new root. */
  private root: string | null = null;

  constructor(
    config: PluginConfig,
    private readonly options: THttpClientOptions = {},
  ) {
    this.baseUrl = config.gatewayUrl.replace(/\/$/, "");
    this.apiKey = config.gatewayApiKey;
  }

  private async requestOnce(
    method: string,
    path: string,
    body: unknown | undefined,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    });
  }

  private async request<T>(
    method: string,
    action: string,
    body?: unknown,
  ): Promise<T> {
    const roots =
      this.root !== null
        ? [this.root]
        : [MEMORY_ROOT_PRIMARY, MEMORY_ROOT_LEGACY];
    let lastStatus = 0;
    let lastText = "";
    let lastPath = "";
    for (const root of roots) {
      const path = `${root}/${action}`;
      lastPath = path;
      try {
        const res = await this.requestOnce(method, path, body);
        if (res.ok) {
          this.root = root;
          if (res.status === 204) return undefined as unknown as T;
          return (await res.json()) as T;
        }
        lastStatus = res.status;
        lastText = await res.text().catch(() => "");
        // Only fall through to the legacy alias on a missing new route.
        if (res.status !== 404 || root === MEMORY_ROOT_LEGACY) break;
      } catch (error) {
        if (isRouteMissing(error) && root !== MEMORY_ROOT_LEGACY) {
          lastStatus = 404;
          lastText = "";
          continue;
        }
        throw error;
      }
    }
    throw new Error(`${method} ${lastPath} → ${lastStatus}: ${lastText}`);
  }

  /**
   * Cheap personal enablement probe. Hooks call this (cached) before any
   * recall/extract network work.
   *
   * - `200` with `enabled` → that value
   * - `404` on both roots → treat as enabled (older gateway without the probe)
   * - other failures throw (caller fail-opens to skip)
   */
  async isEnabled(): Promise<boolean> {
    const roots =
      this.root !== null
        ? [this.root]
        : [MEMORY_ROOT_PRIMARY, MEMORY_ROOT_LEGACY];
    let sawOnly404 = true;
    for (const root of roots) {
      const path = `${root}/enabled`;
      try {
        const res = await this.requestOnce("GET", path, undefined);
        if (res.ok) {
          this.root = root;
          const body = (await res.json()) as { enabled?: unknown };
          // Only an explicit `false` disables. Missing/unknown fields (and
          // older mocks that return an empty JSON body) stay enabled.
          return body.enabled !== false;
        }
        if (res.status !== 404) {
          sawOnly404 = false;
          const text = await res.text().catch(() => "");
          throw new Error(`GET ${path} → ${res.status}: ${text}`);
        }
      } catch (error) {
        // Hook transport throws MemoryHookFailure on 404 — same as a
        // missing route from an older gateway without the probe.
        if (isRouteMissing(error)) continue;
        throw error;
      }
    }
    if (sawOnly404) return true;
    return false;
  }

  /**
   * Save a memory. The chunk is keyed on (saver email, content) — so
   * re-saving the same content unions the projects/teams server-side
   * without re-embedding. One stored chunk; many destinations expressed as
   * metadata.projects[] + ref overlays.
   */
  async save(
    content: string,
    opts: SaveOptions = {},
  ): Promise<{
    id: string;
    projects: string[];
    teams: string[];
    reused: boolean;
    status: "saved";
  }> {
    if (!content.trim()) throw new Error("content is required");
    const body: Record<string, unknown> = { content };
    if (opts.project) body.project = opts.project;
    if (opts.projects && opts.projects.length > 0)
      body.projects = opts.projects;
    if (opts.team) body.team = opts.team;
    if (opts.teams && opts.teams.length > 0) body.teams = opts.teams;
    if (opts.project_ref) body.project_ref = opts.project_ref;
    if (opts.metadata) body.metadata = opts.metadata;
    return this.request("POST", "save", body);
  }

  /** List the distinct project slugs the caller can read. */
  async listProjects(): Promise<string[]> {
    const res = await this.request<{ projects: string[] }>("GET", "projects");
    return Array.isArray(res?.projects) ? res.projects : [];
  }

  /** Automatic extraction retries must never fuzzy-delete a replacement. */
  async forgetExact(
    content: string,
    opts: SaveOptions = {},
  ): Promise<{ deleted: number }> {
    if (!content.trim()) throw new Error("content is required");
    return this.request("POST", "forget", {
      content,
      ...(opts.project ? { project: opts.project } : {}),
    });
  }

  /**
   * Forget by exact-content hash first, then semantic fallback. Server scopes
   * every delete to the caller's own chunks (team chunks stay put).
   */
  async forget(
    content: string,
    opts: SaveOptions = {},
  ): Promise<{ success: boolean; message: string }> {
    // Exact-content match first (server hashes saver email + content).
    const exact = await this.forgetExact(content, opts);
    if (exact.deleted > 0) {
      return { success: true, message: "Forgot memory (exact match)" };
    }

    // Semantic fallback — scoped to the same project(s).
    const SIM_THRESHOLD = 0.85;
    const search = await this.search(content, 5, {
      project: opts.project,
    });
    const hit = search.results.find((m) => m.similarity >= SIM_THRESHOLD);
    if (!hit) {
      return {
        success: false,
        message: `No matching memory found (exact + semantic search at similarity >= ${SIM_THRESHOLD}).`,
      };
    }
    const byId = await this.request<{ deleted: number }>("POST", "forget", {
      id: hit.id,
    });
    if (byId.deleted === 0) {
      return {
        success: false,
        message:
          "Semantic match belonged to another user or team — cannot forget.",
      };
    }
    return {
      success: true,
      message: `Forgot similar memory (similarity ${hit.similarity.toFixed(2)}): "${hit.memory.slice(0, 100)}"`,
    };
  }

  /** Semantic search — server embeds the query and auto-scopes to the caller's refs. */
  async search(
    query: string,
    limit = 10,
    opts: SearchOptions = {},
  ): Promise<SearchResult> {
    if (!query.trim()) throw new Error("query is required");
    const start = Date.now();
    const body: Record<string, unknown> = { query, limit };
    if (opts.projects && opts.projects.length > 0) {
      body.projects = opts.projects;
    } else if (opts.project) {
      body.project = opts.project;
    }
    if (opts.project_ref) body.project_ref = opts.project_ref;
    const res = await this.request<{
      results: Array<{
        id: string;
        content: string;
        similarity: number;
        project?: string;
        createdAt: string | null;
        team_id?: string | null;
        team_name?: string | null;
        author_user_id?: string | null;
        source?: string | null;
      }>;
    }>("POST", "search", body);
    const results: Memory[] = res.results.map((r) => ({
      id: r.id,
      memory: r.content,
      similarity: r.similarity,
      project: r.project,
      createdAt: r.createdAt ?? undefined,
      team_id: r.team_id,
      team_name: r.team_name,
      author_user_id: r.author_user_id,
      source: r.source,
    }));
    return { results, total: results.length, timing: Date.now() - start };
  }

  /** Deterministic team ↔ project match for automatic bucketing. */
  async match(project_ref: TProjectRef): Promise<{ teams: MatchedTeam[] }> {
    const res = await this.request<{ teams: MatchedTeam[] }>("POST", "match", {
      project_ref,
    });
    return {
      teams: Array.isArray(res?.teams) ? res.teams : [],
    };
  }

  /** Identity lookup — which email/role/teams is this MCP bound to? */
  async whoami(): Promise<WhoamiResult> {
    return this.request<WhoamiResult>("GET", "whoami");
  }
}
