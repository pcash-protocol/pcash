import type { ResolvedTransactionData } from "../protocol/records.ts";
import type { EventOptions } from "../protocol/events.ts";
import type { PrivateValueShape } from "../constants/privateValueProfiles.ts";
import type { DesignatedIssuanceOpening } from "../protocol/payout.ts";
import type { FieldNumberish } from "../crypto/field.ts";
import { toAddressField, toField } from "../crypto/field.ts";
import { parseExtendedCode } from "../delivery/extendedCode.ts";
import {
  type StandardFungibleAssetDescriptor
} from "../protocol/asset.ts";
import type { AssetDefinition } from "../protocol/assetDefinition.ts";
import type { ArenaSender } from "../protocol/sectionDelivery.ts";
import { randomFieldEntropy } from "../utils/bytes.ts";
import { STATE_KEY_OUTPUT_ROOT } from "../constants/params.ts";
import { openStateKey } from "../protocol/block.ts";
import type { CurrentBoundaryEnvelope } from "../protocol/boundary.ts";

export interface AssetSnapshot {
  recentPcashBlockHash: FieldNumberish;
  stateRoot: FieldNumberish;
  stateRootHeaderSiblings: readonly FieldNumberish[];
  outputRoot: FieldNumberish;
  outputRootStateSiblings: readonly FieldNumberish[];
  accountStateRoot: FieldNumberish;
  accountStateRootStateSiblings: readonly FieldNumberish[];
}

/** An {@link AssetSnapshot} whose values are the decoded bigints of one account proof. */
export interface AccountProofSnapshot extends AssetSnapshot {
  recentPcashBlockHash: bigint;
  stateRoot: bigint;
  stateRootHeaderSiblings: bigint[];
  outputRoot: bigint;
  outputRootStateSiblings: bigint[];
  accountStateRoot: bigint;
  accountStateRootStateSiblings: bigint[];
}

/**
 * The block-header-proved tree roots an account proof pins, in the snapshot
 * shape every kernel builder takes. All of them describe the proof's boundary,
 * so a witness built from it binds that one `recentPcashBlockHash`.
 */
export function snapshotFromAccountProof(
  proof: {
    boundary: CurrentBoundaryEnvelope;
    stateRootHeaderSiblings: bigint[];
    accountStateRoot: bigint;
    accountStateRootStateSiblings: bigint[];
  },
): AccountProofSnapshot {
  return {
    recentPcashBlockHash: proof.boundary.blockHash,
    stateRoot: proof.boundary.header.stateRoot,
    stateRootHeaderSiblings: proof.stateRootHeaderSiblings,
    outputRoot: proof.boundary.state.outputRoot,
    outputRootStateSiblings: openStateKey(proof.boundary.state, STATE_KEY_OUTPUT_ROOT).siblings,
    accountStateRoot: proof.accountStateRoot,
    accountStateRootStateSiblings: proof.accountStateRootStateSiblings,
  };
}

export interface AssetAccountAuthorization {
  address: FieldNumberish;
  nkRoot: FieldNumberish;
  accountIndex: number;
  accountSiblings: readonly FieldNumberish[];
  accountRuleSetCommitment: FieldNumberish;
  accountKind: FieldNumberish;
  accountRevision: FieldNumberish;
  receiveKeyHash: FieldNumberish;
  rule: {
    configurationCommitment: FieldNumberish;
    commitmentBlinder: FieldNumberish;
    entryIndex: number;
    siblings: readonly FieldNumberish[];
  };
}

export type AssetActionInput =
  | {
    kind: "asset";
    amount: bigint;
    noteSecret: FieldNumberish;
    leafIndex: number;
    siblings: readonly FieldNumberish[];
  }
  | {
    kind: "native";
    amount: bigint;
    noteSecret: FieldNumberish;
    leafIndex: number;
    siblings: readonly FieldNumberish[];
    /** Owner address override, valid only under a separate fee payer. */
    owner?: FieldNumberish;
    /** The override's nullifier key. Required with `owner`. */
    nk?: FieldNumberish;
  }
  | { kind: "creation-marker" }
  | {
    /**
     * A note-free one-shot marker whose nullifier the selected account rule
     * defines. `replayId` must be computed by that rule from facts it has
     * authenticated — never chosen freshly per attempt, or it marks nothing.
     */
    kind: "application";
    replayId: FieldNumberish;
    selectedEntryCommitment: FieldNumberish;
  }
  | { kind: "dummy" };

export type AssetOutputDestination =
  | {
    /** The sender knows and can validate the complete destination opening. */
    kind: "opening";
    recipientAddress: FieldNumberish;
    noteSecret: FieldNumberish;
  }
  | {
    /**
     * Returns to the owning account under the secret the readable rules derive
     * in-circuit from the owner's `nkRoot` and the transaction's nullifiers. The
     * builder resolves the secret and seals the delivery envelope.
     */
    kind: "owner-change";
  }
  | {
    /** The recipient supplied this commitment and accepted responsibility for its opening. */
    kind: "recipient-commitment";
    ownerCommitment: FieldNumberish;
  }
  | {
    /** Advanced escape hatch. A wrong value permanently destroys the output. */
    kind: "raw-commitment";
    ownerCommitment: FieldNumberish;
    allowUnspendableOutput: true;
  };

export type AssetActionOutput =
  | {
    kind: "asset" | "native";
    destination: AssetOutputDestination;
    amount: bigint;
    /**
     * The slot's exact output data for a delivery the builder does not seal;
     * size-class filler when omitted. Encrypted deliveries take theirs from the builder.
     */
    outputData?: Uint8Array;
    delivery:
    | {
      /** The builder seals the opening to `receiveKey`, with the records in the recipient's region. */
      kind: "canonical-encrypted";
      pcashChainId: bigint;
      assetId: bigint;
      outputIndex: number;
      receiveKey: Uint8Array;
      assetDefinition?: AssetDefinition;
      /** Returns to the building wallet, so its sender region does not record it as paid. */
      change?: true;
    }
    | {
      /** Owner change: the builder seals the derived opening to `receiveKey`. */
      kind: "owner-change-encrypted";
      pcashChainId: bigint;
      assetId: bigint;
      receiveKey: Uint8Array;
      assetDefinition?: AssetDefinition;
    }
    | { kind: "recipient-supplied" }
    | { kind: "out-of-band" }
    | { kind: "unsafe-raw" };
  }
  | {
    kind: "dummy";
    dummySecret: FieldNumberish;
    amount: 0n;
    /** Size-class filler when omitted. */
    outputData?: Uint8Array;
  };

export interface BuildAssetActionBaseParams extends EventOptions {
  shape?: PrivateValueShape;
  pcashChainId: FieldNumberish;
  snapshot: AssetSnapshot;
  /** Transfer-only private burn committed by the complete transaction. Defaults to zero. */
  assetBurnAmount?: bigint;
  /** One authenticated account/rule owns every real note input in this action. */
  owner: AssetAccountAuthorization;
  /**
   * Two authorizing accounts: the primary owns the asset inputs and every
   * marker, and a distinct fee payer owns the native inputs. The
   * sponsored-transfer kernel authenticates both accounts, so this build carries no
   * account fields of its own.
   */
  nativeFeePayer?: boolean;
  inputs: readonly AssetActionInput[];
  outputs: readonly AssetActionOutput[];
  openFeeAmount: bigint;
  /** The final output slot is the private native-PCASH selected-relay fee. */
  privateRelayPayment?: { amount: bigint; ownerCommitment: FieldNumberish };
  issuanceOwnerCommitment: FieldNumberish;
  /** Opening for a nonzero designated issuance route. */
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  notBeforeTimestamp?: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
  /** The carrier context the delivering carrier must have; 0 = any delivery. Default 0. */
  carrierContextHash?: FieldNumberish;
  /** Defaults to fresh CSPRNG entropy. Explicit values are for deterministic vectors. */
  dummyInputSeed?: FieldNumberish;
  /**
   * The building wallet's sender region: every output it paid by envelope or
   * opened itself, and the asset's definition.
   */
  sender?: ArenaSender;
  data?: ResolvedTransactionData | undefined;
  /** The asset's definition for the sender region; it must derive the action's assetId. */
  assetDefinition?: AssetDefinition;
}

export interface BuildStandardAssetTransferParams extends BuildAssetActionBaseParams {
  /** Ordinary transfer, split, merge, or burn needs only the recovered note namespace. */
  assetId: FieldNumberish;
  assetDescriptor?: never;
  assetSecret?: never;
}

export interface BuildStandardAssetCreationParams extends BuildAssetActionBaseParams {
  /** Asset creation opens and authenticates the complete immutable definition. */
  assetId?: never;
  assetDescriptor: StandardFungibleAssetDescriptor;
  assetSecret: FieldNumberish;
}

export type BuildAssetActionParams =
  | BuildStandardAssetTransferParams
  | BuildStandardAssetCreationParams;


/**
 * Create a recoverable real output and its canonical encrypted delivery. The
 * builder rechecks the chain, namespace, and position against the final action,
 * and seals the envelope once the arena holds the output's records.
 */
export function openedAssetActionOutput(params: {
  kind: "asset" | "native";
  pcashChainId: FieldNumberish;
  assetId: FieldNumberish;
  outputIndex: number;
  noteSecret?: FieldNumberish;
  amount: bigint;
  /** Delivered with an asset note so its holder can verify the asset's identity. */
  assetDefinition?: AssetDefinition;
  /** The output returns to the building wallet: delivered, but not recorded as paid. */
  change?: true;
} & (
    | {
      recipientExtendedCode: string;
      recipientAddress?: never;
      recipientMlKemPublicKey?: never;
      authenticatedRecipient?: never;
    }
    | {
      recipientExtendedCode?: never;
      recipientAddress: FieldNumberish;
      recipientMlKemPublicKey: Uint8Array;
      /** The caller locally authenticated this address/key pair. */
      authenticatedRecipient: true;
    }
  )): AssetActionOutput {
  const pcashChainId = toField(params.pcashChainId, "pcashChainId");
  const assetId = toField(params.assetId, "assetId");
  if (params.kind === "native" && assetId !== 0n) throw new Error("native output assetId must be zero");
  if (params.kind === "asset" && assetId === 0n) throw new Error("asset output assetId must be nonzero");
  const recipient = params.recipientExtendedCode === undefined
    ? {
      address: toAddressField(params.recipientAddress, "recipientAddress"),
      mlKemPublicKey: params.recipientMlKemPublicKey,
    }
    : parseExtendedCode(params.recipientExtendedCode);
  if ("chainId" in recipient && recipient.chainId !== pcashChainId) {
    throw new Error("recipient extended code uses another PCASH chain");
  }
  const recipientAddress = toAddressField(recipient.address, "recipientAddress");
  const noteSecret = toField(params.noteSecret ?? randomFieldEntropy(), "noteSecret");
  return {
    kind: params.kind,
    destination: {
      kind: "opening",
      recipientAddress,
      noteSecret,
    },
    amount: params.amount,
    delivery: {
      kind: "canonical-encrypted",
      pcashChainId,
      assetId,
      outputIndex: params.outputIndex,
      receiveKey: recipient.mlKemPublicKey,
      ...(params.assetDefinition === undefined ? {} : { assetDefinition: params.assetDefinition }),
      ...(params.change === true ? { change: true as const } : {}),
    },
  };
}

/**
 * Create an owner-change output. The builder derives its note secret exactly as
 * the readable rules do in-circuit and seals the canonical delivery to the
 * owner's `receiveKey`.
 */
export function ownerChangeAssetActionOutput(params: {
  kind: "asset" | "native";
  pcashChainId: FieldNumberish;
  assetId: FieldNumberish;
  amount: bigint;
  receiveKey: Uint8Array;
  assetDefinition?: AssetDefinition;
}): AssetActionOutput {
  const pcashChainId = toField(params.pcashChainId, "pcashChainId");
  const assetId = toField(params.assetId, "assetId");
  if (params.kind === "native" && assetId !== 0n) throw new Error("native output assetId must be zero");
  if (params.kind === "asset" && assetId === 0n) throw new Error("asset output assetId must be nonzero");
  return {
    kind: params.kind,
    destination: { kind: "owner-change" },
    amount: params.amount,
    delivery: {
      kind: "owner-change-encrypted",
      pcashChainId,
      assetId,
      receiveKey: params.receiveKey,
      ...(params.assetDefinition === undefined ? {} : { assetDefinition: params.assetDefinition }),
    },
  };
}

/**
 * Create a real output whose opening is delivered outside the canonical wallet
 * envelope. Callers are responsible for recipient recovery; the builder records
 * the opening in the sender region.
 */
export function outOfBandAssetActionOutput(params: {
  kind: "asset" | "native";
  recipientAddress: FieldNumberish;
  noteSecret: FieldNumberish;
  amount: bigint;
  /** Size-class filler when omitted. */
  outputData?: Uint8Array;
}): AssetActionOutput {
  return {
    kind: params.kind,
    destination: {
      kind: "opening",
      recipientAddress: toAddressField(params.recipientAddress, "recipientAddress"),
      noteSecret: params.noteSecret,
    },
    amount: params.amount,
    ...(params.outputData === undefined ? {} : { outputData: params.outputData }),
    delivery: { kind: "out-of-band" },
  };
}

/** Create a real output from a commitment supplied and accepted by its recipient. */
export function recipientCommittedAssetActionOutput(params: {
  kind: "asset" | "native";
  ownerCommitment: FieldNumberish;
  amount: bigint;
  outputData: Uint8Array;
  recipientAcceptedDelivery: true;
}): AssetActionOutput {
  if (params.recipientAcceptedDelivery !== true) {
    throw new Error("recipient commitment requires recipientAcceptedDelivery=true");
  }
  return {
    kind: params.kind,
    destination: {
      kind: "recipient-commitment",
      ownerCommitment: params.ownerCommitment,
    },
    amount: params.amount,
    outputData: params.outputData,
    delivery: { kind: "recipient-supplied" },
  };
}

/**
 * Create an output from an unauthenticated commitment. This is intentionally
 * verbose: consensus cannot prove that anybody knows a usable opening.
 */
export function unsafeRawAssetActionOutput(params: {
  kind: "asset" | "native";
  ownerCommitment: FieldNumberish;
  amount: bigint;
  outputData: Uint8Array;
  allowUnspendableOutput: true;
}): AssetActionOutput {
  if (params.allowUnspendableOutput !== true) {
    throw new Error("raw owner commitment requires allowUnspendableOutput=true");
  }
  return {
    kind: params.kind,
    destination: {
      kind: "raw-commitment",
      ownerCommitment: params.ownerCommitment,
      allowUnspendableOutput: params.allowUnspendableOutput,
    },
    amount: params.amount,
    outputData: params.outputData,
    delivery: { kind: "unsafe-raw" },
  };
}
