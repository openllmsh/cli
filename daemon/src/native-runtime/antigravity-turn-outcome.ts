/**
 * What `agy` itself recorded about a turn that failed, ended empty or came
 * back as a `refusal`. `agy acp` reports an upstream API failure as a chat
 * message plus `end_turn`; its per-session SQLite log
 * (`<HOME>/.gemini/antigravity-cli/conversations/<sessionId>.db`, table
 * `steps`) ends that turn with an error step (type 17). Reading it is best
 * effort: bounded, read-only, and a missing / locked / foreign file is "no
 * evidence", never an error.
 */

import { Database } from "bun:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { TAntigravityFailure } from "./antigravity-common";
import { classifyAgyMessage } from "./antigravity-common";

/** CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory. */
const ERROR_STEP_TYPE = 17;
/** CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within the turn. */
const PLANNER_RESPONSE_STEP_TYPE = 15;
/** The harness error text leads the payload; a Go stack trace follows. */
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
const SESSION_ID_RE = /^[\w-]+$/;

/** A saved thinking block Claude rejects stays in agy's history, so every
 *  later prompt to that session fails the same way. */
export const INVALID_THINKING_SIGNATURE_RE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block|[^\n]*signature)/;

const API_ERROR_RE = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
const STATUS_ERROR_RE = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED_RE = /\breason:QUOTA_EXHAUSTED\b/;
const RESET_TIMESTAMP_RE = /\bquotaResetTimeStamp:([^\s\]]+)/;
const DURATION = String.raw`(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+`;
const RESET_DELAY_RE = new RegExp(
  String.raw`\b(?:quotaResetDelay|retryDelay):(${DURATION})(?=[\s\]])`,
);
const DURATION_PART_RE = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** When a quota resets, from `quotaResetTimeStamp:` or a Go-duration
 *  `quotaResetDelay:` / `retryDelay:` in `text`; null when unnamed. */
export const quotaResetAtMs = (
  text: string,
  now: number = Date.now(),
): number | null => {
  const stamp = RESET_TIMESTAMP_RE.exec(text)?.[1];
  if (stamp !== undefined) {
    const at = Date.parse(stamp);
    if (Number.isFinite(at)) return at;
  }
  const delay = RESET_DELAY_RE.exec(text)?.[1];
  if (delay === undefined) return null;
  let ms = 0;
  for (const [, amount, unit] of delay.matchAll(DURATION_PART_RE)) {
    ms += Number(amount) * (UNIT_MS[unit ?? ""] ?? 0);
  }
  return ms > 0 ? now + Math.round(ms) : null;
};

export type TLastStep = {
  readonly type: number;
  readonly text: string;
  readonly reachedModel: boolean;
};

const conversationDb = (home: string, sessionId: string): string | null =>
  SESSION_ID_RE.test(sessionId)
    ? join(
        home,
        ".gemini",
        "antigravity-cli",
        "conversations",
        `${sessionId}.db`,
      )
    : null;

const openReadOnly = (file: string): Database | null => {
  try {
    // A regular file only: never follow a link out of the profile.
    if (!existsSync(file) || !lstatSync(file).isFile()) return null;
    const db = new Database(file, { readonly: true });
    db.exec("PRAGMA busy_timeout = 50");
    return db;
  } catch {
    return null;
  }
};

/**
 * The highest step index now in the session log, taken before a prompt so
 * only that prompt's steps are judged. -1 when the session has no log yet
 * (every step is then this prompt's); `undefined` when the log exists but
 * could not be read — the caller must then skip step-log judging, or a stale
 * error from an earlier turn would be blamed on this prompt.
 */
export const readStepWatermark = (
  home: string,
  sessionId: string,
): number | undefined => {
  const file = conversationDb(home, sessionId);
  if (file === null) return undefined;
  if (!existsSync(file)) return -1;
  const db = openReadOnly(file);
  if (db === null) return undefined;
  try {
    const row = db.query("SELECT max(idx) AS idx FROM steps").get() as {
      idx?: unknown;
    } | null;
    if (row === null) return -1;
    return typeof row.idx === "number"
      ? row.idx
      : row.idx === null
        ? -1
        : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
};

/** The last step the prompt after `watermark` added, or null. */
export const readLastStepAfter = (
  home: string,
  sessionId: string,
  watermark: number,
): TLastStep | null => {
  const file = conversationDb(home, sessionId);
  const db = file === null ? null : openReadOnly(file);
  if (db === null) return null;
  try {
    const row = db
      .query(
        `SELECT step_type AS type, substr(step_payload, 1, ?1) AS payload
         FROM steps WHERE idx > ?2 ORDER BY idx DESC LIMIT 1`,
      )
      .get(MAX_ERROR_PAYLOAD_BYTES, watermark) as {
      type?: unknown;
      payload?: unknown;
    } | null;
    if (typeof row?.type !== "number") return null;
    const reached =
      db
        .query("SELECT 1 FROM steps WHERE idx > ?1 AND step_type = ?2 LIMIT 1")
        .get(watermark, PLANNER_RESPONSE_STEP_TYPE) !== null;
    const bytes =
      row.payload instanceof Uint8Array
        ? row.payload
        : typeof row.payload === "string"
          ? new TextEncoder().encode(row.payload)
          : new Uint8Array();
    return {
      type: row.type,
      text: new TextDecoder().decode(bytes),
      reachedModel: reached,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
};

/** A failed turn, as far as `agy`'s own record and the stop reason tell. */
export type TTurnFailure = TAntigravityFailure & {
  /** The session's saved history can no longer be sent: never reuse it. */
  readonly broken?: boolean;
  /** Safe to retry (a transient upstream error). */
  readonly retryable?: boolean;
  /** Absolute time the quota / rate limit lifts, when agy's log names it. */
  readonly recoverAtMs?: number;
};

/** A short, control-free excerpt of vendor text — never the whole message. */
const excerpt = (text: string): string =>
  Array.from(
    text
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 80)
    .join("");

/**
 * Classify a turn from its stop reason and `agy`'s last step. `undefined`
 * means the evidence shows no failure (the caller keeps its own verdict).
 * The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
 */
export const classifyTurnOutcome = (
  stopReason: string | undefined,
  step: TLastStep | null,
  now: number = Date.now(),
): TTurnFailure | undefined => {
  const text = step?.type === ERROR_STEP_TYPE ? step.text : undefined;
  if (text === undefined && stopReason !== "refusal") return undefined;
  const body = text ?? "";
  const resetAt = quotaResetAtMs(body, now);
  const at = resetAt === null ? {} : { recoverAtMs: resetAt };
  const byMessage = classifyAgyMessage(body);
  if (
    QUOTA_EXHAUSTED_RE.test(body) ||
    byMessage?.cooldown === "quota_exhausted"
  ) {
    return {
      reason: "antigravity: quota exhausted",
      cooldown: "quota_exhausted",
      retryable: true,
      ...at,
    };
  }
  if (INVALID_THINKING_SIGNATURE_RE.test(body)) {
    return {
      reason:
        "antigravity: saved conversation rejected by the model (invalid thinking signature)",
      broken: true,
      retryable: true,
    };
  }
  // A refusal with no quota evidence is a plain failure: a safety refusal
  // must never rest the account.
  if (stopReason === "refusal" && text === undefined) {
    return { reason: "antigravity: the model refused the turn" };
  }
  const api = API_ERROR_RE.exec(body);
  const alt = api === null ? STATUS_ERROR_RE.exec(body) : null;
  const httpStatus = api?.[1] ?? alt?.[2];
  if (byMessage !== null) {
    return {
      ...byMessage,
      retryable: byMessage.cooldown === "rate_limit",
      ...(byMessage.cooldown === "rate_limit" ? at : {}),
    };
  }
  // A 404 before the model answered is an unknown / unentitled model; after
  // it, a transient edge error.
  if (httpStatus === "404" && step?.reachedModel === true) {
    return {
      reason: "antigravity: transient upstream 404",
      retryable: true,
    };
  }
  const detail = excerpt(api?.[2] ?? alt?.[3] ?? body);
  return {
    reason: `antigravity: upstream error${httpStatus !== undefined ? ` (HTTP ${httpStatus})` : ""}${detail.length > 0 ? `: ${detail}` : ""}`,
    retryable: httpStatus !== undefined && Number(httpStatus) >= 500,
  };
};
