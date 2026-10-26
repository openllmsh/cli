/**
 * Per-daemon X25519 keypair + sealed-box transfer.
 *
 * Used to move a Claude SETUP-TOKEN between two of the user's own daemons
 * without the cloud ever reading it: the daemon on the machine with the
 * browser mints the token and SEALS it to the target daemon's public key; the
 * cloud relays only ciphertext (`/api/daemon/relay-credential`); the target
 * daemon opens it with its private key and stores it. See
 * docs/proposals/daemon-auth-loopback-forwarding.md §7.4.
 *
 * Sealed box = ephemeral X25519 + ECDH → HKDF-SHA256 → AES-256-GCM. The
 * private key is generated once and persisted `0600` under the state dir; only
 * the public key (SPKI DER, base64) ever leaves the box, on the status push.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";
import { logError } from "./logger";

const privFile = (): string => join(stateDir(), "x25519-priv");
const HKDF_INFO = Buffer.from("openllm-cred-seal-v1");

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
  /** True iff the key was loaded from disk or written by this load. */
  readonly persisted: boolean;
};

const ephemeral = (privateKey: KeyObject): TLoadedKey => ({
  privateKey,
  persisted: false,
});

/** Read (or mint + persist) the X25519 private key at `path`. */
const readOrMintKey = (path: string, dir: string): TLoadedKey => {
  try {
    const der = readFileSync(path);
    try {
      return {
        privateKey: createPrivateKey({
          key: der,
          format: "der",
          type: "pkcs8",
        }),
        persisted: true,
      };
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
    writeFileSync(
      tmpPath,
      privateKey.export({ format: "der", type: "pkcs8" }),
      { mode: 0o600 },
    );
    // link(2) fails with EEXIST instead of replacing — never clobber a
    // dest that appeared after the ENOENT read (first-boot race) or an
    // unreadable existing identity.
    linkSync(tmpPath, path);
    return { privateKey, persisted: true };
  } catch (err) {
    if (isErrnoException(err) && err.code === "EEXIST") {
      try {
        const der = readFileSync(path);
        return {
          privateKey: createPrivateKey({
            key: der,
            format: "der",
            type: "pkcs8",
          }),
          persisted: true,
        };
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
};

/**
 * A memo of identities keyed by their file path, so a re-pointed state dir
 * gets its own identity and nothing ever needs clearing. A fresh store reads
 * the disk again — what a new process does.
 */
export const createIdentityKeyStore = (): TIdentityKeyStore => {
  const loaded = new Map<
    string,
    TLoadedKey & { readonly publicKeyB64: string }
  >();
  const entry = (): TLoadedKey & { readonly publicKeyB64: string } => {
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

const deriveKey = (shared: Buffer): Buffer =>
  Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32));

/**
 * Seal `plaintext` to a recipient daemon's public key (SPKI DER, base64).
 * Output is base64(JSON{ epk, iv, ct }) — the cloud relays it opaquely.
 */
export type TEphKeypair = {
  readonly privateKey: KeyObject;
  readonly publicKeyB64: string;
};

/** Generate an ephemeral X25519 keypair for a one-shot sealed-box reply. */
export const generateEphKeypair = (): TEphKeypair => {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    privateKey,
    publicKeyB64: Buffer.from(
      publicKey.export({ format: "der", type: "spki" }),
    ).toString("base64"),
  };
};

/** Open a sealed blob with an explicit recipient private key. Null on failure. */
export const openSealedWith = (
  privateKey: KeyObject,
  sealedB64: string,
): string | null => {
  try {
    const { epk, iv, ct } = JSON.parse(
      Buffer.from(sealedB64, "base64").toString("utf8"),
    ) as { epk: string; iv: string; ct: string };
    const eph = createPublicKey({
      key: Buffer.from(epk, "base64"),
      format: "der",
      type: "spki",
    });
    const shared = diffieHellman({ privateKey, publicKey: eph });
    const key = deriveKey(shared);
    const ctBuf = Buffer.from(ct, "base64");
    const body = ctBuf.subarray(0, ctBuf.length - 16);
    const tag = ctBuf.subarray(ctBuf.length - 16);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
};

/** Open a sealed blob with this daemon's long-lived private key. */
export const openSealed = (sealedB64: string): string | null =>
  openSealedWith(identityKeys.privateKey(), sealedB64);

/** Seal plaintext to a recipient daemon's public key (SPKI DER, base64). */
export const sealTo = (recipientPubB64: string, plaintext: string): string => {
  const recipient = createPublicKey({
    key: Buffer.from(recipientPubB64, "base64"),
    format: "der",
    type: "spki",
  });
  const eph = generateEphKeypair();
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: recipient,
  });
  const key = deriveKey(shared);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const packed = {
    epk: eph.publicKeyB64,
    iv: iv.toString("base64"),
    ct: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
  };
  return Buffer.from(JSON.stringify(packed)).toString("base64");
};
