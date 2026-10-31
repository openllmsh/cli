/**
 * One request's cap holds, finalized on EVERY exit
 * (docs/plan/2026-10-31-hold-finalization.md).
 *
 * A capped plan's hold is bound to this device and already dispatched, so
 * its terminal record decides the charge:
 *
 * - a success record with usage settled it (the walk's own record) → nothing
 *   more to send;
 * - the request ended before any provider call (superseded plan, invalid
 *   input, a non-retryable refusal) → settle the usage seen, usually 0;
 * - the client received a body whose usage never arrived, or the walk threw
 *   after it started → `usage_unknown`: the cloud charges the full hold.
 *
 * `handleInference` runs inside {@link withHoldSession}, whose `finally`
 * guarantees the terminal record however the handler exits; records go
 * through the durable outbox (`hold-outbox.ts`).
 */
import type { TDaemonRecordRequest } from "@openllmsh/protocol";
import type { THoldOutcome } from "./access-hold-context";
import { newHoldOutcome, trackHoldRecord } from "./access-hold-context";
import { recordRequest } from "./cloud-client";

type TOpenHold = {
  readonly nonce: string;
  readonly model: string;
  readonly origin: string | null;
  readonly outcome: THoldOutcome;
  /** The walk started: from here an exception may follow a provider call. */
  walking: boolean;
};

export type THoldFinish = "no_body" | "delivered" | "threw";

export class HoldSession {
  private hold: TOpenHold | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly startedAt: number,
  ) {}

  /** Take ownership of a hold the cloud just handed out. */
  adopt(nonce: string, model: string, origin: string | null): THoldOutcome {
    if (this.hold !== null && this.hold.nonce !== nonce) this.finish("no_body");
    if (this.hold?.nonce === nonce) return this.hold.outcome;
    const outcome = newHoldOutcome();
    this.hold = { nonce, model, origin, outcome, walking: false };
    return outcome;
  }

  /** Mark the start of the walk for the current hold. */
  startWalk(): void {
    if (this.hold !== null) this.hold.walking = true;
  }

  get open(): boolean {
    return this.hold !== null && !this.hold.outcome.settled;
  }

  get outcome(): THoldOutcome | null {
    return this.hold?.outcome ?? null;
  }

  get nonce(): string | null {
    return this.hold?.nonce ?? null;
  }

  /**
   * Send the current hold's terminal record unless a success record already
   * settled it. `delivered`: the client got a body; `threw`: the handler
   * threw. Returns the pending delivery (for one-hop-at-a-time retries).
   */
  finish(how: THoldFinish): Promise<void> | null {
    const hold = this.hold;
    this.hold = null;
    if (hold === null || hold.outcome.settled) return null;
    hold.outcome.settled = true;
    const tokensIn = hold.outcome.partialTokensIn;
    const tokensOut = hold.outcome.partialTokensOut;
    const usageUnknown =
      tokensIn + tokensOut === 0 &&
      (how === "delivered" || (how === "threw" && hold.walking));
    const model = hold.outcome.lastModel ?? hold.model;
    const row: TDaemonRecordRequest = {
      model,
      provider: hold.outcome.lastProvider ?? model.split("/")[0] ?? "",
      status: "error",
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: Date.now() - this.startedAt,
      endpoint: this.endpoint,
      error:
        how === "delivered"
          ? "Response ended without a usage report"
          : how === "threw"
            ? "Request failed"
            : "Hop failed",
      hold_nonce: hold.nonce,
      ...(usageUnknown ? { usage_unknown: true as const } : {}),
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
        this.finish("no_body");
      });
      return response;
    }
    const later = (): void => {
      setTimeout(() => {
        this.finish("delivered");
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
    session.finish("threw");
    throw err;
  }
  return session.attach(response);
};
