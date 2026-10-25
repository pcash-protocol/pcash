import type { MlKemKeyPair } from "@pcash/sdk/protocol";
import {
  generateMlKemKeyPair,
  ML_KEM_768_SEED_LENGTH,
} from "@pcash/sdk/protocol";
import { toField, type FieldNumberish } from "@pcash/sdk/crypto";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { beBytes, concatBytes, utf8 } from "@pcash/sdk/utils";
import {
  authorizePcashRequestWithPrivateKey,
  type PcashAuthorizationResolver,
} from "@pcash/sdk/eip712";
import type { LocalWalletProfile } from "@pcash/sdk/protocol";
import { deriveWalletIdentity } from "@pcash/sdk/eip712";

/** Deterministic fixture private key; address 0x87c018ef…77a9. */
export const TEST_PRIV_KEY = Uint8Array.from(
  Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"),
);

/** Deterministic fixture nkRoot matching the reference transfer scenario. */
export const TEST_NK_ROOT = 0x0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708n;

export interface DeriveTestWalletOptions {
  privKey?: Uint8Array;
  nkRoot?: FieldNumberish;
  mlKem?: MlKemKeyPair | "deterministic";
}

/** Build a deterministic wallet for tests and circuit-bundle fixture generators. */
export function deriveTestWallet(opts: DeriveTestWalletOptions = {}): LocalWalletProfile {
  const identity = deriveWalletIdentity(opts.privKey ?? TEST_PRIV_KEY);
  const nkRoot = toField(opts.nkRoot ?? TEST_NK_ROOT, "nkRoot");
  const wallet: LocalWalletProfile = { ...identity, nkRoot };
  const mlKem = opts.mlKem === "deterministic"
    ? generateMlKemKeyPair(hkdf(
        sha256,
        concatBytes(identity.privKey, beBytes(nkRoot, 32)),
        utf8("pcash.mlkem-receive-seed"),
        utf8("ml-kem-768"),
        ML_KEM_768_SEED_LENGTH,
      ))
    : opts.mlKem;
  if (mlKem !== undefined) {
    wallet.mlKemPublicKey = mlKem.publicKey;
    wallet.mlKemSecretKey = mlKem.secretKey;
  }
  return wallet;
}

export function testAuthorizationResolver(wallet: LocalWalletProfile): PcashAuthorizationResolver {
  return (request) => authorizePcashRequestWithPrivateKey(wallet.privKey, request);
}
