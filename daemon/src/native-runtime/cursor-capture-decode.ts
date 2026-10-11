/**
 * Cursor AgentService Connect → canonical chat-chunk decoder.
 *
 * Wire facts are taken from the local `@anysphere/agent-cli-runtime`
 * snapshot `2026.07.23-e383d2b` (bundled `@connectrpc/connect-node@1.6.1` +
 * generated `agent.v1` protobuf). This module does NOT import Cursor's
 * runtime and does NOT spawn `cursor-agent`.
 *
 * ## Service shape (artifact)
 *
 * `agent.v1.AgentService`:
 *   - `Run`     — BiDiStreaming (`AgentClientMessage` ↔ `AgentServerMessage`)
 *   - `RunSSE`  — ServerStreaming (HTTP/1 remap of Run; request is often only
 *                 `aiserver.v1.BidiRequestId`, with `AgentClientMessage` bytes
 *                 appended via `aiserver.v1.BidiService/BidiAppend`)
 *   - `RunPoll` — ServerStreaming (poll wrapper; not the primary ACP path)
 *
 * Response messages of interest are `AgentServerMessage.interaction_update`
 * (`text_delta`, `thinking_delta`, MCP `partial_tool_call` /
 * `tool_call_started`, `token_delta`). `exec_server_message` /
 * `interaction_query` require client→server duplex follow-ups — decode
 * refuses those rather than silently pretending a unary POST completed the
 * turn.
 *
 * ## Activation
 *
 * Capability / serve still omit `bridge-capture` for cursor. Integrators must
 * flip the capability table only after wiring this decoder + duplex policy.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import type { TChatCompletionChunk } from "@openllmsh/protocol";

/** Connect envelope flag: payload is end-stream JSON (trailers / error). */
export const CONNECT_FLAG_END_STREAM = 0x02;
/**
 * Connect envelope flag: payload is compressed with the algorithm named by
 * the stream's `connect-content-encoding` header (per-message; typically gzip).
 * @see https://connectrpc.com/docs/protocol/
 */
export const CONNECT_FLAG_COMPRESSED = 0x01;

/** Hard cap on a single decompressed Connect envelope payload. */
export const CONNECT_COMPRESS_MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

export const CURSOR_BIDI_APPEND_PATH_RE =
  /\/aiserver\.v1\.BidiService\/BidiAppend(?:\?|$)/;

export type TCursorAgentServiceMethod = "Run" | "RunSSE" | "RunPoll";

export type TCursorConnectEnvelope = {
  readonly flags: number;
  readonly payload: Uint8Array;
  readonly endStream: boolean;
  readonly compressed: boolean;
};

export type TCursorDecodeFailureCode =
  | "compressed_envelope_unsupported"
  | "connect_compression_invalid"
  | "connect_compression_too_large"
  | "truncated_connect_frame"
  | "connect_end_stream_error"
  | "requires_duplex_bridge"
  /** Server asked for RequestContextArgs — BiDi reply required; no fabricated context. */
  | "requires_request_context_duplex"
  | "unsupported_native_tool_intent"
  /** ExecServerMessage native/filesystem/shell (or similar) — never execute. */
  | "unsupported_native_exec"
  /** ExecServerMessage mcp_args surfaced as caller tool_calls; do not execute locally. */
  | "caller_mcp_tool_cancel"
  /** Server asked for KvServerMessage get/set — BiDi reply required; never fabricate a cache miss/write ack. */
  | "requires_kv_control_duplex"
  /** KvServerMessage subtype we don't relay (tracing/unknown), or a KvClientMessage reply that doesn't match the pending request (wrong id/type). */
  | "unsupported_native_kv"
  /** Server asked for McpStateExecArgs — BiDi reply required; never fabricate a servers/tools state reply. */
  | "requires_mcp_state_exec_duplex"
  | "invalid_protobuf";

export type TCursorExecClass =
  | "protocol_control"
  | "caller_mcp_tool"
  | "native_exec"
  | "unknown";

export class CursorCaptureDecodeError extends Error {
  readonly code: TCursorDecodeFailureCode;
  /** ExecServerMessage oneof case / interaction_query case — never args content. */
  readonly execSubtype: string | null;
  readonly execClass: TCursorExecClass | null;
  constructor(
    code: TCursorDecodeFailureCode,
    message: string,
    opts?: {
      readonly execSubtype?: string | null;
      readonly execClass?: TCursorExecClass | null;
    },
  ) {
    super(message);
    this.name = "CursorCaptureDecodeError";
    this.code = code;
    this.execSubtype = opts?.execSubtype ?? null;
    this.execClass = opts?.execClass ?? null;
  }
}

/**
 * Proven surface vs remaining blockers for Cursor Connect decode / duplex.
 */
export const CURSOR_CAPTURE_DECODE_STATUS = {
  interactionUpdateDecode: "proven_hermetic" as const,
  http1RunSseRequestCompleteness: "transaction_adapter" as const,
  /**
   * ExecServerMessage oneof subtypes are classified (protocol vs MCP vs native).
   * Native exec is rejected; MCP maps to caller tool_calls then cancel.
   * `request_context_args` is a real pre-inference BiDi control — not implemented
   * as a fabricated RequestContextSuccess (would invent workspace context).
   */
  duplexExecBridge: "subtype_classified_fail_closed" as const,
  /**
   * Pre-inference `request_context_args` is forwarded to the live builder; its
   * native RequestContextResult is intercepted and sent upstream unchanged.
   */
  requestContextDuplex: "builder_forward_allowlisted" as const,
  capabilityFlip: "serve_wired" as const,
} as const;

export type TCursorMcpToolIntent = {
  readonly callId: string;
  readonly name: string;
  readonly argumentsText: string;
  readonly providerIdentifier: string | null;
  readonly serverIdentifier: string | null;
};

export type TCursorDecodedInteraction =
  | { readonly kind: "text_delta"; readonly text: string }
  | { readonly kind: "thinking_delta"; readonly text: string }
  | {
      readonly kind: "mcp_tool_partial";
      readonly intent: TCursorMcpToolIntent;
      readonly argsTextDelta: string;
    }
  | {
      readonly kind: "mcp_tool_started";
      readonly intent: TCursorMcpToolIntent;
    }
  | { readonly kind: "token_delta"; readonly tokens: number }
  | { readonly kind: "heartbeat" }
  | {
      readonly kind: "turn_ended";
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cacheReadTokens: number | null;
      readonly cacheWriteTokens: number | null;
      readonly reasoningTokens: number | null;
    }
  | {
      readonly kind: "requires_duplex";
      readonly messageCase: string;
      readonly execSubtype: string | null;
      readonly execClass: TCursorExecClass | null;
      /** Bounded field-tag metadata (never payload) — see {@link describeProtoFieldTags}. */
      readonly tags: string;
    }
  | {
      readonly kind: "exec_server";
      readonly classification: TCursorExecClass;
      readonly subtype: string;
      readonly id: number | null;
      readonly execId: string | null;
      readonly mcp: TCursorMcpToolIntent | null;
    }
  | {
      readonly kind: "native_tool";
      readonly toolCase: string;
      readonly callId: string;
    }
  | {
      readonly kind: "kv_server";
      readonly subtype: "get_blob" | "set_blob" | "tracing" | "unknown";
      /** Proto3 implicit-presence uint32 — 0 is a real id, never "absent". */
      readonly id: number;
      /** Lengths only — never the blob id/data bytes themselves. */
      readonly blobIdLength: number | null;
      readonly blobDataLength: number | null;
    }
  | { readonly kind: "ignored"; readonly reason: string };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const cursorAgentServiceMethodOfPath = (
  pathWithQuery: string,
): TCursorAgentServiceMethod | null => {
  const m = pathWithQuery.match(
    /\/agent\.v1\.AgentService\/(Run|RunSSE|RunPoll)(?:\?|$)/,
  );
  if (m === null || m[1] === undefined) return null;
  return m[1] as TCursorAgentServiceMethod;
};

export const isCursorBidiAppendPath = (pathWithQuery: string): boolean =>
  CURSOR_BIDI_APPEND_PATH_RE.test(pathWithQuery);

/** Encode one Connect envelope (uncompressed unless flags include COMPRESSED). */
export const encodeConnectEnvelope = (
  payload: Uint8Array,
  flags = 0,
): Uint8Array => {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = flags & 0xff;
  const len = payload.byteLength;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payload, 5);
  return out;
};

/**
 * Normalize a `connect-content-encoding` header value. Returns null for
 * missing/identity; throws for unsupported algorithms when required.
 */
export const normalizeConnectContentEncoding = (
  raw: string | null | undefined,
): "gzip" | null => {
  if (raw === undefined || raw === null) return null;
  const enc = raw.trim().toLowerCase();
  if (enc.length === 0 || enc === "identity") return null;
  // Streaming may list multiple; honor the first token.
  const first = enc.split(",", 1)[0]?.trim() ?? enc;
  if (first === "gzip" || first === "x-gzip") return "gzip";
  throw new CursorCaptureDecodeError(
    "compressed_envelope_unsupported",
    `unsupported connect-content-encoding ${JSON.stringify(first)} (only gzip is negotiated)`,
  );
};

/**
 * Decompress a single Connect envelope payload. Does not mutate `payload`.
 * Bounded by {@link CONNECT_COMPRESS_MAX_DECOMPRESSED_BYTES}.
 */
export const decompressConnectEnvelopePayload = (
  payload: Uint8Array,
  encoding: string,
  maxBytes: number = CONNECT_COMPRESS_MAX_DECOMPRESSED_BYTES,
): Uint8Array => {
  const normalized = normalizeConnectContentEncoding(encoding);
  if (normalized === null) {
    throw new CursorCaptureDecodeError(
      "connect_compression_invalid",
      "Connect envelope COMPRESSED flag set but connect-content-encoding is missing/identity",
    );
  }
  if (normalized !== "gzip") {
    throw new CursorCaptureDecodeError(
      "compressed_envelope_unsupported",
      `unsupported connect compression ${normalized}`,
    );
  }
  let inflated: Buffer;
  try {
    // Copy into a fresh Buffer — gunzipSync rejects SharedArrayBuffer views
    // from some stream paths without an explicit copy.
    inflated = gunzipSync(Buffer.from(payload), { maxOutputLength: maxBytes });
  } catch (err) {
    if (err instanceof RangeError) {
      throw new CursorCaptureDecodeError(
        "connect_compression_too_large",
        `decompressed Connect envelope exceeds ${maxBytes} bytes`,
      );
    }
    throw new CursorCaptureDecodeError(
      "connect_compression_invalid",
      `gzip decompress failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (inflated.byteLength > maxBytes) {
    throw new CursorCaptureDecodeError(
      "connect_compression_too_large",
      `decompressed Connect envelope exceeds ${maxBytes} bytes`,
    );
  }
  return new Uint8Array(inflated);
};

/**
 * Return the protobuf/JSON bytes to inspect for an envelope. If compressed,
 * returns a decompressed COPY — the original envelope payload is unchanged.
 * End-stream envelopes are never compressed in practice; still honor the flag.
 */
export const resolveConnectEnvelopePayload = (
  env: TCursorConnectEnvelope,
  connectContentEncoding: string | null | undefined,
): Uint8Array => {
  if (!env.compressed) return env.payload;
  if (
    connectContentEncoding === undefined ||
    connectContentEncoding === null ||
    connectContentEncoding.trim().length === 0
  ) {
    throw new CursorCaptureDecodeError(
      "connect_compression_invalid",
      "compressed Connect envelope without connect-content-encoding",
    );
  }
  return decompressConnectEnvelopePayload(env.payload, connectContentEncoding);
};

/** Hermetic fixture: gzip-compress payload and set COMPRESSED flag. */
export const encodeConnectEnvelopeGzip = (payload: Uint8Array): Uint8Array => {
  const compressed = gzipSync(Buffer.from(payload));
  return encodeConnectEnvelope(
    new Uint8Array(compressed),
    CONNECT_FLAG_COMPRESSED,
  );
};

export const encodeConnectEndStream = (
  body: Readonly<Record<string, unknown>> = {},
): Uint8Array =>
  encodeConnectEnvelope(
    textEncoder.encode(JSON.stringify(body)),
    CONNECT_FLAG_END_STREAM,
  );

/**
 * Pull complete Connect envelopes from a byte buffer. Returns parsed envelopes
 * and the unconsumed tail (partial frame).
 */
const takeConnectEnvelopesImpl = (
  buffer: Uint8Array,
  opts: { readonly strict: boolean },
): {
  readonly envelopes: ReadonlyArray<TCursorConnectEnvelope>;
  readonly rest: Uint8Array;
} => {
  const envelopes: TCursorConnectEnvelope[] = [];
  let offset = 0;
  while (offset + 5 <= buffer.byteLength) {
    const flags = buffer[offset] ?? 0;
    // CodeRabbit round 2: `<<` coerces to a SIGNED 32-bit int, so a claimed
    // length with the top bit set (>= 0x80000000) previously came out
    // negative — `offset + 5 + length > buffer.byteLength` could then pass
    // spuriously with a negative length, `buffer.subarray` would get an end
    // index before its start (empty/garbage payload), and `offset += 5 +
    // length` could move offset BACKWARD, risking an infinite loop over a
    // hostile/corrupt stream. `>>> 0` forces the unsigned 32-bit
    // reassembly Connect actually specifies.
    const length =
      (((buffer[offset + 1] ?? 0) << 24) |
        ((buffer[offset + 2] ?? 0) << 16) |
        ((buffer[offset + 3] ?? 0) << 8) |
        (buffer[offset + 4] ?? 0)) >>>
      0;
    // Bound the claimed length against the same cap already enforced on
    // decompressed envelope payloads (reused, not duplicated). Two modes:
    //   - lenient (default, `takeConnectEnvelopes`): this function is
    //     documented to never throw — some callers (e.g.
    //     `decodeCapturedBidiAppendBody`) buffer a companion best-effort
    //     even when its bytes are malformed — so an over-cap claim is
    //     treated as an incomplete frame: the loop stops and the bytes are
    //     returned as `rest` for the caller to decide.
    //   - strict (`takeConnectEnvelopesStrict`): live model/control stream
    //     readers reassemble `pending = pending + newChunk` across repeated
    //     network reads waiting for a declared length to complete. Treating
    //     an absurd declared length as merely "incomplete" here means that
    //     buffer grows without bound for as long as the sender keeps
    //     sending anything (or forever if it sends nothing) — the exact
    //     regression CodeRabbit flagged: "oversized length not fully fixed
    //     by returning incomplete; live stream would retain/grow buffer
    //     forever". Strict mode rejects the instant the 5-byte header
    //     itself is visible, before any body bytes are required or
    //     accumulated further.
    if (length > CONNECT_COMPRESS_MAX_DECOMPRESSED_BYTES) {
      if (opts.strict) {
        throw new CursorCaptureDecodeError(
          "truncated_connect_frame",
          `Connect envelope declares length ${length} exceeding ${CONNECT_COMPRESS_MAX_DECOMPRESSED_BYTES} bytes`,
        );
      }
      break;
    }
    if (offset + 5 + length > buffer.byteLength) break;
    const payload = buffer.subarray(offset + 5, offset + 5 + length);
    envelopes.push({
      flags,
      payload,
      endStream: (flags & CONNECT_FLAG_END_STREAM) !== 0,
      compressed: (flags & CONNECT_FLAG_COMPRESSED) !== 0,
    });
    offset += 5 + length;
  }
  return {
    envelopes,
    rest: offset === 0 ? buffer : buffer.subarray(offset),
  };
};

export const takeConnectEnvelopes = (
  buffer: Uint8Array,
): {
  readonly envelopes: ReadonlyArray<TCursorConnectEnvelope>;
  readonly rest: Uint8Array;
} => takeConnectEnvelopesImpl(buffer, { strict: false });

/**
 * Same framing as {@link takeConnectEnvelopes}, but rejects an oversized
 * declared envelope length IMMEDIATELY once its 5-byte header is visible —
 * before waiting for (or accumulating) any more body bytes. Use this for
 * live model/control stream readers that reassemble a growing buffer across
 * repeated network reads; use the lenient default for a single
 * already-fully-received body where best-effort partial decode is wanted.
 */
export const takeConnectEnvelopesStrict = (
  buffer: Uint8Array,
): {
  readonly envelopes: ReadonlyArray<TCursorConnectEnvelope>;
  readonly rest: Uint8Array;
} => takeConnectEnvelopesImpl(buffer, { strict: true });

// ── Minimal protobuf helpers (encode + decode) ─────────────────────────────

const writeVarint = (value: number, out: number[]): void => {
  let n = value >>> 0;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
};

const encodeKey = (field: number, wire: number, out: number[]): void => {
  writeVarint((field << 3) | wire, out);
};

export const encodeProtoString = (field: number, value: string): Uint8Array => {
  const bytes = textEncoder.encode(value);
  const out: number[] = [];
  encodeKey(field, 2, out);
  writeVarint(bytes.byteLength, out);
  for (const b of bytes) out.push(b);
  return Uint8Array.from(out);
};

export const encodeProtoBytes = (
  field: number,
  value: Uint8Array,
): Uint8Array => {
  const out: number[] = [];
  encodeKey(field, 2, out);
  writeVarint(value.byteLength, out);
  for (const b of value) out.push(b);
  return Uint8Array.from(out);
};

export const encodeProtoInt32 = (field: number, value: number): Uint8Array => {
  const out: number[] = [];
  encodeKey(field, 0, out);
  writeVarint(value, out);
  return Uint8Array.from(out);
};

/** Encode a keyed fixed64 (wire type 1) field — 8 raw little-endian bytes. */
const encodeKeyedFixed64 = (field: number, bytes: Uint8Array): Uint8Array => {
  const out: number[] = [];
  encodeKey(field, 1, out);
  for (const b of bytes) out.push(b);
  return Uint8Array.from(out);
};

export const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};

type TProtoField = {
  readonly field: number;
  readonly wire: number;
  readonly bytes: Uint8Array;
  readonly varint: bigint | null;
};

const readVarint = (
  buf: Uint8Array,
  offset: number,
): { readonly value: bigint; readonly next: number } => {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    const byte = buf[offset + index];
    if (byte === undefined) {
      throw new CursorCaptureDecodeError(
        "truncated_connect_frame",
        "truncated protobuf varint",
      );
    }
    // A protobuf uint64 has only one value bit left in its tenth byte.
    if (index === 9 && byte > 1) {
      throw new CursorCaptureDecodeError(
        "invalid_protobuf",
        "varint exceeds uint64",
      );
    }
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
  }
  throw new CursorCaptureDecodeError("invalid_protobuf", "varint too long");
};

/** Tags and lengths must not wrap when an untrusted uint64 exceeds uint32. */
const readUint32Varint = (
  buf: Uint8Array,
  offset: number,
): { readonly value: number; readonly next: number } => {
  const decoded = readVarint(buf, offset);
  if (decoded.value > 0xffffffffn) {
    throw new CursorCaptureDecodeError(
      "invalid_protobuf",
      "protobuf tag or length exceeds uint32",
    );
  }
  return { value: Number(decoded.value), next: decoded.next };
};

const parseProtoFields = (buf: Uint8Array): ReadonlyArray<TProtoField> => {
  const fields: TProtoField[] = [];
  let offset = 0;
  while (offset < buf.byteLength) {
    const key = readUint32Varint(buf, offset);
    offset = key.next;
    const field = key.value >>> 3;
    const wire = key.value & 0x07;
    if (wire === 0) {
      const v = readVarint(buf, offset);
      fields.push({
        field,
        wire,
        bytes: new Uint8Array(0),
        varint: v.value,
      });
      offset = v.next;
      continue;
    }
    if (wire === 2) {
      const len = readUint32Varint(buf, offset);
      offset = len.next;
      const end = offset + len.value;
      if (end > buf.byteLength) {
        throw new CursorCaptureDecodeError(
          "truncated_connect_frame",
          "truncated length-delimited protobuf field",
        );
      }
      fields.push({
        field,
        wire,
        bytes: buf.subarray(offset, end),
        varint: null,
      });
      offset = end;
      continue;
    }
    if (wire === 5) {
      if (offset + 4 > buf.byteLength) {
        throw new CursorCaptureDecodeError(
          "truncated_connect_frame",
          "truncated fixed32 protobuf field",
        );
      }
      fields.push({
        field,
        wire,
        bytes: buf.subarray(offset, offset + 4),
        varint: null,
      });
      offset += 4;
      continue;
    }
    if (wire === 1) {
      if (offset + 8 > buf.byteLength) {
        throw new CursorCaptureDecodeError(
          "truncated_connect_frame",
          "truncated fixed64 protobuf field",
        );
      }
      fields.push({
        field,
        wire,
        bytes: buf.subarray(offset, offset + 8),
        varint: null,
      });
      offset += 8;
      continue;
    }
    throw new CursorCaptureDecodeError(
      "invalid_protobuf",
      `unsupported protobuf wire type ${wire}`,
    );
  }
  return fields;
};

const protoStringField = (
  fields: ReadonlyArray<TProtoField>,
  field: number,
): string | null => {
  for (const f of fields) {
    if (f.field === field && f.wire === 2) return textDecoder.decode(f.bytes);
  }
  return null;
};

const protoMessageField = (
  fields: ReadonlyArray<TProtoField>,
  field: number,
): Uint8Array | null => {
  for (const f of fields) {
    if (f.field === field && f.wire === 2) return f.bytes;
  }
  return null;
};

const protoIntField = (
  fields: ReadonlyArray<TProtoField>,
  field: number,
): number | null => {
  for (const f of fields) {
    if (f.field === field && f.wire === 0 && f.varint !== null) {
      return f.varint <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(f.varint)
        : null;
    }
  }
  return null;
};

/**
 * Read a proto3 `uint32` field with IMPLICIT presence: the real (confirmed)
 * KV wire schema declares `KvServerMessage.id` / `KvClientMessage.id` as a
 * non-optional uint32, so a genuine proto3 encoder OMITS the field entirely
 * from the wire when its value is the zero default — an absent field and an
 * explicit `id=0` are the same bytes. Live retest #34 hit exactly this: a
 * real KV round-trip with id=0 was rejected as if the id were missing.
 * This returns 0 when the field is entirely absent (proto3 default), the
 * decoded varint when present with the correct wire type, and THROWS when
 * the field number is present with the WRONG wire type (never silently
 * treated as absent/defaulted) or when its wire type isn't a valid uint32
 * encoding — a genuine wire-format violation must still fail closed.
 */
const protoUint32FieldOrDefault = (
  fields: ReadonlyArray<TProtoField>,
  field: number,
): number => {
  for (const f of fields) {
    if (f.field !== field) continue;
    if (f.wire !== 0 || f.varint === null) {
      throw new CursorCaptureDecodeError(
        "invalid_protobuf",
        `field ${field} has wire type ${f.wire} — expected varint (0) for a uint32`,
      );
    }
    // Preserve all uint64 bits until this field's uint32 range is checked.
    if (f.varint > 0xffffffffn) {
      throw new CursorCaptureDecodeError(
        "invalid_protobuf",
        `field ${field} varint ${f.varint} out of uint32 range`,
      );
    }
    return Number(f.varint);
  }
  // Proto3 implicit presence: absent means the zero default, not "unknown".
  return 0;
};

/**
 * Bounded, metadata-only summary of a decoded message's top-level protobuf
 * field tags — field number + wire type ONLY, never the field's bytes/value.
 * Exists so an unhandled/unknown message (a new oneof case the decoder
 * doesn't yet classify) can be diagnosed from its shape alone — never by
 * logging payload/args/content. Capped to avoid unbounded diagnostic strings
 * on a pathological or hostile message.
 */
const MAX_DESCRIBED_FIELDS = 16;
export const describeProtoFieldTags = (
  fields: ReadonlyArray<TProtoField>,
): string => {
  const tags = fields
    .slice(0, MAX_DESCRIBED_FIELDS)
    .map((f) => `${f.field}:wire${f.wire}`);
  const suffix = fields.length > MAX_DESCRIBED_FIELDS ? ",…" : "";
  return `tags=[${tags.join(",")}${suffix}]`;
};

// ── BidiService wire shapes (HTTP/1 RunSSE companion RPC) ──────────────────
//
// Field numbers taken from the installed runtime's generated descriptors
// (`aiserver.v1.BidiRequestId`, `aiserver.v1.BidiAppendRequest`):
//   BidiRequestId       { 1: request_id (string) }
//   BidiAppendRequest   { 1: data (string, hex-encoded AgentClientMessage),
//                          2: request_id (message BidiRequestId),
//                          3: append_seqno (int64/varint),
//                          4: data_binary (bytes, AgentClientMessage) }
// The installed client picks `data_binary` when `binaryEncoding` is set,
// otherwise a hex string in `data`. Both carry the same application bytes —
// decode prefers `data_binary`, falling back to hex-decoding `data`.

export type TCursorBidiRequestId = {
  readonly requestId: string;
};

export type TCursorBidiAppendRequest = {
  readonly requestId: string | null;
  readonly appendSeqno: number | null;
  /** Decoded AgentClientMessage bytes carried by this companion RPC. */
  readonly data: Uint8Array | null;
};

export const encodeBidiRequestId = (requestId: string): Uint8Array =>
  encodeProtoString(1, requestId);

export const decodeBidiRequestId = (
  bytes: Uint8Array,
): TCursorBidiRequestId | null => {
  const fields = parseProtoFields(bytes);
  const requestId = protoStringField(fields, 1);
  if (requestId === null) return null;
  return { requestId };
};

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byteStr = hex.slice(i * 2, i * 2 + 2);
    const byte = Number.parseInt(byteStr, 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
};

/**
 * Encode a `BidiAppendRequest`. `binary: true` uses field 4 (`data_binary`)
 * matching the installed client's `binaryEncoding` mode; otherwise field 1
 * (`data`) carries the hex-encoded bytes — mirrors the two wire shapes the
 * vendor client actually emits.
 */
export const encodeBidiAppendRequest = (args: {
  readonly requestId: string;
  readonly appendSeqno: number;
  readonly data: Uint8Array;
  readonly binary?: boolean;
}): Uint8Array => {
  const requestIdMsg = encodeProtoBytes(2, encodeBidiRequestId(args.requestId));
  const seqno = encodeProtoInt32(3, args.appendSeqno);
  const dataField =
    args.binary === true
      ? encodeProtoBytes(4, args.data)
      : encodeProtoString(1, Buffer.from(args.data).toString("hex"));
  return concatBytes([dataField, requestIdMsg, seqno]);
};

/**
 * Decode a `BidiAppendRequest`. Never throws — a companion whose bytes are
 * malformed still needs its raw envelope preserved for the transaction
 * buffer, so the caller decides whether a null field blocks dispatch.
 */
export const decodeBidiAppendRequest = (
  bytes: Uint8Array,
): TCursorBidiAppendRequest => {
  let fields: ReadonlyArray<TProtoField>;
  try {
    fields = parseProtoFields(bytes);
  } catch {
    return { requestId: null, appendSeqno: null, data: null };
  }
  const requestIdBytes = protoMessageField(fields, 2);
  const requestId =
    requestIdBytes === null
      ? null
      : (decodeBidiRequestId(requestIdBytes)?.requestId ?? null);
  const appendSeqno = protoIntField(fields, 3);
  const dataBinary = protoMessageField(fields, 4);
  if (dataBinary !== null) {
    return { requestId, appendSeqno, data: dataBinary };
  }
  const dataHex = protoStringField(fields, 1);
  const data = dataHex === null ? null : hexToBytes(dataHex);
  return { requestId, appendSeqno, data };
};

/**
 * Decode the Connect-framed body of a captured RunSSE (primary) request into
 * its `BidiRequestId` correlation id. Returns null if the body is not a
 * well-formed single-envelope Connect message (RunSSE's request body is
 * normally exactly this — no application content).
 */
export const requestIdFromCapturedRunSseBody = (
  body: Uint8Array | null,
): string | null => {
  if (body === null || body.byteLength === 0) return null;
  const { envelopes } = takeConnectEnvelopes(body);
  const first = envelopes.find((e) => !e.endStream);
  if (first === undefined) return null;
  try {
    return decodeBidiRequestId(first.payload)?.requestId ?? null;
  } catch {
    return null;
  }
};

/**
 * Decode the Connect-framed body of a captured BidiAppend companion request.
 * Returns the best-effort decode (never throws) — a companion is buffered
 * even when its bytes are malformed so nothing is silently dropped.
 */
export const decodeCapturedBidiAppendBody = (
  body: Uint8Array | null,
): TCursorBidiAppendRequest => {
  if (body === null || body.byteLength === 0) {
    return { requestId: null, appendSeqno: null, data: null };
  }
  const { envelopes } = takeConnectEnvelopes(body);
  const first = envelopes.find((e) => !e.endStream);
  if (first === undefined) {
    return { requestId: null, appendSeqno: null, data: null };
  }
  return decodeBidiAppendRequest(first.payload);
};

/**
 * Build `agent.v1.AgentServerMessage` with `interaction_update` /
 * duplex cases for hermetic fixtures (field numbers from artifact).
 */
export const encodeAgentServerMessage = (args: {
  readonly interactionUpdate?: Uint8Array;
  readonly execServerMessage?: Uint8Array;
  readonly kvServerMessage?: Uint8Array;
  readonly interactionQuery?: Uint8Array;
}): Uint8Array => {
  const parts: Uint8Array[] = [];
  if (args.interactionUpdate !== undefined) {
    parts.push(encodeProtoBytes(1, args.interactionUpdate));
  }
  if (args.execServerMessage !== undefined) {
    parts.push(encodeProtoBytes(2, args.execServerMessage));
  }
  if (args.kvServerMessage !== undefined) {
    parts.push(encodeProtoBytes(4, args.kvServerMessage));
  }
  if (args.interactionQuery !== undefined) {
    parts.push(encodeProtoBytes(7, args.interactionQuery));
  }
  return concatBytes(parts);
};

/**
 * `AgentServerMessage.kv_server_message` (field 4, `KvServerMessage`) —
 * hermetic test/fixture encoder mirroring the real native field numbers:
 * id(1), get_blob_args(2: blob_id bytes1), set_blob_args(3: blob_id bytes1,
 * blob_data bytes2), tracing(4).
 */
export const encodeKvServerMessage = (args: {
  readonly id?: number;
  readonly getBlobArgs?: { readonly blobId: Uint8Array };
  readonly setBlobArgs?: {
    readonly blobId: Uint8Array;
    readonly blobData: Uint8Array;
  };
  readonly tracing?: Uint8Array;
}): Uint8Array => {
  const parts: Uint8Array[] = [];
  if (args.id !== undefined) parts.push(encodeProtoInt32(1, args.id));
  if (args.getBlobArgs !== undefined) {
    parts.push(
      encodeProtoBytes(2, encodeProtoBytes(1, args.getBlobArgs.blobId)),
    );
  }
  if (args.setBlobArgs !== undefined) {
    const inner = concatBytes([
      encodeProtoBytes(1, args.setBlobArgs.blobId),
      encodeProtoBytes(2, args.setBlobArgs.blobData),
    ]);
    parts.push(encodeProtoBytes(3, inner));
  }
  if (args.tracing !== undefined) {
    parts.push(encodeProtoBytes(4, args.tracing));
  }
  return concatBytes(parts);
};

/**
 * `AgentClientMessage.kv_client_message` (field 3, `KvClientMessage`) —
 * hermetic test/fixture encoder: id(1), get_blob_result(2: blob_data
 * optional bytes1), set_blob_result(3: error optional1).
 */
export const encodeKvClientMessage = (args: {
  readonly id?: number;
  readonly getBlobResult?: { readonly blobData?: Uint8Array };
  readonly setBlobResult?: { readonly error?: Uint8Array };
}): Uint8Array => {
  const parts: Uint8Array[] = [];
  if (args.id !== undefined) parts.push(encodeProtoInt32(1, args.id));
  if (args.getBlobResult !== undefined) {
    const inner =
      args.getBlobResult.blobData !== undefined
        ? encodeProtoBytes(1, args.getBlobResult.blobData)
        : new Uint8Array(0);
    parts.push(encodeProtoBytes(2, inner));
  }
  if (args.setBlobResult !== undefined) {
    const inner =
      args.setBlobResult.error !== undefined
        ? encodeProtoBytes(1, args.setBlobResult.error)
        : new Uint8Array(0);
    parts.push(encodeProtoBytes(3, inner));
  }
  return concatBytes(parts);
};

/** Wrap `KvClientMessage` bytes as `AgentClientMessage.kv_client_message` (field 3). */
export const encodeAgentClientKvMessage = (
  kvClientMessage: Uint8Array,
): Uint8Array => encodeProtoBytes(3, kvClientMessage);

export const encodeTextDeltaUpdate = (text: string): Uint8Array =>
  encodeProtoBytes(1, encodeProtoString(1, text));

export const encodeThinkingDeltaUpdate = (text: string): Uint8Array =>
  encodeProtoBytes(4, encodeProtoString(1, text));

export const encodeTokenDeltaUpdate = (tokens: number): Uint8Array =>
  encodeProtoBytes(8, encodeProtoInt32(1, tokens));

/**
 * `InteractionUpdate.turn_ended` (field 14, `TurnEndedUpdate`) — the real
 * native turn-completion marker. Test/fixture-only encoder mirroring the
 * field numbers confirmed by read-only inspection of the installed vendor
 * artifact: input_tokens(1), output_tokens(2), cache_read_tokens(3),
 * cache_write_tokens(4), reasoning_tokens(5) — all optional int64 counters.
 */
export const encodeTurnEndedUpdate = (
  args: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
  } = {},
): Uint8Array => {
  const parts: Uint8Array[] = [];
  if (args.inputTokens !== undefined) {
    parts.push(encodeProtoInt32(1, args.inputTokens));
  }
  if (args.outputTokens !== undefined) {
    parts.push(encodeProtoInt32(2, args.outputTokens));
  }
  if (args.cacheReadTokens !== undefined) {
    parts.push(encodeProtoInt32(3, args.cacheReadTokens));
  }
  if (args.cacheWriteTokens !== undefined) {
    parts.push(encodeProtoInt32(4, args.cacheWriteTokens));
  }
  if (args.reasoningTokens !== undefined) {
    parts.push(encodeProtoInt32(5, args.reasoningTokens));
  }
  return encodeProtoBytes(14, concatBytes(parts));
};

export const encodeMcpPartialToolCallUpdate = (args: {
  readonly callId: string;
  readonly toolName: string;
  readonly argsTextDelta: string;
  readonly providerIdentifier?: string;
  readonly serverIdentifier?: string;
}): Uint8Array => {
  const mcpArgs = concatBytes([
    encodeProtoString(1, args.toolName),
    encodeProtoString(3, args.callId),
    encodeProtoString(5, args.toolName),
    ...(args.providerIdentifier !== undefined
      ? [encodeProtoString(4, args.providerIdentifier)]
      : []),
    ...(args.serverIdentifier !== undefined
      ? [encodeProtoString(9, args.serverIdentifier)]
      : []),
  ]);
  const mcpToolCall = encodeProtoBytes(1, mcpArgs);
  // ToolCall.mcp_tool_call = field 15
  const toolCall = encodeProtoBytes(15, mcpToolCall);
  const partial = concatBytes([
    encodeProtoString(1, args.callId),
    encodeProtoBytes(2, toolCall),
    encodeProtoString(3, args.argsTextDelta),
  ]);
  // InteractionUpdate.partial_tool_call = field 7
  return encodeProtoBytes(7, partial);
};

export const encodeMcpToolCallStartedUpdate = (args: {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  /**
   * A REAL, complete `args` map (field 2 of the nested `McpArgs`) — verified
   * native schema: a `tool_call_started` update can already carry the
   * complete arguments, not just an empty placeholder streamed later via
   * partials. Omit to encode the ordinary "no args yet" shape (`argumentsJson`
   * is otherwise unused — it exists only to mirror the real caller-facing
   * shape at this fixture's call sites).
   */
  readonly args?: { readonly [key: string]: TCursorMcpFixtureValue };
}): Uint8Array => {
  const mcpArgs = concatBytes([
    encodeProtoString(1, args.toolName),
    ...(args.args !== undefined
      ? Object.entries(args.args).map(([k, v]) =>
          encodeProtoBytes(
            2,
            concatBytes([
              encodeProtoString(1, k),
              encodeProtoBytes(2, encodeMcpFixtureValue(v)),
            ]),
          ),
        )
      : []),
    encodeProtoString(3, args.callId),
    encodeProtoString(5, args.toolName),
  ]);
  const mcpToolCall = encodeProtoBytes(1, mcpArgs);
  const toolCall = encodeProtoBytes(15, mcpToolCall);
  const started = concatBytes([
    encodeProtoString(1, args.callId),
    encodeProtoBytes(2, toolCall),
  ]);
  // Prefer streaming args via a preceding partial; started carries id/name.
  void args.argumentsJson;
  return encodeProtoBytes(2, started);
};

/** Native shell tool (ToolCall.shell_tool_call = field 1) — unsupported by default. */
export const encodeNativeShellToolStartedUpdate = (
  callId: string,
): Uint8Array => {
  const shell = encodeProtoString(1, "echo"); // minimal placeholder args message
  const toolCall = encodeProtoBytes(1, shell);
  const started = concatBytes([
    encodeProtoString(1, callId),
    encodeProtoBytes(2, toolCall),
  ]);
  return encodeProtoBytes(2, started);
};

// ── `google.protobuf.Value` / `Struct` / `ListValue` decode (bounded) ──────
//
// Verified native schema for `agent.v1.McpArgs`: name(1), args(2,
// map<string, google.protobuf.Value>), tool_call_id(3), provider_identifier(4),
// tool_name(5), smart_mode_approval(6), approval_only(7, bool), skip_approval(8,
// bool), server_identifier(9). `google.protobuf.Value`'s oneof: null_value(1,
// enum/varint), number_value(2, double/fixed64), string_value(3),
// bool_value(4, varint), struct_value(5, Struct), list_value(6, ListValue).
// `Struct.fields` (1) and `McpArgs.args` (2) are both `map<string, Value>` —
// wire-identical repeated MapEntry submessages (key=1 string, value=2 Value).
//
// Recursive, but bounded on BOTH depth and total decoded node count so a
// hostile/corrupt struct can't exhaust memory or the call stack. Never
// silently maps a non-finite double to `null` — that would be
// indistinguishable from a genuine `null_value` the caller might act on;
// instead it fails closed. Object keys (including `__proto__` /
// `constructor`) are assembled via `Object.fromEntries`, which defines OWN
// properties rather than going through `[[Set]]` — a key literally named
// `__proto__` can never mutate the resulting object's prototype this way.

export type TCursorMcpJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<TCursorMcpJsonValue>
  | { readonly [key: string]: TCursorMcpJsonValue };

const MCP_VALUE_MAX_DEPTH = 8;
const MCP_VALUE_MAX_NODES = 2_000;

type TMcpDecodeBudget = { nodes: number };

const bumpMcpDecodeBudget = (budget: TMcpDecodeBudget): void => {
  budget.nodes += 1;
  if (budget.nodes > MCP_VALUE_MAX_NODES) {
    throw new CursorCaptureDecodeError(
      "invalid_protobuf",
      `mcp args exceed ${MCP_VALUE_MAX_NODES} decoded value nodes`,
    );
  }
};

/** Read an 8-byte little-endian IEEE754 double from a fixed64 wire field. */
const readFixed64Double = (bytes: Uint8Array): number => {
  if (bytes.byteLength !== 8) {
    throw new CursorCaptureDecodeError(
      "invalid_protobuf",
      `mcp arg number_value has ${bytes.byteLength} bytes, expected 8`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getFloat64(0, true);
};

/**
 * Decode one `google.protobuf.Value` message. `depth` counts Value→Struct /
 * Value→ListValue nesting (not raw protobuf recursion) so a legitimately
 * flat but wide map never trips the depth bound.
 */
const decodeCursorMcpValue = (
  bytes: Uint8Array,
  budget: TMcpDecodeBudget,
  depth: number,
): TCursorMcpJsonValue => {
  bumpMcpDecodeBudget(budget);
  if (depth > MCP_VALUE_MAX_DEPTH) {
    throw new CursorCaptureDecodeError(
      "invalid_protobuf",
      `mcp arg value nesting exceeds ${MCP_VALUE_MAX_DEPTH} levels`,
    );
  }
  const fields = parseProtoFields(bytes);
  for (const f of fields) {
    if (f.field === 1 && f.wire === 0) return null; // NullValue
    if (f.field === 2 && f.wire === 1) {
      const num = readFixed64Double(f.bytes);
      if (!Number.isFinite(num)) {
        // Never silently coerce to null/0 — a non-finite double is a wire
        // violation for JSON-shaped Value, not a legitimate "no value".
        throw new CursorCaptureDecodeError(
          "invalid_protobuf",
          "mcp arg number_value is not finite (NaN/Infinity)",
        );
      }
      return num;
    }
    if (f.field === 3 && f.wire === 2) return textDecoder.decode(f.bytes);
    if (f.field === 4 && f.wire === 0) return f.varint !== 0n;
    if (f.field === 5 && f.wire === 2) {
      return decodeCursorMcpStruct(f.bytes, budget, depth + 1);
    }
    if (f.field === 6 && f.wire === 2) {
      return decodeCursorMcpListValue(f.bytes, budget, depth + 1);
    }
  }
  // Unset oneof (or an unrecognized case) — Value's own default is null.
  return null;
};

/** Decode one `Value`-valued map (`Struct.fields` or `McpArgs.args`). */
const decodeCursorMcpValueMap = (
  fields: ReadonlyArray<TProtoField>,
  entryField: number,
  budget: TMcpDecodeBudget,
  depth: number,
): { readonly [key: string]: TCursorMcpJsonValue } => {
  const entries: Array<readonly [string, TCursorMcpJsonValue]> = [];
  for (const f of fields) {
    if (f.field !== entryField || f.wire !== 2) continue;
    bumpMcpDecodeBudget(budget);
    const entryFields = parseProtoFields(f.bytes);
    const key = protoStringField(entryFields, 1);
    if (key === null) continue; // malformed map entry — skip, don't fabricate a key
    const valueBytes = protoMessageField(entryFields, 2);
    entries.push([
      key,
      valueBytes !== null
        ? decodeCursorMcpValue(valueBytes, budget, depth)
        : null,
    ]);
  }
  // `Object.fromEntries` defines each entry as an own property directly —
  // never through `[[Set]]` — so a key literally named `__proto__` or
  // `constructor` lands as an ordinary own property, never a prototype
  // mutation.
  return Object.fromEntries(entries);
};

const decodeCursorMcpStruct = (
  bytes: Uint8Array,
  budget: TMcpDecodeBudget,
  depth: number,
): { readonly [key: string]: TCursorMcpJsonValue } =>
  decodeCursorMcpValueMap(parseProtoFields(bytes), 1, budget, depth);

const decodeCursorMcpListValue = (
  bytes: Uint8Array,
  budget: TMcpDecodeBudget,
  depth: number,
): ReadonlyArray<TCursorMcpJsonValue> => {
  const fields = parseProtoFields(bytes);
  const out: TCursorMcpJsonValue[] = [];
  for (const f of fields) {
    if (f.field !== 1 || f.wire !== 2) continue;
    bumpMcpDecodeBudget(budget);
    out.push(decodeCursorMcpValue(f.bytes, budget, depth));
  }
  return out;
};

const parseMcpArgs = (
  bytes: Uint8Array,
): {
  readonly name: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly providerIdentifier: string | null;
  readonly serverIdentifier: string | null;
  /**
   * The real `args` map (field 2) decoded via the same bounded Value
   * decoder as `decodeCursorMcpArgs`, when present and non-empty — `null`
   * when absent/empty. Verified native schema: a `tool_call_started`
   * update's own nested `McpArgs` can already carry a COMPLETE args map
   * (not just name/id), so a caller should prefer this over buffering an
   * empty placeholder and waiting on separate partial-delta text.
   */
  readonly argsText: string | null;
} => {
  const fields = parseProtoFields(bytes);
  const budget: TMcpDecodeBudget = { nodes: 0 };
  const argsObj = decodeCursorMcpValueMap(fields, 2, budget, 1);
  return {
    name: protoStringField(fields, 1) ?? "",
    toolCallId: protoStringField(fields, 3) ?? "",
    toolName: protoStringField(fields, 5) ?? protoStringField(fields, 1) ?? "",
    providerIdentifier: protoStringField(fields, 4),
    serverIdentifier: protoStringField(fields, 9),
    argsText: Object.keys(argsObj).length > 0 ? JSON.stringify(argsObj) : null,
  };
};

const parseToolCall = (
  bytes: Uint8Array,
):
  | { readonly kind: "mcp"; readonly args: ReturnType<typeof parseMcpArgs> }
  | { readonly kind: "native"; readonly toolCase: string } => {
  const fields = parseProtoFields(bytes);
  const mcp = protoMessageField(fields, 15);
  if (mcp !== null) {
    const mcpFields = parseProtoFields(mcp);
    const argsMsg = protoMessageField(mcpFields, 1);
    if (argsMsg === null) {
      return { kind: "native", toolCase: "mcp_tool_call_missing_args" };
    }
    return { kind: "mcp", args: parseMcpArgs(argsMsg) };
  }
  const nativeCases: ReadonlyArray<readonly [number, string]> = [
    [1, "shell_tool_call"],
    [3, "delete_tool_call"],
    [4, "glob_tool_call"],
    [5, "grep_tool_call"],
    [8, "read_tool_call"],
    [12, "edit_tool_call"],
    [13, "ls_tool_call"],
    [16, "sem_search_tool_call"],
  ];
  for (const [field, name] of nativeCases) {
    if (protoMessageField(fields, field) !== null) {
      return { kind: "native", toolCase: name };
    }
  }
  return { kind: "native", toolCase: "unknown_tool" };
};

export const decodeInteractionUpdate = (
  bytes: Uint8Array,
): TCursorDecodedInteraction => {
  const fields = parseProtoFields(bytes);
  const textDelta = protoMessageField(fields, 1);
  if (textDelta !== null) {
    const t = protoStringField(parseProtoFields(textDelta), 1) ?? "";
    return { kind: "text_delta", text: t };
  }
  const thinkingDelta = protoMessageField(fields, 4);
  if (thinkingDelta !== null) {
    const t = protoStringField(parseProtoFields(thinkingDelta), 1) ?? "";
    return { kind: "thinking_delta", text: t };
  }
  const tokenDelta = protoMessageField(fields, 8);
  if (tokenDelta !== null) {
    const tokens = protoIntField(parseProtoFields(tokenDelta), 1) ?? 0;
    return { kind: "token_delta", tokens };
  }
  const heartbeat = protoMessageField(fields, 13);
  if (heartbeat !== null) return { kind: "heartbeat" };

  // `InteractionUpdate.turn_ended` (field 14, `TurnEndedUpdate`) is the real
  // native turn-completion marker used by the official Cursor client — it is
  // authoritative independent of any Connect transport `endStream` envelope
  // (confirmed by read-only deminified inspection of the installed vendor
  // artifact: the official client sets a local "terminal turn" flag on this
  // update and, from then on, treats a subsequent transport close/error as a
  // benign "Ignoring transport close after terminal agent stream", not a
  // failure). `TurnEndedUpdate` fields are all optional scalar counters:
  // input_tokens(1), output_tokens(2), cache_read_tokens(3),
  // cache_write_tokens(4), reasoning_tokens(5).
  const turnEnded = protoMessageField(fields, 14);
  if (turnEnded !== null) {
    const tf = parseProtoFields(turnEnded);
    return {
      kind: "turn_ended",
      inputTokens: protoIntField(tf, 1),
      outputTokens: protoIntField(tf, 2),
      cacheReadTokens: protoIntField(tf, 3),
      cacheWriteTokens: protoIntField(tf, 4),
      reasoningTokens: protoIntField(tf, 5),
    };
  }

  const partial = protoMessageField(fields, 7);
  if (partial !== null) {
    const pf = parseProtoFields(partial);
    const callId = protoStringField(pf, 1) ?? "";
    const argsTextDelta = protoStringField(pf, 3) ?? "";
    const toolBytes = protoMessageField(pf, 2);
    if (toolBytes === null) {
      return { kind: "ignored", reason: "partial_tool_call_missing_tool" };
    }
    const tool = parseToolCall(toolBytes);
    if (tool.kind === "native") {
      return { kind: "native_tool", toolCase: tool.toolCase, callId };
    }
    return {
      kind: "mcp_tool_partial",
      argsTextDelta,
      intent: {
        callId: tool.args.toolCallId || callId,
        name: tool.args.toolName || tool.args.name,
        argumentsText: argsTextDelta,
        providerIdentifier: tool.args.providerIdentifier,
        serverIdentifier: tool.args.serverIdentifier,
      },
    };
  }

  const started = protoMessageField(fields, 2);
  if (started !== null) {
    const sf = parseProtoFields(started);
    const callId = protoStringField(sf, 1) ?? "";
    const toolBytes = protoMessageField(sf, 2);
    if (toolBytes === null) {
      return { kind: "ignored", reason: "tool_call_started_missing_tool" };
    }
    const tool = parseToolCall(toolBytes);
    if (tool.kind === "native") {
      return { kind: "native_tool", toolCase: tool.toolCase, callId };
    }
    return {
      kind: "mcp_tool_started",
      intent: {
        callId: tool.args.toolCallId || callId,
        name: tool.args.toolName || tool.args.name,
        // Prefer a COMPLETE args map already present on `started` (verified
        // native schema) over an empty placeholder — exactly "" only when
        // the nested McpArgs truly carries no args field.
        argumentsText: tool.args.argsText ?? "",
        providerIdentifier: tool.args.providerIdentifier,
        serverIdentifier: tool.args.serverIdentifier,
      },
    };
  }

  // tool_call_completed / summaries / shell_output — ignored for chunk stream
  if (protoMessageField(fields, 3) !== null) {
    return { kind: "ignored", reason: "tool_call_completed" };
  }
  if (protoMessageField(fields, 5) !== null) {
    return { kind: "ignored", reason: "thinking_completed" };
  }
  // Bounded, metadata-only (tag + wire type, never value/bytes) so a real
  // native terminal/other signal riding an oneof case we don't yet classify
  // can be identified from its shape alone, without another live capture.
  return {
    kind: "ignored",
    reason: `unhandled_interaction_update ${describeProtoFieldTags(fields)}`,
  };
};

/**
 * `agent.v1.ExecServerMessage.message` oneof field numbers from artifact
 * `2026.07.23-e383d2b`. Values are subtype tags only — never log args payloads.
 */
export const CURSOR_EXEC_SERVER_MESSAGE_CASES: ReadonlyArray<
  readonly [field: number, subtype: string]
> = [
  [2, "shell_args"],
  [3, "write_args"],
  [4, "delete_args"],
  [5, "grep_args"],
  [7, "read_args"],
  [8, "ls_args"],
  [9, "diagnostics_args"],
  [10, "request_context_args"],
  [11, "mcp_args"],
  [14, "shell_stream_args"],
  [16, "background_shell_spawn_args"],
  [17, "list_mcp_resources_exec_args"],
  [18, "read_mcp_resource_exec_args"],
  [20, "fetch_args"],
  [21, "record_screen_args"],
  [22, "computer_use_args"],
  [23, "write_shell_stdin_args"],
  [27, "execute_hook_args"],
  [28, "subagent_args"],
  [29, "redacted_read_args"],
  [30, "force_background_shell_args"],
  [31, "force_background_subagent_args"],
  [36, "mcp_state_exec_args"],
  [37, "subagent_await_args"],
  [38, "smart_mode_classifier_args"],
  [40, "canvas_diagnostics_args"],
  [41, "shell_allowlist_precheck_args"],
  [42, "mcp_allowlist_precheck_args"],
  [43, "web_fetch_allowlist_precheck_args"],
  [44, "git_diff_request"],
  [45, "pi_read_args"],
  [46, "pi_bash_args"],
  [47, "pi_edit_args"],
  [48, "pi_write_args"],
  [49, "pi_grep_args"],
  [50, "pi_find_args"],
  [51, "pi_ls_args"],
  [52, "mini_swe_agent_bash_args"],
  [53, "conversation_search_args"],
  [54, "agent_store_conflict_args"],
] as const;

const PROTOCOL_CONTROL_SUBTYPES: ReadonlySet<string> = new Set([
  "request_context_args",
  "diagnostics_args",
  "shell_allowlist_precheck_args",
  "mcp_allowlist_precheck_args",
  "web_fetch_allowlist_precheck_args",
  "smart_mode_classifier_args",
  "mcp_state_exec_args",
  "execute_hook_args",
  "canvas_diagnostics_args",
]);

export const classifyCursorExecSubtype = (
  subtype: string,
): TCursorExecClass => {
  if (subtype === "mcp_args") return "caller_mcp_tool";
  if (PROTOCOL_CONTROL_SUBTYPES.has(subtype)) return "protocol_control";
  if (subtype.endsWith("_args") || subtype.endsWith("_request")) {
    return "native_exec";
  }
  return "unknown";
};

export type TCursorDecodedExecServerMessage = {
  readonly id: number | null;
  readonly execId: string | null;
  readonly subtype: string;
  readonly classification: TCursorExecClass;
  /** Present only for mcp_args — names/ids only; argumentsText may be empty. */
  readonly mcp: TCursorMcpToolIntent | null;
};

/**
 * Decode `agent.v1.McpArgs` for caller tool handoff. Does not dump map values
 * into diagnostics; argumentsText is "{}" unless a simple string map is present
 * (we intentionally omit opaque protobuf map values).
 */
export const decodeCursorMcpArgs = (
  bytes: Uint8Array,
): TCursorMcpToolIntent => {
  const fields = parseProtoFields(bytes);
  const name = protoStringField(fields, 1) ?? "";
  const toolCallId = protoStringField(fields, 3) ?? "";
  const toolName = protoStringField(fields, 5) ?? name;
  const providerIdentifier = protoStringField(fields, 4);
  const serverIdentifier = protoStringField(fields, 9);
  // `args` (field 2) is `map<string, google.protobuf.Value>` — decode it for
  // real via the bounded recursive Value decoder (never a hardcoded "{}").
  // Values are never logged raw anywhere in this module; only the resulting
  // JSON-shaped structure is ever handed to the caller as its OpenAI-style
  // `arguments` string, exactly as the caller would present any other tool
  // call's arguments.
  const budget: TMcpDecodeBudget = { nodes: 0 };
  const argsObj = decodeCursorMcpValueMap(fields, 2, budget, 1);
  return {
    callId: toolCallId,
    name: toolName || name || "mcp_tool",
    argumentsText: JSON.stringify(argsObj),
    providerIdentifier,
    serverIdentifier,
  };
};

/**
 * Decode ExecServerMessage to a safe subtype classification. Never returns
 * shell/fs argument payloads — only field tags + MCP name/id for caller handoff.
 */
export const decodeExecServerMessage = (
  bytes: Uint8Array,
): TCursorDecodedExecServerMessage => {
  const fields = parseProtoFields(bytes);
  const id = protoIntField(fields, 1);
  const execId = protoStringField(fields, 15);
  let subtype = "unknown_exec_server_message";
  let caseBytes: Uint8Array | null = null;
  for (const [field, name] of CURSOR_EXEC_SERVER_MESSAGE_CASES) {
    const msg = protoMessageField(fields, field);
    if (msg !== null) {
      subtype = name;
      caseBytes = msg;
      break;
    }
  }
  const classification = classifyCursorExecSubtype(subtype);
  const mcp =
    classification === "caller_mcp_tool" && caseBytes !== null
      ? decodeCursorMcpArgs(caseBytes)
      : null;
  return { id, execId, subtype, classification, mcp };
};

/**
 * Proto3-correct numeric id of an `AgentServerMessage.exec_server_message`
 * (field 2 → `ExecServerMessage.id`, field 1, uint32, implicit presence — 0
 * is validly omitted on the wire). Scoped narrowly to request_context_args
 * numeric-id correlation (and later matching a queued `stream_close` against
 * that same exchange) — does NOT replace {@link decodeExecServerMessage}'s
 * general nullable `id` field used by other exec-message consumers, to avoid
 * broadening unrelated behavior.
 */
export const execServerContextNumericId = (
  agentServerMessageBytes: Uint8Array,
): number | null => {
  const fields = parseProtoFields(agentServerMessageBytes);
  const execServer = protoMessageField(fields, 2);
  if (execServer === null) return null;
  return protoUint32FieldOrDefault(parseProtoFields(execServer), 1);
};

/** Hermetic fixture: ExecServerMessage with a chosen oneof case (empty case body). */
export const encodeExecServerMessage = (args: {
  readonly id?: number;
  readonly execId?: string;
  readonly caseField: number;
  readonly caseBytes?: Uint8Array;
}): Uint8Array => {
  const parts: Uint8Array[] = [];
  if (args.id !== undefined) parts.push(encodeProtoInt32(1, args.id));
  if (args.execId !== undefined) parts.push(encodeProtoString(15, args.execId));
  parts.push(
    encodeProtoBytes(args.caseField, args.caseBytes ?? new Uint8Array(0)),
  );
  return concatBytes(parts);
};

/**
 * `ExecServerMessage.mcp_state_exec_args` (field 36) payload — hermetic
 * fixture encoder mirroring the verified native schema `McpStateExecArgs`:
 * server_identifiers (field 1, repeated string), kick_only (field 2, bool).
 * A `serverIdentifiers` array of length > 1 models a batched query across
 * multiple configured MCP servers in one exchange.
 */
export const encodeMcpStateExecArgs = (
  args: {
    readonly serverIdentifiers?: ReadonlyArray<string>;
    readonly kickOnly?: boolean;
  } = {},
): Uint8Array =>
  concatBytes([
    ...(args.serverIdentifiers ?? []).map((id) => encodeProtoString(1, id)),
    ...(args.kickOnly !== undefined
      ? [encodeProtoInt32(2, args.kickOnly ? 1 : 0)]
      : []),
  ]);

/**
 * Hermetic fixture encoder for one `google.protobuf.Value`, mirroring the
 * real oneof: null_value(1), number_value(2, fixed64 double), string_value(3),
 * bool_value(4), struct_value(5), list_value(6).
 */
export type TCursorMcpFixtureValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<TCursorMcpFixtureValue>
  | { readonly [key: string]: TCursorMcpFixtureValue };

export const encodeMcpFixtureValue = (
  value: TCursorMcpFixtureValue,
): Uint8Array => {
  if (value === null) return encodeProtoInt32(1, 0);
  if (typeof value === "boolean") {
    return encodeProtoInt32(4, value ? 1 : 0);
  }
  if (typeof value === "number") {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    return encodeKeyedFixed64(2, new Uint8Array(buf));
  }
  if (typeof value === "string") return encodeProtoString(3, value);
  if (Array.isArray(value)) {
    return encodeProtoBytes(
      6,
      concatBytes(
        value.map((v) => encodeProtoBytes(1, encodeMcpFixtureValue(v))),
      ),
    );
  }
  // Struct: repeated MapEntry { key(1) string, value(2) Value } at field 1.
  const entries = Object.entries(
    value as { readonly [key: string]: TCursorMcpFixtureValue },
  );
  const structBytes = concatBytes(
    entries.map(([k, v]) =>
      encodeProtoBytes(
        1,
        concatBytes([
          encodeProtoString(1, k),
          encodeProtoBytes(2, encodeMcpFixtureValue(v)),
        ]),
      ),
    ),
  );
  return encodeProtoBytes(5, structBytes);
};

export const encodeMcpArgsMessage = (args: {
  readonly name: string;
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly providerIdentifier?: string;
  readonly serverIdentifier?: string;
  readonly args?: { readonly [key: string]: TCursorMcpFixtureValue };
}): Uint8Array =>
  concatBytes([
    encodeProtoString(1, args.name),
    ...(args.args !== undefined
      ? Object.entries(args.args).map(([k, v]) =>
          encodeProtoBytes(
            2,
            concatBytes([
              encodeProtoString(1, k),
              encodeProtoBytes(2, encodeMcpFixtureValue(v)),
            ]),
          ),
        )
      : []),
    encodeProtoString(3, args.toolCallId),
    ...(args.providerIdentifier !== undefined
      ? [encodeProtoString(4, args.providerIdentifier)]
      : []),
    encodeProtoString(5, args.toolName ?? args.name),
    ...(args.serverIdentifier !== undefined
      ? [encodeProtoString(9, args.serverIdentifier)]
      : []),
  ]);

/** RequestContextResult.success { request_context } — opaque non-empty context bytes. */
export const encodeRequestContextResultSuccess = (
  requestContextBytes: Uint8Array,
): Uint8Array => {
  if (requestContextBytes.byteLength === 0) {
    throw new CursorCaptureDecodeError(
      "invalid_protobuf",
      "request_context success fixture requires non-empty context bytes",
    );
  }
  const success = encodeProtoBytes(1, requestContextBytes);
  return encodeProtoBytes(1, success);
};

/** ExecClientMessage { id, request_context_result } */
export const encodeExecClientRequestContextResult = (args: {
  readonly id: number;
  readonly execId?: string;
  readonly requestContextBytes: Uint8Array;
}): Uint8Array =>
  concatBytes([
    encodeProtoInt32(1, args.id),
    ...(args.execId !== undefined ? [encodeProtoString(15, args.execId)] : []),
    encodeProtoBytes(
      10,
      encodeRequestContextResultSuccess(args.requestContextBytes),
    ),
  ]);

/**
 * `ExecClientMessage.mcp_state_exec_result` (field 36) — hermetic
 * test/fixture encoder. Real shape is `McpStateExecResult { success |
 * error | rejected }`; tests only need OPAQUE bytes to prove exact
 * byte-for-byte forwarding (the daemon never decodes this content), so
 * `resultBytes` is accepted as-is rather than modeling the full oneof.
 */
export const encodeExecClientMcpStateExecResult = (args: {
  readonly id: number;
  readonly execId?: string;
  readonly resultBytes: Uint8Array;
}): Uint8Array =>
  concatBytes([
    encodeProtoInt32(1, args.id),
    ...(args.execId !== undefined ? [encodeProtoString(15, args.execId)] : []),
    encodeProtoBytes(36, args.resultBytes),
  ]);

/** AgentClientMessage { exec_client_message } */
export const encodeAgentClientExecClientMessage = (
  execClientMessage: Uint8Array,
): Uint8Array => encodeProtoBytes(2, execClientMessage);

/** AgentClientMessage { client_heartbeat } — empty message body (benign duplex keepalive). */
export const encodeAgentClientHeartbeat = (): Uint8Array =>
  encodeProtoBytes(7, new Uint8Array(0));

/**
 * `AgentClientMessage.exec_client_control_message` (field 5) wrapping
 * `ExecClientControlMessage.stream_close` (field 1,
 * `ExecClientStreamClose { id: uint32 field 1 }`) — hermetic test/fixture
 * encoder mirroring the real native wire shape. `id` omitted encodes the
 * proto3 zero default, matching what a real encoder produces for id=0.
 */
export const encodeAgentClientExecStreamClose = (
  args: { readonly id?: number } = {},
): Uint8Array => {
  const streamClose =
    args.id !== undefined ? encodeProtoInt32(1, args.id) : new Uint8Array(0);
  return encodeProtoBytes(5, encodeProtoBytes(1, streamClose));
};

/**
 * AgentClientMessage oneof field tags (artifact 2026.07.23-e383d2b).
 * Metadata only — never log payloads.
 */
export const CURSOR_AGENT_CLIENT_MESSAGE_CASES: ReadonlyArray<
  readonly [field: number, name: string]
> = [
  [1, "run_request"],
  [2, "exec_client_message"],
  [3, "kv_client_message"],
  [4, "conversation_action"],
  [5, "exec_client_control_message"],
  [6, "interaction_response"],
  [7, "client_heartbeat"],
  [8, "prewarm_request"],
] as const;

/**
 * ExecClientMessage.message oneof tags we care about for follow-up triage.
 * Full list is large; unknown tags surface as `exec_client_field_<n>`.
 */
export const CURSOR_EXEC_CLIENT_RESULT_CASES: ReadonlyArray<
  readonly [field: number, name: string]
> = [
  [2, "shell_result"],
  [3, "write_result"],
  [4, "delete_result"],
  [5, "grep_result"],
  [7, "read_result"],
  [8, "ls_result"],
  [9, "diagnostics_result"],
  [10, "request_context_result"],
  [11, "mcp_result"],
  [14, "shell_stream"],
  [16, "background_shell_spawn_result"],
  [20, "fetch_result"],
  [22, "computer_use_result"],
  [27, "execute_hook_result"],
  [28, "subagent_result"],
  [29, "redacted_read_result"],
  [36, "mcp_state_exec_result"],
  [41, "shell_allowlist_precheck_result"],
  [42, "mcp_allowlist_precheck_result"],
  [43, "web_fetch_allowlist_precheck_result"],
] as const;

export type TCursorFollowUpKind =
  | "request_context_result"
  | "kv_client_result"
  /**
   * `ExecClientMessage.mcp_state_exec_result` (field 36) — the builder's
   * REAL, authoritative reply to a server `mcp_state_exec_args` control
   * query (list/kick configured MCP servers). Opaque here on purpose: the
   * daemon never decodes/logs server names, tool schemas, or instructions
   * — it only correlates by numeric id and relays the exact bytes upstream
   * unchanged, exactly like `request_context_result`/KV.
   */
  | "mcp_state_exec_result"
  /**
   * `ExecClientControlMessage.stream_close` (field 1, `ExecClientStreamClose{id}`).
   * The native generic-exec loop writes this unconditionally AFTER every exec
   * result — including the request_context_args/result exchange — so it can
   * arrive queued behind an unrelated later exchange (e.g. a KV control
   * wait). It is NOT auto-approved: the caller must verify `execNumericId`
   * matches the numeric id of an exec exchange it already forwarded in THIS
   * capture before relaying it, and never against an unrelated id
   * namespace (KV ids are a separate space from exec ids).
   */
  | "exec_stream_close"
  | "benign_control"
  | "forbidden_native"
  | "unknown";

/** Metadata-only classification of a builder→daemon follow-up payload. */
export type TCursorFollowUpClassification = {
  readonly kind: TCursorFollowUpKind;
  readonly connectFlags: number | null;
  readonly connectPayloadBytes: number;
  readonly agentClientCase: string | null;
  readonly execClientCase: string | null;
  readonly execId: string | null;
  readonly execNumericId: number | null;
  /** Safe one-line diagnostic — field tags only, no args/paths/content. */
  readonly diagnostic: string;
};

const agentClientCaseOf = (
  fields: ReadonlyArray<TProtoField>,
): { readonly name: string; readonly bytes: Uint8Array } | null => {
  for (const [field, name] of CURSOR_AGENT_CLIENT_MESSAGE_CASES) {
    const bytes = protoMessageField(fields, field);
    if (bytes !== null) return { name, bytes };
  }
  return null;
};

const execClientCaseOf = (
  fields: ReadonlyArray<TProtoField>,
): string | null => {
  for (const [field, name] of CURSOR_EXEC_CLIENT_RESULT_CASES) {
    if (protoMessageField(fields, field) !== null) return name;
  }
  // Unknown oneof member — report field number only.
  for (const f of fields) {
    if (
      f.wire === 2 &&
      f.field !== 1 &&
      f.field !== 15 &&
      f.field !== 39 &&
      f.field !== 45
    ) {
      return `exec_client_field_${f.field}`;
    }
  }
  return null;
};

/**
 * Classify AgentClientMessage bytes (Connect payload, not including the
 * 5-byte Connect header). Never inspects argument/result content — tags only.
 */
export const classifyAgentClientFollowUp = (
  agentClientMessageBytes: Uint8Array,
  connectMeta?: { readonly flags?: number; readonly payloadBytes?: number },
): TCursorFollowUpClassification => {
  const connectFlags = connectMeta?.flags ?? null;
  const connectPayloadBytes =
    connectMeta?.payloadBytes ?? agentClientMessageBytes.byteLength;
  const base = {
    connectFlags,
    connectPayloadBytes,
  };
  try {
    const fields = parseProtoFields(agentClientMessageBytes);
    const agentCase = agentClientCaseOf(fields);
    if (agentCase === null) {
      return {
        ...base,
        kind: "unknown",
        agentClientCase: null,
        execClientCase: null,
        execId: null,
        execNumericId: null,
        diagnostic: `followup unknown_agent_client flags=${connectFlags} bytes=${connectPayloadBytes}`,
      };
    }
    // Benign duplex keepalives / prewarm — skip and keep waiting.
    if (
      agentCase.name === "client_heartbeat" ||
      agentCase.name === "prewarm_request"
    ) {
      return {
        ...base,
        kind: "benign_control",
        agentClientCase: agentCase.name,
        execClientCase: null,
        execId: null,
        execNumericId: null,
        diagnostic: `followup benign ${agentCase.name} flags=${connectFlags} bytes=${connectPayloadBytes}`,
      };
    }
    if (agentCase.name === "exec_client_control_message") {
      // stream_close / throw / heartbeat — heartbeat is benign; stream_close
      // carries a numeric id the CALLER must verify against a known exec
      // exchange (never auto-approved here); throw/unknown reject.
      const ctrlFields = parseProtoFields(agentCase.bytes);
      const heartbeat = protoMessageField(ctrlFields, 3);
      if (heartbeat !== null) {
        return {
          ...base,
          kind: "benign_control",
          agentClientCase: agentCase.name,
          execClientCase: "heartbeat",
          execId: null,
          execNumericId: null,
          diagnostic: `followup benign exec_client_control.heartbeat flags=${connectFlags} bytes=${connectPayloadBytes}`,
        };
      }
      const streamClose = protoMessageField(ctrlFields, 1);
      if (streamClose !== null) {
        // `ExecClientStreamClose { id: uint32 field 1 }` — proto3 implicit
        // presence, so id=0 is validly omitted on the wire (same fix class
        // as the KV ids). Wrong wire type / out-of-range still rejects.
        const scFields = parseProtoFields(streamClose);
        const streamCloseId = protoUint32FieldOrDefault(scFields, 1);
        return {
          ...base,
          kind: "exec_stream_close",
          agentClientCase: agentCase.name,
          execClientCase: "stream_close",
          execId: null,
          execNumericId: streamCloseId,
          diagnostic: `followup exec_client_control.stream_close id=${streamCloseId} flags=${connectFlags} bytes=${connectPayloadBytes}`,
        };
      }
      const ctrl =
        protoMessageField(ctrlFields, 2) !== null ? "throw" : "unknown_control";
      return {
        ...base,
        kind: "forbidden_native",
        agentClientCase: agentCase.name,
        execClientCase: ctrl,
        execId: null,
        execNumericId: null,
        diagnostic: `followup forbidden exec_client_control.${ctrl} flags=${connectFlags} bytes=${connectPayloadBytes}`,
      };
    }
    if (agentCase.name === "kv_client_message") {
      // AgentClientMessage.kv_client_message (field 3, KvClientMessage):
      // id(1), get_blob_result(2: blob_data optional bytes1),
      // set_blob_result(3: error optional1). Metadata only — reports which
      // reply case + its id, never the blob data / error content.
      const kvFields = parseProtoFields(agentCase.bytes);
      // Proto3 implicit presence: KvClientMessage.id is a non-optional
      // uint32, so id=0 is legitimately omitted on the wire by a real
      // encoder — never treat "absent" as "unknown id" (live retest #34).
      const kvId = protoUint32FieldOrDefault(kvFields, 1);
      const getResult = protoMessageField(kvFields, 2);
      const setResult = protoMessageField(kvFields, 3);
      if (getResult !== null && setResult === null) {
        const gf = parseProtoFields(getResult);
        const blobData = protoMessageField(gf, 1);
        return {
          ...base,
          kind: "kv_client_result",
          agentClientCase: agentCase.name,
          execClientCase: "get_blob_result",
          execId: null,
          execNumericId: kvId,
          diagnostic: `followup allow kv_client.get_blob_result id=${kvId} blob_data_len=${blobData?.byteLength ?? 0} flags=${connectFlags} bytes=${connectPayloadBytes}`,
        };
      }
      if (setResult !== null && getResult === null) {
        const sf = parseProtoFields(setResult);
        const hasError = protoMessageField(sf, 1) !== null;
        return {
          ...base,
          kind: "kv_client_result",
          agentClientCase: agentCase.name,
          execClientCase: "set_blob_result",
          execId: null,
          execNumericId: kvId,
          diagnostic: `followup allow kv_client.set_blob_result id=${kvId} has_error=${hasError} flags=${connectFlags} bytes=${connectPayloadBytes}`,
        };
      }
      return {
        ...base,
        kind: "forbidden_native",
        agentClientCase: agentCase.name,
        execClientCase:
          getResult !== null && setResult !== null
            ? "get_blob_result+set_blob_result"
            : "unknown_kv_client_reply",
        execId: null,
        execNumericId: kvId,
        diagnostic: `followup forbidden kv_client_message ambiguous_or_unknown id=${kvId} flags=${connectFlags} bytes=${connectPayloadBytes}`,
      };
    }
    if (agentCase.name !== "exec_client_message") {
      return {
        ...base,
        kind: "forbidden_native",
        agentClientCase: agentCase.name,
        execClientCase: null,
        execId: null,
        execNumericId: null,
        diagnostic: `followup forbidden agent_client.${agentCase.name} flags=${connectFlags} bytes=${connectPayloadBytes}`,
      };
    }
    const execFields = parseProtoFields(agentCase.bytes);
    const execId = protoStringField(execFields, 15);
    // Same proto3 implicit-presence fix as KV ids: `ExecClientMessage.id`
    // is a non-optional uint32, so id=0 is validly omitted on the wire.
    const execNumericId = protoUint32FieldOrDefault(execFields, 1);
    const execCase = execClientCaseOf(execFields);
    if (execCase === "request_context_result") {
      // Ensure no sibling native result fields ride along.
      for (const [field, name] of CURSOR_EXEC_CLIENT_RESULT_CASES) {
        if (field === 10) continue;
        if (protoMessageField(execFields, field) !== null) {
          return {
            ...base,
            kind: "forbidden_native",
            agentClientCase: agentCase.name,
            execClientCase: `${execCase}+${name}`,
            execId,
            execNumericId,
            diagnostic: `followup forbidden request_context_result mixed with ${name} id=${execNumericId} exec_id_len=${execId?.length ?? 0} flags=${connectFlags} bytes=${connectPayloadBytes}`,
          };
        }
      }
      return {
        ...base,
        kind: "request_context_result",
        agentClientCase: agentCase.name,
        execClientCase: execCase,
        execId,
        execNumericId,
        diagnostic: `followup allow request_context_result id=${execNumericId} exec_id_len=${execId?.length ?? 0} flags=${connectFlags} bytes=${connectPayloadBytes}`,
      };
    }
    if (execCase === null) {
      return {
        ...base,
        kind: "unknown",
        agentClientCase: agentCase.name,
        execClientCase: null,
        execId,
        execNumericId,
        diagnostic: `followup unknown empty_exec_client id=${execNumericId} flags=${connectFlags} bytes=${connectPayloadBytes}`,
      };
    }
    if (execCase === "mcp_state_exec_result") {
      // Ensure no sibling native result fields ride along — same guard as
      // request_context_result above.
      for (const [field, name] of CURSOR_EXEC_CLIENT_RESULT_CASES) {
        if (field === 36) continue;
        if (protoMessageField(execFields, field) !== null) {
          return {
            ...base,
            kind: "forbidden_native",
            agentClientCase: agentCase.name,
            execClientCase: `${execCase}+${name}`,
            execId,
            execNumericId,
            diagnostic: `followup forbidden mcp_state_exec_result mixed with ${name} id=${execNumericId} flags=${connectFlags} bytes=${connectPayloadBytes}`,
          };
        }
      }
      return {
        ...base,
        kind: "mcp_state_exec_result",
        agentClientCase: agentCase.name,
        execClientCase: execCase,
        execId,
        execNumericId,
        // Opaque — never decode/report server names, tool schemas, or
        // instructions. Metadata only (id + byte count).
        diagnostic: `followup allow mcp_state_exec_result id=${execNumericId} flags=${connectFlags} bytes=${connectPayloadBytes}`,
      };
    }
    // Allowlist-adjacent protocol results that are NOT request_context /
    // mcp_state_exec — still not forwardable on this bridge.
    if (
      execCase === "diagnostics_result" ||
      execCase === "shell_allowlist_precheck_result" ||
      execCase === "mcp_allowlist_precheck_result" ||
      execCase === "web_fetch_allowlist_precheck_result" ||
      execCase === "execute_hook_result"
    ) {
      return {
        ...base,
        kind: "forbidden_native",
        agentClientCase: agentCase.name,
        execClientCase: execCase,
        execId,
        execNumericId,
        diagnostic: `followup unsupported_control ${execCase} id=${execNumericId} flags=${connectFlags} bytes=${connectPayloadBytes}`,
      };
    }
    return {
      ...base,
      kind: "forbidden_native",
      agentClientCase: agentCase.name,
      execClientCase: execCase,
      execId,
      execNumericId,
      diagnostic: `followup forbidden ${execCase} id=${execNumericId} flags=${connectFlags} bytes=${connectPayloadBytes}`,
    };
  } catch {
    return {
      ...base,
      kind: "unknown",
      agentClientCase: null,
      execClientCase: null,
      execId: null,
      execNumericId: null,
      diagnostic: `followup parse_error flags=${connectFlags} bytes=${connectPayloadBytes}`,
    };
  }
};

/**
 * True when Connect payload bytes are AgentClientMessage.exec_client_message
 * carrying request_context_result (allowlisted follow-up). Prefer
 * {@link classifyAgentClientFollowUp} when diagnostics are needed.
 */
export const isAllowlistedRequestContextFollowUp = (
  agentClientMessageBytes: Uint8Array,
): boolean =>
  classifyAgentClientFollowUp(agentClientMessageBytes).kind ===
  "request_context_result";

/**
 * `AgentServerMessage.kv_server_message` (field 4, `KvServerMessage`) — the
 * real native KV control protocol: id(1, uint32), get_blob_args(2:
 * blob_id bytes1), set_blob_args(3: blob_id bytes1, blob_data bytes2),
 * tracing(4). Metadata-only: reports lengths, never the blob id/data bytes.
 * The caller (`forwardCursorKvControlThroughBuilder`) relays the ORIGINAL
 * envelope bytes unchanged into the live builder — this function never
 * extracts or exposes the actual blob content.
 */
const decodeKvServerMessage = (
  bytes: Uint8Array,
): TCursorDecodedInteraction => {
  const fields = parseProtoFields(bytes);
  const id = protoUint32FieldOrDefault(fields, 1);
  const getArgs = protoMessageField(fields, 2);
  if (getArgs !== null) {
    const gf = parseProtoFields(getArgs);
    const blobId = protoMessageField(gf, 1);
    return {
      kind: "kv_server",
      subtype: "get_blob",
      id,
      blobIdLength: blobId?.byteLength ?? null,
      blobDataLength: null,
    };
  }
  const setArgs = protoMessageField(fields, 3);
  if (setArgs !== null) {
    const sf = parseProtoFields(setArgs);
    const blobId = protoMessageField(sf, 1);
    const blobData = protoMessageField(sf, 2);
    return {
      kind: "kv_server",
      subtype: "set_blob",
      id,
      blobIdLength: blobId?.byteLength ?? null,
      blobDataLength: blobData?.byteLength ?? null,
    };
  }
  if (protoMessageField(fields, 4) !== null) {
    return {
      kind: "kv_server",
      subtype: "tracing",
      id,
      blobIdLength: null,
      blobDataLength: null,
    };
  }
  return {
    kind: "kv_server",
    subtype: "unknown",
    id,
    blobIdLength: null,
    blobDataLength: null,
  };
};

export const decodeAgentServerMessage = (
  bytes: Uint8Array,
): TCursorDecodedInteraction => {
  const fields = parseProtoFields(bytes);
  const interaction = protoMessageField(fields, 1);
  if (interaction !== null) return decodeInteractionUpdate(interaction);
  const execServer = protoMessageField(fields, 2);
  if (execServer !== null) {
    const decoded = decodeExecServerMessage(execServer);
    return {
      kind: "exec_server",
      classification: decoded.classification,
      subtype: decoded.subtype,
      id: decoded.id,
      execId: decoded.execId,
      mcp: decoded.mcp,
    };
  }
  const execServerControl = protoMessageField(fields, 5);
  if (execServerControl !== null) {
    return {
      kind: "requires_duplex",
      messageCase: "exec_server_control_message",
      execSubtype: "abort",
      execClass: "protocol_control",
      tags: describeProtoFieldTags(parseProtoFields(execServerControl)),
    };
  }
  const interactionQuery = protoMessageField(fields, 7);
  if (interactionQuery !== null) {
    return {
      kind: "requires_duplex",
      messageCase: "interaction_query",
      execSubtype: null,
      execClass: "protocol_control",
      tags: describeProtoFieldTags(parseProtoFields(interactionQuery)),
    };
  }
  if (protoMessageField(fields, 3) !== null) {
    return { kind: "ignored", reason: "conversation_checkpoint_update" };
  }
  const kvServer = protoMessageField(fields, 4);
  if (kvServer !== null) {
    return decodeKvServerMessage(kvServer);
  }
  return {
    kind: "ignored",
    reason: `empty_or_unknown_server_message ${describeProtoFieldTags(fields)}`,
  };
};

/**
 * Map a classified ExecServerMessage onto the failure that capture must raise.
 * MCP caller tools are handled by the chunk decoder (emit tool_calls then this).
 */
export const cursorExecServerFailure = (
  decoded: TCursorDecodedExecServerMessage,
): CursorCaptureDecodeError => {
  const tag = `exec_server_message.${decoded.subtype}`;
  if (decoded.classification === "caller_mcp_tool") {
    return new CursorCaptureDecodeError(
      "caller_mcp_tool_cancel",
      `${tag} mapped to caller tool_calls; native MCP execution is not performed`,
      { execSubtype: decoded.subtype, execClass: decoded.classification },
    );
  }
  if (
    decoded.classification === "protocol_control" &&
    decoded.subtype === "request_context_args"
  ) {
    return new CursorCaptureDecodeError(
      "requires_request_context_duplex",
      `${tag}: remote agent protocol requires a BiDi RequestContextResult follow-up before inference can proceed; fabricated RequestContextSuccess is not sent`,
      { execSubtype: decoded.subtype, execClass: decoded.classification },
    );
  }
  if (decoded.classification === "protocol_control") {
    return new CursorCaptureDecodeError(
      "requires_duplex_bridge",
      `${tag}: protocol control requires a truthful ExecClientMessage follow-up (not implemented for this subtype)`,
      { execSubtype: decoded.subtype, execClass: decoded.classification },
    );
  }
  if (decoded.classification === "native_exec") {
    return new CursorCaptureDecodeError(
      "unsupported_native_exec",
      `${tag}: filesystem/shell/native exec is rejected; capture never executes native tools`,
      { execSubtype: decoded.subtype, execClass: decoded.classification },
    );
  }
  return new CursorCaptureDecodeError(
    "requires_duplex_bridge",
    `${tag}: unclassified ExecServerMessage subtype`,
    { execSubtype: decoded.subtype, execClass: decoded.classification },
  );
};

const chunkBase = (
  providerModelId: string,
  created: number,
  id: string,
): Pick<TChatCompletionChunk, "id" | "object" | "created" | "model"> => ({
  id,
  object: "chat.completion.chunk",
  created,
  model: providerModelId,
});

/**
 * Decode a complete Connect response body (zero or more envelopes + optional
 * end-stream) into canonical chat chunks. Throws {@link CursorCaptureDecodeError}
 * on compressed frames, end-stream errors, duplex requirements, or native tools
 * (unless `allowNativeToolIntents` is set).
 */
export const chunksFromCursorConnectResponseBytes = (
  body: Uint8Array,
  args: {
    readonly providerModelId: string;
    readonly allowNativeToolIntents?: boolean;
    readonly chunkId?: string;
    readonly created?: number;
    /** From response `connect-content-encoding` when envelopes may be compressed. */
    readonly connectContentEncoding?: string | null;
  },
): ReadonlyArray<TChatCompletionChunk> => {
  const { envelopes, rest } = takeConnectEnvelopes(body);
  if (rest.byteLength > 0) {
    throw new CursorCaptureDecodeError(
      "truncated_connect_frame",
      `trailing ${rest.byteLength} bytes are not a complete Connect envelope`,
    );
  }

  const created = args.created ?? Math.floor(Date.now() / 1000);
  const id = args.chunkId ?? `cursor-capture-${created}`;
  const chunks: TChatCompletionChunk[] = [];
  let toolIndex = 0;
  const toolIndexByCallId = new Map<string, number>();
  let sawMeaningful = false;
  let tokenSum = 0;

  const ensureToolIndex = (callId: string): number => {
    const existing = toolIndexByCallId.get(callId);
    if (existing !== undefined) return existing;
    const next = toolIndex;
    toolIndexByCallId.set(callId, next);
    toolIndex += 1;
    return next;
  };

  for (const env of envelopes) {
    const payload = resolveConnectEnvelopePayload(
      env,
      args.connectContentEncoding,
    );
    if (env.endStream) {
      const raw = textDecoder.decode(payload);
      if (raw.length === 0 || raw === "{}") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new CursorCaptureDecodeError(
          "connect_end_stream_error",
          `invalid Connect end-stream JSON: ${raw.slice(0, 200)}`,
        );
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        (parsed as { error?: unknown }).error !== undefined &&
        (parsed as { error?: unknown }).error !== null
      ) {
        const err = (parsed as { error: unknown }).error;
        const msg =
          typeof err === "object" &&
          err !== null &&
          typeof (err as { message?: unknown }).message === "string"
            ? (err as { message: string }).message
            : JSON.stringify(err);
        throw new CursorCaptureDecodeError("connect_end_stream_error", msg);
      }
      continue;
    }

    const decoded = decodeAgentServerMessage(payload);
    switch (decoded.kind) {
      case "text_delta": {
        if (decoded.text.length === 0) break;
        sawMeaningful = true;
        chunks.push({
          ...chunkBase(args.providerModelId, created, id),
          choices: [
            {
              index: 0,
              delta: { content: decoded.text },
              finish_reason: null,
            },
          ],
        });
        break;
      }
      case "thinking_delta": {
        if (decoded.text.length === 0) break;
        sawMeaningful = true;
        chunks.push({
          ...chunkBase(args.providerModelId, created, id),
          choices: [
            {
              index: 0,
              delta: { reasoning_content: decoded.text },
              finish_reason: null,
            },
          ],
        });
        break;
      }
      case "mcp_tool_partial":
      case "mcp_tool_started": {
        sawMeaningful = true;
        const intent = decoded.intent;
        const index = ensureToolIndex(intent.callId);
        const argsDelta =
          decoded.kind === "mcp_tool_partial" ? decoded.argsTextDelta : "";
        chunks.push({
          ...chunkBase(args.providerModelId, created, id),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: intent.callId,
                    type: "function",
                    function: {
                      name: intent.name,
                      arguments: argsDelta,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        break;
      }
      case "token_delta": {
        // Untyped single counter — NOT an authoritative prompt/completion split.
        // Do not invent usage.completion_tokens / total_tokens from it.
        tokenSum += decoded.tokens;
        break;
      }
      case "turn_ended": {
        // The real native turn-completion marker (`InteractionUpdate.turn_ended`,
        // field 14) — authoritative independent of Connect transport
        // `endStream`. Treat the turn as meaningfully complete even with zero
        // streamed text (e.g. a tool-only turn), and stop honoring the count
        // separately — the finish chunk below already emits once, driven by
        // `sawMeaningful`.
        sawMeaningful = true;
        break;
      }
      case "exec_server": {
        if (
          decoded.classification === "caller_mcp_tool" &&
          decoded.mcp !== null
        ) {
          sawMeaningful = true;
          const intent = decoded.mcp;
          const index = ensureToolIndex(
            intent.callId || `exec-${decoded.id ?? 0}`,
          );
          chunks.push({
            ...chunkBase(args.providerModelId, created, id),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: intent.callId || `exec-${decoded.id ?? 0}`,
                      type: "function",
                      function: {
                        name: intent.name,
                        arguments: intent.argumentsText,
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }
        throw cursorExecServerFailure({
          id: decoded.id,
          execId: decoded.execId,
          subtype: decoded.subtype,
          classification: decoded.classification,
          mcp: decoded.mcp,
        });
      }
      case "requires_duplex": {
        throw new CursorCaptureDecodeError(
          "requires_duplex_bridge",
          `AgentServerMessage.${decoded.messageCase} requires client duplex follow-up; no-execution bridge not active (${decoded.tags})`,
          {
            execSubtype: decoded.execSubtype,
            execClass: decoded.execClass,
          },
        );
      }
      case "kv_server": {
        // KvServerMessage get/set requires a real native BiDi reply from the
        // live builder's ControlledKvManager (this bulk-decode path has no
        // live IPC to forward into) — never fabricate a cache miss/write ack.
        throw new CursorCaptureDecodeError(
          "requires_kv_control_duplex",
          `AgentServerMessage.kv_server_message.${decoded.subtype} requires client duplex follow-up; no-execution bridge not active (id=${decoded.id})`,
        );
      }
      case "native_tool": {
        // Never silently relabel native intents as caller tools unless explicitly
        // opted in (tests). Production always fails closed.
        if (args.allowNativeToolIntents === true) {
          sawMeaningful = true;
          const index = ensureToolIndex(decoded.callId);
          chunks.push({
            ...chunkBase(args.providerModelId, created, id),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: decoded.callId,
                      type: "function",
                      function: {
                        name: `cursor_native_${decoded.toolCase}`,
                        arguments: "{}",
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          break;
        }
        throw new CursorCaptureDecodeError(
          "unsupported_native_tool_intent",
          `native tool intent ${decoded.toolCase} (call ${decoded.callId}) is not in the caller contract`,
        );
      }
      case "heartbeat":
      case "ignored":
        break;
    }
  }

  const finishReason =
    toolIndexByCallId.size > 0 ? ("tool_calls" as const) : ("stop" as const);
  if (sawMeaningful) {
    chunks.push({
      ...chunkBase(args.providerModelId, created, id),
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
    });
  } else if (tokenSum > 0) {
    // Token deltas alone are not enough to invent a completion — no usage, no
    // finish. Callers treat this as empty meaningful output.
    void tokenSum;
  }
  return chunks;
};

/** Why a tolerant decode stopped before the Connect body was exhausted. */
export type TCursorDecodeBlock = {
  readonly code: TCursorDecodeFailureCode;
  readonly message: string;
  /** Present for `requires_duplex_bridge` / `unsupported_native_tool_intent`. */
  readonly toolCallId: string | null;
};

export type TCursorTolerantDecodeResult = {
  readonly chunks: ReadonlyArray<TChatCompletionChunk>;
  readonly blocked: TCursorDecodeBlock | null;
};

/**
 * Same decode as {@link chunksFromCursorConnectResponseBytes}, but a
 * duplex-required or unsupported-native-tool message stops the decode and
 * returns everything decoded so far (already-seen text / reasoning / caller
 * tool calls) instead of discarding it. Never fabricates a `finish_reason`
 * for the blocked turn — the integrator decides how to surface `blocked`
 * (typically: emit the caller tool call already decoded, if any, and cancel
 * the transaction rather than pretending the turn completed).
 *
 * Compressed frames / truncated Connect / end-stream errors still throw —
 * those are transport failures, not semantic boundaries.
 */
export const chunksFromCursorConnectResponseBytesTolerant = (
  body: Uint8Array,
  args: {
    readonly providerModelId: string;
    readonly chunkId?: string;
    readonly created?: number;
    readonly connectContentEncoding?: string | null;
  },
): TCursorTolerantDecodeResult => {
  const { envelopes, rest } = takeConnectEnvelopes(body);
  if (rest.byteLength > 0) {
    throw new CursorCaptureDecodeError(
      "truncated_connect_frame",
      `trailing ${rest.byteLength} bytes are not a complete Connect envelope`,
    );
  }

  const created = args.created ?? Math.floor(Date.now() / 1000);
  const id = args.chunkId ?? `cursor-capture-${created}`;
  const chunks: TChatCompletionChunk[] = [];
  let toolIndex = 0;
  const toolIndexByCallId = new Map<string, number>();
  let sawMeaningful = false;
  let tokenSum = 0;
  let blocked: TCursorDecodeBlock | null = null;

  const ensureToolIndex = (callId: string): number => {
    const existing = toolIndexByCallId.get(callId);
    if (existing !== undefined) return existing;
    const next = toolIndex;
    toolIndexByCallId.set(callId, next);
    toolIndex += 1;
    return next;
  };

  for (const env of envelopes) {
    if (blocked !== null) break;
    const payload = resolveConnectEnvelopePayload(
      env,
      args.connectContentEncoding,
    );
    if (env.endStream) {
      const raw = textDecoder.decode(payload);
      if (raw.length === 0 || raw === "{}") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new CursorCaptureDecodeError(
          "connect_end_stream_error",
          `invalid Connect end-stream JSON: ${raw.slice(0, 200)}`,
        );
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        (parsed as { error?: unknown }).error !== undefined &&
        (parsed as { error?: unknown }).error !== null
      ) {
        const err = (parsed as { error: unknown }).error;
        const msg =
          typeof err === "object" &&
          err !== null &&
          typeof (err as { message?: unknown }).message === "string"
            ? (err as { message: string }).message
            : JSON.stringify(err);
        throw new CursorCaptureDecodeError("connect_end_stream_error", msg);
      }
      continue;
    }

    const decoded = decodeAgentServerMessage(payload);
    switch (decoded.kind) {
      case "text_delta": {
        if (decoded.text.length === 0) break;
        sawMeaningful = true;
        chunks.push({
          ...chunkBase(args.providerModelId, created, id),
          choices: [
            {
              index: 0,
              delta: { content: decoded.text },
              finish_reason: null,
            },
          ],
        });
        break;
      }
      case "thinking_delta": {
        if (decoded.text.length === 0) break;
        sawMeaningful = true;
        chunks.push({
          ...chunkBase(args.providerModelId, created, id),
          choices: [
            {
              index: 0,
              delta: { reasoning_content: decoded.text },
              finish_reason: null,
            },
          ],
        });
        break;
      }
      case "mcp_tool_partial":
      case "mcp_tool_started": {
        sawMeaningful = true;
        const intent = decoded.intent;
        const index = ensureToolIndex(intent.callId);
        const argsDelta =
          decoded.kind === "mcp_tool_partial" ? decoded.argsTextDelta : "";
        chunks.push({
          ...chunkBase(args.providerModelId, created, id),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: intent.callId,
                    type: "function",
                    function: {
                      name: intent.name,
                      arguments: argsDelta,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        break;
      }
      case "token_delta": {
        // Untyped single counter — omit from OpenAI usage until split is known.
        tokenSum += decoded.tokens;
        break;
      }
      case "turn_ended": {
        // Authoritative native turn-completion marker — see the non-tolerant
        // decode above for the full rationale.
        sawMeaningful = true;
        break;
      }
      case "exec_server": {
        if (
          decoded.classification === "caller_mcp_tool" &&
          decoded.mcp !== null
        ) {
          sawMeaningful = true;
          const intent = decoded.mcp;
          const callId = intent.callId || `exec-${decoded.id ?? 0}`;
          const index = ensureToolIndex(callId);
          chunks.push({
            ...chunkBase(args.providerModelId, created, id),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: callId,
                      type: "function",
                      function: {
                        name: intent.name,
                        arguments: intent.argumentsText,
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }
        {
          const err = cursorExecServerFailure({
            id: decoded.id,
            execId: decoded.execId,
            subtype: decoded.subtype,
            classification: decoded.classification,
            mcp: decoded.mcp,
          });
          blocked = {
            code: err.code,
            message: err.message,
            toolCallId: decoded.mcp?.callId ?? null,
          };
        }
        break;
      }
      case "requires_duplex": {
        blocked = {
          code: "requires_duplex_bridge",
          message: `AgentServerMessage.${decoded.messageCase} requires client duplex follow-up; no-execution bridge not active (${decoded.tags})`,
          toolCallId: null,
        };
        break;
      }
      case "kv_server": {
        blocked = {
          code: "requires_kv_control_duplex",
          message: `AgentServerMessage.kv_server_message.${decoded.subtype} requires client duplex follow-up; no-execution bridge not active (id=${decoded.id})`,
          toolCallId: null,
        };
        break;
      }
      case "native_tool": {
        blocked = {
          code: "unsupported_native_tool_intent",
          message: `native tool intent ${decoded.toolCase} (call ${decoded.callId}) is not in the caller contract`,
          toolCallId: decoded.callId,
        };
        break;
      }
      case "heartbeat":
      case "ignored":
        break;
    }
  }

  // Only emit a finish chunk when the decode completed without a semantic
  // block. A blocked turn leaves the caller to cancel / surface the boundary
  // — inventing `stop` here would look like a completed inference. Never attach
  // fabricated usage from untyped TokenDeltaUpdate.
  if (blocked === null && sawMeaningful) {
    const finishReason =
      toolIndexByCallId.size > 0 ? ("tool_calls" as const) : ("stop" as const);
    chunks.push({
      ...chunkBase(args.providerModelId, created, id),
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
    });
  } else {
    void tokenSum;
  }

  return { chunks, blocked };
};

export const chunksStreamFromCursorConnectResponse = (
  body: Uint8Array,
  args: {
    readonly providerModelId: string;
    readonly allowNativeToolIntents?: boolean;
    readonly signal?: AbortSignal;
  },
): ReadableStream<TChatCompletionChunk> => {
  const chunks = chunksFromCursorConnectResponseBytes(body, args);
  return new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      if (args.signal?.aborted) {
        controller.error(
          args.signal.reason instanceof Error
            ? args.signal.reason
            : new Error("aborted"),
        );
        return;
      }
      const onAbort = (): void => {
        controller.error(new Error("aborted"));
      };
      args.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        for (const chunk of chunks) {
          if (args.signal?.aborted) {
            throw new Error("aborted");
          }
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (err) {
        controller.error(err instanceof Error ? err : new Error(String(err)));
      } finally {
        args.signal?.removeEventListener("abort", onAbort);
      }
    },
    cancel() {
      // Caller cancelled — no vendor loop to feed.
    },
  });
};

/**
 * Stream Connect envelopes from an upstream response body into canonical
 * chunks as each envelope completes. Does not buffer the entire answer first.
 * Semantic blocks (duplex / native tool) error the stream after any prior
 * chunks were already enqueued — callers that need partial+block should use
 * {@link chunksFromCursorConnectResponseBytesTolerant} on a finished body.
 */
export const chunksStreamFromCursorConnectResponseBody = (
  body: ReadableStream<Uint8Array>,
  args: {
    readonly providerModelId: string;
    readonly allowNativeToolIntents?: boolean;
    readonly signal?: AbortSignal;
    /** From response `connect-content-encoding` when envelopes may be compressed. */
    readonly connectContentEncoding?: string | null;
  },
): ReadableStream<TChatCompletionChunk> => {
  const created = Math.floor(Date.now() / 1000);
  const id = `cursor-capture-${created}`;
  // CodeRabbit round 5: `reader` used to be declared INSIDE `start()`, so
  // the underlying source's own `cancel()` callback (invoked when the
  // CONSUMER of this stream cancels it — a separate signal from
  // `args.signal`) had no way to reach it at all and was a no-op. A
  // consumer cancel then left a pending `reader.read()` on the real
  // upstream body dangling — never unblocked, never released — until the
  // underlying connection happened to close on its own. Declared here,
  // above both `start` and `cancel`, so both can act on the SAME reader.
  const reader = body.getReader();
  let readerCancelled = false;
  const cancelReader = (reason: unknown): void => {
    if (readerCancelled) return;
    readerCancelled = true;
    try {
      // `.cancel()` returns a promise; a caller/consumer cancel is fire-
      // and-forget from this source's perspective — never await it here,
      // and never let a rejection from an already-cancelled/errored reader
      // propagate as an unhandled rejection.
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // ignore — reader may already be released/cancelled
    }
  };
  return new ReadableStream<TChatCompletionChunk>({
    async start(controller) {
      if (args.signal?.aborted) {
        const reason =
          args.signal.reason instanceof Error
            ? args.signal.reason
            : new Error("aborted");
        cancelReader(reason);
        reader.releaseLock();
        controller.error(reason);
        return;
      }
      const onAbort = (): void => {
        const reason =
          args.signal?.reason instanceof Error
            ? args.signal.reason
            : new Error("aborted");
        // Unblock a genuinely pending `reader.read()` immediately — never
        // leave it dangling on the real upstream body — and error the
        // outer stream with the SAME reason, not a generic re-wrap.
        cancelReader(reason);
        controller.error(reason);
      };
      args.signal?.addEventListener("abort", onAbort, { once: true });
      let pending = new Uint8Array(0);
      let toolIndex = 0;
      const toolIndexByCallId = new Map<string, number>();
      let sawMeaningful = false;
      let closed = false;

      const ensureToolIndex = (callId: string): number => {
        const existing = toolIndexByCallId.get(callId);
        if (existing !== undefined) return existing;
        const next = toolIndex;
        toolIndexByCallId.set(callId, next);
        toolIndex += 1;
        return next;
      };

      const emitDecoded = (decoded: TCursorDecodedInteraction): void => {
        switch (decoded.kind) {
          case "text_delta": {
            if (decoded.text.length === 0) return;
            sawMeaningful = true;
            controller.enqueue({
              ...chunkBase(args.providerModelId, created, id),
              choices: [
                {
                  index: 0,
                  delta: { content: decoded.text },
                  finish_reason: null,
                },
              ],
            });
            return;
          }
          case "thinking_delta": {
            if (decoded.text.length === 0) return;
            sawMeaningful = true;
            controller.enqueue({
              ...chunkBase(args.providerModelId, created, id),
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: decoded.text },
                  finish_reason: null,
                },
              ],
            });
            return;
          }
          case "mcp_tool_partial":
          case "mcp_tool_started": {
            sawMeaningful = true;
            const intent = decoded.intent;
            const index = ensureToolIndex(intent.callId);
            const argsDelta =
              decoded.kind === "mcp_tool_partial" ? decoded.argsTextDelta : "";
            controller.enqueue({
              ...chunkBase(args.providerModelId, created, id),
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index,
                        id: intent.callId,
                        type: "function",
                        function: {
                          name: intent.name,
                          arguments: argsDelta,
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
            return;
          }
          case "token_delta":
            // Untyped — omit usage.
            return;
          case "turn_ended":
            // Authoritative native turn-completion marker — handled by the
            // caller immediately after this call returns (finishes the
            // stream without waiting for a Connect `endStream` envelope or
            // socket close).
            sawMeaningful = true;
            return;
          case "exec_server": {
            if (
              decoded.classification === "caller_mcp_tool" &&
              decoded.mcp !== null
            ) {
              sawMeaningful = true;
              const intent = decoded.mcp;
              const callId = intent.callId || `exec-${decoded.id ?? 0}`;
              const index = ensureToolIndex(callId);
              controller.enqueue({
                ...chunkBase(args.providerModelId, created, id),
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: callId,
                          type: "function",
                          function: {
                            name: intent.name,
                            arguments: intent.argumentsText,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            }
            throw cursorExecServerFailure({
              id: decoded.id,
              execId: decoded.execId,
              subtype: decoded.subtype,
              classification: decoded.classification,
              mcp: decoded.mcp,
            });
          }
          case "requires_duplex":
            throw new CursorCaptureDecodeError(
              "requires_duplex_bridge",
              `AgentServerMessage.${decoded.messageCase} requires client duplex follow-up; no-execution bridge not active (${decoded.tags})`,
              {
                execSubtype: decoded.execSubtype,
                execClass: decoded.execClass,
              },
            );
          case "kv_server":
            throw new CursorCaptureDecodeError(
              "requires_kv_control_duplex",
              `AgentServerMessage.kv_server_message.${decoded.subtype} requires client duplex follow-up; no-execution bridge not active (id=${decoded.id})`,
            );
          case "native_tool":
            if (args.allowNativeToolIntents === true) {
              sawMeaningful = true;
              const index = ensureToolIndex(decoded.callId);
              controller.enqueue({
                ...chunkBase(args.providerModelId, created, id),
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: decoded.callId,
                          type: "function",
                          function: {
                            name: `cursor_native_${decoded.toolCase}`,
                            arguments: "{}",
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
              return;
            }
            throw new CursorCaptureDecodeError(
              "unsupported_native_tool_intent",
              `native tool intent ${decoded.toolCase} (call ${decoded.callId}) is not in the caller contract`,
            );
          case "heartbeat":
          case "ignored":
            return;
        }
      };

      let turnEndedSeen = false;
      // CodeRabbit round 3: a clean socket close (`done`) was previously
      // treated as a successful completion whenever ANY meaningful output
      // had streamed, with no check that a genuine terminal marker
      // (`endStream` envelope or `turn_ended`) was ever actually observed —
      // the same fabricated-success class of bug already fixed on the H2
      // duplex path, but this HTTP1/general decode path had no equivalent
      // guard. `sawEndStream` closes that gap.
      let sawEndStream = false;
      let transportEof = false;
      try {
        readLoop: for (;;) {
          if (args.signal?.aborted) throw new Error("aborted");
          const { value, done } = await reader.read();
          if (done) {
            transportEof = true;
            if (!turnEndedSeen && !sawEndStream) {
              throw new Error(
                "cursor capture upstream closed without a terminal Connect end-stream marker or turn_ended",
              );
            }
            break;
          }
          const next = new Uint8Array(pending.byteLength + value.byteLength);
          next.set(pending, 0);
          next.set(value, pending.byteLength);
          // Strict: `pending` accumulates across repeated live reads, so an
          // oversized declared length must fail the instant its 5-byte
          // header is visible — never tolerated as "incomplete" while this
          // buffer keeps growing (CodeRabbit round 2).
          const taken = takeConnectEnvelopesStrict(next);
          // Copy the unconsumed tail into a fresh ArrayBuffer-backed
          // Uint8Array — `subarray` views are `Uint8Array<ArrayBufferLike>`
          // under TS 5.7+ DOM libs and are not assignable to
          // `Uint8Array<ArrayBuffer>` without an unsafe cast.
          pending = new Uint8Array(taken.rest);
          for (const env of taken.envelopes) {
            const payload = resolveConnectEnvelopePayload(
              env,
              args.connectContentEncoding,
            );
            if (env.endStream) {
              // Genuine native/transport terminal marker — mark it BEFORE
              // any trailer-shape branch below, so even an empty/`{}`
              // trailer still counts as having seen it.
              sawEndStream = true;
              const raw = textDecoder.decode(payload);
              if (raw.length === 0 || raw === "{}") continue;
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch {
                throw new CursorCaptureDecodeError(
                  "connect_end_stream_error",
                  `invalid Connect end-stream JSON: ${raw.slice(0, 200)}`,
                );
              }
              if (
                typeof parsed === "object" &&
                parsed !== null &&
                "error" in parsed &&
                (parsed as { error?: unknown }).error != null
              ) {
                const err = (parsed as { error: unknown }).error;
                const msg =
                  typeof err === "object" &&
                  err !== null &&
                  typeof (err as { message?: unknown }).message === "string"
                    ? (err as { message: string }).message
                    : JSON.stringify(err);
                throw new CursorCaptureDecodeError(
                  "connect_end_stream_error",
                  msg,
                );
              }
              continue;
            }
            const decoded = decodeAgentServerMessage(payload);
            emitDecoded(decoded);
            if (decoded.kind === "turn_ended") {
              // Genuine native completion marker — finish now, independent
              // of Connect `endStream` or the socket closing. A transport
              // close/error observed AFTER this point is benign (matches the
              // official client's "Ignoring transport close after terminal
              // agent stream").
              turnEndedSeen = true;
              break readLoop;
            }
          }
        }
        if (!turnEndedSeen && pending.byteLength > 0) {
          throw new CursorCaptureDecodeError(
            "truncated_connect_frame",
            `trailing ${pending.byteLength} bytes are not a complete Connect envelope`,
          );
        }
        if (sawMeaningful) {
          controller.enqueue({
            ...chunkBase(args.providerModelId, created, id),
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason:
                  toolIndexByCallId.size > 0 ? "tool_calls" : "stop",
              },
            ],
          });
        }
        closed = true;
        controller.close();
      } catch (err) {
        if (!closed) {
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        args.signal?.removeEventListener("abort", onAbort);
        if (!transportEof)
          cancelReader(
            new Error("cursor capture decoder finished before transport EOF"),
          );
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    },
    cancel(reason) {
      // CodeRabbit round 5: the CONSUMER cancelling this stream is a
      // separate signal from `args.signal` aborting — it must ALSO unblock
      // a pending `reader.read()` on the real upstream body, never leave it
      // dangling. `start()`'s own `finally` still releases the lock once
      // that pending read settles.
      cancelReader(
        reason instanceof Error ? reason : new Error("consumer cancelled"),
      );
    },
  });
};

/**
 * Decode a daemon-owned upstream `Response` from a captured AgentService
 * exchange. Streams envelopes as they arrive (does not buffer the full body
 * by default).
 */
export const chunksFromCursorCapturedResponse = (
  response: Response,
  args: {
    readonly providerModelId: string;
    readonly allowNativeToolIntents?: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<ReadableStream<TChatCompletionChunk>> => {
  if (response.body === null) {
    return Promise.resolve(
      new ReadableStream<TChatCompletionChunk>({
        start(controller) {
          controller.close();
        },
      }),
    );
  }
  return Promise.resolve(
    chunksStreamFromCursorConnectResponseBody(response.body, args),
  );
};
