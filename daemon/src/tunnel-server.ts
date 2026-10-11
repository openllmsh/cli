/**
 * The SERVING end of the subscription tunnel
 * (`docs/features/sub-tunnel-and-chat-sessions.md` §1). A consumer (a
 * browser tab, or a fleet-peer daemon) opens a mux stream over the relay
 * binary mux (or a direct RTC data channel); this module dispatches the
 * request IN-PROCESS against the daemon's own `/v1/*` surface
 * (`handleInference` — same path a loopback client takes, including the
 * daemon-fetched signed plan), and streams the response back over the mux.
 *
 * Isolation: mux tunnels run on their own async tasks — they NEVER ride the
 * control channel's `commandTail` FIFO (a streaming response would block
 * every other command). The vendor subscription credential is injected by
 * the walker locally, exactly as for a loopback request; only OpenLLM-wire
 * request/response bytes cross the relay.
 *
 * Loop-guard stamp (`x-openllm-tunneled`): set ONLY for daemon→daemon fleet
 * hops (`open.consumer === "daemon"`). Browser→device tunnels must NOT stamp
 * it — otherwise the selected device's walker loop-guards `tryFleetTunnel`
 * and never forwards a missing-sub hop to a peer (browser→A→B). See
 * `docs/proposals/browser-selected-device-tunnel-contract.md`.
 */

import type {
  TTunnelForwardHeaders,
  TTunnelSurface,
} from "@openllmsh/protocol";
import {
  MEDIA_PERSISTENCE_BROWSER,
  MEDIA_PERSISTENCE_REQUEST_HEADER,
  TUNNELED_REQUEST_HEADER,
  TUNNELED_REQUEST_VALUE,
  tunnelResponseHeadersFromHttp,
} from "@openllmsh/protocol";
import type { TServeTunnel } from "@openllmsh/tunnel/streams";
import { handleInference } from "./listener";
import { logWarn } from "./logger";
import { beginRequest, endRequest } from "./self-update";

/** Max concurrently-served tunnels — beyond it, mux opens are nacked
 *  `tunnel_busy`. Concurrent tunnels behave like concurrent loopback
 *  clients (the walker already serves several CLIs at once). */
const MAX_SERVED_TUNNELS = 8;

/** The local endpoint each closed-vocabulary surface maps to. No free URL
 *  path ever crosses the relay — the serving daemon owns this mapping. */
const isVideoGetSurface = (
  surface: TTunnelSurface,
): surface is "video_retrieve" | "video_content" =>
  surface === "video_retrieve" || surface === "video_content";

const surfacePath = (
  surface: TTunnelSurface,
  videoId: string | undefined,
): string => {
  switch (surface) {
    case "chat_completions":
      return "/v1/chat/completions";
    case "messages":
      return "/v1/messages";
    case "responses":
      return "/v1/responses";
    case "responses_compact":
      return "/v1/responses/compact";
    case "audio_transcriptions":
      return "/v1/audio/transcriptions";
    case "audio_speech":
      return "/v1/audio/speech";
    case "images_generations":
      return "/v1/images/generations";
    case "images_edits":
      return "/v1/images/edits";
    case "video_create":
      return "/v1/videos";
    case "video_retrieve":
      return `/v1/videos/${encodeURIComponent(videoId ?? "")}`;
    case "video_content":
      return `/v1/videos/${encodeURIComponent(videoId ?? "")}/content`;
  }
};

let muxServedCount = 0;

const forwardedHeaders = (open: {
  readonly consumer?: "browser" | "daemon";
  readonly headers?: TTunnelForwardHeaders;
}): Headers => {
  const headers = new Headers();
  if (open.headers?.media_persistence === MEDIA_PERSISTENCE_BROWSER)
    headers.set(MEDIA_PERSISTENCE_REQUEST_HEADER, MEDIA_PERSISTENCE_BROWSER);
  headers.set("content-type", open.headers?.content_type ?? "application/json");
  if (open.headers?.accept !== undefined)
    headers.set("accept", open.headers.accept);
  if (open.headers?.anthropic_version !== undefined)
    headers.set("anthropic-version", open.headers.anthropic_version);
  if (open.headers?.anthropic_beta !== undefined)
    headers.set("anthropic-beta", open.headers.anthropic_beta);
  if (open.headers?.user_agent !== undefined)
    headers.set("user-agent", open.headers.user_agent);
  // Only fleet-daemon hops are tunnel-borne for the walker loop-guard.
  // Browser (or omitted consumer) leaves the header off so the selected
  // device may still tryFleetTunnel once.
  if (open.consumer === "daemon") {
    headers.set(TUNNELED_REQUEST_HEADER, TUNNELED_REQUEST_VALUE);
  }
  return headers;
};

type TTunneledOpen = {
  readonly surface: TTunnelSurface;
  readonly consumer?: "browser" | "daemon";
  readonly headers?: TTunnelForwardHeaders;
};

function tunneledRequest(
  open: TTunneledOpen,
  body: Uint8Array,
  signal: AbortSignal,
): Request;
function tunneledRequest(
  open: TTunneledOpen,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Request;
/** Construct the in-process request while preserving Bun's stream duplex requirement. */
function tunneledRequest(
  open: TTunneledOpen,
  body: ReadableStream<Uint8Array> | Uint8Array,
  signal: AbortSignal,
): Request {
  const url = `http://127.0.0.1${surfacePath(open.surface, open.headers?.video_id)}`;
  const headers = forwardedHeaders(open);
  const method = isVideoGetSurface(open.surface) ? "GET" : "POST";
  if (method === "GET") {
    return new Request(url, { method, headers, signal });
  }
  if (body instanceof Uint8Array) {
    return new Request(url, {
      method,
      headers,
      body: body as unknown as BodyInit,
      signal,
    });
  }
  return new Request(url, {
    method,
    headers,
    body,
    duplex: "half",
    signal,
  } as RequestInit);
}

/** The request dispatcher — `handleInference` in production; injectable so
 *  tests exercise the tunnel state machine without a walker/cloud. */
type TDispatch = (req: Request) => Promise<Response>;
let dispatch: TDispatch = (req) => handleInference(req);
export const setTunnelDispatcher = (fn: TDispatch | null): void => {
  dispatch = fn ?? ((req) => handleInference(req));
};

/** Admission remains daemon-owned so concurrent mux tunnels share one cap. */
export const admitMuxTunnel = (): "tunnel_busy" | null =>
  muxServedCount >= MAX_SERVED_TUNNELS ? "tunnel_busy" : null;

/** Daemon adapter for the generic mux serving seam. */
export const serveMuxTunnel: TServeTunnel = async (open, body, signal) => {
  muxServedCount += 1;
  beginRequest();
  let completed = false;
  const complete = (): void => {
    if (completed) return;
    completed = true;
    signal.removeEventListener("abort", complete);
    muxServedCount -= 1;
    endRequest();
  };
  // Dispatch can still be awaiting a provider when the relay dies. Release
  // daemon-owned admission and self-update fencing immediately; completion is
  // idempotent if a late response subsequently reaches the generic streamer.
  signal.addEventListener("abort", complete, { once: true });
  if (signal.aborted) {
    complete();
    throw new Error("mux tunnel aborted before dispatch");
  }
  try {
    const response = await dispatch(tunneledRequest(open, body, signal));
    return {
      status: response.status,
      headers: tunnelResponseHeadersFromHttp(response.headers),
      body: response.body,
      onComplete: complete,
    };
  } catch (error) {
    complete();
    if (!signal.aborted) {
      logWarn(
        "tunnel",
        `mux dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
};
