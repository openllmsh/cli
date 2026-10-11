/**
 * Bounded raw multipart/form-data normalization for the local `/v1/*`
 * listener. Audio uploads (`/v1/audio/transcriptions`) and inline image
 * edits (`/v1/images/edits`) can arrive as `multipart/form-data`, but the
 * listener's body pipeline was JSON-only (`req.arrayBuffer()` +
 * `JSON.parse`). This module turns an already-collected, size-bounded body
 * (see `collectBoundedBytes` in `@openllmsh/tunnel`) into a plain
 * `{fields, files}` shape any walker can consume without re-touching the
 * request stream — the ORIGINAL bytes stay available to the caller
 * separately for cloud passthrough / signature purposes.
 */

/** One uploaded file field from a parsed multipart body. */
export type TParsedMultipartFile = {
  readonly fieldName: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly bytes: Uint8Array;
};

/** A multipart body reduced to its string fields and file parts. */
export type TParsedMultipart = {
  readonly fields: Readonly<Record<string, string>>;
  readonly files: ReadonlyArray<TParsedMultipartFile>;
};

/**
 * Parse a `FormData` (already decoded from bounded bytes — see
 * `parseMultipartBytes`) into `{fields, files}`. A field appearing more than
 * once keeps its LAST value/entry — mirrors `FormData.get` semantics used
 * elsewhere in this codebase (`audio-transcription.ts`'s multipart branch).
 */
export const parseMultipartFormData = async (
  form: FormData,
): Promise<TParsedMultipart> => {
  const fields: Record<string, string> = {};
  // `.forEach` rather than `for...of form.entries()` — the latter's
  // destructured tuple type collapses to `never` under this repo's
  // bun-types + DOM lib combination (a known FormData iterator-typing
  // conflict); `forEach`'s callback signature types `value` correctly.
  const filePromises: Array<Promise<TParsedMultipartFile>> = [];
  form.forEach((value, key) => {
    if (typeof value === "string") {
      fields[key] = value;
      return;
    }
    const file = value;
    filePromises.push(
      file.arrayBuffer().then(
        (buf): TParsedMultipartFile => ({
          fieldName: key,
          ...(file.name.length > 0 ? { filename: file.name } : {}),
          ...(file.type.length > 0 ? { contentType: file.type } : {}),
          bytes: new Uint8Array(buf),
        }),
      ),
    );
  });
  const files = await Promise.all(filePromises);
  return { fields, files };
};

/**
 * Decode already-collected, size-bounded multipart bytes using the
 * inbound `content-type` (which carries the boundary). Throws the same way
 * `Request.formData()` would on a malformed body — callers convert that into
 * a clean 400.
 */
export const parseMultipartBytes = async (
  bytes: Uint8Array,
  contentType: string,
): Promise<TParsedMultipart> => {
  // `new Uint8Array(bytes)` forces a concrete `Uint8Array<ArrayBuffer>` —
  // `bytes` alone may type as `Uint8Array<ArrayBufferLike>` (e.g. a slice of
  // a collected buffer), which this repo's stricter typed-array generics
  // reject as a `BodyInit`.
  const form = await new Response(new Uint8Array(bytes), {
    headers: { "content-type": contentType },
  }).formData();
  return parseMultipartFormData(form);
};

/** The single file for a named field, or `undefined` if absent. Multiple
 *  files under the same field name keep the FIRST (the upload slot), unlike
 *  `parseMultipartFormData`'s last-value-wins for string fields. */
export const multipartFile = (
  parsed: TParsedMultipart,
  fieldName: string,
): TParsedMultipartFile | undefined =>
  parsed.files.find((file) => file.fieldName === fieldName);

/**
 * Re-serialize a parsed multipart body with extra/overridden string fields
 * (used to inject a cloud-selected `model` into a model-less upload). Uses
 * the platform FormData serializer so quotes/CRLF in names cannot inject
 * extra parts. The original inbound Content-Type/boundary/Content-Length
 * MUST NOT be reused.
 */
export const serializeMultipartWithFields = async (
  parsed: TParsedMultipart,
  extraFields: Readonly<Record<string, string>>,
): Promise<{ readonly bytes: ArrayBuffer; readonly contentType: string }> => {
  const form = new FormData();
  const fields = { ...parsed.fields, ...extraFields };
  for (const [name, value] of Object.entries(fields)) {
    form.set(name, value);
  }
  for (const file of parsed.files) {
    const filename = file.filename ?? "blob";
    const type = file.contentType ?? "application/octet-stream";
    form.append(
      file.fieldName,
      new File([new Uint8Array(file.bytes)], filename, { type }),
    );
  }
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type");
  if (contentType === null || !contentType.includes("multipart/form-data")) {
    throw new Error("failed to serialize multipart body");
  }
  const bytes = await encoded.arrayBuffer();
  return { bytes, contentType };
};
