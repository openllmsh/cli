/**
 * Shared client-side sync helpers used by both `claude-context` (code) and
 * `docs-context` (documentation) tool modules.
 *
 * Pure extraction from tools/claude-context.ts — every helper here was previously
 * defined inline there. The only addition is a `pluginPath` parameter on the
 * gateway calls so the same code talks to /api/plugins/claude-context/* OR
 * /api/plugins/docs-context/* depending on the caller. Behaviour is otherwise
 * identical.
 */

import * as crypto from "node:crypto";

// ── Shared config ─────────────────────────────────────────────────────────────

export const CHUNK_LINES = 150;
export const CHUNK_OVERLAP = 30;
export const MAX_CHUNK_CHARS = 7500;
// Chunks per `POST /chunks` request. Each request triggers a server-side
// Bedrock Titan v2 batch on the gateway (host-paid). Keep at 32 to match
// the historical pacing — progress updates fire between batches.
export const EMBED_BATCH_SIZE = 32;
export const EXISTS_BATCH_SIZE = 800;
export const PROGRESS_INTERVAL_MS = 2000;
export const MAX_FILE_BYTES = 512 * 1024;

// ── Gateway client ────────────────────────────────────────────────────────────

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Path prefix for the plugin's HTTP routes — e.g. "/api/plugins/claude-context"
 * or "/api/plugins/docs-context". Passed alongside GatewayConfig so the same
 * helpers can target either pipeline without duplication.
 */
export type PluginPath = string;

export async function gatewayFetch(
  config: GatewayConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Chunk lifecycle (exists / push / overlay) ────────────────────────────────
//
// Embedding runs entirely on the gateway. The bundle ships raw text +
// metadata via `pushChunks`; the gateway batches and calls Bedrock Titan
// v2 with the host's AWS credentials. The bundle has no access to a
// host-paid embedding endpoint, by design.

export async function chunksExists(
  config: GatewayConfig,
  pluginPath: PluginPath,
  codebaseId: string,
  chunkIds: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let i = 0; i < chunkIds.length; i += EXISTS_BATCH_SIZE) {
    const slice = chunkIds.slice(i, i + EXISTS_BATCH_SIZE);
    const res = await gatewayFetch(
      config,
      "POST",
      `${pluginPath}/chunks/exists`,
      {
        codebaseId,
        chunkIds: slice,
      },
    );
    if (!res.ok) continue;
    const data = (await res.json()) as { existing: string[] };
    for (const id of data.existing ?? []) existing.add(id);
  }
  return existing;
}

export interface PushDocument {
  id: string;
  content: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  fileExtension: string;
  metadata: Record<string, unknown>;
}

// Transient gateway/upstream statuses worth retrying. 4xx other than these
// won't change on retry (bad request, auth) so they throw immediately. 409
// is a deliberate "job_cancelled" stop signal — never retried.
const PUSH_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const PUSH_MAX_ATTEMPTS = 3;
const PUSH_RETRY_BASE_DELAY_MS = 500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upload one batch of pre-chunked documents to the gateway, which embeds
 * them server-side. Retries transient failures (network throw or a
 * retryable status) with backoff so a single blip mid-sync doesn't discard
 * all prior progress; a persistent failure still throws so the caller flips
 * the job to "failed" with the reason.
 */
export async function pushChunks(
  config: GatewayConfig,
  pluginPath: PluginPath,
  codebaseId: string,
  documents: PushDocument[],
): Promise<void> {
  if (documents.length === 0) return;
  let lastErr = "";
  for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await gatewayFetch(config, "POST", `${pluginPath}/chunks`, {
        codebaseId,
        documents,
      });
    } catch (err) {
      lastErr = `Chunk push request failed: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < PUSH_MAX_ATTEMPTS) {
        await delay(PUSH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(lastErr);
    }
    if (res.ok) return;
    const msg = await res.text().catch(() => "");
    lastErr = `Chunk push error ${res.status}: ${msg}`;
    if (
      attempt < PUSH_MAX_ATTEMPTS &&
      PUSH_RETRYABLE_STATUSES.has(res.status)
    ) {
      await delay(PUSH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

export interface OverlayEntry {
  filePath: string;
  chunkIds: string[];
  fileHash?: string;
}

export async function setOverlay(
  config: GatewayConfig,
  pluginPath: PluginPath,
  codebaseId: string,
  branch: string,
  entries: OverlayEntry[],
): Promise<void> {
  const res = await gatewayFetch(config, "POST", `${pluginPath}/overlay`, {
    codebaseId,
    branch,
    entries,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Overlay update failed ${res.status}: ${msg}`);
  }
}

export async function fetchOverlay(
  config: GatewayConfig,
  pluginPath: PluginPath,
  codebaseId: string,
  branch: string,
): Promise<{ entries: OverlayEntry[]; headCommit: string | null }> {
  const res = await gatewayFetch(
    config,
    "GET",
    `${pluginPath}/overlay?codebaseId=${encodeURIComponent(codebaseId)}&branch=${encodeURIComponent(branch)}`,
  );
  if (res.status === 404) return { entries: [], headCommit: null };
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Overlay fetch failed ${res.status}: ${msg}`);
  }
  const data = (await res.json()) as {
    entries: OverlayEntry[];
    headCommit: string | null;
  };
  return { entries: data.entries ?? [], headCommit: data.headCommit ?? null };
}

// ── Collection naming + chunking ──────────────────────────────────────────────

export function collectionName(codebaseId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(codebaseId)
    .digest("hex")
    .slice(0, 16);
  return `code_chunks_${hash}`;
}

export interface PendingChunk {
  id: string;
  content: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  extension: string;
}

export function chunkFile(
  relPath: string,
  content: string,
  ext: string,
): PendingChunk[] {
  const lines = content.split("\n");
  const chunks: PendingChunk[] = [];

  const pushChunk = (
    startLine: number,
    endLine: number,
    text: string,
    charOffset: number,
  ): void => {
    const idInput =
      charOffset === 0
        ? `${relPath}|${startLine}|${text}`
        : `${relPath}|${startLine}|co${charOffset}|${text}`;
    const id = crypto
      .createHash("sha256")
      .update(idInput)
      .digest("hex")
      .slice(0, 32);
    chunks.push({
      id,
      content: text,
      relativePath: relPath,
      startLine,
      endLine,
      extension: ext,
    });
  };

  const emit = (start: number, end: number): void => {
    const text = lines.slice(start, end).join("\n");
    if (text.trim().length === 0) return;

    if (text.length <= MAX_CHUNK_CHARS) {
      pushChunk(start + 1, end, text, 0);
      return;
    }

    if (end - start > 1) {
      const mid = Math.floor((start + end) / 2);
      emit(start, mid);
      emit(mid, end);
      return;
    }

    for (let off = 0; off < text.length; off += MAX_CHUNK_CHARS) {
      const sub = text.slice(off, off + MAX_CHUNK_CHARS);
      if (sub.trim().length === 0) continue;
      pushChunk(start + 1, end, sub, off);
    }
  };

  for (
    let start = 0;
    start < lines.length;
    start += CHUNK_LINES - CHUNK_OVERLAP
  ) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    emit(start, end);
    if (end >= lines.length) break;
  }
  return chunks;
}
