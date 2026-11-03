/**
 * Minimal terminal styling for human-facing CLI output (sign-in, its success
 * line). Off unless stderr is a real terminal and the user hasn't opted out
 * (`NO_COLOR`, `TERM=dumb`), so pipes, logs and tests get plain text.
 */
export type TTermStyle = {
  readonly enabled: boolean;
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly green: (text: string) => string;
};

const wrap =
  (enabled: boolean, open: string, close: string) =>
  (text: string): string =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const termStyle = (enabled: boolean): TTermStyle => ({
  enabled,
  bold: wrap(enabled, "1", "22"),
  dim: wrap(enabled, "2", "22"),
  green: wrap(enabled, "32", "39"),
});

export const plainStyle: TTermStyle = termStyle(false);

/** May we style what goes to stderr? */
export const stderrColorEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean =>
  process.stderr.isTTY === true &&
  (env.NO_COLOR ?? "") === "" &&
  env.TERM !== "dumb";

/** Erase the current terminal line and return to its start. */
export const CLEAR_LINE = "\r\x1b[2K";

/** Braille spinner frames, the usual CLI "working" glyphs. */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
