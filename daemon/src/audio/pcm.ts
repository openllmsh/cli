/**
 * Bounded WAV / raw-PCM parsing for Claude's dictation WebSocket, which
 * accepts mono signed 16-bit little-endian PCM at 16kHz on the wire
 * (`CLAUDE_DICTATION_INPUT_FORMATS`: `pcm_s16le_16khz_mono` /
 * `wav_pcm16_16khz_mono` — see `@openllmsh/protocol/audio`). No ffmpeg, no
 * `@openllm/core` import — pure byte-level parsing so the coreless daemon
 * stays coreless. An input that isn't one of those two exact shapes is
 * rejected explicitly (415) rather than resampled or guessed at.
 */

export const PCM_S16LE_16K_MONO_BYTES_PER_SECOND = 16_000 * 2 * 1;

export type TPcmAudio = {
  readonly pcm: Uint8Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
};

export type TPcmParseFailure = { readonly error: string };
export type TPcmParseResult = TPcmAudio | TPcmParseFailure;

export const isPcmParseFailure = (
  value: TPcmParseResult,
): value is TPcmParseFailure =>
  Object.hasOwn(value as object, "error") &&
  !Object.hasOwn(value as object, "pcm");

/** RIFF/WAVE magic sniff — cheap, no allocation beyond the view. */
export const looksLikeWav = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 &&
  bytes[0] === 0x52 && // 'R'
  bytes[1] === 0x49 && // 'I'
  bytes[2] === 0x46 && // 'F'
  bytes[3] === 0x46 && // 'F'
  bytes[8] === 0x57 && // 'W'
  bytes[9] === 0x41 && // 'A'
  bytes[10] === 0x56 && // 'V'
  bytes[11] === 0x45; // 'E'

const asciiAt = (view: DataView, offset: number, len: number): string => {
  let out = "";
  for (let i = 0; i < len; i++)
    out += String.fromCharCode(view.getUint8(offset + i));
  return out;
};

/**
 * Parse a canonical (or chunk-extended) PCM WAV container down to its raw
 * `data` chunk bytes + declared format. Walks chunks rather than assuming
 * the classic 44-byte header, so an `LIST`/`fact`/`JUNK` chunk before `data`
 * doesn't misparse. Bounded by the input's own length — never reads past it.
 */
export const parseWavContainer = (bytes: Uint8Array): TPcmParseResult => {
  if (!looksLikeWav(bytes)) {
    return { error: "not a RIFF/WAVE container" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12; // past "RIFF"<size>"WAVE"
  let formatTag: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataStart: number | null = null;
  let dataLen: number | null = null;

  while (offset + 8 <= bytes.length) {
    const chunkId = asciiAt(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (chunkId === "fmt ") {
      if (bodyStart + 16 > bytes.length) {
        return { error: "truncated fmt chunk" };
      }
      formatTag = view.getUint16(bodyStart, true);
      channels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      bitsPerSample = view.getUint16(bodyStart + 14, true);
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      // Clamp to the actual buffer — some encoders write a streaming
      // placeholder size (0xFFFFFFFF) for a `data` chunk with no trailing
      // chunks; never trust a declared size past what we actually have.
      dataLen = Math.min(chunkSize, bytes.length - bodyStart);
      break; // `data` is conventionally last; stop once we have it + fmt.
    }
    // Chunks are word-aligned (padded to an even byte count).
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (
    formatTag === null ||
    channels === null ||
    sampleRate === null ||
    bitsPerSample === null
  ) {
    return { error: "missing fmt chunk" };
  }
  if (dataStart === null || dataLen === null) {
    return { error: "missing data chunk" };
  }
  // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (still PCM in the sub-format
  // for the mono/16-bit shape we accept — but we don't parse the extension
  // GUID, so require the plain tag to stay conservative).
  if (formatTag !== 1) {
    return { error: `unsupported WAV format tag ${formatTag} (PCM required)` };
  }
  return {
    pcm: bytes.subarray(dataStart, dataStart + dataLen),
    sampleRate,
    channels,
    bitsPerSample,
  };
};

/**
 * Validate + extract mono 16-bit 16kHz PCM from either a WAV container or
 * already-raw `pcm_s16le_16khz_mono` bytes. `declaredFormat` (from a
 * multipart field or catalog format tag) picks which shape to expect when
 * given; omitted, the bytes are sniffed (WAV magic vs raw).
 */
export const extractClaudeDictationPcm = (
  bytes: Uint8Array,
  declaredFormat?: string,
): TPcmParseResult => {
  const wantsWav =
    declaredFormat === "wav_pcm16_16khz_mono" ||
    (declaredFormat === undefined && looksLikeWav(bytes));
  if (wantsWav) {
    const parsed = parseWavContainer(bytes);
    if (isPcmParseFailure(parsed)) return parsed;
    if (parsed.channels !== 1) {
      return { error: `expected mono audio, got ${parsed.channels} channels` };
    }
    if (parsed.bitsPerSample !== 16) {
      return { error: `expected 16-bit PCM, got ${parsed.bitsPerSample}-bit` };
    }
    if (parsed.sampleRate !== 16_000) {
      return {
        error: `expected 16kHz sample rate, got ${parsed.sampleRate}Hz`,
      };
    }
    // Same shape guards the raw branch below applies — a WAV `data` chunk
    // is just as capable of arriving empty (a zero-length recording) or
    // byte-misaligned for 16-bit samples (a truncated/corrupt encoder) as a
    // headerless raw payload is, and neither was checked here before.
    if (parsed.pcm.length === 0) {
      return { error: "empty audio payload" };
    }
    if (parsed.pcm.length % 2 !== 0) {
      return { error: "WAV PCM data has an odd byte length" };
    }
    return parsed;
  }
  // Raw `pcm_s16le_16khz_mono`: no header, so we can only validate shape
  // (even byte length — 16-bit samples) and non-emptiness; the caller is
  // trusted on rate/channels the same way the catalog format tag trusts it.
  if (bytes.length === 0) {
    return { error: "empty audio payload" };
  }
  if (bytes.length % 2 !== 0) {
    return { error: "raw PCM16 payload has an odd byte length" };
  }
  return { pcm: bytes, sampleRate: 16_000, channels: 1, bitsPerSample: 16 };
};

/** Split PCM bytes into fixed-duration frames (default 100ms @ 16kHz mono
 *  16-bit = 3200 bytes), matching the near-real-time cadence the verified
 *  dictation recipe used. The last frame may be shorter. */
export const framePcm = (
  pcm: Uint8Array,
  frameMs = 100,
  bytesPerSecond = PCM_S16LE_16K_MONO_BYTES_PER_SECOND,
): ReadonlyArray<Uint8Array> => {
  const frameBytes = Math.max(
    2,
    Math.floor((bytesPerSecond * frameMs) / 1000 / 2) * 2, // keep 16-bit aligned
  );
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    frames.push(
      pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length)),
    );
  }
  return frames;
};
