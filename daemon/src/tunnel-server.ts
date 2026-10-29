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
  TEAM_GRANT_HEADER,
  TUNNEL_MEDIA_MAX_BODY_BYTES,
  TUNNELED_REQUEST_HEADER,
  TUNNELED_REQUEST_VALUE,
  tunnelResponseHeadersFromHttp,
} from "@openllmsh/protocol";
import { StreamResetError } from "@openllmsh/tunnel/stream-reset-error";
import type { TServeTunnel } from "@openllmsh/tunnel/streams";
import { handleInference } from "./listener";
import { logInfo, logWarn, safeDiagnosticMessage } from "./logger";
import { beginRequest, endRequest } from "./self-update";
import {
  admitTeamGrantForChannel,
  estimateTeamReserveTokens,
  modelFromRequestBody,
  teamGrantFromStreamOpen,
} from "./team-grant-admit";
import { observedTeamLegTokens } from "./team-leg-body";
import {
  reportTeamLegCompletion,
  reportTeamLegDispatch,
} from "./team-leg-dispatch";
import { currentTeamChannelScope, withTeamGrant } from "./team-request-context";
import {
  beginServedTunnel,
  canServeTunnel,
  endServedTunnel,
} from "./tunnel-capacity";

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

const recordTunnelRequest = (input: {
  readonly path: "fleet" | "browser" | "team";
  readonly transport: "rtc" | "mux";
  readonly admissionMs: number;
  readonly resHeadMs: number;
  readonly servingInflight: number;
}): void => {
  logInfo("tunnel_request", safeDiagnosticMessage`tunnel_request`, undefined, {
    tunnel_path: input.path,
    tunnel_transport: input.transport,
    rung_fallback_reason: "none",
    channel_reused: false,
    plan_cache: "miss",
    serving_inflight: input.servingInflight,
    timings: {
      open_ms: 0,
      admission_ms: input.admissionMs,
      res_head_ms: input.resHeadMs,
    },
  });
};

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
  // Team grant: re-check on the request path (model / local cap / kill switch).
  // Same-user hops omit it. See docs/plan/2026-10-26-teams.md §16.1 / §16.4.
  if (open.headers?.team_grant !== undefined) {
    headers.set(TEAM_GRANT_HEADER, open.headers.team_grant);
  }
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

/** The request dispatcher a mux tunnel server hands each tunneled request to. */
export type TTunnelDispatch = (req: Request) => Promise<Response>;

export type TTeamLegDispatchReporter = (input: {
  readonly nonce: string;
  readonly teamGrant: string;
}) => Promise<void>;

export type TTeamLegCompletionReporter = (input: {
  readonly nonce: string;
  readonly teamGrant: string;
  readonly actualTokens: number;
}) => Promise<void>;

/**
 * Run a dispatched team leg and always report its completion, so the hold is
 * released rather than swept at its full amount. A provider error, a bodyless
 * response or a dispatch that throws produced no completion: it reports 0.
 * A streamed response reports its observed usage without delaying the body.
 */
const dispatchTeamLeg = async (
  run: () => Promise<Response>,
  grant: { readonly n: string },
  teamGrant: string,
  reportCompletion: TTeamLegCompletionReporter,
): Promise<Response> => {
  const reportNone = (): void => {
    void reportCompletion({ nonce: grant.n, teamGrant, actualTokens: 0 }).catch(
      () => {},
    );
  };
  let response: Response;
  try {
    response = await run();
  } catch (err) {
    reportNone();
    throw err;
  }
  if (!response.ok || response.body === null) {
    reportNone();
    return response;
  }
  const [forConsumer, forObservation] = response.body.tee();
  const eventStream =
    response.headers.get("content-type")?.includes("text/event-stream") ===
    true;
  void observedTeamLegTokens(forObservation, eventStream)
    .then((actualTokens) =>
      reportCompletion({
        nonce: grant.n,
        teamGrant,
        actualTokens,
      }),
    )
    .catch(() => {});
  return new Response(forConsumer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * Enough leading JSON to find the routing model without making a slow client
 * upload finish before the serving daemon can start walking it. A model after
 * this bound takes the conservative, exact full-buffer admission path.
 */
export const TEAM_MODEL_SCAN_MAX_BYTES = 64 * 1024;

const textDecoder = new TextDecoder();

/**
 * Return a top-level JSON `model` string from an incomplete leading body.
 * This deliberately does not regex nested objects: a later `messages[].model`
 * must not admit a request whose root model differs (or is absent).
 */
export const modelFromLeadingJson = (body: Uint8Array): string | null => {
  const text = textDecoder.decode(body);
  let depth = 0;
  let stringStart = -1;
  let stringKind: "key" | "model" | "ignore" = "ignore";
  let escaped = false;
  let pendingKey: string | null = null;
  let awaitingKey = false;
  let awaitingValue = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (stringStart >= 0) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char !== '"') continue;
      const encoded = text.slice(stringStart, index + 1);
      const completedKind = stringKind;
      stringStart = -1;
      stringKind = "ignore";
      if (completedKind === "ignore") continue;
      let value: string;
      try {
        value = JSON.parse(encoded) as string;
      } catch {
        return null;
      }
      if (completedKind === "key") {
        pendingKey = value;
        awaitingKey = false;
      } else {
        return value.length > 0 ? value : null;
      }
      continue;
    }
    if (char === '"') {
      stringStart = index;
      stringKind =
        depth === 1 && awaitingKey
          ? "key"
          : depth === 1 && awaitingValue && pendingKey === "model"
            ? "model"
            : "ignore";
      continue;
    }
    if (char === "{") {
      depth += 1;
      if (depth === 1) awaitingKey = true;
      continue;
    }
    if (char === "}") {
      if (depth === 1) return null;
      depth -= 1;
      continue;
    }
    if (depth !== 1) continue;
    if (char === ":" && pendingKey !== null) {
      awaitingValue = true;
      continue;
    }
    if (char === ",") {
      pendingKey = null;
      awaitingKey = true;
      awaitingValue = false;
      continue;
    }
    if (!/\s/.test(char) && awaitingValue) awaitingValue = false;
  }
  return null;
};

const combineChunks = (
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array => {
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
};

const bodyWithSizeLimit = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: readonly Uint8Array[],
  prefixBytes: number,
): ReadableStream<Uint8Array> => {
  let prefixIndex = 0;
  let total = prefixBytes;
  return new ReadableStream({
    async pull(controller): Promise<void> {
      if (prefixIndex < prefix.length) {
        controller.enqueue(prefix[prefixIndex]);
        prefixIndex += 1;
        return;
      }
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      total += next.value.byteLength;
      if (total > TUNNEL_MEDIA_MAX_BODY_BYTES) {
        await reader
          .cancel("team body exceeds media size limit")
          .catch(() => {});
        controller.error(
          new StreamResetError("unauthorized", "team_body_too_large"),
        );
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason).catch(() => {});
    },
  });
};

/** Admission remains daemon-owned so concurrent mux tunnels share one cap. */
export const admitMuxTunnel = (): "tunnel_busy" | null =>
  canServeTunnel() ? null : "tunnel_busy";

/**
 * Build a mux tunnel server over `dispatch`. Pure: returns a serving function
 * and installs nothing. Admission + self-update fencing stay daemon-wide.
 *
 * Team traffic: when `open.headers.team_grant` is present the grant is
 * verified (signature, device, model, local cap, kill switch,
 * `teamShareable`) before dispatch. Same-user opens omit the field and behave
 * exactly as before.
 */
export const createMuxTunnelServer =
  (
    dispatch: TTunnelDispatch,
    transport: "rtc" | "mux" = "mux",
    reportDispatch: TTeamLegDispatchReporter = reportTeamLegDispatch,
    reportCompletion: TTeamLegCompletionReporter = reportTeamLegCompletion,
  ): TServeTunnel =>
  async (open, body, signal) => {
    const startedAt = Date.now();
    const servingInflight = beginServedTunnel();
    beginRequest();
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      signal.removeEventListener("abort", complete);
      endServedTunnel();
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
      // Read only as far as a root `model` (bounded) before admitting a team
      // request. The replay stream preserves those bytes for the walker and
      // continues enforcing the media limit while dispatch is already running.
      // If the model is not early enough, retain the historical exact-body path.
      const teamToken = teamGrantFromStreamOpen(open);
      const teamChannelScope = currentTeamChannelScope();
      if (teamToken !== null && teamChannelScope === null) {
        complete();
        throw new StreamResetError("unauthorized", "team_channel_required");
      }
      if (teamToken !== null && teamChannelScope !== null) {
        const chunks: Uint8Array[] = [];
        // Scan into one bounded buffer instead of re-concatenating all chunks
        // after every read (which made a fragmented upload quadratic).
        const modelScan = new Uint8Array(TEAM_MODEL_SCAN_MAX_BYTES);
        let modelScanLength = 0;
        // Rescan only when the prefix has doubled (or the scan window is
        // full) so a body split into many tiny frames costs linear, not
        // quadratic, scanning.
        let lastScannedLength = 0;
        let total = 0;
        let model: string | null = null;
        let ended = false;
        const reader = body.getReader();
        while (!ended && total < TEAM_MODEL_SCAN_MAX_BYTES && model === null) {
          if (signal.aborted) {
            complete();
            throw new Error("mux tunnel aborted before dispatch");
          }
          const next = await reader.read();
          if (next.done) {
            ended = true;
            break;
          }
          total += next.value.byteLength;
          if (total > TUNNEL_MEDIA_MAX_BODY_BYTES) {
            void reader.cancel().catch(() => {});
            complete();
            throw new StreamResetError("unauthorized", "team_body_too_large");
          }
          chunks.push(next.value);
          const remainingScanBytes =
            TEAM_MODEL_SCAN_MAX_BYTES - modelScanLength;
          if (remainingScanBytes > 0) {
            const scanChunk = next.value.subarray(0, remainingScanBytes);
            modelScan.set(scanChunk, modelScanLength);
            modelScanLength += scanChunk.byteLength;
          }
          if (
            modelScanLength >= TEAM_MODEL_SCAN_MAX_BYTES ||
            modelScanLength >= lastScannedLength * 2
          ) {
            lastScannedLength = modelScanLength;
            model = modelFromLeadingJson(
              modelScan.subarray(0, modelScanLength),
            );
          }
        }
        if (model === null && modelScanLength > lastScannedLength) {
          model = modelFromLeadingJson(modelScan.subarray(0, modelScanLength));
        }

        if (model === null && !ended) {
          for (;;) {
            if (signal.aborted) {
              complete();
              throw new Error("mux tunnel aborted before dispatch");
            }
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > TUNNEL_MEDIA_MAX_BODY_BYTES) {
              void reader.cancel().catch(() => {});
              complete();
              throw new StreamResetError("unauthorized", "team_body_too_large");
            }
            chunks.push(next.value);
          }
          const buffered = combineChunks(chunks, total);
          model = modelFromRequestBody(buffered);
          const decision = await admitTeamGrantForChannel(
            teamToken,
            model,
            estimateTeamReserveTokens(buffered),
            teamChannelScope,
          );
          if (!decision.ok) {
            complete();
            logWarn("tunnel", "Team grant refused.", {
              reason: decision.reason,
            });
            throw new StreamResetError(
              "unauthorized",
              `team_${decision.reason}`,
            );
          }
          void reportDispatch({
            nonce: decision.grant.n,
            teamGrant: teamToken,
          }).catch(() => {});
          const response = await dispatchTeamLeg(
            () =>
              withTeamGrant(teamToken, decision.grant, () =>
                dispatch(tunneledRequest(open, buffered, signal)),
              ),
            decision.grant,
            teamToken,
            reportCompletion,
          );
          recordTunnelRequest({
            path: "team",
            transport,
            admissionMs: Date.now() - startedAt,
            resHeadMs: Date.now() - startedAt,
            servingInflight,
          });
          return {
            status: response.status,
            headers: tunnelResponseHeadersFromHttp(response.headers),
            body: response.body,
            onComplete: complete,
          };
        }

        const decision = await admitTeamGrantForChannel(
          teamToken,
          model,
          estimateTeamReserveTokens(combineChunks(chunks, total)),
          teamChannelScope,
        );
        if (!decision.ok) {
          complete();
          logWarn("tunnel", "Team grant refused.", { reason: decision.reason });
          throw new StreamResetError("unauthorized", `team_${decision.reason}`);
        }
        void reportDispatch({
          nonce: decision.grant.n,
          teamGrant: teamToken,
        }).catch(() => {});
        const response = await dispatchTeamLeg(
          () =>
            withTeamGrant(teamToken, decision.grant, () =>
              dispatch(
                ended
                  ? tunneledRequest(open, combineChunks(chunks, total), signal)
                  : tunneledRequest(
                      open,
                      bodyWithSizeLimit(reader, chunks, total),
                      signal,
                    ),
              ),
            ),
          decision.grant,
          teamToken,
          reportCompletion,
        );
        recordTunnelRequest({
          path: "team",
          transport,
          admissionMs: Date.now() - startedAt,
          resHeadMs: Date.now() - startedAt,
          servingInflight,
        });
        return {
          status: response.status,
          headers: tunnelResponseHeadersFromHttp(response.headers),
          body: response.body,
          onComplete: complete,
        };
      }
      const response = await dispatch(tunneledRequest(open, body, signal));
      recordTunnelRequest({
        path: open.consumer === "daemon" ? "fleet" : "browser",
        transport,
        admissionMs: Date.now() - startedAt,
        resHeadMs: Date.now() - startedAt,
        servingInflight,
      });
      return {
        status: response.status,
        headers: tunnelResponseHeadersFromHttp(response.headers),
        body: response.body,
        onComplete: complete,
      };
    } catch (error) {
      complete();
      if (!signal.aborted) {
        logWarn("tunnel", "Mux dispatch failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  };

/** Daemon adapter for the generic mux serving seam (dispatches to the walker). */
export const serveMuxTunnel: TServeTunnel = createMuxTunnelServer((req) =>
  handleInference(req),
);

/** RTC-mounted muxes share dispatch but report their actual transport. */
export const serveRtcTunnel: TServeTunnel = createMuxTunnelServer(
  (req) => handleInference(req),
  "rtc",
);
