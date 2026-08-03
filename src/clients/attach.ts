/**
 * Local terminal view for a daemon-brokered PTY session.
 *
 * The broker owns the PTY; this module only translates terminal bytes and the
 * small JSON control envelope. Unknown envelopes deliberately disappear so CLI
 * and daemon versions can roll independently.
 */

import type { TDaemonCli } from "./registry";

export type TBrokerOpen = {
  readonly session_id: string;
  readonly cli: TDaemonCli;
  readonly cols: number;
  readonly rows: number;
  readonly mode: "spawn" | "attach";
  readonly title?: string;
  readonly dangerous?: boolean;
  readonly vendor_args?: readonly string[];
  readonly cwd?: string;
};

export type TBrokerEnvelope =
  | { readonly t: "ctrl"; readonly p: Record<string, unknown> }
  | {
      readonly t: "reset";
      readonly p: { readonly code: string; readonly message?: string };
    }
  | { readonly t: "exit"; readonly code: number };

export type TAttachResult =
  | { readonly kind: "completed"; readonly code: number }
  | { readonly kind: "pre-ack-failed" };

export type TAttachIo = {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
};

const CTRL_DETACH = 0x1d;
const PIPE_CTRL = 0x1e;
const OPEN_ACK_TIMEOUT_MS = 5_000;

// lib.dom's constructor only models the protocol overload. Bun supports its
// documented custom-header overload; retain the narrow local declaration.
const BunWebSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

/** Parse only the control envelopes this client understands; unknown `t` is skew-safe. */
export const parseBrokerEnvelope = (text: string): TBrokerEnvelope | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, "t")
  ) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.t === "exit" && typeof envelope.code === "number") {
    return { t: "exit", code: envelope.code };
  }
  if (envelope.t === "ctrl" && isRecord(envelope.p)) {
    return { t: "ctrl", p: envelope.p };
  }
  if (
    envelope.t === "reset" &&
    isRecord(envelope.p) &&
    typeof envelope.p.code === "string"
  ) {
    return {
      t: "reset",
      p: {
        code: envelope.p.code,
        ...(typeof envelope.p.message === "string"
          ? { message: envelope.p.message }
          : {}),
      },
    };
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const brokerEnvelope = (
  t: string,
  payload: Record<string, unknown>,
): string => JSON.stringify({ t, ...payload });

/**
 * Remove Ctrl-] from terminal bytes and say whether it requested detachment.
 * A byte is atomic, so chunks split anywhere cannot hide or duplicate it.
 */
export const scanDetachBytes = (
  bytes: Uint8Array,
): {
  readonly bytes: Uint8Array;
  readonly detach: boolean;
} => {
  const detach = bytes.includes(CTRL_DETACH);
  if (!detach) return { bytes, detach: false };
  const filtered = new Uint8Array(
    bytes.filter((byte) => byte !== CTRL_DETACH).length,
  );
  let target = 0;
  for (const byte of bytes) {
    if (byte !== CTRL_DETACH) filtered[target++] = byte;
  }
  return { bytes: filtered, detach: true };
};

const terminalSize = (
  stdout: NodeJS.WriteStream,
): { readonly cols: number; readonly rows: number } => ({
  cols: stdout.columns ?? 80,
  rows: stdout.rows ?? 24,
});

const restoreTerminal = (
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): void => {
  if (stdin.isTTY) stdin.setRawMode(false);
  stdout.write("\x1b[?1049l\x1b[?25h\n");
};

const toBytes = (value: string | ArrayBuffer | Uint8Array): Uint8Array => {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
};

export type TBrokerAttachTarget = string;

/**
 * Resolve either the legacy daemon broker origin/URL or a durable session-host
 * Unix socket path. `ws+unix://` is Bun's WebSocket dial form (the host's own
 * transport test uses this exact spelling).
 */
export const brokerAttachUrl = (target: TBrokerAttachTarget): string => {
  if (target.startsWith("ws+unix://")) return target;
  if (target.startsWith("/")) return `ws+unix://${target}`;
  if (target.startsWith("ws://") || target.startsWith("wss://"))
    return target.endsWith("/broker/session")
      ? target
      : `${target.replace(/\/+$/, "")}/broker/session`;
  return `${target.replace(/^http/, "ws").replace(/\/+$/, "")}/broker/session`;
};

/** Attach the current terminal to an already-created (or newly spawned) broker session. */
export const attachBrokerSession = async (args: {
  /** Daemon broker origin/URL, or the session-host Unix socket path. */
  readonly target: TBrokerAttachTarget;
  /** Required only by the legacy daemon broker; Unix sockets are filesystem-private. */
  readonly apiKey?: string;
  readonly open: TBrokerOpen;
  readonly announce: boolean;
  /**
   * Non-tty-friendly mode for stdio piping:
   * - keeps the terminal bridge active
   * - suppresses raw-mode setup and resize controls
   * - forwards bytes unchanged
   */
  readonly pipe?: boolean;
  readonly io?: TAttachIo;
}): Promise<TAttachResult> => {
  const io = args.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const url = brokerAttachUrl(args.target);

  return new Promise<TAttachResult>((resolve) => {
    let ws: WebSocket | null = null;
    let acknowledged = false;
    let exitCode: number | null = null;
    let settled = false;
    let detached = false;
    let raw = false;
    const pipe = args.pipe === true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: TAttachResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      io.stdin.off("data", onData);
      process.off("SIGWINCH", onResize);
      process.off("SIGINT", onDetachSignal);
      process.off("SIGTERM", onDetachSignal);
      if (raw) restoreTerminal(io.stdin, io.stdout);
      resolve(result);
    };

    const close = (intent: "detach" | "kill"): void => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(brokerEnvelope("ctrl", { p: { t: "close", intent } }));
        ws.close();
      }
    };

    const onDetachSignal = (): void => {
      detached = true;
      close("detach");
      // settle() restores the terminal synchronously, so the hint below
      // lands on a sane screen instead of inside the alt-screen raw mode.
      settle({ kind: "completed", code: 0 });
      if (!pipe) {
        io.stderr.write(
          `[openllm] detached — resume with: openllm sessions attach ${args.open.session_id}\n`,
        );
      }
    };

    const onResize = (): void => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const { cols, rows } = terminalSize(io.stdout);
      ws.send(brokerEnvelope("ctrl", { p: { t: "resize", cols, rows } }));
    };

    /**
     * Pipe-mode stdin framing from a parent (the daemon):
     *   - `0x1e` + JSON line + `\n` → control envelope (resize/close)
     *   - anything else → raw PTY input
     * Interactive mode still scans for Ctrl-] detach.
     */
    let pipeCtrlBuf = "";
    const onData = (chunk: Buffer): void => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (pipe) {
        let i = 0;
        while (i < chunk.length) {
          if (pipeCtrlBuf.length > 0 || chunk[i] === 0x1e) {
            if (pipeCtrlBuf.length === 0) i += 1; // skip RS
            while (i < chunk.length) {
              const b = chunk[i] ?? 0;
              i += 1;
              if (b === 0x0a) {
                try {
                  const ctrl = JSON.parse(pipeCtrlBuf) as {
                    t?: string;
                    cols?: number;
                    rows?: number;
                    intent?: string;
                  };
                  if (
                    ctrl.t === "resize" &&
                    typeof ctrl.cols === "number" &&
                    typeof ctrl.rows === "number"
                  ) {
                    ws.send(
                      brokerEnvelope("ctrl", {
                        p: { t: "resize", cols: ctrl.cols, rows: ctrl.rows },
                      }),
                    );
                  } else if (ctrl.t === "focus") {
                    // Browser owns focus in pipe mode — forward opaquely.
                    ws.send(brokerEnvelope("ctrl", { p: { t: "focus" } }));
                  } else if (ctrl.t === "close") {
                    close(ctrl.intent === "kill" ? "kill" : "detach");
                    settle({ kind: "completed", code: 0 });
                  }
                } catch {
                  // Malformed control — drop and keep streaming.
                }
                pipeCtrlBuf = "";
                break;
              }
              pipeCtrlBuf += String.fromCharCode(b);
              if (pipeCtrlBuf.length > 512) pipeCtrlBuf = ""; // refuse runaway
            }
            continue;
          }
          // Batch contiguous non-control bytes into one send.
          const start = i;
          while (i < chunk.length && chunk[i] !== 0x1e) i += 1;
          if (i > start) ws.send(Buffer.from(chunk.subarray(start, i)));
        }
        return;
      }
      const scanned = scanDetachBytes(new Uint8Array(chunk));
      if (scanned.bytes.length > 0) ws.send(Buffer.from(scanned.bytes));
      if (scanned.detach) onDetachSignal();
    };

    const enterIo = (): void => {
      if (pipe) {
        // Parent owns the stdio pipe — no raw mode, no SIGWINCH, no announce.
        // Focus is owned by the browser bridge; do not auto-claim primary here.
        io.stdin.resume();
        io.stdin.on("data", onData);
        process.on("SIGINT", onDetachSignal);
        process.on("SIGTERM", onDetachSignal);
        return;
      }
      if (!io.stdin.isTTY) return;
      io.stdin.setRawMode(true);
      raw = true;
      io.stdin.resume();
      io.stdin.on("data", onData);
      process.on("SIGWINCH", onResize);
      process.on("SIGINT", onDetachSignal);
      process.on("SIGTERM", onDetachSignal);
      // A freshly-attached local human almost certainly wants to drive the PTY
      // size — claim primary immediately without waiting for a keystroke.
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(brokerEnvelope("ctrl", { p: { t: "focus" } }));
      }
    };

    try {
      ws = new BunWebSocket(
        url,
        args.apiKey === undefined
          ? {}
          : { headers: { Authorization: `Bearer ${args.apiKey}` } },
      );
    } catch {
      settle({ kind: "pre-ack-failed" });
      return;
    }

    timer = setTimeout(() => {
      if (!acknowledged) {
        ws?.close();
        settle({ kind: "pre-ack-failed" });
      }
    }, OPEN_ACK_TIMEOUT_MS);

    ws.binaryType = "arraybuffer";
    ws.onopen = (): void => {
      ws?.send(brokerEnvelope("open", { open: args.open }));
    };
    ws.onerror = (): void => {
      if (!acknowledged) settle({ kind: "pre-ack-failed" });
    };
    ws.onmessage = (
      event: MessageEvent<string | ArrayBuffer | Uint8Array>,
    ): void => {
      if (typeof event.data !== "string") {
        if (acknowledged) io.stdout.write(toBytes(event.data));
        return;
      }
      const envelope = parseBrokerEnvelope(event.data);
      if (envelope === null) return;
      if (envelope.t === "ctrl") {
        if (
          pipe &&
          (envelope.p.t === "open_ack" || envelope.p.t === "replay_done")
        ) {
          io.stdout.write(
            `${String.fromCharCode(PIPE_CTRL)}${JSON.stringify(envelope.p)}\n`,
          );
        }
        if (envelope.p.t !== "open_ack") return;
        if (envelope.p.ok !== true) {
          if (!acknowledged) {
            // Spawn callers fall back to a direct launch, so their nack must
            // stay silent; an explicit attach has no fallback — surface why.
            if (args.open.mode === "attach") {
              io.stderr.write(
                `[openllm] ${
                  typeof envelope.p.error === "string"
                    ? envelope.p.error
                    : "session open failed"
                }\n`,
              );
            }
            settle({ kind: "pre-ack-failed" });
          } else {
            const message =
              typeof envelope.p.error === "string"
                ? envelope.p.error
                : "session open failed";
            io.stderr.write(`[openllm] ${message}\n`);
            settle({ kind: "completed", code: 1 });
          }
          return;
        }
        acknowledged = true;
        if (timer !== undefined) clearTimeout(timer);
        if (args.announce && !pipe) {
          io.stderr.write(
            `[openllm] session ${args.open.session_id} attached — Ctrl-] to detach\n`,
          );
        }
        enterIo();
        return;
      }
      if (envelope.t === "exit") {
        exitCode = envelope.code;
        return;
      }
      if (envelope.t === "reset") {
        if (pipe) {
          io.stdout.write(
            `${String.fromCharCode(PIPE_CTRL)}${JSON.stringify({ t: "reset", ...envelope.p })}\n`,
          );
        }
        if (!acknowledged) {
          settle({ kind: "pre-ack-failed" });
          return;
        }
        const message = envelope.p.message ?? envelope.p.code;
        io.stderr.write(`[openllm] ${message}\n`);
        settle({ kind: "completed", code: 1 });
      }
    };
    ws.onclose = (): void => {
      if (!acknowledged) {
        settle({ kind: "pre-ack-failed" });
        return;
      }
      if (detached) return;
      settle({ kind: "completed", code: exitCode ?? 0 });
    };
  });
};
