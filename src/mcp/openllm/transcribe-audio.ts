/** CLI-only local audio boundary. Never import this from browser-shared tools.ts. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TToolResult } from "../types";
import {
  handleOpenllmTool,
  MAX_TRANSCRIPTION_BYTES,
  TRANSCRIPTION_TOOL_NAME,
} from "./tools";

const CONVERSION_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 8192;

type TAudioFormat = { mime: string; convert?: "ogg" | "flac" };
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
    if (fmt && data) return { mime: "audio/wav" };
  }
  if (bytes.length > 27 && starts("OggS"))
    return { mime: "audio/wav", convert: "ogg" };
  if (bytes.length > 42 && starts("fLaC"))
    return { mime: "audio/wav", convert: "flac" };
  if (
    bytes.length > 10 &&
    (starts("ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2))
  )
    return { mime: "audio/mpeg" };
  if (
    bytes.length > 16 &&
    bytes.readUInt32BE(0) === 0x1a45dfa3 &&
    bytes.subarray(0, 4096).includes(Buffer.from("webm"))
  )
    return { mime: "audio/webm" };
  throw new Error(
    "Unrecognized or malformed audio. Use WAV, MP3, WebM, Ogg/Opus or FLAC; convert other formats to WAV first.",
  );
};

export const convertAudioToWav = async (
  input: Buffer,
  format: "ogg" | "flac",
  options: TAudioConversionOptions = {},
): Promise<Buffer> => {
  const executable =
    options.ffmpegPath === undefined ? Bun.which("ffmpeg") : options.ffmpegPath;
  if (!executable)
    throw new Error(
      "Ogg/Opus and FLAC transcription requires ffmpeg. Install ffmpeg and ensure it is on PATH, then retry; WAV and MP3 do not require it.",
    );
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPTION_BYTES;
  const dir = await mkdtemp(
    join(options.tempRoot ?? tmpdir(), "openllm-audio-"),
  );
  try {
    await chmod(dir, 0o700);
    const output = join(dir, "audio.wav");
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
          format,
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
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          "-threads",
          "1",
          "-fs",
          String(maxBytes + 1),
          "-f",
          "wav",
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
    const outputFormat = formatOf(bytes);
    if (outputFormat.mime !== "audio/wav" || outputFormat.convert !== undefined)
      throw new Error("Audio conversion did not produce valid WAV audio.");
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    const format = formatOf(bytes);
    if (format.convert) bytes = await convertAudioToWav(bytes, format.convert);
    const encoded = bytes.toString("base64");
    const result = await handleOpenllmTool(
      TRANSCRIPTION_TOOL_NAME,
      {
        body: {
          file: `data:${format.mime};base64,${encoded}`,
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.language === undefined ? {} : { language: args.language }),
        },
      },
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
  } catch (error) {
    // Only our deliberately sanitized messages escape; filesystem errors may contain paths.
    const message =
      error instanceof Error && !("code" in error)
        ? error.message
        : "Unable to process the local audio file.";
    return { content: [{ type: "text", text: message }], isError: true };
  }
};
