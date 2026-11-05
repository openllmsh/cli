/**
 * The `@openllmsh/sdk` files the single `openllm` binary actually compiles in.
 *
 * The binary's change gate (`cliBinaryGitPathspecs()` and the `cli-pins-match`
 * guard) must fire only when code the binary ships changes, not when an
 * unrelated part of the SDK does (a browser-only `client/` or `vault/passkey`
 * edit must not force a rebuild and re-pin). So instead of gating on all of
 * `packages/sdk`, the gate reads the committed list in `binary-sdk-paths.txt`:
 * every SDK file in the bundler's resolved closure of the CLI entry and the
 * daemon entry, plus the SDK manifest (it pins the npm deps those files pull
 * in).
 *
 * The list is committed (not computed in CI) so the bash guard can read it
 * without bundling. `tests/release/cli-binary-sources.test.ts` rebuilds it in
 * memory and fails when the committed file is stale. Regenerate with
 * `bun run build:cli-binary-paths`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");

const ENTRIES: readonly string[] = [
  join(PKG_ROOT, "src", "main.ts"),
  join(PKG_ROOT, "daemon", "src", "main.ts"),
];

/** Committed list, one repo-relative path per line. */
export const BINARY_SDK_PATHS_FILE = "packages/cli/binary-sdk-paths.txt";

const SDK_PREFIX = "packages/sdk/";

/** Never binary bytes: publish-time pin metadata (see BINARY_SOURCE_EXCLUDES). */
const EXCLUDED: readonly string[] = [
  "packages/sdk/protocol/subscription-daemon-floors.ts",
];

/** Always gated: the SDK manifest pins the npm deps the closure bundles. */
const ALWAYS: readonly string[] = ["packages/sdk/package.json"];

const closureOf = async (entry: string): Promise<readonly string[]> => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    metafile: true,
    throw: false,
  });
  if (!result.success || result.metafile === undefined) {
    const detail = result.logs.map((log) => String(log)).join("\n");
    throw new Error(
      `could not resolve the import closure of ${entry}\n${detail}`,
    );
  }
  return Object.keys(result.metafile.inputs).map((path) =>
    relative(REPO_ROOT, resolve(process.cwd(), path)),
  );
};

/** Every repo-relative input of the binary (CLI + daemon entries), sorted. */
export const binaryClosure = async (): Promise<readonly string[]> => {
  const all = new Set<string>();
  for (const entry of ENTRIES) {
    for (const path of await closureOf(entry)) all.add(path);
  }
  return [...all].sort();
};

/** The SDK files the binary compiles in, plus {@link ALWAYS}, sorted. */
export const computeBinarySdkPaths = async (): Promise<readonly string[]> => {
  const sdk = (await binaryClosure()).filter(
    (path) => path.startsWith(SDK_PREFIX) && !EXCLUDED.includes(path),
  );
  return [...new Set([...sdk, ...ALWAYS])].sort();
};

/** Render the committed file's text. */
export const renderBinarySdkPaths = (paths: readonly string[]): string =>
  `${paths.join("\n")}\n`;

/** Read the committed list (repo-relative paths). */
export const readBinarySdkPaths = (): readonly string[] =>
  readFileSync(join(REPO_ROOT, BINARY_SDK_PATHS_FILE), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

if (import.meta.main) {
  const paths = await computeBinarySdkPaths();
  writeFileSync(
    join(REPO_ROOT, BINARY_SDK_PATHS_FILE),
    renderBinarySdkPaths(paths),
  );
  process.stdout.write(
    `[binary-sdk-paths] wrote ${BINARY_SDK_PATHS_FILE} (${paths.length} paths)\n`,
  );
}
