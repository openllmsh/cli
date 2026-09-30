/** JSON command adapter for stdio MCP. No daemon implementation or provider catalogue imports. */
import { findDaemonBinary } from "./daemon-delegation";
import type { TLocalAuthRequest } from "./generated/local-auth";
import {
  AUTH_LOCAL_VERSION,
  parseLocalAuthRequest,
} from "./generated/local-auth";

export type TAuthCommandResult = {
  readonly ok: boolean;
  readonly body: Record<string, unknown>;
};
export const authCommandArgs = (
  request: TLocalAuthRequest,
): readonly string[] => [
  "auth",
  request.operation,
  ...(request.provider !== undefined ? [request.provider] : []),
  ...(request.method !== undefined ? ["--method", request.method] : []),
  ...(request.flow_id !== undefined ? ["--flow-id", request.flow_id] : []),
  "--json",
];

export const runAuthCommand = async (
  input: unknown,
): Promise<TAuthCommandResult> => {
  let request: TLocalAuthRequest;
  try {
    request = parseLocalAuthRequest(input);
  } catch {
    return { ok: false, body: { error: "invalid_auth_request" } };
  }
  const binary = findDaemonBinary();
  if (binary === null)
    return {
      ok: false,
      body: {
        error: "daemon_missing",
        message: "Install OpenLLM, then run openllm start on this machine.",
      },
    };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([binary, ...authCommandArgs(request)], {
      stdin: request.code === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
    if (
      request.code !== undefined &&
      child.stdin !== undefined &&
      child.stdin !== null &&
      typeof child.stdin !== "number"
    ) {
      child.stdin.write(request.code);
      child.stdin.end();
    }
    const stdout = child.stdout;
    if (stdout === undefined || typeof stdout === "number")
      throw new Error("missing output");
    const read = async (): Promise<unknown> => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of stdout) {
        length += chunk.byteLength;
        if (length > 1_048_576) throw new Error("output limit");
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    };
    const work = Promise.all([read(), child.exited]);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), 125_000);
    });
    const [body, exit] = await Promise.race([work, timeout]);
    if (body === null || typeof body !== "object" || Array.isArray(body))
      throw new Error("invalid output");
    const result = body as Record<string, unknown>;
    if (result.version !== AUTH_LOCAL_VERSION && exit === 0)
      throw new Error("version mismatch");
    return { ok: exit === 0, body: result };
  } catch {
    return {
      ok: false,
      body: {
        error: "auth_command_unavailable",
        message:
          "Upgrade both OpenLLM binaries and start the daemon. Check auth status before retrying a mutation; no cloud fallback was attempted.",
      },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      child?.kill();
    } catch {
      /* already exited */
    }
  }
};
