/**
 * Production {@link TAgentEngineSpawn}: `Bun.spawn` with piped stdio, stdout
 * split into NDJSON lines. Bounded per line so a runaway engine line is a
 * kill, never a growing buffer.
 */
import { createAgentLineSplitter } from "@openllmsh/protocol";
import { logError } from "../logger";
import type {
  TAgentEngineProcess,
  TAgentEngineSpawn,
  TAgentEngineSpawnOptions,
} from "./types";

/** One engine stdout line may carry a whole tool result; bound it generously. */
export const AGENT_ENGINE_MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Kept stderr tail, for a readable failure message when the engine exits. */
const STDERR_TAIL_CHARS = 4096;

export const spawnAgentEngineProcess: TAgentEngineSpawn = (
  options: TAgentEngineSpawnOptions,
): TAgentEngineProcess => {
  const child = Bun.spawn([...options.argv], {
    cwd: options.cwd,
    env: { ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lineHandlers: ((line: string) => void)[] = [];
  const stderrHandlers: ((text: string) => void)[] = [];
  const exitHandlers: ((code: number | null, signal: string | null) => void)[] =
    [];
  let inputOpen = true;
  const encoder = new TextEncoder();

  const pumpStdout = async (): Promise<void> => {
    const splitter = createAgentLineSplitter(AGENT_ENGINE_MAX_LINE_BYTES);
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      const lines = splitter.push(chunk);
      if (lines === null) {
        logError("agent", "engine stdout line exceeded the bound");
        child.kill("SIGTERM");
        return;
      }
      for (const line of lines) {
        const text = decoder.decode(line).trim();
        if (text.length === 0) continue;
        for (const handler of lineHandlers) handler(text);
      }
    }
  };
  const pumpStderr = async (): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      const text = decoder.decode(chunk, { stream: true });
      for (const handler of stderrHandlers) handler(text);
    }
  };
  const stdoutDone = pumpStdout().catch((err: unknown) => {
    logError("agent", err);
  });
  void pumpStderr().catch(() => {});
  void Promise.all([child.exited, stdoutDone]).then(([code]) => {
    inputOpen = false;
    const signal = child.signalCode ?? null;
    for (const handler of exitHandlers)
      handler(signal === null ? code : null, signal);
  });

  return {
    writeLine: (line) => {
      if (!inputOpen) return false;
      try {
        child.stdin.write(encoder.encode(`${line}\n`));
        void child.stdin.flush();
        return true;
      } catch {
        inputOpen = false;
        return false;
      }
    },
    endInput: () => {
      if (!inputOpen) return;
      inputOpen = false;
      try {
        void child.stdin.end();
      } catch {
        // already closed
      }
    },
    kill: (signal = "SIGTERM") => {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    },
    onLine: (handler) => {
      lineHandlers.push(handler);
    },
    onStderr: (handler) => {
      stderrHandlers.push(handler);
    },
    onExit: (handler) => {
      exitHandlers.push(handler);
    },
  };
};

/** Keep the last {@link STDERR_TAIL_CHARS} characters of a stderr stream. */
export const createStderrTail = (): {
  readonly push: (text: string) => void;
  readonly text: () => string;
} => {
  let tail = "";
  return {
    push: (text) => {
      tail = (tail + text).slice(-STDERR_TAIL_CHARS);
    },
    text: () => tail.trim(),
  };
};
