/**
 * Local-first media-default handoff helpers. The cloud owns selection;
 * this module only classifies an omitted vs explicit model, builds the
 * metadata-only plan query, and materializes the verified plan's first
 * hop into the inbound body so walkers/BYOK passthrough see a concrete
 * model. Never sends prompt/file/audio bytes to the cloud.
 */

import type {
  TMediaDefaultRequest,
  TMediaDefaultSurface,
} from "@openllmsh/protocol";
import {
  decodeMediaModelSelection,
  mediaDefaultRequestFromBody,
} from "@openllmsh/protocol";
import type { TParsedMultipart } from "./multipart";
import { serializeMultipartWithFields } from "./multipart";

export type TModelField =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "explicit"; readonly value: string };

export const classifyModelField = (value: unknown): TModelField => {
  try {
    const { model } = decodeMediaModelSelection({ model: value });
    return model === undefined
      ? { kind: "absent" }
      : { kind: "explicit", value: model };
  } catch {
    return { kind: "invalid" };
  }
};

export const modelFieldFromRequest = (
  rawBody: unknown,
  multipart: TParsedMultipart | null,
): TModelField => {
  if (
    rawBody !== null &&
    typeof rawBody === "object" &&
    !Array.isArray(rawBody)
  ) {
    return classifyModelField((rawBody as { model?: unknown }).model);
  }
  if (multipart !== null) {
    const field = multipart.fields.model;
    return field === undefined ? { kind: "absent" } : classifyModelField(field);
  }
  return { kind: "absent" };
};

export const mediaDefaultSurfaceFor = (args: {
  readonly isImages: boolean;
  readonly isImageEdits: boolean;
  readonly isTranscriptions: boolean;
  readonly isSpeech: boolean;
  readonly isVideoCreate: boolean;
}): TMediaDefaultSurface | null => {
  if (args.isImages) return "image";
  if (args.isImageEdits) return "image_edit";
  if (args.isTranscriptions) return "transcription";
  if (args.isSpeech) return "speech";
  if (args.isVideoCreate) return "video";
  return null;
};

const jsonRecord = (rawBody: unknown): Record<string, unknown> | null => {
  if (
    rawBody === null ||
    typeof rawBody !== "object" ||
    Array.isArray(rawBody)
  ) {
    return null;
  }
  return rawBody as Record<string, unknown>;
};

const CONTENT_KEYS = new Set([
  "prompt",
  "file",
  "input",
  "image",
  "images",
  "mask",
  "messages",
  "input_image",
  "reference_images",
  "reference_voices",
]);

const metadataBody = (
  raw: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (CONTENT_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
};

const DATA_URL_RE = /^data:([^;,]*);base64,(.*)$/s;

const audioInspectFromJsonFile = (
  file: string,
): { bytes: Uint8Array; contentType?: string } | undefined => {
  const match = DATA_URL_RE.exec(file);
  if (match === null) return undefined;
  try {
    const binary = atob(match[2] ?? "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const contentType = match[1];
    return contentType !== undefined && contentType.length > 0
      ? { bytes, contentType }
      : { bytes };
  } catch {
    return undefined;
  }
};

export const buildMediaDefaultRequest = (
  surface: TMediaDefaultSurface,
  rawBody: unknown,
  multipart: TParsedMultipart | null,
): TMediaDefaultRequest | null => {
  // Validate and derive bounded requirements before content is removed.
  if (surface === "video") return mediaDefaultRequestFromBody(surface, rawBody);
  const body = jsonRecord(rawBody) ?? {};
  const audioFile = multipart?.files.find((file) => file.fieldName === "file");
  const jsonAudio =
    typeof body.file === "string"
      ? audioInspectFromJsonFile(body.file)
      : undefined;
  const audio =
    audioFile !== undefined
      ? {
          bytes: audioFile.bytes,
          contentType: audioFile.contentType,
          filename: audioFile.filename,
        }
      : jsonAudio;
  const metadata = metadataBody(body);
  if (multipart !== null) {
    for (const [key, value] of Object.entries(multipart.fields)) {
      if (CONTENT_KEYS.has(key) || key === "model") continue;
      metadata[key] = value;
    }
  }
  return mediaDefaultRequestFromBody(surface, metadata, audio);
};

/** First `provider/model` hop of a signed plan — the cloud's selected model. */
export const selectedModelFromPlan = (plan: string): string | null => {
  const first = plan
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  return first ?? null;
};

export type TMaterializedMediaBody = {
  readonly rawBody: unknown;
  readonly rawBytes: ArrayBuffer;
  readonly multipart: TParsedMultipart | null;
  readonly contentType: string | null;
};

export const materializeSelectedModel = async (args: {
  readonly model: string;
  readonly rawBody: unknown;
  readonly rawBytes: ArrayBuffer;
  readonly multipart: TParsedMultipart | null;
  readonly requestContentType: string;
}): Promise<TMaterializedMediaBody> => {
  if (args.multipart !== null) {
    const serialized = await serializeMultipartWithFields(args.multipart, {
      model: args.model,
    });
    return {
      rawBody: args.rawBody,
      rawBytes: serialized.bytes,
      multipart: {
        fields: { ...args.multipart.fields, model: args.model },
        files: args.multipart.files,
      },
      contentType: serialized.contentType,
    };
  }
  const record = jsonRecord(args.rawBody) ?? {};
  const nextBody = { ...record, model: args.model };
  const encoded = new TextEncoder().encode(JSON.stringify(nextBody));
  return {
    rawBody: nextBody,
    rawBytes: encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer,
    multipart: null,
    contentType: "application/json",
  };
};
