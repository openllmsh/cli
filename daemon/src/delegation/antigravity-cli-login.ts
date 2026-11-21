/**
 * Google sign-in for the Antigravity `agy` CLI, driven through its own login
 * screen. `agy` has no login subcommand and its print mode refuses to sign in
 * ("Run 'agy' to log in"), so the daemon runs the official interactive screen
 * in a pseudo-terminal and does what a person would:
 *
 *   1. `Select login method: > 1. Google OAuth` → press Enter.
 *   2. `agy` prints Google's OAuth URL (redirect to
 *      https://antigravity.google/oauth-callback) and waits at
 *      "paste the authorization code below". The URL is surfaced to the UI.
 *   3. Google's callback page shows an authorization code; the user pastes it
 *      in the UI and the daemon types it into the waiting screen.
 *   4. `agy` lands on its signed-in screen (`<email> (<plan>)`) → done.
 *
 * Nothing here reads or writes a token: `agy` stores its own sign-in (the
 * isolated keychain on macOS — callers gate on `ensureKeychainReady` first —
 * or its file store). The screen text is the only interface, so every match
 * is narrow, and anything unrecognised ends in a clear failure instead of a
 * guess. The terminal is wide so the URL never wraps.
 */

/** Wide enough that Google's OAuth URL (~700 chars) is one line. */
export const AGY_LOGIN_COLS = 4000;
export const AGY_LOGIN_ROWS = 60;

const MENU_RE = /Select login method/;
const GOOGLE_OAUTH_OPTION_RE = />\s*1\.\s*Google OAuth/;
/** The menu is fully drawn once its second option is on screen. */
const SECOND_OPTION_RE = /(^|\n)\s*>?\s*2\.\s+\S/;
const CODE_PROMPT_RE = /paste the authorization code/i;
/** The signed-in banner: `<email> (<plan>)`, e.g. `me@example.com (Antigravity Starter Quota)`. */
const SIGNED_IN_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s+\([^)]+\)/;
const AUTH_URL_RE =
  /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s"'<>]+/;

/** Strip ANSI CSI/OSC/other escape sequences and control noise. */
const ESC = "\u001b";
const BEL = "\u0007";
const OSC_RE = new RegExp(
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const ESC2_RE = new RegExp(`${ESC}[@-_]`, "g");

export const stripTerminal = (raw: string): string =>
  raw
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(ESC2_RE, "")
    .replace(/\r/g, "\n");

export type TAgyAuthUrl = { readonly url: string };

/**
 * Google's OAuth URL as `agy` prints it, validated: Google's endpoint,
 * authorization-code flow with PKCE, a Google OAuth client, and the redirect
 * to Antigravity's own callback page. Anything else → null.
 */
export const parseAgyAuthUrl = (screen: string): TAgyAuthUrl | null => {
  const match = AUTH_URL_RE.exec(screen);
  if (match === null) return null;
  let url: URL;
  try {
    url = new URL(match[0]);
  } catch {
    return null;
  }
  const p = url.searchParams;
  const redirect = p.get("redirect_uri") ?? "";
  const ok =
    url.protocol === "https:" &&
    url.hostname === "accounts.google.com" &&
    url.pathname === "/o/oauth2/auth" &&
    p.get("response_type") === "code" &&
    (p.get("client_id") ?? "").endsWith(".apps.googleusercontent.com") &&
    (p.get("code_challenge") ?? "").length > 0 &&
    redirect.startsWith("https://antigravity.google/");
  return ok ? { url: url.toString() } : null;
};

/** Google authorization codes (`4/0A…`): printable token chars only, so
 *  nothing pasted can steer the terminal (no newlines, escapes, spaces). */
export const validateAgyAuthCode = (
  pasted: string,
):
  | { readonly ok: true; readonly code: string }
  | {
      readonly ok: false;
      readonly reason: string;
    } => {
  const code = pasted.trim();
  if (!/^[A-Za-z0-9/_.-]{10,512}$/.test(code)) {
    return {
      ok: false,
      reason:
        "That doesn't look like a Google authorization code. Copy the code shown on Google's page and paste it here.",
    };
  }
  return { ok: true, code };
};

export type TAgyLoginPty = {
  readonly write: (data: string) => void;
  readonly kill: () => void;
  readonly exited: Promise<number | null>;
};

export type TAgyLoginPtySpawner = (args: {
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly onData: (chunk: Uint8Array) => void;
}) => TAgyLoginPty;

/** Production spawner over Bun's built-in PTY. */
export const bunAgyLoginPty: TAgyLoginPtySpawner = (args) => {
  const terminal = new Bun.Terminal({
    cols: args.cols,
    rows: args.rows,
    name: "xterm-256color",
    data: (_t, chunk) => args.onData(chunk),
  });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...args.argv], {
      cwd: args.cwd,
      env: args.env,
      terminal,
    });
  } catch (error) {
    terminal.close();
    throw error;
  }
  const exited = proc.exited.then(
    (code) => {
      terminal.close();
      return code;
    },
    () => {
      terminal.close();
      return null;
    },
  );
  return {
    write: (data) => terminal.write(data),
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
    exited,
  };
};

export type TAgyLoginOutcome =
  | { readonly kind: "signed_in" }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly timedOut?: boolean;
    };

export type TAgyLogin = {
  /** Resolves with the URL once `agy` shows it (null if it never does). */
  readonly url: Promise<TAgyAuthUrl | null>;
  /** Resolves when the screen reaches signed-in, fails, exits or times out. */
  readonly done: Promise<TAgyLoginOutcome>;
  /** Type a validated authorization code into the waiting screen. */
  readonly submitCode: (pasted: string) => {
    readonly ok: boolean;
    readonly detail: string;
  };
  readonly cancel: () => void;
};

/**
 * Start `agy`'s login screen and walk it. The caller owns the env (isolated
 * HOME, keychain gate already `present`) and the argv (sandbox wrap).
 */
export const startAgyLogin = (args: {
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly spawn?: TAgyLoginPtySpawner;
  readonly urlWaitMs: number;
  readonly loginTimeoutMs: number;
}): TAgyLogin => {
  let screen = "";
  let menuAnswered = false;
  let surfaced: TAgyAuthUrl | null = null;
  let codeTyped = false;
  let settled = false;
  let resolveUrl: (value: TAgyAuthUrl | null) => void = () => {};
  const url = new Promise<TAgyAuthUrl | null>((resolve) => {
    resolveUrl = resolve;
  });
  let resolveDone: (value: TAgyLoginOutcome) => void = () => {};
  const done = new Promise<TAgyLoginOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let pty: TAgyLoginPty | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const decoder = new TextDecoder();

  const settle = (outcome: TAgyLoginOutcome): void => {
    if (settled) return;
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    resolveUrl(surfaced);
    resolveDone(outcome);
    pty?.kill();
  };

  const onData = (chunk: Uint8Array): void => {
    if (settled) return;
    // Keep a bounded tail: the screen redraws, only the latest state matters.
    screen =
      `${screen}${stripTerminal(decoder.decode(chunk, { stream: true }))}`.slice(
        -32_768,
      );
    if (!menuAnswered && MENU_RE.test(screen)) {
      // The menu can arrive across several chunks: decide only once Google
      // OAuth is selected, or the menu is complete without it.
      const menu = screen.slice(screen.search(MENU_RE));
      if (!GOOGLE_OAUTH_OPTION_RE.test(menu)) {
        if (SECOND_OPTION_RE.test(menu)) {
          settle({
            kind: "failed",
            reason: "agy's login menu did not offer Google OAuth first",
          });
        }
        return;
      }
      menuAnswered = true;
      pty?.write("\r");
      return;
    }
    if (menuAnswered && surfaced === null) {
      const parsed = parseAgyAuthUrl(screen);
      if (parsed !== null && CODE_PROMPT_RE.test(screen)) {
        surfaced = parsed;
        resolveUrl(parsed);
      }
    }
    if (
      SIGNED_IN_RE.test(screen) &&
      (codeTyped || surfaced !== null || !menuAnswered)
    ) {
      // Signed in: after a code, after the browser finished on its own, or
      // already signed in when the screen opened.
      settle({ kind: "signed_in" });
    }
  };

  try {
    pty = (args.spawn ?? bunAgyLoginPty)({
      argv: args.argv,
      env: args.env,
      cwd: args.cwd,
      cols: AGY_LOGIN_COLS,
      rows: AGY_LOGIN_ROWS,
      onData,
    });
  } catch (error) {
    settle({
      kind: "failed",
      reason: `could not start agy: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  void pty?.exited.then(() =>
    settle({ kind: "failed", reason: "agy exited before sign-in finished" }),
  );
  timers.push(
    setTimeout(() => {
      if (surfaced === null) {
        settle({
          kind: "failed",
          reason: "agy did not show a Google sign-in link",
          timedOut: true,
        });
      }
    }, args.urlWaitMs),
    setTimeout(
      () =>
        settle({
          kind: "failed",
          reason: "Google sign-in did not finish in time",
          timedOut: true,
        }),
      args.loginTimeoutMs,
    ),
  );

  return {
    url,
    done,
    submitCode: (pasted) => {
      if (settled || surfaced === null) {
        return { ok: false, detail: "no Google sign-in is awaiting a code." };
      }
      const checked = validateAgyAuthCode(pasted);
      if (!checked.ok) return { ok: false, detail: checked.reason };
      pty?.write(checked.code);
      pty?.write("\r");
      codeTyped = true;
      return {
        ok: true,
        detail: "Code sent to Google Antigravity — finishing.",
      };
    },
    cancel: () => settle({ kind: "failed", reason: "sign-in cancelled" }),
  };
};

/**
 * Sign out through `agy`'s own `/logout` command (it is not one of the
 * read-only print-mode commands): open the signed-in screen, type `/logout`,
 * and judge success by the sign-in store (`isSignedIn`, metadata only) rather
 * than by screen text. Enter is repeated once in case the first one only
 * accepted a command-completion suggestion.
 */
export const runAgyLogout = async (args: {
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly isSignedIn: () => Promise<boolean>;
  readonly spawn?: TAgyLoginPtySpawner;
  readonly timeoutMs: number;
  readonly pollMs?: number;
}): Promise<{ readonly ok: boolean; readonly detail: string }> => {
  if (!(await args.isSignedIn())) {
    return { ok: true, detail: "already signed out" };
  }
  let screen = "";
  let typed = false;
  const decoder = new TextDecoder();
  let pty: TAgyLoginPty;
  try {
    pty = (args.spawn ?? bunAgyLoginPty)({
      argv: args.argv,
      env: args.env,
      cwd: args.cwd,
      cols: AGY_LOGIN_COLS,
      rows: AGY_LOGIN_ROWS,
      onData: (chunk) => {
        screen =
          `${screen}${stripTerminal(decoder.decode(chunk, { stream: true }))}`.slice(
            -32_768,
          );
        if (!typed && SIGNED_IN_RE.test(screen)) {
          typed = true;
          pty.write("/logout");
          pty.write("\r");
          setTimeout(() => pty.write("\r"), 1_500);
        }
      },
    });
  } catch (error) {
    return {
      ok: false,
      detail: `could not start agy: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const deadline = Date.now() + args.timeoutMs;
  try {
    while (Date.now() < deadline) {
      await Bun.sleep(args.pollMs ?? 500);
      if (typed && !(await args.isSignedIn())) {
        return { ok: true, detail: "signed out of Google Antigravity" };
      }
    }
    return {
      ok: false,
      detail: typed
        ? "agy did not sign out in time"
        : "agy did not show its signed-in screen",
    };
  } finally {
    pty.kill();
  }
};
