/**
 * Local `/v1/audio/transcriptions` + `/v1/audio/speech` for subscription
 * providers, served the same way `image-walker.ts` serves
 * `/v1/images/generations`: the daemon only walks here once it already knows a subscription hop can
 * serve the model, so a missing credential is a real local failure (404),
 * not a signal to fall back anywhere else.
 *
 * Three verified upstream shapes (foundation research, ac06f4cb):
 *   - claude_code (dictation): a WebSocket
 *     (`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`) that
 *     wants mono 16-bit 16kHz PCM in binary frames — batch input is decoded
 *     locally (`audio/pcm.ts`) and streamed (`audio/claude-ws.ts`).
 *   - chatgpt (Codex): `POST /backend-api/transcribe` (multipart, webm/opus)
 *     and `POST /backend-api/pronunciation/synthesize?format=mp3` (JSON →
 *     raw MP3 bytes, no voice selector).
 *   - grok: `POST /v1/stt` (multipart, mono 16-bit 16kHz WAV) and
 *     `POST /v1/tts` (JSON, voice fixed to `eve` → MP3).
 *
 * Options are validated against the verified per-provider format/voice
 * constants in `@openllmsh/protocol` (`CLAUDE_DICTATION_INPUT_FORMATS`,
 * `CODEX_*`, `GROK_*`) — an unsupported input encoding or an explicit
 * unsupported voice/output-format is rejected (415/400), never silently
 * dropped or forwarded to a wire that doesn't support it.
 */
import {
  CLAUDE_DICTATION_INPUT_FORMATS,
  CODEX_SPEECH_OUTPUT_FORMATS,
  CODEX_SPEECH_VOICES,
  CODEX_TRANSCRIBE_INPUT_FORMATS,
  GROK_STT_INPUT_FORMATS,
  GROK_TTS_OUTPUT_FORMATS,
  GROK_TTS_VOICES,
  isSubscriptionProviderSlug,
  MEDIA_PERSISTENCE_BROWSER,
  MEDIA_PERSISTENCE_REQUEST_HEADER,
  MEDIA_PERSISTENCE_RESPONSE_HEADER,
} from "@openllmsh/protocol";
import { TUNNEL_MEDIA_MAX_BODY_BYTES } from "@openllmsh/tunnel";
import type { TWebSocketFactory } from "./audio/claude-ws";
import { runClaudeDictationSession } from "./audio/claude-ws";
import {
  extractClaudeDictationPcm,
  framePcm,
  isPcmParseFailure,
} from "./audio/pcm";
import { uploadMedia } from "./cloud-client";
import { lookupCatalogEntry } from "./config";
import { errorJson } from "./cors";
import { getDelegate } from "./delegation";
import type { TImageCredential } from "./delegation/types";
import { logWarn, safeDiagnosticMessage } from "./logger";
import { withMediaAttribution } from "./media-attribution";
import { forwardMediaHopToCloud } from "./media-cloud-forward";
import { mediaHopAdvances, mediaHttpErrorCode } from "./media-retry";
import type { TParsedMultipart, TParsedMultipartFile } from "./multipart";
import { multipartFile } from "./multipart";
import type { TWalkArgs } from "./walker";
import {
  coolHopAfterStaleRefresh,
  parsePlan,
  passthroughHeaders,
  planSignatureOk,
  postUpstream,
  report,
  resolveHop,
} from "./walker";

// ─── Credential acquisition (mirrors `acquireImageUpstream`) ───────────────

type TAudioOp = "transcription" | "speech";

type TAudioUpstream = {
  readonly headers: Record<string, string>;
  readonly url: string;
  readonly accountHash: string | null;
};

const delegateHookFor = (
  op: TAudioOp,
): "credentialForTranscription" | "credentialForSpeech" =>
  op === "transcription" ? "credentialForTranscription" : "credentialForSpeech";

/** Test seam: override the injected WebSocket transport for the claude_code
 *  dictation session (never touched in production). */
let claudeWsFactoryForTests: TWebSocketFactory | undefined;
export const setClaudeWsFactoryForTests = (
  factory: TWebSocketFactory | undefined,
): void => {
  claudeWsFactoryForTests = factory;
};

/** Test seam: skip real-time frame pacing so tests don't wait wall-clock
 *  time for a multi-second recording. */
let claudePaceForTests: ((ms: number) => Promise<void>) | undefined;
export const setClaudePaceForTests = (
  pace: ((ms: number) => Promise<void>) | undefined,
): void => {
  claudePaceForTests = pace;
};

const acquireAudioUpstream = async (
  op: TAudioOp,
  provider: string,
  args: TWalkArgs,
  hop: { readonly provider: string; readonly modelId: string },
): Promise<TAudioUpstream | "retry"> => {
  const delegate = getDelegate(provider);
  const hook = delegateHookFor(op);
  const credentialFor = delegate?.[hook];
  if (credentialFor === undefined) return "retry";
  try {
    const cred: TImageCredential = await credentialFor(args.req.headers);
    if (cred.stale_refresh !== undefined) {
      coolHopAfterStaleRefresh(hop, cred.stale_refresh);
      return "retry";
    }
    return {
      headers: {
        ...cred.headers,
        authorization: `Bearer ${cred.access_token}`,
      },
      url: cred.url,
      accountHash: cred.account_hash ?? null,
    };
  } catch {
    return "retry";
  }
};

/** Ordered plan hops. Subscription audio hooks and API-key tails both appear. */
const listAudioHops = (args: TWalkArgs) => {
  const pmids = args.pmidsParam === null ? [] : args.pmidsParam.split(",");
  return parsePlan(args.planParam).map((modelId, index) =>
    resolveHop(modelId, pmids[index]),
  );
};

const requirePlanned = (args: TWalkArgs): Response | null => {
  if (
    !planSignatureOk(
      args.planParam,
      args.pmidsParam,
      args.originParam,
      args.contextOverflowStrategy ?? null,
      args.sigParam,
    )
  ) {
    return errorJson(403, "invalid or missing plan signature");
  }
  if (args.planParam === null) {
    return errorJson(400, "audio requires a daemon plan");
  }
  return null;
};

// ─── Transcription ──────────────────────────────────────────────────────

/** Either an already-parsed multipart body, or a JSON body carrying `file`
 *  as a `data:` URL (mirroring the cloud handler's `jsonAudioToFormData`
 *  convention) — the listener hands over whichever shape the client sent. */
export type TAudioTranscriptionInput =
  | { readonly kind: "multipart"; readonly multipart: TParsedMultipart }
  | { readonly kind: "json"; readonly body: unknown };

type TDetectedAudioFormat =
  | "webm_opus"
  | "wav_pcm16_16khz_mono"
  | "pcm_s16le_16khz_mono";

const DATA_URL_RE = /^data:([^;,]*);base64,(.*)$/s;

const decodeBase64 = (b64: string): Uint8Array | null => {
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

type TTranscriptionFileInput = {
  readonly bytes: Uint8Array;
  readonly contentType?: string;
  readonly filename?: string;
};

type TNormalizedTranscriptionRequest = {
  readonly file: TTranscriptionFileInput;
  readonly language?: string;
  readonly prompt?: string;
  readonly responseFormat?: string;
};

type TNormalizeFailure = { readonly status: number; readonly message: string };

const normalizeTranscriptionInput = (
  input: TAudioTranscriptionInput,
): TNormalizedTranscriptionRequest | TNormalizeFailure => {
  if (input.kind === "multipart") {
    const file: TParsedMultipartFile | undefined = multipartFile(
      input.multipart,
      "file",
    );
    if (file === undefined) {
      return { status: 400, message: "`file` is required" };
    }
    const fields = input.multipart.fields;
    return {
      file: {
        bytes: file.bytes,
        ...(file.contentType !== undefined
          ? { contentType: file.contentType }
          : {}),
        ...(file.filename !== undefined ? { filename: file.filename } : {}),
      },
      ...(typeof fields.language === "string"
        ? { language: fields.language }
        : {}),
      ...(typeof fields.prompt === "string" ? { prompt: fields.prompt } : {}),
      ...(typeof fields.response_format === "string"
        ? { responseFormat: fields.response_format }
        : {}),
    };
  }
  const raw = input.body;
  if (raw === null || typeof raw !== "object") {
    return { status: 400, message: "Body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.file !== "string") {
    return { status: 400, message: "`file` must be a string (data URL)" };
  }
  const match = DATA_URL_RE.exec(body.file);
  if (match === null) {
    return {
      status: 400,
      message:
        'Daemon HTTP JSON requires `file` starting with "data:audio/wav;base64," followed by actual encoded audio, or a multipart/form-data file upload. The CLI MCP transcription tool accepts {"path":"./voice-note.ogg"} instead and reads the local audio itself.',
    };
  }
  const bytes = decodeBase64(match[2] ?? "");
  if (bytes === null) {
    return { status: 400, message: "`file` base64 payload is not valid" };
  }
  return {
    file: {
      bytes,
      ...(match[1] !== undefined && match[1].length > 0
        ? { contentType: match[1] }
        : {}),
    },
    ...(typeof body.language === "string" ? { language: body.language } : {}),
    ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
    ...(typeof body.response_format === "string"
      ? { responseFormat: body.response_format }
      : {}),
  };
};

const detectAudioFormat = (
  file: TTranscriptionFileInput,
): TDetectedAudioFormat | null => {
  const ct = (file.contentType ?? "").toLowerCase();
  const name = (file.filename ?? "").toLowerCase();
  if (ct.includes("webm") || name.endsWith(".webm")) return "webm_opus";
  if (
    ct.includes("wav") ||
    ct === "audio/x-wav" ||
    ct === "audio/vnd.wave" ||
    name.endsWith(".wav")
  ) {
    return "wav_pcm16_16khz_mono";
  }
  if (
    ct.includes("l16") ||
    ct.includes("pcm") ||
    name.endsWith(".pcm") ||
    name.endsWith(".raw")
  ) {
    return "pcm_s16le_16khz_mono";
  }
  return null;
};

/** The formats this daemon can actually detect AND frame. A catalog card
 *  may name an encoding a future daemon handles; accepting it here would
 *  hand un-decodable bytes to a verified recipe (Claude's dictation
 *  socket wants framed PCM), so a declared format is only honoured when
 *  this build has a decode path for it. */
const DECODABLE_AUDIO_FORMATS: ReadonlyArray<TDetectedAudioFormat> = [
  "webm_opus",
  "wav_pcm16_16khz_mono",
  "pcm_s16le_16khz_mono",
];

const isDecodableAudioFormat = (value: string): value is TDetectedAudioFormat =>
  (DECODABLE_AUDIO_FORMATS as ReadonlyArray<string>).includes(value);

/** Verified per-provider recipe, used ONLY when the catalog says nothing
 *  (an older cloud's bootstrap carries no `audio_support`). Keeping it
 *  means an un-advertised catalog never widens a wire that has a single
 *  verified encoding, and never narrows one either. */
const verifiedInputFormatsFor = (
  provider: string,
): ReadonlyArray<TDetectedAudioFormat> => {
  switch (provider) {
    case "claude_code":
      return CLAUDE_DICTATION_INPUT_FORMATS;
    case "chatgpt":
      return CODEX_TRANSCRIBE_INPUT_FORMATS;
    case "grok":
      return GROK_STT_INPUT_FORMATS;
    default:
      return [];
  }
};

/**
 * Accepted transcription input encodings for THIS model.
 *
 * The fact is per-model catalog data (`audio_support.input_formats`),
 * delivered by the authenticated bootstrap, so a vendor adding an
 * encoding is a catalog edit rather than a daemon release. A card that
 * declares nothing falls back to the verified constant for the provider
 * — absence is compatibility, not a widened wire.
 */
const inputFormatsFor = (hop: {
  readonly provider: string;
  readonly modelId: string;
}): ReadonlyArray<TDetectedAudioFormat> => {
  const declared = lookupCatalogEntry(hop.modelId)?.audio_support
    ?.input_formats;
  if (declared === undefined) return verifiedInputFormatsFor(hop.provider);
  return declared.filter(isDecodableAudioFormat);
};

const stripCodexAssetPointers = (
  parsed: unknown,
): { readonly text: string } => {
  if (parsed !== null && typeof parsed === "object") {
    const text = (parsed as { readonly text?: unknown }).text;
    if (typeof text === "string") return { text };
  }
  throw new Error("upstream transcription response missing text");
};

/** Extensionless fallback filename per detected format — Codex's ASR
 *  backend identifies the container by the multipart filename's extension
 *  (verified live: an extensionless `audio` filename produced an opaque
 *  500 `Error in ASR API`; the verified working recipe explicitly used
 *  `input.webm`). The JSON `data:<mime>;base64,...` request shape
 *  (`jsonAudioToFormData`'s convention) carries no filename at all, so
 *  every JSON-body caller needs this fallback — a multipart caller that
 *  already supplies a real filename is untouched. */
const FILENAME_FALLBACK_FOR_FORMAT: Record<TDetectedAudioFormat, string> = {
  webm_opus: "audio.webm",
  wav_pcm16_16khz_mono: "audio.wav",
  pcm_s16le_16khz_mono: "audio.pcm",
};

const buildTranscriptionForm = (
  file: TTranscriptionFileInput,
  format: TDetectedAudioFormat,
  language: string | undefined,
  extra?: Readonly<Record<string, string>>,
): FormData => {
  const form = new FormData();
  // `new Uint8Array(file.bytes)` forces a concrete `Uint8Array<ArrayBuffer>`
  // — `file.bytes` alone types as `Uint8Array<ArrayBufferLike>` (it may have
  // come from a generic buffer slice), which this repo's stricter typed-array
  // generics reject as a `BlobPart`.
  const blob = new Blob([new Uint8Array(file.bytes)], {
    type: file.contentType ?? "application/octet-stream",
  });
  form.append(
    "file",
    blob,
    file.filename ?? FILENAME_FALLBACK_FOR_FORMAT[format],
  );
  if (language !== undefined) form.append("language", language);
  for (const [key, value] of Object.entries(extra ?? {})) {
    form.append(key, value);
  }
  return form;
};

export const runAudioTranscriptionWalker = async (
  args: TWalkArgs,
  multipart: TParsedMultipart | null,
): Promise<Response> => {
  const planErr = requirePlanned(args);
  if (planErr !== null) return planErr;

  const input: TAudioTranscriptionInput =
    multipart !== null
      ? { kind: "multipart", multipart }
      : { kind: "json", body: args.rawBody };
  const normalized = normalizeTranscriptionInput(input);
  if ("status" in normalized) {
    return errorJson(normalized.status, normalized.message);
  }

  const hops = listAudioHops(args);
  const attempted: string[] = [];
  const stamp = (resp: Response, resolved?: string): Response =>
    withMediaAttribution(resp, {
      attempted,
      ...(resolved !== undefined ? { resolvedModel: resolved } : {}),
    });
  let lastError: Response | null = null;
  const format = detectAudioFormat(normalized.file);

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    if (hop === undefined) continue;
    const last = i === hops.length - 1;
    const transcribeHook = getDelegate(
      hop.provider,
    )?.credentialForTranscription;
    if (
      isSubscriptionProviderSlug(hop.provider) &&
      transcribeHook === undefined
    ) {
      lastError = errorJson(
        404,
        `No transcription credential available for ${hop.provider}`,
      );
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "missing_credential",
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    if (!isSubscriptionProviderSlug(hop.provider)) {
      attempted.push(hop.modelId);
      const forwarded = await forwardMediaHopToCloud(args, hop.modelId);
      if (forwarded.ok) return stamp(forwarded, hop.modelId);
      lastError = forwarded;
      if (
        !last &&
        mediaHopAdvances({
          dispatched: true,
          httpStatus: forwarded.status,
          errorCode: mediaHttpErrorCode(forwarded.status),
          accepted: false,
        })
      ) {
        continue;
      }
      return stamp(forwarded);
    }

    const allowed = inputFormatsFor(hop);
    if (format === null || !allowed.includes(format)) {
      lastError = errorJson(
        415,
        `Unsupported audio input for ${hop.provider}. Accepted: ${
          allowed.length > 0 ? allowed.join(", ") : "none"
        }.`,
      );
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "model_unavailable",
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    // A claimed `wav_pcm16_16khz_mono` (grok's ONLY accepted format, and one
    // of claude_code's two) is verified by actually parsing the container —
    // a WAV with the wrong sample rate/channel count/bit depth is rejected
    // explicitly (415) rather than forwarded and left to the vendor's own
    // (opaque) validation. `pcm_s16le_16khz_mono` (claude_code-only, no
    // header) is validated for shape (even byte count, non-empty) the same
    // way. Grok still gets the ORIGINAL file bytes forwarded untouched below
    // — this is a validation pass, not a transcode.
    const pcmValidation =
      format === "wav_pcm16_16khz_mono" || format === "pcm_s16le_16khz_mono"
        ? extractClaudeDictationPcm(normalized.file.bytes, format)
        : null;
    if (pcmValidation !== null && isPcmParseFailure(pcmValidation)) {
      lastError = errorJson(
        415,
        `Invalid ${format} audio: ${pcmValidation.error}`,
      );
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "missing_credential",
        })
      )
        continue;
      return stamp(lastError);
    }

    attempted.push(hop.modelId);
    const acquired = await acquireAudioUpstream(
      "transcription",
      hop.provider,
      args,
      hop,
    );
    if (acquired === "retry") {
      lastError = errorJson(
        404,
        `No transcription credential available for ${hop.provider}`,
      );
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "missing_credential",
        })
      )
        continue;
      return stamp(lastError);
    }

    const reportResult = (
      status: "success" | "error",
      latencyMs: number,
    ): void => {
      report(
        {
          model: hop.modelId,
          provider: hop.provider,
          status,
          tokens_in: 0,
          tokens_out: 0,
          latency_ms: latencyMs,
          endpoint: args.endpoint,
          ...(acquired.accountHash !== null
            ? { account_hash: acquired.accountHash }
            : {}),
        },
        args.originParam,
      );
    };

    // ── claude_code: decode + stream over the dictation WebSocket ──────────
    if (hop.provider === "claude_code") {
      // Already validated above (`pcmValidation`) — `format` being accepted
      // for claude_code guarantees it was one of the two PCM shapes, so this
      // is always the success variant here.
      if (pcmValidation === null || isPcmParseFailure(pcmValidation)) {
        return errorJson(415, "Invalid dictation audio");
      }
      const pcmResult = pcmValidation;
      const startedAt = Date.now();
      const session = await runClaudeDictationSession({
        url: acquired.url,
        headers: acquired.headers,
        pcm: pcmResult.pcm,
        frames: framePcm(pcmResult.pcm),
        // Verified research recipe: "Send silence at the tail, then
        // CloseStream" — the connection's own `utterance_end_ms=1000` needs a
        // quiet tail to finalize the last utterance; bursting straight into
        // CloseStream starves it and a short clip comes back with an EMPTY
        // transcript despite a 200 (live-verified on this branch).
        trailingSilenceMs: 1_200,
        ...(claudeWsFactoryForTests !== undefined
          ? { wsFactory: claudeWsFactoryForTests }
          : {}),
        ...(claudePaceForTests !== undefined
          ? { pace: claudePaceForTests }
          : {}),
        signal: args.req.signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (session.kind === "error") {
        reportResult("error", latencyMs);
        return errorJson(502, session.message);
      }
      reportResult("success", latencyMs);
      return stamp(
        new Response(JSON.stringify({ text: session.text }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        hop.modelId,
      );
    }

    // ── chatgpt / grok: batch multipart POST, forwarded verbatim ────────────
    const startedAt = Date.now();
    // Both verified subscription STT recipes ALWAYS sent an explicit
    // `language: en` (docs/research/subscription-provider-capabilities-
    // 2026-09-17.md: grok's "Working fields: file=input.wav, language=en,
    // format=true"; chatgpt's "Working form fields: file: input.webm,
    // language: en"). Grok's `/v1/stt` outright REJECTS a request missing it
    // (400 `Field 'language' is required when 'format' is true`) — verified
    // live. The OpenAI-compatible `/v1/audio/transcriptions` contract treats
    // `language` as fully optional, so every caller that omits it (the common
    // case) needs a server-side default here, never a bare pass-through of
    // `undefined`, for either provider. An explicit caller-supplied language
    // still wins.
    const form =
      hop.provider === "grok"
        ? buildTranscriptionForm(
            normalized.file,
            format,
            normalized.language ?? "en",
            { format: "true" },
          )
        : buildTranscriptionForm(
            normalized.file,
            format,
            normalized.language ?? "en",
          );

    const resp = await postUpstream(acquired.url, {
      method: "POST",
      headers: { ...acquired.headers, accept: "application/json" },
      body: form,
      signal: args.req.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (resp === null) {
      reportResult("error", latencyMs);
      return args.req.signal.aborted
        ? errorJson(499, "client aborted request")
        : errorJson(502, "upstream transcription provider is unreachable");
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      reportResult("error", latencyMs);
      lastError = new Response(body.length > 0 ? body : null, {
        status: resp.status,
        headers: passthroughHeaders(resp),
      });
      if (
        !last &&
        mediaHopAdvances({
          dispatched: true,
          httpStatus: resp.status,
          errorCode: mediaHttpErrorCode(resp.status),
          accepted: false,
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    let upstream: unknown;
    try {
      upstream = await resp.json();
    } catch {
      reportResult("error", latencyMs);
      return errorJson(
        502,
        "upstream transcription provider returned invalid JSON",
      );
    }
    let normalizedResponse: { readonly text: string };
    try {
      // Never leak Codex's internal asset pointers (`asset_pointer` /
      // `asset_ttl` / `asset_format`) — the OpenAI-compatible contract is
      // `{text}` (plus optional verbose fields we don't populate here).
      normalizedResponse = stripCodexAssetPointers(upstream);
    } catch (err) {
      reportResult("error", latencyMs);
      return errorJson(
        502,
        err instanceof Error
          ? `upstream transcription provider returned invalid data: ${err.message}`
          : "upstream transcription provider returned invalid data",
      );
    }
    reportResult("success", latencyMs);
    return stamp(
      new Response(JSON.stringify(normalizedResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      hop.modelId,
    );
  }
  return stamp(
    lastError ??
      errorJson(
        404,
        "No transcription provider in the daemon plan can serve this request",
      ),
  );
};

// ─── Speech (TTS) ───────────────────────────────────────────────────────

type TSpeechRequestBody = {
  readonly model: string;
  readonly input: string;
  readonly voice?: string;
  readonly responseFormat?: string;
  readonly speed?: number;
};

const parseSpeechRequestBody = (
  raw: unknown,
):
  | TSpeechRequestBody
  | { readonly status: number; readonly message: string } => {
  if (raw === null || typeof raw !== "object") {
    return { status: 400, message: "Body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.model !== "string" || body.model.length === 0) {
    return { status: 400, message: "`model` is required" };
  }
  if (typeof body.input !== "string" || body.input.length === 0) {
    return { status: 400, message: "`input` is required" };
  }
  if (body.voice !== undefined && typeof body.voice !== "string") {
    return { status: 400, message: "`voice` must be a string" };
  }
  if (
    body.response_format !== undefined &&
    typeof body.response_format !== "string"
  ) {
    return { status: 400, message: "`response_format` must be a string" };
  }
  if (body.speed !== undefined && typeof body.speed !== "number") {
    return { status: 400, message: "`speed` must be a number" };
  }
  return {
    model: body.model,
    input: body.input,
    ...(typeof body.voice === "string" ? { voice: body.voice } : {}),
    ...(typeof body.response_format === "string"
      ? { responseFormat: body.response_format }
      : {}),
    ...(typeof body.speed === "number" ? { speed: body.speed } : {}),
  };
};

/** Verified TTS output encodings, used only when the catalog declares
 *  none. Both verified subscription TTS providers are mp3-only today. */
const verifiedOutputFormatsFor = (provider: string): ReadonlyArray<string> =>
  provider === "chatgpt"
    ? CODEX_SPEECH_OUTPUT_FORMATS
    : GROK_TTS_OUTPUT_FORMATS;

/**
 * Reject an output format the model doesn't produce.
 *
 * The accepted set is per-model catalog data
 * (`audio_support.output_formats`); the provider constant is the
 * fallback for a bootstrap that carries no card. Nothing is substituted:
 * an unsupported explicit format is named and refused, and an omitted
 * one stays omitted.
 */
const validateOutputFormat = (
  hop: { readonly provider: string; readonly modelId: string },
  requested: string | undefined,
): string | null => {
  if (requested === undefined) return null;
  const allowed =
    lookupCatalogEntry(hop.modelId)?.audio_support?.output_formats ??
    verifiedOutputFormatsFor(hop.provider);
  return allowed.includes(requested)
    ? null
    : `${hop.provider} speech only supports: ${allowed.join(", ")}.`;
};

/**
 * Reject an EXPLICIT unsupported voice rather than silently forwarding
 * or substituting one.
 *
 * The voice menu is per-model catalog data (`audio_support.voices`).
 * ABSENT means unknown, so nothing is refused — which is exactly
 * `chatgpt/pronunciation`, whose verified wire carries no voice
 * parameter at all: the field is part of the inbound OpenAI shape, is
 * simply not serialized upstream, and was never validated as "chosen".
 * A DECLARED menu (`grok/tts` → `eve`) refuses anything outside it, and
 * a declared EMPTY menu says so explicitly rather than guessing.
 */
const validateVoice = (
  hop: { readonly provider: string; readonly modelId: string },
  requested: string | undefined,
): string | null => {
  if (requested === undefined) return null;
  const declared = lookupCatalogEntry(hop.modelId)?.audio_support?.voices;
  const allowed =
    declared ?? (hop.provider === "grok" ? GROK_TTS_VOICES : undefined);
  if (allowed === undefined) return null;
  if ((allowed as ReadonlyArray<string>).includes(requested)) return null;
  return allowed.length === 0
    ? `${hop.provider} speech does not support a voice selector.`
    : `${hop.provider} speech only supports the voice: ${allowed.join(", ")}.`;
};

// Silence unused-import lint for a constant kept for documentation/reuse by
// callers that want to surface "no voices supported" explicitly.
export const CODEX_SPEECH_HAS_NO_VOICE_SELECTOR =
  CODEX_SPEECH_VOICES.length === 0;

/** Wall-clock bound on draining the persist branch of a tee'd speech
 *  response — independent of `uploadMedia`'s own upload timeout, this only
 *  guards the (non-network) read of the upstream body itself. */
const SPEECH_PERSIST_READ_TIMEOUT_MS = 60_000;

/**
 * Bounded, non-blocking tee-and-persist for generated TTS audio into the
 * cloud media library — the daemon-side counterpart of the cloud handler's
 * `streamAndPersist` (`packages/api/lib/media-store.ts`), adapted because the
 * daemon has no direct DB access (see `@packages/cli/daemon/ARCHITECTURE.md`):
 * persistence goes through the same `uploadMedia` control-plane call
 * `image-walker.ts` already uses for generated images.
 *
 * The CLIENT branch of the tee is returned untouched by the caller; this
 * function only ever sees the PERSIST branch, reads it in the background,
 * and is deliberately decoupled from the inbound request's abort signal —
 * the client closing its connection once it has the audio must not cancel
 * the library write (mirrors the cloud handler's own rationale). Bounded by
 * `TUNNEL_MEDIA_MAX_BODY_BYTES` (size) and
 * `SPEECH_PERSIST_READ_TIMEOUT_MS` (time) so a misbehaving upstream can't
 * grow memory or leak an open reader. Failures are logged and swallowed —
 * a failed background persist never fails the TTS response itself.
 */
const persistSpeechInBackground = (
  body: ReadableStream<Uint8Array>,
  contentType: string,
  origin: string | null,
): void => {
  void (async (): Promise<void> => {
    const reader = body.getReader();
    const timer = setTimeout(() => {
      void reader.cancel("persist read timed out");
    }, SPEECH_PERSIST_READ_TIMEOUT_MS);
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > TUNNEL_MEDIA_MAX_BODY_BYTES) {
          await reader.cancel("generated audio exceeds the media size limit");
          throw new Error("generated audio exceeds the media size limit");
        }
        chunks.push(value);
      }
      if (total === 0) return;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const saved = await uploadMedia(
        bytes,
        { contentType, kind: "audio" },
        origin,
      );
      if (saved === null) throw new Error("cloud rejected the media upload");
    } catch (err) {
      logWarn(
        "audio-walker",
        safeDiagnosticMessage`failed to persist generated speech audio`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      clearTimeout(timer);
    }
  })();
};

export const runAudioSpeechWalker = async (
  args: TWalkArgs,
): Promise<Response> => {
  const planErr = requirePlanned(args);
  if (planErr !== null) return planErr;

  const parsedBody = parseSpeechRequestBody(args.rawBody);
  if ("status" in parsedBody) {
    return errorJson(parsedBody.status, parsedBody.message);
  }

  const hops = listAudioHops(args);
  const attempted: string[] = [];
  const stamp = (resp: Response, resolved?: string): Response =>
    withMediaAttribution(resp, {
      attempted,
      ...(resolved !== undefined ? { resolvedModel: resolved } : {}),
    });
  let lastError: Response | null = null;
  const chars = parsedBody.input.length;

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    if (hop === undefined) continue;
    const last = i === hops.length - 1;
    if (!isSubscriptionProviderSlug(hop.provider)) {
      attempted.push(hop.modelId);
      const forwarded = await forwardMediaHopToCloud(args, hop.modelId);
      if (forwarded.ok) return stamp(forwarded, hop.modelId);
      lastError = forwarded;
      if (
        !last &&
        mediaHopAdvances({
          dispatched: true,
          httpStatus: forwarded.status,
          errorCode: mediaHttpErrorCode(forwarded.status),
          accepted: false,
        })
      ) {
        continue;
      }
      return stamp(forwarded);
    }
    const speechHook = getDelegate(hop.provider)?.credentialForSpeech;
    if (speechHook === undefined) {
      lastError = errorJson(
        404,
        `No speech credential available for ${hop.provider}`,
      );
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "missing_credential",
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    const formatError = validateOutputFormat(hop, parsedBody.responseFormat);
    const voiceError = validateVoice(hop, parsedBody.voice);
    if (formatError !== null || voiceError !== null) {
      lastError = errorJson(400, formatError ?? voiceError ?? "invalid speech");
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "model_unavailable",
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    const acquired = await acquireAudioUpstream(
      "speech",
      hop.provider,
      args,
      hop,
    );
    if (acquired === "retry") {
      lastError = errorJson(
        404,
        `No speech credential available for ${hop.provider}`,
      );
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "missing_credential",
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    attempted.push(hop.modelId);
    const startedAt = Date.now();
    const upstreamBody =
      hop.provider === "grok"
        ? JSON.stringify({
            text: parsedBody.input,
            // The caller's voice, once `validateVoice` has accepted it
            // against the model's declared menu — forwarding a DIFFERENT
            // voice than the one accepted would be the silent
            // substitution the validation exists to prevent. With no
            // voice sent, grok's single verified voice is used, which is
            // the byte-identical previous behaviour for today's card
            // (`grok/tts` declares exactly `eve`).
            voice_id: parsedBody.voice ?? GROK_TTS_VOICES[0],
            language: "en",
          })
        : JSON.stringify({
            text: parsedBody.input,
            pronunciation_language: "en-US",
            speed: parsedBody.speed ?? 1,
          });
    const resp = await postUpstream(acquired.url, {
      method: "POST",
      headers: {
        ...acquired.headers,
        "content-type": "application/json",
        accept: "audio/mpeg, application/json",
      },
      body: upstreamBody,
      signal: args.req.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const reportResult = (status: "success" | "error"): void => {
      report(
        {
          model: hop.modelId,
          provider: hop.provider,
          status,
          tokens_in: chars,
          tokens_out: 0,
          latency_ms: latencyMs,
          endpoint: args.endpoint,
          ...(acquired.accountHash !== null
            ? { account_hash: acquired.accountHash }
            : {}),
        },
        args.originParam,
      );
    };
    if (resp === null) {
      reportResult("error");
      return stamp(
        args.req.signal.aborted
          ? errorJson(499, "client aborted request")
          : errorJson(502, "upstream speech provider is unreachable"),
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      reportResult("error");
      lastError = new Response(body.length > 0 ? body : null, {
        status: resp.status,
        headers: passthroughHeaders(resp),
      });
      if (
        !last &&
        mediaHopAdvances({
          dispatched: true,
          httpStatus: resp.status,
          errorCode: mediaHttpErrorCode(resp.status),
          accepted: false,
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    reportResult("success");
    const contentType = resp.headers.get("content-type") ?? "audio/mpeg";
    const body = resp.body;
    if (body === null) {
      return stamp(
        new Response(null, {
          status: 200,
          headers: { "content-type": contentType },
        }),
        hop.modelId,
      );
    }
    if (
      args.req.headers.get(MEDIA_PERSISTENCE_REQUEST_HEADER) ===
      MEDIA_PERSISTENCE_BROWSER
    ) {
      return stamp(
        new Response(body, {
          status: 200,
          headers: {
            "content-type": contentType,
            [MEDIA_PERSISTENCE_RESPONSE_HEADER]: MEDIA_PERSISTENCE_BROWSER,
          },
        }),
        hop.modelId,
      );
    }
    const [clientBranch, persistBranch] = body.tee();
    persistSpeechInBackground(persistBranch, contentType, args.originParam);
    return stamp(
      new Response(clientBranch, {
        status: 200,
        headers: { "content-type": contentType },
      }),
      hop.modelId,
    );
  }
  return stamp(
    lastError ??
      errorJson(
        404,
        "No speech provider in the daemon plan can serve this request",
      ),
  );
};
