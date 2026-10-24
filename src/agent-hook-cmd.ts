/**
 * `openllm exec agent hook <event>` — Claude hook bridge for agent sessions.
 *
 * Installed in the claude overlay for every session; a no-op (silent exit 0)
 * unless the process runs under a durable session host
 * (`OPENLLM_DEVICE_SESSION_ID`). Forwards the hook's stdin JSON to the daemon
 * loopback (`/local/agent-hook`, local control capability) and prints the
 * daemon's reply as the hook output.
 *
 * Fails closed to NATIVE behaviour: any error, timeout or empty reply prints
 * nothing, so Claude shows its own permission dialog. It never allows on its
 * own.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { daemonPort } from "./clients/gateway";
import { DEVICE_SESSION_ID_ENV } from "./clients/live";
import { daemonStateDir } from "./env";
import { DOCTOR_REPORT_CLI_CONSTANTS } from "./generated/doctor-report-cli";

// The CLI command code never imports the protocol package; these mirror
// `AGENT_HOOK_LOCAL_PATH` / `AGENT_HOOK_EVENTS` (parity-tested).
export const AGENT_HOOK_PATH = "/local/agent-hook";
export const AGENT_HOOK_EVENT_NAMES = ["PermissionRequest", "Stop"] as const;

/** Upper bound on one hook round trip (under the hook's own `timeout`). */
export const AGENT_HOOK_FETCH_TIMEOUT_MS = 110_000;

const readCapability = (): string | null => {
  const path = join(
    daemonStateDir(),
    DOCTOR_REPORT_CLI_CONSTANTS.capabilityFilename,
  );
  if (!existsSync(path)) return null;
  try {
    if ((statSync(path).mode & 0o077) !== 0) return null;
    const token = readFileSync(path, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
};

const readStdin = async (): Promise<string> => {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
};

export type TAgentHookDeps = {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly capability?: () => string | null;
  readonly port?: () => number;
  readonly write?: (text: string) => void;
};

export const runAgentHookCommand = async (
  args: readonly string[],
  deps: TAgentHookDeps = {},
): Promise<number> => {
  const env = deps.env ?? process.env;
  const sessionId = env[DEVICE_SESSION_ID_ENV]?.trim();
  const event = args[0];
  if (
    sessionId === undefined ||
    sessionId.length === 0 ||
    event === undefined ||
    !(AGENT_HOOK_EVENT_NAMES as readonly string[]).includes(event)
  )
    return 0;
  const token = (deps.capability ?? readCapability)();
  if (token === null) return 0;
  let payload: unknown;
  try {
    payload = JSON.parse(await (deps.stdin ?? readStdin)());
  } catch {
    return 0;
  }
  try {
    const res = await (deps.fetch ?? fetch)(
      `http://127.0.0.1:${(deps.port ?? daemonPort)()}${AGENT_HOOK_PATH}`,
      {
        method: "POST",
        headers: {
          Host: "127.0.0.1",
          "content-type": "application/json",
          [DOCTOR_REPORT_CLI_CONSTANTS.capabilityHeader]: token,
        },
        body: JSON.stringify({ session_id: sessionId, event, payload }),
        signal: AbortSignal.timeout(AGENT_HOOK_FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) return 0;
    const body = (await res.json()) as { output?: unknown };
    if (body.output !== undefined && body.output !== null)
      (deps.write ?? ((text) => process.stdout.write(text)))(
        JSON.stringify(body.output),
      );
  } catch {
    // Native dialog / behaviour.
  }
  return 0;
};
