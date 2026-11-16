// Shared PCASH witness and transfer types.
//
// Wallet profile shapes live here rather than in wallet/ so the reference rule layer can
// name a wallet without depending on how one is derived.

import type { FieldNumberish } from "../crypto/field.ts";

/**
 * A PCASH note binds its `owner` address, a per-note `noteSecret`, an
 * `assetId`, and an `amount`. `assetId = 0` is native PCASH.
 */
export interface Note {
  owner: FieldNumberish;
  noteSecret: FieldNumberish;
  assetId: FieldNumberish;
  amount: FieldNumberish;
}

export interface WalletIdentity {
  /** 32-byte big-endian public key coordinates. */
  pubX: Uint8Array;
  pubY: Uint8Array;
  /** uint160 Ethereum address = low160(keccak256(pubX || pubY)). */
  address: bigint;
}

/** A local signing identity used only by raw-key adapters and deterministic tests. */
export interface LocalWalletIdentity extends WalletIdentity {
  /** 32-byte secp256k1 private key. Never required by a production builder. */
  privKey: Uint8Array;
}

export interface WalletProfile extends WalletIdentity {
  /** BN254 nullifier-root scalar. */
  nkRoot: bigint;
  /** ML-KEM-768 public receive key (1184 bytes) — account / extended code. */
  mlKemPublicKey?: Uint8Array;
  /** ML-KEM-768 secret receive key (2400 bytes) — envelope scanning. */
  mlKemSecretKey?: Uint8Array;
}

/** Wallet profile backed by a local private key. */
export interface LocalWalletProfile extends WalletProfile, LocalWalletIdentity {}

/** Wallet profile with the receive material required by scanning. */
export interface WalletProfileWithReceiveKeys extends WalletProfile {
  mlKemPublicKey: Uint8Array;
  mlKemSecretKey: Uint8Array;
}
