import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toField, type FieldNumberish } from "../src/crypto/field.ts";
import { addressFromPublicKeyXY, publicKeyXY } from "../src/eip712/eip712.ts";
import {
  authorizePcashRequestWithPrivateKey,
  type PcashAuthorizationResolver,
} from "../src/eip712/authorization.ts";
import {
  generateMlKemKeyPair,
  ML_KEM_768_SEED_LENGTH,
  type MlKemKeyPair,
} from "../src/protocol/envelope.ts";
import type { LocalWalletProfile, WalletProfileWithReceiveKeys } from "../src/protocol/types.ts";
import { beBytes, concatBytes, utf8 } from "../src/utils/bytes.ts";

export const TEST_PRIV_KEY = Uint8Array.from(
  Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"),
);
export const TEST_NK_ROOT = 0x0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708n;

export interface DeriveTestWalletOptions {
  privKey?: Uint8Array;
  nkRoot?: FieldNumberish;
  mlKem?: MlKemKeyPair | "deterministic";
}

/** A deterministic wallet always carries its ML-KEM receive keys. */
export function deriveTestWallet(
  opts: DeriveTestWalletOptions & { mlKem: "deterministic" },
): LocalWalletProfile & WalletProfileWithReceiveKeys;
export function deriveTestWallet(opts?: DeriveTestWalletOptions): LocalWalletProfile;
export function deriveTestWallet(opts: DeriveTestWalletOptions = {}): LocalWalletProfile {
  const privKey = opts.privKey ?? TEST_PRIV_KEY;
  const { x, y } = publicKeyXY(privKey);
  const address = addressFromPublicKeyXY(concatBytes(x, y));
  const nkRoot = toField(opts.nkRoot ?? TEST_NK_ROOT, "nkRoot");
  const wallet: LocalWalletProfile = {
    privKey,
    pubX: x,
    pubY: y,
    address,
    nkRoot,
  };
  const mlKem = opts.mlKem === "deterministic"
    ? generateMlKemKeyPair(hkdf(
        sha256,
        concatBytes(privKey, beBytes(nkRoot, 32)),
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
