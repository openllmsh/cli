/**
 * What counts as fatal for the daemon process.
 *
 * The last-resort handlers in `main.ts` exit non-zero on an uncaught throw:
 * continuing after a genuine fault leaves the process in an indeterminate
 * state, and the supervisor restarts it clean. That reasoning does NOT hold for
 * a transport error handed to us by the network.
 *
 * The case that forced this: a WebRTC ICE agent probes the peer's candidates
 * over UDP. When one is unreachable the network answers with ICMP
 * port-unreachable, and because the socket carries `IP_RECVERR` (Linux) the
 * kernel reports it as `ECONNREFUSED` on the next receive. `werift` registers
 * only a `"message"` listener on that socket and no `"error"` one, so the
 * error arrives as an uncaughtException — and the daemon killed itself over a
 * remote peer's dead candidate. On a box with a dashboard open and retrying,
 * that is an unbroken crash loop; it is also a remote DoS, since anything that
 * makes the daemon send a datagram to a closed port takes it down.
 *
 * Such an error says nothing about the health of this process. It is logged and
 * survived. Everything else still exits.
 */
import { isStreamResetError } from "@openllmsh/tunnel";

/**
 * Errno codes that describe the state of a REMOTE peer or the network path,
 * never the state of this process.
 *
 * Deliberately a closed list of transport errnos rather than anything
 * resembling a network error: an unrecognised throw must keep exiting, because
 * the whole value of the last-resort handler is not limping on after a real
 * fault. Permission errors are deliberately excluded because they can also
 * originate in unrelated local filesystem or process operations.
 */
export const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ETIMEDOUT",
]);

/** `Error: ECONNREFUSED: connection refused, recv` — Bun puts the errno first
 *  in the message. Matched only when the error carries no `code`, since the
 *  code is the reliable signal and this is the fallback. */
const leadingErrno = (message: string): string | null => {
  // Upper bound covers the longest errno in the set (`EHOSTUNREACH`, 12) with
  // room to spare; it is only a cheap shape guard — the set decides.
  const match = /^(?:[A-Za-z]*Error:\s*)?([A-Z]{4,16}):/.exec(message.trim());
  return match?.[1] ?? null;
};

/**
 * Whether this error is a remote/transport condition the daemon should log and
 * survive rather than exit over.
 */
export const isTransientNetworkError = (err: unknown): boolean => {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return TRANSIENT_NETWORK_CODES.has(code);
  }
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : null;
  if (message === null) return false;
  const errno = leadingErrno(message);
  return errno !== null && TRANSIENT_NETWORK_CODES.has(errno);
};

/**
 * A tunnel/mux stream reset (`StreamResetError`) is transport lifecycle data —
 * a peer's channel went away, a session open was refused, an open timed out, a
 * frame violated the protocol. Like a dead-socket errno (above), it says
 * NOTHING about the health of THIS process, yet its `code` (`protocol_error`,
 * `peer_gone`, `timeout`, session NACK codes, …) is NOT one of the network
 * errnos, so the bare `isTransientNetworkError` gate would let a leaked reset
 * take the fatal branch in `main.ts` and kill the daemon over a remote peer's
 * behaviour. That is exactly the crash-loop shape `crash-policy` exists to
 * prevent.
 *
 * We classify by `instanceof` (`isStreamResetError`), NEVER by string-matching
 * `"protocol_error"`: an arbitrary application error must keep exiting, since
 * the whole value of the last-resort handler is not limping on after a real
 * fault. Only a genuine `StreamResetError` instance is survived.
 */
export const isSurvivableTransportError = (err: unknown): boolean =>
  isTransientNetworkError(err) || isStreamResetError(err);
