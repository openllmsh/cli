/**
 * Image attachments for the headless `agy` CLI: each image is stored ONCE
 * under the SHA-256 of its bytes in `<agy temp root>/attachments/`, so the
 * same image always has the same path (and the prompt line naming it never
 * changes between turns). It sits in the `agy` temp root, the only part of
 * the daemon's temp dir the inference `agy`'s confinement (Seatbelt on
 * macOS, Landlock on Linux — `antigravity-seatbelt.ts`) can read.
 *
 * Files untouched for {@link AGY_ATTACHMENT_TTL_MS} are swept (each use
 * refreshes the mtime).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { inspectImageBytes } from "@openllmsh/sdk/wire/lib/canonical/image-signature";
import { agyTempRoot } from "../sandbox/working-set/base";

export const AGY_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

const EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

/** A base64 `data:` image URL whose bytes really are the PNG, JPEG, GIF or
 *  WebP it declares (the bytes are sniffed), or null. */
export const parseAgyImageDataUrl = (
  url: string,
): { readonly mime: string; readonly bytes: Uint8Array } | null => {
  const m = url.match(DATA_URL);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const declared = m[1].trim().toLowerCase();
  const bytes = new Uint8Array(Buffer.from(m[2], "base64"));
  const inspected = inspectImageBytes(bytes);
  if (inspected === null) return null;
  const canon = declared === "image/jpg" ? "image/jpeg" : declared;
  return canon === inspected.mime ? { mime: inspected.mime, bytes } : null;
};

export const agyAttachmentsDir = (): string =>
  join(agyTempRoot(), "attachments");

let lastSweep = 0;

/** Remove attachments unused for the TTL (best effort, at most hourly). */
export const sweepAgyAttachments = (
  dir: string = agyAttachmentsDir(),
  now: number = Date.now(),
): void => {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > AGY_ATTACHMENT_TTL_MS) {
        rmSync(path, { force: true });
      }
    } catch {
      // best effort
    }
  }
};

/**
 * Store one `data:` image URL; its absolute path, or null when it is not a
 * base64 `data:` URL of a real PNG / JPEG / GIF / WebP (the bytes are
 * sniffed — a declared type that doesn't match them is refused).
 */
export const storeAgyImage = (
  url: string,
  dir: string = agyAttachmentsDir(),
): string | null => {
  const parsed = parseAgyImageDataUrl(url);
  if (parsed === null) return null;
  const { bytes } = parsed;
  const ext = EXT[parsed.mime];
  if (ext === undefined) return null;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = join(dir, `${hash}.${ext}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      const now = new Date();
      utimesSync(path, now, now);
    } else {
      const tmp = `${path}.${process.pid}.${Date.now()}.partial`;
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, path);
    }
  } catch {
    return null;
  }
  sweepAgyAttachments(dir);
  return path;
};
