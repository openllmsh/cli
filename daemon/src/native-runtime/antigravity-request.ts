/**
 * The Antigravity request view for the headless `agy` CLI (`serve.ts`):
 * every `image_url` part becomes one stable text line, `[image: <path>]`,
 * naming the image's bytes stored under their hash
 * (`antigravity-attachments.ts`). `agy` opens the path with its own
 * `read_file`; the same image always renders the same line, so a resent
 * conversation hashes (and is cached upstream) the same on every turn.
 */

import type { TChatCompletionRequest } from "@openllmsh/sdk/protocol";
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

/** Image input needs the chat `agy`'s Seatbelt confinement (macOS). */
export const agyImageInputSupported = (
  platform: NodeJS.Platform = process.platform,
): boolean => platform === "darwin";

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
          refused ??=
            "antigravity: images must be data: URLs of a PNG, JPEG, GIF or WebP";
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
