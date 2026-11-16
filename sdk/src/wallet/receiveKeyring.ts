// Browser-safe durable receive-key keyring operations.

import { bytesEqual, fromHex, toHex } from "@pcash/sdk/utils";
import { fieldToHex } from "@pcash/sdk/crypto";
import {
  type MlKemKeyPair,
  ML_KEM_768_SECRET_KEY_LENGTH,
  decryptEnvelope,
  encryptEnvelope,
  receiveKeyHash as protocolReceiveKeyHash,
} from "@pcash/sdk/protocol";
import { ML_KEM_768_PUBLIC_KEY_LENGTH } from "@pcash/sdk/constants";
import type { StoredReceiveKeyPair, WalletFileData } from "./noteStore.ts";
import type { WalletProfileWithReceiveKeys } from "@pcash/sdk/protocol";

const hexBytes = (value: string): Uint8Array => fromHex(value, "receive key");

/** The account-state receive-key digest of `publicKey`, as a canonical 32-byte hex word. */
export function receiveKeyHashHex(pair: Pick<MlKemKeyPair, "publicKey">): string {
  if (!(pair.publicKey instanceof Uint8Array) || pair.publicKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new Error(`ML-KEM-768 public key must be ${ML_KEM_768_PUBLIC_KEY_LENGTH} bytes`);
  }
  return fieldToHex(protocolReceiveKeyHash(pair.publicKey));
}

export function storedReceiveKeyPair(pair: MlKemKeyPair): StoredReceiveKeyPair {
  if (!(pair.publicKey instanceof Uint8Array) || pair.publicKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new Error(`ML-KEM-768 public key must be ${ML_KEM_768_PUBLIC_KEY_LENGTH} bytes`);
  }
  if (!(pair.secretKey instanceof Uint8Array) || pair.secretKey.length !== ML_KEM_768_SECRET_KEY_LENGTH) {
    throw new Error(`ML-KEM-768 secret key must be ${ML_KEM_768_SECRET_KEY_LENGTH} bytes`);
  }
  // An imported pair is caller-supplied: a secret key that cannot open what its
  // public key seals would advertise a receive key this wallet cannot scan.
  const probe = Uint8Array.of(0x50, 0x43, 0x41, 0x53, 0x48);
  const opened = decryptEnvelope(pair.secretKey, encryptEnvelope(pair.publicKey, probe));
  if (opened === null || !bytesEqual(opened, probe)) {
    throw new Error("receive key.mlKemSecretKey does not match mlKemPublicKey");
  }
  return {
    receiveKeyHash: receiveKeyHashHex(pair),
    mlKemPublicKey: toHex(pair.publicKey),
    mlKemSecretKey: toHex(pair.secretKey),
  };
}

/** Add an owned keypair exactly once. Existing keys are never removed. */
export function retainReceiveKeyPair(data: WalletFileData, pair: MlKemKeyPair): boolean {
  const stored = storedReceiveKeyPair(pair);
  const existing = data.receiveKeys.find((key) => key.receiveKeyHash === stored.receiveKeyHash);
  if (existing !== undefined) {
    if (
      existing.mlKemPublicKey !== stored.mlKemPublicKey
      || existing.mlKemSecretKey !== stored.mlKemSecretKey
    ) throw new Error("receive-key hash is already bound to different local key material");
    return false;
  }
  data.receiveKeys.push(stored);
  return true;
}

/** Retain newly imported decryption material and durably require a historical replay. */
export function retainReceiveKeyPairForRescan(data: WalletFileData, pair: MlKemKeyPair): boolean {
  if (!retainReceiveKeyPair(data, pair)) return false;
  data.fullRescanRequired = true;
  return true;
}

export function receiveKeyPairs(data: WalletFileData): MlKemKeyPair[] {
  return data.receiveKeys.map((stored) => ({
    publicKey: hexBytes(stored.mlKemPublicKey),
    secretKey: hexBytes(stored.mlKemSecretKey),
  }));
}

/** Resolve one exact owned keypair by the digest committed in account state. */
export function receiveKeyPairForHash(
  data: WalletFileData,
  receiveKeyHashValue: string,
): MlKemKeyPair | null {
  const canonicalHash = receiveKeyHashValue.toLowerCase();
  const stored = data.receiveKeys.find((key) => key.receiveKeyHash === canonicalHash);
  return stored === undefined
    ? null
    : { publicKey: hexBytes(stored.mlKemPublicKey), secretKey: hexBytes(stored.mlKemSecretKey) };
}

/** A successful user-wallet scan must cover the key currently advertised
 * by authenticated account state. Historical extra keys may remain retained. */
export function assertCurrentReceiveKeyOwned(
  account: { receiveKeyHash: string },
  pairs: Iterable<MlKemKeyPair>,
): void {
  if (BigInt(account.receiveKeyHash) === 0n) return;
  const expected = account.receiveKeyHash.toLowerCase();
  for (const pair of pairs) {
    if (receiveKeyHashHex(pair) === expected) return;
  }
  throw new Error("wallet does not own the current authenticated receive key; restore its receive-key keyring before scanning");
}

/** Ensure the wallet's reproducible/default key is retained, then return all
 * locally-owned keys for recovery scanning. */
export function retainWalletReceiveKey(
  data: WalletFileData,
  wallet: WalletProfileWithReceiveKeys,
): WalletProfileWithReceiveKeys {
  retainReceiveKeyPair(data, {
    publicKey: wallet.mlKemPublicKey,
    secretKey: wallet.mlKemSecretKey,
  });
  return wallet;
}
