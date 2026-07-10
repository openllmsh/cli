#!/usr/bin/env bun

/**
 * Verify published CLI binaries against the committed checksum manifest —
 * the `openllmc` twin of `packages/daemon/scripts/verify.ts`.
 *
 * The CLI ships as a compiled binary, so end users don't run this `.ts`
 * source — they run an artifact the cloud serves, which redirects to the
 * GitHub Release on the mirror repo. This command lets ANYONE independently
 * confirm that artifact is exactly what this source-available repo vouches
 * for: it downloads each published `openllmc-<target>.gz` asset straight
 * from the GitHub Release named in `manifest.ts`, decompresses it, sha256's
 * the bytes that actually execute, and asserts the digest equals the value
 * committed in `manifest.ts`. A mismatch fails loud (non-zero exit).
 *
 * Why not "rebuild from source and diff the binary": `bun build --compile
 * --bytecode` is NOT byte-reproducible, so a fresh local build won't
 * hash-match the release even from identical source. The trust anchor is the
 * committed manifest + the published asset.
 *
 * Usage (via `bun run verify`):
 *   bun run verify                        # every published target vs the manifest
 *   bun run verify -- --host              # only this host's target
 *   bun run verify -- --target linux-x64-baseline # one target
 *   bun run verify -- --file ./openllmc   # a local binary you have
 *   bun run verify -- --installed         # the `openllmc` found on $PATH
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { CLI_RELEASE } from "../manifest";
import type { TCliTarget } from "../release-types";
import { CLI_TARGETS } from "../release-types";

const DOWNLOAD_TIMEOUT_MS = 60_000;

/** This host's release target, or null when the platform/arch isn't one we
 *  publish. `process.arch` reports `arm64`/`x64`; x64 maps to the `-baseline`
 *  variant (the single x64 release target), matching `CLI_TARGETS`. */
const hostTarget = (): TCliTarget | null => {
  const arch =
    process.arch === "x64"
      ? "x64-baseline"
      : process.arch === "arm64"
        ? "arm64"
        : null;
  if (arch === null) return null;
  const t = `${process.platform}-${arch}`;
  return (CLI_TARGETS as readonly string[]).includes(t)
    ? (t as TCliTarget)
    : null;
};

/** The published GitHub Release asset URL for a target (gzipped binary). */
const assetUrl = (target: TCliTarget): string =>
  `https://github.com/${CLI_RELEASE.repo}/releases/download/${CLI_RELEASE.tag}/openllmc-${target}.gz`;

/** Decompress when the gzip magic (0x1f 0x8b) is present; tolerate a raw
 *  binary too. The pinned sha256 is over the DECOMPRESSED bytes. */
const decompress = (buf: Buffer): Buffer =>
  buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
    ? Buffer.from(gunzipSync(buf))
    : buf;

const sha256 = (buf: Buffer): string =>
  createHash("sha256").update(buf).digest("hex");

const fetchAsset = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }
  return decompress(Buffer.from(await res.arrayBuffer()));
};

type TResult = {
  readonly target: TCliTarget;
  readonly source: string;
  readonly expected: string | undefined;
  readonly actual: string | null;
  readonly ok: boolean;
  readonly error?: string;
};

const verifyBytes = (
  target: TCliTarget,
  source: string,
  bytes: Buffer,
): TResult => {
  const expected = CLI_RELEASE.sha256[target];
  const actual = sha256(bytes);
  return {
    target,
    source,
    expected,
    actual,
    ok: expected !== undefined && actual === expected,
    error:
      expected === undefined ? "no checksum pinned in manifest" : undefined,
  };
};

const verifyRemote = async (target: TCliTarget): Promise<TResult> => {
  const url = assetUrl(target);
  try {
    return verifyBytes(target, url, await fetchAsset(url));
  } catch (err) {
    return {
      target,
      source: url,
      expected: CLI_RELEASE.sha256[target],
      actual: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const verifyLocalFile = (target: TCliTarget, path: string): TResult => {
  try {
    return verifyBytes(target, path, decompress(readFileSync(path)));
  } catch (err) {
    return {
      target,
      source: path,
      expected: CLI_RELEASE.sha256[target],
      actual: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const shortSha = (sha: string | null): string =>
  sha === null ? "—".padEnd(17) : `${sha.slice(0, 12)}…${sha.slice(-4)}`;

const printResult = (r: TResult): void => {
  const mark = r.ok ? "✓" : "✗";
  const head = `  ${mark} ${r.target.padEnd(13)} ${shortSha(r.actual)}`;
  if (r.ok) {
    console.log(`${head}  matches manifest`);
    return;
  }
  if (r.error !== undefined && r.actual === null) {
    console.log(`${head}  ${r.error}`);
    return;
  }
  console.log(
    `${head}  MISMATCH — manifest pins ${shortSha(r.expected ?? null)}` +
      (r.error !== undefined ? ` (${r.error})` : ""),
  );
};

const parseArgs = (
  argv: readonly string[],
): {
  host: boolean;
  installed: boolean;
  target: string | null;
  file: string | null;
} => {
  let host = false;
  let installed = false;
  let target: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = true;
    else if (a === "--installed") installed = true;
    else if (a === "--target" || a === "--file") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`${a} requires a value`);
      }
      if (a === "--target") target = v;
      else file = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return { host, installed, target, file };
};

const asTarget = (value: string): TCliTarget => {
  if (!(CLI_TARGETS as readonly string[]).includes(value)) {
    throw new Error(
      `unknown target "${value}" — expected one of: ${CLI_TARGETS.join(", ")}`,
    );
  }
  return value as TCliTarget;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  if (CLI_RELEASE.tag === "") {
    throw new Error(
      "manifest pins no release yet (tag is empty) — nothing to verify.",
    );
  }

  console.log("openllmc release verification");
  console.log(`  repo: ${CLI_RELEASE.repo}`);
  console.log(`  tag:  ${CLI_RELEASE.tag}\n`);

  const localPath = args.installed
    ? (Bun.which("openllmc") ??
      ((): never => {
        throw new Error("--installed: no `openllmc` found on $PATH");
      })())
    : args.file;
  if (localPath !== null) {
    const target =
      args.target !== null
        ? asTarget(args.target)
        : (hostTarget() ??
          ((): never => {
            throw new Error(
              `this host (${process.platform}-${process.arch}) is not a published target — pass --target <target> to say which pin ${localPath} should match`,
            );
          })());
    const r = verifyLocalFile(target, localPath);
    printResult(r);
    console.log(`\n${r.ok ? "✓ matches" : "✗ DOES NOT match"} the manifest.`);
    process.exit(r.ok ? 0 : 1);
  }

  const targets: readonly TCliTarget[] = args.target
    ? [asTarget(args.target)]
    : args.host
      ? [
          hostTarget() ??
            ((): never => {
              throw new Error(
                `--host: this host (${process.platform}-${process.arch}) is not a published target`,
              );
            })(),
        ]
      : CLI_RELEASE.targets;

  const results = await Promise.all(targets.map(verifyRemote));
  for (const r of results) printResult(r);

  const ok = results.filter((r) => r.ok).length;
  const bad = results.length - ok;
  console.log(
    `\n${bad === 0 ? `✓ all ${ok} match the manifest.` : `✗ ${bad} of ${results.length} DO NOT match.`}`,
  );
  process.exit(bad === 0 ? 0 : 1);
};

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
