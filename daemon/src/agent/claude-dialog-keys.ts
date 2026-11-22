/**
 * The keystrokes that answer Claude Code's own TUI dialogs, for a question or
 * approval the web answers while the dialog is already on the terminal.
 *
 * Verified against `claude` 2.1.330 (a scratch HOME, a canned Messages API;
 * `tests/daemon/agent-claude-dialog-keys.live.test.ts` replays it):
 *
 * - AskUserQuestion, one tab per question. The cursor starts on the first
 *   option. Rows are the options, then a free-text row ("Type something"),
 *   then — multi-select only — a `Submit` row, then "Chat about this".
 * - Single-select: Down to the option, Enter picks it and moves to the next
 *   tab. On the free-text row typing fills it; Enter picks it.
 * - Multi-select: Enter toggles the row under the cursor. Typing on the
 *   free-text row checks it by itself (Enter would uncheck it again). Enter on
 *   the `Submit` row moves to the next tab.
 * - After the last tab a "Review your answers" screen opens on "Submit
 *   answers" — except for a lone single-select question, which submits at
 *   once.
 * - A tool approval: Enter is the first choice (Yes); Esc rejects.
 * - Esc cancels any of them.
 */
import type {
  TAgentUserInputAnswers,
  TAgentUserInputQuestion,
} from "@openllmsh/sdk/protocol";

export const CLAUDE_KEY_ENTER = "\r";
export const CLAUDE_KEY_ESC = "\x1b";
export const CLAUDE_KEY_DOWN = "\x1b[B";

/** One write to the PTY, then a wait: `tab` when Claude animates to the next tab. */
export type TClaudeDialogKey = {
  readonly text: string;
  readonly settle: "key" | "tab";
};

/** Answer a tool approval: Yes is preselected, Esc rejects. */
export const claudeApprovalKeys = (accept: boolean): TClaudeDialogKey[] => [
  { text: accept ? CLAUDE_KEY_ENTER : CLAUDE_KEY_ESC, settle: "key" },
];

/** Dismiss whatever dialog is open. */
export const claudeCancelKeys = (): TClaudeDialogKey[] => [
  { text: CLAUDE_KEY_ESC, settle: "key" },
];

const downs = (count: number): TClaudeDialogKey[] =>
  Array.from({ length: Math.max(0, count) }, () => ({
    text: CLAUDE_KEY_DOWN,
    settle: "key" as const,
  }));

const asList = (answer: string | readonly string[]): readonly string[] =>
  typeof answer === "string" ? [answer] : answer;

/**
 * The keys that answer an AskUserQuestion dialog, or null when the answers
 * don't fit the dialog (a question without options, or one left unanswered)
 * and nothing should be typed.
 */
export const claudeQuestionKeys = (
  questions: readonly TAgentUserInputQuestion[],
  answers: TAgentUserInputAnswers,
): TClaudeDialogKey[] | null => {
  const keys: TClaudeDialogKey[] = [];
  for (const question of questions) {
    const options = question.options;
    const answer = answers[question.id];
    if (options === undefined || options.length === 0 || answer === undefined)
      return null;
    const labels = options.map((option) => option.label);
    const given = asList(answer);
    const picked = new Set<number>();
    const other: string[] = [];
    for (const value of given) {
      const index = labels.indexOf(value);
      if (index >= 0) picked.add(index);
      else if (value.trim() !== "") other.push(value);
    }
    const otherText = other.join(", ");
    const otherRow = options.length;
    if (question.multi_select !== true) {
      if (otherText !== "") {
        keys.push(...downs(otherRow), { text: otherText, settle: "key" });
      } else {
        const index = [...picked][0];
        if (index === undefined) return null;
        keys.push(...downs(index));
      }
      keys.push({ text: CLAUDE_KEY_ENTER, settle: "tab" });
      continue;
    }
    let cursor = 0;
    for (const index of [...picked].sort((a, b) => a - b)) {
      keys.push(...downs(index - cursor), {
        text: CLAUDE_KEY_ENTER,
        settle: "key",
      });
      cursor = index;
    }
    if (otherText !== "") {
      keys.push(...downs(otherRow - cursor), {
        text: otherText,
        settle: "key",
      });
      cursor = otherRow;
    }
    // The `Submit` row sits right under the free-text row.
    keys.push(...downs(otherRow + 1 - cursor), {
      text: CLAUDE_KEY_ENTER,
      settle: "tab",
    });
  }
  const lone = questions.length === 1 && questions[0]?.multi_select !== true;
  // The review screen opens on "Submit answers".
  if (!lone) keys.push({ text: CLAUDE_KEY_ENTER, settle: "key" });
  return keys;
};
