/**
 * Shell completion for `openllm` — `openllm completion <bash|zsh|fish>`
 * emits a completion script; `openllm completion install` detects the
 * current shell (`$SHELL`) and wires it into the user's rc (idempotent).
 * Every subcommand, exec group/verb, flag, and shell is derived from the
 * shared definitions in `commands.ts`, so completion can't drift from the
 * actual CLI surface. The openllm twin of the daemon's `completion.ts`.
 *
 * The bash/zsh scripts are sourced dynamically (`source <(openllm
 * completion <shell>)`) so they always reflect the installed binary; fish
 * writes a static file into its completions dir.
 */
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { TCompletionShell } from "./commands";
import {
  CLIENT_FLAGS,
  COMMAND_ARGS,
  COMMANDS,
  COMPLETION_SHELLS,
  EXEC_GROUPS,
  EXEC_VERBS,
  FLAGS,
} from "./commands";
import { userHome } from "./env";

/** Top-level completion tokens: every subcommand + every flag alias. */
const TOP_LEVEL = [
  ...COMMANDS.map((c) => c.name),
  ...FLAGS.map((f) => f.name),
  // Client flags live BEFORE the subcommand, so they belong here.
  ...CLIENT_FLAGS.map((f) => f.name),
];
const HELP_FLAGS = ["-h", "--help"] as const;

const commandArgLines = (): ReadonlyArray<
  readonly [string, readonly string[]]
> =>
  COMMANDS.filter((command) => command.name !== "exec").map((command) => {
    const extra = COMMAND_ARGS[command.name] ?? [];
    return [command.name, [...extra, ...HELP_FLAGS]] as const;
  });

const bashScript = (): string => {
  const top = TOP_LEVEL.join(" ");
  const verbCases = EXEC_GROUPS.map(
    (g) =>
      `      ${g}) [ "$pos" -eq 3 ] && COMPREPLY=( $(compgen -W "${EXEC_VERBS[g].join(" ")}" -- "$cur") ) ;;`,
  ).join("\n");
  const argCases = commandArgLines()
    .map(
      ([command, args]) =>
        `    ${command}) COMPREPLY=( $(compgen -W "${args.join(" ")}" -- "$cur") ) ;;`,
    )
    .join("\n");
  // `-d|-r` — the alternation the flag-skipping loop matches on.
  const clientFlagPattern = CLIENT_FLAGS.map((f) => f.name).join("|");
  return `# openllm bash completion
_openllm() {
  local cur cmd off pos
  cur="\${COMP_WORDS[COMP_CWORD]}"
  # Our own flags sit BEFORE the client name (\`openllm -d -r claude …\`), so
  # skip them: the command is the first non-flag word, not always word 1.
  off=0
  while [ $((off + 1)) -lt "$COMP_CWORD" ]; do
    case "\${COMP_WORDS[off + 1]}" in
      ${clientFlagPattern}) off=$((off + 1)) ;;
      *) break ;;
    esac
  done
  cmd="\${COMP_WORDS[off + 1]}"
  if [ "$COMP_CWORD" -eq $((off + 1)) ]; then
    COMPREPLY=( $(compgen -W "${top}" -- "$cur") )
    return
  fi
  pos=$((COMP_CWORD - off))
  case "$cmd" in
${argCases}
    exec)
      if [ "$pos" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "${EXEC_GROUPS.join(" ")}" -- "$cur") )
        return
      fi
      case "\${COMP_WORDS[off + 2]}" in
${verbCases}
      esac ;;
  esac
}
complete -F _openllm openllm ollm
`;
};

/** Escape a value for a single-quoted shell string (`'` → `'\\''`). The
 *  descriptions are kept quote-free by convention (commands.ts), but a slip
 *  must degrade to a weird description, not a parse error in the user's rc. */
const zq = (s: string): string => s.replace(/'/g, `'\\''`);

const zshScript = (): string => {
  // Descriptions are colon-free (commands.ts), so the `value:desc` specs parse.
  const specs = [
    ...COMMANDS.map((c) => `'${zq(c.name)}:${zq(c.description)}'`),
    ...FLAGS.map((f) => `'${zq(f.name)}:${zq(f.description)}'`),
    ...CLIENT_FLAGS.map((f) => `'${zq(f.name)}:${zq(f.description)}'`),
  ].join("\n    ");
  const verbCases = EXEC_GROUPS.map(
    (g) => `      ${g}) _values 'verb' ${EXEC_VERBS[g].join(" ")} ;;`,
  ).join("\n");
  const clientFlagPattern = CLIENT_FLAGS.map((f) => f.name).join("|");
  // Hand-rolled over `_arguments -C '1:command:->cmd'`: our own flags sit
  // BEFORE the client name (`openllm -d -r claude …`), so word 1 is not
  // necessarily the command. Skip the leading flags, then dispatch on the
  // first non-flag word — otherwise completion dies after `-d`/`-r`.
  return `# openllm zsh completion
_openllm() {
  local -a _cmds
  _cmds=(
    ${specs}
  )
  local off=1 cmd pos
  while (( off + 1 < CURRENT )); do
    case "\${words[off + 1]}" in
      ${clientFlagPattern}) (( off++ )) ;;
      *) break ;;
    esac
  done
  cmd="\${words[off + 1]}"
  if (( CURRENT == off + 1 )); then
    _describe -t commands 'openllm command' _cmds
    return
  fi
  (( pos = CURRENT - off + 1 ))
  case "$cmd" in
${commandArgLines()
  .map(
    ([command, args]) => `    ${command}) _values 'arg' ${args.join(" ")} ;;`,
  )
  .join("\n")}
    exec)
      if (( pos == 3 )); then
        _values 'group' ${EXEC_GROUPS.join(" ")}
      else
        case "\${words[off + 2]}" in
${verbCases}
        esac
      fi ;;
  esac
}
compdef _openllm openllm ollm
`;
};

const fishScript = (): string => {
  const lines = COMMANDS.map(
    (c) =>
      `complete -c openllm -n __fish_use_subcommand -a ${c.name} -d '${zq(c.description)}'`,
  );
  lines.push(
    ...commandArgLines().map(
      ([command, args]) =>
        `complete -c openllm -n '__fish_seen_subcommand_from ${command}' -a '${args.join(" ")}'`,
    ),
    `complete -c openllm -n '__fish_seen_subcommand_from exec' -a '${EXEC_GROUPS.join(" ")}'`,
    ...EXEC_GROUPS.map(
      (g) =>
        `complete -c openllm -n '__fish_seen_subcommand_from ${g}' -a '${EXEC_VERBS[g].join(" ")}'`,
    ),
    `complete -c openllm -s h -l help -d 'Show help'`,
    `complete -c openllm -s v -l version -d 'Print the version'`,
  );
  // `ollm` wraps `openllm` — fish inherits every completion for the alias.
  return `# openllm fish completion\ncomplete -c openllm -f\n${lines.join("\n")}\ncomplete -c ollm --wraps openllm\n`;
};

export const completionScript = (shell: TCompletionShell): string => {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
  }
};

const isShell = (v: string): v is TCompletionShell =>
  (COMPLETION_SHELLS as readonly string[]).includes(v);

/** The marker every rc line we add carries, so removal is exact. */
const RC_MARKER = "# openllm-completion";

/** Suffix of the backup written before an rc file is replaced. */
export const RC_BACKUP_SUFFIX = ".openllm.bak";

/**
 * Resolve a chain of symlinks to the file the bytes must land on. A plain
 * `writeFileSync(path)` follows a symlink and writes the TARGET, so an
 * atomic write must do the same — renaming over `path` itself would replace
 * the user's link with a regular file. Bounded: a link loop returns the last
 * hop rather than spinning.
 */
const resolveWriteTarget = (path: string): string => {
  let current = path;
  for (let hop = 0; hop < 10; hop += 1) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      return current; // does not exist yet — it becomes the target
    }
    if (!stat.isSymbolicLink()) return current;
    let raw: string;
    try {
      raw = readlinkSync(current);
    } catch {
      return current;
    }
    current = isAbsolute(raw) ? raw : join(dirname(current), raw);
  }
  return current;
};

/**
 * Write `content` to `path` without ever leaving a partial file behind: the
 * bytes go to a fsynced temp file in the same directory, then a rename moves
 * it over the target atomically. A truncating `writeFileSync` can leave an
 * empty or half-written rc after ENOSPC or a mid-write crash; this cannot.
 *
 * Symlinks are resolved first so the link stays a link. When `backup` is
 * set and the target exists, the old bytes are first copied to
 * `target + backup` so a bad replace is recoverable. An existing file's
 * permission bits carry over to the replacement. Throws on fs errors.
 */
export const writeFileAtomic = (
  path: string,
  content: string,
  opts?: { backup?: boolean },
): void => {
  const target = resolveWriteTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  let mode: number | undefined;
  try {
    const stat = lstatSync(target);
    if (stat.isFile()) {
      mode = stat.mode & 0o777;
      if (opts?.backup === true) {
        copyFileSync(target, `${target}${RC_BACKUP_SUFFIX}`);
      }
    }
  } catch {
    // no existing file — first write, nothing to back up
  }
  const tmp = join(
    dirname(target),
    `.${basename(target)}.openllm-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  try {
    const fd = openSync(tmp, "w", mode);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // renamed or never created
    }
    throw error;
  }
};

/**
 * Drop the lines that carry `marker`. For each dropped line, one directly
 * preceding empty line is dropped too — that is the separator our own append
 * wrote (`\n<line>\n`), so an uninstall restores the original bytes exactly.
 * Nothing else is rewritten: blank-line runs elsewhere in the file are the
 * user's and stay untouched.
 */
export const removeMarkedLines = (text: string, marker: string): string => {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (line.includes(marker)) {
      if (kept[kept.length - 1] === "") kept.pop();
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
};

const fishCompletionPath = (): string =>
  join(userHome(), ".config", "fish", "completions", "openllm.fish");

/** The current login shell name from `$SHELL`, or null if not recognized. */
const detectShell = (): TCompletionShell | null => {
  const sh = basename(process.env.SHELL ?? "");
  return isShell(sh) ? sh : null;
};

/** Append a line to a file once (idempotent on an exact marker substring).
 *  Throws on fs errors — the caller decides how to surface them. */
const appendOnce = (file: string, line: string, marker: string): boolean => {
  try {
    const existing = readFileSync(file, "utf-8");
    if (existing.includes(marker)) return false;
  } catch {
    // file may not exist yet — created by appendFileSync below
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `\n${line}\n`);
  return true;
};

/**
 * Install completion for the current shell by wiring it into the rc
 * (bash/zsh) or dropping a completions file (fish). Idempotent. Returns the
 * file it touched, or null when the shell is unsupported OR the write failed
 * (a read-only rc under the daemon sandbox, a missing $HOME, …) — the
 * callers already render null as a clean "couldn't install" message instead
 * of a raw stack trace.
 */
export const installCompletion = (): string | null => {
  const shell = detectShell();
  if (shell === null) return null;
  try {
    if (shell === "fish") {
      const file = fishCompletionPath();
      writeFileAtomic(file, fishScript(), { backup: true });
      return file;
    }
    const rc = join(userHome(), shell === "zsh" ? ".zshrc" : ".bashrc");
    appendOnce(
      rc,
      `command -v openllm >/dev/null && source <(openllm completion ${shell})  ${RC_MARKER}`,
      RC_MARKER,
    );
    return rc;
  } catch {
    // fs failure (read-only rc / sandbox) — report as not-installed.
    return null;
  }
};

/**
 * Remove the completion we installed: drop our marked rc line (bash/zsh) and
 * delete the fish completions file. Best-effort and silent — the uninstall path
 * must not fail because a shell rc is read-only.
 */
export const removeCompletion = (): void => {
  try {
    rmSync(fishCompletionPath(), { force: true });
  } catch {
    // best-effort
  }
  for (const name of [".zshrc", ".bashrc"]) {
    const rc = join(userHome(), name);
    try {
      const existing = readFileSync(rc, "utf-8");
      if (!existing.includes(RC_MARKER)) continue;
      const next = removeMarkedLines(existing, RC_MARKER);
      writeFileAtomic(rc, next, { backup: true });
    } catch {
      // missing / unwritable rc — nothing to do
    }
  }
};

export const runCompletionCommand = (args: readonly string[]): number => {
  const arg = args[0] ?? "";
  if (arg === "install") {
    const file = installCompletion();
    if (file === null) {
      process.stderr.write(
        "could not install completion — unsupported shell (set $SHELL to bash/zsh/fish) or the rc file is not writable\n",
      );
      return 1;
    }
    process.stdout.write(`completion installed → ${file}\n`);
    process.stdout.write("restart your shell (or source the rc) to load it\n");
    return 0;
  }
  if (isShell(arg)) {
    process.stdout.write(completionScript(arg));
    return 0;
  }
  process.stderr.write("usage: openllm completion <bash|zsh|fish|install>\n");
  return 2;
};
