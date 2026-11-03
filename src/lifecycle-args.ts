/**
 * `openllm start | restart | stop` arguments. `start` and `restart` need a
 * credential first, and get it through the ONE shared gate
 * (`requireCliApiKey`): browser sign-in by default, the hidden paste prompt
 * with `--api-key` — the same flag `openllm login` takes. The daemon's own
 * gate never prompts (`daemon/src/credential-gate.ts`).
 */

export type TLifecycleCommand = "start" | "restart" | "stop";

export type TLifecycleArgs = {
  /** Run the credential gate before handing the command to the daemon. */
  readonly needsCredential: boolean;
  /** Paste a key instead of signing in in the browser. */
  readonly apiKeyEntry: boolean;
};

/** Null on anything but `--api-key` (and that only where a key is asked). */
export const parseLifecycleArgs = (
  command: TLifecycleCommand,
  args: readonly string[],
): TLifecycleArgs | null => {
  const needsCredential = command !== "stop";
  if (args.length === 0) return { needsCredential, apiKeyEntry: false };
  if (needsCredential && args.length === 1 && args[0] === "--api-key")
    return { needsCredential, apiKeyEntry: true };
  return null;
};

export const lifecycleUsage = (command: TLifecycleCommand): string =>
  command === "stop"
    ? `usage: openllm stop

Stop the managed OpenLLM daemon.
`
    : `usage: openllm ${command} [--api-key]

${command === "start" ? "Start" : "Restart"} the managed OpenLLM daemon. Without a saved API key, signs this
computer in through the browser first.

  --api-key   paste an API key instead of signing in in the browser
`;
