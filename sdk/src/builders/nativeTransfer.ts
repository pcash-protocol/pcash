import { accountCreationAttachmentCommitment, type AccountCreationAttachment } from "../protocol/codec.ts";
import type { ResolvedTransactionData } from "../protocol/records.ts";
import { prepareEvent, type EventOptions } from "../protocol/events.ts";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import { authorizationIssuanceOpening, type DesignatedIssuanceOpening } from "../protocol/payout.ts";
// PCASH witness builders.
//
// Produces the exact Prover.toml witness shapes the reference circuits consume,
// building a coherent scenario end to end: a transfer authorized by a real
// secp256k1 signature under the reference ECDSA rule, folded with the protocol kernel;
// standalone first/subsequent transfers; and a signed account body.

import { type FieldNumberish, toField, toNonnegativeBigInt } from "../crypto/field.ts";
import {
  createPcashAuthorizationRequest,
  requirePcashAuthorization,
  requestPcashAuthorization,
  type PcashActionSigner,
  type PcashAuthorizationResolver,
  type PcashAuthorizationRequest,
  type VerifiedPcashAuthorization,
} from "../eip712/authorization.ts";
import {
  DEFAULT_RULE_ENTRY_INDICES,
  defaultUserAccountRuleSet,
  type DefaultUserAccountRule,
  type DefaultUserAccountRuleSet,
  type DefaultUserRuleSecrets,
} from "../rules/referenceRules.ts";
import {
  buildPaymentRuleWitness,
  paymentTypedData,
} from "../rules/readableRules.ts";
import { MINE_RULE_VK_HASH } from "../constants/rulePins.ts";
import {
  batchTransferTypedData,
} from "../rules/semanticRules.ts";
import { buildBatchTransferRuleWitness } from "../rules/semanticWitnesses.ts";
import {
  fullOutputCommitment,
  noteBodyCommitment,
  noteNk,
  noteSecret,
  noteSecretSeed,
  nullifier,
  nullifierKeyCommitment,
  ownerCommitment,
  applicationNullifier,
  dummyNullifier,
} from "../protocol/notes.ts";
import { assertArena, deliveryCommitment } from "../protocol/transfer.ts";
import {
  accountRuleEntryCommitment,
  accountStateCommitment,
  buildAccountRuleSet,
  type AccountRuleEntry,
  type ChonkVkArtifacts,
} from "../protocol/account.ts";
import {
  ruleStatementMap,
  fieldArrayMap,
  fm,
  privateValueChoicesMap,
  privateValueMap,
  type WitnessMap,
  zeroFields,
} from "../protocol/witness.ts";
import {
  accountScalarMap,
  accountWitnessMap,
  snapshotWitnessMap,
  inputNoteMap,
  vkWitnessMap,
} from "./witnessMaps.ts";
import { rootFromIndex } from "../crypto/merkle.ts";
import {
  BLOCK_HEADER_KEY_STATE_ROOT,
  BLOCK_HEADER_TREE_DEPTH,
  ACCOUNT_RULE_SET_DEPTH,
  MERKLE_DEPTH,
  ACCOUNT_KIND_USER,
  STATE_KEY_OUTPUT_ROOT,
  STATE_KEY_ACCOUNT_STATE_ROOT,
  STATE_TREE_DEPTH,
} from "../constants/params.ts";
import { sizeClassFiller, assertOutputDataItems } from "../protocol/envelope.ts";
import type { SentOpening } from "../protocol/arena.ts";
import { sealSectionDelivery, type ArenaSender, type EnvelopeOutput } from "../protocol/sectionDelivery.ts";
import {
  encodePrivateValueTransaction,
  TX_KIND_PRIVATE_VALUE,
  type PrivateValueOutputData,
  type PrivateValueOutputDataOverrides,
} from "../protocol/codec.ts";
import { randomFieldEntropy } from "../utils/bytes.ts";
import type { WalletProfile } from "../protocol/types.ts";
import { parseExtendedCode } from "../delivery/extendedCode.ts";
import { networkForChain, type NetworkConfigLike } from "../protocol/network.ts";
import {
  SlotClass,
  privateValueCommitment,
  type PrivateValue,
} from "../protocol/transaction.ts";
import {
  authorizationCommitment,
  ruleStatement,
  transferActionCommitment,
  type RuleStatement,
} from "../protocol/statement.ts";
import { verifyBlockHeaderPath, verifyStatePath } from "../protocol/block.ts";
import { requireLength } from "../utils/validate.ts";


// Witness encodings (fm, fieldArrayMap, WitnessMap) live in
// ../protocol/witness.ts; shared account/snapshot blocks in ./witnessMaps.ts.

/** A fixed-depth sibling path as field elements, rejecting any other length. */
function fieldPath(
  values: readonly FieldNumberish[],
  depth: number,
  label: string,
  elementLabel: string,
): bigint[] {
  if (values.length !== depth) throw new Error(`${label} must have length ${depth}`);
  return values.map((value) => toField(value, elementLabel));
}

function treeIndex(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** MERKLE_DEPTH) {
    throw new Error(`${label} must be an integer below 2^${MERKLE_DEPTH}`);
  }
  return value;
}

/**
 * Resolve a Merkle opening for a witness leaf. Real openings are required:
 * the caller supplies `root` + `siblings` from its synced tree at the selected
 * block, which the circuit re-derives from `leaf` at `leafIndex`. Real multi-leaf state
 * demands this; a synthetic single-leaf root does not open from the selected
 * block's stateRoot. The sibling path length is checked before witness assembly.
 */
function resolveOpening(
  label: string,
  leafIndex: number,
  root: FieldNumberish,
  siblings: readonly FieldNumberish[],
): { leafIndex: number; siblings: bigint[]; root: bigint } {
  const checkedLeafIndex = treeIndex(`${label} leaf index`, leafIndex);
  requireLength(siblings, MERKLE_DEPTH, `${label} siblings`);
  return {
    leafIndex: checkedLeafIndex,
    siblings: siblings.map((s) => toField(s, `${label} sibling`)),
    root: toField(root, `${label} root`),
  };
}

function unifiedAccountState(
  accountRevision: FieldNumberish,
  receiveKeyHash: FieldNumberish,
): { revision: bigint; hash: bigint } {
  const revision = toNonnegativeBigInt(accountRevision, "accountRevision");
  if (revision >= 1n << 32n) {
    throw new Error("accountRevision must be a u32");
  }
  return { revision, hash: toField(receiveKeyHash, "receiveKeyHash") };
}

// ===========================================================================
// PrivateValue native transfer (kind 0) — account rules
// ===========================================================================

/**
 * One shared account-rule entry plus its depth-8 membership witness. User
 * rule and Smart Contract function APIs adapt their own terms to this shape.
 */
export interface AccountRuleMembershipWitness {
  configurationCommitment: FieldNumberish;
  commitmentBlinder: FieldNumberish;
  entryIndex: number;
  /** Depth-8 membership siblings, leaf-level upward. */
  siblings: readonly FieldNumberish[];
}

/** User-rule adapter shape consumed by `buildNativeTransfer`. */
export interface UserRuleWitness {
  configurationCommitment: FieldNumberish;
  commitmentBlinder: FieldNumberish;
  slot: number;
  siblings: readonly FieldNumberish[];
}

/** One spent input note plus its depth-40 opening against the selected snapshot's note root. */
export interface TransferInputNote {
  amount: bigint;
  noteSecret: FieldNumberish;
  outputIndex?: number;
  /** Leaf-level-upward depth-MERKLE_DEPTH opening against `outputRoot`. */
  siblings: readonly FieldNumberish[];
}

/** One real output note (slot 1 second recipient, or an explicit extra output). */
export interface TransferOutput {
  /**
   * The output owner's 20-byte address. On the default rule path the batch
   * rule's message declares it, unless it is the signer's own address, which
   * is proved as owner change.
   */
  address: FieldNumberish;
  amount: bigint;
  /** entropy for this slot; subject to the transfer-wide freshness policy. */
  entropy?: FieldNumberish;
  /** ML-KEM-768 receive key to encrypt this output's payload to. */
  receiveKey?: Uint8Array;
  /** Alternative to `receiveKey`: an extended code. */
  extendedCode?: string;
  /** Explicit transaction output data (no-encryption path). */
  outputData?: Uint8Array;
}

/**
 * Inputs for `buildNativeTransfer` (kind 0). The shared fields below apply to
 * every spend. Authorization is supplied through EXACTLY ONE of two groups:
 *
 *  - the user-rule façade (`ruleSetCommitment?`, `rule?`, `slot?`,
 *    `defaultRuleSecrets?`, `otherRules?`) — when omitted entirely, the
 *    account's default ECDSA rule set is reconstructed and its application
 *    signature witness is emitted;
 *  - the explicit account-rule group (`accountKind`, `accountRuleSetCommitment`,
 *    `accountRule`, `buildEcdsaApplicationWitness?`) — the neutral core used by Smart
 *    Contract functions and non-default user rules.
 *
 * Supplying fields from both groups (beyond the default-ECDSA user case)
 * throws.
 */
export interface BuildNativeTransferParams extends EventOptions {
  /** Closed private-value subtype; dimensions come from the generated profile. */
  shape?: PrivateValueShape;
  chainId: FieldNumberish;
  /** Runtime genesis network. Generated values are used only when omitted. */
  network?: NetworkConfigLike;
  wallet: WalletProfile;
  /** Resolved receive key for automatically encrypted change. */
  selfReceiveKey?: Uint8Array;
  /**
   * The building wallet's sender region: every envelope this build delivers to
   * someone else and every output whose opening it chose, readable later with
   * the wallet's outgoing key alone.
   */
  sender?: ArenaSender;
  /** Verified external authorization, when already available. */
  authorization?: VerifiedPcashAuthorization;
  /** Synchronous adapter used by headless tooling after the request is prepared. */
  authorizationResolver?: PcashAuthorizationResolver;
  /**
   * Slot-0 recipient address: the owner of the slot-0 note and, under the
   * default rules, the recipient the readable message displays.
   */
  recipientAddress: FieldNumberish;
  /**
   * Slot-0 amount, `0 <= paymentAmount < 2^128`. Zero leaves slot 0 as dummy
   * padding: no recipient note, payload, or receive key. The recipient is
   * still signed.
   */
  paymentAmount: bigint;
  /**
   * Up to the selected profile’s input capacity of spent notes, all owned by `wallet`, opened against the selected
   * snapshot's `outputRoot`. Empty input slots become dummy nullifiers. The caller
   * (coin selection) chooses which notes to spend; none is valid when the
   * outputs and fee need no funding.
   */
  inputs: readonly TransferInputNote[];
  /**
   * Optional note-free APPLICATION markers, placed in slots the inputs do not
   * occupy. Each publishes `poseidon(APPLICATION_NULLIFIER_DOMAIN,
   * uint160(address), selectedEntryCommitment, replayId)` as that slot's
   * nullifier, so the selected rule's one-shot fact reaches consensus as an
   * ordinary nullifier. `replayId` must be one the rule derives from facts it
   * has authenticated; a value chosen per attempt marks nothing.
   */
  applicationMarkers?: readonly {
    slot: number;
    replayId: FieldNumberish;
    selectedEntryCommitment: FieldNumberish;
  }[];
  /**
   * Optional slot-1 second real output (arbitrary owner). Change to self is added
   * automatically into the next free slot; remaining slots are dummies. Under
   * the default rules it routes the transfer through the batch rule: the
   * payment rule's only other output is the owner's change.
   */
  secondOutput?: TransferOutput;
  /** Ordered recipients after the primary and optional second output. Change follows them. */
  additionalOutputs?: readonly TransferOutput[];
  /** Private native-PCASH fee note in the final output slot, separate from application recipients. */
  privateRelayPayment?: TransferOutput;
  /** Slot-ordered entropy overrides, including late L slots. */
  outputEntropies?: readonly (FieldNumberish | undefined)[];
  openFeeAmount: bigint;
  issuanceOwnerCommitment: FieldNumberish;
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  /**
   * Per-transaction dummy entropy: a private witness, fresh and unpredictable
   * per action, that makes every dummy input nullifier unique. Omit to sample a
   * fresh CSPRNG scalar; explicit values support deterministic application
   * flows and tests.
   */
  dummyInputEntropy?: FieldNumberish;
  /** Inclusion deadline: `< 2^64`, nonzero. */
  validUntilTimestamp: FieldNumberish;
  /** Earliest inclusion timestamp: `< 2^64`; 0 = unconstrained. Default 0. */
  notBeforeTimestamp?: FieldNumberish;
  /** The carrier context the delivering carrier must have; 0 = any delivery. Default 0. */
  carrierContextHash?: FieldNumberish;
  accountCreation?: AccountCreationAttachment;
  /** Canonical recent PCASH block selected for this proof. */
  recentPcashBlockHash: FieldNumberish;
  /** State root and depth-4 opening under the selected block header. */
  stateRoot: FieldNumberish;
  stateRootHeaderSiblings: readonly FieldNumberish[];
  /** Selected snapshot note root and its depth-4 opening under stateRoot. */
  outputRoot: FieldNumberish;
  outputRootStateSiblings: readonly FieldNumberish[];
  /** Depth-4 opening of accountStateRoot under stateRoot. */
  accountStateRootStateSiblings: readonly FieldNumberish[];
  /** Account fields opened by the kernel; historical membership is required for non-dummy inputs. */
  accountRevision: FieldNumberish;
  /** `receiveKeyHash` of the receive key, or zero when the account has no receive key. */
  receiveKeyHash: FieldNumberish;
  /** Durable blinders for the default user rule instances. */
  defaultRuleSecrets?: DefaultUserRuleSecrets;
  accountIndex?: number;
  // --- user-rule façade group ---
  ruleSetCommitment?: FieldNumberish;
  /**
   * An explicitly registered user-account rule such as multisig. When
   * present, `ruleSetCommitment` must be the account's registered set and the
   * supplied application witness must satisfy that rule.
   * When absent, the default ECDSA rule is reconstructed with the SDK's
   * deterministic blinder and the ECDSA application witness is emitted.
   */
  rule?: UserRuleWitness;
  /** Rules co-resident with the default ECDSA rules (ignored when `rule` is given). */
  otherRules?: readonly AccountRuleEntry[];
  // --- explicit account-rule group (Smart Contract functions / non-default rules) ---
  /** Account kind bound into the leaf. Explicit-group only. */
  accountKind?: FieldNumberish;
  /** The account's committed account-rule set the spend proves membership in. Explicit-group only. */
  accountRuleSetCommitment?: FieldNumberish;
  /** The depth-8 account-rule membership witness for the spending entry. Explicit-group only. */
  accountRule?: AccountRuleMembershipWitness;
  /** Emit the reference ECDSA application witness for this account-rule entry. Explicit-group only. */
  buildEcdsaApplicationWitness?: boolean;
  /**
   * Per-slot entropy witnesses, ordered across the selected profile. An explicit value is used when valid.
   * Padding, private relay payments, published-root outputs, and outputs in a
   * fully occupied real-input transfer sample fresh entropy by default. Other
   * real outputs in a private-root transfer default to zero. Owner change under
   * the default readable rules always uses zero entropy and ignores an explicit
   * value: those rules derive its secret in-circuit from `nkRoot` and the
   * published nullifiers so a clean wallet can recompute it. `secondOutput.entropy`
   * overrides its slot.
   * When freshness is required, overrides must be nonzero and distinct across
   * slots.
   */
  /**
   * Slot-ordered output note-secret overrides. A rule whose recipient opening is
   * canonical pins the secret here. A caller rebuilding an already-authorized
   * action against newer state can reuse the prior build's resolved secrets so
   * its output bodies do not change. A first-build override for padding must
   * itself be private and unpredictable.
   */
  outputNoteSecrets?: readonly (FieldNumberish | undefined)[];
  /**
   * The spender's `nkRoot` is or may be public. When set, EVERY output
   * slot (recipient, second, change, AND dummies) gets fresh CSPRNG entropy so
   * observers cannot recompute output secrets or recognize zero-entropy dummies.
   * Defaults to false; contract adapters set it from whether the contract body
   * publishes `nkRoot`, not from account kind. Explicit per-slot entropy must remain
   * nonzero and independent. Recovery of such outputs is via output-data scan, not
   * nk-rescan.
   */
  publicNkRoot?: boolean;
  /**
   * Optional slot-ordered output-data overrides. An undefined slot is generated
   * automatically; an explicit zero-length array remains zero-length.
   */
  outputData?: PrivateValueOutputDataOverrides;
  /**
   * A prior build's arena, to rebuild the same private value. Every encrypted
   * output must then reuse that build's output data too; by default the
   * builder writes a fresh arena holding this build's records.
   */
  arena?: Uint8Array;
  /** Recipient ML-KEM-768 receive key for slot-0 output (delivery target 1). */
  recipientReceiveKey?: Uint8Array;
  /** Alternative to `recipientReceiveKey`: an extended code. */
  recipientExtendedCode?: string;
  /**
   * Alternative to a receive key: slot 0 is a direct send. Its envelope is
   * keyed by its note secret, so it carries the records `data` names for its
   * address, and the sender region records its opening, flagged so the sender
   * can rebuild the link it shares. Requires `sender`.
   */
  recipientDirectSend?: true;
  /** Transaction data: encrypted for recipients and the sender, and public records anyone reads. */
  data?: ResolvedTransactionData | undefined;
  /**
   * Address-account opening for the spender at the selected block — `accountStateRoot`
   * and `accountSiblings` from the synced account tree. The circuit recomputes
   * this root from the account state commitment at `accountIndex`. Leaf-level upward, length
   * MERKLE_DEPTH.
   */
  accountStateRoot: FieldNumberish;
  accountSiblings: readonly FieldNumberish[];
}


export interface NativeTransferBuild {
  eventOpening: { eventEntry: bigint; eventSalt: bigint; eventsCommitment: bigint };
  shape: PrivateValueShape;
  publicInputs: bigint[]; // Verifier order; the node derives the chain ID and delivery commitment.
  pcashChainId: bigint;
  recentPcashBlockHash: bigint;
  transaction: PrivateValue;
  privateValueCommitment: bigint;
  /** The acting account's address, which the authorization commitment names. */
  address: bigint;
  /** The rule statement the transfer kernel expects from the selected rule. */
  ruleStatement: RuleStatement;
  /**
   * Application package the witness targets: the mine rule for mining, the
   * payment rule for payment-shaped transfers, or the batch rule for larger
   * recipient sets. Provers select the circuit package by this name.
   */
  authorizationCircuit: "account_rule_mine" | "account_rule_payment_ecdsa" | "account_rule_batch_transfer_ecdsa" | "account_rule_large_batch_transfer_ecdsa";
  /** Per-output note secrets in profile slot order. */
  outputNoteSecrets: bigint[];
  configurationCommitment: bigint;
  accountRuleSetCommitment: bigint;
  /**
   * Application witness for the mine rule or an authorized ECDSA transfer.
   */
  accountRuleWitnessMap?: WitnessMap;
  /** Exact typed-data authorization needed by the default user rule. */
  authorizationRequest?: PcashAuthorizationRequest;
  /** Attach a verified response without rebuilding transaction randomness. */
  authorizeAccountRule?: (authorization: VerifiedPcashAuthorization) => {
    witnessMap: WitnessMap;
  };
  buildKernelWitnessMap: (authorizationVk: ChonkVkArtifacts) => WitnessMap;
  /** Private-value transaction output-data items in profile slot order. */
  outputData: PrivateValueOutputData;
  arena: Uint8Array;
  /** The exact type-0 transaction bytes for this build's kernel proof. */
  encodeTransaction(proof: Uint8Array): Uint8Array;
  scenario: Record<string, bigint>;
}

/**
 * Reconstruct the account's default rule set, plus any co-resident
 * `otherRules`.
 * Returns the set commitment and the payment rule's depth-8 membership witness
 * (the transfer path's default). The base blinder is the SDK's
 * signature-derived value by default, so a wallet reconstructs its own default
 * set from the Ethereum key alone.
 */
/** Which default rule the returned witness selects. */
export type DefaultRuleName =
  | "payment"
  | "assetPayment"
  | "assetBurn"
  | "batchTransfer"
  | "accountAdmin"
  | "contractFeeSponsorship"
  | "assetCreation";

const RULE_PROPERTY = {
  payment: "rule",
  assetPayment: "assetPaymentRule",
  assetBurn: "assetBurnRule",
  batchTransfer: "batchTransferRule",
  accountAdmin: "accountAdminRule",
  contractFeeSponsorship: "contractFeeSponsorshipRule",
  assetCreation: "assetCreationRule",
} as const satisfies Record<DefaultRuleName, keyof DefaultUserAccountRuleSet>;

export function defaultEcdsaRuleSet(params: {
  wallet: WalletProfile;
  network?: NetworkConfigLike;
  secrets: DefaultUserRuleSecrets;
  /** Co-resident non-default rules, at indices outside the reserved set. */
  otherRules?: readonly AccountRuleEntry[];
  rule?: DefaultRuleName;
  shape?: PrivateValueShape;
}): { ruleSetCommitment: bigint; accountRuleEntryCommitment: bigint; ruleWitness: UserRuleWitness } {
  const defaults = defaultUserAccountRuleSet({
    wallet: params.wallet,
    ...(params.network === undefined ? {} : { network: params.network }),
    secrets: params.secrets,
  });
  const others = params.otherRules ?? [];
  for (const rule of others) {
    if ((DEFAULT_RULE_ENTRY_INDICES as readonly number[]).includes(rule.entryIndex)) {
      throw new Error(`slot ${rule.entryIndex} is reserved for a default ECDSA rule`);
    }
  }
  const set = buildAccountRuleSet([...others, ...defaults.entries]);
  const selected = params.shape === PRIVATE_VALUE_PROFILES.L.shapeId
    ? params.rule === "assetCreation" ? defaults.largeAssetCreationRule
      : params.rule === "contractFeeSponsorship" ? defaults.largeContractFeeSponsorshipRule
      : params.rule === "accountAdmin" ? defaults.accountAdminRule
      : defaults.largeBatchTransferRule
    : defaults[RULE_PROPERTY[params.rule ?? "payment"]] as DefaultUserAccountRule;
  const membership = set.membership(selected.entryIndex);
  return {
    ruleSetCommitment: set.accountRuleSetCommitment,
    accountRuleEntryCommitment: selected.accountRuleEntryCommitment,
    ruleWitness: {
      configurationCommitment: selected.configurationCommitment,
      commitmentBlinder: selected.commitmentBlinder,
      slot: selected.entryIndex,
      siblings: membership.siblings,
    },
  };
}

/** One resolved input slot: a real spent note or a dummy placeholder. */
interface InputSlot {
  leafIndex: number;
  noteSecret: bigint;
  amount: bigint;
  siblings: bigint[];
  commitment: bigint;
  nullifier: bigint;
}

/** One resolved output slot (0 primary recipient, 1–2 second recipient/change/dummy). */
interface OutputSlot {
  /** The note owner's address; zero for padding. */
  owner: bigint;
  amount: bigint;
  isDummy: boolean;
  entropy: bigint;
  noteSecret: bigint;
  ownerCommitment: bigint;
  body: bigint;
  outputData: Uint8Array;
}

/**
 * Build a native transfer (kind 0). Authorization comes from EXACTLY ONE of the
 * user-rule façade or the explicit account-rule group (see
 * `BuildNativeTransferParams`); the default-ECDSA user path (no group
 * supplied) reconstructs the account's default rule set and emits its
 * ECDSA application witness.
 */
export function buildNativeTransfer(params: BuildNativeTransferParams): NativeTransferBuild {
  const shape = params.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const profile = privateValueProfile(shape);
  const TRANSFER_N_IN = profile.inputs;
  const TRANSFER_N_OUT = profile.outputs;
  const network = networkForChain(params.chainId, params.network);
  // The L profile and any output beyond the payment, change, and relay fee
  // exceed the payment message's shape, so the default rule path selects the
  // batch-transfer rule for them. That includes a second output to the owner:
  // the payment rule has one change slot.
  const defaultRule: DefaultRuleName =
    shape === PRIVATE_VALUE_PROFILES.L.shapeId || (params.additionalOutputs?.length ?? 0) > 0
      || params.secondOutput !== undefined
      ? "batchTransfer"
      : "payment";
  const hasExplicitGroup =
    params.accountRule !== undefined ||
    params.accountRuleSetCommitment !== undefined ||
    params.accountKind !== undefined;
  const hasUserGroup =
    params.rule !== undefined ||
    params.ruleSetCommitment !== undefined ||
    params.defaultRuleSecrets !== undefined ||
    params.otherRules !== undefined;
  if (hasExplicitGroup && hasUserGroup) {
    throw new Error(
      "buildNativeTransfer: supply either the user-rule group or the explicit account-rule group, not both",
    );
  }

  let accountKind: bigint;
  let accountRuleSetCommitment: bigint;
  let accountRule: AccountRuleMembershipWitness;
  let buildEcdsaApplicationWitness: boolean;
  if (hasExplicitGroup) {
    if (
      params.accountKind === undefined ||
      params.accountRuleSetCommitment === undefined ||
      params.accountRule === undefined
    ) {
      throw new Error(
        "the explicit account-rule group requires accountKind, accountRuleSetCommitment, and accountRule",
      );
    }
    accountKind = toField(params.accountKind, "accountKind");
    accountRuleSetCommitment = toField(params.accountRuleSetCommitment, "accountRuleSetCommitment");
    accountRule = params.accountRule;
    buildEcdsaApplicationWitness = params.buildEcdsaApplicationWitness ?? false;
  } else {
    // User-rule façade: default readable set (nothing supplied) or an
    // explicitly registered user rule such as multisig.
    const usingDefaultEcdsa = params.rule === undefined;
    let ruleSetCommitment: bigint;
    let ruleWitness: UserRuleWitness;
    if (usingDefaultEcdsa) {
      if (params.defaultRuleSecrets === undefined) {
        throw new Error("defaultRuleSecrets are required for the default user rules");
      }
      const set = defaultEcdsaRuleSet({
        wallet: params.wallet,
        network,
        secrets: params.defaultRuleSecrets,
        rule: defaultRule,
        shape,
        ...(params.otherRules !== undefined ? { otherRules: params.otherRules } : {}),
      });
      ruleSetCommitment = set.ruleSetCommitment;
      if (
        params.ruleSetCommitment !== undefined &&
        toField(params.ruleSetCommitment, "ruleSetCommitment") !== ruleSetCommitment
      ) {
        throw new Error(
          "ruleSetCommitment does not match the reconstructed default ECDSA rule set",
        );
      }
      ruleWitness = set.ruleWitness;
    } else {
      if (params.ruleSetCommitment === undefined) {
        throw new Error(
          "an explicit rule requires ruleSetCommitment (the account's registered rule set)",
        );
      }
      if (params.rule!.siblings.length !== ACCOUNT_RULE_SET_DEPTH) {
        throw new Error(`rule.siblings must have length ${ACCOUNT_RULE_SET_DEPTH}`);
      }
      ruleSetCommitment = toField(params.ruleSetCommitment, "ruleSetCommitment");
      ruleWitness = params.rule!;
    }
    accountKind = ACCOUNT_KIND_USER;
    accountRuleSetCommitment = ruleSetCommitment;
    accountRule = {
      configurationCommitment: ruleWitness.configurationCommitment,
      commitmentBlinder: ruleWitness.commitmentBlinder,
      entryIndex: ruleWitness.slot,
      siblings: ruleWitness.siblings,
    };
    buildEcdsaApplicationWitness = usingDefaultEcdsa;
  }

  const chainId = toField(params.chainId, "chainId");
  const { wallet } = params;
  const recipientAddress = toField(params.recipientAddress, "recipientAddress");
  const issuanceOwnerCommitment = toField(params.issuanceOwnerCommitment, "issuanceOwnerCommitment");
  if (issuanceOwnerCommitment !== 0n && params.openFeeAmount !== 0n) throw new Error("designated issuance cannot coexist with an open fee");
  // Per-transaction dummy entropy: fresh CSPRNG scalar unless an explicit
  // deterministic value is supplied.
  const dummyInputEntropy =
    params.dummyInputEntropy !== undefined
      ? toField(params.dummyInputEntropy, "dummyInputEntropy")
      : randomFieldEntropy();
  const validUntil = toField(params.validUntilTimestamp, "validUntilTimestamp");
  const notBefore = toField(params.notBeforeTimestamp ?? 0n, "notBeforeTimestamp");
  const carrierContextHash = toField(params.carrierContextHash ?? 0n, "carrierContextHash");
  const recentPcashBlockHash = toField(
    params.recentPcashBlockHash,
    "recentPcashBlockHash",
  );
  const stateRoot = toField(params.stateRoot, "stateRoot");
  const stateRootHeaderSiblings = fieldPath(
    params.stateRootHeaderSiblings,
    BLOCK_HEADER_TREE_DEPTH,
    "stateRootHeaderSiblings",
    "stateRootHeaderSibling",
  );
  const accountStateRootStateSiblings = fieldPath(
    params.accountStateRootStateSiblings,
    STATE_TREE_DEPTH,
    "accountStateRootStateSiblings",
    "accountStateRootStateSibling",
  );
  const accountIndex = treeIndex("accountIndex", params.accountIndex ?? 0);
  const accountState = unifiedAccountState(
    params.accountRevision,
    params.receiveKeyHash,
  );

  if (params.inputs.length > TRANSFER_N_IN) {
    throw new Error(`transfer takes 0..${TRANSFER_N_IN} inputs, got ${params.inputs.length}`);
  }

  const accountRuleSiblings = fieldPath(
    accountRule.siblings,
    ACCOUNT_RULE_SET_DEPTH,
    "accountRule.siblings",
    "accountRuleSibling",
  );
  const configurationCommitment = toField(
    accountRule.configurationCommitment,
    "accountRule.configurationCommitment",
  );
  const commitmentBlinder = toField(
    accountRule.commitmentBlinder,
    "accountRule.commitmentBlinder",
  );
  const entryIndex = accountRule.entryIndex;

  const openFeeAmount = params.openFeeAmount;
  const nk = noteNk(wallet.nkRoot);
  const p = nullifierKeyCommitment(wallet.nkRoot);
  const outputRoot = toField(params.outputRoot, "outputRoot");
  const outputRootStateSiblings = fieldPath(
    params.outputRootStateSiblings,
    STATE_TREE_DEPTH,
    "outputRootStateSiblings",
    "outputRootStateSibling",
  );

  // --- Input slots: real notes first, then markers, then dummy fillers. ---
  const markers = new Map<number, { replayId: bigint; nullifier: bigint }>();
  for (const marker of params.applicationMarkers ?? []) {
    if (!Number.isInteger(marker.slot) || marker.slot < 0 || marker.slot >= TRANSFER_N_IN) {
      throw new Error(`applicationMarkers slot ${marker.slot} is out of range`);
    }
    if (marker.slot < params.inputs.length) {
      throw new Error(`applicationMarkers slot ${marker.slot} already holds a spent note`);
    }
    if (markers.has(marker.slot)) {
      throw new Error(`applicationMarkers slot ${marker.slot} declared twice`);
    }
    markers.set(marker.slot, {
      replayId: toField(marker.replayId, "applicationMarkers.replayId"),
      nullifier: applicationNullifier(
        wallet.address,
        marker.selectedEntryCommitment,
        marker.replayId,
      ),
    });
  }
  const inputSlots: InputSlot[] = [];
  let totalIn = 0n;
  for (let i = 0; i < TRANSFER_N_IN; i++) {
    if (i < params.inputs.length) {
      const spec = params.inputs[i]!;
      const leafIndex = treeIndex(`inputs[${i}].outputIndex`, spec.outputIndex ?? 0);
      const noteSecretVal = toField(spec.noteSecret, `inputs[${i}].noteSecret`);
      const open = resolveOpening(`inputs[${i}]`, leafIndex, outputRoot, spec.siblings);
      const commitment = fullOutputCommitment(
        { owner: wallet.address, noteSecret: noteSecretVal, assetId: 0n, amount: spec.amount },
        leafIndex,
      );
      totalIn += spec.amount;
      inputSlots.push({
        leafIndex,
        noteSecret: noteSecretVal,
        amount: spec.amount,
        siblings: open.siblings,
        commitment,
        nullifier: nullifier(commitment, nk, noteSecretVal),
      });
    } else {
      // A marker slot carries no note, exactly like a dummy; only the nullifier
      // differs, and who defines it.
      const marker = markers.get(i);
      inputSlots.push({
        leafIndex: 0,
        noteSecret: 0n,
        amount: 0n,
        siblings: zeroFields(MERKLE_DEPTH),
        commitment: 0n,
        nullifier: marker?.nullifier ?? dummyNullifier(dummyInputEntropy, i),
      });
    }
  }
  const inputSlotClasses = inputSlots.map((_, index) =>
    index < params.inputs.length ? SlotClass.NATIVE
      : markers.has(index) ? SlotClass.APPLICATION
      : SlotClass.DUMMY
  );
  const replayIds = inputSlots.map((_, index) => markers.get(index)?.replayId ?? 0n);

  // All published nullifiers are fixed here before any output
  // is constructed, so they can salt every output note secret.
  const nullifiers = inputSlots.map((s) => s.nullifier);

  // Output roles: primary, remaining ordered recipients, change, then padding.
  // A zero primary payment has no role; its slot is padding like any other.
  const paymentAmount = params.paymentAmount;
  if (paymentAmount < 0n || paymentAmount >= 1n << 128n) {
    throw new Error("paymentAmount must be nonnegative and below 2^128");
  }

  interface OutRole {
    recipientAddress: bigint;
    amount: bigint;
    entropy?: FieldNumberish;
    receiveKey?: Uint8Array;
    extendedCode?: string;
    outputData?: Uint8Array;
    relayPayment?: boolean;
    change?: boolean;
  }
  const extras: OutRole[] = [];
  const privateRelay = params.privateRelayPayment;
  if (privateRelay !== undefined && (privateRelay.amount <= 0n || privateRelay.amount >= 1n << 128n)) {
    throw new Error("private relay payment amount must be positive and below 2^128");
  }
  let spent = paymentAmount + openFeeAmount + (privateRelay?.amount ?? 0n);
  const remainingOutputs = [
    ...(params.secondOutput === undefined ? [] : [params.secondOutput]),
    ...(params.additionalOutputs ?? []),
  ];
  for (const [index, so] of remainingOutputs.entries()) {
    if (so.amount <= 0n || so.amount >= 1n << 128n) {
      throw new Error(`recipient output ${index + 1} amount must be positive and below 2^128`);
    }
    const outputAddress = toField(so.address, `recipient output ${index + 1} address`);
    // The batch rule reads a zero declared recipient as an undeclared slot.
    if (buildEcdsaApplicationWitness && defaultRule === "batchTransfer" && outputAddress === 0n) {
      throw new Error(`recipient output ${index + 1} address must be nonzero under the batch rule`);
    }
    extras.push({
      recipientAddress: outputAddress,
      amount: so.amount,
      ...(so.entropy !== undefined ? { entropy: so.entropy } : {}),
      ...(so.receiveKey !== undefined ? { receiveKey: so.receiveKey } : {}),
      ...(so.extendedCode !== undefined ? { extendedCode: so.extendedCode } : {}),
      ...(so.outputData !== undefined ? { outputData: so.outputData } : {}),
    });
    spent += so.amount;
  }
  const changeAmount = totalIn - spent;
  if (changeAmount < 0n) {
    throw new Error("sum(inputs) < paymentAmount + secondOutput + openFeeAmount");
  }
  if (changeAmount > 0n) {
    // Change is just a note to self, encrypted to the spender's own receive key.
    extras.push({ recipientAddress: wallet.address, amount: changeAmount, change: true, ...(params.selfReceiveKey !== undefined ? { receiveKey: params.selfReceiveKey } : {}) });
  }
  if (extras.length > TRANSFER_N_OUT - 1 - (privateRelay === undefined ? 0 : 1)) {
    throw new Error(
      `too many real outputs for ${TRANSFER_N_OUT} slots, including change`,
    );
  }
  const privateRelayRole: OutRole | undefined = privateRelay === undefined ? undefined : {
    recipientAddress: toField(privateRelay.address, "privateRelayPayment.address"),
    amount: privateRelay.amount,
    ...(privateRelay.receiveKey !== undefined ? { receiveKey: privateRelay.receiveKey } : {}),
    ...(privateRelay.extendedCode !== undefined ? { extendedCode: privateRelay.extendedCode } : {}),
    ...(privateRelay.outputData !== undefined ? { outputData: privateRelay.outputData } : {}),
    relayPayment: true,
  };

  const seed = noteSecretSeed(nk);
  // Output entropy. A public dummy nullifier separates transactions but does
  // not hide padding from someone who knows the note key, so every padding slot
  // gets private entropy. With no dummy inputs the tuple is stable across
  // competing actions, so every output slot needs fresh entropy even for a
  // private-root wallet. Published roots require it in every shape because
  // observers can otherwise recompute output secrets. Owner change under the
  // default readable rules is the exception: those rules derive its secret
  // in-circuit with zero entropy so the owner can recompute it.
  //
  // The salt has to come from an actual DUMMY slot. An APPLICATION marker is
  // note-free in the same way, but its nullifier is canonical by construction —
  // that is the entire point of the class — so it salts nothing. Counting spare
  // slots would treat the two alike and silently drop output entropy.
  const publicNkRoot = params.publicNkRoot ?? false;
  if (publicNkRoot && buildEcdsaApplicationWitness) {
    throw new Error("the readable rules derive owner change from a private nkRoot; publicNkRoot is not supported");
  }
  const hasDummyInput = inputSlotClasses.some((slotClass) => slotClass === SlotClass.DUMMY);
  const requiresFreshOutputEntropy = publicNkRoot || !hasDummyInput;
  const usedFreshEntropy = new Set<bigint>();
  const resolveEntropy = (i: number, role: OutRole | undefined): bigint => {
    const explicit = role?.entropy ?? params.outputEntropies?.[i];
    // Owner change under the readable rules opens under the derived secret,
    // so explicit entropy for that slot has no effect. Slot 0 under the payment
    // rule is the signed recipient even when it pays the owner, so its secret
    // stays free.
    const provedAsOwnerChange = buildEcdsaApplicationWitness
      && role !== undefined
      && role.recipientAddress === wallet.address
      && role.relayPayment !== true
      && !(defaultRule === "payment" && i === 0);
    if (provedAsOwnerChange) return 0n;
    const needsFreshEntropy = requiresFreshOutputEntropy
      || role === undefined
      || role.relayPayment === true;
    const resolved = explicit !== undefined
      ? toField(explicit, `outputEntropies[${i}]`)
      : needsFreshEntropy
        ? randomFieldEntropy()
        : 0n;
    if (needsFreshEntropy) {
      if (resolved === 0n) {
        throw new Error(
          `outputEntropies[${i}] must be nonzero when fresh output entropy is required`,
        );
      }
      if (usedFreshEntropy.has(resolved)) {
        throw new Error("fresh output entropy must be distinct for every slot");
      }
      usedFreshEntropy.add(resolved);
    }
    return resolved;
  };
  const outputDataOverrides = params.outputData ?? [];
  if (params.recipientDirectSend === true && (params.sender === undefined || params.recipientReceiveKey !== undefined
    || params.recipientExtendedCode !== undefined || outputDataOverrides[0] !== undefined)) {
    throw new Error("a direct send needs a sender region and no other slot-0 delivery");
  }
  const slot0Delivery: OutRole | undefined = paymentAmount === 0n ? undefined : {
    recipientAddress,
    amount: paymentAmount,
    ...(params.recipientReceiveKey !== undefined ? { receiveKey: params.recipientReceiveKey } : {}),
    ...(params.recipientExtendedCode !== undefined
      ? { extendedCode: params.recipientExtendedCode }
      : {}),
    ...(outputDataOverrides[0] !== undefined ? { outputData: outputDataOverrides[0] } : {}),
  };

  const outputSlots: OutputSlot[] = [];
  const envelopeOutputs: EnvelopeOutput[] = [];
  const sentOpenings: SentOpening[] = [];
  for (let i = 0; i < TRANSFER_N_OUT; i++) {
    const role: OutRole | undefined =
      i === 0 ? slot0Delivery : i === TRANSFER_N_OUT - 1 && privateRelayRole !== undefined
        ? privateRelayRole : extras[i - 1];
    const isDummy = role === undefined;
    const owner = isDummy ? 0n : role!.recipientAddress;
    const amount = isDummy ? 0n : role!.amount;
    const entropy = resolveEntropy(i, role);
    // A rule with a canonical opening pins its output's secret, because the
    // recipient must be able to reconstruct it from chain data rather than
    // trusting whoever executed the action to have chosen one they know.
    const pinned = params.outputNoteSecrets?.[i];
    const ns = pinned === undefined
      ? noteSecret(seed, nullifiers, i, entropy, shape)
      : toField(pinned, `outputNoteSecrets[${i}]`);
    const outputOwnerCommitment = ownerCommitment(owner, ns);
    const body = noteBodyCommitment(outputOwnerCommitment, 0n, amount);

    // Output data. Explicit bytes win; dummy slots use size-class filler by
    // default, while real slots are sealed to their receive keys once the
    // arena holds their records.
    let outputData: Uint8Array = new Uint8Array(0);
    const explicitOutputData = i === 0
      ? outputDataOverrides[0]
      : role?.outputData ?? outputDataOverrides[i];
    // Change and the relay fee return to their owners; everything else is paid.
    const paid = !isDummy && role!.change !== true && role!.relayPayment !== true;
    if (explicitOutputData !== undefined) {
      outputData = explicitOutputData;
      if (paid) {
        sentOpenings.push({ slot: i, recipientAddress: owner, assetId: 0n, amount, noteSecret: ns });
      }
    } else if (i === 0 && !isDummy && params.recipientDirectSend === true) {
      envelopeOutputs.push({ slot: i, recipientAddress: owner, note: { chainId, assetId: 0n, amount, owner, noteSecret: ns } });
      sentOpenings.push({ slot: i, directSend: true, recipientAddress: owner, assetId: 0n, amount, noteSecret: ns });
    } else if (isDummy) {
      // Padded by default so the real-output count is not observable.
      outputData = sizeClassFiller();
    } else {
      const pub =
        role!.receiveKey ??
        (role!.extendedCode !== undefined
          ? parseExtendedCode(role!.extendedCode).mlKemPublicKey
          : undefined);
      if (pub === undefined) {
        throw new Error(
          `buildNativeTransfer: output ${i} has no receive key and no explicit outputData[${i}]; pass a receive key/extended code or explicit output data`,
        );
      }
      envelopeOutputs.push({
        slot: i,
        receiveKey: pub,
        recipientAddress: role!.recipientAddress,
        note: { chainId, assetId: 0n, amount, owner, noteSecret: ns },
        ...(paid ? { sentTo: owner } : {}),
      });
    }
    outputSlots.push({
      owner,
      amount,
      isDummy,
      entropy,
      noteSecret: ns,
      ownerCommitment: outputOwnerCommitment,
      body,
      outputData,
    });
  }
  let arena: Uint8Array;
  if (params.arena !== undefined) {
    if (envelopeOutputs.length > 0 || params.data !== undefined) {
      throw new Error("a supplied arena requires the prior build's output data for every encrypted output");
    }
    arena = params.arena;
  } else {
    const delivery = sealSectionDelivery({
      shape,
      context: { chainId, transactionType: TX_KIND_PRIVATE_VALUE, nullifiers },
      envelopes: envelopeOutputs,
      data: params.data,
      freeSlots: outputSlots.flatMap((output, slot) => output.isDummy && outputDataOverrides[slot] === undefined ? [slot] : []),
      ...(params.sender === undefined ? {} : { sender: params.sender }),
      sentOpenings,
    });
    arena = delivery.arena;
    for (const [slot, envelope] of delivery.envelopes) outputSlots[slot]!.outputData = envelope;
  }
  const accountOpen = resolveOpening("account", accountIndex, params.accountStateRoot, params.accountSiblings);
  const openedAccountStateCommitment = accountStateCommitment(
    wallet.address,
    p,
    accountRuleSetCommitment,
    accountKind,
    accountState.revision,
    accountState.hash,
  );
  const reconstructedAccountRoot = rootFromIndex(openedAccountStateCommitment, accountIndex, accountOpen.siblings);
  // SDK callers supply these openings. Match the circuit's membership rule
  // using the actual slot classes, including APPLICATION markers.
  if (inputSlotClasses.some((slot) => slot !== SlotClass.DUMMY) && reconstructedAccountRoot !== accountOpen.root) {
    throw new Error("account fields do not open under accountStateRoot");
  }
  if (!verifyBlockHeaderPath(
    recentPcashBlockHash,
    BLOCK_HEADER_KEY_STATE_ROOT,
    stateRoot,
    stateRootHeaderSiblings,
  )) throw new Error("stateRoot does not open under recentPcashBlockHash");
  if (!verifyStatePath(
    stateRoot,
    STATE_KEY_ACCOUNT_STATE_ROOT,
    accountOpen.root,
    accountStateRootStateSiblings,
  )) throw new Error("accountStateRoot does not open under stateRoot");
  if (!verifyStatePath(
    stateRoot,
    STATE_KEY_OUTPUT_ROOT,
    outputRoot,
    outputRootStateSiblings,
  )) throw new Error("outputRoot does not open under stateRoot");
  const outputData = outputSlots.map((slot) => slot.outputData);
  assertOutputDataItems(outputData, shape);
  assertArena(arena, shape);
  const delivery = deliveryCommitment(outputData, arena);
  const { issuanceRecipient, issuanceNoteSecret, transactionContext } = authorizationIssuanceOpening(issuanceOwnerCommitment, chainId, nullifiers, params.designatedIssuanceOpening, shape);
  const accountCreationCommitment = accountCreationAttachmentCommitment(params.accountCreation, chainId);
  const transaction: PrivateValue = {
    global: {
      openFeeAmount,
      issuanceOwnerCommitment,
      notBeforeTimestamp: notBefore,
      validUntilTimestamp: validUntil,
      carrierContextHash,
      assetBurnAmount: 0n,
      deliveryCommitment: delivery,
      accountCreationCommitment,
    },
    inputs: inputSlots.map((slot, index) => ({
      slotClass: inputSlotClasses[index]!,
      inputCommitment: slot.commitment,
      nullifier: slot.nullifier,
    })),
    outputs: outputSlots.map((slot) => ({
      slotClass: slot.isDummy ? SlotClass.DUMMY : SlotClass.NATIVE,
      outputBodyCommitment: slot.body,
    })),
  };
  const privateValueCommitmentValue = privateValueCommitment(transaction, shape);
  const eventOpening = prepareEvent(params);
  const statement = ruleStatement(
    authorizationCommitment(wallet.address, configurationCommitment),
    transferActionCommitment(chainId, privateValueCommitmentValue),
    recentPcashBlockHash,
    eventOpening.eventEntry,
  );
  const publicInputs = [
    chainId,
    recentPcashBlockHash,
    ...inputSlots.map((s) => s.nullifier),
    ...outputSlots.map((slot) => slot.body),
    delivery,
    openFeeAmount,
    issuanceOwnerCommitment,
    notBefore,
    validUntil,
    carrierContextHash,
    eventOpening.eventsCommitment,
    accountCreationCommitment,
  ];

  // --- Optional readable payment-rule witness (the default user rule).
  // The signed message displays the recipient, amount, fee, and timing. ---
  let accountRuleWitnessMap: WitnessMap | undefined;
  let authorizationRequest: PcashAuthorizationRequest | undefined;
  let authorizeAccountRule:
    | ((authorization: VerifiedPcashAuthorization) => {
        witnessMap: WitnessMap;
      })
    | undefined;
  if (buildEcdsaApplicationWitness) {
    if (defaultRule === "payment") {
      const message = {
        pcashChainId: chainId,
        recipient: recipientAddress,
        amount: paymentAmount,
        openFeeAmount,
        issuanceRecipient,
        issuanceOwnerCommitment,
        relayFeeAmount: privateRelayRole?.amount ?? 0n,
        relayFeeOwnerCommitment: privateRelayRole === undefined ? 0n
          : outputSlots[TRANSFER_N_OUT - 1]!.ownerCommitment,
        accountCreationCommitment,
        transactionContext,
        notBefore,
        validUntil,
      };
      authorizationRequest = createPcashAuthorizationRequest({
        kind: "payment",
        authorizingAddress: wallet.address,
        typedData: paymentTypedData(network, message),
      });
      authorizeAccountRule = (authorization) => buildPaymentRuleWitness({
          network,
          wallet,
          authorization: requirePcashAuthorization(authorizationRequest!, authorization),
          recentPcashBlockHash,
          eventEntry: eventOpening.eventEntry,
          nkRoot: wallet.nkRoot,
          message,
          nativeChangeAmount: outputSlots[1]!.isDummy ? 0n : outputSlots[1]!.amount,
          transaction,
          issuanceNoteSecret,
          recipientNoteSecret: outputSlots[0]!.isDummy ? 0n : outputSlots[0]!.noteSecret,
        });
    } else {
      // Batch rule: every externally-directed output is named in the message.
      // A slot that pays the owner is declared all-zero and proved to return to
      // the owner in-circuit, so private change never reaches the typed data.
      const isOwnerChange = (slot: (typeof outputSlots)[number]) =>
        !slot.isDummy && slot.owner === wallet.address;
      const declaration = (slotIndex: number) => {
        const slot = outputSlots[slotIndex]!;
        return slot.isDummy || isOwnerChange(slot)
          || (privateRelayRole !== undefined && slotIndex === TRANSFER_N_OUT - 1)
          ? { recipient: 0n, amount: 0n, assetId: 0n }
          : { recipient: slot.owner, amount: slot.amount, assetId: 0n };
      };
      const message = {
        pcashChainId: chainId,
        assetId: 0n,
        assetBurnAmount: 0n,
        outputs: outputSlots.map((_, index) => declaration(index)),
        openFeeAmount,
        issuanceRecipient,
        issuanceOwnerCommitment,
        relayFeeAmount: privateRelayRole?.amount ?? 0n,
        relayFeeOwnerCommitment: privateRelayRole === undefined ? 0n
          : outputSlots[TRANSFER_N_OUT - 1]!.ownerCommitment,
        accountCreationCommitment,
        transactionContext,
        notBefore,
        validUntil,
      };
      authorizationRequest = createPcashAuthorizationRequest({
        kind: "batch-transfer",
        authorizingAddress: wallet.address,
        typedData: batchTransferTypedData(network, message, shape),
      });
      authorizeAccountRule = (authorization) => buildBatchTransferRuleWitness({
          shape,
          network,
          wallet,
          authorization: requirePcashAuthorization(authorizationRequest!, authorization),
          recentPcashBlockHash,
          eventEntry: eventOpening.eventEntry,
          nkRoot: wallet.nkRoot,
          message,
          transaction,
          issuanceNoteSecret,
          outputNoteSecrets: outputSlots.map((slot) =>
            slot.isDummy || isOwnerChange(slot)
              || (privateRelayRole !== undefined && slot === outputSlots[TRANSFER_N_OUT - 1])
              ? 0n : slot.noteSecret),
          ownerChangeAmounts: outputSlots.map((slot) => isOwnerChange(slot) ? slot.amount : 0n),
        });
    }
    const suppliedAuthorization = params.authorization
      ?? params.authorizationResolver?.(authorizationRequest!);
    if (suppliedAuthorization !== undefined) {
      const applicationWitness = authorizeAccountRule!(suppliedAuthorization);
      accountRuleWitnessMap = applicationWitness.witnessMap;
    }
  }

  const buildKernelWitnessMap = (authorizationVk: ChonkVkArtifacts): WitnessMap => {
    const authorizationVkMap = vkWitnessMap(authorizationVk, "authorizationVk");
    return {
      event_salt: fm(eventOpening.eventSalt),
      pcash_chain_id: fm(chainId),
      recent_pcash_block_hash: fm(recentPcashBlockHash),
      choices: privateValueChoicesMap(transaction),
      output_owner_commitments: fieldArrayMap(outputSlots.map((slot) => slot.ownerCommitment)),
      output_dummy_secrets: fieldArrayMap(outputSlots.map((slot) => slot.isDummy ? slot.noteSecret : 0n)),
      output_amounts: fieldArrayMap(outputSlots.map((slot) => slot.amount)),
      asset_id: fm(0n),
      dummy_input_seed: fm(dummyInputEntropy),
      replay_ids: fieldArrayMap(replayIds),
      ...snapshotWitnessMap({
        stateRootHeaderSiblings,
        outputRoot,
        outputRootStateSiblings,
        accountStateRoot: accountOpen.root,
        accountStateRootStateSiblings,
      }),
      account: {
        ...accountScalarMap({
          address: wallet.address,
          nkRoot: wallet.nkRoot,
          accountRevision: accountState.revision,
          receiveKeyHash: accountState.hash,
          configurationCommitment,
          commitmentBlinder,
        }),
        ...accountWitnessMap({
          accountIndex,
          accountSiblings: accountOpen.siblings,
          ruleEntryIndex: entryIndex,
          ruleSiblings: accountRuleSiblings,
        }),
      },
      account_kind: fm(accountKind),
      rule_statement: ruleStatementMap(statement),
      authorization_vk: authorizationVkMap,
      owner_inputs: inputSlots.map((slot) => inputNoteMap(slot)),
    };
  };

  return {
    shape,
    eventOpening,
    publicInputs,
    pcashChainId: chainId,
    recentPcashBlockHash,
    transaction,
    privateValueCommitment: privateValueCommitmentValue,
    address: wallet.address,
    ruleStatement: statement,
    authorizationCircuit:
      defaultRule === "payment"
        ? "account_rule_payment_ecdsa"
        : shape === PRIVATE_VALUE_PROFILES.L.shapeId
          ? "account_rule_large_batch_transfer_ecdsa"
          : "account_rule_batch_transfer_ecdsa",
    outputNoteSecrets: outputSlots.map((slot) => slot.noteSecret),
    configurationCommitment,
    accountRuleSetCommitment,
    ...(accountRuleWitnessMap !== undefined ? { accountRuleWitnessMap } : {}),
    ...(authorizationRequest !== undefined ? { authorizationRequest } : {}),
    ...(authorizeAccountRule !== undefined ? { authorizeAccountRule } : {}),
    buildKernelWitnessMap,
    outputData,
    arena,
    encodeTransaction: (proof) => encodePrivateValueTransaction({ shape, publicInputs, proof, outputData, arena, ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }) }),
    scenario: {
      nk,
      p,
      nullifier0: inputSlots[0]!.nullifier,
      body0: outputSlots[0]!.body,
      body1: outputSlots[1]!.body,
      body2: outputSlots[2]!.body,
      accountStateRoot: accountOpen.root,
      outputRoot,
      changeAmount,
      totalIn,
    },
  };
}

/** Snapshot and payout inputs for a signature-free S-profile mining action. */
export type BuildMineActionParams = Pick<BuildNativeTransferParams,
  | "chainId" | "network" | "wallet"
  | "issuanceOwnerCommitment" | "designatedIssuanceOpening" | "dummyInputEntropy"
  | "validUntilTimestamp" | "notBeforeTimestamp" | "carrierContextHash" | "accountCreation" | "recentPcashBlockHash"
  | "stateRoot" | "stateRootHeaderSiblings" | "outputRoot" | "outputRootStateSiblings"
  | "accountStateRoot" | "accountStateRootStateSiblings" | "accountIndex" | "accountSiblings"
  | "accountRevision" | "receiveKeyHash" | "sender" | "data"
>;

/** Build an all-padding action with a private rule set that is never registered. */
export function buildMineAction(params: BuildMineActionParams): NativeTransferBuild {
  const configurationCommitment = 0n;
  const commitmentBlinder = randomFieldEntropy();
  const rules = buildAccountRuleSet([{
    entryIndex: 0,
    accountRuleEntryCommitment: accountRuleEntryCommitment(MINE_RULE_VK_HASH, configurationCommitment, commitmentBlinder),
  }]);
  const build = buildNativeTransfer({
    chainId: params.chainId,
    ...(params.network !== undefined ? { network: params.network } : {}),
    wallet: params.wallet,
    issuanceOwnerCommitment: params.issuanceOwnerCommitment,
    ...(params.designatedIssuanceOpening !== undefined ? { designatedIssuanceOpening: params.designatedIssuanceOpening } : {}),
    ...(params.dummyInputEntropy !== undefined ? { dummyInputEntropy: params.dummyInputEntropy } : {}),
    validUntilTimestamp: params.validUntilTimestamp,
    ...(params.notBeforeTimestamp !== undefined ? { notBeforeTimestamp: params.notBeforeTimestamp } : {}),
    ...(params.carrierContextHash !== undefined ? { carrierContextHash: params.carrierContextHash } : {}),
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    recentPcashBlockHash: params.recentPcashBlockHash,
    stateRoot: params.stateRoot,
    stateRootHeaderSiblings: params.stateRootHeaderSiblings,
    outputRoot: params.outputRoot,
    outputRootStateSiblings: params.outputRootStateSiblings,
    accountStateRoot: params.accountStateRoot,
    accountStateRootStateSiblings: params.accountStateRootStateSiblings,
    ...(params.accountIndex !== undefined ? { accountIndex: params.accountIndex } : {}),
    accountSiblings: params.accountSiblings,
    accountRevision: params.accountRevision,
    receiveKeyHash: params.receiveKeyHash,
    ...(params.sender !== undefined ? { sender: params.sender } : {}),
    ...(params.data !== undefined ? { data: params.data } : {}),
    shape: PRIVATE_VALUE_PROFILES.S.shapeId,
    recipientAddress: params.wallet.address,
    paymentAmount: 0n,
    inputs: [],
    openFeeAmount: 0n,
    accountKind: ACCOUNT_KIND_USER,
    accountRuleSetCommitment: rules.accountRuleSetCommitment,
    accountRule: { configurationCommitment, commitmentBlinder, entryIndex: 0, siblings: rules.membership(0).siblings },
  });
  return {
    ...build,
    authorizationCircuit: "account_rule_mine",
    // The mine rule opens nothing about the account, so it passes the
    // kernel's authorization commitment through.
    accountRuleWitnessMap: {
      pcash_chain_id: fm(build.pcashChainId),
      recent_pcash_block_hash: fm(build.recentPcashBlockHash),
      authorization_commitment: fm(build.ruleStatement[0]),
      event_entry: fm(build.eventOpening.eventEntry),
      private_value: privateValueMap(build.transaction),
    },
  };
}

/** Complete a prepared default-rule transfer through the platform-neutral signer boundary. */
export async function authorizeNativeTransferBuild(
  build: NativeTransferBuild,
  signer: PcashActionSigner,
): Promise<NativeTransferBuild> {
  if (build.authorizationRequest === undefined) return build;
  if (build.authorizeAccountRule === undefined) {
    throw new Error("native transfer authorization request has no witness finalizer");
  }
  const witness = build.authorizeAccountRule(
    await requestPcashAuthorization(signer, build.authorizationRequest),
  );
  return {
    ...build,
    accountRuleWitnessMap: witness.witnessMap,
  };
}
