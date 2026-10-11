import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { CLAUDE_TOOL_PASSTHROUGH_SCOPE } from "../execution-identity";

const TOKEN_VERSION = 1;
const TOKEN_PREFIX = "ots1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type TToolContinuationIdentity = {
  /** Authenticated account discriminator. The bootstrap signing key is per-user. */
  readonly subject: string;
  /** The daemon API-key id that owns the live iterator. */
  readonly ownerDaemonKey: string;
  /** Per-process epoch; a restarted owner cannot accept an old hold. */
  readonly ownerDaemonEpoch: string;
  /** Shared per-user secret from bootstrap, or process-local development fallback. */
  readonly secret: string;
  /**
   * Normalized execution-identity key (see `../execution-identity.ts`) this
   * continuation capability is scoped to. Defaults to
   * {@link CLAUDE_TOOL_PASSTHROUGH_SCOPE} — the sole production owner of
   * this token family today — so every caller/test that predates variant
   * partitioning keeps its exact current behavior unchanged. A held
   * session's minted token can only be redeemed by a continuation request
   * carrying the SAME scope: it must resolve to its original
   * integration/adapter owner, never "whichever global mode happens to be
   * selected now" (09-implementation-plan.md §7).
   */
  readonly executionScope?: string;
};

/** Resolve the effective scope for comparison/claims — the identity's own
 *  scope, or the single legacy owner when it predates partitioning. */
const executionScopeOf = (identity: TToolContinuationIdentity): string =>
  identity.executionScope ?? CLAUDE_TOOL_PASSTHROUGH_SCOPE;

type TToolContinuationClaims = {
  readonly v: number;
  readonly jti: string;
  readonly sub: string;
  readonly owner: string;
  readonly epoch: string;
  readonly scope: string;
  readonly ids: ReadonlyArray<string>;
  readonly exp: number;
};

export type TValidatedToolContinuation = {
  readonly tokenId: string;
  readonly pendingIds: ReadonlySet<string>;
};

export type TToolContinuationValidation =
  | { readonly kind: "valid"; readonly value: TValidatedToolContinuation }
  | { readonly kind: "invalid"; readonly reason: string };

const encode = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64url");
const decode = (value: string): Buffer => Buffer.from(value, "base64url");
const keyOf = (secret: string): Buffer =>
  createHash("sha256").update(secret).digest();

const claimsOf = (plain: string): TToolContinuationClaims | null => {
  try {
    const parsed: unknown = JSON.parse(plain);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.v !== TOKEN_VERSION ||
      typeof candidate.jti !== "string" ||
      typeof candidate.sub !== "string" ||
      typeof candidate.owner !== "string" ||
      typeof candidate.epoch !== "string" ||
      typeof candidate.scope !== "string" ||
      !Array.isArray(candidate.ids) ||
      !candidate.ids.every((id) => typeof id === "string") ||
      typeof candidate.exp !== "number"
    ) {
      return null;
    }
    return {
      v: candidate.v,
      jti: candidate.jti,
      sub: candidate.sub,
      owner: candidate.owner,
      epoch: candidate.epoch,
      scope: candidate.scope,
      ids: candidate.ids,
      exp: candidate.exp,
    };
  } catch {
    return null;
  }
};

/** Mint an encrypted, authenticated continuation capability for one pause. */
export const mintToolContinuation = (
  identity: TToolContinuationIdentity,
  pendingIds: ReadonlyArray<string>,
  expiresAt: number,
): string => {
  const claims: TToolContinuationClaims = {
    v: TOKEN_VERSION,
    jti: randomUUID(),
    sub: identity.subject,
    owner: identity.ownerDaemonKey,
    epoch: identity.ownerDaemonEpoch,
    scope: executionScopeOf(identity),
    ids: [...pendingIds].sort(),
    exp: expiresAt,
  };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyOf(identity.secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(claims), "utf8"),
    cipher.final(),
  ]);
  return `${TOKEN_PREFIX}.${encode(Buffer.concat([iv, ciphertext, cipher.getAuthTag()]))}`;
};

/** Validate a continuation capability before a held iterator is touched. */
export const validateToolContinuation = (
  token: string,
  identity: TToolContinuationIdentity,
  deliveredIds: ReadonlyArray<string>,
  now: number,
): TToolContinuationValidation => {
  const [prefix, encoded, extra] = token.split(".");
  if (prefix !== TOKEN_PREFIX || encoded === undefined || extra !== undefined) {
    return {
      kind: "invalid",
      reason: "invalid tool-session continuation token",
    };
  }
  try {
    const packed = decode(encoded);
    if (packed.length <= IV_BYTES + AUTH_TAG_BYTES) {
      return {
        kind: "invalid",
        reason: "invalid tool-session continuation token",
      };
    }
    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(packed.length - AUTH_TAG_BYTES);
    const ciphertext = packed.subarray(
      IV_BYTES,
      packed.length - AUTH_TAG_BYTES,
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyOf(identity.secret),
      iv,
    );
    decipher.setAuthTag(tag);
    const claims = claimsOf(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      ),
    );
    if (claims === null) {
      return {
        kind: "invalid",
        reason: "invalid tool-session continuation token",
      };
    }
    if (claims.exp <= now) {
      return {
        kind: "invalid",
        reason: "tool-session continuation token expired",
      };
    }
    if (claims.sub !== identity.subject) {
      return {
        kind: "invalid",
        reason: "tool-session continuation token belongs to a different user",
      };
    }
    if (
      claims.owner !== identity.ownerDaemonKey ||
      claims.epoch !== identity.ownerDaemonEpoch
    ) {
      return {
        kind: "invalid",
        reason:
          "tool-session continuation belongs to a different daemon or daemon epoch",
      };
    }
    if (claims.scope !== executionScopeOf(identity)) {
      return {
        kind: "invalid",
        reason:
          "tool-session continuation token belongs to a different execution variant",
      };
    }
    const ids = new Set(claims.ids);
    if (deliveredIds.length === 0 || deliveredIds.some((id) => !ids.has(id))) {
      return {
        kind: "invalid",
        reason:
          "tool-session continuation token does not match these tool-result ids",
      };
    }
    return { kind: "valid", value: { tokenId: claims.jti, pendingIds: ids } };
  } catch {
    return {
      kind: "invalid",
      reason: "invalid tool-session continuation token",
    };
  }
};
