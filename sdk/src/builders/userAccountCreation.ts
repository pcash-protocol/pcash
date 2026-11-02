// PCASH witness builders.
//
// Produces the exact Prover.toml witness shapes the reference circuits consume,
// building a coherent scenario end to end: a transfer authorized by a real
// secp256k1 signature under the reference ECDSA rule (which binds the
// canonical private-value commitment), folded with the protocol kernel;
// standalone first/subsequent transfers; and a signed account body.

import {
  type NetworkConfigLike
} from "../protocol/network.ts";
import { toField, type FieldNumberish } from "../crypto/field.ts";
import {
  createPcashAuthorizationRequest,
  requestPcashAuthorization,
  requirePcashAuthorization,
  type PcashActionSigner,
  type PcashAuthorizationRequest,
  type PcashAuthorizationResolver,
  type VerifiedPcashAuthorization,
} from "../eip712/authorization.ts";
import { accountCreationTypedData } from "../eip712/eip712.ts";
import {
  validateReferenceWalletRuleSet,
  type IrreversibleRuleOverride,
  type ReferenceWalletRuleInspection,
} from "../rules/ruleSafety.ts";
import {
  type DefaultUserRuleSecrets
} from "../rules/referenceRules.ts";
import {
  nullifierKeyCommitment
} from "../protocol/notes.ts";
import type { WalletProfile } from "../protocol/types.ts";
import { encodeReceiveKey, USER_ACCOUNT_AUTH_DIRECT, USER_ACCOUNT_AUTH_SIGNED } from "../protocol/codec.ts";
import { beBytes, field32, concatBytes } from "../utils/bytes.ts";
import { receiveKeyHash as receiveKeyHashOf } from "../protocol/account.ts";
import { defaultEcdsaRuleSet } from "./nativeTransfer.ts";
import { networkForChain } from "../protocol/network.ts";
import { requireWalletAuthorization } from "../eip712/authorization.ts";
export interface BuildUserAccountCreationParams {
  chainId: FieldNumberish;
  network?: NetworkConfigLike;
  wallet: WalletProfile;
  authorization?: VerifiedPcashAuthorization;
  authorizationResolver?: PcashAuthorizationResolver;
  /**
   * Low-level opaque rule-set commitment. Reference clients should use the
   * reference creation wrappers below. When omitted, the four-rule readable
   * ECDSA set is reconstructed by `defaultEcdsaRuleSet`.
   */
  unsafeOpaqueRuleSetCommitment?: FieldNumberish;
  /** Required when unsafeOpaqueRuleSetCommitment is omitted. Ethereum-derived profiles reconstruct it from the profile signature. */
  defaultRuleSecrets?: DefaultUserRuleSecrets;
  mlKemPublicKey?: Uint8Array; // 1184 bytes when present
  recentPcashBlockHash: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
}

export interface UserAccountCreationBuild {
  /** Creation authorization mode, common account fields, and EIP-712 signature. */
  body: Uint8Array;
  address: bigint;
  nullifierKeyCommitment: bigint;
  signingHash: Uint8Array;
  r: bigint;
  s: bigint;
  yParity: number;
}

export interface PreparedUserAccountCreationBuild {
  address: bigint;
  nullifierKeyCommitment: bigint;
  signingHash: Uint8Array;
  authorizationRequest: PcashAuthorizationRequest;
  authorize: (authorization: VerifiedPcashAuthorization) => UserAccountCreationBuild;
}

function commonUserAccountCreation(params: BuildUserAccountCreationParams) {
  const chainId = toField(params.chainId, "chainId");
  const network = networkForChain(chainId, params.network);
  const { wallet } = params;
  const ruleSetCommitment =
    params.unsafeOpaqueRuleSetCommitment !== undefined
      ? toField(params.unsafeOpaqueRuleSetCommitment, "unsafeOpaqueRuleSetCommitment")
      : params.defaultRuleSecrets !== undefined
        ? defaultEcdsaRuleSet({
          wallet,
          network,
          secrets: params.defaultRuleSecrets,
        }).ruleSetCommitment
        : (() => {
          throw new Error(
            "defaultRuleSecrets are required when unsafeOpaqueRuleSetCommitment is omitted",
          );
        })();
  const receiveKey = encodeReceiveKey(params.mlKemPublicKey);
  const p = nullifierKeyCommitment(wallet.nkRoot);
  const receiveKeyHash = params.mlKemPublicKey === undefined ? 0n : receiveKeyHashOf(params.mlKemPublicKey);
  const recentPcashBlockHash = toField(params.recentPcashBlockHash, "recentPcashBlockHash");
  const validUntilTimestamp = toField(params.validUntilTimestamp, "validUntilTimestamp");
  if (validUntilTimestamp >= 1n << 64n) {
    throw new Error("validUntilTimestamp must fit in 64 bits");
  }

  const creationMessage = {
    pcashChainId: chainId,
    nullifierKeyCommitment: p,
    ruleSetCommitment,
    receiveKeyHash,
    recentPcashBlockHash,
    validUntilTimestamp,
  };
  const body = concatBytes(
    field32(p), field32(ruleSetCommitment), receiveKey,
    field32(recentPcashBlockHash), beBytes(validUntilTimestamp, 8),
  );
  return { body, address: wallet.address, nullifierKeyCommitment: p, network, creationMessage };
}

/** Low-level signed preparation with an explicit rule-set root when requested. */
export function prepareUserAccountCreation(params: BuildUserAccountCreationParams): PreparedUserAccountCreationBuild {
  const { body: commonBody, address, nullifierKeyCommitment: p, network, creationMessage } = commonUserAccountCreation(params);
  const { wallet } = params;
  const authorizationRequest = createPcashAuthorizationRequest({
    kind: "account-creation",
    authorizingAddress: wallet.address,
    typedData: accountCreationTypedData(network, creationMessage),
  });
  const signingHash = authorizationRequest.digest;

  // The node creates the account at whatever address the signature recovers
  // to, so the signature must recover to this wallet before the body exists.
  const authorize = (authorization: VerifiedPcashAuthorization): UserAccountCreationBuild => {
    const sig = requirePcashAuthorization(authorizationRequest, authorization);
    requireWalletAuthorization(wallet, sig, "account");
    const body = concatBytes(Uint8Array.of(USER_ACCOUNT_AUTH_SIGNED), commonBody,
      beBytes(sig.r, 32), beBytes(sig.s, 32), Uint8Array.of(sig.yParity));
    return {
      body,
      address: wallet.address,
      nullifierKeyCommitment: p,
      signingHash,
      r: sig.r,
      s: sig.s,
      yParity: sig.yParity,
    };
  };

  return { address, nullifierKeyCommitment: p, signingHash, authorizationRequest, authorize };
}

/** Low-level finalization primitive. It intentionally accepts an opaque rule-set root. */
export function buildUserAccountCreation(
  params: BuildUserAccountCreationParams,
): UserAccountCreationBuild {
  const prepared = prepareUserAccountCreation(params);
  const authorization = params.authorization
    ?? params.authorizationResolver?.(prepared.authorizationRequest);
  if (authorization === undefined) {
    throw new Error("buildUserAccountCreation requires an authorization or authorizationResolver");
  }
  return prepared.authorize(authorization);
}

/** Low-level signer adapter. It intentionally accepts an opaque rule-set root. */
async function buildAuthorizedUserAccountCreation(
  params: BuildUserAccountCreationParams,
  signer: PcashActionSigner,
): Promise<UserAccountCreationBuild> {
  const prepared = prepareUserAccountCreation(params);
  return prepared.authorize(
    await requestPcashAuthorization(signer, prepared.authorizationRequest),
  );
}

/** Explicit acknowledgement for a custom root whose entries the reference wallet cannot inspect. */
export interface IrreversibleOpaqueUserRuleOverride {
  acknowledgeOpaqueRuleSet: true;
}

export interface BuildReferenceUserAccountCreationParams
  extends Omit<BuildUserAccountCreationParams, "unsafeOpaqueRuleSetCommitment"> {
  /** A custom root accepted only after inspection or the explicit opaque-rule-set override. */
  ruleSetCommitment?: FieldNumberish;
  /** Required for an ordinary custom-root flow. */
  ruleInspection?: ReferenceWalletRuleInspection;
  /** Permits an inspected rule set that deliberately omits roles or verified independent recovery. */
  irreversibleRuleOverride?: IrreversibleRuleOverride;
  /** Advanced escape hatch for a deliberately opaque custom root. */
  irreversibleOpaqueRuleOverride?: IrreversibleOpaqueUserRuleOverride;
}

function referenceUserAccountCreationParams(
  params: BuildReferenceUserAccountCreationParams,
): BuildUserAccountCreationParams {
  const {
    ruleSetCommitment,
    ruleInspection,
    irreversibleRuleOverride,
    irreversibleOpaqueRuleOverride,
    ...buildParams
  } = params;
  if (ruleSetCommitment === undefined) {
    if (
      ruleInspection !== undefined
      || irreversibleRuleOverride !== undefined
      || irreversibleOpaqueRuleOverride !== undefined
    ) {
      throw new Error("default user account creation does not accept custom rule-set safety options");
    }
    return buildParams;
  }
  if (ruleInspection !== undefined) {
    if (irreversibleOpaqueRuleOverride !== undefined) {
      throw new Error("an inspected user-account rule set cannot also use the opaque-rule-set override");
    }
    validateReferenceWalletRuleSet({
      expectedRuleSetCommitment: ruleSetCommitment,
      inspection: ruleInspection,
      ...(irreversibleRuleOverride === undefined
        ? {}
        : { irreversibleOverride: irreversibleRuleOverride }),
    });
    return {
      ...buildParams,
      unsafeOpaqueRuleSetCommitment: ruleSetCommitment,
    };
  }
  if (irreversibleRuleOverride !== undefined) {
    throw new Error("an irreversible rule override requires inspected rule entries");
  }
  if (irreversibleOpaqueRuleOverride?.acknowledgeOpaqueRuleSet !== true) {
    throw new Error(
      "an opaque user-account rule set requires the irreversible opaque-rule-set override",
    );
  }
  return {
    ...buildParams,
    unsafeOpaqueRuleSetCommitment: ruleSetCommitment,
  };
}

/** Synchronous reference-wallet creation with rule-safety enforcement. */
export function buildReferenceUserAccountCreation(
  params: BuildReferenceUserAccountCreationParams,
): UserAccountCreationBuild {
  return buildUserAccountCreation(referenceUserAccountCreationParams(params));
}

/** Async reference-wallet creation with rule-safety enforcement. */
export async function buildAuthorizedReferenceUserAccountCreation(
  params: BuildReferenceUserAccountCreationParams,
  signer: PcashActionSigner,
): Promise<UserAccountCreationBuild> {
  return buildAuthorizedUserAccountCreation(
    referenceUserAccountCreationParams(params),
    signer,
  );
}

export type BuildDirectReferenceUserAccountCreationParams = Omit<BuildReferenceUserAccountCreationParams, "authorization" | "authorizationResolver">;

export interface DirectUserAccountCreationBuild {
  body: Uint8Array;
  address: bigint;
  nullifierKeyCommitment: bigint;
}

/** Creation authorized by the carrying Ethereum transaction's sender, with the same reference rule checks. */
export function buildDirectReferenceUserAccountCreation(params: BuildDirectReferenceUserAccountCreationParams): DirectUserAccountCreationBuild {
  const { body, address, nullifierKeyCommitment: p } = commonUserAccountCreation(referenceUserAccountCreationParams(params));
  return { body: concatBytes(Uint8Array.of(USER_ACCOUNT_AUTH_DIRECT), body), address, nullifierKeyCommitment: p };
}
