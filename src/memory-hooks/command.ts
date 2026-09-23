import { EXEC_VERBS } from "../commands";
import {
  hookWorkerInvocation,
  readHookEvent,
  startHookWorker,
} from "../hook-helpers";
import { runMemoryExtraction, runMemoryRecall } from "./runtime";

export const MEMORY_HOOK_USAGE = `usage: openllm exec memory <${EXEC_VERBS.memory.join("|")}>

Read a client hook event from stdin. Recall emits hook context; extract starts
an independent worker and returns immediately. extract-worker is internal.
No external Python, Node or Bun installation is required by the compiled CLI.
`;

export const memoryWorkerInvocation = (
  executable: string,
  entry: string | undefined,
): readonly string[] =>
  hookWorkerInvocation(executable, entry, "memory", "extract-worker");

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

  const input = await readHookEvent();
  if (input === null) return 0;
  try {
    if (verb === "recall") {
      const output = await runMemoryRecall(input);
      if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
    } else if (verb === "extract-worker") {
      await runMemoryExtraction(input);
    } else if (
      !(await startHookWorker(
        input,
        memoryWorkerInvocation(process.execPath, process.argv[1]),
      ))
    ) {
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
