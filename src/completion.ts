/**
 * Shell completion for `openllmc` — `openllmc completion <bash|zsh|fish>`
 * emits a completion script; `openllmc completion install` detects the
 * current shell (`$SHELL`) and wires it into the user's rc (idempotent).
 * Every subcommand, exec group/verb, flag, and shell is derived from the
 * shared definitions in `commands.ts`, so completion can't drift from the
 * actual CLI surface. The openllmc twin of the daemon's `completion.ts`.
 *
 * The bash/zsh scripts are sourced dynamically (`source <(openllmc
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
  return `# openllmc bash completion
_openllmc() {
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
complete -F _openllmc openllmc
`;
};

const zshScript = (): string => {
  // Descriptions are colon-free (commands.ts), so the `value:desc` specs parse.
  const specs = [
    ...COMMANDS.map((c) => `'${c.name}:${c.description}'`),
    ...FLAGS.map((f) => `'${f.name}:${f.description}'`),
  ].join("\n    ");
  const verbCases = EXEC_GROUPS.map(
    (g) => `        ${g}) _values 'verb' ${EXEC_VERBS[g].join(" ")} ;;`,
  ).join("\n");
  return `# openllmc zsh completion
_openllmc() {
  local -a _cmds
  _cmds=(
    ${specs}
  )
  _arguments -C '1:command:->cmd' '*::arg:->args'
  case "$state" in
    cmd) _describe -t commands 'openllmc command' _cmds ;;
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
compdef _openllmc openllmc
`;
};

const fishScript = (): string => {
  const lines = COMMANDS.map(
    (c) =>
      `complete -c openllmc -n __fish_use_subcommand -a ${c.name} -d '${c.description}'`,
  );
  lines.push(
    `complete -c openllmc -n '__fish_seen_subcommand_from completion' -a '${COMPLETION_ARGS.join(" ")}'`,
    `complete -c openllmc -n '__fish_seen_subcommand_from mcp' -a '--only ${MCP_ONLY_GROUPS.join(" ")}'`,
    `complete -c openllmc -n '__fish_seen_subcommand_from api' -a '--spec'`,
    `complete -c openllmc -n '__fish_seen_subcommand_from exec' -a '${EXEC_GROUPS.join(" ")}'`,
    ...EXEC_GROUPS.map(
      (g) =>
        `complete -c openllmc -n '__fish_seen_subcommand_from ${g}' -a '${EXEC_VERBS[g].join(" ")}'`,
    ),
    `complete -c openllmc -s h -l help -d 'Show help'`,
    `complete -c openllmc -s v -l version -d 'Print the version'`,
  );
  return `# openllmc fish completion\ncomplete -c openllmc -f\n${lines.join("\n")}\n`;
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
  join(homedir(), ".config", "fish", "completions", "openllmc.fish");

/** The current login shell name from `$SHELL`, or null if not recognized. */
const detectShell = (): TCompletionShell | null => {
  const sh = basename(process.env.SHELL ?? "");
  return isShell(sh) ? sh : null;
};

/** Append a line to a file once (idempotent on an exact marker substring). */
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
 * file it touched, or null when the shell is unsupported.
 */
export const installCompletion = (): string | null => {
  const shell = detectShell();
  if (shell === null) return null;
  if (shell === "fish") {
    const file = fishCompletionPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fishScript());
    return file;
  }
  const rc = join(homedir(), shell === "zsh" ? ".zshrc" : ".bashrc");
  appendOnce(
    rc,
    `command -v openllmc >/dev/null && source <(openllmc completion ${shell})  # openllmc-completion`,
    "openllmc completion",
  );
  return rc;
};

export const runCompletionCommand = (args: readonly string[]): number => {
  const arg = args[0] ?? "";
  if (arg === "install") {
    const file = installCompletion();
    if (file === null) {
      process.stderr.write(
        "unsupported shell — supported: bash, zsh, fish (set $SHELL)\n",
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
  process.stderr.write("usage: openllmc completion <bash|zsh|fish|install>\n");
  return 2;
};
