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
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TCompletionShell } from "./commands";
import {
  COMMANDS,
  COMPLETION_SHELLS,
  EXEC_GROUPS,
  EXEC_VERBS,
  FLAGS,
  MCP_ONLY_GROUPS,
} from "./commands";

/** Top-level completion tokens: every subcommand + every flag alias. */
const TOP_LEVEL = [...COMMANDS.map((c) => c.name), ...FLAGS.map((f) => f.name)];
const COMPLETION_ARGS = [...COMPLETION_SHELLS, "install"];

const bashScript = (): string => {
  const top = TOP_LEVEL.join(" ");
  const verbCases = EXEC_GROUPS.map(
    (g) =>
      `      ${g}) [ "$COMP_CWORD" -eq 3 ] && COMPREPLY=( $(compgen -W "${EXEC_VERBS[g].join(" ")}" -- "$cur") ) ;;`,
  ).join("\n");
  return `# openllm bash completion
_openllm() {
  local cur cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${top}" -- "$cur") )
    return
  fi
  case "$cmd" in
    completion) COMPREPLY=( $(compgen -W "${COMPLETION_ARGS.join(" ")}" -- "$cur") ) ;;
    mcp) COMPREPLY=( $(compgen -W "--only ${MCP_ONLY_GROUPS.join(" ")}" -- "$cur") ) ;;
    api) COMPREPLY=( $(compgen -W "--spec" -- "$cur") ) ;;
    exec)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "${EXEC_GROUPS.join(" ")}" -- "$cur") )
        return
      fi
      case "\${COMP_WORDS[2]}" in
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
  ].join("\n    ");
  const verbCases = EXEC_GROUPS.map(
    (g) => `        ${g}) _values 'verb' ${EXEC_VERBS[g].join(" ")} ;;`,
  ).join("\n");
  return `# openllm zsh completion
_openllm() {
  local -a _cmds
  _cmds=(
    ${specs}
  )
  _arguments -C '1:command:->cmd' '*::arg:->args'
  case "$state" in
    cmd) _describe -t commands 'openllm command' _cmds ;;
    args)
      case "$line[1]" in
        completion) _values 'shell' ${COMPLETION_ARGS.join(" ")} ;;
        mcp) _values 'group' --only ${MCP_ONLY_GROUPS.join(" ")} ;;
        api) _values 'flag' --spec ;;
        exec)
          if (( CURRENT == 2 )); then
            _values 'group' ${EXEC_GROUPS.join(" ")}
          else
            case "$line[2]" in
${verbCases}
            esac
          fi ;;
      esac ;;
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
    `complete -c openllm -n '__fish_seen_subcommand_from completion' -a '${COMPLETION_ARGS.join(" ")}'`,
    `complete -c openllm -n '__fish_seen_subcommand_from mcp' -a '--only ${MCP_ONLY_GROUPS.join(" ")}'`,
    `complete -c openllm -n '__fish_seen_subcommand_from api' -a '--spec'`,
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

const fishCompletionPath = (): string =>
  join(homedir(), ".config", "fish", "completions", "openllm.fish");

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
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, fishScript());
      return file;
    }
    const rc = join(homedir(), shell === "zsh" ? ".zshrc" : ".bashrc");
    appendOnce(
      rc,
      `command -v openllm >/dev/null && source <(openllm completion ${shell})  # openllm-completion`,
      "openllm completion",
    );
    return rc;
  } catch {
    // fs failure (read-only rc / sandbox) — report as not-installed.
    return null;
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
