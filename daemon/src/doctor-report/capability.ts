import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  DOCTOR_LOCAL_CAPABILITY_FILENAME,
  DOCTOR_LOCAL_CAPABILITY_HEADER,
} from "@openllmsh/protocol";
import type { TAtomicWrite } from "./files";
import { atomicWriteText, doctorStatePath, readTextFile } from "./files";

export const doctorCapabilityPath = (): string =>
  doctorStatePath(DOCTOR_LOCAL_CAPABILITY_FILENAME);

/**
 * This process's view of the capability at one path. `failedClosed`: this
 * boot's mint failed after bind — do not honor a leftover file token. Scoped to
 * the path so a re-pointed state dir never inherits another dir's token.
 */
type TCapabilityState = {
  readonly path: string;
  readonly token: string | null;
  readonly failedClosed: boolean;
};

let capabilityState: TCapabilityState | null = null;

const currentState = (): TCapabilityState => {
  const path = doctorCapabilityPath();
  if (capabilityState?.path === path) return capabilityState;
  return { path, token: null, failedClosed: false };
};

export const doctorCapabilityHeaderName = (): string =>
  DOCTOR_LOCAL_CAPABILITY_HEADER;

export type TMintDoctorCapabilityOptions = {
  /** Override the durable write (fs-failure fixtures); defaults to the real fs path. */
  readonly atomicWrite?: TAtomicWrite;
};

/** Mint a per-boot owner-only capability. Local FS only — never network. */
export const mintDoctorCapability = (
  options?: TMintDoctorCapabilityOptions,
): boolean => {
  const token = randomBytes(32).toString("hex");
  const wrote = atomicWriteText(doctorCapabilityPath(), `${token}\n`, {
    ...(options?.atomicWrite !== undefined
      ? { write: options.atomicWrite }
      : {}),
  });
  const path = doctorCapabilityPath();
  if (!wrote) {
    capabilityState = { path, token: null, failedClosed: true };
    return false;
  }
  capabilityState = { path, token, failedClosed: false };
  return true;
};

/**
 * Rotate the capability only after the loopback listener is bound.
 * A failed bind must not clobber a live process's token.
 */
export const onDoctorListenAttempt = (
  bound: boolean,
  options?: TMintDoctorCapabilityOptions,
): boolean => {
  if (!bound) return false;
  return mintDoctorCapability(options);
};

export const readDoctorCapability = (): string | null => {
  const state = currentState();
  if (state.failedClosed) return null;
  if (state.token !== null) return state.token;
  const raw = readTextFile(doctorCapabilityPath());
  if (raw === null) return null;
  const token = raw.trim();
  if (token.length < 16) return null;
  capabilityState = { path: state.path, token, failedClosed: false };
  return token;
};

export const capabilityMatches = (presented: string | null): boolean => {
  const expected = readDoctorCapability();
  if (expected === null || presented === null) return false;
  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);
  if (expectedBytes.length !== presentedBytes.length) return false;
  return timingSafeEqual(expectedBytes, presentedBytes);
};

/** CLI read: owner-only regular file, never a symlink or an unbounded read. */
export const readOwnerDoctorCapability = (): string | null => {
  let fd: number | undefined;
  try {
    fd = openSync(
      doctorCapabilityPath(),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 256 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      return null;
    const token = readFileSync(fd, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
