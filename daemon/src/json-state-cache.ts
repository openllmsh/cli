/**
 * Shared atomic JSON state-file helpers used by `cli-version-cache` and
 * `launcher-resolution-cache` (tmp + rename, mode 0o600, size-capped load).
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

let tmpSeq = 0;

export const writeJsonStateAtomic = (
  dir: string,
  file: string,
  body: unknown,
): boolean => {
  tmpSeq += 1;
  const base = file.includes("/")
    ? file.slice(file.lastIndexOf("/") + 1)
    : file;
  const tmp = join(dir, `.${base}.${process.pid}.${tmpSeq}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    return false;
  }
};

export const readJsonStateFile = (
  file: string,
  maxFileBytes: number,
): unknown | null => {
  try {
    const info = statSync(file);
    if (info.size > maxFileBytes) return null;
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  if (raw.length > maxFileBytes) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
