/**
 * `openllm doctor [--scrub-legacy]` — report (and optionally clean up) state
 * left behind by the pre-runtime-merge model.
 *
 * Before this refactor, installing a client wrote managed regions into the
 * user's own config, stamped install digests under `~/.openllm/installed/` and
 * `state.json`, and kept write-once backups (which held a live `sk-llm` key
 * forever). None of that is produced any more, but existing machines still
 * carry it, so `doctor` finds it and — only when asked — removes it.
 *
 * Deliberately conservative: the default is a REPORT. `--scrub-legacy` removes
 * only OpenLLM-owned paths and OpenLLM-authored managed regions; the user's own
 * settings inside those files are preserved.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeRegion } from "./clients/merge";
import { openllmDir, userHome } from "./env";

/** OpenLLM-owned paths the old install model created. */
const legacyPaths = (): readonly string[] => [
  join(openllmDir(), "installed"),
  join(openllmDir(), "backups"),
  join(openllmDir(), "state.json"),
  join(openllmDir(), "setup"),
  join(userHome(), ".claude", "plugins", "openllm"),
];

/**
 * Files the old installers wrote a managed region into, with the marker pair
 * used in each. Only the region is removed — everything else is the user's.
 */
const legacyRegions = (): readonly {
  path: string;
  begin: string;
  end: string;
}[] => {
  const home = userHome();
  return [
    {
      path: join(home, ".claude", "CLAUDE.md"),
      begin: "<!-- >>> openllm (managed) >>> -->",
      end: "<!-- <<< openllm (managed) <<< -->",
    },
    {
      path: join(home, ".codex", "config.toml"),
      begin: "# >>> openllm (managed) >>>",
      end: "# <<< openllm (managed) <<<",
    },
    {
      path: join(home, ".grok", "config.toml"),
      begin: "# >>> openllm-ext (managed) >>>",
      end: "# <<< openllm-ext (managed) <<<",
    },
  ];
};

/** Sibling backups the old installers left next to a user's config. */
const legacyBackups = (): readonly string[] => {
  const home = userHome();
  return [
    join(home, ".codex", "config.toml.openllm-bak"),
    join(home, ".config", "raycast", "ai", "providers.yaml.openllm-bak"),
    join(home, ".openllm", "cli.env"),
  ];
};

/** A transitional/legacy binary name that should no longer be primary. */
const legacyBinary = (): string => join(openllmDir(), "bin", "openllmc");

const DOCTOR_USAGE = `usage: openllm doctor [--scrub-legacy]

Report state left over from the old install model (managed regions inside your
client configs, install stamps, key-bearing backups, a legacy openllmc binary).

  openllm doctor                 report only — changes nothing
  openllm doctor --scrub-legacy  remove the OpenLLM-owned leftovers

Scrubbing removes only OpenLLM's own paths and its managed regions; your own
settings in those files are kept.
`;

export const runDoctor = (args: readonly string[]): number => {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(DOCTOR_USAGE);
    return 0;
  }
  const scrub = args.includes("--scrub-legacy");
  const found: string[] = [];

  for (const path of legacyPaths()) {
    if (!existsSync(path)) continue;
    found.push(path);
    if (scrub) rmSync(path, { recursive: true, force: true });
  }

  for (const backup of legacyBackups()) {
    if (!existsSync(backup)) continue;
    found.push(`${backup} (may contain an API key)`);
    if (scrub) rmSync(backup, { force: true });
  }

  for (const { path, begin, end } of legacyRegions()) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    if (!text.includes(begin)) continue;
    found.push(`${path} (OpenLLM managed region)`);
    if (!scrub) continue;
    const next = removeRegion(text, begin, end);
    if (next === null) {
      process.stdout.write(
        `  ! ${path} has an unbalanced region — left untouched, remove it by hand\n`,
      );
      continue;
    }
    try {
      writeFileSync(path, next);
    } catch {
      process.stdout.write(`  ! ${path} is not writable — left untouched\n`);
    }
  }

  const legacyBin = legacyBinary();
  if (existsSync(legacyBin)) {
    found.push(`${legacyBin} (legacy openllmc name)`);
    // Left in place even when scrubbing: it is the transitional compat symlink
    // that keeps older MCP entries and scripts working for one major.
  }

  if (found.length === 0) {
    process.stdout.write("✓ Nothing left over from the old install model.\n");
    return 0;
  }

  process.stdout.write(
    scrub
      ? `Removed ${found.length} leftover item(s):\n`
      : `Found ${found.length} leftover item(s) from the old install model:\n`,
  );
  for (const item of found) process.stdout.write(`  - ${item}\n`);
  if (!scrub) {
    process.stdout.write(
      "\nOpenLLM no longer edits client configs — run a client with\n" +
        "`openllm claude` (or codex / grok / opencode) instead.\n" +
        "Remove the leftovers with: openllm doctor --scrub-legacy\n",
    );
  }
  return 0;
};
