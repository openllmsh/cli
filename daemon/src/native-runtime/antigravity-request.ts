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
import { storeAgyImage } from "./antigravity-attachments";

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

export const agyImageView = (
  canonical: TChatCompletionRequest,
  dir?: string,
): TAgyImageView => {
  const paths = new Set<string>();
  let refused: string | null = null;
  const messages = canonical.messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        const p = part as {
          readonly type?: unknown;
          readonly image_url?: { readonly url?: unknown };
        };
        if (p.type !== "image_url") return part;
        const url = p.image_url?.url;
        const stored = typeof url === "string" ? storeAgyImage(url, dir) : null;
        if (stored === null) {
          refused ??= IMAGE_REFUSAL;
          return part;
        }
        paths.add(stored);
        return { type: "text" as const, text: `\n${agyImageLine(stored)}\n` };
      }),
    } as typeof message;
  });
  if (refused !== null) return { kind: "declined", reason: refused };
  return { kind: "view", canonical: { ...canonical, messages }, paths };
};

/** Why the request's images can't go to `agy` (ACP image blocks), or null.
 *  The same rule as the headless view: every image is a `data:` URL whose
 *  bytes really are the PNG, JPEG, GIF or WebP it declares. An http(s) URL
 *  would otherwise reach the model as plain text it can't see. */
export const agyAcpImageRefusal = (
  canonical: TChatCompletionRequest,
): string | null => {
  for (const message of canonical.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const p = part as {
        readonly type?: unknown;
        readonly image_url?: { readonly url?: unknown };
      };
      if (p.type !== "image_url") continue;
      const url = p.image_url?.url;
      const m = typeof url === "string" ? url.match(ACP_DATA_URL) : null;
      const declared = m?.[1]?.trim().toLowerCase();
      const inspected =
        m?.[2] === undefined
          ? null
          : inspectImageBytes(new Uint8Array(Buffer.from(m[2], "base64")));
      const canon = declared === "image/jpg" ? "image/jpeg" : declared;
      if (inspected === null || canon !== inspected.mime) {
        return IMAGE_REFUSAL;
      }
    }
  }
  return null;
};

const ACP_DATA_URL = /^data:([^;,]+);base64,(.+)$/s;
const IMAGE_REFUSAL =
  "antigravity: images must be data: URLs of a PNG, JPEG, GIF or WebP";

/** The largest linked image fetched for `agy`. */
export const AGY_REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** The longest one linked-image fetch may take. */
export const AGY_REMOTE_IMAGE_TIMEOUT_MS = 15_000;

/** Hosts a linked image must never be fetched from (the daemon runs on the
 *  user's machine: no loopback, link-local or private-network targets). */
const isPrivateHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return true;
  }
  if (
    h === "::1" ||
    h.startsWith("fe80:") ||
    h.startsWith("fc") ||
    h.startsWith("fd")
  ) {
    return true;
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

/** One linked image as a `data:` URL, or null when it can't be used. */
const fetchImageAsDataUrl = async (
  url: string,
  fetchImpl: typeof fetch,
): Promise<string | null> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || isPrivateHost(parsed.hostname)) {
    return null;
  }
  try {
    const res = await fetchImpl(parsed, {
      redirect: "follow",
      signal: AbortSignal.timeout(AGY_REMOTE_IMAGE_TIMEOUT_MS),
    });
    const finalUrl = new URL(res.url || parsed.href);
    if (
      !res.ok ||
      finalUrl.protocol !== "https:" ||
      isPrivateHost(finalUrl.hostname) ||
      res.body === null
    ) {
      return null;
    }
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
  for (const message of canonical.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const p = part as {
        readonly type?: unknown;
        readonly image_url?: { readonly url?: unknown };
      };
      const url = p.image_url?.url;
      if (
        p.type === "image_url" &&
        typeof url === "string" &&
        /^https:/i.test(url)
      ) {
        urls.add(url);
      }
    }
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
  const messages = canonical.messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        const p = part as {
          readonly type?: unknown;
          readonly image_url?: {
            readonly url?: unknown;
            readonly detail?: unknown;
          };
        };
        const url = p.image_url?.url;
        const data =
          p.type === "image_url" && typeof url === "string"
            ? resolved.get(url)
            : undefined;
        return data === undefined
          ? part
          : { ...part, image_url: { ...p.image_url, url: data } };
      }),
    } as typeof message;
  });
  return { ...canonical, messages };
};
