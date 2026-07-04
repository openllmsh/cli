/**
 * docs-context tools: index_docs, search_docs, get_docs_indexing_status, clear_docs_index.
 *
 * Documentation indexing pipeline that runs in parallel to claude-context:
 *
 *   crawl base URL (BFS, same-origin, prefix-matched, page cap)
 *     → cheerio: strip nav/footer/script/style, extract content + links
 *     → turndown: HTML → Markdown
 *     → sha256(markdown): skip pages whose hash matches the prior overlay
 *     → chunkFile(urlPath, markdown, ".md")  // shared with code pipeline
 *     → POST /api/plugins/docs-context/chunks  (same shared helpers)
 *     → POST /api/plugins/docs-context/overlay
 *
 * The chunk store + ref overlays + embedding model are all shared with the
 * code pipeline (they're content-agnostic). What's unique here is the
 * crawl + transform front-end and the docs identity model.
 */

import * as crypto from "node:crypto";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import {
  chunkFile,
  chunksExists,
  collectionName,
  EMBED_BATCH_SIZE,
  fetchOverlay,
  type GatewayConfig,
  gatewayFetch,
  type OverlayEntry,
  type PendingChunk,
  PROGRESS_INTERVAL_MS,
  pushChunks,
  setOverlay,
} from "./shared/sync";

const PLUGIN_PATH = "/api/plugins/docs-context";
const DEFAULT_REF = "latest";

// ── Crawl knobs ───────────────────────────────────────────────────────────────

const MAX_PAGES = 200;
const MAX_DEPTH = 4;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const USER_AGENT =
  "litellm-docs-context/1.0 (+https://github.com/0xxmemo/litellmctl)";

// Path tokens that indicate "this URL points at documentation". When the URL
// the user mentioned has one of these as its first path segment, the crawl
// scope is narrowed to that prefix; otherwise it's origin-scoped.
const DOC_PATH_TOKENS = new Set([
  "docs",
  "doc",
  "developers",
  "developer",
  "api",
  "reference",
  "guide",
  "guides",
  "learn",
  "manual",
  "handbook",
  "tutorial",
  "tutorials",
  "wiki",
  "help",
  "getting-started",
  "quickstart",
]);

// Cheerio selectors stripped before HTML→Markdown so chrome doesn't poison the
// embedding signal. A lot of docs sites have a sidebar with the full nav on
// every page — without this you embed the same nav 200 times.
const STRIP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "nav",
  "header",
  "footer",
  "aside",
  "[role=navigation]",
  "[role=banner]",
  "[role=contentinfo]",
  ".navigation",
  ".sidebar",
  ".menu",
  ".toc",
  ".breadcrumb",
  ".header",
  ".footer",
  ".nav",
  ".site-header",
  ".site-footer",
  // Framework-specific chrome — confirmed by probing real sites.
  ".VPNav",
  ".VPLocalNav",
  ".VPSidebar", // VitePress
  ".navbar",
  ".theme-doc-sidebar-container", // Docusaurus
  ".md-header",
  ".md-tabs",
  ".md-sidebar", // MkDocs Material
  ".sphinxsidebar",
  "[role=search]", // Sphinx
  ".nextra-nav-container",
  ".nextra-sidebar-container", // Nextra
  "[class*=DocSearch]",
  "[class*=algolia]", // Algolia search bars
  "[data-testid=page.search]",
  ".search-bar", // Generic search
];

// Ordered content-root selectors — first hit wins. Listed in rough specificity
// order so framework-specific containers beat generic <main>/<article>. The
// Mintlify entries (#content-area / #content) come first because Bun, Mintlify
// themselves, and many SaaS dev-tools use Mintlify and don't expose a clean
// <main> tag.
const CONTENT_SELECTORS = [
  "#content-area", // Mintlify
  ".VPDoc",
  ".vp-doc", // VitePress (Bun, Vue, Vite)
  ".theme-doc-markdown", // Docusaurus
  ".md-content",
  "article.md-content__inner", // MkDocs Material
  '[itemprop="articleBody"]',
  ".document", // Sphinx (Python, RTD)
  ".nextra-content",
  "main.nextra-content", // Nextra
  ".docMainContainer",
  "[class*=docMainContainer]", // Docusaurus alt
  ".prose", // Tailwind-typography docs
  "main",
  "article",
  "[role=main]", // Standard semantic HTML
  ".content",
  ".main",
  ".docs-content",
  "#content", // Generic fallbacks
].join(", ");

// File extensions we never crawl — they're either binary or non-documentation.
const SKIP_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".mp4",
  ".mp3",
  ".wav",
  ".webm",
  ".mov",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".css",
  ".js",
  ".mjs",
  ".map",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".xml",
  ".rss",
  ".atom",
]);

// ── URL normalization ─────────────────────────────────────────────────────────

export interface DocsBase {
  baseUrl: string; // canonical "https://host[/prefix]" with no trailing slash
  origin: string; // "https://host"
  pathPrefix: string; // "/prefix" or "" (empty for origin-only)
  sourceId: string; // "docs:host[/prefix]"
}

/**
 * Derive the canonical base URL + codebase id from any user-mentioned URL.
 * Returns null for URLs that don't make sense to index (file hosts, raw
 * binaries, etc.).
 */
export function deriveDocsBase(rawUrl: string): DocsBase | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.host.toLowerCase();
  // Skip clearly-not-docs hosts. These are excluded even when explicitly
  // invoked because crawling them never produces useful docs context.
  const blockedHosts = [
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "gist.github.com",
    "pastebin.com",
  ];
  if (blockedHosts.includes(host)) return null;

  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  const firstSegment = segments[0]?.toLowerCase() ?? "";
  const useFirstSegment =
    firstSegment.length > 0 && DOC_PATH_TOKENS.has(firstSegment);

  const pathPrefix = useFirstSegment ? `/${segments[0]}` : "";
  const origin = `${parsed.protocol}//${host}`;
  const baseUrl = origin + pathPrefix;
  // source_id format must satisfy the gateway's SOURCE_ID_RE and start with
  // "docs:" so it lives in its own namespace, distinct from the code plugin's
  // git-origin codebase ids.
  const idPath = useFirstSegment ? `/${segments[0].toLowerCase()}` : "";
  const sourceId = `docs:${host}${idPath}`;

  return { baseUrl, origin, pathPrefix, sourceId };
}

/**
 * Collapse two domains that point at the same docs site to one identity, so
 * the same content isn't indexed twice (e.g. a `bun.sh`→`bun.com` rebrand, a
 * `www`/apex pair, or a DNS mirror). Resolves the canonical *origin* from the
 * two authoritative signals — the HTTP redirect target and a
 * `<link rel="canonical">` tag — then re-derives the base against that origin
 * while keeping the caller's path prefix. Only the host changes; scope is
 * preserved. Best-effort: any failure (site down, no signal) falls back to the
 * literal base, so this never regresses the existing behavior.
 */
export async function resolveCanonicalDocsBase(
  base: DocsBase,
): Promise<DocsBase> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(base.baseUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return base;
    }

    // 1. The redirect target host wins over the requested host.
    let canonicalOrigin: string;
    try {
      canonicalOrigin = new URL(res.url || base.baseUrl).origin;
    } catch {
      canonicalOrigin = base.origin;
    }

    // 2. A <link rel="canonical"> beats the redirect target — mirror domains
    //    that serve 200 without redirecting advertise their home this way.
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("html")) {
      const html = await res.text().catch(() => "");
      if (html) {
        const href = cheerio
          .load(html)('link[rel="canonical"]')
          .first()
          .attr("href");
        if (href) {
          try {
            canonicalOrigin = new URL(href, res.url || base.baseUrl).origin;
          } catch {
            // ignore a malformed canonical href
          }
        }
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }

    if (canonicalOrigin.toLowerCase() === base.origin.toLowerCase()) {
      return base;
    }
    const canon = deriveDocsBase(canonicalOrigin + base.pathPrefix);
    return canon ?? base;
  } catch {
    return base;
  } finally {
    clearTimeout(t);
  }
}

function normalizeLink(href: string, pageUrl: string): string | null {
  try {
    const u = new URL(href, pageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Strip query strings — most docs sites don't vary content by query and
    // including them would multiply page count for trivially-different URLs.
    // If a site genuinely needs them, the search results still surface the
    // canonical path.
    u.search = "";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

function urlPathFor(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    let path = u.pathname || "/";
    if (path !== "/" && path.endsWith("/")) path = path.slice(0, -1);
    return `${u.host}${path}`;
  } catch {
    return rawUrl;
  }
}

// ── Crawl ─────────────────────────────────────────────────────────────────────

interface CrawledPage {
  url: string;
  urlPath: string;
  markdown: string;
  hash: string;
  title: string;
}

async function fetchPage(
  url: string,
): Promise<{ html: string; finalUrl: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("html")) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_PAGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const html = new TextDecoder().decode(
      Buffer.concat(chunks.map((c) => Buffer.from(c))),
    );
    return { html, finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractContentAndLinks(
  html: string,
  pageUrl: string,
  base: DocsBase,
  aliasOrigins: Set<string>,
): { markdown: string; title: string; links: string[] } {
  const $ = cheerio.load(html);
  const title =
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    pageUrl;

  // Collect links BEFORE stripping nav/sidebar — those are usually where the
  // BFS frontier lives. We just don't want them in the embedded text.
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const norm = normalizeLink(href, pageUrl);
    if (!norm) return;
    // Accept any of the origins discovered via sitemap (handles bun.sh→bun.com
    // style domain rebrands where both hosts serve the same docs).
    let inAnyOrigin = false;
    for (const origin of aliasOrigins) {
      if (norm.startsWith(origin)) {
        inAnyOrigin = true;
        break;
      }
    }
    if (!inAnyOrigin) return;
    if (base.pathPrefix && !new URL(norm).pathname.startsWith(base.pathPrefix))
      return;
    const ext = norm.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
    if (ext && SKIP_EXTENSIONS.has(ext)) return;
    links.add(norm);
  });

  for (const sel of STRIP_SELECTORS) $(sel).remove();
  const main = $(CONTENT_SELECTORS).first();
  const html2 = (main.length > 0 ? main : $("body")).html() ?? "";

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  td.remove(["script", "style"]);
  let markdown = td.turndown(html2);
  // Collapse runs of blank lines so the chunker's line counts stay honest.
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  return { markdown, title, links: Array.from(links) };
}

// ── Sitemap discovery ────────────────────────────────────────────────────────
//
// Most modern docs frameworks (Docusaurus, VitePress, MkDocs, Mintlify, Nextra,
// Astro Starlight) publish a sitemap.xml. Pulling it gives us the canonical
// list of pages without relying on link discovery, which can miss orphan pages
// reachable only from search/filter widgets. We treat sitemap URLs as a SEED
// for the BFS queue, not a replacement — pages without sitemap entries still
// get picked up via link extraction.

const SITEMAP_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/docs/sitemap.xml",
];

async function fetchSitemapUrls(
  base: DocsBase,
): Promise<{ urls: string[]; aliasOrigins: Set<string> }> {
  const seen = new Set<string>();
  // raw URLs we'd accept under "strict" scope (same origin), all URLs grouped
  // by origin so we can detect domain-redirect sitemaps (e.g., bun.sh's
  // sitemap lists bun.com URLs after the project rebranded).
  const collected = new Map<string, string[]>();

  const tryFetch = async (url: string, depth: number): Promise<void> => {
    if (depth > 2 || seen.has(url)) return;
    seen.add(url);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/xml,text/xml,*/*",
        },
        signal: ctrl.signal,
      });
      if (!res.ok) return;
      const xml = await res.text();
      if (xml.length > MAX_PAGE_BYTES) return;

      // Sitemap index → recurse into nested sitemap files.
      if (/<sitemapindex/i.test(xml)) {
        const nested = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(
          (m) => m[1],
        );
        for (const n of nested) await tryFetch(n, depth + 1);
        return;
      }
      const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(
        (m) => m[1],
      );
      for (const u of urls) {
        try {
          const parsed = new URL(u);
          const origin = `${parsed.protocol}//${parsed.host}`;
          const originUrls = collected.get(origin) ?? [];
          originUrls.push(u);
          collected.set(origin, originUrls);
        } catch {
          // skip malformed
        }
      }
    } catch {
      // sitemap is best-effort — never fatal
    } finally {
      clearTimeout(t);
    }
  };

  // Try sitemap paths at both the base prefix and the origin (some sites only
  // publish the sitemap at the root even when docs live under /docs/).
  const candidates = new Set<string>();
  for (const p of SITEMAP_PATHS) {
    candidates.add(base.origin + p);
    if (base.pathPrefix) candidates.add(base.baseUrl + p);
  }
  for (const c of candidates) await tryFetch(c, 0);

  // Decide the accepted origin set. Default = base.origin only. But if every
  // URL in the sitemap lives under a *different* origin (bun.sh → bun.com
  // rebrand), that origin is the canonical doc home — accept it as an alias.
  // The alias is also used by the BFS link filter so cross-domain links
  // discovered on a page get crawled.
  const aliasOrigins = new Set<string>([base.origin]);
  const sameOriginCount = (collected.get(base.origin) ?? []).length;
  if (sameOriginCount === 0) {
    // No URLs in base.origin — adopt every other origin we found that has a
    // meaningful number of URLs (≥3 to ignore stray cross-links).
    for (const [origin, list] of collected) {
      if (list.length >= 3) aliasOrigins.add(origin);
    }
  }

  const out: string[] = [];
  for (const origin of aliasOrigins) {
    const list = collected.get(origin) ?? [];
    for (const u of list) {
      // If we have a path prefix, only accept URLs whose pathname starts
      // with it (after migrating to the alias origin if present).
      try {
        const parsed = new URL(u);
        if (base.pathPrefix && !parsed.pathname.startsWith(base.pathPrefix))
          continue;
      } catch {
        continue;
      }
      let norm = u.split("#")[0];
      if (norm.endsWith("/") && !/:\/\/[^/]+\/$/.test(norm))
        norm = norm.slice(0, -1);
      out.push(norm);
    }
  }
  // dedupe while preserving insertion order
  return { urls: Array.from(new Set(out)), aliasOrigins };
}

interface CrawlOptions {
  base: DocsBase;
  startUrl: string;
  maxPages: number;
  onProgress?: (pagesIndexed: number, pagesTotal: number) => void;
}

async function crawlSite(opts: CrawlOptions): Promise<CrawledPage[]> {
  const { base, startUrl } = opts;
  const seen = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [];

  // Seed from sitemap.xml when one's available. Each sitemap URL is enqueued
  // at depth 0 so we still BFS-link-discover from each page (catches anything
  // the sitemap missed). Capped at maxPages — sitemaps for big docs sites can
  // be tens of thousands of URLs. aliasOrigins captures cross-domain redirects
  // (e.g. bun.sh's sitemap lists bun.com URLs) so the BFS link filter accepts
  // links to either host.
  const sitemap = await fetchSitemapUrls(base).catch(() => ({
    urls: [],
    aliasOrigins: new Set([base.origin]),
  }));
  for (const u of sitemap.urls.slice(0, opts.maxPages)) {
    if (seen.has(u)) continue;
    seen.add(u);
    queue.push({ url: u, depth: 0 });
  }
  // Always include the user-mentioned URL (might not be in the sitemap, e.g.
  // landing-page-only sites or a deep link the model wants to anchor on).
  if (!seen.has(startUrl)) {
    seen.add(startUrl);
    queue.push({ url: startUrl, depth: 0 });
  }
  const pages: CrawledPage[] = [];

  while (queue.length > 0 && pages.length < opts.maxPages) {
    // Pull a small batch and fetch them in parallel.
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) => {
        const fetched = await fetchPage(item.url);
        if (!fetched) return null;
        const { markdown, title, links } = extractContentAndLinks(
          fetched.html,
          item.url,
          base,
          sitemap.aliasOrigins,
        );
        return { item, markdown, title, links };
      }),
    );

    for (const r of results) {
      if (!r) continue;
      const { item, markdown, title, links } = r;
      if (markdown.trim().length > 0) {
        pages.push({
          url: item.url,
          urlPath: urlPathFor(item.url),
          markdown,
          hash:
            "sha256:" +
            crypto.createHash("sha256").update(markdown).digest("hex"),
          title,
        });
        opts.onProgress?.(pages.length, pages.length + queue.length);
        if (pages.length >= opts.maxPages) break;
      }
      if (item.depth < MAX_DEPTH) {
        for (const link of links) {
          if (seen.has(link)) continue;
          seen.add(link);
          queue.push({ url: link, depth: item.depth + 1 });
        }
      }
    }
  }

  return pages;
}

// ── Sync (carryover-based, mirrors runSync in claude-context.ts) ─────────────

interface DocsJobUpdate {
  sourceId: string;
  ref: string;
  collection: string;
  baseUrl?: string;
  status: "indexing" | "indexed" | "failed";
  percentage?: number;
  pages_total?: number;
  pages_indexed?: number;
  total_chunks?: number;
  error?: string;
}

async function upsertJob(
  config: GatewayConfig,
  job: DocsJobUpdate,
): Promise<void> {
  await gatewayFetch(config, "POST", `${PLUGIN_PATH}/jobs`, job);
}

export interface DocsSyncResult {
  shortCircuit: boolean;
  totalChunks: number;
  embeddedChunks: number;
  reusedChunks: number;
  totalPages: number;
}

export async function runDocsSync(
  config: GatewayConfig,
  base: DocsBase,
): Promise<DocsSyncResult> {
  const ref = DEFAULT_REF;
  const collection = collectionName(base.sourceId);
  const now = () => Date.now();

  // Heartbeat the job alive — don't reset the previous run's counters.
  const updateJob = async (fields: Partial<DocsJobUpdate>): Promise<void> => {
    try {
      await upsertJob(config, {
        sourceId: base.sourceId,
        ref,
        collection,
        baseUrl: base.baseUrl,
        status: "indexing",
        ...fields,
      });
    } catch {
      // best-effort
    }
  };
  await updateJob({});

  const prior = await fetchOverlay(
    config,
    PLUGIN_PATH,
    base.sourceId,
    ref,
  ).catch(() => ({
    entries: [] as OverlayEntry[],
    headCommit: null as string | null,
  }));
  const priorByPath = new Map<string, OverlayEntry>();
  for (const e of prior.entries) priorByPath.set(e.filePath, e);

  // Crawl the entire site up front. We need the page set to know what to
  // carry over vs re-embed; the crawl itself is the slow part anyway.
  let pagesSeen = 0;
  const pages = await crawlSite({
    base,
    startUrl: base.baseUrl,
    maxPages: MAX_PAGES,
    onProgress: async (n) => {
      if (n - pagesSeen >= 5) {
        pagesSeen = n;
        await updateJob({ pages_indexed: n });
      }
    },
  });

  await updateJob({ pages_total: pages.length, pages_indexed: pages.length });

  // Carryover pass: pages whose markdown hash matches the prior overlay reuse
  // their chunk IDs verbatim. Only fresh/changed pages go through the chunker
  // and the chunksExists round-trip.
  const overlayEntries: OverlayEntry[] = [];
  const changedChunks: PendingChunk[] = [];
  let reusedFromHash = 0;

  for (const page of pages) {
    const prior = priorByPath.get(page.urlPath);
    if (prior && prior.fileHash === page.hash && prior.chunkIds.length > 0) {
      overlayEntries.push({
        filePath: page.urlPath,
        chunkIds: prior.chunkIds,
        fileHash: page.hash,
      });
      reusedFromHash += prior.chunkIds.length;
      continue;
    }
    const chunks = chunkFile(page.urlPath, page.markdown, ".md");
    if (chunks.length === 0) continue;
    for (const c of chunks) changedChunks.push(c);
    overlayEntries.push({
      filePath: page.urlPath,
      chunkIds: chunks.map((c) => c.id),
      fileHash: page.hash,
    });
  }

  const existing = await chunksExists(
    config,
    PLUGIN_PATH,
    base.sourceId,
    changedChunks.map((c) => c.id),
  );
  const missing = changedChunks.filter((c) => !existing.has(c.id));
  const reusedFromCollection = changedChunks.length - missing.length;
  const totalChunks = reusedFromHash + changedChunks.length;

  const workDoneBefore = reusedFromHash + reusedFromCollection;
  const computePct = (embeddedSoFar: number): number => {
    if (totalChunks === 0) return 100;
    return Math.min(
      99,
      Math.round(((workDoneBefore + embeddedSoFar) / totalChunks) * 100),
    );
  };
  await updateJob({ total_chunks: totalChunks, percentage: computePct(0) });

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
      metadata: { kind: "docs", sourceId: base.sourceId },
    }));
    await pushChunks(config, PLUGIN_PATH, base.sourceId, docs);
    embedded += batch.length;

    const t = now();
    if (t - lastProgress >= PROGRESS_INTERVAL_MS) {
      await updateJob({ percentage: computePct(embedded) });
      lastProgress = t;
    }
  }

  await setOverlay(config, PLUGIN_PATH, base.sourceId, ref, overlayEntries);

  await upsertJob(config, {
    sourceId: base.sourceId,
    ref,
    collection,
    baseUrl: base.baseUrl,
    status: "indexed",
    percentage: 100,
    pages_total: pages.length,
    pages_indexed: pages.length,
    total_chunks: totalChunks,
  });

  return {
    shortCircuit: false,
    totalChunks,
    embeddedChunks: embedded,
    reusedChunks: reusedFromHash + reusedFromCollection,
    totalPages: pages.length,
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const docsContextToolDefs = [
  {
    name: "index_docs",
    description:
      "Crawl a documentation website and index it for semantic search. Pass any URL on the docs " +
      "site — the plugin derives the base URL automatically (origin + first path segment if it's " +
      "a known docs prefix like /docs, /reference, /api, /guide). Crawl is BFS, same-origin, " +
      "capped at 200 pages and depth 4. Re-running on an already-indexed URL only re-embeds pages " +
      "whose content hash changed.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Any URL on the docs site (https://bun.sh/docs, https://react.dev/reference, ...).",
        },
        force: {
          type: "boolean",
          description: "Drop the prior index and re-crawl from scratch.",
          default: false,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "search_docs",
    description:
      "Semantic search across indexed documentation websites. Pass a `url` to scope to one site, " +
      "or omit it to fan out across every docs site indexed in this gateway. Use this BEFORE " +
      "WebFetch when the user asks about a framework / library / protocol — the index already " +
      "has the right content and won't get rate-limited.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language query — describe what you're trying to find.",
        },
        url: {
          type: "string",
          description:
            "Optional. Any URL on a previously-indexed docs site to scope the search to that site.",
        },
        limit: { type: "number", default: 8, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_docs_indexing_status",
    description: "Check indexing progress for a docs site.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Any URL on the docs site." },
      },
      required: ["url"],
    },
  },
  {
    name: "clear_docs_index",
    description: "Remove the index for a docs site.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Any URL on the docs site." },
      },
      required: ["url"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function handleDocsContextTool(
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
    case "index_docs": {
      const url = args.url as string;
      const force = (args.force as boolean) ?? false;
      if (!url) return errRes("url required");
      const rawBase = deriveDocsBase(url);
      if (!rawBase)
        return errRes(`Cannot index '${url}' — not an indexable docs URL.`);
      // Canonicalize so two domains pointing at the same docs collapse to one
      // index instead of being crawled + embedded twice.
      const base = await resolveCanonicalDocsBase(rawBase);
      const collection = collectionName(base.sourceId);

      if (force) {
        await gatewayFetch(
          config,
          "DELETE",
          `${PLUGIN_PATH}/jobs?sourceId=${encodeURIComponent(base.sourceId)}`,
        ).catch(() => {});
      }

      // Already-indexing guard, mirrors index_codebase.
      const statusRes = await gatewayFetch(
        config,
        "GET",
        `${PLUGIN_PATH}/jobs?sourceId=${encodeURIComponent(base.sourceId)}&ref=${encodeURIComponent(DEFAULT_REF)}`,
      );
      if (statusRes.ok) {
        const existing = (await statusRes.json()) as { status?: string };
        if (existing.status === "indexing" && !force) {
          return errRes(
            `Already indexing '${base.sourceId}'. Use force=true to restart.`,
          );
        }
      }

      await upsertJob(config, {
        sourceId: base.sourceId,
        ref: DEFAULT_REF,
        collection,
        baseUrl: base.baseUrl,
        status: "indexing",
        percentage: 0,
      });

      // Background sync — the model gets a queued response immediately.
      (async () => {
        try {
          await runDocsSync(config, base);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await upsertJob(config, {
            sourceId: base.sourceId,
            ref: DEFAULT_REF,
            collection,
            baseUrl: base.baseUrl,
            status: "failed",
            error: msg,
          }).catch(() => {});
        }
      })();

      return textRes(
        `Started crawl for '${base.baseUrl}' (codebase '${base.sourceId}'). Use get_docs_indexing_status to track progress.`,
      );
    }

    case "search_docs": {
      const query = args.query as string;
      const url = args.url as string | undefined;
      const limit = (args.limit as number) ?? 8;
      if (!query) return errRes("query required");

      let payload: Record<string, unknown> = { query, limit };
      if (url) {
        const rawBase = deriveDocsBase(url);
        if (!rawBase)
          return errRes(
            `Cannot search '${url}' — not a recognizable docs URL.`,
          );
        // Resolve to the canonical identity so a scoped search via an alias
        // domain still hits the one index it was stored under.
        const base = await resolveCanonicalDocsBase(rawBase);
        payload = { ...payload, sourceId: base.sourceId, ref: DEFAULT_REF };
      }
      const res = await gatewayFetch(
        config,
        "POST",
        `${PLUGIN_PATH}/search`,
        payload,
      );
      if (res.status === 404) {
        return errRes(
          url
            ? `No docs indexed for '${url}'. Run index_docs first.`
            : "No docs indexed yet. Run index_docs on a URL first.",
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
          sourceId?: string;
        }>;
        indexing: boolean;
      };

      if (data.results.length === 0) {
        const note = data.indexing
          ? " (indexing still in progress — more results may appear later)"
          : "";
        return textRes(`No docs matches for "${query}"${note}`);
      }

      const formatted = data.results
        .map((r, i) => {
          const tag = r.sourceId ? ` [${r.sourceId}]` : "";
          return (
            `${i + 1}. ${r.document.relativePath}:${r.document.startLine}-${r.document.endLine}${tag}\n` +
            `\`\`\`md\n${r.document.content}\n\`\`\``
          );
        })
        .join("\n\n");

      const note = data.indexing
        ? "\n\n⚠️ Indexing still in progress — results may be incomplete."
        : "";
      return textRes(
        `Found ${data.results.length} doc matches for "${query}":\n\n${formatted}${note}`,
      );
    }

    case "get_docs_indexing_status": {
      const url = args.url as string;
      if (!url) return errRes("url required");
      const rawBase = deriveDocsBase(url);
      if (!rawBase) return errRes(`'${url}' is not a recognizable docs URL.`);
      const base = await resolveCanonicalDocsBase(rawBase);

      const res = await gatewayFetch(
        config,
        "GET",
        `${PLUGIN_PATH}/jobs?sourceId=${encodeURIComponent(base.sourceId)}&ref=${encodeURIComponent(DEFAULT_REF)}`,
      );
      if (res.status === 404)
        return textRes(`'${base.sourceId}' is not indexed.`);
      if (!res.ok) return errRes(`Status check failed: ${res.status}`);

      const job = (await res.json()) as {
        status: string;
        percentage: number;
        pages_indexed?: number;
        pages_total?: number;
        total_chunks?: number;
        error?: string;
        updated_at: number;
      };
      const ago = Math.round((Date.now() - job.updated_at) / 1000);
      const since = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;

      if (job.status === "indexed") {
        return textRes(
          `✅ '${base.sourceId}' is indexed.\n` +
            `Pages: ${job.pages_indexed ?? "?"} | Chunks: ${job.total_chunks ?? "?"} | Updated ${since}`,
        );
      }
      if (job.status === "indexing") {
        const pct = Math.round(job.percentage);
        const progress = job.pages_total
          ? ` (${job.pages_indexed ?? 0}/${job.pages_total} pages)`
          : "";
        return textRes(
          `🔄 Crawling: ${pct}%${progress} — last update ${since}`,
        );
      }
      if (job.status === "failed") {
        return textRes(
          `❌ Indexing failed: ${job.error ?? "unknown error"}\nRun index_docs to retry.`,
        );
      }
      return textRes(`Unknown status: ${job.status}`);
    }

    case "clear_docs_index": {
      const url = args.url as string;
      if (!url) return errRes("url required");
      const rawBase = deriveDocsBase(url);
      if (!rawBase) return errRes(`'${url}' is not a recognizable docs URL.`);
      const base = await resolveCanonicalDocsBase(rawBase);

      const res = await gatewayFetch(
        config,
        "DELETE",
        `${PLUGIN_PATH}/jobs?sourceId=${encodeURIComponent(base.sourceId)}`,
      );
      if (res.status === 404)
        return textRes(`'${base.sourceId}' is not indexed.`);
      if (!res.ok) return errRes(`Clear failed: ${res.status}`);
      return textRes(`Cleared docs index for '${base.sourceId}'.`);
    }

    default:
      return errRes(`Unknown tool: ${name}`);
  }
}
