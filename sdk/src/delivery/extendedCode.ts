import type { FieldNumberish } from "../crypto/field.ts";
import { beBytes, bytesEqual, bytesToBigInt, concatBytes, fromBase64Url, toBase64Url } from "../utils/bytes.ts";
import { keccak256 } from "../utils/keccak.ts";
import { ML_KEM_768_PUBLIC_KEY_LENGTH } from "../constants/params.ts";
import type { WalletProfileWithReceiveKeys } from "../protocol/types.ts";

export const EXTENDED_CODE_VERSION = 2;
const EXTENDED_CODE_BODY_LENGTH = 1 + 4 + 20 + ML_KEM_768_PUBLIC_KEY_LENGTH;
const EXTENDED_CODE_CHECKSUM_LENGTH = 4;
const EXTENDED_CODE_LENGTH = EXTENDED_CODE_BODY_LENGTH + EXTENDED_CODE_CHECKSUM_LENGTH;

export interface ExtendedCode {
  version: number;
  chainId: bigint;
  address: bigint;
  mlKemPublicKey: Uint8Array;
}

export function buildExtendedCode(params: {
  version?: number;
  chainId: FieldNumberish;
  address: FieldNumberish;
  mlKemPublicKey: Uint8Array;
}): string {
  const version = params.version ?? EXTENDED_CODE_VERSION;
  if (version !== EXTENDED_CODE_VERSION) throw new Error(`extended code version must be ${EXTENDED_CODE_VERSION}`);
  if (params.mlKemPublicKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new Error(`mlKemPublicKey must be ${ML_KEM_768_PUBLIC_KEY_LENGTH} bytes`);
  }
  const body = concatBytes(
    Uint8Array.from([version]),
    beBytes(params.chainId, 4),
    beBytes(params.address, 20),
    params.mlKemPublicKey,
  );
  return toBase64Url(concatBytes(body, keccak256(body).subarray(0, EXTENDED_CODE_CHECKSUM_LENGTH)));
}

export function parseExtendedCode(code: string): ExtendedCode {
  const bytes = fromBase64Url(code);
  if (bytes.length !== EXTENDED_CODE_LENGTH) throw new Error("extended code has wrong length");
  const version = bytes[0]!;
  if (version !== EXTENDED_CODE_VERSION) throw new Error(`unknown extended code version ${version}`);
  const body = bytes.subarray(0, EXTENDED_CODE_BODY_LENGTH);
  const checksum = bytes.subarray(EXTENDED_CODE_BODY_LENGTH);
  if (!bytesEqual(keccak256(body).subarray(0, EXTENDED_CODE_CHECKSUM_LENGTH), checksum)) {
    throw new Error("extended code checksum mismatch");
  }
  return {
    version,
    chainId: bytesToBigInt(bytes.subarray(1, 5)),
    address: bytesToBigInt(bytes.subarray(5, 25)),
    mlKemPublicKey: bytes.slice(25, 25 + ML_KEM_768_PUBLIC_KEY_LENGTH),
  };
}

export function walletExtendedCode(wallet: WalletProfileWithReceiveKeys, chainId: FieldNumberish): string {
  return buildExtendedCode({ chainId, address: wallet.address, mlKemPublicKey: wallet.mlKemPublicKey });
}
