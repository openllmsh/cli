/**
 * Owner-only atomic JSON/text writes for doctor-report state.
 * Interrupted writes must not leave a half-decoded checkpoint.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../env";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const doctorStateDir = (): string => stateDir();

export const doctorStatePath = (basename: string): string =>
  join(doctorStateDir(), basename);

type TAtomicWrite = (path: string, contents: string) => boolean;

let atomicWriteForTests: TAtomicWrite | null = null;

export const setAtomicWriteForTests = (fn: TAtomicWrite | null): void => {
  atomicWriteForTests = fn;
};

export const ensureDoctorStateDir = (): void => {
  mkdirSync(doctorStateDir(), { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(doctorStateDir(), DIR_MODE);
  } catch {
    // best-effort on platforms that ignore chmod
  }
};

export const readTextFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export const atomicWriteText = (path: string, contents: string): boolean => {
  if (atomicWriteForTests !== null) return atomicWriteForTests(path, contents);
  try {
    ensureDoctorStateDir();
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", FILE_MODE);
    try {
      writeFileSync(fd, contents, { encoding: "utf8" });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, FILE_MODE);
    } catch {
      // ignore
    }
    renameSync(tmp, path);
    try {
      chmodSync(path, FILE_MODE);
    } catch {
      // ignore
    }
    return true;
  } catch {
    return false;
  }
};

export const removeFile = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // missing is fine
  }
};

export const parentDir = (path: string): string => dirname(path);
