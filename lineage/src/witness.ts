import type { NativeTransferBuild } from "@pcash/sdk/builders";
import { fieldToHex as fm } from "@pcash/sdk/crypto";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { openBlockHeaderKey } from "@pcash/sdk/protocol";
import { l1LogGroundingWitnessMap } from "@pcash/sdk/protocol";
import { privateValueMap, type WitnessMap } from "@pcash/sdk/builders";
import type { EventApplication, PreparedEventApplication } from "@pcash/sdk/prover";
import type { L1LogProofResult } from "@pcash/sdk/clients";
import type { ResultProofRpc } from "@pcash/sdk/clients";
import { type LineagePolicy } from "./policy.ts";
import type { Handoff } from "./handoff.ts";

export interface LineageInput { commitment: bigint; proof: ResultProofRpc; handoff?: Handoff }
const zeros = (count: number) => Array<string>(count).fill(fm(0n));
export function emptyLineageInput(): WitnessMap {
  return {
    is_source: false,
    result_opening: { block_number: fm(0n), history_siblings: zeros(40), results_header_siblings: zeros(4), transaction_count: 0, payout_count: 0, result_index: 0, result_siblings: zeros(64) },
    payout: { output_index: fm(0n), owner_commitment: fm(0n), open_fee_amount: fm(0n), issuance_amount: fm(0n) },
    source_path: { index: 0, siblings: zeros(32) },
    transaction_result: { tx_type: fm(0n), funding_mode: fm(0n), l1_transaction_index: fm(0n), batch_item_index: fm(0n), outcome: fm(0n), poster_owner_commitment: fm(0n), output_start_index: fm(0n), statement_hash: fm(0n) },
    transaction_statement: zeros(PRIVATE_VALUE_PROFILES.S.publicInputs), output_slot: 0, event_salt: fm(0n), qualification_mask: fm(0n),
    deny_gap: { lower_present: false, lower: fm(0n), upper_present: false, upper: fm(0n), path: { index: 0, siblings: zeros(32) } },
  };
}

export function lineageInputWitness(input: LineageInput, policy: LineagePolicy): WitnessMap {
  const proof = input.proof, leaf = proof.leaf;
  const gap = policy.denyWitness(input.commitment);
  const source = leaf.kind === "payout";
  const path = source ? policy.sourceWitness(input.commitment) : undefined;
  const statementWords = leaf.kind === "transaction" ? leaf.statement?.words : undefined;
  if (!source && input.handoff === undefined) throw new Error("missing predecessor event opening");
  if (!source && statementWords === undefined) throw new Error("lineage predecessor has no successful statement");
  return {
    ...emptyLineageInput(), is_source: source,
    result_opening: {
      block_number: proof.block.boundary.header.number,
      history_siblings: proof.history?.historySiblings ?? zeros(40),
      results_header_siblings: proof.resultsRootSiblings,
      transaction_count: BigInt(proof.transactionCount).toString(), payout_count: BigInt(proof.payoutCount).toString(), result_index: BigInt(proof.leafIndex).toString(), result_siblings: proof.siblings,
    },
    ...(leaf.kind === "payout" ? {
      payout: { output_index: leaf.outputIndex, owner_commitment: leaf.ownerCommitment, open_fee_amount: leaf.openFeeAmount, issuance_amount: leaf.issuanceAmount },
      source_path: { index: path!.leafIndex, siblings: path!.siblings.map(fm) },
    } : {
      transaction_result: { tx_type: fm(BigInt(leaf.txType)), funding_mode: fm(BigInt(leaf.fundingMode)), l1_transaction_index: leaf.l1TransactionIndex, batch_item_index: leaf.batchItemIndex, outcome: fm(BigInt(leaf.outcome)), poster_owner_commitment: leaf.posterOwnerCommitment, output_start_index: leaf.outputStartIndex, statement_hash: leaf.statementHash },
      transaction_statement: statementWords!, output_slot: input.handoff!.outputSlot,
      event_salt: fm(input.handoff!.salt), qualification_mask: fm(BigInt(input.handoff!.qualificationMask)),
    }),
    deny_gap: { lower_present: gap.lowerPresent, lower: fm(gap.lower), upper_present: gap.upperPresent, upper: fm(gap.upper), path: { index: gap.leafIndex, siblings: gap.siblings.map(fm) } },
  };
}

/** Supplies the application witness for an event prepared before authorization. */
export function buildLineageWitness(params: {
  build: NativeTransferBuild; preparedEvent: PreparedEventApplication; policy: LineagePolicy; lineageVk: bigint; publication: L1LogProofResult;
  rootSequence: bigint; inputs: readonly (LineageInput | null)[];
}): EventApplication & { qualificationMask: number; handoff(outputSlot: number): Handoff } {
  const { build, policy, publication } = params;
  if (params.inputs.length !== 4) throw new Error("lineage requires four input slots");
  const qualificationMask = build.transaction.outputs.reduce((mask, output, slot) => output.slotClass === 1 ? mask | (1 << slot) : mask, 0);
  return {
    preparedEvent: params.preparedEvent, qualificationMask,
    witnessMap: {
      pcash_chain_id: fm(build.pcashChainId), recent_pcash_block_hash: fm(build.recentPcashBlockHash), private_value: privateValueMap(build.transaction),
      provider: fm(policy.provider), approved_sources_root: fm(policy.sourceTree.root), deny_gaps_root: fm(policy.gapTree.root), root_sequence: params.rootSequence.toString(),
      publication: l1LogGroundingWitnessMap({ ...publication, logsRoot: publication.l1LogsRoot, logCount: publication.l1LogCount }),
      lineage_vk_identity: fm(params.lineageVk), history_root: fm(publication.boundary.header.historyRoot),
      history_root_siblings: openBlockHeaderKey(publication.boundary.header, 6).siblings.map(fm),
      inputs: params.inputs.map(input => input === null ? emptyLineageInput() : lineageInputWitness(input, policy)),
    },
    handoff(outputSlot: number) { return { salt: build.eventOpening.eventSalt, qualificationMask, outputSlot }; },
  };
}
