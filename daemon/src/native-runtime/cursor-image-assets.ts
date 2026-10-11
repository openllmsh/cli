/**
 * Provenance-only Cursor image collection. Paths come from ACP Generate Image
 * tool completion (or a documented generate_image notification payload), never
 * from a home-wide sweep. Each candidate is realpath-jailed against the
 * isolated workspace and the Cursor project assets root.
 */

import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  IMAGE_INSPECT_MAX_BYTES,
  inspectImageBytes,
} from "@openllmsh/wire/lib/canonical/image-signature";
import type { TInspectedImageMime } from "@openllmsh/wire/lib/canonical/image-signature";

export type TCursorNativeImageAsset = {
  readonly bytes: Uint8Array;
  readonly mime: TInspectedImageMime;
  readonly width: number;
  readonly height: number;
  readonly sourcePath: string;
};

export const CURSOR_IMAGE_MAX_BYTES = IMAGE_INSPECT_MAX_BYTES;

const isPathInside = (root: string, candidate: string): boolean => {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
};

const fileUriPath = (value: string): string | null => {
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      return null;
    }
  }
  return value;
};

const pushPath = (out: string[], value: unknown): void => {
  if (typeof value !== "string" || value.length === 0) return;
  const path = fileUriPath(value);
  if (path !== null && path.length > 0) out.push(path);
};

const walkUnknownForPaths = (value: unknown, out: string[], depth: number): void => {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (
      value.startsWith("/") ||
      value.startsWith("file://") ||
      value.includes(`${sep}assets${sep}`) ||
      /\.(png|jpe?g|gif|webp)$/i.test(value)
    ) {
      pushPath(out, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkUnknownForPaths(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  for (const key of [
    "filePath",
    "path",
    "uri",
    "outputPath",
    "imagePath",
    "filepath",
  ]) {
    pushPath(out, o[key]);
  }
  if (o.locations !== undefined) walkUnknownForPaths(o.locations, out, depth + 1);
  if (o.content !== undefined) walkUnknownForPaths(o.content, out, depth + 1);
  if (o.rawInput !== undefined) walkUnknownForPaths(o.rawInput, out, depth + 1);
  if (o.rawOutput !== undefined) walkUnknownForPaths(o.rawOutput, out, depth + 1);
};

/** Collect candidate filesystem paths from one ACP update / notification. */
export const provenancePathsOf = (update: unknown): ReadonlyArray<string> => {
  const out: string[] = [];
  walkUnknownForPaths(update, out, 0);
  return [...new Set(out)];
};

export type TCursorImageJail = {
  readonly workspaceRoot: string;
  readonly assetsRoot: string;
};

/**
 * Allowed roots: the isolated request workspace, and Cursor's managed
 * `.cursor/projects/<workspace>/assets` under the isolated HOME (may sit
 * outside the requested cwd).
 */
export const cursorImageJailOf = (params: {
  readonly workspaceDir: string;
  readonly homeDir: string;
}): TCursorImageJail => {
  const workspaceRoot = resolve(params.workspaceDir);
  const name = workspaceRoot.split(sep).filter(Boolean).at(-1) ?? "workspace";
  const assetsRoot = resolve(
    join(params.homeDir, ".cursor", "projects", name, "assets"),
  );
  return { workspaceRoot, assetsRoot };
};

/**
 * Best-effort removal of the per-run Cursor project directory that owns
 * `jail.assetsRoot` — i.e. `<homeDir>/.cursor/projects/<workspace-name>`,
 * the parent of `.../assets`. `workspace-name` is derived from the unique
 * `mkdtemp`-generated workspace directory name, so this directory is never
 * shared across runs; the shared `.cursor/projects` root itself is never a
 * target and is left untouched. Resolves both the shared root and the
 * candidate project dir through `realpath` first so a symlink swapped in
 * under `assetsRoot` can't be used to walk the removal outside the jail.
 */
export const cleanupCursorImageProjectDir = async (
  jail: TCursorImageJail,
): Promise<void> => {
  const projectDir = resolve(jail.assetsRoot, "..");
  const projectsRoot = resolve(jail.assetsRoot, "..", "..");
  if (projectDir === projectsRoot) return;
  let realProjectsRoot: string;
  try {
    realProjectsRoot = await realpath(projectsRoot);
  } catch {
    return; // shared root doesn't exist — nothing to protect or clean
  }
  let realProjectDir: string;
  try {
    realProjectDir = await realpath(projectDir);
  } catch {
    return; // nothing to remove
  }
  if (realProjectDir === realProjectsRoot) return;
  if (!isPathInside(realProjectsRoot, realProjectDir)) return;
  try {
    await rm(projectDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
};

const resolveInsideJail = async (
  candidate: string,
  jail: TCursorImageJail,
): Promise<string | null> => {
  if (!isAbsolute(candidate)) return null;
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    return null;
  }
  const roots = [jail.workspaceRoot, jail.assetsRoot];
  const resolvedRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return root;
      }
    }),
  );
  if (!resolvedRoots.some((root) => isPathInside(root, resolved))) return null;
  try {
    const st = await lstat(resolved);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
};

export const collectJailedCursorImage = async (
  candidatePath: string,
  jail: TCursorImageJail,
): Promise<TCursorNativeImageAsset | null> => {
  const resolved = await resolveInsideJail(candidatePath, jail);
  if (resolved === null) return null;
  let buf: Buffer;
  try {
    buf = await readFile(resolved);
  } catch {
    return null;
  }
  if (buf.byteLength === 0 || buf.byteLength > CURSOR_IMAGE_MAX_BYTES) {
    return null;
  }
  const inspected = inspectImageBytes(new Uint8Array(buf));
  if (inspected === null) return null;
  return {
    bytes: new Uint8Array(buf),
    mime: inspected.mime,
    width: inspected.width,
    height: inspected.height,
    sourcePath: resolved,
  };
};

export const collectJailedCursorImages = async (
  candidatePaths: ReadonlyArray<string>,
  jail: TCursorImageJail,
): Promise<ReadonlyArray<TCursorNativeImageAsset>> => {
  const seen = new Set<string>();
  const out: TCursorNativeImageAsset[] = [];
  for (const path of candidatePaths) {
    const asset = await collectJailedCursorImage(path, jail);
    if (asset === null) continue;
    if (seen.has(asset.sourcePath)) continue;
    seen.add(asset.sourcePath);
    out.push(asset);
  }
  return out;
};
