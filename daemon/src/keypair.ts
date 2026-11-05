/**
 * Per-daemon X25519 keypair + sealed-box transfer.
 *
 * Identity key file I/O stays here (node KeyObject + 0600 PKCS#8 on disk).
 * Sealed-box open/seal uses `@openllmsh/sdk/vault` cred-seal (WebCrypto), with
 * a cached non-extractable CryptoKey imported from the same PKCS#8 bytes.
 *
 * `daemonX25519Dh` stays on node:crypto KeyObject — Noise_IK in mux-host needs
 * a sync-friendly DH against raw 32-byte peers; reimplementing that in
 * WebCrypto would add async on the handshake hot path without removing the
 * KeyObject already required for disk I/O. Cited by the no-reimplementation
 * allow-list for that reason.
 */
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TEphKeypair } from "@openllmsh/sdk/vault";
import {
  importX25519PrivateKey,
  openCredSealed,
  sealToDaemon,
  generateEphKeypair as vaultGenerateEphKeypair,
} from "@openllmsh/sdk/vault";
import { stateDir } from "./env";
import { logError } from "./logger";

const privFile = (): string => join(stateDir(), "x25519-priv");

const isErrnoException = (err: unknown): err is NodeJS.ErrnoException => {
  if (!(err instanceof Error)) return false;
  return (
    ("code" in err && typeof err.code === "string") ||
    ("errno" in err && typeof err.errno === "number")
  );
};

const errnoFields = (
  err: unknown,
): { readonly errno: number | null; readonly code: string | null } => {
  if (!isErrnoException(err)) return { errno: null, code: null };
  return {
    errno: typeof err.errno === "number" ? err.errno : null,
    code: typeof err.code === "string" ? err.code : null,
  };
};

const isAbsentIdentityFile = (err: unknown): boolean =>
  isErrnoException(err) && err.code === "ENOENT";

const logIdentityFailure = (
  message: string,
  operation: "read" | "parse" | "write",
  err: unknown,
  path: string,
): void => {
  const { errno, code } = errnoFields(err);
  logError("keypair", message, {
    operation,
    class: err instanceof Error ? err.constructor.name : typeof err,
    errno,
    code,
    path,
  });
};

/**
 * Load (or mint) the daemon's long-lived X25519 identity.
 *
 * Caller contract (publishIdentity / bootstrap):
 * - Always returns a usable in-memory key for THIS run — mux, chat, seals, and
 *   subscriptions keep working even when the disk is full. Never process.exit.
 * - `persisted` is true iff the PKCS#8 private key is on disk under the state
 *   dir (loaded or written). When false, the caller MUST skip publishIdentity.
 *   The cloud pin is write-once; publishing an unpersisted pubkey plants a pin
 *   this process cannot reproduce, and the next boot 409s forever.
 * - Never auto-rotate the pin via the API key. A stolen `sk-llm-…` must not be
 *   able to rotate a device identity.
 */
export type TIdentityKey = {
  readonly publicKeyB64: string;
  readonly persisted: boolean;
};

const publicKeyB64Of = (privateKey: KeyObject): string =>
  Buffer.from(
    createPublicKey(privateKey).export({ format: "der", type: "spki" }),
  ).toString("base64");

type TLoadedKey = {
  readonly privateKey: KeyObject;
  readonly pkcs8B64: string;
  /** True iff the key was loaded from disk or written by this load. */
  readonly persisted: boolean;
};

const ephemeral = (privateKey: KeyObject): TLoadedKey => ({
  privateKey,
  pkcs8B64: Buffer.from(
    privateKey.export({ format: "der", type: "pkcs8" }),
  ).toString("base64"),
  persisted: false,
});

const loadedFromDer = (der: Buffer, persisted: boolean): TLoadedKey => {
  const privateKey = createPrivateKey({
    key: der,
    format: "der",
    type: "pkcs8",
  });
  return {
    privateKey,
    pkcs8B64: Buffer.from(der).toString("base64"),
    persisted,
  };
};

/** Read (or mint + persist) the X25519 private key at `path`. */
const readOrMintKey = (path: string, dir: string): TLoadedKey => {
  try {
    const der = readFileSync(path);
    try {
      return loadedFromDer(der, true);
    } catch (err) {
      // File exists but is not a usable PKCS#8 key — never overwrite it.
      logIdentityFailure(
        "identity private key exists but is unreadable — using ephemeral key, skip publishIdentity this run",
        "parse",
        err,
        path,
      );
      return ephemeral(generateKeyPairSync("x25519").privateKey);
    }
  } catch (err) {
    if (!isAbsentIdentityFile(err)) {
      // Existing file we cannot read (EACCES, EISDIR, …) — never overwrite.
      logIdentityFailure(
        "identity private key exists but is unreadable — using ephemeral key, skip publishIdentity this run",
        "read",
        err,
        path,
      );
      return ephemeral(generateKeyPairSync("x25519").privateKey);
    }
  }
  const { privateKey } = generateKeyPairSync("x25519");
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    const der = Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    );
    writeFileSync(tmpPath, der, { mode: 0o600 });
    // link(2) fails with EEXIST instead of replacing — never clobber a
    // dest that appeared after the ENOENT read (first-boot race) or an
    // unreadable existing identity.
    linkSync(tmpPath, path);
    return {
      privateKey,
      pkcs8B64: der.toString("base64"),
      persisted: true,
    };
  } catch (err) {
    if (isErrnoException(err) && err.code === "EEXIST") {
      try {
        const der = readFileSync(path);
        return loadedFromDer(der, true);
      } catch (readErr) {
        logIdentityFailure(
          "identity private key exists but is unreadable — using ephemeral key, skip publishIdentity this run",
          "read",
          readErr,
          path,
        );
        return ephemeral(privateKey);
      }
    }
    logIdentityFailure(
      "identity private key was not persisted — skip publishIdentity this run",
      "write",
      err,
      path,
    );
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort: the tmp file may never have been created.
    }
  }
  return ephemeral(privateKey);
};

export type TIdentityKeyStore = {
  /** The identity for the current state dir, loaded at most once per dir. */
  readonly load: () => TIdentityKey;
  /** The private key behind {@link load}. */
  readonly privateKey: () => KeyObject;
  /** WebCrypto private key cached alongside the KeyObject (cred-seal). */
  readonly cryptoPrivateKey: () => Promise<CryptoKey>;
};

/**
 * A memo of identities keyed by their file path, so a re-pointed state dir
 * gets its own identity and nothing ever needs clearing. A fresh store reads
 * the disk again — what a new process does.
 */
export const createIdentityKeyStore = (): TIdentityKeyStore => {
  const loaded = new Map<
    string,
    TLoadedKey & {
      readonly publicKeyB64: string;
      cryptoPrivateKey?: CryptoKey;
      cryptoPrivateKeyPromise?: Promise<CryptoKey>;
    }
  >();
  const entry = (): TLoadedKey & {
    readonly publicKeyB64: string;
    cryptoPrivateKey?: CryptoKey;
    cryptoPrivateKeyPromise?: Promise<CryptoKey>;
  } => {
    const path = privFile();
    const hit = loaded.get(path);
    if (hit !== undefined) return hit;
    const key = readOrMintKey(path, stateDir());
    const next = { ...key, publicKeyB64: publicKeyB64Of(key.privateKey) };
    loaded.set(path, next);
    return next;
  };
  return {
    load: (): TIdentityKey => {
      const { publicKeyB64, persisted } = entry();
      return { publicKeyB64, persisted };
    },
    privateKey: (): KeyObject => entry().privateKey,
    cryptoPrivateKey: (): Promise<CryptoKey> => {
      const cur = entry();
      if (cur.cryptoPrivateKey !== undefined) {
        return Promise.resolve(cur.cryptoPrivateKey);
      }
      if (cur.cryptoPrivateKeyPromise !== undefined) {
        return cur.cryptoPrivateKeyPromise;
      }
      const pending = importX25519PrivateKey(cur.pkcs8B64).then((key) => {
        cur.cryptoPrivateKey = key;
        cur.cryptoPrivateKeyPromise = undefined;
        return key;
      });
      cur.cryptoPrivateKeyPromise = pending;
      return pending;
    },
  };
};

const identityKeys = createIdentityKeyStore();

export const loadIdentityKey = (): TIdentityKey => identityKeys.load();

/**
 * Whether the long-lived private key is on disk. False means skip
 * publishIdentity (see {@link loadIdentityKey}).
 */
export const identityKeyPersisted = (): boolean => loadIdentityKey().persisted;

/** This daemon's public key (SPKI DER, base64) — in-memory even if not persisted. */
export const daemonPublicKey = (): string => loadIdentityKey().publicKeyB64;

/**
 * X25519(this daemon's private key, `remoteRaw`) — the static DH the Noise_IK
 * responder needs for agent streams on the relay mux (`mux-host.ts`). The
 * private key never leaves this module. Throws on a malformed peer key.
 *
 * Intentionally node:crypto (KeyObject) rather than vault WebCrypto: Noise
 * wraps this in an async callback already, and the identity KeyObject is the
 * durable form on disk. See module doc / no-reimplementation allow-list.
 */
export const daemonX25519Dh = (remoteRaw: Uint8Array): Uint8Array => {
  if (remoteRaw.byteLength !== 32) {
    throw new RangeError("X25519 public key must be 32 bytes");
  }
  const publicKey = createPublicKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      x: Buffer.from(remoteRaw).toString("base64url"),
    },
    format: "jwk",
  });
  return new Uint8Array(
    diffieHellman({ privateKey: identityKeys.privateKey(), publicKey }),
  );
};

export type { TEphKeypair };

/** Generate an ephemeral X25519 keypair for a one-shot sealed-box reply. */
export const generateEphKeypair = (): Promise<TEphKeypair> =>
  vaultGenerateEphKeypair();

/** Open a sealed blob with an explicit recipient private key. Null on failure. */
export const openSealedWith = (
  privateKey: CryptoKey,
  sealedB64: string,
): Promise<string | null> => openCredSealed(sealedB64, privateKey);

/** Open a sealed blob with this daemon's long-lived private key. */
export const openSealed = async (sealedB64: string): Promise<string | null> =>
  openCredSealed(sealedB64, await identityKeys.cryptoPrivateKey());

/** Seal plaintext to a recipient daemon's public key (SPKI DER, base64). */
export const sealTo = (
  recipientPubB64: string,
  plaintext: string,
): Promise<string> => sealToDaemon(recipientPubB64, plaintext);
