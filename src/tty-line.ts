/**
 * Read one visible line from the person at the terminal, without blocking
 * the event loop (polling and Ctrl-C keep working while it waits).
 *
 * Uses stdin when it is a TTY; otherwise opens `/dev/tty` — `install.sh`
 * runs `openllm login < /dev/tty`, but a piped caller still has a terminal.
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
    let owned = false;
    if (process.stdin.isTTY === true) {
      stream = process.stdin;
    } else {
      try {
        stream = new ReadStream(openSync("/dev/tty", "r"));
        owned = true;
      } catch {
        resolve(null);
        return;
      }
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
      if (owned) stream.destroy();
      else stream.pause();
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
