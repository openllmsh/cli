/**
 * Front door 2: the loopback agent endpoint for the desktop app talking to its
 * OWN machine's daemon (plan "Agent protocol" → Transports → Desktop app).
 *
 *   GET ws://127.0.0.1:<port>/local/agent   (WebSocket upgrade)
 *
 * The socket carries the same NDJSON-shaped protocol as the mux stream, one
 * JSON value per text message: {@link TAgentCommand} in, {@link TAgentEvent}
 * out, plus `{"t":"replay_done"}` after an attach replay.
 *
 * Admission (no device grant on loopback — the caller is on this machine):
 *   1. the peer address is loopback, and the `Host` header names loopback
 *      (DNS-rebinding guard);
 *   2. `Origin`, when present, is the desktop app's Tauri origin or an OpenLLM
 *      deployment the app's webview renders — any other browser origin is
 *      refused;
 *   3. the local control capability (the per-boot, owner-only token the
 *      doctor / `/local/auth` routes use) is presented, either as the
 *      capability header (CLI / native code) or, because a browser WebSocket
 *      cannot set headers, as a `Sec-WebSocket-Protocol` entry
 *      `openllm-cap.<token>` next to {@link AGENT_LOCAL_SUBPROTOCOL}.
 */
import type { TAgentCommand, TAgentEvent } from "@openllmsh/protocol";
import {
  AGENT_MAX_LINE_BYTES,
  DOCTOR_LOCAL_CAPABILITY_HEADER,
  encodeAgentLine,
  parseAgentCommand,
  parseStreamCtrlPayload,
} from "@openllmsh/protocol";
import { isTrustedDeploymentOrigin } from "../cors";
import { capabilityMatches } from "../doctor-report/capability";
import { isLoopbackLocalHost } from "../local-http";
import type { TAgentDispatcher } from "./dispatcher";
import type { TAgentConnection } from "./types";

/** Path of the loopback agent WebSocket on the daemon's localhost surface. */
export const AGENT_LOCAL_PATH = "/local/agent";

/** The subprotocol a loopback agent client offers (and the server selects). */
export const AGENT_LOCAL_SUBPROTOCOL = "openllm-agent.v1";

/** Prefix of the subprotocol entry that carries the capability token. */
export const AGENT_LOCAL_CAPABILITY_PROTOCOL_PREFIX = "openllm-cap.";

/**
 * The desktop app's own webview origins: macOS/iOS WKWebView serve the bundle
 * as `tauri://localhost`; Windows/Linux as `http(s)://tauri.localhost`.
 */
export const TAURI_ORIGINS: ReadonlySet<string> = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

export type TLocalAgentRefusal =
  | "not_loopback"
  | "forbidden_origin"
  | "capability_missing";

const isLoopbackAddress = (address: string | null | undefined): boolean => {
  if (address === null || address === undefined) return false;
  const raw = address.trim().toLowerCase();
  if (raw === "::1" || raw === "localhost") return true;
  const v4 = raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
  return /^127(\.\d{1,3}){3}$/.test(v4);
};

/** Whether a loopback agent caller's `Origin` may drive this daemon. */
export const isAllowedLocalAgentOrigin = (origin: string | null): boolean =>
  origin === null ||
  TAURI_ORIGINS.has(origin) ||
  isTrustedDeploymentOrigin(origin);

const offeredProtocols = (req: Request): string[] =>
  (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const presentedCapability = (req: Request): string | null => {
  const header = req.headers.get(DOCTOR_LOCAL_CAPABILITY_HEADER);
  if (header !== null) return header;
  const entry = offeredProtocols(req).find((one) =>
    one.startsWith(AGENT_LOCAL_CAPABILITY_PROTOCOL_PREFIX),
  );
  return entry === undefined
    ? null
    : entry.slice(AGENT_LOCAL_CAPABILITY_PROTOCOL_PREFIX.length);
};

/**
 * Admission for a loopback agent upgrade. `remoteAddress` is the TCP peer
 * (`server.requestIP(req)?.address`). Null = admitted.
 */
export const localAgentRefusal = (
  req: Request,
  remoteAddress: string | null | undefined,
): TLocalAgentRefusal | null => {
  if (!isLoopbackAddress(remoteAddress)) return "not_loopback";
  if (!isLoopbackLocalHost(req.headers.get("host"))) return "not_loopback";
  if (!isAllowedLocalAgentOrigin(req.headers.get("origin")))
    return "forbidden_origin";
  return capabilityMatches(presentedCapability(req))
    ? null
    : "capability_missing";
};

/** The subprotocol to select on upgrade, when the client offered one. */
export const selectedLocalAgentProtocol = (req: Request): string | null =>
  offeredProtocols(req).includes(AGENT_LOCAL_SUBPROTOCOL)
    ? AGENT_LOCAL_SUBPROTOCOL
    : null;

export const localAgentRefusalResponse = (
  refusal: TLocalAgentRefusal,
): Response =>
  new Response(JSON.stringify({ error: refusal }), {
    status: 403,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

/** `Bun.serve` per-socket data for a loopback agent socket. */
export type TLocalAgentSocketData = {
  readonly agentLoopback: true;
  connection: TAgentConnection | null;
};

export const localAgentSocketData = (): TLocalAgentSocketData => ({
  agentLoopback: true,
  connection: null,
});

/** Minimal socket surface the handlers need (Bun's `ServerWebSocket`). */
export type TLocalAgentSocket = {
  readonly data: TLocalAgentSocketData;
  readonly sendText: (text: string) => number;
  readonly close: (code?: number, reason?: string) => void;
};

const textEncoder = new TextEncoder();

/**
 * WebSocket handlers for a loopback agent socket. The caller (`main.ts`)
 * dispatches to these only for sockets whose data is
 * {@link TLocalAgentSocketData}.
 */
export const createLocalAgentWebSocket = (
  dispatcher: () => TAgentDispatcher | null,
): {
  readonly open: (socket: TLocalAgentSocket) => void;
  readonly message: (
    socket: TLocalAgentSocket,
    message: string | Buffer,
  ) => void;
  readonly close: (socket: TLocalAgentSocket) => void;
} => ({
  open: (socket) => {
    const active = dispatcher();
    if (active === null) {
      socket.close(1011, "agent_unavailable");
      return;
    }
    let ended = false;
    socket.data.connection = active.connect({
      send: async (event: TAgentEvent) => {
        if (ended) return false;
        // Same size bound as a mux line; the socket carries one value per
        // message, so no trailing newline.
        if (encodeAgentLine(event) === null) return false;
        // Bun: >0 sent, -1 queued under backpressure, 0 dropped (closed).
        return socket.sendText(JSON.stringify(event)) !== 0;
      },
      replayDone: () => {
        if (!ended) socket.sendText(JSON.stringify({ t: "replay_done" }));
      },
      end: (code) => {
        if (ended) return;
        ended = true;
        if (code === undefined) socket.close(1000, "done");
        else socket.close(code === "lagging" ? 1008 : 1002, code);
      },
    });
  },
  message: (socket, message) => {
    const connection = socket.data.connection;
    if (connection === null) return;
    const text = typeof message === "string" ? message : null;
    if (
      text === null ||
      textEncoder.encode(text).byteLength > AGENT_MAX_LINE_BYTES
    ) {
      connection.invalid(undefined);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      connection.invalid(undefined);
      return;
    }
    const ctrl = parseStreamCtrlPayload(parsed);
    if (ctrl?.t === "focus") {
      connection.focus();
      return;
    }
    if (ctrl?.t === "blur") {
      connection.blur();
      return;
    }
    const command: TAgentCommand | null = parseAgentCommand(parsed);
    if (command === null) connection.invalid(parsed);
    else connection.command(command);
  },
  close: (socket) => {
    const connection = socket.data.connection;
    socket.data.connection = null;
    connection?.detach();
  },
});
