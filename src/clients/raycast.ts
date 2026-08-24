/**
 * Raycast — the one ALWAYS-ON client (proposal §3.4.2 / §5.5).
 *
 * Raycast is a long-lived macOS app: it reads `providers.yaml` from a fixed
 * path plus its own UserDefaults, and there is no env var or flag that points
 * it at a private overlay. Session merge is therefore impossible, so this is
 * the single place in the product that writes a third-party config — and it
 * does so only when the user runs `openllm raycast`.
 *
 * The rules that keep that safe:
 *
 *   - user-initiated only (nothing in install / auto-update / the daemon
 *     control channel reaches this code),
 *   - idempotent apply (a managed region, replaced in place on re-run),
 *   - an exact reverse via `openllm raycast uninstall`, computed from an
 *     OWNERSHIP LEDGER under `~/.openllm/clients/raycast.json` rather than
 *     from a snapshot backup, so we only ever undo what we actually changed,
 *   - no key-bearing backup file is ever created.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CLI_VERSION, openllmDir, userHome } from "../env";
import { contextStateDir, fetchModelCatalog, resolveGateway } from "./gateway";
import { removeRegion, substitute, upsertRegion } from "./merge";
import { OVERLAYS } from "./overlays";
import type { TClientFlags } from "./registry";

const REGION_BEGIN = "# >>> openllm (managed) >>>";
const REGION_END = "# <<< openllm (managed) <<<";

/** Raycast's UserDefaults domain + the keys we may touch. */
const DOMAIN = "com.raycast.macos";
const EXPERIMENTAL_KEY = "aiExperimentalFeatures";
const DISABLED_KEY = "aiDisabledModels";
const CUSTOM_PROVIDERS = "customProviders";
/** Prefix of the model ids Raycast derives for our provider. */
const OUR_MODEL_PREFIX = "custom-router-openllm/";

const providersPath = (): string =>
  process.env.OPENLLM_RAYCAST_PROVIDERS ??
  join(userHome(), ".config", "raycast", "ai", "providers.yaml");

const ledgerPath = (): string => join(openllmDir(), "clients", "raycast.json");

/**
 * Fallback tier-alias window when the live catalog is unavailable. Report the
 * highest limit and let the OpenLLM proxy own compaction (aligns with the grok
 * overlay + Claude's CLAUDE_CODE_MAX_CONTEXT_TOKENS).
 */
const FALLBACK_CONTEXT = 1_000_000;

/** Fallback `models:` block when the live catalog is unavailable. */
const FALLBACK_MODELS = [
  '      - id: "ultra"',
  '        name: "Ultra (OpenLLM)"',
  `        context: ${FALLBACK_CONTEXT}`,
  '      - id: "plus"',
  '        name: "Plus (OpenLLM)"',
  `        context: ${FALLBACK_CONTEXT}`,
  '      - id: "lite"',
  '        name: "Lite (OpenLLM)"',
  `        context: ${FALLBACK_CONTEXT}`,
].join("\n");

/**
 * What `openllm raycast` changed, so `uninstall` can reverse exactly that.
 * Recorded under ~/.openllm/ (ours), never inside Raycast's own files.
 */
export type TRaycastLedger = {
  readonly version: 1;
  readonly cli_version: string;
  readonly providers_path: string;
  readonly api_base: string;
  readonly model_count: number;
  readonly prefs: {
    /** True only when WE added `customProviders` (it wasn't already on). */
    readonly added_custom_providers: boolean;
    /** OpenLLM model ids we removed from `aiDisabledModels`. */
    readonly removed_disabled_ids: readonly string[];
  };
};

const readLedger = (): TRaycastLedger | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as TRaycastLedger;
  } catch {
    return null;
  }
};

const writeLedger = (ledger: TRaycastLedger): void => {
  const path = ledgerPath();
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
};

/** Read Raycast's plist domain as JSON with `defaults export | plutil`. */
const readDefaultsArray = (key: string): string[] => {
  try {
    const plist = execFileSync("defaults", ["export", DOMAIN, "-"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
      encoding: "utf-8",
      input: plist,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const raw = parsed[key];
    return Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const writeDefaultsArray = (key: string, values: readonly string[]): void => {
  // No empty-array special case: spreading zero values already yields the
  // exact `defaults write <domain> <key> -array` that writes an empty array.
  execFileSync("defaults", ["write", DOMAIN, key, "-array", ...values], {
    stdio: "ignore",
  });
};

const isDarwin = (): boolean => process.platform === "darwin";

/**
 * Apply — idempotent. Returns a process exit code.
 *
 * `remote` (`-r`) picks which base URL gets BAKED into `providers.yaml`: the
 * local daemon (default) or the cloud origin. Unlike a session client this
 * choice persists until the next apply, because Raycast reads the file rather
 * than being relaunched — so re-run `openllm -r raycast` to switch it.
 */
export const applyRaycast = async (opts?: {
  readonly remote?: boolean;
}): Promise<number> => {
  if (!isDarwin()) {
    process.stderr.write("openllm raycast is macOS-only.\n");
    return 1;
  }
  const gateway = await resolveGateway({ remote: opts?.remote });
  if (gateway.apiKey.length === 0) {
    process.stderr.write(
      "No OpenLLM API key configured — set OPENLLM_API_KEY, or pair the daemon so ~/.openllm/.env carries it.\n",
    );
    return 1;
  }
  const catalog = await fetchModelCatalog(gateway, "raycast");
  const models = catalog ?? FALLBACK_MODELS;
  const block = substitute(
    OVERLAYS.raycast.providers.replace("{{MODELS}}", models),
    {
      OPENLLM_API_BASE: gateway.base,
      OPENLLM_API_KEY: gateway.apiKey,
      STATE_DIR: contextStateDir(),
    },
  )
    // Strip the authoring header comments — only the provider item belongs in
    // the user's file.
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .replace(/^\n+/, "");

  const path = providersPath();
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const next = renderProviders(existing, block);
  if (next === null) {
    process.stderr.write(
      `${path} has an unbalanced OpenLLM managed region — refusing to touch it.\n` +
        "Remove the stray marker by hand, then re-run.\n",
    );
    return 1;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, next, { mode: 0o600 });

  // Prefs: enable Custom Providers (else providers.yaml is ignored entirely)
  // and un-disable our models. Record ONLY what we actually changed.
  const prior = readLedger();
  let addedCustomProviders = prior?.prefs.added_custom_providers ?? false;
  let removedDisabled: string[] = [
    ...(prior?.prefs.removed_disabled_ids ?? []),
  ];
  try {
    const features = readDefaultsArray(EXPERIMENTAL_KEY);
    if (!features.includes(CUSTOM_PROVIDERS)) {
      writeDefaultsArray(EXPERIMENTAL_KEY, [...features, CUSTOM_PROVIDERS]);
      addedCustomProviders = true;
    }
    const disabled = readDefaultsArray(DISABLED_KEY);
    const ours = disabled.filter((id) => id.startsWith(OUR_MODEL_PREFIX));
    if (ours.length > 0) {
      writeDefaultsArray(
        DISABLED_KEY,
        disabled.filter((id) => !ours.includes(id)),
      );
      removedDisabled = [...new Set([...removedDisabled, ...ours])];
    }
  } catch {
    process.stdout.write(
      "  note: could not update Raycast preferences (Settings → AI → Custom Providers may need enabling by hand)\n",
    );
  }

  writeLedger({
    version: 1,
    cli_version: CLI_VERSION,
    providers_path: path,
    api_base: gateway.base,
    model_count: models.split("- id:").length - 1,
    prefs: {
      added_custom_providers: addedCustomProviders,
      removed_disabled_ids: removedDisabled,
    },
  });

  process.stdout.write(
    `✓ Raycast configured → ${path}\n` +
      `  gateway: ${gateway.base}${gateway.local ? " (local daemon)" : ""}\n` +
      "  Restart Raycast to reload providers.\n" +
      "  Remove again with: openllm raycast uninstall\n",
  );
  return 0;
};

/**
 * Insert or replace the managed provider item. The block must live UNDER the
 * top-level `providers:` key, so a fresh file gets that key and an existing one
 * has the region placed immediately after it.
 */
export const renderProviders = (
  existing: string,
  block: string,
): string | null => {
  if (existing.trim().length === 0) {
    return `providers:\n${REGION_BEGIN}\n${block.replace(/\n*$/, "")}\n${REGION_END}\n`;
  }
  // Re-apply: the region already exists somewhere — replace it in place.
  if (existing.includes(REGION_BEGIN) || existing.includes(REGION_END)) {
    return upsertRegion(existing, REGION_BEGIN, REGION_END, block);
  }
  const lines = existing.split("\n");
  const idx = lines.findIndex((l) => /^providers:\s*$/.test(l));
  const region = `${REGION_BEGIN}\n${block.replace(/\n*$/, "")}\n${REGION_END}`;
  if (idx < 0) {
    // No `providers:` key yet — append the whole structure.
    return `${existing.replace(/\n*$/, "\n")}providers:\n${region}\n`;
  }
  return `${[...lines.slice(0, idx + 1), region, ...lines.slice(idx + 1)].join("\n").replace(/\n*$/, "\n")}`;
};

/** Uninstall — the exact reverse of apply. Idempotent. */
export const uninstallRaycast = (): number => {
  const ledger = readLedger();
  const path = ledger?.providers_path ?? providersPath();
  let removed = false;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf-8");
    const next = removeRegion(existing, REGION_BEGIN, REGION_END);
    if (next === null) {
      process.stderr.write(
        `${path} has an unbalanced OpenLLM managed region — refusing to touch it.\n`,
      );
      return 1;
    }
    if (next !== existing) {
      writeFileSync(path, next, { mode: 0o600 });
      removed = true;
    }
  }

  // Reverse ONLY the prefs the ledger says we changed.
  let prefsRestored = true;
  if (ledger !== null && isDarwin()) {
    try {
      if (ledger.prefs.added_custom_providers) {
        const features = readDefaultsArray(EXPERIMENTAL_KEY);
        writeDefaultsArray(
          EXPERIMENTAL_KEY,
          features.filter((f) => f !== CUSTOM_PROVIDERS),
        );
      }
      if (ledger.prefs.removed_disabled_ids.length > 0) {
        const disabled = readDefaultsArray(DISABLED_KEY);
        const restore = ledger.prefs.removed_disabled_ids.filter(
          (id) => !disabled.includes(id),
        );
        if (restore.length > 0)
          writeDefaultsArray(DISABLED_KEY, [...disabled, ...restore]);
      }
    } catch {
      prefsRestored = false;
      process.stdout.write(
        "  note: could not restore Raycast preferences (they may need a manual check)\n",
      );
    }
  }

  if (prefsRestored) {
    rmSync(ledgerPath(), { force: true });
  }
  process.stdout.write(
    removed
      ? `✓ Removed OpenLLM from ${path}\n  Restart Raycast to reload providers.\n`
      : "Nothing to remove — OpenLLM is not applied to Raycast.\n",
  );
  return 0;
};

/** Status — one JSON line for scripts and the dashboard badge. */
export const statusRaycast = (): number => {
  const ledger = readLedger();
  const path = ledger?.providers_path ?? providersPath();
  const present =
    existsSync(path) && readFileSync(path, "utf-8").includes(REGION_BEGIN);
  process.stdout.write(
    `${JSON.stringify({
      installed: ledger !== null && present,
      cli_version: ledger?.cli_version ?? null,
      model_count: ledger?.model_count ?? null,
      api_base: ledger?.api_base ?? null,
      // A user who hand-deleted our block leaves a ledger with no region.
      stale_ledger: ledger !== null && !present,
    })}\n`,
  );
  return 0;
};

const RAYCAST_USAGE = `usage: openllm [-r] raycast [uninstall|status]

Raycast runs continuously and has no per-launch config hook, so OpenLLM is
applied to its config once:

  openllm raycast              apply / refresh (idempotent)
  openllm -r raycast           apply, baking the CLOUD gateway base URL
  openllm raycast uninstall    remove exactly what apply wrote
  openllm raycast status       report whether OpenLLM is wired in

The applied base URL defaults to your local daemon (127.0.0.1:8787). \`-r\`
bakes the cloud origin instead, which 307-redirects subscription hops back to a
live daemon. Because Raycast reads the FILE (it isn't relaunched per session),
that choice persists until the next apply — re-run to switch.

Re-run apply after adding models or providers. Restart Raycast afterwards.
`;

/** Dispatch for the always-on client. */
export const runRaycastCommand = async (
  args: readonly string[],
  flags?: TClientFlags,
): Promise<number> => {
  if (flags?.dangerous === true) {
    // Nothing is launched here, so there are no approval prompts to skip.
    // Ignoring it silently would imply it did something.
    process.stderr.write(
      "-d does not apply to raycast — it configures Raycast rather than launching it.\n",
    );
    return 2;
  }
  const verb = args[0];
  if (verb === undefined) return applyRaycast({ remote: flags?.remote });
  if (verb === "uninstall") return uninstallRaycast();
  if (verb === "status") return statusRaycast();
  if (verb === "-h" || verb === "--help") {
    process.stdout.write(RAYCAST_USAGE);
    return 0;
  }
  process.stderr.write(`unknown raycast verb "${verb}"\n\n${RAYCAST_USAGE}`);
  return 2;
};
