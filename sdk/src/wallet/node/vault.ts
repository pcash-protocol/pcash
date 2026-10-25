import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import type { WalletStorageCipher } from "../storageCipher.ts";

const FORMAT = "pcash-wallet-vault";
const KDF = { name: "argon2id", version: 0x13, memoryKiB: 65_536, iterations: 3, parallelism: 1 } as const;
const MAX_VAULT_BYTES = 16 * 1024 * 1024;

interface SealedValue {
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface WalletVaultDocument {
  format: typeof FORMAT;
  kdf: typeof KDF & { salt: string };
  wrappedKey: SealedValue;
  payload: SealedValue;
}

export interface UnlockedWalletVault {
  readonly storageCipher: WalletStorageCipher;
  seal(payload: unknown): WalletVaultDocument;
  close(): void;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hex(value: unknown, label: string, bytes?: number): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/.test(value)
    || (bytes !== undefined && value.length !== bytes * 2)) {
    throw new Error(`${label} has an invalid encoding`);
  }
  return value;
}

function sealedValue(value: unknown): SealedValue {
  const record = object(value, "encrypted wallet value");
  return {
    nonce: hex(record.nonce, "encryption nonce", 12),
    ciphertext: hex(record.ciphertext, "ciphertext"),
    tag: hex(record.tag, "authentication tag", 16),
  };
}

function parseDocument(value: unknown): WalletVaultDocument {
  const document = object(value, "wallet vault");
  if (document.format !== FORMAT) throw new Error("unsupported wallet vault format");
  const kdf = object(document.kdf, "wallet vault KDF");
  // Vault files are imported input. Reject unsupported costs before allocating Argon2 memory.
  for (const [key, expected] of Object.entries(KDF)) {
    if (kdf[key] !== expected) throw new Error("unsupported wallet vault KDF parameters");
  }
  const wrappedKey = sealedValue(document.wrappedKey);
  const payload = sealedValue(document.payload);
  if (wrappedKey.ciphertext.length !== 64 || payload.ciphertext.length > MAX_VAULT_BYTES * 2) {
    throw new Error("wallet vault ciphertext has an invalid size");
  }
  return { format: FORMAT, kdf: { ...KDF, salt: hex(kdf.salt, "KDF salt", 16) }, wrappedKey, payload };
}

function encrypt(key: Uint8Array, plaintext: Uint8Array, context: string): SealedValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce: nonce.toString("hex"), ciphertext: ciphertext.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

function decrypt(key: Uint8Array, encrypted: SealedValue, context: string): Buffer {
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.nonce, "hex"));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
    return Buffer.concat([cipher.update(Buffer.from(encrypted.ciphertext, "hex")), cipher.final()]);
  } catch {
    throw new Error("wallet authentication failed: incorrect password, key, or modified data");
  }
}

function keyContext(kdf: WalletVaultDocument["kdf"]): string {
  return JSON.stringify([FORMAT, "wrapped-key", kdf]);
}

async function passwordKey(password: string, salt: string): Promise<Uint8Array> {
  if (typeof password !== "string" || password.length === 0) throw new Error("wallet password must not be empty");
  return argon2idAsync(password, Buffer.from(salt, "hex"), {
    version: KDF.version, m: KDF.memoryKiB, t: KDF.iterations, p: KDF.parallelism,
    dkLen: 32, maxmem: KDF.memoryKiB * 1024 + 1024 * 1024,
  });
}

function unlockedVault(masterKey: Uint8Array, kdf: WalletVaultDocument["kdf"], wrappedKey: SealedValue): UnlockedWalletVault {
  const encryptionKey = Buffer.from(hkdfSync("sha256", masterKey, "", "pcash.wallet.storage.encryption", 32));
  const indexKey = Buffer.from(hkdfSync("sha256", masterKey, "", "pcash.wallet.storage.index", 32));
  let closed = false;
  const checkOpen = () => { if (closed) throw new Error("wallet vault is locked"); };
  const index = (context: string) => {
    checkOpen();
    return createHmac("sha256", indexKey).update(context).digest("hex");
  };
  const storageCipher: WalletStorageCipher = {
    id: index("pcash.wallet.storage.identity"),
    index,
    encode(value, context) {
      checkOpen();
      const bytes = Buffer.from(JSON.stringify(value));
      try { return encrypt(encryptionKey, bytes, JSON.stringify([FORMAT, "storage", context])); }
      finally { bytes.fill(0); }
    },
    decode(value, context) {
      checkOpen();
      const bytes = decrypt(encryptionKey, sealedValue(value), JSON.stringify([FORMAT, "storage", context]));
      try { return JSON.parse(bytes.toString("utf8")) as unknown; }
      finally { bytes.fill(0); }
    },
  };
  return {
    storageCipher,
    seal(payload) {
      checkOpen();
      return structuredClone({ format: FORMAT, kdf, wrappedKey, payload: storageCipher.encode(payload, "vault-payload") as SealedValue });
    },
    close() {
      closed = true;
      encryptionKey.fill(0);
      indexKey.fill(0);
    },
  };
}

/** Create a password-wrapped random storage key and an encrypted initial keystore. */
export async function createWalletVault(password: string, payload: unknown): Promise<{
  document: WalletVaultDocument;
  vault: UnlockedWalletVault;
}> {
  const kdf = { ...KDF, salt: randomBytes(16).toString("hex") };
  const key = await passwordKey(password, kdf.salt);
  const masterKey = randomBytes(32);
  try {
    const vault = unlockedVault(masterKey, kdf, encrypt(key, masterKey, keyContext(kdf)));
    try { return { document: vault.seal(payload), vault }; }
    catch (error) { vault.close(); throw error; }
  } finally {
    key.fill(0);
    masterKey.fill(0);
  }
}

/** Authenticate an imported vault before exposing any decrypted payload or database key. */
export async function unlockWalletVault(password: string, value: unknown): Promise<{
  payload: unknown;
  vault: UnlockedWalletVault;
}> {
  const document = parseDocument(value);
  const key = await passwordKey(password, document.kdf.salt);
  let masterKey: Buffer | undefined;
  let vault: UnlockedWalletVault | undefined;
  try {
    masterKey = decrypt(key, document.wrappedKey, keyContext(document.kdf));
    vault = unlockedVault(masterKey, document.kdf, document.wrappedKey);
    return { payload: vault.storageCipher.decode(document.payload, "vault-payload"), vault };
  } catch (error) {
    vault?.close();
    throw error;
  } finally {
    key.fill(0);
    masterKey?.fill(0);
  }
}
