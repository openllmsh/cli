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

/** Attach the current terminal to an already-created (or newly spawned) broker session. */
export const attachBrokerSession = async (args: {
  readonly origin: string;
  readonly apiKey: string;
  readonly open: TBrokerOpen;
  readonly announce: boolean;
  readonly io?: TAttachIo;
}): Promise<TAttachResult> => {
  const io = args.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const url = `${args.origin.replace(/^http/, "ws")}/broker/session`;

  return new Promise<TAttachResult>((resolve) => {
    let ws: WebSocket | null = null;
    let acknowledged = false;
    let exitCode: number | null = null;
    let settled = false;
    let detached = false;
    let raw = false;
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
      io.stderr.write(
        `[openllm] detached — resume with: openllm sessions attach ${args.open.session_id}\n`,
      );
    };

    const onResize = (): void => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const { cols, rows } = terminalSize(io.stdout);
      ws.send(brokerEnvelope("ctrl", { p: { t: "resize", cols, rows } }));
    };

    const onData = (chunk: Buffer): void => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const scanned = scanDetachBytes(new Uint8Array(chunk));
      if (scanned.bytes.length > 0) ws.send(Buffer.from(scanned.bytes));
      if (scanned.detach) onDetachSignal();
    };

    const enterRawMode = (): void => {
      if (!io.stdin.isTTY) return;
      io.stdin.setRawMode(true);
      raw = true;
      io.stdin.resume();
      io.stdin.on("data", onData);
      process.on("SIGWINCH", onResize);
      process.on("SIGINT", onDetachSignal);
      process.on("SIGTERM", onDetachSignal);
    };

    try {
      ws = new BunWebSocket(url, {
        headers: { Authorization: `Bearer ${args.apiKey}` },
      });
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
      if (envelope.t === "ctrl" && envelope.p.t === "open_ack") {
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
        if (args.announce) {
          io.stderr.write(
            `[openllm] session ${args.open.session_id} on local daemon — Ctrl-] to detach\n`,
          );
        }
        enterRawMode();
        return;
      }
      if (envelope.t === "exit") {
        exitCode = envelope.code;
        return;
      }
      if (envelope.t === "reset") {
        if (!acknowledged) {
          settle({ kind: "pre-ack-failed" });
          return;
        }
        if (envelope.p.code === "superseded") {
          io.stderr.write("[openllm] attached elsewhere\n");
          settle({ kind: "completed", code: 0 });
          return;
        }
        io.stderr.write(`[openllm] ${envelope.p.message ?? envelope.p.code}\n`);
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
