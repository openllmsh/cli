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

type TInferenceAdmission = {
  readonly signal: AbortSignal;
  run: (
    request: Request,
    handler: (request: Request) => Promise<Response>,
  ) => Promise<Response>;
  stop: (timeoutMs?: number) => Promise<void>;
};

/** Track inference through plan fetch and response body, including tunnel requests. */
export const createInferenceAdmission = (): TInferenceAdmission => {
  let stopping = false;
  const shutdown = new AbortController();
  const active = new Set<{
    abort: AbortController;
    done: Promise<void>;
    cancel: (() => void) | null;
  }>();
  return {
    signal: shutdown.signal,
    async run(request, handler) {
      if (stopping)
        return new Response("daemon shutting down", { status: 503 });
      const abort = new AbortController();
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entry = { abort, done, cancel: null as (() => void) | null };
      active.add(entry);
      const complete = (): void => {
        active.delete(entry);
        finish();
      };
      try {
        const req = new Request(request, {
          signal: AbortSignal.any([request.signal, abort.signal]),
        });
        const response = await handler(req);
        if (!response.body) {
          complete();
          return response;
        }
        const reader = response.body.getReader();
        entry.cancel = () => {
          void reader
            .cancel()
            .catch(() => undefined)
            .finally(complete);
        };
        if (stopping) entry.cancel();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const item = await reader.read();
              if (item.done) {
                complete();
                controller.close();
              } else controller.enqueue(item.value);
            } catch (error) {
              complete();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              complete();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        complete();
        throw error;
      }
    },
    async stop(timeoutMs = 3_000) {
      stopping = true;
      shutdown.abort();
      for (const entry of active) {
        entry.abort.abort();
        entry.cancel?.();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...active].map((entry) => entry.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
};

export const inferenceAdmission = createInferenceAdmission();

type TOpenHold = {
  readonly nonce: string;
  readonly model: string;
  readonly origin: string | null;
  readonly outcome: THoldOutcome;
};

/** Sessions holding an unsettled hold, so shutdown can settle them first. */
const openSessions = new Set<HoldSession>();

/**
 * Settle every open hold now. Shutdown calls this before draining the
 * journal: a stream still running would otherwise queue its settlement after
 * the drain and be lost to `process.exit`, leaving the sweep to charge in full.
 */
export const finishOpenHoldSessions = (): void => {
  for (const session of [...openSessions]) session.close();
};

export class HoldSession {
  private hold: TOpenHold | null = null;
  private closed = false;

  constructor(
    private readonly endpoint: string,
    private readonly startedAt: number,
    private readonly admissionSignal?: AbortSignal,
  ) {}

  close(): void {
    this.closed = true;
    this.finish();
  }

  canDispatch(signal: AbortSignal, admission: TInferenceAdmission): boolean {
    return !this.closed && !signal.aborted && !admission.signal.aborted;
  }

  /** Take ownership of a hold the cloud just handed out. */
  adopt(nonce: string, model: string, origin: string | null): THoldOutcome {
    if (this.closed || this.admissionSignal?.aborted)
      throw new Error("daemon shutting down");
    if (this.hold !== null && this.hold.nonce !== nonce) this.finish();
    if (this.hold?.nonce === nonce) return this.hold.outcome;
    const outcome = newHoldOutcome();
    this.hold = { nonce, model, origin, outcome };
    openSessions.add(this);
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
    openSessions.delete(this);
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
    if (!this.open) {
      // Settled elsewhere (e.g. the walker's usage record): stop tracking.
      openSessions.delete(this);
      return response;
    }
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
