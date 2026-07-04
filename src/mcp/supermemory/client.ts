/**
 * Thin client over the gateway's /api/plugins/supermemory/* endpoints.
 *
 * Embedding, ref-overlay scoping, and collection bootstrap all live server-side
 * now — this client just forwards save/forget/search calls with the caller's
 * API key.
 */

import type { PluginConfig } from "./config";

// ── Domain types ──────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  memory: string;
  similarity: number;
  project?: string;
  createdAt?: string;
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

export interface SaveOptions {
  /** Single project slug — merged with `projects` server-side. */
  project?: string;
  /** Multiple project slugs — chunk surfaces in every named bucket. */
  projects?: string[];
  /** Single team id — merged with `teams` server-side. Caller must be a member. */
  team?: string;
  /** Multiple team ids — chunk is shared with every listed team. */
  teams?: string[];
}

export interface SearchOptions {
  project?: string;
  projects?: string[];
}

// ── Client ────────────────────────────────────────────────────────────────

export class MemoryClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: PluginConfig) {
    this.baseUrl = config.gatewayUrl.replace(/\/$/, "");
    this.apiKey = config.gatewayApiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
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
    return this.request("POST", "/api/plugins/supermemory/save", body);
  }

  /** List the distinct project slugs the caller can read. */
  async listProjects(): Promise<string[]> {
    const res = await this.request<{ projects: string[] }>(
      "GET",
      "/api/plugins/supermemory/projects",
    );
    return Array.isArray(res?.projects) ? res.projects : [];
  }

  /**
   * Forget by exact-content hash first, then semantic fallback. Server scopes
   * every delete to the caller's own chunks (team chunks stay put).
   */
  async forget(
    content: string,
    opts: SaveOptions = {},
  ): Promise<{ success: boolean; message: string }> {
    if (!content.trim()) throw new Error("content is required");

    // Exact-content match first (server hashes (project, content) → same id).
    const exact = await this.request<{ deleted: number }>(
      "POST",
      "/api/plugins/supermemory/forget",
      {
        content,
        ...(opts.project ? { project: opts.project } : {}),
      },
    );
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
    const byId = await this.request<{ deleted: number }>(
      "POST",
      "/api/plugins/supermemory/forget",
      { id: hit.id },
    );
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
    const res = await this.request<{
      results: Array<{
        id: string;
        content: string;
        similarity: number;
        project?: string;
        createdAt: string | null;
      }>;
    }>("POST", "/api/plugins/supermemory/search", body);
    const results: Memory[] = res.results.map((r) => ({
      id: r.id,
      memory: r.content,
      similarity: r.similarity,
      project: r.project,
      createdAt: r.createdAt ?? undefined,
    }));
    return { results, total: results.length, timing: Date.now() - start };
  }

  /** Identity lookup — which email/role/teams is this MCP bound to? */
  async whoami(): Promise<WhoamiResult> {
    return this.request<WhoamiResult>("GET", "/api/plugins/supermemory/whoami");
  }
}
