/**
 * Process-local remembered launcher profile + interpreter dir, keyed by
 * provider. Kept in its own dependency-free module so `cli-paths` can read
 * the interpreter dir without importing the full resolver (which would
 * cycle through manager-resolution → spawn → … → cli-paths).
 */
import { dirname } from "node:path";
import type {
  TLauncherProfile,
  TLauncherResolution,
} from "./launcher-resolution-types";
import { launcherProfileOf } from "./launcher-resolution-types";

const providerInterpreterDirs = new Map<string, string>();
const providerProfiles = new Map<string, TLauncherProfile>();

export const rememberInterpreterDir = (
  providerKey: string,
  interpreterPath: string | undefined,
): void => {
  if (interpreterPath === undefined) {
    providerInterpreterDirs.delete(providerKey);
    return;
  }
  providerInterpreterDirs.set(providerKey, dirname(interpreterPath));
};

export const interpreterDirFor = (providerKey: string): string | undefined =>
  providerInterpreterDirs.get(providerKey);

export const rememberLauncherProfile = (
  providerKey: string,
  resolution: TLauncherResolution | null,
): void => {
  if (resolution === null) {
    providerProfiles.delete(providerKey);
    return;
  }
  providerProfiles.set(providerKey, launcherProfileOf(resolution));
};

export const launcherProfileFor = (
  providerKey: string,
): TLauncherProfile | undefined => providerProfiles.get(providerKey);
