/**
 * Which sessions were started with skip-permissions, so the choice survives
 * the session itself: a resume — from the web or `openllm <client> --resume`
 * in a terminal — launches the engine in the same mode it was started in.
 *
 * One empty marker file per session id under the daemon state dir, written
 * by the session host (the one choke point every web and CLI launch passes
 * through) under its own id and the vendor's session id. Never consulted to
 * WIDEN a grant on its own: it only replays a choice the user made for that
 * same session through the gated picker / `-d`.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../env";

/** Session / vendor ids are UUID-like; nothing path-shaped gets through. */
const MARKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const markerDir = (): string => join(stateDir(), "agent-skip-permissions");

const markerPath = (id: string): string | null =>
  MARKER_ID_PATTERN.test(id) ? join(markerDir(), id) : null;

/** Record that `id` runs with skip-permissions. Best effort. */
export const rememberSkipPermissions = (id: string): void => {
  const path = markerPath(id);
  if (path === null) return;
  try {
    mkdirSync(markerDir(), { recursive: true, mode: 0o700 });
    writeFileSync(path, "", { mode: 0o600 });
  } catch {
    /* best effort: the session itself still runs as asked */
  }
};

/** True when `id` was started (or resumed) with skip-permissions. */
export const skipPermissionsRemembered = (id: string): boolean => {
  const path = markerPath(id);
  return path !== null && existsSync(path);
};

/** Drop the record (the session's history was deleted). */
export const forgetSkipPermissions = (id: string): void => {
  const path = markerPath(id);
  if (path === null) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* already gone */
  }
};

/** The session id a vendor arg list resumes (`--resume <id>` / `-r <id>`). */
export const resumedIdOf = (vendorArgs: readonly string[]): string | null => {
  for (let i = 0; i < vendorArgs.length; i += 1) {
    const arg = vendorArgs[i] ?? "";
    if (arg === "--resume" || arg === "-r") return vendorArgs[i + 1] ?? null;
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length);
  }
  return null;
};
