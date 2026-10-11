/**
 * The daemon half's code fingerprint — a sha-256 over every module the daemon
 * entry (`daemon/src/main.ts`) reaches, as the bundler resolves it: daemon
 * source, the protocol/wire/tunnel workspace packages, and every npm module.
 *
 * Baked into the single `openllm` binary at compile time
 * (`__OPENLLM_DAEMON_FINGERPRINT__`). After the binary is swapped, the running
 * daemon asks the new file for its fingerprint (`openllm daemon --fingerprint`)
 * and restarts only when it differs from its own: a CLI-only release swaps the
 * file without bouncing the daemon.
 *
 * Content-addressed, not git-addressed, so it is correct for any build input
 * (uncommitted edits, a dependency bump) and stable across checkouts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
export const DAEMON_ENTRY = join(PKG_ROOT, "daemon", "src", "main.ts");

/** Inputs that never change daemon behaviour. The subscription floors are
 *  cloud-side policy data the old daemon change-gate excluded too. */
const EXCLUDED: readonly string[] = [
  "packages/protocol/subscription-daemon-floors.ts",
];

/** The daemon entry's resolved import closure, repo-relative and sorted. */
export const daemonClosure = async (): Promise<readonly string[]> => {
  const result = await Bun.build({
    entrypoints: [DAEMON_ENTRY],
    target: "bun",
    metafile: true,
    throw: false,
  });
  if (!result.success || result.metafile === undefined) {
    const detail = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`could not resolve the daemon import closure\n${detail}`);
  }
  // Metafile paths are relative to the cwd; normalise to the repo root so the
  // fingerprint is the same wherever the build runs.
  return Object.keys(result.metafile.inputs)
    .map((path) => relative(REPO_ROOT, resolve(process.cwd(), path)))
    .filter((path) => !EXCLUDED.includes(path))
    .sort();
};

/** The release pin. It changes every release, so a daemon import of it would
 *  make the fingerprint change on CLI-only releases too — refuse it. */
const MANIFEST = "packages/cli/manifest.ts";

/** sha-256 (hex) over each closure file's path and bytes. */
export const daemonFingerprint = async (): Promise<string> => {
  const closure = await daemonClosure();
  if (closure.includes(MANIFEST)) {
    throw new Error(
      `the daemon half imports ${MANIFEST}; its pin changes every release, so every update would restart the daemon — remove the import`,
    );
  }
  const hash = createHash("sha256");
  for (const path of closure) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(REPO_ROOT, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
};

if (import.meta.main) {
  process.stdout.write(`${await daemonFingerprint()}\n`);
}
