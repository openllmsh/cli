/**
 * Request views for the Antigravity serve path (`serve.ts`): an image
 * conversation is correlated with the shared `agy` conversation store by a
 * TEXT view in which every image is a stable marker, and a turn that loads
 * the conversation over ACP sends only its own (trailing) images.
 */

import { createHash } from "node:crypto";
import type { TChatCompletionRequest } from "@openllmsh/sdk/protocol";
import type { TCursorImage } from "./cursor-request";
import { cursorRequestOf } from "./cursor-request";

/** The marker standing in for one image in the text view: the same image
 *  always renders the same marker, so a resent conversation hashes the same. */
export const imageMarkerOf = (url: string): string =>
  `[image ${createHash("sha256").update(url).digest("hex").slice(0, 16)}]`;

/**
 * The request with every `image_url` part replaced by a text marker
 * ({@link imageMarkerOf}). Other parts are left as they are, so a shape the
 * text view can't hold (files, audio) still has no text view.
 */
export const withImageMarkers = (
  canonical: TChatCompletionRequest,
): TChatCompletionRequest => ({
  ...canonical,
  messages: canonical.messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        const p = part as {
          readonly type?: unknown;
          readonly image_url?: { readonly url?: unknown };
        };
        return p.type === "image_url" && typeof p.image_url?.url === "string"
          ? {
              type: "text" as const,
              text: `\n${imageMarkerOf(p.image_url.url)}\n`,
            }
          : part;
      }),
    } as typeof message;
  }),
});

/** The images of the trailing user turns (after the last reply): what a
 *  loaded conversation has not seen yet. */
export const trailingUserImages = (
  canonical: TChatCompletionRequest,
): ReadonlyArray<TCursorImage> => {
  const lastReply = canonical.messages.findLastIndex(
    (message) => message.role !== "user" && message.role !== "system",
  );
  const trailing = canonical.messages
    .slice(lastReply + 1)
    .filter((message) => message.role === "user");
  return cursorRequestOf({ ...canonical, messages: trailing }).images;
};
