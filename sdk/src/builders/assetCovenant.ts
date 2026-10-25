import {
  AMOUNT_BITS,
  MERKLE_DEPTH
} from "../constants/params.ts";
import type { FieldNumberish } from "../crypto/field.ts";
import { toAddressField, toField } from "../crypto/field.ts";
import { rootFromIndex } from "../crypto/merkle.ts";
import {
  assertAssetAmount,
  assetCovenantSuccessorConfigurationCommitment
} from "../protocol/asset.ts";
import {
  noteBodyCommitment,
  ownerCommitment
} from "../protocol/notes.ts";
import { accountStateCommitment } from "../protocol/account.ts";
import {
  SlotClass
} from "../protocol/transaction.ts";
import { requireLength } from "../utils/validate.ts";
import type { AssetActionBuild } from "./assetAction.ts";
import type { AssetSnapshot } from "./assetOutputs.ts";
import {
  fieldArrayMap,
  fm,
  privateValueMap,
  type WitnessMap,
} from "../protocol/witness.ts";


export interface AssetCovenantSuccessorAccount {
  address: FieldNumberish;
  nullifierKeyCommitment: FieldNumberish;
  ruleSetCommitment: FieldNumberish;
  accountRevision: FieldNumberish;
  receiveKeyHash: FieldNumberish;
  accountIndex: number;
  accountSiblings: readonly FieldNumberish[];
}

export interface AssetCovenantOutputOpening {
  /** Zero for native PCASH; nonzero for an asset successor output. */
  assetId: FieldNumberish;
  amount: bigint;
  noteSecret: FieldNumberish;
}

/** Build the installed Smart Contract rule witness for an exact live successor. */
export function buildAssetCovenantRuleWitness(params: {
  build: AssetActionBuild;
  snapshot: AssetSnapshot;
  pcashChainId: FieldNumberish;
  /** Maximum public PCASH fee the successor covenant permits. */
  maxNativeOpenFeeAmount: bigint;
  successor: AssetCovenantSuccessorAccount;
  outputs: readonly [
    AssetCovenantOutputOpening | null,
    AssetCovenantOutputOpening | null,
    AssetCovenantOutputOpening | null,
    AssetCovenantOutputOpening | null,
    AssetCovenantOutputOpening | null,
  ];
}): { configurationCommitment: bigint; witnessMap: WitnessMap } {
  if (params.build.operation !== "transfer") {
    throw new Error("asset successor covenant requires a standard asset transfer");
  }
  if (params.maxNativeOpenFeeAmount < 0n || params.maxNativeOpenFeeAmount >= (1n << BigInt(AMOUNT_BITS))) {
    throw new Error(`maxNativeOpenFeeAmount must be in 0..2^${AMOUNT_BITS}-1`);
  }
  if (toField(params.build.transaction.global.assetBurnAmount) !== 0n) {
    throw new Error("asset successor covenant forbids asset burning");
  }
  if (toField(params.build.transaction.global.openFeeAmount) > params.maxNativeOpenFeeAmount) {
    throw new Error("asset successor covenant fee exceeds maxNativeOpenFeeAmount");
  }
  if (params.build.transaction.inputs.some((input) => input.slotClass === SlotClass.ASSET_CREATION)) {
    throw new Error("asset successor covenant input must be asset, native, or dummy");
  }
  requireLength(params.successor.accountSiblings, MERKLE_DEPTH, "successor account siblings");
  const successor = params.successor;
  const address = toAddressField(successor.address, "successor.address");
  const nkCommitment = toField(successor.nullifierKeyCommitment, "successor.nullifierKeyCommitment");
  const ruleSetCommitment = toField(successor.ruleSetCommitment, "successor.ruleSetCommitment");
  const revision = toField(successor.accountRevision, "successor.accountRevision");
  const receiveKeyHash = toField(successor.receiveKeyHash, "successor.receiveKeyHash");
  const successorLeaf = accountStateCommitment(
    address,
    nkCommitment,
    ruleSetCommitment,
    1n,
    revision,
    receiveKeyHash,
  );
  if (
    rootFromIndex(
      successorLeaf,
      successor.accountIndex,
      successor.accountSiblings,
    ) !== toField(params.snapshot.accountStateRoot)
  ) {
    throw new Error("successor account opening does not match the asset snapshot");
  }
  const configurationCommitment = assetCovenantSuccessorConfigurationCommitment({
    maxNativeOpenFeeAmount: params.maxNativeOpenFeeAmount,
    successorAddress: address,
    successorNullifierKeyCommitment: nkCommitment,
    successorRuleSetCommitment: ruleSetCommitment,
    successorAccountRevision: revision,
    successorReceiveKeyHash: receiveKeyHash,
  });
  let assetOutputCount = 0;
  const assetIds = params.outputs.map((opening, index) => {
    const slotClass = params.build.transaction.outputs[index]!.slotClass;
    const isReal = slotClass === SlotClass.ASSET || slotClass === SlotClass.NATIVE;
    if (isReal !== (opening !== null)) throw new Error(`covenant output ${index} coverage mismatch`);
    if (opening === null) return 0n;
    const outputAssetId = toField(opening.assetId, `outputs[${index}].assetId`);
    if (slotClass === SlotClass.ASSET) {
      if (outputAssetId === 0n) throw new Error(`covenant asset output ${index} requires nonzero assetId`);
      assertAssetAmount(opening.amount, `covenant asset output ${index} amount`);
      assetOutputCount += 1;
    } else {
      if (outputAssetId !== 0n) throw new Error(`covenant native output ${index} requires assetId zero`);
      if (opening.amount <= 0n || opening.amount >= (1n << BigInt(AMOUNT_BITS))) {
        throw new Error(`covenant native output ${index} amount must be in 1..2^${AMOUNT_BITS}-1`);
      }
    }
    const noteSecret = toField(opening.noteSecret, `outputs[${index}].noteSecret`);
    const expectedBody = noteBodyCommitment(
      ownerCommitment(address, noteSecret),
      outputAssetId,
      opening.amount,
    );
    if (expectedBody !== toField(params.build.transaction.outputs[index]!.outputBodyCommitment)) {
      throw new Error(`covenant output ${index} opening does not match the action`);
    }
    return outputAssetId;
  });
  if (assetOutputCount === 0) throw new Error("asset successor covenant requires an asset output");
  const amounts = params.outputs.map((opening) => opening?.amount ?? 0n);
  const secrets = params.outputs.map((opening) => opening === null ? 0n : toField(opening.noteSecret));
  const map: WitnessMap = {
    pcash_chain_id: fm(params.pcashChainId),
    recent_pcash_block_hash: fm(params.snapshot.recentPcashBlockHash),
    event_entry: fm(params.build.eventOpening.eventEntry),
    address: fm(params.build.address),
    private_value: privateValueMap(params.build.transaction),
    block_header_state_siblings: fieldArrayMap(params.snapshot.stateRootHeaderSiblings),
    state_account_siblings: fieldArrayMap(params.snapshot.accountStateRootStateSiblings),
    successor_address: fm(address),
    successor_nullifier_key_commitment: fm(nkCommitment),
    successor_rule_set_commitment: fm(ruleSetCommitment),
    successor_account_revision: fm(revision),
    successor_receive_key_hash: fm(receiveKeyHash),
    successor_account_witness: {
      leaf_index: fm(successor.accountIndex),
      siblings: fieldArrayMap(successor.accountSiblings),
    },
    max_native_open_fee_amount: fm(params.maxNativeOpenFeeAmount),
    output_asset_ids: fieldArrayMap(assetIds),
    output_amounts: fieldArrayMap(amounts),
    output_note_secrets: fieldArrayMap(secrets),
  };
  return { configurationCommitment, witnessMap: map };
}
