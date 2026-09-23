import { spawn } from "node:child_process";
import { EXEC_VERBS } from "../commands";
import { runMemoryExtraction, runMemoryRecall } from "./runtime";

const MAX_EVENT_BYTES = 256 * 1024;
const WORKER_START_TIMEOUT_MS = 1_500;

export const MEMORY_HOOK_USAGE = `usage: openllm exec memory <${EXEC_VERBS.memory.join("|")}>

Read a client hook event from stdin. Recall emits hook context; extract starts
an independent worker and returns immediately. extract-worker is internal.
No external Python, Node or Bun installation is required by the compiled CLI.
`;

/** Bun's compiled entry is virtual; source runs must re-exec their real entry. */
export const memoryWorkerInvocation = (
  executable: string,
  entry: string | undefined,
): readonly string[] => [
  executable,
  ...(entry === undefined || entry.startsWith("/$bunfs/") ? [] : [entry]),
  "exec",
  "memory",
  "extract-worker",
];

/** Bound untrusted hook input; never spill a conversation or key into argv. */
const readEvent = async (): Promise<unknown> => {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_EVENT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
};

/** Only pipe delivery is awaited; the worker never inherits the hook's stdio. */
const startWorker = (input: unknown): Promise<boolean> =>
  new Promise((resolve) => {
    const invocation = memoryWorkerInvocation(
      process.execPath,
      process.argv[1],
    );
    const child = spawn(invocation[0], invocation.slice(1), {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env,
    });
    let finished = false;
    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!ok) child.kill();
      child.unref();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WORKER_START_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.stdin.once("error", () => finish(false));
    child.once("spawn", () => {
      child.stdin.end(JSON.stringify(input), () => finish(true));
    });
  });

/** Hook failures are advisory and never block the user's primary task. */
export const runMemoryHookCommand = async (
  args: readonly string[],
): Promise<number> => {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(MEMORY_HOOK_USAGE);
    return 0;
  }
  const verb = args[0];
  if (args.length !== 1 || !EXEC_VERBS.memory.includes(verb)) {
    process.stderr.write(MEMORY_HOOK_USAGE);
    return 2;
  }
  const toggle =
    verb === "recall" ? "SUPERMEMORY_AUTO_RECALL" : "SUPERMEMORY_AUTO_SAVE";
  if ((process.env[toggle] ?? "1") !== "1") return 0;

  // Compatibility for old standalone hooks. The CLI remains the only parser;
  // canonical overrides (even invalid ones) keep their normal precedence.
  if (
    process.env.OPENLLM_DAEMON_ENV_FILE === undefined &&
    process.env.OPENLLM_ENV_FILE !== undefined
  ) {
    process.env.OPENLLM_DAEMON_ENV_FILE = process.env.OPENLLM_ENV_FILE;
  }

  const input = await readEvent();
  if (input === null) return 0;
  try {
    if (verb === "recall") {
      const output = await runMemoryRecall(input);
      if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
    } else if (verb === "extract-worker") {
      await runMemoryExtraction(input);
    } else if (!(await startWorker(input))) {
      process.stdout.write(
        `${JSON.stringify({ systemMessage: "OpenLLM memory: automatic saving could not start. Work can continue; check the OpenLLM CLI installation." })}\n`,
      );
    }
  } catch {
    // Never interpolate an exception: upstream errors may contain secrets.
    process.stderr.write("[openllm] memory hook could not complete\n");
  }
  return 0;
};
