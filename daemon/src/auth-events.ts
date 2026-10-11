/**
 * Subscription-auth event sink.
 *
 * `login-flow` (and the connect adaptors) emit `AuthEvent`s; the control
 * channel registers a sink that wraps each one in a `type: "auth"` relay
 * frame and pushes status. A dedicated module so login-flow does not import
 * the WebSocket transport (that would cycle: control-channel → control-relay
 * → delegates → login-flow).
 */
import type { TAuthEvent } from "@openllmsh/protocol";
import { withoutCommandReplayContext } from "./op-context";

export type TAuthSink = {
  readonly emit: (event: TAuthEvent) => void;
  readonly pushStatus: () => void;
};

export type TVerifiedLoginAdmit = (flow: {
  readonly slug: string;
  readonly flowId: string;
}) => boolean;

let sink: TAuthSink | null = null;
let verifiedLoginAdmit: TVerifiedLoginAdmit | null = null;
const observers = new Set<(event: TAuthEvent) => void>();

/** Install (or clear) the transport sink. Called from `startControlChannel`. */
export const setAuthSink = (next: TAuthSink | null): void => {
  sink = next;
};

/** Status registers the last-known seed. Login-flow must not import status. */
export const setVerifiedLoginAdmitter = (
  next: TVerifiedLoginAdmit | null,
): void => {
  verifiedLoginAdmit = next;
};

/** Seed a verified login observation when an admitter is registered. */
export const admitVerifiedLogin = (flow: {
  readonly slug: string;
  readonly flowId: string;
}): boolean => {
  if (verifiedLoginAdmit === null) return true;
  try {
    return verifiedLoginAdmit(flow) === true;
  } catch {
    return false;
  }
};

/** Add an independent best-effort auth-event observer. */
export const addAuthObserver = (
  observer: (event: TAuthEvent) => void,
): (() => void) => {
  observers.add(observer);
  return () => observers.delete(observer);
};

/** Best-effort: no-op when the control channel is not running (tests, headless). */
export const emitAuth = (event: TAuthEvent): void => {
  try {
    withoutCommandReplayContext(() => sink?.emit(event));
  } catch {
    // Relay delivery must not prevent independent observers from running.
  }
  for (const observer of observers) {
    try {
      withoutCommandReplayContext(() => observer(event));
    } catch {
      // Observers are advisory and must never disrupt relay delivery or peers.
    }
  }
};

/** Best-effort status push so a background login finalize flips the card. */
export const requestStatusPush = (): void => {
  withoutCommandReplayContext(() => sink?.pushStatus());
};
