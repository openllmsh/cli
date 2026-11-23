/**
 * The Antigravity request view for the headless `agy` CLI (`serve.ts`):
 * every `image_url` part becomes one stable text line, `[image: <path>]`,
 * naming the image's bytes stored under their hash
 * (`antigravity-attachments.ts`). `agy` opens the path with its own
 * `read_file`; the same image always renders the same line, so a resent
 * conversation hashes (and is cached upstream) the same on every turn.
 */

import type { TChatCompletionRequest } from "@openllmsh/sdk/protocol";
import { inspectImageBytes } from "@openllmsh/sdk/wire/lib/canonical/image-signature";
import { parseAgyImageDataUrl, storeAgyImage } from "./antigravity-attachments";

export type TAgyImageView =
  | {
      readonly kind: "view";
      /** The request with images replaced by their path lines. */
      readonly canonical: TChatCompletionRequest;
      /** Every stored image path the request names (the turn may open). */
      readonly paths: ReadonlySet<string>;
    }
  | { readonly kind: "declined"; readonly reason: string };

/** The line standing in for one stored image. */
export const agyImageLine = (path: string): string => `[image: ${path}]`;

type TImagePart = {
  readonly type?: unknown;
  readonly image_url?: { readonly url?: unknown };
};

/** Every `image_url` part's URL (null when it isn't a string), in order. */
const imageUrlsOf = (canonical: TChatCompletionRequest): (string | null)[] => {
  const urls: (string | null)[] = [];
  for (const message of canonical.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const p = part as TImagePart;
      const url = p.image_url?.url;
      if (p.type === "image_url")
        urls.push(typeof url === "string" ? url : null);
    }
  }
  return urls;
};

/** The request with each `image_url` part replaced by `fn(part, url)` (a
 *  part whose URL isn't a string is passed with `null`). */
const mapImageParts = (
  canonical: TChatCompletionRequest,
  fn: (part: unknown, url: string | null) => unknown,
): TChatCompletionRequest => ({
  ...canonical,
  messages: canonical.messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        const p = part as TImagePart;
        if (p.type !== "image_url") return part;
        const url = p.image_url?.url;
        return fn(part, typeof url === "string" ? url : null);
      }),
    } as typeof message;
  }),
});

export const hasAgyImages = (canonical: TChatCompletionRequest): boolean =>
  imageUrlsOf(canonical).length > 0;

export const agyImageView = (
  canonical: TChatCompletionRequest,
  dir?: string,
): TAgyImageView => {
  const paths = new Set<string>();
  let refused: string | null = null;
  const view = mapImageParts(canonical, (part, url) => {
    const stored = url === null ? null : storeAgyImage(url, dir);
    if (stored === null) {
      refused ??= IMAGE_REFUSAL;
      return part;
    }
    paths.add(stored);
    return { type: "text" as const, text: `\n${agyImageLine(stored)}\n` };
  });
  if (refused !== null) return { kind: "declined", reason: refused };
  return { kind: "view", canonical: view, paths };
};

/** Why the request's images can't go to `agy` (ACP image blocks), or null.
 *  The same rule as the headless view: every image is a `data:` URL whose
 *  bytes really are the PNG, JPEG, GIF or WebP it declares. An http(s) URL
 *  would otherwise reach the model as plain text it can't see. */
export const agyAcpImageRefusal = (
  canonical: TChatCompletionRequest,
): string | null => {
  for (const url of imageUrlsOf(canonical)) {
    if (url === null || parseAgyImageDataUrl(url) === null) {
      return IMAGE_REFUSAL;
    }
  }
  return null;
};

const IMAGE_REFUSAL =
  "antigravity: images must be data: URLs of a PNG, JPEG, GIF or WebP";

/** The largest linked image fetched for `agy`. */
export const AGY_REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** The longest one linked-image fetch may take. */
export const AGY_REMOTE_IMAGE_TIMEOUT_MS = 15_000;

/** Hosts a linked image must never be fetched from (the daemon runs on the
 *  user's machine: no loopback, link-local or private-network targets). */
export const isPrivateHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return true;
  }
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) {
      return true;
    }
    // IPv4-mapped (::ffff:a.b.c.d, or the hex form ::ffff:7f00:1).
    const mapped = h.match(/^(?:0:0:0:0:0:|::)ffff:(.+)$/);
    if (mapped?.[1] !== undefined) {
      const tail = mapped[1];
      if (tail.includes(".")) return isPrivateHost(tail);
      const hex = tail.split(":");
      if (hex.length === 2) {
        const hi = Number.parseInt(hex[0] ?? "", 16);
        const lo = Number.parseInt(hex[1] ?? "", 16);
        return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
      return true;
    }
    return false;
  }
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4 === null) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

const MAX_REDIRECTS = 3;

/** One linked image as a `data:` URL, or null when it can't be used. */
const fetchImageAsDataUrl = async (
  url: string,
  fetchImpl: typeof fetch,
): Promise<string | null> => {
  try {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return null;
    }
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (target.protocol !== "https:" || isPrivateHost(target.hostname)) {
        return null;
      }
      res = await fetchImpl(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(AGY_REMOTE_IMAGE_TIMEOUT_MS),
      });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (location === null || hop === MAX_REDIRECTS) return null;
      try {
        target = new URL(location, target);
      } catch {
        return null;
      }
      res = null;
    }
    if (res === null || !res.ok || res.body === null) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > AGY_REMOTE_IMAGE_MAX_BYTES) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > AGY_REMOTE_IMAGE_MAX_BYTES) return null;
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const inspected = inspectImageBytes(bytes);
    if (inspected === null) return null;
    return `data:${inspected.mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
};

/**
 * Inline every linked (`https://`) image in the request as a `data:` URL, so
 * `agy` — which only takes image bytes — can see it. Browser chat uploads an
 * attachment and sends its link. Fetched once per distinct URL, https only,
 * never from a private or loopback host, at most
 * {@link AGY_REMOTE_IMAGE_MAX_BYTES} within {@link AGY_REMOTE_IMAGE_TIMEOUT_MS},
 * and the bytes must really be a PNG, JPEG, GIF or WebP. An image that can't
 * be fetched is left as is (the image check then declines the hop).
 */
export const inlineRemoteImages = async (
  canonical: TChatCompletionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TChatCompletionRequest> => {
  const urls = new Set<string>();
  for (const url of imageUrlsOf(canonical)) {
    if (url !== null && /^https:/i.test(url)) urls.add(url);
  }
  if (urls.size === 0) return canonical;
  const resolved = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (url) => {
      const data = await fetchImageAsDataUrl(url, fetchImpl);
      if (data !== null) resolved.set(url, data);
    }),
  );
  if (resolved.size === 0) return canonical;
  return mapImageParts(canonical, (part, url) => {
    const data = url === null ? undefined : resolved.get(url);
    if (data === undefined) return part;
    const p = part as { readonly image_url?: object };
    return { ...p, image_url: { ...p.image_url, url: data } };
  });
};
