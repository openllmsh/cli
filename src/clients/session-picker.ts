/**
 * The "tap into a running session?" picker for `openllm <client>`.
 *
 * Durable session hosts publish a filesystem registry
 * (`~/.openllm/sessions/<id>/meta.json` + `ctl.sock`) that is shared by BOTH
 * origins: a browser-started session is spawned by the daemon's
 * `spawnSessionHostProc`, a local one by `openllm <client>` itself, and both
 * write to the same `OPENLLM_DAEMON_STATE_DIR ?? ~/.openllm` tree. So a local
 * invocation can see — and join — a session the browser started, and vice
 * versa, without either side knowing about the other.
 *
 * Joining is a real ATTACH to the live PTY, never a vendor `--resume`: the
 * session host fans PTY output out to every consumer and reflows a private
 * screen per consumer size, so tapping in alongside a browser viewer neither
 * kicks it nor disturbs its geometry. Nothing here parses vendor session files.
 *
 * This module is PURE (no I/O, no process state) so the ordering, labelling,
 * and input rules are unit-testable; `session.ts` owns the terminal read.
 */

import type { TLiveSessionHost } from "../session-host";
import type { TDaemonCli } from "./registry";

/** One selectable row, numbered as displayed. */
export type TSessionChoice = {
  /** 1-based number the user types. */
  readonly index: number;
  readonly session: TLiveSessionHost;
  /** Started in the directory the user is invoking from. */
  readonly sameCwd: boolean;
};

export type TSessionPick =
  | { readonly kind: "attach"; readonly session: TLiveSessionHost }
  | { readonly kind: "new" }
  | { readonly kind: "invalid" };

/**
 * Sessions for THIS client, most-relevant first: same working directory before
 * anything else, then newest. Attaching adopts the session's cwd, not the
 * caller's, so a same-cwd session is the only one that behaves like the
 * `openllm <client>` the user just typed — hence it sorts first and is the
 * default.
 */
export const buildSessionChoices = (
  sessions: readonly TLiveSessionHost[],
  cli: TDaemonCli,
  cwd: string,
): readonly TSessionChoice[] =>
  sessions
    .filter((session) => session.cli === cli)
    .map((session) => ({ session, sameCwd: session.cwd === cwd }))
    .sort((a, b) => {
      if (a.sameCwd !== b.sameCwd) return a.sameCwd ? -1 : 1;
      return b.session.startedAtMs - a.session.startedAtMs;
    })
    .map((choice, position) => ({ ...choice, index: position + 1 }));

/**
 * Bare Enter attaches to a same-cwd session when one exists, and otherwise
 * starts a new one — never silently drop the user into a CLI rooted in some
 * unrelated directory.
 */
export const defaultPick = (
  choices: readonly TSessionChoice[],
): TSessionPick => {
  const preferred = choices.find((choice) => choice.sameCwd);
  return preferred === undefined
    ? { kind: "new" }
    : { kind: "attach", session: preferred.session };
};

/** Resolve an exact id or a unique non-empty prefix. */
export const resolveById = <T extends { readonly id: string }>(
  rows: readonly T[],
  supplied: string,
): T | "missing" | "ambiguous" => {
  const exact = rows.find((row) => row.id === supplied);
  if (exact !== undefined) return exact;
  if (supplied.length === 0) return "missing";
  const matches = rows.filter((row) => row.id.startsWith(supplied));
  if (matches.length === 1) return matches[0] as T;
  return matches.length === 0 ? "missing" : "ambiguous";
};

/**
 * Map one line of terminal input to an action. Accepts the displayed number,
 * `n`/`new`, `q`/`quit` (also "new" — the user declined the offer, not the
 * session), a session id prefix, or empty for {@link defaultPick}.
 */
export const resolvePick = (
  input: string,
  choices: readonly TSessionChoice[],
): TSessionPick => {
  const answer = input.trim().toLowerCase();
  if (answer.length === 0) return defaultPick(choices);
  if (answer === "n" || answer === "new" || answer === "q" || answer === "quit")
    return { kind: "new" };
  if (/^\d+$/.test(answer)) {
    const chosen = choices.find((choice) => choice.index === Number(answer));
    return chosen === undefined
      ? { kind: "invalid" }
      : { kind: "attach", session: chosen.session };
  }
  const resolved = resolveById(
    choices.map((choice) => choice.session),
    answer,
  );
  return resolved === "missing" || resolved === "ambiguous"
    ? { kind: "invalid" }
    : { kind: "attach", session: resolved };
};

const relativeAge = (startedAtMs: number, nowMs: number): string => {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
};

const compactCwd = (cwd: string, home: string | undefined): string =>
  home !== undefined && home.length > 0 && cwd.startsWith(`${home}/`)
    ? `~/${cwd.slice(home.length + 1)}`
    : cwd;

const pad = (value: string, width: number): string => value.padEnd(width);

/** Render the offer. Columns are sized to content so short lists stay tight. */
export const formatSessionPrompt = (
  choices: readonly TSessionChoice[],
  args: {
    readonly clientName: string;
    readonly nowMs: number;
    readonly home?: string;
  },
): string => {
  const rows = choices.map((choice) => ({
    number: `${choice.index}`,
    title:
      choice.session.title !== null && choice.session.title.length > 0
        ? choice.session.title
        : "(untitled)",
    cwd: compactCwd(choice.session.cwd, args.home),
    age: relativeAge(choice.session.startedAtMs, args.nowMs),
    here: choice.sameCwd,
  }));
  const width = (pick: (row: (typeof rows)[number]) => string): number =>
    Math.max(0, ...rows.map((row) => pick(row).length));
  const numberWidth = width((row) => row.number);
  const titleWidth = width((row) => row.title);
  const cwdWidth = width((row) => row.cwd);
  const lines = rows.map(
    (row) =>
      `  ${pad(row.number, numberWidth)}  ${pad(row.title, titleWidth)}  ${pad(
        row.cwd,
        cwdWidth,
      )}  ${row.age}${row.here ? "  ← this directory" : ""}`,
  );
  const noun = choices.length === 1 ? "session is" : "sessions are";
  const fallback = defaultPick(choices);
  const hint =
    fallback.kind === "new"
      ? "[number to attach, Enter for a new session]"
      : "[number to attach, n for a new session, Enter to attach the one in this directory]";
  return [
    `${choices.length} ${args.clientName} ${noun} already running on this machine:`,
    ...lines,
    `  ${pad("n", numberWidth)}  start a new session`,
    "",
    `${hint} `,
  ].join("\n");
};
