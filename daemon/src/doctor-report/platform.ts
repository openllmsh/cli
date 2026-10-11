import { readFileSync } from "node:fs";
import type { TDoctorArchitecture, TDoctorPlatform } from "@openllmsh/protocol";

type TDoctorOsStamp = {
  readonly os_version?: string;
  readonly os_build?: string;
};

const SYSTEM_VERSION_PLIST = "/System/Library/CoreServices/SystemVersion.plist";

const plistString = (xml: string, key: string): string | undefined =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,32})</string>`).exec(
    xml,
  )?.[1];

let osStamp: TDoctorOsStamp | null = null;

/**
 * macOS product version + build, read once from SystemVersion.plist (a file
 * read — no subprocess). Store behaviour changes per OS release (macOS 27
 * refuses reserved-name keychains), so every diagnostic carries it. Values are
 * validated by the protocol projection; anything unexpected is dropped.
 */
export const doctorOsStamp = (): TDoctorOsStamp => {
  if (osStamp !== null) return osStamp;
  let stamp: TDoctorOsStamp = {};
  if (process.platform === "darwin") {
    try {
      const xml = readFileSync(SYSTEM_VERSION_PLIST, "utf8");
      const os_version = plistString(xml, "ProductVersion");
      const os_build = plistString(xml, "ProductBuildVersion");
      stamp = {
        ...(os_version !== undefined ? { os_version } : {}),
        ...(os_build !== undefined ? { os_build } : {}),
      };
    } catch {
      // Unreadable: omit rather than guess.
    }
  }
  osStamp = stamp;
  return stamp;
};

export const doctorPlatform = (): TDoctorPlatform | null => {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return null;
};

export const doctorArchitecture = (): TDoctorArchitecture | null => {
  const a = process.arch;
  if (a === "arm64" || a === "x64") return a;
  return null;
};
