/**
 * `openllm config --json` — the resolved configuration, for tools that must
 * agree with the CLI instead of re-deriving it (the desktop app reads its
 * origin here). One JSON object on stdout; the key itself is never printed.
 */

import { daemonPort } from "./clients/gateway";
import { cliConfig, cliEnvFile } from "./env";
import { isOpenllmDevMode } from "./runtime-contracts";

export const CONFIG_USAGE = `usage: openllm config --json

Print the resolved configuration as JSON: the cloud origin, the env file,
the daemon port, whether an API key is configured and whether this is a dev
run (OPENLLM_DAEMON_DEV=1). The key itself is never printed.
`;

export type TResolvedConfig = {
  readonly origin: string;
  readonly envFile: string;
  readonly daemonPort: number;
  readonly keyConfigured: boolean;
  readonly dev: boolean;
};

export const resolvedConfig = (): TResolvedConfig => {
  const { gatewayUrl, apiKey } = cliConfig();
  return {
    origin: gatewayUrl,
    envFile: cliEnvFile(),
    daemonPort: daemonPort(),
    keyConfigured: apiKey.length > 0,
    dev: isOpenllmDevMode(),
  };
};

export const runConfig = (
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): number => {
  if (args.length !== 1 || args[0] !== "--json") {
    process.stderr.write(CONFIG_USAGE);
    return 2;
  }
  write(`${JSON.stringify(resolvedConfig())}\n`);
  return 0;
};
