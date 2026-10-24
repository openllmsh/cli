/**
 * `POST /local/agent-hook` — Claude hook calls for agent sessions, from
 * `openllm exec agent hook <event>` in the session's own Claude process.
 * Admission is the loopback `/local/*` gate with the local control capability
 * (`localAgentRefusal`); no device grant on loopback.
 */
import {
  AGENT_HOOK_EVENTS,
  AGENT_SESSION_ID_PATTERN,
} from "@openllmsh/protocol";
import { handleAgentHook } from "./claude-code";
import { localAgentRefusal, localAgentRefusalResponse } from "./loopback";

/** Max hook request body (a tool input can be large). */
const HOOK_BODY_MAX_BYTES = 1024 * 1024;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const isEvent = (value: unknown): value is (typeof AGENT_HOOK_EVENTS)[number] =>
  typeof value === "string" &&
  (AGENT_HOOK_EVENTS as readonly string[]).includes(value);

export const handleLocalAgentHook = async (
  req: Request,
  remoteAddress: string | null | undefined,
): Promise<Response> => {
  const refusal = localAgentRefusal(req, remoteAddress);
  if (refusal !== null) return localAgentRefusalResponse(refusal);
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const text = await req.text();
  if (text.length > HOOK_BODY_MAX_BYTES)
    return json(413, { error: "too_large" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return json(400, { error: "invalid_body" });
  const {
    session_id: sessionId,
    event,
    payload,
  } = body as Record<string, unknown>;
  if (
    typeof sessionId !== "string" ||
    !AGENT_SESSION_ID_PATTERN.test(sessionId) ||
    !isEvent(event) ||
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  )
    return json(400, { error: "invalid_body" });
  const output = await handleAgentHook(
    sessionId,
    event,
    payload as Record<string, unknown>,
  );
  return json(200, output === null ? {} : { output });
};
