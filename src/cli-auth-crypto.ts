/**
 * CLI-local mirror of `packages/vault/cli-auth-seal.ts` open path + X25519
 * keypair mint. The compiled `openllm` binary must NOT depend on
 * `@openllm/vault`; keep this algorithm byte-identical so vault-sealed
 * envelopes open here.
 *
 * Domain: `openllm-cli-auth-seal-v1`
 * AAD: `JSON([DOMAIN, userId, authorizationId, recipientPublicKeyB64])`
 * HKDF info: `JSON([DOMAIN, epk, recipientPublicKeyB64])`
 */

export const CLI_AUTH_SEAL_DOMAIN = "openllm-cli-auth-seal-v1";

export type TCliAuthSealBinding = {
  readonly userId: string;
  readonly authorizationId: string;
  /** Recipient (CLI) X25519 public key, base64 SPKI DER. */
  readonly recipientPublicKeyB64: string;
};

export type TCliAuthSealed = {
  readonly v: 1;
  readonly epk: string;
  readonly nonce: string;
  readonly ct: string;
};

/** An X25519 key pair whose private half cannot leave this runtime. */
export type TCliAuthKeypair = {
  /** SPKI DER, base64. */
  readonly publicKeyB64: string;
  /** Non-extractable; held in memory only. */
  readonly privateKey: CryptoKey;
};

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (s === undefined) {
    throw new Error("WebCrypto SubtleCrypto is not available in this runtime");
  }
  return s;
};

export const toB64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] as number);
  }
  return btoa(bin);
};

export const fromB64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Best-effort overwrite of sensitive bytes. */
export const zero = (bytes: Uint8Array): void => {
  bytes.fill(0);
};

const copyOf = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );

const importAesGcmKey = async (keyBytes: Uint8Array): Promise<CryptoKey> => {
  const copy = copyOf(keyBytes);
  try {
    return await subtle().importKey(
      "raw",
      copy as BufferSource,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    zero(copy);
  }
};

const gcmParams = (
  nonce: Uint8Array,
  additionalData: Uint8Array | undefined,
): AesGcmParams =>
  additionalData === undefined
    ? { name: "AES-GCM", iv: nonce as BufferSource }
    : {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: additionalData as BufferSource,
      };

const aesGcmDecrypt = async (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> => {
  if (key.length !== 32) throw new Error("AES-GCM key must be 32 bytes");
  if (nonce.length !== 12) throw new Error("AES-GCM nonce must be 12 bytes");
  const cryptoKey = await importAesGcmKey(key);
  const pt = await subtle().decrypt(
    gcmParams(nonce, additionalData),
    cryptoKey,
    ciphertext as BufferSource,
  );
  return new Uint8Array(pt);
};

const hkdfSha256 = async (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  bytes: number,
): Promise<Uint8Array> => {
  const ikmCopy = copyOf(ikm);
  let key: CryptoKey;
  try {
    key = await subtle().importKey(
      "raw",
      ikmCopy as BufferSource,
      "HKDF",
      false,
      ["deriveBits"],
    );
  } finally {
    zero(ikmCopy);
  }
  const out = await subtle().deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: copyOf(salt) as BufferSource,
      info: new TextEncoder().encode(info),
    },
    key,
    bytes * 8,
  );
  return new Uint8Array(out);
};

const aad = (binding: TCliAuthSealBinding): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify([
      CLI_AUTH_SEAL_DOMAIN,
      binding.userId,
      binding.authorizationId,
      binding.recipientPublicKeyB64,
    ]),
  );

const decode = (value: unknown): Uint8Array => {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Invalid sealed envelope encoding");
  const bytes = fromB64(value);
  if (toB64(bytes) !== value)
    throw new Error("Invalid sealed envelope encoding");
  return bytes;
};

const deriveKey = async (
  privateKey: CryptoKey,
  peerB64: string,
  epk: string,
  recipient: string,
): Promise<Uint8Array> => {
  const peer = await subtle().importKey(
    "spki",
    decode(peerB64) as BufferSource,
    { name: "X25519" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await subtle().deriveBits(
      { name: "X25519", public: peer },
      privateKey,
      256,
    ),
  );
  try {
    return await hkdfSha256(
      shared,
      new Uint8Array(0),
      JSON.stringify([CLI_AUTH_SEAL_DOMAIN, epk, recipient]),
      32,
    );
  } finally {
    zero(shared);
  }
};

/**
 * Mint an ephemeral X25519 key pair. Public half exported as base64 SPKI DER
 * (same shape as vault handoff); private half re-imported non-extractable.
 */
export const generateCliAuthKeypair = async (): Promise<TCliAuthKeypair> => {
  const pair = (await subtle().generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(
    await subtle().exportKey("pkcs8", pair.privateKey),
  );
  try {
    const privateKey = await subtle().importKey(
      "pkcs8",
      pkcs8 as BufferSource,
      { name: "X25519" },
      false,
      ["deriveBits"],
    );
    return { publicKeyB64: toB64(spki), privateKey };
  } finally {
    zero(pkcs8);
  }
};

/**
 * Key pair for `openllm login --non-interactive` (D19): the private half must
 * survive until `--resume`, so it is also returned as PKCS#8 base64 for the
 * caller to write to a 0600 state file. The in-memory key stays
 * non-extractable.
 */
export const generateResumableCliAuthKeypair = async (): Promise<
  TCliAuthKeypair & { readonly privateKeyPkcs8B64: string }
> => {
  const pair = (await subtle().generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(
    await subtle().exportKey("pkcs8", pair.privateKey),
  );
  try {
    return {
      publicKeyB64: toB64(spki),
      privateKey: await importCliAuthPrivateKey(toB64(pkcs8)),
      privateKeyPkcs8B64: toB64(pkcs8),
    };
  } finally {
    zero(pkcs8);
  }
};

/** Re-import a resumable private key (non-extractable). */
export const importCliAuthPrivateKey = async (
  pkcs8B64: string,
): Promise<CryptoKey> => {
  const pkcs8 = fromB64(pkcs8B64);
  try {
    return await subtle().importKey(
      "pkcs8",
      pkcs8 as BufferSource,
      { name: "X25519" },
      false,
      ["deriveBits"],
    );
  } finally {
    zero(pkcs8);
  }
};

/** Caller owns the returned plaintext and must wipe it when finished. */
export const openCliAuthSealed = async (
  binding: TCliAuthSealBinding,
  sealed: TCliAuthSealed,
  privateKey: CryptoKey,
): Promise<Uint8Array> => {
  if (typeof sealed !== "object" || sealed === null || sealed.v !== 1)
    throw new Error("Invalid sealed envelope");
  const nonce = decode(sealed.nonce);
  const ct = decode(sealed.ct);
  if (nonce.length !== 12 || ct.length < 16 || typeof sealed.epk !== "string")
    throw new Error("Invalid sealed envelope");
  const key = await deriveKey(
    privateKey,
    sealed.epk,
    sealed.epk,
    binding.recipientPublicKeyB64,
  );
  try {
    return await aesGcmDecrypt(key, nonce, ct, aad(binding));
  } finally {
    zero(key);
  }
};
