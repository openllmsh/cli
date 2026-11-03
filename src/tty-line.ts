/**
 * Read one visible line from the person at the terminal, without blocking
 * the event loop (polling and Ctrl-C keep working while it waits).
 *
 * Always reads its own `tty.ReadStream` on `/dev/tty`, never
 * `process.stdin`: when stdin IS the `/dev/tty` alias — `install.sh` runs
 * `openllm login < /dev/tty` — Bun's stdin stream fails on macOS with
 * `EINVAL … kqueue` (kqueue can't watch `/dev/tty`), which read as EOF and
 * left "Press Enter to open the browser" dead. A `tty.ReadStream` on the same
 * path reads fine, from a terminal stdin and a redirected one alike.
 */

import { closeSync, openSync } from "node:fs";
import { ReadStream } from "node:tty";

/** True when a line can be read from a terminal at all. */
export const ttyAvailable = (): boolean => {
  if (process.stdin.isTTY === true) return true;
  try {
    closeSync(openSync("/dev/tty", "r"));
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve with the next line (without its newline), or null on EOF, on
 * `signal` abort, or when no terminal can be opened.
 */
export const readTtyLine = (signal?: AbortSignal): Promise<string | null> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(null);
      return;
    }
    let stream: NodeJS.ReadStream;
    try {
      stream = new ReadStream(openSync("/dev/tty", "r"));
    } catch {
      resolve(null);
      return;
    }
    let buffered = "";
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onEnd);
      signal?.removeEventListener("abort", onAbort);
      stream.destroy();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const end = buffered.search(/[\r\n]/);
      if (end >= 0) finish(buffered.slice(0, end));
    };
    const onEnd = (): void => finish(null);
    const onAbort = (): void => finish(null);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.resume();
  });
