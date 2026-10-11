/**
 * Durable, per-session PTY host.
 *
 * This is deliberately independent of the daemon control plane: one invocation
 * owns one PTY and serves its attached terminal consumers on a private Unix
 * WebSocket. The wire envelope is the local broker envelope.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  TDeviceSessionCli,
  TSessionStreamOpenPayload,
} from "@openllmsh/protocol";
import {
  DeviceSessionCli,
  SESSION_ID_PATTERN,
  TerminalDimension,
} from "@openllmsh/protocol";
import { decodeJsonPayload, encodeJsonPayload } from "@openllmsh/tunnel/codec";
import { Schema as S } from "effect";
import { stateDir } from "../env";
import type { TSessionStream } from "../session-core";
import {
  bindSessionStream,
  closeSession,
  openSession,
  pollSessionActivity,
  RESUME_ID_PATTERN,
  setSessionLifecycleHooks,
} from "../session-core";

const SESSION_DIR_MODE = 0o700;
const ACTIVITY_POLL_MS = 15_000;

const processStartTime = (): string | null => {
  try {
    const output = Bun.spawnSync(
      ["ps", "-o", "lstart=", "-p", String(process.pid)],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (output.exitCode !== 0) return null;
    const value = new TextDecoder().decode(output.stdout).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

export type TSessionHostArgs = {
  readonly id: string;
  readonly cli: TDeviceSessionCli;
  readonly cols?: number;
  readonly rows?: number;
  readonly cwd?: string;
  readonly title?: string;
  readonly dangerous: boolean;
  readonly resumeSessionId?: string;
  readonly vendorArgs: readonly string[];
};

export type TSessionHostMeta = {
  readonly id: string;
  readonly cli: TDeviceSessionCli;
  readonly cwd: string;
  readonly pid: number;
  readonly vendorSessionId: string | null;
  readonly title: string | null;
  readonly startedAtMs: number;
  readonly processStartTime: string;
  readonly generation: number;
};

type TSocketData = {
  stream: SessionHostStream | null;
  opened: boolean;
  drainWaiters: Set<{ resolve: () => void; reject: (error: Error) => void }>;
};

type TSocket = Bun.ServerWebSocket<TSocketData>;

type TEnvelope = {
  readonly t?: unknown;
  readonly open?: unknown;
  readonly p?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Empty / unparseable RESET → `peer_gone` (channel teardown), not protocol_error. */
export const sessionHostResetPayload = (
  payload?: Uint8Array,
): Record<string, unknown> => {
  if (payload === undefined || payload.byteLength === 0) {
    return { code: "peer_gone" };
  }
  const decoded = decodeJsonPayload(payload);
  return isRecord(decoded) ? decoded : { code: "peer_gone" };
};

const isCli: (value: unknown) => value is TDeviceSessionCli =
  S.is(DeviceSessionCli);

const parseDimension = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  if (value !== `${parsed}`) return null;
  return S.is(TerminalDimension)(parsed) ? parsed : null;
};

const isDimension = (value: unknown): value is number =>
  S.is(TerminalDimension)(value);

const validVendorArg = (value: string): boolean =>
  value.length >= 1 && value.length <= 512 && !value.includes("\0");

/** Parse hidden-process arguments without accepting option-like injection. */
export const parseSessionHostArgs = (
  argv: readonly string[],
): TSessionHostArgs | null => {
  let id: string | undefined;
  let cli: TDeviceSessionCli | undefined;
  let cols: number | undefined;
  let rows: number | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let dangerous = false;
  let resumeSessionId: string | undefined;
  const vendorArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    switch (option) {
      case "--id":
        if (id !== undefined || value === undefined) return null;
        id = value;
        index += 1;
        break;
      case "--cli":
        if (cli !== undefined || value === undefined || !isCli(value))
          return null;
        cli = value;
        index += 1;
        break;
      case "--cols": {
        if (cols !== undefined) return null;
        const parsedCols = parseDimension(value);
        if (parsedCols === null) return null;
        cols = parsedCols;
        index += 1;
        break;
      }
      case "--rows": {
        if (rows !== undefined) return null;
        const parsedRows = parseDimension(value);
        if (parsedRows === null) return null;
        rows = parsedRows;
        index += 1;
        break;
      }
      case "--cwd":
        if (
          cwd !== undefined ||
          value === undefined ||
          value.length < 1 ||
          value.length > 1024 ||
          value.includes("\0") ||
          !value.startsWith("/")
        )
          return null;
        cwd = value;
        index += 1;
        break;
      case "--title":
        if (
          title !== undefined ||
          value === undefined ||
          value.length > 80 ||
          value.includes("\0")
        )
          return null;
        title = value;
        index += 1;
        break;
      case "--dangerous":
        if (dangerous) return null;
        dangerous = true;
        break;
      case "--resume":
        if (
          resumeSessionId !== undefined ||
          value === undefined ||
          !RESUME_ID_PATTERN.test(value)
        )
          return null;
        resumeSessionId = value;
        index += 1;
        break;
      case "--vendor-arg":
        if (
          value === undefined ||
          vendorArgs.length >= 64 ||
          !validVendorArg(value)
        )
          return null;
        vendorArgs.push(value);
        index += 1;
        break;
      default:
        return null;
    }
  }
  if (id === undefined || !SESSION_ID_PATTERN.test(id) || cli === undefined)
    return null;
  return {
    id,
    cli,
    ...(cols === undefined ? {} : { cols }),
    ...(rows === undefined ? {} : { rows }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(title === undefined ? {} : { title }),
    dangerous,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    vendorArgs,
  };
};

export const sessionHostDir = (id: string): string =>
  join(stateDir(), "sessions", id);
export const sessionHostSocketPath = (id: string): string =>
  join(sessionHostDir(id), "ctl.sock");

class SessionHostStream implements TSessionStream {
  private readonly dataHandlers = new Set<(payload: Uint8Array) => unknown>();
  private readonly ctrlHandlers = new Set<(payload: Uint8Array) => unknown>();
  private readonly resetHandlers = new Set<(payload: Uint8Array) => unknown>();
  private readonly endHandlers = new Set<() => void>();
  private resetSent = false;

  constructor(private readonly socket: TSocket) {}

  write = (bytes: Uint8Array): Promise<void> => {
    const status = this.socket.sendBinary(bytes);
    if (status > 0) return Promise.resolve();
    if (status === 0)
      return Promise.reject(new Error("session host socket send failed"));
    return new Promise<void>((resolve, reject) => {
      this.socket.data.drainWaiters.add({ resolve, reject });
    });
  };

  sendCtrl = (payload: Uint8Array): void => {
    const decoded = decodeJsonPayload(payload);
    if (decoded !== undefined)
      this.socket.sendText(JSON.stringify({ t: "ctrl", p: decoded }));
  };

  reset = (payload?: Uint8Array): void => {
    if (this.resetSent) return;
    this.resetSent = true;
    this.socket.sendText(
      JSON.stringify({
        t: "reset",
        p: sessionHostResetPayload(payload),
      }),
    );
    this.socket.close();
  };

  end = (): void => this.socket.close();
  onData = (handler: (payload: Uint8Array) => unknown): (() => void) => {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  };
  onCtrl = (handler: (payload: Uint8Array) => unknown): (() => void) => {
    this.ctrlHandlers.add(handler);
    return () => this.ctrlHandlers.delete(handler);
  };
  onReset = (handler: (payload: Uint8Array) => unknown): (() => void) => {
    this.resetHandlers.add(handler);
    return () => this.resetHandlers.delete(handler);
  };
  onEnd = (handler: () => void): (() => void) => {
    this.endHandlers.add(handler);
    return () => this.endHandlers.delete(handler);
  };
  receiveData = (payload: Uint8Array): void => {
    for (const handler of this.dataHandlers) handler(payload);
  };
  receiveCtrl = (payload: unknown): void => {
    for (const handler of this.ctrlHandlers)
      handler(encodeJsonPayload(payload));
  };
  closed = (): void => {
    if (this.resetSent) {
      for (const handler of this.resetHandlers) handler(new Uint8Array());
      return;
    }
    for (const handler of this.endHandlers) handler();
  };
}

const protocolError = (socket: TSocket): void => {
  const stream = socket.data.stream ?? new SessionHostStream(socket);
  socket.data.stream = stream;
  stream.reset(encodeJsonPayload({ code: "protocol_error" }));
};

const parseAttachOpen = (
  value: unknown,
  expected: TSessionHostArgs,
): TSessionStreamOpenPayload | null => {
  if (!isRecord(value)) return null;
  if (
    value.session_id !== expected.id ||
    value.cli !== expected.cli ||
    !isDimension(value.cols) ||
    !isDimension(value.rows) ||
    value.mode !== "attach"
  )
    return null;
  return {
    kind: "session",
    session_id: expected.id,
    cli: expected.cli,
    cols: value.cols,
    rows: value.rows,
    mode: "attach",
  };
};

export type TSessionHostOptions = {
  /** Test seam: production exits after cleanup, tests retain the process. */
  readonly exit?: (code: number) => void;
};

/** Start one durable session host. Kept exportable so tests can use its fake PTY seam. */
export const runSessionHost = (
  args: TSessionHostArgs,
  options: TSessionHostOptions = {},
): void => {
  const directory = sessionHostDir(args.id);
  const root = join(stateDir(), "sessions");
  const claim = join(root, `.${args.id}.claim`);
  const stagingDirectory = join(root, `.${args.id}.${process.pid}.staging`);
  const socketPath = join(stagingDirectory, "ctl.sock");

  let server: Bun.Server<TSocketData> | null = null;
  let activityTimer: ReturnType<typeof setInterval> | null = null;
  let ownerTimer: ReturnType<typeof setInterval> | null = null;
  let cleaned = false;
  let ownsClaim = false;
  let meta: TSessionHostMeta | null = null;
  let published = false;

  const fail = (): void => {
    cleanup();
    if (options.exit === undefined) process.exitCode = 1;
    else options.exit(1);
  };

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (activityTimer !== null) clearInterval(activityTimer);
    if (ownerTimer !== null) clearInterval(ownerTimer);
    server?.stop(true);
    if (published) rmSync(directory, { recursive: true, force: true });
    rmSync(stagingDirectory, { recursive: true, force: true });
    if (ownsClaim) rmSync(claim, { recursive: true, force: true });
  };
  const exit = (): void => {
    cleanup();
    (options.exit ?? process.exit)(0);
  };

  const publish = (): void => {
    if (published) return;
    try {
      renameSync(stagingDirectory, directory);
      published = true;
    } catch (error) {
      cleanup();
      throw error;
    }
    rmSync(claim, { recursive: true, force: true });
    ownsClaim = false;
  };

  const writeMeta = (): void => {
    if (meta === null) return;
    const temp = join(stagingDirectory, `.meta.json.${process.pid}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      renameSync(temp, join(stagingDirectory, "meta.json"));
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // Best-effort temp cleanup.
      }
      throw error;
    }
  };

  try {
    mkdirSync(root, { recursive: true, mode: SESSION_DIR_MODE });
    mkdirSync(claim, { mode: SESSION_DIR_MODE });
    ownsClaim = true;
  } catch {
    fail();
    return;
  }

  if (existsSync(directory)) {
    fail();
    return;
  }

  try {
    rmSync(stagingDirectory, { recursive: true, force: true });
    mkdirSync(stagingDirectory, { mode: SESSION_DIR_MODE });
    chmodSync(stagingDirectory, SESSION_DIR_MODE);
  } catch {
    fail();
    return;
  }
  const ownProcessStartTime = processStartTime();
  if (ownProcessStartTime === null) {
    fail();
    return;
  }

  setSessionLifecycleHooks({
    onSpawn: (session) => {
      meta = {
        id: args.id,
        cli: args.cli,
        cwd: session.cwd,
        pid: process.pid,
        vendorSessionId: session.vendorSessionId,
        title: session.title,
        startedAtMs: session.startedAtMs,
        processStartTime: ownProcessStartTime,
        generation: session.generation,
      };
      writeMeta();
    },
    onEnd: () => exit(),
  });

  let spawnFailed = false;
  openSession(
    {
      session_id: args.id,
      cli: args.cli,
      cols: args.cols ?? 80,
      rows: args.rows ?? 24,
      mode: "spawn",
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.dangerous ? { dangerous: true } : {}),
      ...(args.resumeSessionId === undefined
        ? {}
        : { resume_session_id: args.resumeSessionId }),
    },
    {
      vendorArgs: args.vendorArgs,
      onAck: (ack) => {
        if (!ack.ok) spawnFailed = true;
      },
    },
  );
  if (spawnFailed || meta === null) {
    fail();
    return;
  }

  try {
    server = Bun.serve({
      unix: socketPath,
      fetch: (request, current): Response | undefined => {
        if (request.method !== "GET")
          return new Response("not found", { status: 404 });
        return current.upgrade(request, {
          data: { stream: null, opened: false, drainWaiters: new Set() },
        })
          ? undefined
          : new Response("websocket upgrade failed", { status: 400 });
      },
      websocket: {
        open: (socket): void => {
          socket.binaryType = "uint8array";
        },
        drain: (socket): void => {
          const waiters = [...socket.data.drainWaiters];
          socket.data.drainWaiters.clear();
          for (const waiter of waiters) waiter.resolve();
        },
        message: (socket, message): void => {
          try {
            const stream = socket.data.stream;
            if (typeof message !== "string") {
              if (!socket.data.opened || stream === null) {
                protocolError(socket);
                return;
              }
              stream.receiveData(new Uint8Array(message));
              return;
            }
            const envelope: TEnvelope = JSON.parse(message) as TEnvelope;
            if (!socket.data.opened) {
              if (envelope.t !== "open") {
                protocolError(socket);
                return;
              }
              const open = parseAttachOpen(envelope.open, args);
              if (open === null) {
                protocolError(socket);
                return;
              }
              const next = new SessionHostStream(socket);
              socket.data.stream = next;
              socket.data.opened = true;
              bindSessionStream(next, open, {
                onExit: (code) =>
                  socket.sendText(JSON.stringify({ t: "exit", code })),
              });
              return;
            }
            if (envelope.t === "ctrl" && stream !== null)
              stream.receiveCtrl(envelope.p);
          } catch {
            protocolError(socket);
          }
        },
        close: (socket): void => {
          const waiters = [...socket.data.drainWaiters];
          socket.data.drainWaiters.clear();
          for (const waiter of waiters)
            waiter.reject(new Error("session host socket closed"));
          socket.data.stream?.closed();
        },
      },
    });
    publish();
  } catch {
    fail();
    return;
  }

  activityTimer = setInterval(
    () => void pollSessionActivity(),
    ACTIVITY_POLL_MS,
  );
  activityTimer.unref?.();
  const shutdown = (): void => {
    closeSession(args.id);
    exit();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // The trace harness marks only its source-client children. A host launched
  // from that client may be detached, so it must reap itself when that exact
  // owner exits rather than relying on broad session-directory cleanup.
  const ownerPid = Number.parseInt(
    process.env.OPENLLM_SESSION_HOST_OWNER_PID ?? "",
    10,
  );
  if (Number.isSafeInteger(ownerPid) && ownerPid > 1) {
    ownerTimer = setInterval((): void => {
      try {
        process.kill(ownerPid, 0);
      } catch {
        shutdown();
      }
    }, 100);
    ownerTimer.unref?.();
  }
};

/** Entry for the hidden `openllmd __session-host` subcommand. */
export const runSessionHostProcess = (argv: readonly string[]): boolean => {
  const args = parseSessionHostArgs(argv);
  if (args === null) {
    process.stderr.write(
      "usage: openllmd __session-host --id <id> --cli <cli> [--cols <n> --rows <n> --cwd <dir> --title <title> --dangerous --resume <vendorId> --vendor-arg <arg>]\n",
    );
    process.exitCode = 2;
    // `runCli` false means "boot the daemon". This internal command was
    // handled even when malformed, so it must never fall through to that path.
    return true;
  }
  runSessionHost(args);
  return true;
};
