/** Shared title rules for local session readers. */

export const TITLE_MAX = 80;

const ELLIPSIS = "…";

export const truncate = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length === 0) return "Untitled";
  // Reserve the ellipsis width so the result never exceeds TITLE_MAX and
  // survives readLocalSessions' own `.slice(0, TITLE_MAX)` unchanged.
  return t.length <= TITLE_MAX
    ? t
    : `${t
        .slice(0, TITLE_MAX - ELLIPSIS.length)
        .replace(/[\uD800-\uDBFF]$/, "")}${ELLIPSIS}`;
};

/** `/new`, `/resume <id>`, `/clear`, `/plugin:cmd` … typed at the prompt. */
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(?:\s|$)/;
/** Claude's transcript wrappers for commands, their output and meta caveats. */
const COMMAND_WRAPPER =
  /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
/** "[Request interrupted by user]", "[Request interrupted by user for tool use]". */
const INTERRUPTED = /^\[Request interrupted/;
/** "[Pasted text #1 +663 lines]", "[Image #16]" — placeholders, not words. */
const PLACEHOLDER = /\[(?:Pasted text|Image) #\d+(?: \+\d+ lines)?\]/g;

/**
 * How well one raw prompt names a conversation: `real` text the user wrote,
 * `placeholder` (only pasted-text / image markers), or `null` for something
 * that is never a title (slash commands, command wrappers, interrupt markers).
 */
export const promptTitleOf = (
  raw: string,
): { readonly kind: "real" | "placeholder"; readonly title: string } | null => {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (SLASH_COMMAND.test(text)) return null;
  if (COMMAND_WRAPPER.test(text)) return null;
  if (INTERRUPTED.test(text)) return null;
  const words = text.replace(PLACEHOLDER, " ").replace(/\s+/g, " ").trim();
  if (words.length > 0) return { kind: "real", title: truncate(words) };
  return { kind: "placeholder", title: truncate(text) };
};

/**
 * The title for a conversation from its prompts, oldest first: the first real
 * prompt; else the first placeholder-only prompt; else null.
 */
export const pickPromptTitle = (prompts: readonly string[]): string | null => {
  let fallback: string | null = null;
  for (const prompt of prompts) {
    const picked = promptTitleOf(prompt);
    if (picked === null) continue;
    if (picked.kind === "real") return picked.title;
    fallback ??= picked.title;
  }
  return fallback;
};

/** A running session nobody has prompted yet: never the folder name. */
export const newSessionTitle = (cliLabel: string): string =>
  `New session · ${cliLabel}`;
