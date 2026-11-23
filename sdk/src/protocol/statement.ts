import { DEFAULT_EVENT_ENTRY } from "./events.ts";
// The rule statement: what an account's selected rule returns to the kernel,
// [authorizationCommitment, actionCommitment, recentPcashBlockHash, eventEntry]. One-to-one
// with circuits/protocol/lib/src/authorization/statement.nr.
//
// Every action commitment is one formula over (actionDomain, pcashChainId,
// privateValueCommitment, extraData); each role has its own constructor, so an
// action domain is never a free input. Each distinct approval has its own
// domain.

import {
  ACCOUNT_UPDATE_ACTION_DOMAIN,
  AUTHORIZATION_COMMITMENT_DOMAIN,
  CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN,
  MINT_ACTION_DOMAIN,
  SPONSORED_TRANSFER_ACTION_DOMAIN,
  TRANSFER_ACTION_DOMAIN,
} from "../constants/domainTags.ts";
import type { PrivateValueShape } from "../constants/privateValueProfiles.ts";
import { type FieldNumberish, toAddressField, toField } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { privateValueCommitment, SlotClass, type PrivateValue } from "./transaction.ts";

export type RuleStatement = readonly [bigint, bigint, bigint, bigint];

/** Which account acts, under which settings of the selected rule. */
export function authorizationCommitment(address: FieldNumberish, configurationCommitment: FieldNumberish): bigint {
  return poseidon([
    AUTHORIZATION_COMMITMENT_DOMAIN,
    toAddressField(address),
    toField(configurationCommitment, "configurationCommitment"),
  ]);
}

function actionCommitment(
  actionDomain: bigint,
  pcashChainId: FieldNumberish,
  privateValueCommitment: FieldNumberish,
  extraData: FieldNumberish,
): bigint {
  return poseidon([
    actionDomain,
    toField(pcashChainId, "pcashChainId"),
    toField(privateValueCommitment, "privateValueCommitment"),
    toField(extraData, "extraData"),
  ]);
}

/** One account moves its own value: the transfer and restricted-transfer kernels. */
export function transferActionCommitment(pcashChainId: FieldNumberish, privateValueCommitment: FieldNumberish): bigint {
  return actionCommitment(TRANSFER_ACTION_DOMAIN, pcashChainId, privateValueCommitment, 0n);
}

/** One account mints an asset: the mint kernel. The extra data is the ID of the asset the kernel derives. */
export function mintActionCommitment(
  pcashChainId: FieldNumberish,
  privateValueCommitment: FieldNumberish,
  assetId: FieldNumberish,
): bigint {
  return actionCommitment(MINT_ACTION_DOMAIN, pcashChainId, privateValueCommitment, assetId);
}

/**
 * A rule that opens the private value and serves both the transfer and the mint kernel chooses between their actions
 * by its slot classes: the mint action for `mintedAssetId` when an input is a mint marker, else the transfer action,
 * which ignores `mintedAssetId`.
 */
export function ownerActionCommitment(
  pcashChainId: FieldNumberish,
  transaction: PrivateValue,
  mintedAssetId: FieldNumberish,
  shape?: PrivateValueShape,
): bigint {
  const commitment = privateValueCommitment(transaction, shape);
  return transaction.inputs.some((input) => input.slotClass === SlotClass.MINT)
    ? mintActionCommitment(pcashChainId, commitment, mintedAssetId)
    : transferActionCommitment(pcashChainId, commitment);
}

/** The contract side of a sponsored transfer: the contract moves the asset and another account pays the native fee. */
export function sponsoredTransferActionCommitment(
  pcashChainId: FieldNumberish,
  privateValueCommitment: FieldNumberish,
): bigint {
  return actionCommitment(SPONSORED_TRANSFER_ACTION_DOMAIN, pcashChainId, privateValueCommitment, 0n);
}

/** A user account pays the native fee for one named contract's sponsored transfer. */
export function contractFeeSponsorshipActionCommitment(
  pcashChainId: FieldNumberish,
  privateValueCommitment: FieldNumberish,
  contractAddress: FieldNumberish,
): bigint {
  return actionCommitment(CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN, pcashChainId, privateValueCommitment, contractAddress);
}

/** A user-account update together with the fee payment that funds it. */
export function accountUpdateActionCommitment(
  pcashChainId: FieldNumberish,
  privateValueCommitment: FieldNumberish,
  accountUpdateCommitment: FieldNumberish,
): bigint {
  return actionCommitment(ACCOUNT_UPDATE_ACTION_DOMAIN, pcashChainId, privateValueCommitment, accountUpdateCommitment);
}

/** A contract function that serves both the transfer and the sponsored-transfer role chooses between them with `feePaid`. */
export function contractActionCommitment(
  pcashChainId: FieldNumberish,
  privateValueCommitment: FieldNumberish,
  feePaid: boolean,
): bigint {
  return feePaid
    ? sponsoredTransferActionCommitment(pcashChainId, privateValueCommitment)
    : transferActionCommitment(pcashChainId, privateValueCommitment);
}

export function ruleStatement(
  authorizationCommitmentValue: FieldNumberish,
  actionCommitmentValue: FieldNumberish,
  recentPcashBlockHash: FieldNumberish,
  eventEntry: FieldNumberish = DEFAULT_EVENT_ENTRY,
): RuleStatement {
  return [
    toField(authorizationCommitmentValue, "authorizationCommitment"),
    toField(actionCommitmentValue, "actionCommitment"),
    toField(recentPcashBlockHash, "recentPcashBlockHash"),
    toField(eventEntry, "eventEntry"),
  ];
}
