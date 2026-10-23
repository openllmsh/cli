/**
 * `openllm exec memory import` — copy memories the user already keeps in
 * files (Claude Code's auto-memory folder, or any Markdown they point at) into
 * OpenLLM memory. The files are only read, never moved or changed, so the
 * user's own memory keeps working next to ours.
 *
 * One file becomes one memory. The gateway keys a memory on its content, so a
 * re-run saves nothing twice.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CLI_VERSION } from "../cli-version";
import { cliConfig, userHome } from "../env";
import { MemoryClient } from "../mcp/memory/client";
import { memoryProject } from "./transcript";

const MAX_CONTENT_LENGTH = 200_000;
const INDEX_FILE = "MEMORY.md";

export const MEMORY_IMPORT_USAGE = `usage: openllm exec memory import [path ...] [--project <slug>] [--dry-run]

Import existing memories into OpenLLM. Each Markdown file becomes one memory;
your files are read only, never changed. With no path, imports Claude Code's
auto-memory folder for the current directory. --project defaults to the
current repo. Re-running is safe: identical memories are not saved twice.
`;

export type TMemoryImportItem = {
  readonly path: string;
  readonly content: string;
};

export type TMemoryImportDeps = {
  readonly cwd: () => string;
  readonly env: (name: string) => string | undefined;
  readonly home: () => string;
  readonly isDirectory: (path: string) => boolean;
  readonly listDir: (path: string) => readonly string[];
  readonly readFile: (path: string) => string;
  readonly save: (
    content: string,
    project: string,
  ) => Promise<{ readonly reused: boolean }>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/** Claude Code names a project's folder after its cwd, every non-alphanumeric → `-`. */
export const claudeMemoryDir = (cwd: string, configDir: string): string =>
  join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), "memory");

/** Strip YAML frontmatter; a file with no body keeps its `description`. */
export const memoryContentOf = (text: string): string => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return text.trim();
  const body = text.slice(match[0].length).trim();
  if (body) return body;
  const description = /^description:\s*(.+)$/m.exec(match[1]);
  return description ? description[1].trim().replace(/^["']|["']$/g, "") : "";
};

/** A `MEMORY.md` made only of `- [Title](file.md) — hook` lines is an index, not a memory. */
const isIndex = (text: string): boolean => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        /^\s*[-*]\s*\[[^\]]+\]\([^)]+\)/.test(line) || /^#/.test(line.trim()),
    )
  );
};

export const createMemoryImport = (deps: TMemoryImportDeps) => {
  const collect = (path: string, explicit: boolean): TMemoryImportItem[] => {
    if (deps.isDirectory(path)) {
      return [...deps.listDir(path)]
        .sort()
        .flatMap((name) => collect(join(path, name), false));
    }
    if (!explicit && extname(path).toLowerCase() !== ".md") return [];
    const text = deps.readFile(path);
    if (basename(path) === INDEX_FILE && isIndex(text)) return [];
    const content = memoryContentOf(text);
    return content ? [{ path, content }] : [];
  };

  const run = async (args: readonly string[]): Promise<number> => {
    const paths: string[] = [];
    let project: string | undefined;
    let dryRun = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--dry-run") dryRun = true;
      else if (arg === "--project") {
        project = args[++i];
        if (!project || project.startsWith("-")) {
          deps.err(MEMORY_IMPORT_USAGE);
          return 2;
        }
      } else if (arg === "-h" || arg === "--help") {
        deps.out(MEMORY_IMPORT_USAGE);
        return 0;
      } else if (arg.startsWith("-")) {
        deps.err(MEMORY_IMPORT_USAGE);
        return 2;
      } else paths.push(arg);
    }
    const cwd = deps.cwd();
    if (paths.length === 0) {
      paths.push(
        claudeMemoryDir(
          cwd,
          deps.env("CLAUDE_CONFIG_DIR") ?? join(deps.home(), ".claude"),
        ),
      );
    }
    const slug = memoryProject(cwd, project);

    const items: TMemoryImportItem[] = [];
    for (const path of paths) {
      try {
        items.push(...collect(path, true));
      } catch {
        deps.err(`[openllm] cannot read ${path}`);
        return 1;
      }
    }
    if (items.length === 0) {
      deps.out(`No memories found in ${paths.join(", ")}`);
      return 0;
    }

    let saved = 0;
    let reused = 0;
    let failed = 0;
    for (const item of items) {
      if (item.content.length > MAX_CONTENT_LENGTH) {
        deps.err(
          `skipped ${item.path}: longer than ${MAX_CONTENT_LENGTH} characters`,
        );
        failed++;
        continue;
      }
      if (dryRun) {
        deps.out(`would import ${item.path} → ${slug}`);
        continue;
      }
      try {
        const res = await deps.save(item.content, slug);
        if (res.reused) reused++;
        else saved++;
      } catch {
        // Never interpolate the error: upstream messages may carry secrets.
        deps.err(`failed ${item.path}`);
        failed++;
      }
    }
    if (dryRun) {
      deps.out(`${items.length} memories would be imported into "${slug}"`);
    } else {
      deps.out(
        `Imported ${saved} memories into "${slug}"${reused ? ` (${reused} already there)` : ""}${failed ? `, ${failed} failed` : ""}`,
      );
    }
    return failed ? 1 : 0;
  };

  return { collect, run };
};

/** Production wiring: real filesystem, gateway client from the CLI config. */
export const runMemoryImport = async (
  args: readonly string[],
): Promise<number> => {
  const config = cliConfig();
  const dryRun =
    args.includes("--dry-run") ||
    args.includes("-h") ||
    args.includes("--help");
  if (!dryRun && (!config.apiKey || !config.gatewayUrl)) {
    process.stderr.write(
      "[openllm] not logged in — run `openllm login` first\n",
    );
    return 1;
  }
  const client = new MemoryClient({
    name: "openllm-memory",
    version: CLI_VERSION,
    gatewayUrl: config.gatewayUrl,
    gatewayApiKey: config.apiKey,
  });
  return createMemoryImport({
    cwd: () => process.cwd(),
    env: (name) => process.env[name],
    home: userHome,
    isDirectory: (path) => statSync(path).isDirectory(),
    listDir: (path) => readdirSync(path),
    readFile: (path) => readFileSync(path, "utf8"),
    save: (content, project) => client.save(content, { project }),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).run(args);
};
