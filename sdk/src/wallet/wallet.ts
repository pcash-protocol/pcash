// PCASH wallet profile material.
//
// A wallet describes the public signing identity plus the private material used
// to discover and nullify notes. Per-action signing is a separate capability:
// browser wallets never expose a private key, while the CLI's local-key adapter
// may hold one. The protocol commits to `nkRoot` but does not prescribe how a
// wallet derives or stores it.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type FieldNumberish, toField } from "@pcash/sdk/crypto";
import {
  beBytes,
  concatBytes,
  utf8,
} from "@pcash/sdk/utils";
import {
  ML_KEM_768_SECRET_KEY_LENGTH,
  ML_KEM_768_SEED_LENGTH,
  type MlKemKeyPair,
  generateMlKemKeyPair,
} from "@pcash/sdk/protocol";
import { ML_KEM_768_PUBLIC_KEY_LENGTH } from "@pcash/sdk/constants";
import type {
  WalletProfile,
  WalletProfileWithReceiveKeys,
} from "@pcash/sdk/protocol";
export { EXTENDED_CODE_VERSION, buildExtendedCode, parseExtendedCode, walletExtendedCode } from "@pcash/sdk/delivery";
export type { ExtendedCode } from "@pcash/sdk/delivery";

/** Derive an application-owned receive key from recoverable profile material. */
export function deterministicMlKemKeysFromApplicationSeed(
  applicationSeed: Uint8Array,
  context: FieldNumberish,
): MlKemKeyPair {
  if (!(applicationSeed instanceof Uint8Array) || applicationSeed.length !== 32) {
    throw new Error("applicationSeed must be 32 bytes");
  }
  const seed = hkdf(
    sha256,
    concatBytes(applicationSeed, beBytes(toField(context, "context"), 32)),
    utf8("pcash.application.mlkem-receive-seed"),
    utf8("ml-kem-768"),
    ML_KEM_768_SEED_LENGTH,
  );
  return generateMlKemKeyPair(seed);
}

/** Require the complete receive material needed by delivery and scanning. */
export function requireReceiveKeys<T extends WalletProfile>(wallet: T): T & WalletProfileWithReceiveKeys {
  if (
    !(wallet.mlKemPublicKey instanceof Uint8Array)
    || wallet.mlKemPublicKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH
    || !(wallet.mlKemSecretKey instanceof Uint8Array)
    || wallet.mlKemSecretKey.length !== ML_KEM_768_SECRET_KEY_LENGTH
  ) {
    throw new Error("wallet profile has no complete receive key; derive or restore the canonical profile first");
  }
  return wallet as T & WalletProfileWithReceiveKeys;
}
