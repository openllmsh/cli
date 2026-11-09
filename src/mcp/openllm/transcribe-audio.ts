/** CLI-only local audio boundary. Never import this from browser-shared tools.ts. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MEDIA_DEFAULT_CLASS,
  MediaAudioInputFormat,
} from "@openllmsh/sdk/protocol";
import type { TToolResult } from "../types";
import {
  LOCAL_TRANSCRIPTION_TIMEOUT_MS,
  MAX_TRANSCRIPTION_BYTES,
  TRANSCRIPTION_TIMEOUT_MS,
  uploadTranscription,
} from "./tools";

const CONVERSION_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 8192;

/** ffmpeg demuxers the MCP forces once the container is recognised by its
 *  magic bytes. `probe` is the fallback for everything else: ffmpeg picks the
 *  demuxer itself, but only from {@link PROBE_FORMATS}. */
type TDemuxer =
  | "wav"
  | "w64"
  | "ogg"
  | "flac"
  | "mp3"
  | "matroska"
  | "mov"
  | "aiff"
  | "caf"
  | "aac"
  | "amr"
  | "asf"
  | "probe";
type TAudioFormat = {
  mime: string;
  demuxer: TDemuxer;
  /** The bytes can't be uploaded as they are: every hop gets a conversion
   *  (WebM/Opus for API-key hops, the declared format for the others). */
  convert?: true;
};

/** What an unrecognised file may be probed as: audio (and audio-carrying
 *  video) FILE containers only. Never a playlist, concat list, image
 *  sequence or network demuxer (no hls, concat, image2, dash, sdp, tee,
 *  ffmetadata), and never mov — a QuickTime file is recognised by its boxes
 *  and opened with data references pinned off instead. */
const PROBE_FORMATS = [
  "wav",
  "w64",
  "ogg",
  "flac",
  "mp3",
  "matroska",
  "webm",
  "aiff",
  "iff",
  "caf",
  "aac",
  "loas",
  "amr",
  "amrnb",
  "amrwb",
  "asf",
  "xwma",
  "avi",
  "flv",
  "nut",
  "mpeg",
  "mpegts",
  "au",
  "voc",
  "sox",
  "wv",
  "ape",
  "tta",
  "mpc",
  "mpc8",
  "dsf",
  "ac3",
  "eac3",
  "dts",
  "truehd",
  "mlp",
].join(",");

const converted = (demuxer: TDemuxer): TAudioFormat => ({
  mime: "audio/wav",
  demuxer,
  convert: true,
});
/** What a hop can be sent: a 16 kHz mono PCM16 WAV or a WebM/Opus stream. */
type TConversionTarget = "wav16k" | "webm_opus";
type TMediaAudioInputFormat = (typeof MediaAudioInputFormat.literals)[number];
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
const [PCM_16K, WAV_16K, WEBM_OPUS] = MediaAudioInputFormat.literals;
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
  /** Injection is for tests of a file changing under the read. */
  openFile: typeof open = open,
): Promise<Buffer> => {
  // O_NONBLOCK prevents FIFO opens from hanging before fstat can reject them.
  const handle = await openFile(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
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

/** A RIFF/WAVE whose chunk sizes all fit and that carries `fmt ` + `data`:
 *  safe to upload unchanged. Also the check on our own converted output. */
const isWellFormedWav = (bytes: Buffer): boolean => {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 > bytes.length
  )
    return false;
  let fmt = false;
  let data = false;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > bytes.length) return false;
    const chunk = bytes.toString("ascii", offset, offset + 4);
    if (chunk === "fmt " && size >= 16) fmt = true;
    if (chunk === "data" && size > 0) data = true;
    offset = end + (size % 2);
  }
  return fmt && data;
};

/** QuickTime top-level boxes a `.mov` may open with instead of `ftyp`. */
const QUICKTIME_BOXES = new Set([
  "moov",
  "mdat",
  "wide",
  "free",
  "skip",
  "pnot",
]);
const ASF_GUID = Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex");
const W64_RIFF_GUID = Buffer.from("726966662e91cf11a5d628db04c10000", "hex");

/**
 * How to read these bytes. Never throws: a container recognised by its magic
 * bytes gets its demuxer forced; anything else is handed to ffmpeg to probe
 * among {@link PROBE_FORMATS}. Only WAV, MP3 and WebM that are already well
 * formed are uploaded unchanged.
 */
export const formatOf = (bytes: Buffer): TAudioFormat => {
  const ascii = (from: number, to: number): string =>
    bytes.toString("ascii", from, Math.min(to, bytes.length));
  // RIFF/WAVE with sizes that don't add up (a recorder that never finalised
  // its header, a streamed capture): ffmpeg reads it; re-encode it.
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE")
    return isWellFormedWav(bytes)
      ? { mime: "audio/wav", demuxer: "wav" }
      : converted("wav");
  if (ascii(0, 4) === "RF64" && ascii(8, 12) === "WAVE")
    return converted("wav");
  if (bytes.subarray(0, 16).equals(W64_RIFF_GUID)) return converted("w64");
  if (ascii(0, 4) === "OggS") return converted("ogg");
  if (ascii(0, 4) === "fLaC") return converted("flac");
  // MP4/M4A/3GP (Voice Memos, most phones): `ftyp` box at offset 4;
  // QuickTime may open with another top-level box.
  if (ascii(4, 8) === "ftyp" || QUICKTIME_BOXES.has(ascii(4, 8)))
    return converted("mov");
  if (ascii(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(8, 12)))
    return converted("aiff");
  if (ascii(0, 4) === "caff") return converted("caf");
  if (ascii(0, 5) === "#!AMR") return converted("amr");
  if (bytes.subarray(0, 16).equals(ASF_GUID)) return converted("asf");
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3)
    return bytes.subarray(0, 4096).includes(Buffer.from("webm"))
      ? { mime: "audio/webm", demuxer: "matroska" }
      : converted("matroska");
  // Raw AAC (ADTS): 12-bit sync, layer 00. Checked before MP3, whose sync
  // word it shares the first byte of.
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0)
    return converted("aac");
  if (
    ascii(0, 3) === "ID3" ||
    (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2)
  )
    return { mime: "audio/mpeg", demuxer: "mp3" };
  return converted("probe");
};

export const convertAudioToWav = (
  input: Buffer,
  format: TDemuxer,
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

const ffmpegExecutable = (options: TAudioConversionOptions): string => {
  const executable =
    options.ffmpegPath === undefined
      ? // Read PATH now: Bun.which alone keeps the PATH the process started with.
        Bun.which("ffmpeg", { PATH: process.env.PATH ?? "" })
      : options.ffmpegPath;
  if (!executable)
    throw new Error(
      "Converting this audio for the selected model requires ffmpeg. Install ffmpeg and ensure it is on PATH, then retry.",
    );
  return executable;
};

/** Runs `fn` with the input written to a private (0700 dir, 0600 file) temp
 *  file. ffmpeg reads a FILE, not a pipe: an M4A whose `moov` index follows
 *  the audio (Apple Notes, Voice Memos) can only be read by seeking. */
const withPrivateInput = async <T>(
  input: Buffer,
  options: TAudioConversionOptions,
  fn: (dir: string, inputPath: string) => Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(
    join(options.tempRoot ?? tmpdir(), "openllm-audio-"),
  );
  try {
    await chmod(dir, 0o700);
    const inputPath = join(dir, "input");
    await writeFile(inputPath, input, { flag: "wx", mode: 0o600 });
    return await fn(dir, inputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** File-only protocol and a forced (or whitelisted) demuxer: no playlist,
 *  network or concat indirection. `file` would let a container reference
 *  OTHER local files; of the demuxers allowed only mov can (data
 *  references), so they are pinned off, and ffmpeg runs in the private dir
 *  so nothing resolves relative to the caller's cwd. */
const inputArgs = (demuxer: TDemuxer, inputPath: string): string[] => [
  "-hide_banner",
  "-nostdin",
  "-protocol_whitelist",
  "file",
  ...(demuxer === "mov" ? ["-enable_drefs", "0"] : []),
  ...(demuxer === "probe"
    ? ["-format_whitelist", PROBE_FORMATS]
    : ["-f", demuxer]),
  "-i",
  inputPath,
];

type TFfmpegRun = { readonly code: number | null; readonly stderr: string };

const runFfmpeg = (
  executable: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  maxStderrBytes: number,
  cwd: string,
): Promise<TFfmpegRun> =>
  new Promise<TFfmpegRun>((resolveRun, rejectRun): void => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let failure: string | undefined;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const fail = (message: string): void => {
      failure ??= message;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => fail("Audio conversion timed out; use a shorter recording."),
      timeoutMs,
    );
    child.stderr.on("data", (chunk: Buffer): void => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes)
        fail("Audio conversion failed (excessive diagnostic output).");
      else stderr.push(chunk);
    });
    child.on("error", (): void => {
      failure =
        "Unable to start ffmpeg. Install ffmpeg and ensure it is executable on PATH.";
    });
    child.on("close", (code): void => {
      clearTimeout(timer);
      if (failure) rejectRun(new Error(failure));
      else resolveRun({ code, stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });

/** A conversion failure is its own error, never the format error: the file
 *  was recognised, ffmpeg just couldn't decode it. */
const CONVERSION_FAILED =
  "Audio conversion failed: ffmpeg found no decodable audio in this file (it may not contain audio, may be damaged, or may use a codec this ffmpeg build lacks).";

/** This ffmpeg build lacks the encoder for `target` (e.g. no libopus). */
/** ffmpeg couldn't decode the input: a property of the file, so no other
 *  model or target format will do better. */
class UndecodableAudioError extends Error {
  constructor() {
    super(CONVERSION_FAILED);
  }
}

class MissingEncoderError extends Error {
  constructor(target: TConversionTarget) {
    super(
      `This ffmpeg build has no ${target === "webm_opus" ? "Opus (libopus)" : "PCM"} encoder; install an ffmpeg with it, then retry.`,
    );
  }
}

const encodeArgs = (target: TConversionTarget): string[] => [
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
];

const checkConverted = (bytes: Buffer, target: TConversionTarget): void => {
  if (target === "wav16k") {
    if (!isWellFormedWav(bytes))
      throw new Error("Audio conversion did not produce valid WAV audio.");
  } else if (inputFormatOf(bytes, "audio/webm") !== "webm_opus") {
    throw new Error("Audio conversion did not produce valid WebM/Opus audio.");
  }
};

export const convertAudio = async (
  input: Buffer,
  demuxer: TDemuxer,
  target: TConversionTarget,
  options: TAudioConversionOptions = {},
): Promise<Buffer> => {
  const executable = ffmpegExecutable(options);
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPTION_BYTES;
  return withPrivateInput(input, options, async (dir, inputPath) => {
    // Output is a private seekable file so ffmpeg finalizes real RIFF/data sizes.
    const output = join(dir, `audio.${MUXER[target]}`);
    const file = await open(output, "wx", 0o600);
    await file.close();
    const run = await runFfmpeg(
      executable,
      [
        ...inputArgs(demuxer, inputPath),
        "-loglevel",
        "error",
        "-y",
        ...encodeArgs(target),
        "-fs",
        String(maxBytes + 1),
        "-f",
        MUXER[target],
        output,
      ],
      options.timeoutMs ?? CONVERSION_TIMEOUT_MS,
      MAX_STDERR_BYTES,
      dir,
    );
    if (run.code !== 0)
      throw /Encoder not found|Unknown encoder/.test(run.stderr)
        ? new MissingEncoderError(target)
        : new UndecodableAudioError();
    const bytes = await readBoundedAudio(output, maxBytes);
    checkConverted(bytes, target);
    return bytes;
  });
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

/** Largest upload sent unchanged to a hop that declares no formats. The
 *  cloud gateway runs on Vercel, which refuses request bodies over 4.5 MB
 *  (413) before the function starts. */
export const MAX_DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;

/** API-key hops take WAV, MP3 and WebM as they are; everything else, and
 *  anything over {@link MAX_DIRECT_UPLOAD_BYTES}, is re-encoded, to
 *  WebM/Opus rather than WAV: 5 minutes of 16 kHz WAV is ~10 MB, the same
 *  audio as WebM/Opus ~1.2 MB. */
const legacyUpload = async (source: TSource): Promise<TUpload> => {
  if (
    source.format.convert === undefined &&
    source.bytes.length <= MAX_DIRECT_UPLOAD_BYTES
  )
    return { mime: source.format.mime, bytes: source.bytes };
  try {
    return {
      mime: MIME_OF.webm_opus,
      bytes: await convertAudio(
        source.bytes,
        source.format.demuxer,
        "webm_opus",
      ),
    };
  } catch (error) {
    // An ffmpeg built without libopus still decodes; send WAV instead.
    // Any other failure is the audio's, and WAV would fail the same way.
    if (!(error instanceof MissingEncoderError)) throw error;
    return {
      mime: MIME_OF.wav16k,
      bytes: await convertAudio(source.bytes, source.format.demuxer, "wav16k"),
    };
  }
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
  const target = conversionTargetFor(formats);
  return {
    mime: MIME_OF[target],
    bytes: await convertAudio(source.bytes, source.format.demuxer, target),
  };
};

const MIME_OF: Record<TConversionTarget, string> = {
  wav16k: "audio/wav",
  webm_opus: "audio/webm",
};

/** What to convert to for a hop with these declared formats (a hop that
 *  declares none goes through {@link legacyUpload}). */
const conversionTargetFor = (
  formats: ReadonlyArray<string>,
): TConversionTarget => {
  if (formats.includes(WAV_16K) || formats.includes(PCM_16K)) return "wav16k";
  if (formats.includes(WEBM_OPUS)) return "webm_opus";
  throw new Error(`cannot produce any accepted format (${formats.join(", ")})`);
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
  // 413: the platform refused the body before the function ran (Vercel caps
  // request bodies at 4.5 MB, so a long 16 kHz WAV for one hop never lands
  // while the same audio as WebM/Opus for the next hop does).
  if ([401, 404, 413, 415, 429].includes(status)) return true;
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

const EXTENSION_OF: Record<string, string> = {
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/webm": "webm",
};

/** Where one upload goes; `local` when that is this machine's daemon,
 *  which has no function time limit. */
type TUploadConfig = Parameters<typeof uploadTranscription>[1] & {
  readonly local?: boolean;
};

const sendTranscription = async (
  upload: TUpload,
  fields: { readonly model?: string; readonly language?: string },
  config: TUploadConfig,
): Promise<TToolResult> => {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(upload.bytes)], { type: upload.mime }),
    `audio.${EXTENSION_OF[upload.mime] ?? "bin"}`,
  );
  if (fields.model !== undefined) form.set("model", fields.model);
  if (fields.language !== undefined) form.set("language", fields.language);
  return redactAudio(
    await uploadTranscription(
      form,
      config,
      config.local ? LOCAL_TRANSCRIPTION_TIMEOUT_MS : TRANSCRIPTION_TIMEOUT_MS,
    ),
  );
};

/** Some upstream validation errors echo a data URL. Never send audio back
 *  into the model's context (the multipart upload itself carries none). */
export const redactAudio = (result: TToolResult): TToolResult => ({
  ...result,
  content: result.content.map((content) =>
    content.type === "text"
      ? {
          ...content,
          text: content.text.replace(
            /data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/g,
            "[audio omitted]",
          ),
        }
      : content,
  ),
});

export type TTranscribeOptions = {
  /** Where the audio is uploaded (the local daemon when it answers); the
   *  catalog is always read from `config.baseUrl`. Defaults to it. */
  readonly uploadBase?: () => Promise<string>;
};

export const transcribeAudio = async (
  args: Record<string, unknown>,
  config: Parameters<typeof uploadTranscription>[1],
  options: TTranscribeOptions = {},
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
      typeof args.language === "string" ? { language: args.language } : {};
    const model = typeof args.model === "string" ? args.model : undefined;
    const cards = await transcriptionCards(config);
    const uploadBase = await options.uploadBase?.().catch(() => undefined);
    const uploadConfig: TUploadConfig = {
      ...config,
      baseUrl: uploadBase ?? config.baseUrl,
      local: uploadBase !== undefined && uploadBase !== config.baseUrl,
    };
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
        uploadConfig,
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
        // The file itself can't be decoded: say so once, not per model.
        if (error instanceof UndecodableAudioError) throw error;
        failures.push(
          `${card.id}: ${error instanceof Error && !("code" in error) ? error.message : "audio conversion failed"}`,
        );
        continue;
      }
      last = await sendTranscription(
        upload,
        { model: card.id, ...language },
        uploadConfig,
      );
      if (last.isError !== true) return last;
      failures.push(`${card.id}: ${resultText(last)}`);
      // Never resend audio a model may have accepted: that bills twice.
      if (!refusedBeforeAcceptance(resultText(last))) return last;
    }
    // The chain is never empty here (an empty ranked chain took the legacy
    // path above), so there is always at least one failure to report.
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
