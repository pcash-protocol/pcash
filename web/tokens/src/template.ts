// Transaction assembly shared by the token templates.
//
// Every template function spends notes owned by a published-root Contract
// Account in one of two roles. Transfer: the contract owns every real input and
// contributes no native value, so the action pays no open fee. Sponsored: a
// distinct USER account contributes native PCASH for the open fee through the
// two-account sponsored-transfer kernel and takes its change back.
//
// A builder here returns everything proving needs and nothing about how to
// prove or publish: the caller injects its prover and submission.

import { ACCOUNT_KIND_CONTRACT, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { toField, type FieldNumberish } from "@pcash/sdk/crypto";
import {
  buildContractFunctionSet,
  issuancePayoutOpening,
  noteNk,
  ownerChangeNoteSecret,
  type ArenaSender,
  type AssetDefinition,
  type ContractFunction,
  type DesignatedIssuanceOpening,
  type FunctionSelector,
  type NetworkConfigLike,
  type WalletProfile,
} from "@pcash/sdk/protocol";
import {
  buildAssetAction,
  assetActionInputNullifiers,
  buildSponsoredTransferWitness,
  openedAssetActionOutput,
  prepareContractFeeSponsorshipAuthorization,
  type AssetAccountAuthorization,
  type AssetActionBuild,
  type AssetActionInput,
  type AssetActionOutput,
  type AssetSnapshot,
  type ChonkVkArtifacts,
  type PreparedContractFeeSponsorshipAuthorization,
  type WitnessMap,
} from "@pcash/sdk/builders";
import { CIRCUIT_URLS, type AssetActionProofRequest } from "@pcash/sdk/browser-prover/requests";
import { randomFieldEntropy } from "@pcash/sdk/utils";
import type { SponsoredContractAssetActionPrimary } from "@pcash/sdk/wallet/actions";

/** The published contract material a template action spends under. */
export interface TemplateContract {
  address: bigint;
  nkRoot: bigint;
  functionSetCommitment: bigint;
  functions: readonly ContractFunction[];
}

/** The contract's account leaf in the snapshot's account tree. */
export interface TemplateContractOpening {
  accountIndex: number;
  accountSiblings: readonly FieldNumberish[];
}

/** One note's leaf and its depth-40 opening in the snapshot's output tree. */
export interface TemplateNoteOpening {
  leafIndex: number;
  siblings: readonly FieldNumberish[];
}

export interface TemplateNote extends TemplateNoteOpening {
  noteSecret: bigint;
  amount: bigint;
}

/** A recipient that decrypts its own delivery. */
export interface TemplateRecipient {
  address: FieldNumberish;
  receiveKey: Uint8Array;
  /** The wallet that builds the action: its sender region does not record the payout as paid. */
  self?: true;
}

/**
 * Transfer role. `issuance` selects who receives the action's issuance:
 * the poster (open route) or the publishing account itself (self-publication).
 */
export interface TransferRole {
  kind: "transfer";
  issuance?: { kind: "open" } | { kind: "self"; recipient: { address: FieldNumberish; nkRoot: FieldNumberish } };
}

/** Sponsored role: a USER account pays the open fee from its own native notes. */
export interface SponsoredRole {
  kind: "sponsored";
  /** The payer's authenticated account opening under its contract-fee-sponsorship rule. */
  feePayer: AssetAccountAuthorization;
  feePayerWallet: WalletProfile;
  /** The payer's registered, owned receive key when fee change is produced. */
  feeChangeReceiveKey?: Uint8Array;
  /** The network the payer's rule is configured for, as the node reports it. */
  network: NetworkConfigLike;
  nativeInputs: readonly TemplateNote[];
  openFeeAmount: bigint;
}

export type TemplateRole = TransferRole | SponsoredRole;

/** The template function's application step, for native or browser proving. */
export interface TemplateApplication {
  /** Release artifact ID resolved by native provers. */
  packageName: string;
  /** Pinned artifact URL resolved by the browser prover. */
  circuitUrl: string;
  label: string;
  witnessMap: WitnessMap;
}

interface TemplateActionBase {
  build: AssetActionBuild;
  application: TemplateApplication;
  /** The self-published route's designated issuance; absent on the open route. */
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
}

export interface TransferTemplateAction extends TemplateActionBase {
  role: "transfer";
}

export interface SponsoredTemplateAction extends TemplateActionBase {
  role: "sponsored";
  /** The fee payer's native change, if any. */
  change: { slot: number; noteSecret: bigint; amount: bigint } | null;
  /** The fee payer signs `sponsorship.request`; `authorize` yields its application witness. */
  sponsorship: PreparedContractFeeSponsorshipAuthorization;
  buildKernelWitnessMap(primaryVk: ChonkVkArtifacts, feePayerVk: ChonkVkArtifacts): WitnessMap;
}

export type TemplateAction = TransferTemplateAction | SponsoredTemplateAction;

/** Kernel-facing opening of one template function under a Contract Account. */
export function templateContractAccount(
  contract: TemplateContract,
  selector: FunctionSelector,
  opening: TemplateContractOpening,
): AssetAccountAuthorization {
  const membership = buildContractFunctionSet(contract.functions).membership(selector);
  const entry = contract.functions.find((candidate) => candidate.selector === selector)!;
  return {
    address: contract.address,
    nkRoot: contract.nkRoot,
    accountIndex: opening.accountIndex,
    accountSiblings: opening.accountSiblings,
    accountRuleSetCommitment: contract.functionSetCommitment,
    accountKind: ACCOUNT_KIND_CONTRACT,
    accountRevision: 1n,
    receiveKeyHash: 0n,
    rule: {
      configurationCommitment: entry.configurationCommitment,
      commitmentBlinder: 0n,
      entryIndex: selector,
      siblings: membership.siblings,
    },
  };
}

/** One ASSET output as the template circuit and the sponsored-transfer kernel open it. */
export interface TemplateAssetOutput {
  output: AssetActionOutput;
  noteSecret: bigint;
}

/** One template ASSET output and its canonical encrypted delivery to the recipient. */
export function templateAssetOutput(params: {
  pcashChainId: bigint;
  assetId: bigint;
  slot: number;
  amount: bigint;
  recipient: TemplateRecipient;
  /** Omitted: a fresh random secret. */
  noteSecret?: bigint;
  assetDefinition: AssetDefinition;
}): TemplateAssetOutput {
  const noteSecret = params.noteSecret ?? randomFieldEntropy();
  return {
    output: openedAssetActionOutput({
      kind: "asset",
      pcashChainId: params.pcashChainId,
      assetId: params.assetId,
      outputIndex: params.slot,
      noteSecret,
      amount: params.amount,
      recipientAddress: params.recipient.address,
      recipientMlKemPublicKey: params.recipient.receiveKey,
      authenticatedRecipient: true,
      assetDefinition: params.assetDefinition,
      ...(params.recipient.self === true ? { change: true as const } : {}),
    }),
    noteSecret,
  };
}

export interface TemplateActionSpec {
  pcashChainId: FieldNumberish;
  snapshot: AssetSnapshot;
  contract: AssetAccountAuthorization;
  assetId: bigint;
  /** Contract-owned ASSET notes, in input-slot order from slot 0. */
  assetInputs: readonly TemplateNote[];
  /** The function's one-shot marker, placed after the asset inputs. */
  marker?: { replayId: bigint; selectedEntryCommitment: bigint };
  /** ASSET outputs from slot 0, given the action's final ordered nullifiers. */
  assetOutputs: (nullifiers: readonly bigint[]) => readonly TemplateAssetOutput[];
  role: TemplateRole;
  notBeforeTimestamp?: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
  /** Defaults to fresh entropy. */
  dummyInputSeed?: FieldNumberish;
  /**
   * The building wallet's sender region; none for a profile without an
   * outgoing key. A wallet-sponsored action writes its own.
   */
  sender?: ArenaSender;
  application: (build: AssetActionBuild, feePaid: boolean) => TemplateApplication;
}

/** Contract side of a fee-sponsored template action; the wallet fills fee inputs and outputs. */
export function sponsoredTemplatePrimary(
  spec: TemplateActionSpec,
  circuit: { circuitUrl: string; label: string },
  ownedSlots: readonly number[],
): SponsoredContractAssetActionPrimary {
  const inputs: SponsoredContractAssetActionPrimary["inputs"] = [
    ...spec.assetInputs.map((note, slot) => ({ slot, input: { kind: "asset" as const, ...note } })),
    ...(spec.marker === undefined ? [] : [{
      slot: spec.assetInputs.length,
      input: { kind: "application" as const, ...spec.marker },
    }]),
  ];
  return {
    authorization: spec.contract,
    assetId: spec.assetId,
    inputs,
    realizeOutputs: (nullifiers) => {
      const entries = spec.assetOutputs(nullifiers);
      return {
        outputs: entries.map((entry, slot) => ({ slot, output: entry.output })),
        ownedOutputs: entries.flatMap((entry, slot) => ownedSlots.includes(slot) ? [{ slot, noteSecret: entry.noteSecret }] : []),
      };
    },
    ...circuit,
    witness: (build) => spec.application(build, true).witnessMap,
  };
}

const SHAPE = PRIVATE_VALUE_PROFILES.S;

function dummyOutput(): AssetActionOutput {
  return { kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n };
}

/** Assemble one S-profile template action in the selected role. */
export function buildTemplateAction(spec: TemplateActionSpec): TemplateAction {
  const sponsored = spec.role.kind === "sponsored" ? spec.role : null;
  const pcashChainId = toField(spec.pcashChainId, "pcashChainId");
  const dummyInputSeed = toField(spec.dummyInputSeed ?? randomFieldEntropy(), "dummyInputSeed");
  const payerOwner = sponsored === null ? 0n : sponsored.feePayerWallet.address;
  const payerNk = sponsored === null ? 0n : noteNk(sponsored.feePayerWallet.nkRoot);
  const nativeInputs = sponsored?.nativeInputs ?? [];

  // Nullifiers are fixed before any output: an output may open under a secret
  // derived from them, exactly as the kernel's dummy and note derivations fix them.
  const inputs: AssetActionInput[] = [];
  for (const note of spec.assetInputs) {
    inputs.push({ kind: "asset", ...note });
  }
  if (spec.marker !== undefined) {
    inputs.push({ kind: "application", ...spec.marker });
  }
  for (const note of nativeInputs) {
    inputs.push({ kind: "native", ...note, owner: payerOwner, nk: payerNk });
  }
  while (inputs.length < SHAPE.inputs) inputs.push({ kind: "dummy" });
  const nullifiers = assetActionInputNullifiers({
    owner: spec.contract, assetId: spec.assetId, inputs, dummyInputSeed, nativeFeePayer: sponsored !== null,
  });

  const assetOutputs = spec.assetOutputs(nullifiers);
  const outputs: AssetActionOutput[] = assetOutputs.map((entry) => entry.output);
  let change: { slot: number; noteSecret: bigint; amount: bigint } | null = null;
  if (sponsored !== null) {
    const changeAmount = nativeInputs.reduce((sum, note) => sum + note.amount, 0n) - sponsored.openFeeAmount;
    if (changeAmount > 0n) {
      if (sponsored.feeChangeReceiveKey === undefined) throw new Error("fee change requires the payer's registered receive key");
      // The sponsorship rule accepts change only under the sponsor's derived secret.
      const slot = outputs.length;
      change = { slot, noteSecret: ownerChangeNoteSecret(sponsored.feePayerWallet.nkRoot, nullifiers, slot, SHAPE.shapeId), amount: changeAmount };
      outputs.push(openedAssetActionOutput({
        kind: "native",
        pcashChainId,
        assetId: 0n,
        outputIndex: change.slot,
        noteSecret: change.noteSecret,
        amount: changeAmount,
        recipientAddress: sponsored.feePayerWallet.address,
        recipientMlKemPublicKey: sponsored.feeChangeReceiveKey,
        authenticatedRecipient: true,
        change: true,
      }));
    }
  }
  while (outputs.length < SHAPE.outputs) outputs.push(dummyOutput());

  let issuanceOwnerCommitment = 0n;
  let designatedIssuanceOpening: DesignatedIssuanceOpening | undefined;
  if (spec.role.kind === "transfer" && spec.role.issuance?.kind === "self") {
    const recipient = spec.role.issuance.recipient;
    const opening = issuancePayoutOpening(recipient.address, recipient.nkRoot, pcashChainId, nullifiers);
    issuanceOwnerCommitment = opening.ownerCommitment;
    designatedIssuanceOpening = {
      recipientAddress: recipient.address,
      noteSecret: opening.noteSecret,
      transactionContext: opening.context,
    };
  }

  const build = buildAssetAction({
    pcashChainId,
    snapshot: spec.snapshot,
    owner: spec.contract,
    assetId: spec.assetId,
    nativeFeePayer: sponsored !== null,
    inputs,
    outputs,
    openFeeAmount: sponsored?.openFeeAmount ?? 0n,
    issuanceOwnerCommitment,
    ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }),
    ...(spec.notBeforeTimestamp === undefined ? {} : { notBeforeTimestamp: spec.notBeforeTimestamp }),
    validUntilTimestamp: spec.validUntilTimestamp,
    dummyInputSeed,
    ...(spec.sender === undefined ? {} : { sender: spec.sender }),
  });
  const application = spec.application(build, sponsored !== null);
  const issuance = designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening };
  if (sponsored === null) return { role: "transfer", build, application, ...issuance };

  const sponsorship = prepareContractFeeSponsorshipAuthorization({
    build,
    primary: spec.contract,
    wallet: sponsored.feePayerWallet,
    network: sponsored.network,
    sponsoredContract: spec.contract.address,
  });
  return {
    role: "sponsored",
    build,
    application,
    ...issuance,
    change,
    sponsorship,
    buildKernelWitnessMap: (primaryVk, feePayerVk) => buildSponsoredTransferWitness({
      build,
      snapshot: spec.snapshot,
      pcashChainId,
      assetId: spec.assetId,
      primary: spec.contract,
      feePayer: sponsored.feePayer,
      primaryVk,
      feeVk: feePayerVk,
    }).witnessMap,
  };
}

/**
 * Browser proving request for a template action. A sponsored action also
 * needs the fee payer's signed sponsorship witness.
 */
export function templateProofRequest(action: TransferTemplateAction): AssetActionProofRequest;
export function templateProofRequest(action: SponsoredTemplateAction, sponsorWitnessMap: WitnessMap): AssetActionProofRequest;
export function templateProofRequest(action: TemplateAction, sponsorWitnessMap?: WitnessMap): AssetActionProofRequest {
  const application = {
    circuitUrl: action.application.circuitUrl,
    witnessMap: action.application.witnessMap,
    label: action.application.label,
  };
  if (action.role === "transfer") {
    return {
      operation: "transfer",
      authorization: application,
      buildKernelWitnessMap: action.build.buildKernelWitnessMap,
      expectedPublicInputs: action.build.publicInputs,
    };
  }
  if (sponsorWitnessMap === undefined) throw new Error("a sponsored action requires the fee payer's signed witness");
  return {
    operation: "sponsored-transfer",
    primary: application,
    feePayer: {
      circuitUrl: CIRCUIT_URLS.account_rule_contract_fee_sponsorship_ecdsa,
      witnessMap: sponsorWitnessMap,
      label: "contract fee sponsorship rule",
    },
    buildKernelWitnessMap: action.buildKernelWitnessMap,
    expectedPublicInputs: action.build.publicInputs,
  };
}
