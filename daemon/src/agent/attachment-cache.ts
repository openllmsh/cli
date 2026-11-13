/**
 * The device's attachment cache: files a consumer uploaded for agent sessions
 * (`attachment_put`), stored once under the SHA-256 of their bytes in
 * `<state>/agent-attachment-cache/<sha256>`.
 *
 * A session uses a cached file by HARD-LINKING it into its own attachments
 * dir, so the prompt names a file of that session, `attachment_get` serves it
 * like any other upload, and deleting the session drops its link. A cache
 * file whose link count is back to 1 is used by no session and is swept. No
 * reference index to keep in step: the filesystem counts the references.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { TAgentAttachmentPutCommand } from "@openllmsh/sdk/protocol";
import {
  AGENT_ATTACHMENT_SHA256_PATTERN,
  AGENT_MAX_ATTACHMENT_BYTES,
  AGENT_MAX_ATTACHMENTS,
} from "@openllmsh/sdk/protocol";
import { stateDir } from "../env";

/**
 * How long an unlinked cache file or an unfinished upload is kept before a
 * sweep removes it.
 */
const UNUSED_GRACE_MS = 60 * 60 * 1000;
const PARTIAL_PREFIX = ".partial-";

export const attachmentCacheDir = (): string =>
  join(stateDir(), "agent-attachment-cache");

const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
};

/** The cached file for `sha256`, or null when the device doesn't hold it. */
export const cachedAttachmentPath = (
  sha256: string,
  dir: string = attachmentCacheDir(),
): string | null => {
  if (!AGENT_ATTACHMENT_SHA256_PATTERN.test(sha256)) return null;
  const path = join(dir, sha256);
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
};

/**
 * The cached file for `sha256` if its bytes still hash to that name. A
 * session's engine can rewrite its linked copy (permissions don't stop the
 * owner), which rewrites the cache too: such an entry is dropped, so the
 * consumer uploads the real bytes again.
 */
const intactCachedAttachment = (sha256: string, dir: string): string | null => {
  const path = cachedAttachmentPath(sha256, dir);
  if (path === null) return null;
  if (createHash("sha256").update(readFileSync(path)).digest("hex") === sha256)
    return path;
  rmSync(path, { force: true });
  return null;
};

/** Link a cached file into a session's attachments dir as `target`. */
export const linkCachedAttachment = (
  sha256: string,
  target: string,
  dir: string = attachmentCacheDir(),
): { readonly size: number } => {
  const source = cachedAttachmentPath(sha256, dir);
  if (source === null) {
    throw new Error("attachment_missing: the file is not on the device");
  }
  linkSync(source, target);
  return { size: statSync(source).size };
};

export type TAttachmentPutResult =
  | {
      readonly ok: true;
      readonly sha256: string;
      readonly stored: boolean;
      readonly received: number;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * One consumer connection's uploads in flight. Chunks arrive in order, each
 * answered before the next, so one open file per hash is all it holds.
 */
export const createAttachmentUploads = (
  dir: string = attachmentCacheDir(),
): {
  readonly put: (command: TAgentAttachmentPutCommand) => TAttachmentPutResult;
  /** Drop unfinished uploads (the consumer went away). */
  readonly abort: () => void;
} => {
  const open = new Map<
    string,
    { readonly path: string; readonly size: number; received: number }
  >();
  const fail = (
    sha256: string,
    code: string,
    message: string,
  ): TAttachmentPutResult => {
    const upload = open.get(sha256);
    if (upload !== undefined) {
      open.delete(sha256);
      rmSync(upload.path, { force: true });
    }
    return { ok: false, code, message };
  };

  const put = (command: TAgentAttachmentPutCommand): TAttachmentPutResult => {
    const { sha256, size, offset, done } = command;
    const cached = intactCachedAttachment(sha256, dir);
    if (cached !== null) {
      open.delete(sha256);
      // A hit restarts the sweep's grace: the `send` that links it is coming.
      const now = new Date();
      utimesSync(cached, now, now);
      return { ok: true, sha256, stored: true, received: size };
    }
    if (size > AGENT_MAX_ATTACHMENT_BYTES) {
      return fail(sha256, "attachment_too_large", "The file is too large.");
    }
    const bytes = Buffer.from(command.data, "base64");
    let upload = open.get(sha256);
    if (upload === undefined) {
      if (offset !== 0) {
        return fail(sha256, "attachment_out_of_order", "Upload out of order.");
      }
      if (open.size >= AGENT_MAX_ATTACHMENTS) {
        return {
          ok: false,
          code: "attachment_busy",
          message: "Too many files uploading at once.",
        };
      }
      ensureDir(dir);
      upload = {
        // Unique per upload: two consumers may send the same file at once.
        path: join(dir, `${PARTIAL_PREFIX}${sha256}-${randomUUID()}`),
        size,
        received: 0,
      };
      closeSync(openSync(upload.path, "wx", 0o600));
      open.set(sha256, upload);
    }
    if (offset !== upload.received || size !== upload.size) {
      return fail(sha256, "attachment_out_of_order", "Upload out of order.");
    }
    if (upload.received + bytes.byteLength > size) {
      return fail(sha256, "attachment_too_large", "More bytes than declared.");
    }
    if (bytes.byteLength > 0) {
      const fd = openSync(upload.path, "a", 0o600);
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      upload.received += bytes.byteLength;
    }
    if (!done)
      return { ok: true, sha256, stored: false, received: upload.received };

    open.delete(sha256);
    if (upload.received !== size) {
      rmSync(upload.path, { force: true });
      return {
        ok: false,
        code: "attachment_incomplete",
        message: "Upload incomplete.",
      };
    }
    const digest = createHash("sha256")
      .update(readFileSync(upload.path))
      .digest("hex");
    if (digest !== sha256) {
      rmSync(upload.path, { force: true });
      return {
        ok: false,
        code: "attachment_hash_mismatch",
        message: "The file didn't arrive intact.",
      };
    }
    // Read-only: every session's link IS this file, so an edit through one
    // (the engine rewriting an attachment) must not change the others or the
    // bytes its name vouches for.
    chmodSync(upload.path, 0o400);
    renameSync(upload.path, join(dir, sha256));
    // Uploads that were never sent don't pile up between session deletes.
    sweepAttachmentCache(dir);
    return { ok: true, sha256, stored: true, received: size };
  };

  const abort = (): void => {
    for (const upload of open.values()) rmSync(upload.path, { force: true });
    open.clear();
  };

  return { put, abort };
};

/**
 * Remove cache files no session links to any more (link count 1) and
 * abandoned uploads, once older than an hour. Run after a session's
 * attachments go.
 */
export const sweepAttachmentCache = (
  dir: string = attachmentCacheDir(),
  now: number = Date.now(),
): readonly string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const stat = statSync(path);
      // Both wait out the grace: a file just stored may not be linked yet
      // (its `send` is on the way), an upload may still be arriving.
      const old = now - stat.mtimeMs > UNUSED_GRACE_MS;
      const unused =
        old &&
        (AGENT_ATTACHMENT_SHA256_PATTERN.test(entry)
          ? stat.nlink <= 1
          : entry.startsWith(PARTIAL_PREFIX));
      if (!unused) continue;
      rmSync(path, { force: true });
      removed.push(entry);
    } catch {
      // Gone already.
    }
  }
  return removed;
};
