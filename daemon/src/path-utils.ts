/**
 * Shared filesystem-path helpers for the daemon.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";

/**
 * Standard user bin dirs the daemon prepends to a spawned integration's PATH.
 * The daemon runs as a background service with a minimal inherited PATH, so
 * user-installed CLIs the bundled scripts call (`claude` lands in ~/.local/bin;
 * `bun` lands in ~/.bun/bin via the official installer; many tools live under
 * Homebrew) aren't found and a script that relies on one half-applies or acks
 * `status:error`. Every entry is within the OS-sandbox working set (`/opt`,
 * `/usr`, ~/.local/bin, ~/.bun — see `sandbox/working-set/`), so a spawn never
 * hits a Landlock denial; absent dirs are simply ignored by the shell.
 *
 * Computed per call (not module-load) so a test that overrides `HOME` sees the
 * overridden dirs — production HOME is stable for the process lifetime.
 */
export const defaultBinDirs = (): readonly string[] => [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  `${homedir()}/.local/bin`,
  `${homedir()}/.bun/bin`,
];

/** @deprecated Prefer {@link defaultBinDirs}; kept as a snapshot alias. */
export const DEFAULT_BIN_DIRS: readonly string[] = defaultBinDirs();

/** Directories the daemon searches when resolving a command on its spawn PATH. */
export const spawnPathDirs = (): string[] =>
  [
    ...(process.env.PATH?.split(delimiter) ?? []),
    ...defaultBinDirs(),
    "/usr/bin",
    "/bin",
  ].filter((d) => d.length > 0);

/**
 * Every existing location of `cmd` across the daemon's effective search space,
 * in priority order — a multi-hit `which -a` that doesn't depend on a shell.
 * Scans (deduped): the process's own PATH entries, then {@link defaultBinDirs}
 * (the daemon's minimal service PATH often lacks the user dirs), then the
 * system dirs (`/usr/bin`, `/bin`) so a system-wide / distro / sudo install is
 * always found. Existence-checked only — callers exec the result, so a
 * non-executable hit fails loudly there rather than being silently skipped.
 */
export const resolveOnPath = (cmd: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of spawnPathDirs()) {
    const p = join(dir, cmd);
    if (seen.has(p)) continue;
    seen.add(p);
    if (existsSync(p)) out.push(p);
  }
  return out;
};

export type THostCliKind = "native" | "script";

export type THostCliRuntime = {
  readonly kind: THostCliKind;
  /** Interpreter basename for a script shebang; null for a native binary. */
  readonly interpreter: string | null;
  /** Whether that interpreter resolves on the daemon spawn PATH (native: true). */
  readonly interpreterResolved: boolean;
};

const SHEBANG_READ_BYTES = 512;

/**
 * Parse `#!…` into the interpreter the kernel/`env` would try to exec.
 * Supports `#!/usr/bin/env node`, `#!/usr/bin/env -S node --flag`, and absolute
 * interpreters. Returns null when the file is not a shebang script.
 */
export const parseShebangInterpreter = (shebangLine: string): string | null =>
  parseShebang(shebangLine)?.interpreter ?? null;

type TShebang = {
  readonly interpreter: string;
  /** `PATH=` assigned by `env` before the command, if any. */
  readonly envPath: string | null;
};

const parseShebang = (shebangLine: string): TShebang | null => {
  const trimmed = shebangLine.trimEnd();
  if (!trimmed.startsWith("#!")) return null;
  const body = trimmed.slice(2).trim();
  if (body.length === 0) return null;
  const tokens = body.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const prog = tokens[0];
  if (prog === undefined) return null;
  if (basename(prog) === "env") {
    let i = 1;
    let envPath: string | null = null;
    // `env -S` / `env -i` / `env --split-string` — skip short flags until the
    // command name. Unknown long options stop the scan rather than invent one.
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === undefined) break;
      if (t === "-S" || t === "--split-string") {
        i += 1;
        continue;
      }
      // `-u NAME` / `-C DIR` take a separate value; skip both tokens.
      if (t === "-u" || t === "-C") {
        i += 2;
        continue;
      }
      // `NAME=value` environment assignments precede the command.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        if (t.startsWith("PATH=")) envPath = t.slice("PATH=".length);
        i += 1;
        continue;
      }
      if (t.startsWith("-") && !t.startsWith("--")) {
        i += 1;
        continue;
      }
      break;
    }
    const cmd = tokens[i];
    return cmd !== undefined && cmd.length > 0
      ? { interpreter: cmd, envPath }
      : null;
  }
  return { interpreter: prog, envPath: null };
};

const readShebangLine = (binPath: string): string | null => {
  let fd: number | null = null;
  try {
    // Directories / FIFOs / devices are never a host CLI — and opening a FIFO
    // would block discovery.
    if (!statSync(binPath).isFile()) return null;
    // Read only the header: a native CLI can be hundreds of MB.
    fd = openSync(binPath, "r");
    const buf = Buffer.alloc(SHEBANG_READ_BYTES);
    const read = readSync(fd, buf, 0, SHEBANG_READ_BYTES, 0);
    const slice = buf.subarray(0, read);
    if (slice.length < 2 || slice[0] !== 0x23 || slice[1] !== 0x21) {
      return null;
    }
    let end = slice.length;
    for (let i = 2; i < slice.length; i += 1) {
      if (slice[i] === 0x0a) {
        end = i;
        break;
      }
    }
    return Buffer.from(slice.subarray(0, end)).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

const interpreterResolves = (
  interpreter: string,
  envPath: string | null,
): boolean => {
  if (isAbsolute(interpreter)) return existsSync(interpreter);
  // `env PATH=…` searches only the assigned PATH, not the daemon's.
  if (envPath !== null) {
    return envPath
      .split(delimiter)
      .filter((d) => d.length > 0)
      .some((d) => existsSync(join(d, interpreter)));
  }
  return resolveOnPath(interpreter).length > 0;
};

/**
 * Classify a host CLI candidate as a native binary or a shebang script, and
 * whether its interpreter is on the daemon's spawn PATH. Returns null when the
 * path cannot be read (absent / unreadable) — callers treat that as unusable.
 */
export const inspectHostCliRuntime = (
  binPath: string,
): THostCliRuntime | null => {
  if (!existsSync(binPath)) return null;
  try {
    if (!statSync(binPath).isFile()) return null;
  } catch {
    return null;
  }
  const shebang = readShebangLine(binPath);
  if (shebang === null) {
    return {
      kind: "native",
      interpreter: null,
      interpreterResolved: true,
    };
  }
  const parsed = parseShebang(shebang);
  if (parsed === null) {
    // Shebang present but unparseable — do not treat as a usable host CLI.
    return {
      kind: "script",
      interpreter: null,
      interpreterResolved: false,
    };
  }
  return {
    kind: "script",
    interpreter: basename(parsed.interpreter),
    interpreterResolved: interpreterResolves(
      parsed.interpreter,
      parsed.envPath,
    ),
  };
};

/** True when a host CLI can actually be spawned under the daemon's PATH. */
export const isHostCliRunnable = (binPath: string): boolean => {
  const runtime = inspectHostCliRuntime(binPath);
  if (runtime === null) return false;
  return runtime.kind === "native" || runtime.interpreterResolved;
};

/**
 * Captured vendor-CLI output that means the shebang interpreter was missing
 * (`env: node: No such file or directory`, busybox `exec: node: not found`).
 */
export const isCliRuntimeMissingOutput = (captured: string): boolean =>
  /\benv:\s+\S+:\s+No such file or directory/i.test(captured) ||
  /\bexec:\s+\S+:\s+not found/i.test(captured);
