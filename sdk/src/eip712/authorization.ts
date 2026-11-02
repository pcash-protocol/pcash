// Platform-neutral PCASH action authorization.
//
// Transaction construction produces one exact EIP-712 request. A browser
// adapter can hand its typed data to an injected wallet; a headless adapter can
// sign the already-computed digest. Both return the same verified witness
// material, and neither path gives builders access to a private key.

import { addressHex } from "../utils/hex.ts";
import { type FieldNumberish, toAddressField } from "../crypto/field.ts";
import {
  assertValidPrivKey,
  type EcdsaSignatureInput,
  type PcashTypedData,
  pcashSigningHash,
  type RecoveredEcdsa,
  publicKeyXY,
  addressFromPublicKeyXY,
  recoverEcdsaSignature,
  serializeEcdsaSignature,
  signDigest,
} from "./eip712.ts";
import { bytesEqual, concatBytes } from "../utils/bytes.ts";
import type { LocalWalletIdentity, WalletProfile } from "../protocol/types.ts";

export type PcashAuthorizationKind =
  | "selected-relay-quote"
  | "profile-derivation"
  | "account-creation"
  | "account-update"
  | "payment"
  | "asset-creation"
  | "asset-payment"
  | "asset-burn"
  | "batch-transfer"
  | "contract-fee-sponsorship"
  | "marketplace-reclaim"
  | "fixture";

/** One exact message an account must authorize. */
export interface PcashAuthorizationRequest<
  TypedData extends PcashTypedData = PcashTypedData,
> {
  kind: PcashAuthorizationKind;
  authorizingAddress: bigint;
  /** hashTypedData of `typedData`: the digest the relevant node/circuit verifies. */
  digest: Uint8Array;
  /** The exact payload a wallet displays and signs. */
  typedData: TypedData;
}

/** A signing capability, deliberately separate from recoverable profile data. */
export interface PcashActionSigner {
  readonly address: bigint;
  signTypedData(request: PcashAuthorizationRequest): Promise<EcdsaSignatureInput>;
}

/** Canonical low-s signature and recovered key material ready for a witness. */
export interface VerifiedPcashAuthorization extends RecoveredEcdsa {
  authorizingAddress: bigint;
}

export type PcashAuthorizationResolver = (
  request: PcashAuthorizationRequest,
) => VerifiedPcashAuthorization;

/** The request for one typed-data payload; its digest is derived from that payload. */
export function createPcashAuthorizationRequest<
  TypedData extends PcashTypedData,
>(params: {
  kind: PcashAuthorizationKind;
  authorizingAddress: FieldNumberish;
  typedData: TypedData;
}): PcashAuthorizationRequest<TypedData> {
  return {
    kind: params.kind,
    authorizingAddress: toAddressField(
      params.authorizingAddress,
      "authorizingAddress",
    ),
    digest: pcashSigningHash(params.typedData),
    typedData: params.typedData,
  };
}

/** Verify that external signature bytes authorize this exact request/account. */
export function verifyPcashAuthorization(
  request: PcashAuthorizationRequest,
  signature: EcdsaSignatureInput,
): VerifiedPcashAuthorization {
  const recovered = recoverEcdsaSignature(
    request.digest,
    signature,
    `${request.kind} signature`,
  );
  if (recovered.address !== request.authorizingAddress) {
    throw new Error(
      `${request.kind} signature recovers ${addressHex(recovered.address)}, `
        + `expected ${addressHex(request.authorizingAddress)}`,
    );
  }
  return {
    ...recovered,
    authorizingAddress: request.authorizingAddress,
  };
}

/** Rebind previously verified witness material to the exact request being built. */
export function requirePcashAuthorization(
  request: PcashAuthorizationRequest,
  authorization: VerifiedPcashAuthorization,
): VerifiedPcashAuthorization {
  return verifyPcashAuthorization(
    request,
    serializeEcdsaSignature(authorization),
  );
}

/** Ask the selected signer, then verify its answer before exposing witness data. */
export async function requestPcashAuthorization(
  signer: PcashActionSigner,
  request: PcashAuthorizationRequest,
): Promise<VerifiedPcashAuthorization> {
  const signerAddress = toAddressField(signer.address, "signer.address");
  if (signerAddress !== request.authorizingAddress) {
    throw new Error("selected PCASH signer does not match the action's authorizing address");
  }
  return verifyPcashAuthorization(request, await signer.signTypedData(request));
}

/** Synchronous raw-key adapter for headless tooling and deterministic tests. */
export function authorizePcashRequestWithPrivateKey(
  privateKey: Uint8Array,
  request: PcashAuthorizationRequest,
): VerifiedPcashAuthorization {
  assertValidPrivKey(privateKey);
  return verifyPcashAuthorization(request, serializeEcdsaSignature(signDigest(privateKey, request.digest)));
}

/** Derive the secp256k1 identity shared by wallets and authorization signers. */
export function deriveWalletIdentity(privKey: Uint8Array): LocalWalletIdentity {
  assertValidPrivKey(privKey);
  const { x, y } = publicKeyXY(privKey);
  const address = addressFromPublicKeyXY(concatBytes(x, y));
  return { privKey, pubX: x, pubY: y, address };
}

/**
 * Headless/raw-key adapter implementing the same boundary as an injected wallet.
 * The copied key remains closed over by the signer and is never placed in profile
 * or transaction-builder input data.
 */
export function privateKeyPcashActionSigner(privateKey: Uint8Array): PcashActionSigner {
  const key = privateKey.slice();
  const { address } = deriveWalletIdentity(key);
  return {
    address,
    async signTypedData(request): Promise<EcdsaSignatureInput> {
      if (request.authorizingAddress !== address) {
        throw new Error("raw-key PCASH signer does not match the action's authorizing address");
      }
      return serializeEcdsaSignature(signDigest(key, request.digest));
    },
  };
}

/**
 * Verify a verified profile signature is exactly this wallet's: the recovering
 * address and both public-key coordinates must match the profile. The single
 * definition for every builder that binds an authorization to a wallet.
 */
export function requireWalletAuthorization(
  wallet: WalletProfile,
  authorization: VerifiedPcashAuthorization,
  label: string,
): void {
  if (authorization.authorizingAddress !== wallet.address) {
    throw new Error(`${label} authorization does not match the wallet address`);
  }
  if (!bytesEqual(authorization.pubX, wallet.pubX) || !bytesEqual(authorization.pubY, wallet.pubY)) {
    throw new Error(`${label} authorization public key does not match the wallet profile`);
  }
}
