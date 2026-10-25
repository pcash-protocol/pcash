// Eligibility drops. A published-root Contract Account holds exact-amount
// inventory notes under public secrets. Every USER account that existed at the
// cutoff block claims one note's value once, into a note that opens under its
// own implicit owner-change secret; after the claim window the creator
// reclaims what is left.

import { poseidon, toAddressField, toField, type FieldNumberish } from "@pcash/sdk/crypto";
import {
  applicationNullifier,
  assertAssetAmount,
  buildContractBody,
  contractFunctionCommitment,
  fullOutputCommitment,
  noteNk,
  nullifier,
  nullifierKeyCommitment,
  ownerChangeNoteSecret,
  type ArenaSender,
  type AssetDefinition,
  type ContractFunction,
} from "@pcash/sdk/protocol";
import { referenceConfigurationCommitment } from "@pcash/sdk/rules";
import { fieldArrayMap, fm, privateValueMap, type AssetActionBuild, type AssetSnapshot } from "@pcash/sdk/builders";
import {
  DROP_CLAIM_FUNCTION_SELECTOR,
  DROP_RECLAIM_FUNCTION_SELECTOR,
  TOKENS_DROP_CLAIM_REPLAY_DOMAIN,
  TOKENS_DROP_CONTRACT_DOMAIN,
  TOKENS_DROP_INVENTORY_DOMAIN,
} from "./constants.ts";
import {
  DROP_CLAIM_APPLICATION_VK_HASH,
  DROP_RECLAIM_APPLICATION_VK_HASH,
} from "./applicationPins.ts";
import { TOKENS_CIRCUIT_PACKAGES, TOKENS_CIRCUITS } from "./circuits.ts";
import {
  buildTemplateAction,
  templateAssetOutput,
  templateContractAccount,
  type TemplateAction,
  type TemplateContract,
  type TemplateContractOpening,
  type TemplateNoteOpening,
  type TemplateRole,
  type TemplateActionSpec,
} from "./template.ts";

export interface DropConfiguration {
  configurationSalt: bigint;
  assetId: bigint;
  claimAmount: bigint;
  cutoffBlockNumber: bigint;
  claimEndTimestamp: bigint;
  creator: bigint;
  creatorNullifierKeyCommitment: bigint;
}

/** One commitment configures both functions; their entries differ by application VK. */
export function dropConfigurationCommitment(configuration: DropConfiguration): bigint {
  return referenceConfigurationCommitment(configuration.configurationSalt, [
    configuration.assetId,
    configuration.claimAmount,
    configuration.cutoffBlockNumber,
    configuration.claimEndTimestamp,
    configuration.creator,
    configuration.creatorNullifierKeyCommitment,
  ]);
}

/** The public terms a drop seed and a creator fix. */
export interface DropTerms {
  dropSeed: FieldNumberish;
  assetId: FieldNumberish;
  claimAmount: bigint;
  cutoffBlockNumber: bigint;
  claimEndTimestamp: bigint;
  creator: FieldNumberish;
  creatorNullifierKeyCommitment: FieldNumberish;
}

/** An eligibility-drop contract and every value derived from its public terms. */
export interface EligibilityDrop extends TemplateContract {
  dropSeed: bigint;
  configuration: DropConfiguration;
  configurationCommitment: bigint;
  /** Unsigned contract-account body for sponsored creation. */
  body: Uint8Array;
  accountStateCommitment: bigint;
  /** The claim function's entry, which scopes every claim marker. */
  claimEntryCommitment: bigint;
}

function nonzero(value: FieldNumberish, label: string): bigint {
  const field = toField(value, label);
  if (field === 0n) throw new Error(`${label} must be nonzero`);
  return field;
}

/**
 * Derive the drop contract from its terms. The terms arrive from the creator's
 * form or from an untrusted publication, so they are bounded here.
 */
export function eligibilityDrop(terms: DropTerms): EligibilityDrop {
  const dropSeed = toField(terms.dropSeed, "dropSeed");
  assertAssetAmount(terms.claimAmount, "claim amount");
  if (terms.cutoffBlockNumber < 0n || terms.cutoffBlockNumber >= 1n << 40n) throw new Error("cutoff block number must fit 40 bits");
  if (terms.claimEndTimestamp <= 0n || terms.claimEndTimestamp >= 1n << 64n) throw new Error("claim end must be a nonzero 64-bit timestamp");
  const configuration: DropConfiguration = {
    configurationSalt: poseidon([TOKENS_DROP_CONTRACT_DOMAIN, dropSeed, 0n]),
    assetId: nonzero(terms.assetId, "assetId"),
    claimAmount: terms.claimAmount,
    cutoffBlockNumber: terms.cutoffBlockNumber,
    claimEndTimestamp: terms.claimEndTimestamp,
    creator: toAddressField(terms.creator, "creator"),
    creatorNullifierKeyCommitment: toField(terms.creatorNullifierKeyCommitment, "creatorNullifierKeyCommitment"),
  };
  const nkRoot = poseidon([TOKENS_DROP_CONTRACT_DOMAIN, dropSeed, 1n]);
  const configurationCommitment = dropConfigurationCommitment(configuration);
  const functions: ContractFunction[] = [
    {
      selector: DROP_CLAIM_FUNCTION_SELECTOR,
      applicationVkHash: DROP_CLAIM_APPLICATION_VK_HASH,
      configurationCommitment,
    },
    {
      selector: DROP_RECLAIM_FUNCTION_SELECTOR,
      applicationVkHash: DROP_RECLAIM_APPLICATION_VK_HASH,
      configurationCommitment,
    },
  ];
  const built = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot }, functions });
  return {
    dropSeed,
    configuration,
    configurationCommitment,
    nkRoot,
    functions,
    body: built.body,
    address: built.address,
    functionSetCommitment: built.functionSetCommitment,
    accountStateCommitment: built.accountStateCommitment,
    claimEntryCommitment: contractFunctionCommitment(functions[0]!),
  };
}

/** Terms for a creator account's drop. */
export function dropTermsForCreator(params: {
  dropSeed: FieldNumberish;
  assetId: FieldNumberish;
  claimAmount: bigint;
  cutoffBlockNumber: bigint;
  claimEndTimestamp: bigint;
  creator: { address: FieldNumberish; nkRoot: FieldNumberish };
}): DropTerms {
  return {
    dropSeed: params.dropSeed,
    assetId: params.assetId,
    claimAmount: params.claimAmount,
    cutoffBlockNumber: params.cutoffBlockNumber,
    claimEndTimestamp: params.claimEndTimestamp,
    creator: params.creator.address,
    creatorNullifierKeyCommitment: nullifierKeyCommitment(params.creator.nkRoot),
  };
}

/** Inventory note `index` opens under this public secret. */
export function dropInventorySecret(drop: EligibilityDrop, index: number): bigint {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("inventory index must be a nonnegative integer");
  return poseidon([TOKENS_DROP_INVENTORY_DOMAIN, drop.dropSeed, BigInt(index)]);
}

export interface DropInventoryNote {
  index: number;
  leafIndex: number;
  noteSecret: bigint;
  outputCommitment: bigint;
  nullifier: bigint;
}

export function dropInventoryNote(drop: EligibilityDrop, index: number, leafIndex: number): DropInventoryNote {
  const noteSecret = dropInventorySecret(drop, index);
  const outputCommitment = fullOutputCommitment({
    owner: drop.address,
    noteSecret,
    assetId: drop.configuration.assetId,
    amount: drop.configuration.claimAmount,
  }, leafIndex);
  return { index, leafIndex, noteSecret, outputCommitment, nullifier: nullifier(outputCommitment, noteNk(drop.nkRoot), noteSecret) };
}

/** Funding for inventory notes: send `claimAmount` to the contract under each indexed secret. */
export function planDropInventory(drop: EligibilityDrop, countOrIndexes: number | readonly number[]): { index: number; noteSecret: bigint; amount: bigint }[] {
  const indexes = typeof countOrIndexes === "number"
    ? Array.from({ length: countOrIndexes }, (_, index) => index)
    : [...countOrIndexes];
  if (indexes.some(index => !Number.isSafeInteger(index) || index < 0) || new Set(indexes).size !== indexes.length) {
    throw new Error("inventory indexes must be distinct nonnegative integers");
  }
  return indexes.map(index => ({
    index,
    noteSecret: dropInventorySecret(drop, index),
    amount: drop.configuration.claimAmount,
  }));
}

export function dropClaimReplayId(address: FieldNumberish, nkRoot: FieldNumberish): bigint {
  return poseidon([TOKENS_DROP_CLAIM_REPLAY_DOMAIN, toAddressField(address), toField(nkRoot, "nkRoot")]);
}

/** The claim marker a claimant account spends; spent means that account already claimed. */
export function dropClaimMarker(drop: EligibilityDrop, claimant: { address: FieldNumberish; nkRoot: FieldNumberish }): bigint {
  return applicationNullifier(
    drop.address,
    drop.claimEntryCommitment,
    dropClaimReplayId(claimant.address, claimant.nkRoot),
  );
}

/** The claimant's current USER account leaf in the snapshot's account tree. */
export interface DropClaimantAccount {
  accountIndex: number;
  accountSiblings: readonly FieldNumberish[];
  accountRuleSetCommitment: FieldNumberish;
  accountRevision: FieldNumberish;
  receiveKeyHash: FieldNumberish;
}

/**
 * Openings from the snapshot's recent header to the account count after the
 * cutoff block: the recent history root, the cutoff block in history, and its
 * state's account count.
 */
export interface DropEligibilityOpening {
  historyRoot: FieldNumberish;
  historyRootHeaderSiblings: readonly FieldNumberish[];
  cutoffBlockHash: FieldNumberish;
  historySiblings: readonly FieldNumberish[];
  cutoffStateRoot: FieldNumberish;
  cutoffStateRootHeaderSiblings: readonly FieldNumberish[];
  cutoffAccountCount: bigint;
  cutoffAccountCountSiblings: readonly FieldNumberish[];
}

export interface DropClaimParams {
  drop: EligibilityDrop;
  pcashChainId: FieldNumberish;
  snapshot: AssetSnapshot;
  contractOpening: TemplateContractOpening;
  inventory: { index: number } & TemplateNoteOpening;
  claimant: {
    address: FieldNumberish;
    nkRoot: FieldNumberish;
    /** Receives the claimed note's delivery. */
    receiveKey: Uint8Array;
    account: DropClaimantAccount;
  };
  eligibility: DropEligibilityOpening;
  role: TemplateRole;
  notBeforeTimestamp?: FieldNumberish;
  /** At most the drop's claim end. */
  validUntilTimestamp: FieldNumberish;
  assetDefinition: AssetDefinition;
  dummyInputSeed?: FieldNumberish;
  /** The claimant wallet's sender region. */
  sender?: ArenaSender;
}

/** The inputs both drop functions hash into the statement they return. */
function statementInputs(drop: EligibilityDrop, build: AssetActionBuild, feePaid: boolean, pcashChainId: bigint) {
  return {
    recent_pcash_block_hash: fm(build.recentPcashBlockHash),
    event_entry: fm(build.eventOpening.eventEntry),
    address: fm(drop.address),
    pcash_chain_id: fm(pcashChainId),
    fee_paid: feePaid,
  };
}

/** The claim takes the creator's nullifier key commitment beside this; the reclaim derives it. */
function configurationMap(configuration: DropConfiguration): Record<string, string> {
  return {
    configuration_salt: fm(configuration.configurationSalt),
    asset_id: fm(configuration.assetId),
    claim_amount: fm(configuration.claimAmount),
    cutoff_block_number: fm(configuration.cutoffBlockNumber),
    claim_end_timestamp: fm(configuration.claimEndTimestamp),
    creator: fm(configuration.creator),
  };
}

/** One claim: one inventory note in, the configured amount out to the claimant. */
export function buildDropClaim(params: DropClaimParams): TemplateAction {
  return buildTemplateAction(dropClaimSpec(params));
}

/** Shared contract-side terms for unsponsored and wallet-sponsored drop claims. */
export function dropClaimSpec(params: DropClaimParams): TemplateActionSpec {
  const { drop, claimant, eligibility, snapshot } = params;
  const pcashChainId = toField(params.pcashChainId, "pcashChainId");
  const assetId = drop.configuration.assetId;
  const claimAmount = drop.configuration.claimAmount;
  return {
    pcashChainId,
    snapshot,
    contract: templateContractAccount(drop, DROP_CLAIM_FUNCTION_SELECTOR, params.contractOpening),
    assetId,
    assetInputs: [{
      noteSecret: dropInventorySecret(drop, params.inventory.index),
      amount: claimAmount,
      leafIndex: params.inventory.leafIndex,
      siblings: params.inventory.siblings,
    }],
    marker: { replayId: dropClaimReplayId(claimant.address, claimant.nkRoot), selectedEntryCommitment: drop.claimEntryCommitment },
    assetOutputs: (nullifiers) => [templateAssetOutput({
      pcashChainId,
      assetId,
      slot: 0,
      amount: claimAmount,
      recipient: { address: claimant.address, receiveKey: claimant.receiveKey, self: true },
      noteSecret: ownerChangeNoteSecret(claimant.nkRoot, nullifiers, 0),
      assetDefinition: params.assetDefinition,
    })],
    role: params.role,
    ...(params.notBeforeTimestamp === undefined ? {} : { notBeforeTimestamp: params.notBeforeTimestamp }),
    validUntilTimestamp: params.validUntilTimestamp,
    ...(params.dummyInputSeed === undefined ? {} : { dummyInputSeed: params.dummyInputSeed }),
    ...(params.sender === undefined ? {} : { sender: params.sender }),
    application: (build, feePaid) => ({
      packageName: TOKENS_CIRCUIT_PACKAGES.dropClaim,
      circuitUrl: TOKENS_CIRCUITS.dropClaim,
      label: "drop claim function",
      witnessMap: {
        ...statementInputs(drop, build, feePaid, pcashChainId),
        private_value: privateValueMap(build.transaction),
        configuration: configurationMap(drop.configuration),
        creator_nullifier_key_commitment: fm(drop.configuration.creatorNullifierKeyCommitment),
        selected_entry_commitment: fm(drop.claimEntryCommitment),
        claimant: {
          address: fm(claimant.address),
          nk_root: fm(claimant.nkRoot),
          account_rule_set_commitment: fm(claimant.account.accountRuleSetCommitment),
          account_revision: fm(claimant.account.accountRevision),
          receive_key_hash: fm(claimant.account.receiveKeyHash),
          account_witness: {
            leaf_index: fm(claimant.account.accountIndex),
            siblings: fieldArrayMap(claimant.account.accountSiblings),
          },
        },
        recent: {
          state_root: fm(snapshot.stateRoot),
          state_root_header_siblings: fieldArrayMap(snapshot.stateRootHeaderSiblings),
          account_state_root: fm(snapshot.accountStateRoot),
          account_state_root_state_siblings: fieldArrayMap(snapshot.accountStateRootStateSiblings),
          history_root: fm(eligibility.historyRoot),
          history_root_header_siblings: fieldArrayMap(eligibility.historyRootHeaderSiblings),
        },
        cutoff: {
          block_hash: fm(eligibility.cutoffBlockHash),
          history_siblings: fieldArrayMap(eligibility.historySiblings),
          state_root: fm(eligibility.cutoffStateRoot),
          state_root_header_siblings: fieldArrayMap(eligibility.cutoffStateRootHeaderSiblings),
          account_count: fm(eligibility.cutoffAccountCount),
          account_count_state_siblings: fieldArrayMap(eligibility.cutoffAccountCountSiblings),
        },
        claim_slot: 0,
      },
    }),
  };
}

export interface DropReclaimParams {
  drop: EligibilityDrop;
  pcashChainId: FieldNumberish;
  snapshot: AssetSnapshot;
  contractOpening: TemplateContractOpening;
  /** Up to four inventory notes (three when sponsored), merged into one output. */
  inventory: readonly ({ index: number } & TemplateNoteOpening)[];
  creator: {
    address: FieldNumberish;
    nkRoot: FieldNumberish;
    receiveKey: Uint8Array;
  };
  role: TemplateRole;
  /** At least the drop's claim end; defaults to it. */
  notBeforeTimestamp?: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
  assetDefinition: AssetDefinition;
  dummyInputSeed?: FieldNumberish;
  /** The creator wallet's sender region. */
  sender?: ArenaSender;
}

/** Return unclaimed inventory to the creator once the claim window closes. */
export function buildDropReclaim(params: DropReclaimParams): TemplateAction {
  return buildTemplateAction(dropReclaimSpec(params));
}

/** Shared contract-side terms for unsponsored and wallet-sponsored drop reclaims. */
export function dropReclaimSpec(params: DropReclaimParams): TemplateActionSpec {
  const { drop, creator } = params;
  const pcashChainId = toField(params.pcashChainId, "pcashChainId");
  const assetId = drop.configuration.assetId;
  const total = drop.configuration.claimAmount * BigInt(params.inventory.length);
  return {
    pcashChainId,
    snapshot: params.snapshot,
    contract: templateContractAccount(drop, DROP_RECLAIM_FUNCTION_SELECTOR, params.contractOpening),
    assetId,
    assetInputs: params.inventory.map((note) => ({
      noteSecret: dropInventorySecret(drop, note.index),
      amount: drop.configuration.claimAmount,
      leafIndex: note.leafIndex,
      siblings: note.siblings,
    })),
    assetOutputs: (nullifiers) => [templateAssetOutput({
      pcashChainId,
      assetId,
      slot: 0,
      amount: total,
      recipient: { address: creator.address, receiveKey: creator.receiveKey, self: true },
      noteSecret: ownerChangeNoteSecret(creator.nkRoot, nullifiers, 0),
      assetDefinition: params.assetDefinition,
    })],
    role: params.role,
    notBeforeTimestamp: params.notBeforeTimestamp ?? drop.configuration.claimEndTimestamp,
    validUntilTimestamp: params.validUntilTimestamp,
    ...(params.dummyInputSeed === undefined ? {} : { dummyInputSeed: params.dummyInputSeed }),
    ...(params.sender === undefined ? {} : { sender: params.sender }),
    application: (build, feePaid) => ({
      packageName: TOKENS_CIRCUIT_PACKAGES.dropReclaim,
      circuitUrl: TOKENS_CIRCUITS.dropReclaim,
      label: "drop reclaim function",
      witnessMap: {
        ...statementInputs(drop, build, feePaid, pcashChainId),
        private_value: privateValueMap(build.transaction),
        configuration: configurationMap(drop.configuration),
        creator_nk_root: fm(creator.nkRoot),
        output_amounts: fieldArrayMap(build.transaction.outputs.map((_, slot) => slot === 0 ? total : 0n)),
      },
    }),
  };
}
