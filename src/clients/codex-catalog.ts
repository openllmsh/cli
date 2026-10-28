import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Restore Codex's built-in GPT metadata in a gateway-built Codex catalog.
 *
 * Once `model_catalog_json` is set, that file is the ONLY thing Codex's model
 * picker lists, so a `chatgpt/*` model left out of it is routable but
 * invisible. The gateway can list them (`?chatgpt=1`), but only as
 * placeholders: it doesn't have Codex's per-model prompt
 * (`base_instructions`, ~20k chars), reasoning levels or tool settings, and
 * an entry without them would replace what Codex uses for that model today.
 * The installed binary ships exactly that metadata (`codex debug models
 * --bundled`), version-matched to the Codex that will run the turn, so each
 * placeholder becomes the built-in entry for its suffix (`chatgpt/gpt-6-sol`
 * → `gpt-6-sol`), keeping our slug/name and the gateway's context window.
 *
 * A placeholder this Codex doesn't know (older binary, no `debug models`, a
 * failed read) is DROPPED — the previous behavior: still routable by typing
 * the id, never listed with an empty prompt. Accounts without a ChatGPT sub
 * have no `chatgpt/*` cards, so nothing here applies to them.
 */

const CHATGPT_PREFIX = "chatgpt/";

/** Generous: the read is ~0.1s, but it runs on the launch path. */
const BUNDLED_READ_TIMEOUT_MS = 5_000;

type TCodexCatalogEntry = Readonly<Record<string, unknown>> & {
  readonly slug: string;
};

const entriesOf = (
  value: unknown,
): ReadonlyArray<TCodexCatalogEntry> | null => {
  if (typeof value !== "object" || value === null) return null;
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;
  return models.filter(
    (m): m is TCodexCatalogEntry =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as { slug?: unknown }).slug === "string",
  );
};

/**
 * The installed Codex's bundled catalog, keyed by slug. Runs under a throwaway
 * `CODEX_HOME` so a broken user `config.toml` can't fail the read and nothing
 * is written to the real one. Empty map on any failure.
 */
export const readBundledCodexModels = (
  codexBin: string,
): ReadonlyMap<string, TCodexCatalogEntry> => {
  const home = mkdtempSync(join(tmpdir(), "openllm-codex-models-"));
  try {
    const res = spawnSync(codexBin, ["debug", "models", "--bundled"], {
      env: { ...process.env, CODEX_HOME: home },
      encoding: "utf8",
      timeout: BUNDLED_READ_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0) return new Map();
    const entries = entriesOf(JSON.parse(res.stdout));
    return new Map((entries ?? []).map((e) => [e.slug, e]));
  } catch {
    return new Map();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

/**
 * Swap each `chatgpt/*` placeholder in `catalog` (the gateway's JSON text) for
 * the matching `bundled` entry; drop the ones with no match. Non-ChatGPT
 * entries pass through untouched. Unparseable input is returned verbatim so
 * the existing launch handling stays in charge of it. Null when dropping
 * leaves nothing: Codex rejects an empty catalog, while no catalog falls back
 * to its built-ins.
 */
export const hydrateChatgptEntries = (
  catalog: string,
  bundled: ReadonlyMap<string, TCodexCatalogEntry>,
): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(catalog);
  } catch {
    return catalog;
  }
  const entries = entriesOf(parsed);
  if (entries === null) return catalog;
  if (!entries.some((e) => e.slug.startsWith(CHATGPT_PREFIX))) return catalog;

  const models = entries.flatMap((entry): TCodexCatalogEntry[] => {
    if (!entry.slug.startsWith(CHATGPT_PREFIX)) return [entry];
    const builtin = bundled.get(entry.slug.slice(CHATGPT_PREFIX.length));
    if (builtin === undefined) return [];
    return [
      {
        ...builtin,
        slug: entry.slug,
        display_name: entry.display_name ?? builtin.display_name,
        context_window: entry.context_window ?? builtin.context_window,
        max_context_window:
          entry.max_context_window ?? builtin.max_context_window,
        // Codex orders its picker by `priority` (stable sort). The built-in
        // value (1–13) would list GPT models above the fallback chains; the
        // gateway's ties them with every other entry, keeping its order.
        priority: entry.priority ?? builtin.priority,
        visibility: "list",
      },
    ];
  });
  return models.length === 0
    ? null
    : JSON.stringify({ ...(parsed as object), models });
};

/** Both steps, for a launch that knows which Codex binary will run. */
export const codexCatalogFor = (
  catalog: string | null,
  codexBin: string,
): string | null =>
  catalog === null || !catalog.includes(`"${CHATGPT_PREFIX}`)
    ? catalog
    : hydrateChatgptEntries(catalog, readBundledCodexModels(codexBin));
