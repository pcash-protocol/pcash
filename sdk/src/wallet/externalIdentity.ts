// PCASH identity derived from an externally produced signature.
//
// An application that connects a browser wallet never sees a private key: it asks
// the wallet to sign one canonical EIP-712 message and expands the verified
// signature into all recoverable profile material.
//
// Nothing here is a spend credential. Authorization remains a fresh per-action
// signature from the connected account. Seed wallets derive the same profile
// fields independently in seedIdentity.ts.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { beBytes, concatBytes, utf8 } from "@pcash/sdk/utils";
import { type FieldNumberish, toField } from "@pcash/sdk/crypto";
import {
  type EcdsaSignatureInput,
  type KeyDerivationTypedMessage,
  keyDerivationTypedData,
  type PcashTypedData,
} from "@pcash/sdk/eip712";
import {
  authorizePcashRequestWithPrivateKey,
  createPcashAuthorizationRequest,
  privateKeyPcashActionSigner,
  type PcashActionSigner,
  type PcashAuthorizationRequest,
  requestPcashAuthorization,
  type VerifiedPcashAuthorization,
  verifyPcashAuthorization,
} from "@pcash/sdk/eip712";
import { nullifierKeyCommitment } from "@pcash/sdk/protocol";
import {
  DEFAULT_NETWORK_CONFIG,
  type NetworkConfig,
  type NetworkConfigLike,
  resolveNetworkConfig,
} from "@pcash/sdk/protocol";
import {
  ML_KEM_768_SEED_LENGTH,
  generateMlKemKeyPair,
} from "@pcash/sdk/protocol";
import { scalarFromBytes } from "@pcash/sdk/utils";
import {
  defaultUserAccountRuleSet,
  type DefaultUserAccountRuleSet,
  type DefaultUserRuleSecrets,
} from "@pcash/sdk/rules";

/**
 * The one message an external signer is asked to sign.
 *
 * Distinct from the SDK profile's per-value contexts on purpose: a browser
 * prompt is expensive, so one signature seeds everything.
 */
export const PROFILE_DERIVATION_CONTEXT = "pcash-profile";

/** HKDF salt labels, one per derived value, so a single signature stays safe as shared IKM. */
const PROFILE_NULLIFIER_ROOT_SALT_LABEL = "pcash.profile.nullifier-root";
const PROFILE_PAYMENT_COMMITMENT_BLINDER_SALT_LABEL =
  "pcash.profile.payment-commitment-blinder";
const PROFILE_BATCH_TRANSFER_COMMITMENT_BLINDER_SALT_LABEL =
  "pcash.profile.batch-transfer-commitment-blinder";
const PROFILE_LARGE_BATCH_TRANSFER_COMMITMENT_BLINDER_SALT_LABEL =
  "pcash.profile.large-batch-transfer-commitment-blinder";
const PROFILE_ACCOUNT_ADMIN_COMMITMENT_BLINDER_SALT_LABEL =
  "pcash.profile.account-admin-commitment-blinder";
const PROFILE_ASSET_PAYMENT_COMMITMENT_BLINDER_SALT_LABEL =
  "pcash.profile.asset-payment-commitment-blinder";
const PROFILE_ASSET_BURN_COMMITMENT_BLINDER_SALT_LABEL =
  "pcash.profile.asset-burn-commitment-blinder";
const PROFILE_CONTRACT_FEE_COMMITMENT_BLINDER_SALT_LABEL =
  "pcash.profile.contract-fee-commitment-blinder";
const PROFILE_MLKEM_SALT_LABEL = "pcash.profile.mlkem-receive-seed";
const PROFILE_APPLICATION_SEED_SALT_LABEL = "pcash.profile.application-seed";
const PROFILE_OUTGOING_KEY_SALT_LABEL = "pcash.profile.outgoing-key";

const HKDF_INFO_SCALAR = "bn254-scalar";
const HKDF_INFO_MLKEM = "ml-kem-768";
const HKDF_INFO_SEED = "application-seed";
const HKDF_INFO_OUTGOING_KEY = "outgoing-key";

function derivationNetwork(
  networkOrChainId: NetworkConfigLike | FieldNumberish,
): NetworkConfig {
  if (
    typeof networkOrChainId === "object"
    && networkOrChainId !== null
    && "pcashChainId" in networkOrChainId
  ) {
    return resolveNetworkConfig(networkOrChainId as NetworkConfigLike);
  }
  return resolveNetworkConfig({
    ...DEFAULT_NETWORK_CONFIG,
    pcashChainId: networkOrChainId as FieldNumberish,
  });
}

/** A profile-derivation signature as `r ‖ s ‖ v` (65 bytes). */
type PcashProfileSignature = EcdsaSignatureInput;

function expandScalar(ikm: Uint8Array, pcashChainId: bigint, saltLabel: string): bigint {
  const salt = sha256(concatBytes(utf8(saltLabel), beBytes(pcashChainId, 4)));
  return scalarFromBytes(hkdf(sha256, ikm, salt, utf8(HKDF_INFO_SCALAR), 48));
}

/**
 * Recoverable private profile material, separate from action-signing capability.
 */
export interface PcashProfile {
  /** The secret from which this profile can be reconstructed. */
  recoveryContract: "ethereum-signature-derived" | "seed-derived";
  /** Public signing identity; the corresponding signing capability stays separate. */
  pubX: Uint8Array;
  pubY: Uint8Array;
  /** The connected account's PCASH account address. */
  address: bigint;
  nkRoot: bigint;
  /** Flat receive-key fields make the profile structurally usable as a note owner. */
  mlKemPublicKey: Uint8Array;
  mlKemSecretKey: Uint8Array;
  /** All durable inputs needed to reproduce the default user rule set. */
  defaultUserRuleSecrets: DefaultUserRuleSecrets;
  /**
   * Domain-separated application material. Applications derive their own named
   * subkeys from this seed; it is never an action-signing credential.
   */
  applicationSeed: Uint8Array;
  /**
   * Keys the sender region of every transaction this wallet builds, so it can
   * reopen what it sent from the recovery root alone. Derived separately from
   * `applicationSeed` and never from `nkRoot`.
   */
  outgoingKey: Uint8Array;
  /** `poseidon(NULLIFIER_KEY_COMMITMENT_DOMAIN, nkRoot)`, as published in the account. */
  nullifierKeyCommitment: bigint;
}

/** The single canonical profile-derivation authorization request. */
export function profileDerivationSigningRequest(
  networkOrChainId: NetworkConfigLike | FieldNumberish,
  account: FieldNumberish,
): PcashAuthorizationRequest<PcashTypedData<"PcashKeyDerivation", KeyDerivationTypedMessage>> {
  return createPcashAuthorizationRequest({
    kind: "profile-derivation",
    authorizingAddress: account,
    typedData: keyDerivationTypedData(
      derivationNetwork(networkOrChainId),
      account,
      PROFILE_DERIVATION_CONTEXT,
    ),
  });
}

function verifiedSignatureIkm(signature: VerifiedPcashAuthorization): Uint8Array {
  return concatBytes(
    beBytes(signature.r, 32),
    beBytes(signature.s, 32),
    Uint8Array.from([signature.yParity]),
  );
}

function deriveVerifiedProfile(
  verified: VerifiedPcashAuthorization,
  networkOrChainId: NetworkConfigLike | FieldNumberish,
): PcashProfile {
  const network = derivationNetwork(networkOrChainId);
  const pcashChainId = toField(network.pcashChainId, "pcashChainId");
  const ikm = verifiedSignatureIkm(verified);
  const nkRoot = expandScalar(ikm, pcashChainId, PROFILE_NULLIFIER_ROOT_SALT_LABEL);
  const paymentCommitmentBlinder = expandScalar(
    ikm,
    pcashChainId,
    PROFILE_PAYMENT_COMMITMENT_BLINDER_SALT_LABEL,
  );
  const batchTransferCommitmentBlinder = expandScalar(
    ikm,
    pcashChainId,
    PROFILE_BATCH_TRANSFER_COMMITMENT_BLINDER_SALT_LABEL,
  );
  const largeBatchTransferCommitmentBlinder = expandScalar(
    ikm, pcashChainId, PROFILE_LARGE_BATCH_TRANSFER_COMMITMENT_BLINDER_SALT_LABEL,
  );
  const largeAssetCreationCommitmentBlinder = expandScalar(ikm, pcashChainId, "pcash.profile.large-asset-creation-commitment-blinder");
  const largeContractFeeCommitmentBlinder = expandScalar(ikm, pcashChainId, "pcash.profile.large-contract-fee-commitment-blinder");
  const accountAdminCommitmentBlinder = expandScalar(
    ikm,
    pcashChainId,
    PROFILE_ACCOUNT_ADMIN_COMMITMENT_BLINDER_SALT_LABEL,
  );
  const assetPaymentCommitmentBlinder = expandScalar(
    ikm,
    pcashChainId,
    PROFILE_ASSET_PAYMENT_COMMITMENT_BLINDER_SALT_LABEL,
  );
  const assetBurnCommitmentBlinder = expandScalar(
    ikm,
    pcashChainId,
    PROFILE_ASSET_BURN_COMMITMENT_BLINDER_SALT_LABEL,
  );
  const contractFeeCommitmentBlinder = expandScalar(
    ikm,
    pcashChainId,
    PROFILE_CONTRACT_FEE_COMMITMENT_BLINDER_SALT_LABEL,
  );
  const assetCreationCommitmentBlinder = expandScalar(ikm, pcashChainId, "pcash.profile.asset-creation-commitment-blinder");
  const mlKemSeed = hkdf(
    sha256,
    ikm,
    sha256(concatBytes(utf8(PROFILE_MLKEM_SALT_LABEL), beBytes(pcashChainId, 4))),
    utf8(HKDF_INFO_MLKEM),
    ML_KEM_768_SEED_LENGTH,
  );
  const applicationSeed = hkdf(
    sha256,
    ikm,
    sha256(concatBytes(utf8(PROFILE_APPLICATION_SEED_SALT_LABEL), beBytes(pcashChainId, 4))),
    utf8(HKDF_INFO_SEED),
    32,
  );
  const outgoingKey = hkdf(
    sha256,
    ikm,
    sha256(concatBytes(utf8(PROFILE_OUTGOING_KEY_SALT_LABEL), beBytes(pcashChainId, 4))),
    utf8(HKDF_INFO_OUTGOING_KEY),
    32,
  );
  const mlKem = generateMlKemKeyPair(mlKemSeed);
  const address = verified.authorizingAddress;
  const defaultUserRuleSecrets: DefaultUserRuleSecrets = {
    paymentCommitmentBlinder,
    batchTransferCommitmentBlinder,
    largeBatchTransferCommitmentBlinder,
    largeAssetCreationCommitmentBlinder,
    largeContractFeeCommitmentBlinder,
    accountAdminCommitmentBlinder,
    assetPaymentCommitmentBlinder,
    assetBurnCommitmentBlinder,
    contractFeeCommitmentBlinder,
    assetCreationCommitmentBlinder,
  };
  return {
    recoveryContract: "ethereum-signature-derived",
    pubX: verified.pubX.slice(),
    pubY: verified.pubY.slice(),
    address,
    nkRoot,
    mlKemPublicKey: mlKem.publicKey,
    mlKemSecretKey: mlKem.secretKey,
    defaultUserRuleSecrets,
    applicationSeed,
    outgoingKey,
    nullifierKeyCommitment: nullifierKeyCommitment(nkRoot),
  };
}

/**
 * Derive a complete Ethereum-signature-derived PCASH identity from one signature over
 * the {@link profileDerivationSigningRequest} typed data.
 *
 * The signature is the master secret. It must never be logged or sent to a
 * server. A browser wallet may retain it in origin-local durable storage to
 * restore an explicit sign-in without prompting the external signer again.
 */
export function derivePcashProfileFromSignature(
  signature: PcashProfileSignature,
  networkOrChainId: NetworkConfigLike | FieldNumberish,
  account: FieldNumberish,
): PcashProfile {
  const request = profileDerivationSigningRequest(networkOrChainId, account);
  return deriveVerifiedProfile(
    verifyPcashAuthorization(request, signature),
    networkOrChainId,
  );
}

/** Ask an action signer for the canonical profile signature and verify it. */
export async function requestPcashProfile(
  signer: PcashActionSigner,
  networkOrChainId: NetworkConfigLike | FieldNumberish,
): Promise<PcashProfile> {
  const request = profileDerivationSigningRequest(networkOrChainId, signer.address);
  return deriveVerifiedProfile(
    await requestPcashAuthorization(signer, request),
    networkOrChainId,
  );
}

/** Headless convenience adapter over the canonical profile request. */
export function derivePcashProfileFromPrivateKey(
  privateKey: Uint8Array,
  networkOrChainId: NetworkConfigLike | FieldNumberish,
): PcashProfile {
  const signer = privateKeyPcashActionSigner(privateKey);
  const boundRequest = profileDerivationSigningRequest(networkOrChainId, signer.address);
  return deriveVerifiedProfile(
    authorizePcashRequestWithPrivateKey(privateKey, boundRequest),
    networkOrChainId,
  );
}

export interface PcashProfileAccountView {
  address: string;
  nullifierKeyCommitment: string;
  accountRuleSetCommitment: string;
  accountKind: number;
  receiveKeyHash: string;
}

/** Bind a profile to the immutable identity fields of an authenticated user account. */
export function assertPcashProfileMatchesAccountIdentity(
  profile: PcashProfile,
  account: PcashProfileAccountView,
): void {
  if (BigInt(account.address) !== profile.address || account.accountKind !== 0) {
    throw new Error("authenticated PCASH account does not belong to this user profile");
  }
  if (BigInt(account.nullifierKeyCommitment) !== profile.nullifierKeyCommitment) {
    throw new Error(
      "derived PCASH profile does not match the account's nullifier-key commitment; "
      + "the wallet returned a different profile signature or the account uses another profile",
    );
  }
}

/** Fail before authorization/spend if a canonical profile cannot open the
 * account's installed default user rule set, and return that rule set.
 * Receive-key rotation is independent. */
export function assertPcashProfileMatchesAccount(
  profile: PcashProfile,
  account: PcashProfileAccountView,
  network: NetworkConfigLike,
): DefaultUserAccountRuleSet {
  const resolved = resolveNetworkConfig(network);
  assertPcashProfileMatchesAccountIdentity(profile, account);
  const rules = defaultUserAccountRuleSet({
    wallet: profile,
    network: resolved,
    secrets: profile.defaultUserRuleSecrets,
  });
  if (BigInt(account.accountRuleSetCommitment) !== rules.accountRuleSetCommitment) {
    throw new Error("derived PCASH profile does not reproduce the account's default rule set");
  }
  return rules;
}
