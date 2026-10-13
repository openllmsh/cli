import { existsSync } from "node:fs";
import type { TDoctorLocalPreference } from "@openllmsh/protocol";
import {
  DOCTOR_LOCAL_OPT_OUT_FILENAME,
  parseDoctorLocalPreference,
} from "@openllmsh/protocol";
import type { TAtomicWrite } from "./files";
import {
  atomicWriteText,
  doctorStatePath,
  readTextFile,
  removeFile,
} from "./files";

export const doctorLocalPreferencePath = (): string =>
  doctorStatePath(DOCTOR_LOCAL_OPT_OUT_FILENAME);

export const readLocalPreference = (): TDoctorLocalPreference | null => {
  const raw = readTextFile(doctorLocalPreferencePath());
  if (raw === null) return null;
  try {
    return parseDoctorLocalPreference(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

export type TWriteLocalPreferenceOptions = {
  /** Override the durable write (fs-failure fixtures); defaults to the real fs path. */
  readonly atomicWrite?: TAtomicWrite;
};

export const writeLocalPreference = (
  pref: TDoctorLocalPreference,
  options?: TWriteLocalPreferenceOptions,
): boolean =>
  atomicWriteText(doctorLocalPreferencePath(), `${JSON.stringify(pref)}\n`, {
    ...(options?.atomicWrite !== undefined
      ? { write: options.atomicWrite }
      : {}),
  });

export const clearLocalPreference = (): void => {
  removeFile(doctorLocalPreferencePath());
};

/**
 * Machine-local disable is sticky across key/origin changes until explicit
 * local opt-in. Scope fields isolate pending *uploads*, not this kill switch.
 * A later key must not resume reporting after a keyless opt-out.
 */
export const localDisableSticky = (): boolean => {
  const pref = readLocalPreference();
  return pref === null
    ? existsSync(doctorLocalPreferencePath())
    : pref.enabled === false;
};
