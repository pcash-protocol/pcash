import {
  scanWallet,
  type PayoutSourceKind,
  type SystemPayoutResult,
  type PcashNodeClient,
  type ReceiptResult,
  type WalletProfileWithReceiveKeys,
} from "../deps.ts";
import { eventually } from "../framework/eventually.ts";

export interface SettledSystemPayout {
  receipt: ReceiptResult;
  /**
   * The block's payout notes at the receipt's destination. A poster's notes
   * also carry its other open-route actions in that block.
   */
  payouts: SystemPayoutResult[];
}

/**
 * Where a receipt's settlement pays: its issuance destination, or, for a kind
 * that cannot earn issuance, the poster of its batch, who collects every open fee.
 */
async function payoutDestination(node: PcashNodeClient, receipt: ReceiptResult): Promise<bigint | null> {
  if (receipt.issuanceOwnerCommitment !== null) return BigInt(receipt.issuanceOwnerCommitment);
  if (receipt.settledOpenFeeAmount === 0n) return null;
  const batch = await node.getInboxDeliveryBatch(receipt.inclusion.l1TransactionHash);
  if (batch?.posterOwnerCommitment == null) {
    throw new Error(`${receipt.transactionId} settled an open fee from a batch with no poster commitment`);
  }
  return BigInt(batch.posterOwnerCommitment);
}

/** One accepted action's settled fee and issuance, and the payout notes at its destination. */
export async function settledSystemPayout(node: PcashNodeClient, contentHash: string): Promise<SettledSystemPayout> {
  const receipt = (await node.getReceipt({ contentHash })).find((candidate) => candidate.outcome === "succeeded");
  if (receipt === undefined) throw new Error(`${contentHash} has no successful canonical receipt`);
  const destination = await payoutDestination(node, receipt);
  if (destination === null) return { receipt, payouts: [] };
  const transaction = await eventually(
    `indexed transaction ${receipt.transactionId}`,
    () => node.getTransaction(receipt.transactionId),
    (value) => value !== null,
    { timeoutMs: 60_000 },
  );
  const block = await eventually(
    `indexed block payouts for ${receipt.transactionId}`,
    () => node.getBlockPayouts(transaction!.summary.block),
    (value) => value !== null,
    { timeoutMs: 60_000 },
  );
  return { receipt, payouts: block!.payouts.filter((payout) => payout.ownerCommitment === destination) };
}

/**
 * Assert that one accepted action paid its open fee and issuance through `sourceKind` to
 * `recipient`, and that `recipient` recovers every payout note at that
 * destination from its seed and the node alone.
 */
export async function assertSystemPayoutRecovered(params: {
  node: PcashNodeClient;
  chainId: bigint;
  contentHash: string;
  label: string;
  sourceKind: PayoutSourceKind;
  recipient: WalletProfileWithReceiveKeys;
}): Promise<SettledSystemPayout> {
  const settled = await settledSystemPayout(params.node, params.contentHash);
  const { receipt, payouts } = settled;
  if (receipt.settledOpenFeeAmount + receipt.settledIssuanceAmount === 0n) {
    throw new Error(`${params.label}: settled no fee or issuance`);
  }
  if (payouts.length === 0) throw new Error(`${params.label}: no system payout note at its destination`);
  const kinds = [...new Set(payouts.map((payout) => payout.source.kind))];
  if (kinds.length !== 1 || kinds[0] !== params.sourceKind) {
    throw new Error(`${params.label}: paid as ${kinds.join(", ")}, expected ${params.sourceKind}`);
  }
  const fees = payouts.reduce((total, payout) => total + (payout.component === "openFee" ? payout.amount : 0n), 0n);
  const issuance = payouts.reduce((total, payout) => total + (payout.component === "issuance" ? payout.amount : 0n), 0n);
  const exact = params.sourceKind === "designatedIssuance";
  if (exact
    ? fees !== receipt.settledOpenFeeAmount || issuance !== receipt.settledIssuanceAmount
    : fees < receipt.settledOpenFeeAmount || issuance < receipt.settledIssuanceAmount) {
    throw new Error(`${params.label}: payout notes carry fee ${fees} and issuance ${issuance}, receipt settled ${receipt.settledOpenFeeAmount} and ${receipt.settledIssuanceAmount}`);
  }
  const recovered = new Set((await scanWallet(params.node, params.recipient, params.chainId)).recovered
    .map((note) => note.leafIndex));
  if (payouts.some((payout) => !recovered.has(payout.outputIndex))) {
    throw new Error(`${params.label}: the paid wallet did not recover its system payout notes from its seed`);
  }
  return settled;
}
