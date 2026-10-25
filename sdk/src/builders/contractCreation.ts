import type { EventOptions } from "../protocol/events.ts";
import type { DesignatedIssuanceOpening } from "../protocol/payout.ts";
// Witness assembly for `circuits/protocol/contract_creation/kernel`.
//
// A contract has nothing to spend before it exists, so a User Account sponsor
// pays the creation fee from its own native notes and takes at most one change
// note back. The sponsor's installed contract-fee-sponsorship rule authorizes
// the payment bound to the address being created, so the same readable
// sponsorship message that pays for a contract's asset actions pays for its
// creation.

import { type FieldNumberish, toField } from "../crypto/field.ts";
import { ACCOUNT_KIND_USER } from "../constants/params.ts";
import type { ChonkVkArtifacts } from "../protocol/account.ts";
import {
  authorizationCommitment,
  contractFeeSponsorshipActionCommitment,
  ruleStatement,
} from "../protocol/statement.ts";
import { encodeContractAccountCreation, TX_KIND_CONTRACT_ACCOUNT_CREATION } from "../protocol/codec.ts";
import type { ArenaSender } from "../protocol/sectionDelivery.ts";
import { buildContractBody, type BuildContractParams, type ContractBuild } from "../protocol/contract.ts";
import { fm, ruleStatementMap, type WitnessMap } from "../protocol/witness.ts";
import { resolveNetworkConfig, type NetworkConfigLike } from "../protocol/network.ts";
import type { WalletProfile } from "../protocol/types.ts";
import type { PcashAuthorizationRequest, VerifiedPcashAuthorization } from "../eip712/authorization.ts";
import type { AssetAccountAuthorization } from "./assetOutputs.ts";
import { prepareSponsorshipAuthorization } from "./sponsoredTransfer.ts";
import {
  authorizedAccountMap,
  snapshotWitnessMap,
  vkWitnessMap,
  type SnapshotWitness,
} from "./witnessMaps.ts";
import {
  buildNativeFeePayment,
  type FeePaymentNoteInput,
  type NativeFeePaymentBuild,
} from "./feePayment.ts";
import type { PrivateValueOutputDataOverrides } from "../protocol/codec.ts";
import { U160_LIMIT } from "../utils/validate.ts";

export interface BuildUnfundedContractCreationParams {
  pcashChainId: FieldNumberish;
  contract: BuildContractParams;
  recentPcashBlockHash: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
}

export interface UnfundedContractCreationBuild extends ContractBuild {
  transactionBytes: Uint8Array;
}

/** Build the canonical contract body and its unfunded creation transaction. */
export function buildUnfundedContractCreation(
  params: BuildUnfundedContractCreationParams,
): UnfundedContractCreationBuild {
  const contract = buildContractBody(params.contract);
  return {
    ...contract,
    transactionBytes: encodeContractAccountCreation(params.pcashChainId, contract.body, {
      mode: "unfunded",
      recentPcashBlockHash: params.recentPcashBlockHash,
      validUntilTimestamp: params.validUntilTimestamp,
    }),
  };
}

export interface SponsoredContractCreationFee {
  openFeeAmount: FieldNumberish;
  privateRelayPayment?: { recipientAddress: FieldNumberish; receiveKey: Uint8Array; amount: FieldNumberish };
  issuanceOwnerCommitment?: FieldNumberish;
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  notBeforeTimestamp?: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
  /** The carrier context the delivering carrier must have; 0 = any delivery. Default 0. */
  carrierContextHash?: FieldNumberish;
  /** The sponsor's native notes funding the fee. */
  inputs: readonly FeePaymentNoteInput[];
  dummyInputEntropy?: FieldNumberish;
  dummyOutputEntropy?: readonly FieldNumberish[];
  outputData?: PrivateValueOutputDataOverrides;
  /** A prior build's arena, reused with its output data to rebuild the same fee section. */
  arena?: Uint8Array;
}

export interface PrepareSponsoredContractCreationParams extends EventOptions {
  network: NetworkConfigLike;
  /** The unsigned body and the address the node derives from it. */
  contract: { body: Uint8Array; address: FieldNumberish };
  /** The sponsor's authenticated account row and installed sponsorship rule. */
  sponsor: AssetAccountAuthorization;
  sponsorWallet: WalletProfile;
  /** Resolved receive key for the sponsor's automatically encrypted fee change. */
  sponsorReceiveKey?: Uint8Array;
  snapshot: SnapshotWitness & { recentPcashBlockHash: FieldNumberish };
  fee: SponsoredContractCreationFee;
  /** The sponsor's sender region in the fee section. */
  sender?: ArenaSender;
  authorization?: VerifiedPcashAuthorization;
}

export interface SponsoredContractCreationBuild {
  /** The private-value words, then the contract address. */
  publicInputs: readonly bigint[];
  contractAddress: bigint;
  payment: NativeFeePaymentBuild;
  /** The sponsorship action the installed rule authorizes. */
  feeActionCommitment: bigint;
  authorizationRequest: PcashAuthorizationRequest;
  authorizeReadableEcdsa(authorization: VerifiedPcashAuthorization): { witnessMap: WitnessMap };
  readableEcdsaWitnessMap?: WitnessMap;
  buildKernelWitnessMap(feeVk: ChonkVkArtifacts): WitnessMap;
  encodeTransaction(proof: Uint8Array): Uint8Array;
}

export function prepareSponsoredContractCreation(
  params: PrepareSponsoredContractCreationParams,
): SponsoredContractCreationBuild {
  const network = resolveNetworkConfig(params.network);
  const contractAddress = toField(params.contract.address, "contract.address");
  if (contractAddress === 0n || contractAddress >= U160_LIMIT) {
    throw new Error("contract.address must be a nonzero 160-bit address");
  }
  if (toField(params.sponsor.accountKind, "sponsor.accountKind") !== ACCOUNT_KIND_USER) {
    throw new Error("a contract creation sponsor must be a User Account");
  }
  const sponsorAddress = toField(params.sponsor.address, "sponsor.address");
  if (sponsorAddress !== toField(params.sponsorWallet.address, "sponsorWallet.address")) {
    throw new Error("sponsorWallet does not match the authenticated sponsor account");
  }
  if (toField(params.sponsor.nkRoot, "sponsor.nkRoot") !== toField(params.sponsorWallet.nkRoot)) {
    throw new Error("sponsorWallet nkRoot does not match the authenticated sponsor account");
  }
  const recentPcashBlockHash = toField(params.snapshot.recentPcashBlockHash, "recentPcashBlockHash");
  const fee = params.fee;
  const payment = buildNativeFeePayment({
    transactionType: TX_KIND_CONTRACT_ACCOUNT_CREATION,
    ...(params.sender === undefined ? {} : { sender: params.sender }),
    ...(params.preparedEvent === undefined ? {} : { preparedEvent: params.preparedEvent }),
    ...(params.eventSalt === undefined ? {} : { eventSalt: params.eventSalt }),
    pcashChainId: network.pcashChainId,
    recentPcashBlockHash,
    payer: {
      address: sponsorAddress,
      nkRoot: params.sponsor.nkRoot,
      ...(params.sponsorReceiveKey !== undefined
        ? { receiveKey: params.sponsorReceiveKey }
        : {}),
    },
    inputs: fee.inputs,
    openFeeAmount: fee.openFeeAmount,
    ...(fee.privateRelayPayment === undefined ? {} : { privateRelayPayment: fee.privateRelayPayment }),
    issuanceOwnerCommitment: fee.issuanceOwnerCommitment ?? 0n,
    ...(fee.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: fee.designatedIssuanceOpening }),
    notBeforeTimestamp: fee.notBeforeTimestamp ?? 0n,
    validUntilTimestamp: fee.validUntilTimestamp,
    ...(fee.carrierContextHash !== undefined ? { carrierContextHash: fee.carrierContextHash } : {}),
    ...(fee.dummyInputEntropy !== undefined ? { dummyInputEntropy: fee.dummyInputEntropy } : {}),
    ...(fee.dummyOutputEntropy !== undefined ? { dummyOutputEntropy: fee.dummyOutputEntropy } : {}),
    ...(fee.outputData !== undefined ? { outputData: fee.outputData } : {}),
    ...(fee.arena !== undefined ? { arena: fee.arena } : {}),
  });
  if (payment.change !== null && fee.outputData?.[payment.change.slot] === undefined && params.sponsorReceiveKey === undefined) {
    throw new Error("sponsor change requires the sponsor's resolved receive key");
  }
  const feeActionCommitment = contractFeeSponsorshipActionCommitment(
    network.pcashChainId,
    payment.privateValueCommitment,
    contractAddress,
  );
  const sponsorship = prepareSponsorshipAuthorization({
    ...(fee.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: fee.designatedIssuanceOpening }),
    payment: { kind: "native-fee-payment", build: payment },
    pcashChainId: network.pcashChainId,
    recentPcashBlockHash,
    wallet: params.sponsorWallet,
    network,
    sponsoredContract: contractAddress,
  });
  const feeStatement = ruleStatement(
    authorizationCommitment(sponsorAddress, params.sponsor.rule.configurationCommitment),
    feeActionCommitment,
    recentPcashBlockHash,
    payment.eventOpening.eventEntry,
  );
  const publicInputs = [...payment.publicInputs, contractAddress];
  const readable = params.authorization === undefined
    ? undefined
    : sponsorship.authorize(params.authorization);
  return {
    publicInputs,
    contractAddress,
    payment,
    feeActionCommitment,
    authorizationRequest: sponsorship.request,
    authorizeReadableEcdsa: (authorization) => sponsorship.authorize(authorization),
    ...(readable === undefined ? {} : { readableEcdsaWitnessMap: readable.witnessMap }),
    buildKernelWitnessMap: (feeVk) => {
      const feeVkMap = vkWitnessMap(feeVk, "contract-creation sponsor");
      return {
        pcash_chain_id: fm(network.pcashChainId),
        recent_pcash_block_hash: fm(recentPcashBlockHash),
        contract_address: fm(contractAddress),
        ...snapshotWitnessMap(params.snapshot),
        fee_payer: authorizedAccountMap(params.sponsor),
        ...payment.kernelWitnessMap(),
        fee_statement: ruleStatementMap(feeStatement),
        fee_vk: feeVkMap,
      };
    },
    encodeTransaction: (proof) => encodeContractAccountCreation(network.pcashChainId, params.contract.body, {
      mode: "sponsored",
      section: { publicInputs: payment.publicInputs, proof, outputData: payment.outputData, arena: payment.arena },
    }),
  };
}
