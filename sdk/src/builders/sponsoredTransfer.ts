import { PRIVATE_VALUE_PROFILES, privateValueProfile } from "../constants/privateValueProfiles.ts";
import { authorizationIssuanceOpening, type DesignatedIssuanceOpening } from "../protocol/payout.ts";
// Witness assembly for `circuits/protocol/private_value/s/sponsored_transfer_kernel`.
//
// One asset action with two authorizing accounts: the primary moves the asset
// and owns every APPLICATION marker; a distinct fee payer contributes native
// PCASH for the protocol fee and takes at most one change note back. The role
// partition comes from the slot classes, so nothing here chooses it — this
// builder only supplies the openings each side already implies.

import {
  type AssetActionBuild,
} from "./assetAction.ts";
import type { AssetAccountAuthorization } from "./assetOutputs.ts";
import type { ChonkVkArtifacts } from "../protocol/account.ts";
import {
  absentInputMap,
  authorizedAccountMap,
  inputNoteMap,
  snapshotWitnessMap,
  vkWitnessMap,
} from "./witnessMaps.ts";
import {
  fieldArrayMap,
  fm,
  privateValueChoicesMap,
  ruleStatementMap,
} from "../protocol/witness.ts";
import { toAddressField, toField, type FieldNumberish } from "../crypto/field.ts";
import { ACCOUNT_KIND_CONTRACT } from "../constants/params.ts";
import { SlotClass } from "../protocol/transaction.ts";
import {
  authorizationCommitment,
  contractFeeSponsorshipActionCommitment,
  ruleStatement,
  sponsoredTransferActionCommitment,
} from "../protocol/statement.ts";
import {
  createPcashAuthorizationRequest,
  requirePcashAuthorization,
  type PcashAuthorizationRequest,
  type VerifiedPcashAuthorization,
} from "../eip712/authorization.ts";
import { networkForChain, type NetworkConfigLike } from "../protocol/network.ts";
import {
  contractFeeSponsorshipTypedData,
} from "../rules/semanticRules.ts";
import { buildContractFeeSponsorshipRuleWitness } from "../rules/semanticWitnesses.ts";
import type { WalletProfile } from "../protocol/types.ts";
import type { NativeFeePaymentBuild } from "./feePayment.ts";

export interface SponsoredTransferWitnessParams {
  build: AssetActionBuild;
  snapshot: {
    recentPcashBlockHash: FieldNumberish;
    stateRoot: FieldNumberish;
    stateRootHeaderSiblings: readonly FieldNumberish[];
    outputRoot: FieldNumberish;
    outputRootStateSiblings: readonly FieldNumberish[];
    accountStateRoot: FieldNumberish;
    accountStateRootStateSiblings: readonly FieldNumberish[];
  };
  pcashChainId: FieldNumberish;
  assetId: FieldNumberish;
  primary: AssetAccountAuthorization;
  feePayer: AssetAccountAuthorization;
  nativeRelayPayment?: { slot: number; amount: bigint; ownerCommitment: FieldNumberish };
  primaryVk: ChonkVkArtifacts;
  feeVk: ChonkVkArtifacts;
}





/**
 * Assemble the relation's witness, checking the openings the circuit will check
 * so a mismatch names itself here rather than surfacing as a broken constraint.
 */
export function buildSponsoredTransferWitness(params: SponsoredTransferWitnessParams): {
  primaryActionCommitment: bigint;
  feeActionCommitment: bigint;
  witnessMap: Record<string, unknown>;
} {
  const { build, primary, feePayer } = params;
  const { inputs: N_IN } = privateValueProfile(build.shape);
  const assetId = toField(params.assetId, "assetId");
  const pcashChainId = toField(params.pcashChainId, "pcashChainId");
  const recentPcashBlockHash = toField(params.snapshot.recentPcashBlockHash, "recentPcashBlockHash");
  const primaryAddress = toAddressField(primary.address, "primary.address");
  const feePayerAddress = toAddressField(feePayer.address, "feePayer.address");
  if (primaryAddress === feePayerAddress) {
    throw new Error("the fee payer must be a different account from the primary");
  }

  const ownerInputs = Array.from({ length: N_IN }, absentInputMap);
  build.resolvedInputs.forEach((input, slot) => {
    if (input.slotClass !== SlotClass.ASSET && input.slotClass !== SlotClass.NATIVE) return;
    const expectedOwner = input.slotClass === SlotClass.ASSET ? primaryAddress : feePayerAddress;
    const expectedAssetId = input.slotClass === SlotClass.ASSET ? assetId : 0n;
    if (input.owner !== expectedOwner || input.assetId !== expectedAssetId) {
      throw new Error(`input slot ${slot} belongs to another account or asset`);
    }
    ownerInputs[slot] = inputNoteMap(input);
  });

  const assetOutputAmounts = build.resolvedOutputs.map((output) => output.slotClass === SlotClass.ASSET ? output.amount : 0n);
  const nativeChangeSlots = build.resolvedOutputs.flatMap((output, slot) =>
    output.slotClass === SlotClass.NATIVE && output.recipient === feePayerAddress
      ? [{ ...output, slot }] : []);
  if (nativeChangeSlots.length > 1) throw new Error("sponsored transfer has multiple native change outputs");
  const change = nativeChangeSlots[0] ?? null;
  const relayPayment = params.nativeRelayPayment;
  if (relayPayment !== undefined) {
    const output = build.resolvedOutputs[relayPayment.slot];
    if (relayPayment.amount <= 0n || output?.slotClass !== SlotClass.NATIVE
      || output.amount !== relayPayment.amount
      || output.ownerCommitment !== toField(relayPayment.ownerCommitment)) {
      throw new Error("selected relay output does not match the sponsored transfer");
    }
    if (relayPayment.slot === change?.slot) throw new Error("selected relay and change cannot share a slot");
  }
  const allowedNativeSlots = new Set([...(change === null ? [] : [change.slot]),
    ...(relayPayment === undefined ? [] : [relayPayment.slot])]);
  build.resolvedOutputs.forEach((output, slot) => {
    if (output.slotClass === SlotClass.NATIVE && !allowedNativeSlots.has(slot)) {
      throw new Error("sponsored transfer has an undeclared native output");
    }
  });

  const nativeIn = build.resolvedInputs.reduce((sum, input) => sum + (input.slotClass === SlotClass.NATIVE ? input.amount : 0n), 0n);
  const openFeeAmount = toField(build.transaction.global.openFeeAmount);
  const changeAmount = change?.amount ?? 0n;
  if (nativeIn !== openFeeAmount + changeAmount + (relayPayment?.amount ?? 0n)) {
    throw new Error(
      `native inputs total ${nativeIn} but the fee is ${openFeeAmount} and change ${changeAmount}`,
    );
  }

  const replayIds = build.resolvedInputs.map((input) => input.replayId);
  const primaryVkMap = vkWitnessMap(params.primaryVk, "primary");
  const feeVkMap = vkWitnessMap(params.feeVk, "fee-payer");
  const primaryActionCommitment = sponsoredTransferActionCommitment(pcashChainId, build.privateValueCommitment);
  const feeActionCommitment = contractFeeSponsorshipActionCommitment(
    pcashChainId,
    build.privateValueCommitment,
    primaryAddress,
  );
  const primaryStatement = ruleStatement(
    authorizationCommitment(primaryAddress, primary.rule.configurationCommitment),
    primaryActionCommitment,
    recentPcashBlockHash,
    build.eventOpening.eventEntry,
  );
  const feeStatement = ruleStatement(
    authorizationCommitment(feePayerAddress, feePayer.rule.configurationCommitment),
    feeActionCommitment,
    recentPcashBlockHash,
    build.eventOpening.eventEntry,
  );

  return {
    primaryActionCommitment,
    feeActionCommitment,
    // Every input the relation declares, from the same locals the TOML above
    // uses. A map missing a field does not fail late in proving — noirc_abi
    // refuses to encode the witness at all.
    witnessMap: {
      event_salt: fm(build.eventOpening.eventSalt),
      pcash_chain_id: fm(params.pcashChainId),
      recent_pcash_block_hash: fm(params.snapshot.recentPcashBlockHash),
      choices: privateValueChoicesMap(build.transaction),
      output_owner_commitments: fieldArrayMap(build.outputOwnerCommitments),
      output_dummy_secrets: fieldArrayMap(build.outputDummySecrets),
      asset_output_amounts: fieldArrayMap(assetOutputAmounts),
      native_change: {
        slot: change?.slot ?? 0,
        secret: fm(change?.noteSecret ?? 0n),
        amount: fm(changeAmount),
      },
      native_relay_output: {
        slot: relayPayment?.slot ?? 0,
        amount: fm(relayPayment?.amount ?? 0n),
      },
      asset_id: fm(assetId),
      dummy_input_seed: fm(build.dummyInputSeed),
      replay_ids: fieldArrayMap(replayIds),
      ...snapshotWitnessMap(params.snapshot),
      primary: authorizedAccountMap(primary),
      fee_payer: authorizedAccountMap(feePayer),
      owner_inputs: ownerInputs,
      primary_statement: ruleStatementMap(primaryStatement),
      primary_vk: primaryVkMap,
      fee_statement: ruleStatementMap(feeStatement),
      fee_vk: feeVkMap,
    },
  };
}

export interface ContractFeeSponsorshipAuthorizationParams {
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  build: AssetActionBuild;
  /** Authenticated primary opening used by the sponsored-transfer kernel. */
  primary: AssetAccountAuthorization;
  wallet: WalletProfile;
  network?: NetworkConfigLike;
  /** The authenticated primary Contract Account whose action this sponsors. */
  sponsoredContract: FieldNumberish;
  nativeRelayPayment?: { slot: number; amount: bigint; ownerCommitment: FieldNumberish } | null;
}

export interface PreparedContractFeeSponsorshipAuthorization {
  authorizationCircuit: "account_rule_contract_fee_sponsorship_ecdsa" | "account_rule_large_contract_fee_sponsorship_ecdsa";
  request: PcashAuthorizationRequest;
  authorize: (authorization: VerifiedPcashAuthorization) => {
    witnessMap: Record<string, unknown>;
  };
}

/**
 * The sponsor's half of a two-account action: one signature over the named
 * contract, the fee, the validity window, and the transaction context binding
 * every ordered input nullifier. Asset recipients and amounts remain governed
 * by the primary account's rule.
 *
 * The sponsor does not sign a private-value commitment. Their nullifiers are
 * single-spend so exactly one transaction can ever land, but within that bound
 * the counterparty chooses which action of the named contract it is. That is
 * the deliberate trade for a message a wallet can actually display. The rule
 * hashes the signed contract into its action commitment and the kernel builds
 * the same commitment from its authenticated primary address, so the signature
 * is useless against any other contract.
 */
export function prepareContractFeeSponsorshipAuthorization(
  params: ContractFeeSponsorshipAuthorizationParams,
): PreparedContractFeeSponsorshipAuthorization {
  const { build } = params;
  const sponsoredContract = toField(params.sponsoredContract, "sponsoredContract");
  if (toField(params.primary.accountKind, "primary.accountKind") !== ACCOUNT_KIND_CONTRACT) {
    throw new Error("contract fee sponsorship requires a Contract Account primary");
  }
  if (toField(params.primary.address, "primary.address") !== sponsoredContract) {
    throw new Error("sponsoredContract does not match the authenticated primary account");
  }
  return prepareSponsorshipAuthorization({
    ...(params.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: params.designatedIssuanceOpening }),
    payment: {
      kind: "asset-action",
      build,
      ...(params.nativeRelayPayment === undefined ? {} : { nativeRelayPayment: params.nativeRelayPayment }),
    },
    pcashChainId: build.pcashChainId,
    recentPcashBlockHash: build.recentPcashBlockHash,
    wallet: params.wallet,
    ...(params.network !== undefined ? { network: params.network } : {}),
    sponsoredContract,
  });
}

export interface SponsorshipAuthorizationParams {
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  /** A live contract's asset action, or the native fee payment of a contract creation. */
  payment:
    | {
      kind: "asset-action";
      build: AssetActionBuild;
      nativeRelayPayment?: { slot: number; amount: bigint; ownerCommitment: FieldNumberish } | null;
    }
    | { kind: "native-fee-payment"; build: NativeFeePaymentBuild };
  pcashChainId: FieldNumberish;
  recentPcashBlockHash: FieldNumberish;
  wallet: WalletProfile;
  network?: NetworkConfigLike;
  /** The Contract Account this sponsor pays for: a live primary, or the address being created. */
  sponsoredContract: FieldNumberish;
}

/**
 * The sponsor's signature over the named contract and the fee terms. The
 * kernel that folds it decides what the contract is doing: an asset action of
 * a live contract, or that contract's own creation.
 */
export function prepareSponsorshipAuthorization(
  params: SponsorshipAuthorizationParams,
): PreparedContractFeeSponsorshipAuthorization {
  const { wallet, payment } = params;
  const shape = payment.kind === "asset-action" ? payment.build.shape : PRIVATE_VALUE_PROFILES.S.shapeId;
  const pcashChainId = toField(params.pcashChainId, "pcashChainId");
  const recentPcashBlockHash = toField(params.recentPcashBlockHash, "recentPcashBlockHash");
  const network = networkForChain(pcashChainId, params.network);
  const sponsoredContract = toField(params.sponsoredContract, "sponsoredContract");
  const transaction = payment.build.transaction;
  // A zero fee is a valid sponsorship: a contract creation the signer pays no
  // PCASH for still needs the signer's authorization of the exact action.
  const openFeeAmount = toField(transaction.global.openFeeAmount, "openFeeAmount");
  const nativeOutputs = payment.kind === "asset-action"
    ? payment.build.resolvedOutputs.flatMap((output, slot) => output.slotClass === SlotClass.NATIVE
      ? [{ slot, amount: output.amount, ownerCommitment: output.ownerCommitment,
        ownerChange: output.recipient === toField(wallet.address, "wallet.address") }] : [])
    : [
        ...(payment.build.change === null ? [] : [{ ...payment.build.change, ownerChange: true }]),
        ...(payment.build.relayPayment === null ? [] : [{ ...payment.build.relayPayment, ownerChange: false }]),
      ];
  const changes = nativeOutputs.filter((output) => output.ownerChange);
  if (changes.length > 1) throw new Error("sponsorship has multiple native change outputs");
  const change = changes[0] ?? null;
  const relayPayment = payment.kind === "asset-action" ? payment.nativeRelayPayment : payment.build.relayPayment;
  if (relayPayment !== undefined && relayPayment !== null) {
    if (relayPayment.amount <= 0n) throw new Error("private relay payment must be positive");
    const output = nativeOutputs.find((item) => item.slot === relayPayment.slot);
    if (output === undefined || output.ownerChange || output.amount !== relayPayment.amount
      || output.ownerCommitment !== toField(relayPayment.ownerCommitment)) {
      throw new Error("private relay payment opening does not match the transaction");
    }
  }
  if (change !== null && relayPayment !== undefined && relayPayment !== null
    && change.slot === relayPayment.slot) throw new Error("change and relay payment must use different slots");
  const nativeChangeAmount = change?.amount ?? 0n;
  if (change !== null && nativeChangeAmount <= 0n) throw new Error("sponsorship change amount must be positive");
  const { issuanceRecipient, issuanceNoteSecret, transactionContext } = authorizationIssuanceOpening(transaction.global.issuanceOwnerCommitment, pcashChainId, transaction.inputs.map((input) => input.nullifier), params.designatedIssuanceOpening, shape);
  const message = {
    pcashChainId,
    sponsoredContract,
    openFeeAmount,
    issuanceRecipient,
    issuanceOwnerCommitment: toField(transaction.global.issuanceOwnerCommitment, "issuanceOwnerCommitment"),
    relayFeeAmount: relayPayment?.amount ?? 0n,
    relayFeeOwnerCommitment: relayPayment?.ownerCommitment ?? 0n,
    transactionContext,
    notBefore: toField(transaction.global.notBeforeTimestamp, "notBeforeTimestamp"),
    validUntil: toField(transaction.global.validUntilTimestamp, "validUntilTimestamp"),
  };
  const request = createPcashAuthorizationRequest({
    kind: "contract-fee-sponsorship",
    authorizingAddress: wallet.address,
    typedData: contractFeeSponsorshipTypedData(network, message),
  });
  return {
    authorizationCircuit: shape === PRIVATE_VALUE_PROFILES.L.shapeId ? "account_rule_large_contract_fee_sponsorship_ecdsa" : "account_rule_contract_fee_sponsorship_ecdsa",
    request,
    authorize(authorization) {
      return buildContractFeeSponsorshipRuleWitness({
        network,
        wallet,
        authorization: requirePcashAuthorization(request, authorization),
        recentPcashBlockHash,
        eventEntry: payment.build.eventOpening.eventEntry,
        nkRoot: wallet.nkRoot,
        message,
        nativeChangeAmount,
        transaction,
        issuanceNoteSecret,
      });
    },
  };
}
