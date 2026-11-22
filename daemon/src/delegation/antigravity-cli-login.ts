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
 *   4. `agy` stores the sign-in → done (judged by the store, not the screen:
 *      on a first sign-in `agy` next shows an onboarding wizard whose second
 *      page is a Terms of Service / data-use consent — the daemon never
 *      answers it; it closes the screen. Headless inference does not need it).
 *
 * Nothing here reads or writes a token: `agy` stores its own sign-in (the
 * isolated keychain on macOS — callers gate on `ensureKeychainReady` first —
 * or its file store). The screen text is the only interface, so every match
 * is narrow, and anything unrecognised ends in a clear failure instead of a
 * guess. The terminal is wide so the URL never wraps.
 */

import { Terminal } from "@xterm/headless";

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
    isAntigravityCallback(redirect);
  return ok ? { url: url.toString() } : null;
};

/** Exactly Antigravity's own OAuth callback page — never any other path on
 *  the host. */
const isAntigravityCallback = (redirect: string): boolean => {
  try {
    const u = new URL(redirect);
    return (
      u.protocol === "https:" &&
      u.hostname === "antigravity.google" &&
      u.port === "" &&
      u.pathname === "/oauth-callback"
    );
  } catch {
    return false;
  }
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

/** Grace between SIGTERM and SIGKILL for an `agy` child. */
export const AGY_KILL_GRACE_MS = 2_000;

/** SIGTERM now, SIGKILL if it is still running after the grace. */
export const killHard = (proc: {
  readonly kill: (signal?: number | NodeJS.Signals) => void;
  readonly exitCode: number | null;
  readonly signalCode?: string | number | null;
}): void => {
  try {
    proc.kill();
  } catch {
    return; // already gone
  }
  const timer = setTimeout(() => {
    if (proc.exitCode !== null || (proc.signalCode ?? null) !== null) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, AGY_KILL_GRACE_MS);
  timer.unref?.();
};

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
    (code): number | null => {
      terminal.close();
      return code;
    },
    (): null => {
      terminal.close();
      return null;
    },
  );
  return {
    write: (data): void => {
      terminal.write(data);
    },
    // agy's login screen can outlive SIGTERM; a survivor keeps running in a
    // HOME whose keychain is about to be removed, and macOS then asks the
    // user for a keychain out of nowhere. Escalate to SIGKILL.
    kill: (): void => killHard(proc),
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
  /** Resolves once the login screen's process has exited (at once when it
   *  never started). */
  readonly exited: Promise<void>;
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
  /**
   * The sign-in store check (metadata only). Polled once the URL is out: a
   * sign-in is complete when `agy` has stored it, which happens BEFORE its
   * first-run wizard (colour scheme, then a Terms / data-use consent page).
   * The wizard is never answered — the screen is closed instead.
   */
  readonly isSignedIn: () => Promise<boolean>;
  readonly pollMs?: number;
}): TAgyLogin => {
  // The RAW tail, stripped as a whole on every read: a PTY read can end in
  // the middle of an escape sequence, and stripping each read on its own
  // would leave that sequence's tail in the text.
  let raw = "";
  let screen = "";
  // What is on screen NOW, rendered by a real terminal emulator: clears,
  // line erases, cursor moves and screen switches all apply, so a prompt
  // agy replaced (consent page, wizard) is gone — not retained as text the
  // way stripping keeps it.
  const emulator = new Terminal({
    cols: AGY_LOGIN_COLS,
    rows: AGY_LOGIN_ROWS,
    scrollback: 0,
    allowProposedApi: true,
  });
  let visible = "";
  // Output not yet rendered: while any is pending, the screen may already
  // have moved on, so no code is typed and no exit is judged.
  let pendingWrites = 0;
  let drained: Array<() => void> = [];
  const renderDone = (): void => {
    pendingWrites -= 1;
    renderVisible();
    if (pendingWrites === 0) {
      maybeSurface();
      const waiters = drained;
      drained = [];
      for (const resolve of waiters) resolve();
    }
  };
  /** Resolves once every chunk received so far is rendered. */
  const allRendered = (): Promise<void> =>
    pendingWrites === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          drained.push(resolve);
        });
  const renderVisible = (): void => {
    if (settled) return;
    const buffer = emulator.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < emulator.rows; y++) {
      lines.push(
        buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "",
      );
    }
    visible = lines.join("\n");
  };
  // The link is surfaced only once ALL received output is rendered and the
  // link and its code prompt are both on that one rendered screen: a
  // replaced link (a second attempt) is never the one published, and a
  // code pasted right away is never refused for lag.
  const maybeSurface = (): void => {
    if (settled || !menuAnswered || surfaced !== null) return;
    const parsed = parseAgyAuthUrl(visible);
    if (parsed !== null && CODE_PROMPT_RE.test(visible)) {
      surfaced = parsed;
      resolveUrl(parsed);
    }
  };
  let menuAnswered = false;
  let surfaced: TAgyAuthUrl | null = null;
  let codeTyped = false;
  let childExited = false;
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
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    resolveUrl(surfaced);
    resolveDone(outcome);
    pty?.kill();
    emulator.dispose();
  };

  const onData = (chunk: Uint8Array): void => {
    if (settled) return;
    // Keep a bounded tail: the screen redraws, only the latest state matters.
    raw = `${raw}${decoder.decode(chunk, { stream: true })}`.slice(-65_536);
    screen = stripTerminal(raw);
    if (chunk.length > 0) {
      pendingWrites += 1;
      emulator.write(chunk, renderDone);
    }
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
      // An injected spawner can deliver output before its handle returns:
      // answer the menu only once there is a terminal to answer it on.
      if (pty === null) return;
      menuAnswered = true;
      pty.write("\r");
      return;
    }
    if (SIGNED_IN_RE.test(screen)) {
      // Already signed in when the screen opened: done. After a code or the
      // browser, the banner only prompts a store check — the screen closes
      // once `agy` has actually stored the sign-in, never before.
      if (!menuAnswered) settle({ kind: "signed_in" });
      else if (codeTyped || surfaced !== null) checkStore();
    }
  };

  // Once the link is out, the store decides: the browser may complete the
  // sign-in on its own, or a pasted code may.
  // One store check at a time: a slow keychain probe never piles up.
  let inFlight: Promise<boolean> | null = null;
  const checkStore = (): void => {
    if (settled || inFlight !== null) return;
    const check = args.isSignedIn().then(
      (yes) => yes,
      () => false,
    );
    inFlight = check;
    void check.then((yes) => {
      inFlight = null;
      if (yes) settle({ kind: "signed_in" });
    });
  };
  const poll = setInterval(() => {
    if (surfaced !== null) checkStore();
  }, args.pollMs ?? 1_000);
  timers.push(poll as unknown as ReturnType<typeof setTimeout>);

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
  // Output delivered before the handle returned: a flow that already
  // settled on it kills the screen now; a late menu is answered now.
  if (pty !== null && settled) pty.kill();
  else if (pty !== null) onData(new Uint8Array());
  // `agy` may store the sign-in and exit before a poll sees it: the store
  // decides once the link is out.
  void pty?.exited.then(async () => {
    if (settled) return;
    // Nothing is listening any more: no code may be typed while the final
    // store check runs.
    childExited = true;
    // Wait for a poll already running (it may be the one that sees the
    // sign-in); if it doesn't confirm, check once more now `agy` is gone.
    // Everything agy wrote before exiting is rendered first, so a link it
    // printed just before storing the sign-in and exiting still counts.
    await Promise.race([allRendered(), Bun.sleep(1_000)]);
    if (settled) return;
    const running = inFlight;
    const finalCheck = async (): Promise<boolean> => {
      if (running !== null && (await running)) return true;
      // Tracked like a poll, so the interval never starts another alongside.
      const check = args.isSignedIn().catch(() => false);
      inFlight = check;
      return check;
    };
    const stored = surfaced !== null && (await finalCheck());
    settle(
      stored
        ? { kind: "signed_in" }
        : { kind: "failed", reason: "agy exited before sign-in finished" },
    );
  });
  // A failed spawn already settled: arm no deadlines for it.
  if (!settled)
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
      // One code per screen: once typed, `agy` is no longer at the prompt.
      // …and only while that prompt is still what `agy` shows: once its
      // screen moved on (the browser finished, the first-run wizard with
      // its consent page), nothing pasted may reach it.
      // …and only for the link that was shown: if agy replaced it (a second
      // attempt), a code from the first link must not reach the second.
      const atPrompt =
        CODE_PROMPT_RE.test(visible) &&
        surfaced !== null &&
        parseAgyAuthUrl(visible)?.url === surfaced.url;
      if (
        pendingWrites > 0 ||
        settled ||
        childExited ||
        surfaced === null ||
        codeTyped ||
        !atPrompt
      ) {
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
    exited:
      pty === null
        ? Promise.resolve()
        : pty.exited.then(
            () => undefined,
            () => undefined,
          ),
  };
};
