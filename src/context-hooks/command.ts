import { CONTEXT_HOOK_VERBS } from "../commands";
import { readHookEvent } from "../hook-helpers";
import { runContextHook, runIndexWorker } from "./runtime";

export const runContextCommand = async (args: string[]): Promise<void> => {
  const verb = args[0];
  if (!CONTEXT_HOOK_VERBS.some((candidate) => candidate === verb)) {
    const { runClaudeContextCli } = await import("../mcp/claude-context");
    await runClaudeContextCli(args);
    return;
  }
  if (args.length !== 1) {
    process.stderr.write(
      `usage: openllm exec ctx <${CONTEXT_HOOK_VERBS.join("|")}> (event on stdin)\n`,
    );
    process.exitCode = 2;
    return;
  }
  const input = await readHookEvent();
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return;
  try {
    if (verb === "index-worker") await runIndexWorker(input);
    else {
      const output = await runContextHook(verb, input);
      if (output !== null) process.stdout.write(`${output}\n`);
    }
  } catch {
    process.stderr.write("[openllm] context hook could not complete\n");
  }
};
