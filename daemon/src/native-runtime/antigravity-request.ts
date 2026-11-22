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
