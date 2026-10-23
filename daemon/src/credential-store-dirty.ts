/**
 * Cheap credential-store dirtiness for the status watcher.
 *
 * Heartbeat-only ticks must not call `delegate.status()` / keychain observe
 * (demand-driven auth). They still need a backstop for *external* credential
 * changes the auth sink never saw. This module only `statSync`s known store
 * paths (and Darwin keychain files) — never `security(1)`, never vendor CLIs.
 *
 * Call {@link markCredentialStoresDirtyIfChanged} on every watcher poll *before*
 * {@link statusWatcherGate.consumeWatcherCompute} so a changed fingerprint
 * becomes a full dirty tick instead of a probe-skipping heartbeat.
 */

import { readdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { readRoster } from "./account-roster";
import type { TCliProvider } from "./cli-paths";
import { CLI_PROVIDERS, cliConfigDir, cliHome } from "./cli-paths";
import { keychainStoreIdentity } from "./delegation/keychain";
import {
  fileStoreIdentity,
  fingerprintStoreIdentity,
} from "./delegation/observation-cache";
import { markStatusDirty } from "./status-dirty";

const MAC = platform() === "darwin";

const kimiCredentialFingerprints = (configDir: string): string[] => {
  const dir = join(configDir, "credentials");
  try {
    return readdirSync(dir)
      .filter((name) => /^kimi-code(?:-env-[0-9a-f]{16})?\.json$/.test(name))
      .map((name) =>
        fingerprintStoreIdentity(fileStoreIdentity(join(dir, name))),
      );
  } catch {
    return [fingerprintStoreIdentity(fileStoreIdentity(dir))];
  }
};

/** Snapshot of isolated credential-store identities (stat only). */
export const credentialStoreFingerprint = (): string => {
  const parts: string[] = [];
  for (const provider of CLI_PROVIDERS) {
    for (const { index } of readRoster(provider).accounts) {
      parts.push(...accountStoreFingerprints(provider, index));
    }
  }
  return parts.join("\n");
};

/** Stat-only identities of one provider account's credential store. */
const accountStoreFingerprints = (
  provider: TCliProvider,
  index: number,
): string[] => {
  const parts: string[] = [];
  {
    const config = cliConfigDir(provider, undefined, index);
    const home = cliHome(provider, undefined, index);
    switch (provider) {
      case "claude_code":
        if (MAC) {
          parts.push(fingerprintStoreIdentity(keychainStoreIdentity(home)));
        }
        parts.push(
          fingerprintStoreIdentity(
            fileStoreIdentity(join(config, ".credentials.json")),
          ),
        );
        break;
      case "chatgpt":
      case "grok":
      case "muse":
        parts.push(
          fingerprintStoreIdentity(
            fileStoreIdentity(join(config, "auth.json")),
          ),
        );
        break;
      case "cursor":
        if (MAC) {
          parts.push(fingerprintStoreIdentity(keychainStoreIdentity(home)));
        }
        parts.push(
          fingerprintStoreIdentity(
            fileStoreIdentity(join(config, "auth.json")),
          ),
        );
        break;
      case "kimi_code":
        parts.push(...kimiCredentialFingerprints(config));
        break;
      case "antigravity":
        parts.push(
          fingerprintStoreIdentity(
            fileStoreIdentity(
              join(config, "antigravity-acp", "acp_token.json"),
            ),
          ),
        );
        break;
      default: {
        const _exhaustive: never = provider;
        void _exhaustive;
        break;
      }
    }
  }
  return parts;
};

let lastFingerprint: string | null = null;

/**
 * If any watched credential store identity changed since the last check,
 * mark status dirty with reason `auth`. Always refreshes the baseline so a
 * subsequent compute / heartbeat does not re-fire on the same snapshot.
 * Returns whether dirtiness was marked.
 */
export const markCredentialStoresDirtyIfChanged = (): boolean => {
  const next = credentialStoreFingerprint();
  if (lastFingerprint === null) {
    lastFingerprint = next;
    return false;
  }
  if (next === lastFingerprint) return false;
  lastFingerprint = next;
  markStatusDirty("auth");
  return true;
};

/** Drop the baseline so the next check re-baselines (watcher stop). */
export const resetCredentialStoreFingerprint = (): void => {
  lastFingerprint = null;
};
