/**
 * Durable launcher-resolution cache — mirrors `cli-version-cache.ts` shape
 * (JSON under `stateDir()`, atomic tmp+rename, mode 0o600). Stores the L1
 * result (path, kind, adapter, interpreter, fingerprint) so a daemon restart
 * can peek without re-spawning managers. Fingerprint drift or an explicit
 * invalidate drops the row; never persists a miss.
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
import { stateDir } from "./env";
import type {
  TLauncherKind,
  TLauncherResolution,
} from "./launcher-resolution-types";

const SCHEMA_V = 1;
export const LAUNCHER_RESOLUTION_CACHE_MAX_RECORDS = 64;
const MAX_PATH_CHARS = 4_096;
const MAX_FILE_BYTES =
  64 * 1024 +
  LAUNCHER_RESOLUTION_CACHE_MAX_RECORDS * (MAX_PATH_CHARS * 3 + 256);

let persistTmpSeq = 0;

export type TLauncherResolutionPersistRecord = {
  readonly candidate: string;
  readonly path: string;
  readonly kind: TLauncherKind;
  readonly adapterId: string | null;
  readonly interpreter: string | null;
  readonly fingerprint: string;
  readonly underManagerRoot: boolean;
  readonly resolvedAt: number;
};

type TPersistFile = {
  readonly v: number;
  readonly records: readonly TLauncherResolutionPersistRecord[];
};

type TCacheState = {
  readonly file: string;
  readonly dir: string;
  readonly memory: Map<string, TLauncherResolutionPersistRecord>;
  persistLoaded: boolean;
  persistLocked: boolean;
  persistQueued: boolean;
};

let cacheState: TCacheState | null = null;

export const launcherResolutionCacheFilePath = (): string =>
  join(stateDir(), "launcher-resolution-cache.json");

/** A persisted `kind` must be a real {@link TLauncherKind}: one of the closed
 *  kinds, or `shim:<adapter id>` with a non-empty id. */
const isLauncherKind = (k: string): boolean =>
  k === "binary" ||
  k === "script" ||
  k === "wrapper" ||
  /^shim:[\w.-]+$/.test(k);

const isRecord = (v: unknown): v is TLauncherResolutionPersistRecord => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as TLauncherResolutionPersistRecord;
  return (
    typeof r.candidate === "string" &&
    r.candidate.length > 0 &&
    r.candidate.length <= MAX_PATH_CHARS &&
    typeof r.path === "string" &&
    r.path.length > 0 &&
    r.path.length <= MAX_PATH_CHARS &&
    typeof r.kind === "string" &&
    r.kind.length <= 64 &&
    isLauncherKind(r.kind) &&
    (r.adapterId === null || typeof r.adapterId === "string") &&
    (r.interpreter === null ||
      (typeof r.interpreter === "string" &&
        r.interpreter.length <= MAX_PATH_CHARS)) &&
    typeof r.fingerprint === "string" &&
    r.fingerprint.length > 0 &&
    r.fingerprint.length <= 256 &&
    typeof r.underManagerRoot === "boolean" &&
    typeof r.resolvedAt === "number" &&
    Number.isFinite(r.resolvedAt)
  );
};

const coerceFile = (v: unknown): TLauncherResolutionPersistRecord[] => {
  if (typeof v !== "object" || v === null) return [];
  const raw = v as { v?: unknown; records?: unknown };
  if (raw.v !== SCHEMA_V || !Array.isArray(raw.records)) return [];
  return raw.records
    .filter(isRecord)
    .slice(-LAUNCHER_RESOLUTION_CACHE_MAX_RECORDS);
};

const stateOf = (): TCacheState => {
  const file = launcherResolutionCacheFilePath();
  if (cacheState === null || cacheState.file !== file) {
    cacheState = {
      file,
      dir: stateDir(),
      memory: new Map(),
      persistLoaded: false,
      persistLocked: false,
      persistQueued: false,
    };
  }
  return cacheState;
};

const loadPersist = (st: TCacheState): void => {
  if (st.persistLoaded) return;
  st.persistLoaded = true;
  try {
    const info = statSync(st.file);
    if (info.size > MAX_FILE_BYTES) return;
  } catch {
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(st.file, "utf-8");
  } catch {
    return;
  }
  if (raw.length > MAX_FILE_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  for (const rec of coerceFile(parsed)) {
    st.memory.set(rec.candidate, rec);
  }
};

const writePersistAtomic = (
  st: TCacheState,
  records: readonly TLauncherResolutionPersistRecord[],
): void => {
  persistTmpSeq += 1;
  const tmp = join(
    st.dir,
    `.launcher-resolution-cache.json.${process.pid}.${persistTmpSeq}.tmp`,
  );
  const body: TPersistFile = { v: SCHEMA_V, records };
  try {
    mkdirSync(st.dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, st.file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
};

const flushPersist = (st: TCacheState): void => {
  if (st.persistLocked) {
    st.persistQueued = true;
    return;
  }
  st.persistLocked = true;
  try {
    do {
      st.persistQueued = false;
      writePersistAtomic(
        st,
        [...st.memory.values()].slice(-LAUNCHER_RESOLUTION_CACHE_MAX_RECORDS),
      );
    } while (st.persistQueued);
  } finally {
    st.persistLocked = false;
  }
};

export const recordToResolution = (
  rec: TLauncherResolutionPersistRecord,
): TLauncherResolution => ({
  kind: rec.kind,
  path: rec.path,
  fingerprint: rec.fingerprint,
  underManagerRoot: rec.underManagerRoot,
  ...(rec.adapterId !== null ? { adapterId: rec.adapterId } : {}),
  ...(rec.interpreter !== null ? { interpreter: rec.interpreter } : {}),
});

export const resolutionToRecord = (
  candidate: string,
  resolution: TLauncherResolution,
  resolvedAt: number = Date.now(),
): TLauncherResolutionPersistRecord => ({
  candidate,
  path: resolution.path,
  kind: resolution.kind,
  adapterId: resolution.adapterId ?? null,
  interpreter: resolution.interpreter ?? null,
  fingerprint: resolution.fingerprint,
  underManagerRoot: resolution.underManagerRoot,
  resolvedAt,
});

/** Ensure disk is loaded into the process-local map; return a snapshot. */
export const loadLauncherResolutionCache =
  (): readonly TLauncherResolutionPersistRecord[] => {
    const st = stateOf();
    loadPersist(st);
    return [...st.memory.values()];
  };

export const peekPersistedLauncherResolution = (
  candidate: string,
): TLauncherResolution | undefined => {
  const st = stateOf();
  loadPersist(st);
  const rec = st.memory.get(candidate);
  return rec === undefined ? undefined : recordToResolution(rec);
};

export const persistLauncherResolution = (
  candidate: string,
  resolution: TLauncherResolution,
): void => {
  const st = stateOf();
  loadPersist(st);
  st.memory.set(candidate, resolutionToRecord(candidate, resolution));
  if (st.memory.size > LAUNCHER_RESOLUTION_CACHE_MAX_RECORDS) {
    const first = st.memory.keys().next().value;
    if (first !== undefined && first !== candidate) st.memory.delete(first);
  }
  flushPersist(st);
};

export const dropPersistedLauncherResolution = (candidate: string): void => {
  const st = stateOf();
  loadPersist(st);
  if (!st.memory.has(candidate)) return;
  st.memory.delete(candidate);
  flushPersist(st);
};
