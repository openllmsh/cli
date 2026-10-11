import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve native model metadata while applying the already-validated hop budget. */
export const codexContextModelCatalog = (
  cache: unknown,
  providerModelId: string,
  inputTokenLimit: number,
): { readonly models: ReadonlyArray<Record<string, unknown>> } => {
  if (!Number.isSafeInteger(inputTokenLimit) || inputTokenLimit <= 0) {
    throw new Error("invalid Codex context budget");
  }
  if (!isRecord(cache) || !Array.isArray(cache.models)) {
    throw new Error("Codex native model metadata is unavailable");
  }
  let matched = false;
  const models = cache.models.map((model: unknown): Record<string, unknown> => {
    if (!isRecord(model) || typeof model.slug !== "string") {
      throw new Error("invalid Codex native model metadata");
    }
    if (model.slug !== providerModelId) return model;
    matched = true;
    return {
      ...model,
      context_window: inputTokenLimit,
      max_context_window: inputTokenLimit,
      // The gateway value is an INPUT budget, not a total window from which
      // native must subtract its default 5% safety reserve a second time.
      effective_context_window_percent: 100,
      auto_compact_token_limit: Math.floor((inputTokenLimit * 9) / 10),
    };
  });
  if (!matched)
    throw new Error("Codex native model metadata has no matching model");
  return { models };
};

/** Private catalogs live for one app-server child; never overwrite the vendor cache. */
export class CodexModelContextCatalog {
  private root: Promise<string> | null = null;
  private readonly catalogs = new Map<string, Promise<string>>();
  private closed = false;

  constructor(
    private readonly codexHome: string | undefined,
    private readonly tempRoot: string,
    private readonly fallbackCodexHome?: string,
  ) {}

  async pathFor(
    providerModelId: string,
    inputTokenLimit: number,
  ): Promise<string> {
    if (this.closed) throw new Error("Codex context catalogs are closed");
    const catalog = await this.loadCatalog(providerModelId, inputTokenLimit);
    if (this.closed) throw new Error("Codex context catalogs are closed");
    // A refreshed vendor cache must not be frozen behind a same-budget hit.
    const contents = JSON.stringify(catalog);
    const key = createHash("sha256").update(contents).digest("hex");
    const previous = this.catalogs.get(key);
    if (previous !== undefined) return previous;
    const pending = this.writeCatalog(contents);
    this.catalogs.set(key, pending);
    void pending.catch(() => {
      if (this.catalogs.get(key) === pending) this.catalogs.delete(key);
    });
    return pending;
  }

  async cleanup(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.catalogs.values()]);
    const root = this.root;
    if (root !== null) await rm(await root, { recursive: true, force: true });
    this.catalogs.clear();
    this.root = null;
  }

  private async loadCatalog(
    providerModelId: string,
    inputTokenLimit: number,
  ): Promise<ReturnType<typeof codexContextModelCatalog>> {
    for (const home of new Set([this.codexHome, this.fallbackCodexHome])) {
      if (home === undefined) continue;
      try {
        const cache: unknown = JSON.parse(
          await readFile(join(home, "models_cache.json"), "utf8"),
        );
        return codexContextModelCatalog(
          cache,
          providerModelId,
          inputTokenLimit,
        );
      } catch {
        // A readable durable cache may be stale or incomplete while an isolated
        // capture has refreshed its own matching metadata. Try both sources.
      }
    }
    throw new Error("Codex native model metadata is unavailable");
  }

  private async writeCatalog(contents: string): Promise<string> {
    if (this.root === null) {
      this.root = (async (): Promise<string> => {
        await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
        return await mkdtemp(join(this.tempRoot, "codex-context-"));
      })();
    }
    const path = join(await this.root, `${crypto.randomUUID()}.json`);
    await writeFile(path, contents, { mode: 0o600 });
    return path;
  }
}
