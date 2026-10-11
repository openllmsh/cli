/** Shared private loopback transport guards. Never used by the public health/CORS surface. */
import { DOCTOR_LOCAL_CAPABILITY_HEADER } from "@openllmsh/protocol";
import { capabilityMatches } from "./doctor-report/capability";

export const localJson = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
const portOk = (port: string): boolean =>
  /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
export const isLoopbackLocalHost = (host: string | null): boolean => {
  if (host === null) return false;
  const raw = host.trim().toLowerCase();
  if (raw === "" || raw.includes("@") || /\s/.test(raw)) return false;
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close <= 1 || raw.slice(1, close) !== "::1") return false;
    const rest = raw.slice(close + 1);
    return rest === "" || (rest.startsWith(":") && portOk(rest.slice(1)));
  }
  const parts = raw.split(":");
  if (
    parts.length > 2 ||
    (parts[0] !== "127.0.0.1" && parts[0] !== "localhost")
  )
    return false;
  return parts[1] === undefined || portOk(parts[1]);
};
export const localAccessFailure = (
  req: Request,
): "forbidden" | "capability_missing" | null => {
  if (
    !isLoopbackLocalHost(req.headers.get("host")) ||
    req.headers.has("origin")
  )
    return "forbidden";
  return capabilityMatches(req.headers.get(DOCTOR_LOCAL_CAPABILITY_HEADER))
    ? null
    : "capability_missing";
};

/** Bound while reading, not after arrayBuffer allocates an unbounded chunked body. */
export const readBoundedLocalJson = async (
  req: Request,
  maxBytes: number,
): Promise<unknown | Response> => {
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes)
    return localJson(413, { error: "oversize" });
  if (
    req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return localJson(415, { error: "unsupported_media_type" });
  if (req.body === null) return localJson(400, { error: "invalid" });
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        return localJson(413, { error: "oversize" });
      }
      chunks.push(next.value);
    }
    return JSON.parse(
      Buffer.concat(chunks, length).toString("utf8"),
    ) as unknown;
  } catch {
    return localJson(400, { error: "invalid" });
  } finally {
    reader.releaseLock();
  }
};
