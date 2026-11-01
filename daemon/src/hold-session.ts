/**
 * One request's cap holds, finalized on EVERY exit
 * (docs/plan/2026-10-31-hold-finalization.md).
 *
 * A capped plan's hold is bound to this device and already dispatched, so
 * its terminal record decides the charge:
 *
 * - a success record with complete usage settled it (the walk's own record,
 *   carrying every earlier attempt's charge) → nothing more to send;
 * - otherwise send the request's charge so far: tokens of attempts with
 *   complete usage, and how many sends had no usage evidence (each charged
 *   the full reservation by the cloud).
 *
 * `handleInference` runs inside {@link withHoldSession}, whose `finally`
 * guarantees the terminal record however the handler exits; records go
 * through the durable outbox (`hold-outbox.ts`).
 */
import type { TDaemonRecordRequest } from "@openllmsh/protocol";
import type { THoldOutcome } from "./access-hold-context";
import {
  holdCharge,
  newHoldOutcome,
  trackHoldRecord,
} from "./access-hold-context";
import { recordRequest } from "./cloud-client";

type TOpenHold = {
  readonly nonce: string;
  readonly model: string;
  readonly origin: string | null;
  readonly outcome: THoldOutcome;
};

export class HoldSession {
  private hold: TOpenHold | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly startedAt: number,
  ) {}

  /** Take ownership of a hold the cloud just handed out. */
  adopt(nonce: string, model: string, origin: string | null): THoldOutcome {
    if (this.hold !== null && this.hold.nonce !== nonce) this.finish();
    if (this.hold?.nonce === nonce) return this.hold.outcome;
    const outcome = newHoldOutcome();
    this.hold = { nonce, model, origin, outcome };
    return outcome;
  }

  get open(): boolean {
    return this.hold !== null && !this.hold.outcome.settled;
  }

  get outcome(): THoldOutcome | null {
    return this.hold?.outcome ?? null;
  }

  /**
   * Send the current hold's terminal record unless a success record already
   * settled it. Returns the pending delivery.
   */
  finish(): Promise<void> | null {
    const hold = this.hold;
    this.hold = null;
    if (hold === null || hold.outcome.settled) return null;
    hold.outcome.settled = true;
    const charge = holdCharge(hold.outcome);
    const model = hold.outcome.lastModel ?? hold.model;
    const row: TDaemonRecordRequest = {
      model,
      provider: hold.outcome.lastProvider ?? model.split("/")[0] ?? "",
      status: "error",
      tokens_in: 0,
      tokens_out: 0,
      latency_ms: Date.now() - this.startedAt,
      endpoint: this.endpoint,
      error: "Request ended without a complete usage report",
      hold_nonce: hold.nonce,
      hold_prior_tokens: charge.priorTokens,
      hold_unknown_attempts: charge.unknownAttempts,
    };
    const record = recordRequest(row, hold.origin);
    trackHoldRecord(hold.nonce, record);
    return record;
  }

  /**
   * Finalize when the response is over: at once for an error or bodyless
   * response, otherwise when the body ends, errors or is cancelled. Stream
   * completion records run on the same tick as the body's end; a turn later
   * lets a success record settle the hold first.
   */
  attach(response: Response): Response {
    if (!this.open) return response;
    if (!response.ok || response.body === null) {
      queueMicrotask(() => {
        this.finish();
      });
      return response;
    }
    const later = (): void => {
      setTimeout(() => {
        this.finish();
      }, 0);
    };
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        pull: async (controller): Promise<void> => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              later();
              return;
            }
            controller.enqueue(value);
          } catch (err) {
            controller.error(err);
            later();
          }
        },
        cancel: async (reason): Promise<void> => {
          await reader.cancel(reason).catch(() => undefined);
          later();
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  }
}

/** Run a request handler so its hold is finalized on every exit. */
export const withHoldSession = async (
  session: HoldSession,
  run: () => Promise<Response>,
): Promise<Response> => {
  let response: Response;
  try {
    response = await run();
  } catch (err) {
    session.finish();
    throw err;
  }
  return session.attach(response);
};
