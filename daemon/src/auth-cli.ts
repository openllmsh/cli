/** Short-lived CLI is a private loopback client, never a provider executor. */
import type { TLocalAuthRequest } from "@openllmsh/sdk/protocol";
import {
  AUTH_CODE_MAX_BYTES,
  AUTH_LOCAL_PATH,
  AUTH_LOCAL_VERSION,
  authHelp,
  DOCTOR_LOCAL_CAPABILITY_HEADER,
  parseAuthArgs,
} from "@openllmsh/sdk/protocol";
import { readOwnerDoctorCapability } from "./doctor-report/capability";
import { daemonPort } from "./env";

export const callLocalAuth = async (
  request: TLocalAuthRequest,
): Promise<{
  readonly ok: boolean;
  readonly body: Record<string, unknown>;
}> => {
  const token = readOwnerDoctorCapability();
  if (token === null)
    return {
      ok: false,
      body: {
        error: "capability_missing",
        message:
          "Local capability unavailable. Start the daemon with openllm start; if already running, upgrade and restart it.",
      },
    };
  try {
    const response = await fetch(
      `http://127.0.0.1:${daemonPort()}${AUTH_LOCAL_PATH}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
        headers: {
          Host: "127.0.0.1",
          "content-type": "application/json",
          [DOCTOR_LOCAL_CAPABILITY_HEADER]: token,
        },
        body: JSON.stringify(request),
      },
    );
    if (response.status === 404)
      return {
        ok: false,
        body: {
          error: "upgrade_required",
          message:
            "Running daemon does not support auth. Upgrade OpenLLM and restart the daemon.",
        },
      };
    if (response.status === 403)
      return {
        ok: false,
        body: {
          error: "capability_rejected",
          message:
            "Local capability expired or access denied. Retry after the daemon finishes restarting.",
        },
      };
    const value: unknown = await response.json();
    if (
      value === null ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== AUTH_LOCAL_VERSION
    )
      return {
        ok: false,
        body: {
          error: "version_mismatch",
          message: "Upgrade OpenLLM and restart the daemon.",
        },
      };
    return { ok: response.ok, body: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      body: {
        error: "daemon_unavailable",
        message:
          "Local daemon stopped, unreachable, or timed out. Run openllm start, then check auth status before retrying a mutation. No cloud fallback was attempted.",
      },
    };
  }
};

export const readAuthCode = async (
  input: AsyncIterable<Uint8Array | string>,
): Promise<string> => {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > AUTH_CODE_MAX_BYTES + 2)
      throw new Error("Authorization code exceeds input limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
};

/** Long-poll hold per round; under the loopback fetch timeout. */
const WATCH_WAIT_MS = 55_000;

/** A watched flow is over once it connected or ended; nothing more will change for it. */
const flowSettled = (body: Record<string, unknown>): boolean => {
  const flow = body.flow as Record<string, unknown> | undefined;
  return flow?.state === "connected" || flow?.state === "ended";
};

/**
 * `auth status --watch`: one snapshot per change, each the same shape as a
 * one-shot `status` reply. Ends when a watched `--flow-id` settles, on any
 * error reply, or on Ctrl-C.
 */
export const watchStatus = async (
  request: TLocalAuthRequest,
  output: (body: Record<string, unknown>) => void,
  call: typeof callLocalAuth = callLocalAuth,
): Promise<number> => {
  let since: string | undefined;
  for (;;) {
    const result = await call({
      ...request,
      ...(since !== undefined ? { since, wait_ms: WATCH_WAIT_MS } : {}),
    });
    if (!result.ok) {
      output(result.body);
      return 1;
    }
    const revision = result.body.revision;
    if (typeof revision !== "string") {
      output({
        error: "upgrade_required",
        message: "Running daemon does not support --watch. Restart it.",
      });
      return 1;
    }
    if (revision !== since) output(result.body);
    if (request.flow_id !== undefined && flowSettled(result.body)) return 0;
    since = revision;
  }
};

export const runAuthCli = async (args: readonly string[]): Promise<number> => {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(authHelp("openllmd"));
    return 0;
  }
  const json = args.includes("--json");
  const output = (body: Record<string, unknown>): void => {
    // Human output is labelled/indented; machine output is one JSON object.
    process.stdout.write(
      `${JSON.stringify(body, null, json ? undefined : 2)}\n`,
    );
  };
  try {
    // Validate syntax before waiting for stdin. No code may be present in argv.
    parseAuthArgs(
      args,
      args[0] === "submit-code" ? "validation-placeholder" : undefined,
    );
    if (args[0] === "submit-code" && process.stdin.isTTY) {
      throw new Error(
        "Read the authorization code from a secret-safe stdin pipe, not shell arguments or an echoed terminal",
      );
    }
    const request = parseAuthArgs(
      args,
      args[0] === "submit-code" ? await readAuthCode(process.stdin) : undefined,
    );
    if (args.includes("--watch")) return await watchStatus(request, output);
    const result = await callLocalAuth(request);
    output(result.body);
    return result.ok ? 0 : 1;
  } catch (err) {
    const detail =
      err instanceof Error && err.message.trim() !== ""
        ? err.message.trim()
        : "See openllm auth --help.";
    output({
      error: "invalid_auth_arguments",
      message: detail,
    });
    return 2;
  }
};
