/** CLI-only local audio boundary. Never import this from browser-shared tools.ts. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MEDIA_AUDIO_INPUT_FORMATS,
  MEDIA_DEFAULT_CLASS,
} from "../../sdk/generated/inference-headers";
import type { TToolResult } from "../types";
import {
  handleOpenllmTool,
  MAX_TRANSCRIPTION_BYTES,
  TRANSCRIPTION_TOOL_NAME,
} from "./tools";

const CONVERSION_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 8192;

/** ffmpeg demuxers the MCP will open, always forced — never auto-probed. */
type TDemuxer = "wav" | "ogg" | "flac" | "mp3" | "matroska" | "mov";
type TAudioFormat = {
  mime: string;
  demuxer: TDemuxer;
  /** Set when an API-key upload needs WAV (historical: Ogg/FLAC/MP4). */
  convert?: "ogg" | "flac" | "mov";
};
/** What a hop can be sent: a 16 kHz mono PCM16 WAV or a WebM/Opus stream. */
type TConversionTarget = "wav16k" | "webm_opus";
type TMediaAudioInputFormat = (typeof MEDIA_AUDIO_INPUT_FORMATS)[number];
/** The `/v1/models` fields the chain walk reads. */
type TTranscriptionCard = {
  readonly id: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly default_tiers?: ReadonlyArray<string>;
  readonly tier_rank?: number;
  readonly deprecated?: boolean;
  readonly included_usage?: unknown;
  readonly audio_support?: {
    readonly input_formats?: ReadonlyArray<string>;
  };
};
const [PCM_16K, WAV_16K, WEBM_OPUS] = MEDIA_AUDIO_INPUT_FORMATS;
/** Injection is for hermetic subprocess tests, never populated from tool arguments. */
export type TAudioConversionOptions = {
  ffmpegPath?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  tempRoot?: string;
};

export const readBoundedAudio = async (
  path: string,
  maxBytes = MAX_TRANSCRIPTION_BYTES,
): Promise<Buffer> => {
  // O_NONBLOCK prevents FIFO opens from hanging before fstat can reject them.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error("Audio path must refer to a regular file.");
    if (info.size === 0) throw new Error("Audio file is empty.");
    if (info.size > maxBytes)
      throw new Error("Audio exceeds the 25 MiB limit.");
    // Never readFile: a file may grow after fstat. One extra byte detects overflow.
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > info.size)
      throw new Error(
        "Audio file changed while reading; retry with a stable file.",
      );
    if (offset === 0) throw new Error("Audio file is empty.");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
};

const formatOf = (bytes: Buffer): TAudioFormat => {
  const starts = (value: string): boolean =>
    bytes.subarray(0, value.length).toString("ascii") === value;
  if (
    bytes.length >= 44 &&
    starts("RIFF") &&
    bytes.toString("ascii", 8, 12) === "WAVE"
  ) {
    // Reject truncated or fabricated RIFF containers before any upstream call.
    if (bytes.readUInt32LE(4) + 8 > bytes.length)
      throw new Error("WAV audio is truncated.");
    let fmt = false;
    let data = false;
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const size = bytes.readUInt32LE(offset + 4);
      const end = offset + 8 + size;
      if (end > bytes.length) throw new Error("WAV audio is truncated.");
      const chunk = bytes.toString("ascii", offset, offset + 4);
      if (chunk === "fmt " && size >= 16) fmt = true;
      if (chunk === "data" && size > 0) data = true;
      offset = end + (size % 2);
    }
    if (fmt && data) return { mime: "audio/wav", demuxer: "wav" };
  }
  if (bytes.length > 27 && starts("OggS"))
    return { mime: "audio/wav", demuxer: "ogg", convert: "ogg" };
  if (bytes.length > 42 && starts("fLaC"))
    return { mime: "audio/wav", demuxer: "flac", convert: "flac" };
  // MP4/M4A (Voice Memos, many recorders): `ftyp` box at offset 4.
  if (bytes.length > 12 && bytes.toString("ascii", 4, 8) === "ftyp")
    return { mime: "audio/wav", demuxer: "mov", convert: "mov" };
  if (
    bytes.length > 10 &&
    (starts("ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2))
  )
    return { mime: "audio/mpeg", demuxer: "mp3" };
  if (
    bytes.length > 16 &&
    bytes.readUInt32BE(0) === 0x1a45dfa3 &&
    bytes.subarray(0, 4096).includes(Buffer.from("webm"))
  )
    return { mime: "audio/webm", demuxer: "matroska" };
  throw new Error(
    "Unrecognized or malformed audio. Use WAV, MP3, WebM, M4A/MP4, Ogg/Opus or FLAC; convert other formats to WAV first.",
  );
};

export const convertAudioToWav = (
  input: Buffer,
  format: "ogg" | "flac" | "mov",
  options: TAudioConversionOptions = {},
): Promise<Buffer> => convertAudio(input, format, "wav16k", options);

const ENCODE_ARGS: Record<TConversionTarget, ReadonlyArray<string>> = {
  wav16k: ["-ar", "16000", "-c:a", "pcm_s16le"],
  webm_opus: ["-ar", "48000", "-c:a", "libopus", "-b:a", "32k"],
};
const MUXER: Record<TConversionTarget, string> = {
  wav16k: "wav",
  webm_opus: "webm",
};

export const convertAudio = async (
  input: Buffer,
  demuxer: TDemuxer,
  target: TConversionTarget,
  options: TAudioConversionOptions = {},
): Promise<Buffer> => {
  const executable =
    options.ffmpegPath === undefined ? Bun.which("ffmpeg") : options.ffmpegPath;
  if (!executable)
    throw new Error(
      "Converting this audio for the selected model requires ffmpeg. Install ffmpeg and ensure it is on PATH, then retry.",
    );
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPTION_BYTES;
  const dir = await mkdtemp(
    join(options.tempRoot ?? tmpdir(), "openllm-audio-"),
  );
  try {
    await chmod(dir, 0o700);
    const output = join(dir, `audio.${MUXER[target]}`);
    const file = await open(output, "wx", 0o600);
    await file.close();
    await new Promise<void>((resolveConversion, rejectConversion): void => {
      // Forced demuxer + pipe-only INPUT protocols prohibit playlist/network/file indirection.
      // Output is a private seekable file so ffmpeg finalizes real RIFF/data sizes.
      const child = spawn(
        executable,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-protocol_whitelist",
          "pipe",
          "-f",
          demuxer,
          "-i",
          "pipe:0",
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-map_metadata",
          "-1",
          "-ac",
          "1",
          ...ENCODE_ARGS[target],
          "-threads",
          "1",
          "-fs",
          String(maxBytes + 1),
          "-f",
          MUXER[target],
          output,
        ],
        { shell: false, stdio: ["pipe", "ignore", "pipe"] },
      );
      let failure: string | undefined;
      let stderrBytes = 0;
      const fail = (message: string): void => {
        failure ??= message;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(
        () => fail("Audio conversion timed out; use a shorter recording."),
        options.timeoutMs ?? CONVERSION_TIMEOUT_MS,
      );
      child.stderr.on("data", (chunk: Buffer): void => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES)
          fail("Audio conversion failed (excessive diagnostic output).");
      });
      child.on("error", (): void => {
        failure =
          "Unable to start ffmpeg. Install ffmpeg and ensure it is executable on PATH.";
      });
      child.stdin.on("error", (): void => {
        /* Early decoder exit; close handles the sanitized error. */
      });
      child.on("close", (code): void => {
        clearTimeout(timer);
        if (failure || code !== 0)
          rejectConversion(
            new Error(
              failure ??
                "Audio conversion failed. The audio may be malformed or its codec unsupported by ffmpeg.",
            ),
          );
        else resolveConversion();
      });
      child.stdin.end(input);
    });
    const bytes = await readBoundedAudio(output, maxBytes);
    if (target === "wav16k") {
      const outputFormat = formatOf(bytes);
      if (
        outputFormat.mime !== "audio/wav" ||
        outputFormat.convert !== undefined
      )
        throw new Error("Audio conversion did not produce valid WAV audio.");
    } else if (inputFormatOf(bytes, "audio/webm") !== "webm_opus") {
      throw new Error(
        "Audio conversion did not produce valid WebM/Opus audio.",
      );
    }
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

type TUpload = { readonly mime: string; readonly bytes: Buffer };
type TSource = { readonly bytes: Buffer; readonly format: TAudioFormat };

/** Which declared encoding these bytes already are (`unknown` otherwise). */
const inputFormatOf = (bytes: Buffer, mime: string): TMediaAudioInputFormat => {
  if (mime === "audio/wav") {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32LE(offset + 4);
      if (bytes.toString("ascii", offset, offset + 4) === "fmt " && size >= 16)
        return bytes.readUInt16LE(offset + 8) === 1 &&
          bytes.readUInt16LE(offset + 10) === 1 &&
          bytes.readUInt32LE(offset + 12) === 16_000 &&
          bytes.readUInt16LE(offset + 22) === 16
          ? WAV_16K
          : "unknown";
      offset += 8 + size + (size % 2);
    }
    return "unknown";
  }
  if (mime === "audio/webm") {
    const head = bytes.subarray(0, 8192);
    if (
      head.includes(Buffer.from("A_OPUS")) ||
      head.includes(Buffer.from("OpusHead"))
    )
      return WEBM_OPUS;
  }
  return "unknown";
};

/** The media default chain order: host-included first, then `tier_rank`. */
const rankTranscriptionCards = (
  cards: ReadonlyArray<TTranscriptionCard>,
): ReadonlyArray<TTranscriptionCard> =>
  cards
    .filter(
      (card) =>
        card.default_tiers?.includes(MEDIA_DEFAULT_CLASS) === true &&
        card.deprecated !== true,
    )
    .sort(
      (a, b) =>
        (a.included_usage === undefined ? 1 : 0) -
          (b.included_usage === undefined ? 1 : 0) ||
        (a.tier_rank ?? Number.MAX_SAFE_INTEGER) -
          (b.tier_rank ?? Number.MAX_SAFE_INTEGER),
    );

/** API-key hops take almost anything; only Ogg/FLAC/MP4 are re-encoded. */
const legacyUpload = async (source: TSource): Promise<TUpload> =>
  source.format.convert === undefined
    ? { mime: source.format.mime, bytes: source.bytes }
    : {
        mime: "audio/wav",
        bytes: await convertAudioToWav(source.bytes, source.format.convert),
      };

/** The audio as a hop with these declared formats accepts it: passed
 *  through when it already matches, otherwise converted with ffmpeg. */
const uploadFor = async (
  source: TSource,
  formats: ReadonlyArray<string> | undefined,
): Promise<TUpload> => {
  if (formats === undefined || formats.length === 0)
    return legacyUpload(source);
  const current = inputFormatOf(source.bytes, source.format.mime);
  if (current !== "unknown" && formats.includes(current))
    return { mime: source.format.mime, bytes: source.bytes };
  const target: TConversionTarget | null =
    formats.includes(WAV_16K) || formats.includes(PCM_16K)
      ? "wav16k"
      : formats.includes(WEBM_OPUS)
        ? "webm_opus"
        : null;
  if (target === null)
    throw new Error(
      `cannot produce any accepted format (${formats.join(", ")})`,
    );
  return {
    mime: target === "wav16k" ? "audio/wav" : "audio/webm",
    bytes: await convertAudio(source.bytes, source.format.demuxer, target),
  };
};

const isTranscriptionCard = (value: unknown): value is TTranscriptionCard =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  Array.isArray((value as { capabilities?: unknown }).capabilities) &&
  (value as { capabilities: unknown[] }).capabilities.includes("transcription");

/** The caller's transcription cards (ranks + accepted formats), or null
 *  when the catalog can't be read. */
const transcriptionCards = async (config: {
  readonly baseUrl: string;
  readonly apiKey: string;
}): Promise<ReadonlyArray<TTranscriptionCard> | null> => {
  try {
    const res = await fetch(new URL("/v1/models", config.baseUrl), {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    return body.data.filter(isTranscriptionCard);
  } catch {
    return null;
  }
};

const resultText = (result: TToolResult): string =>
  result.content
    .map((content) => (content.type === "text" ? content.text : ""))
    .join(" ");

/** Gateway error types that are only ever raised before a provider sees
 *  the audio (no daemon/device, no credential, no candidate). */
const PRE_DISPATCH_ERROR_TYPES = new Set([
  "no_media_default",
  "subscription_requires_daemon",
  "local_requires_daemon",
  "missing_credential",
  "model_unavailable",
  "auth_error",
  "rate_limited",
  "quota_exhausted",
]);

/**
 * Whether a failed attempt was refused outright, so trying the next model
 * cannot bill the same audio twice. Auth, missing-model, unsupported-media and
 * rate-limit statuses are refusals; so is a 400/403 the gateway raised
 * pre-dispatch. Everything else — 5xx, timeouts, transport errors, other 4xx —
 * may have been accepted upstream and ends the walk.
 */
const refusedBeforeAcceptance = (text: string): boolean => {
  const match = /^HTTP (\d{3}): ([\s\S]*)$/.exec(text);
  if (match === null) return false;
  const status = Number(match[1]);
  if ([401, 404, 415, 429].includes(status)) return true;
  if (status !== 400 && status !== 403) return false;
  // The body may be followed by a " Served by …" attribution sentence.
  const body = match[2] ?? "";
  try {
    const type = (
      JSON.parse(body.slice(0, body.lastIndexOf("}") + 1)) as {
        error?: { type?: unknown };
      }
    ).error?.type;
    return typeof type === "string" && PRE_DISPATCH_ERROR_TYPES.has(type);
  } catch {
    return false;
  }
};

const sendTranscription = async (
  upload: TUpload,
  fields: { readonly model?: string; readonly language?: unknown },
  config: Parameters<typeof handleOpenllmTool>[2],
): Promise<TToolResult> => {
  const encoded = upload.bytes.toString("base64");
  const result = await handleOpenllmTool(
    TRANSCRIPTION_TOOL_NAME,
    { body: { file: `data:${upload.mime};base64,${encoded}`, ...fields } },
    config,
  );
  // Some upstream validation errors echo the request. Never send its audio back
  // into the model's context, even though the ordinary shared handler can.
  return {
    ...result,
    content: result.content.map((content) =>
      content.type === "text"
        ? {
            ...content,
            text: content.text
              .replaceAll(encoded, "[audio omitted]")
              .replace(
                /data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/g,
                "[audio omitted]",
              ),
          }
        : content,
    ),
  };
};

export const transcribeAudio = async (
  args: Record<string, unknown>,
  config: Parameters<typeof handleOpenllmTool>[2],
): Promise<TToolResult> => {
  try {
    if (
      Object.keys(args).some(
        (key) => !["path", "model", "language"].includes(key),
      ) ||
      typeof args.path !== "string" ||
      !args.path.trim() ||
      args.path.includes("\0")
    ) {
      throw new Error(
        'Use {"path":"./voice-note.ogg","model":"openai/whisper-1"} (model optional). MCP reads the local file; do not send body.file, bytes or base64.',
      );
    }
    for (const key of ["model", "language"] as const) {
      if (
        args[key] !== undefined &&
        (typeof args[key] !== "string" || !args[key].trim())
      )
        throw new Error(`${key} must be a nonempty string when supplied.`);
    }
    let bytes: Buffer;
    try {
      bytes = await readBoundedAudio(resolve(args.path));
    } catch (error) {
      if (error instanceof Error && "code" in error)
        throw new Error(
          "Cannot read audio path. Check that the local file exists, is readable, and is a regular file.",
        );
      throw error;
    }
    const source = { bytes, format: formatOf(bytes) };
    const language =
      args.language === undefined ? {} : { language: args.language };
    const model = typeof args.model === "string" ? args.model : undefined;
    const cards = await transcriptionCards(config);
    // No catalog (older gateway, network blip): let the gateway pick, the
    // historical behaviour.
    // An empty ranked chain (no media-default cards) does the same.
    if (
      cards === null ||
      (model === undefined && rankTranscriptionCards(cards).length === 0)
    )
      return await sendTranscription(
        await legacyUpload(source),
        { ...(model === undefined ? {} : { model }), ...language },
        config,
      );
    const chain: ReadonlyArray<TTranscriptionCard | { readonly id: string }> =
      model !== undefined
        ? [cards.find((card) => card.id === model) ?? { id: model }]
        : rankTranscriptionCards(cards);
    // Walk the catalog order ourselves, converting the audio to whatever
    // each hop accepts, so a format never reorders the chain.
    const uploads = new Map<string, Promise<TUpload>>();
    const failures: string[] = [];
    let last: TToolResult | null = null;
    for (const card of chain) {
      const formats =
        "audio_support" in card ? card.audio_support?.input_formats : undefined;
      const key = formats === undefined ? "legacy" : formats.join(",");
      let pending = uploads.get(key);
      if (pending === undefined) {
        pending = uploadFor(source, formats);
        uploads.set(key, pending);
      }
      let upload: TUpload;
      try {
        upload = await pending;
      } catch (error) {
        failures.push(
          `${card.id}: ${error instanceof Error && !("code" in error) ? error.message : "audio conversion failed"}`,
        );
        continue;
      }
      last = await sendTranscription(
        upload,
        { model: card.id, ...language },
        config,
      );
      if (last.isError !== true) return last;
      failures.push(`${card.id}: ${resultText(last)}`);
      // Never resend audio a model may have accepted: that bills twice.
      if (!refusedBeforeAcceptance(resultText(last))) return last;
    }
    if (failures.length === 0)
      throw new Error(
        "No transcription model is available. Connect a subscription STT provider or configure an API-key transcription provider.",
      );
    if (failures.length === 1 && last !== null) return last;
    return {
      content: [
        {
          type: "text",
          text: `Every transcription model failed:\n${failures.join("\n")}`,
        },
      ],
      isError: true,
    };
  } catch (error) {
    // Only our deliberately sanitized messages escape; filesystem errors may contain paths.
    const message =
      error instanceof Error && !("code" in error)
        ? error.message
        : "Unable to process the local audio file.";
    return { content: [{ type: "text", text: message }], isError: true };
  }
};
