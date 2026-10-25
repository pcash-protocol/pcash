import { formatAssetDefinition } from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex, sameHex } from "@pcash/sdk/utils";
import { walletAction, type WalletBulkRecovery } from "@pcash/sdk/wallet";
import { eligibilityDrop, dropTermsForCreator, planDropInventory } from "../drop.ts";
import { claimLinkSetSecret, planClaimLinks } from "../link.ts";
import type { FundingChunk } from "../witness.ts";
import { dropKey, linkSetKey, type DropRecord, type LinkSetRecord, type TokensRecord } from "./store.ts";
import { parseTokenRecoveryTag } from "./recoveryTag.ts";
import type { TokensRuntime } from "./runtime.ts";

interface OrderedRecovery {
  recipients: WalletBulkRecovery["chunks"][number]["recipients"];
  funding: FundingChunk[];
  createdAt: number;
}

function orderedRecovery(recovery: WalletBulkRecovery): OrderedRecovery | null {
  const chunks = [...recovery.chunks].sort((left, right) =>
    left.recipients[0]!.originalIndex - right.recipients[0]!.originalIndex);
  if (chunks.some(chunk => chunk.recipients.length === 0
    || chunk.recipients.some((recipient, slot) => recipient.originalIndex !== chunk.recipients[0]!.originalIndex + slot))) return null;
  const recipients = chunks.flatMap((chunk) => chunk.recipients);
  if (recipients.length === 0 || recipients.length !== recovery.paidOriginalIndexes.length
    || new Set(recipients.map(recipient => recipient.originalIndex)).size !== recipients.length
    || recipients.some((recipient, position) => recipient.originalIndex !== recovery.paidOriginalIndexes[position])) return null;
  return {
    recipients,
    funding: chunks.map((chunk) => ({ contentHash: chunk.contentHash,
      firstIndex: chunk.recipients[0]!.originalIndex, count: chunk.recipients.length })),
    createdAt: Number(chunks[0]!.inclusion.blockTimestamp * 1_000n),
  };
}

function recoveredLinkRecord(
  recovery: WalletBulkRecovery,
  ordered: OrderedRecovery,
  definition: Parameters<typeof formatAssetDefinition>[0],
  creator: string,
  chainId: bigint,
  nkRoot: bigint,
  nonce: bigint,
): LinkSetRecord | null {
  const amounts = ordered.recipients.map((recipient) => recipient.amount);
  const plan = planClaimLinks({ creatorSecret: claimLinkSetSecret(nkRoot, nonce), assetId: recovery.assetId, amounts,
    indexes: ordered.recipients.map(recipient => recipient.originalIndex) });
  const contract = addressHex(plan.contract.address);
  if (ordered.recipients.some((recipient, index) =>
    !sameHex(recipient.recipientAddress, contract)
    || BigInt(recipient.noteSecret) !== plan.links[index]!.noteSecret)) return null;
  const nonceHex = bytes32Hex(nonce);
  const key = linkSetKey(chainId, creator, nonceHex);
  return {
    kind: "links", key, chainId: chainId.toString(), creator, assetId: recovery.assetId.toString(),
    definition: formatAssetDefinition(definition), nonce: nonceHex, amounts: amounts.map(String),
    funding: ordered.funding, recoveryJobId: recovery.recoveryJobId,
    createdAt: ordered.createdAt, updatedAt: ordered.createdAt,
  };
}

function recoveredDropRecord(
  recovery: WalletBulkRecovery,
  ordered: OrderedRecovery,
  definition: Parameters<typeof formatAssetDefinition>[0],
  creator: string,
  chainId: bigint,
  nkRoot: bigint,
  tag: Extract<ReturnType<typeof parseTokenRecoveryTag>, { kind: "drop" }>,
): DropRecord | null {
  if (ordered.recipients.length > tag.count) return null;
  const drop = eligibilityDrop(dropTermsForCreator({
    dropSeed: tag.dropSeed,
    assetId: recovery.assetId,
    claimAmount: tag.claimAmount,
    cutoffBlockNumber: tag.cutoffBlockNumber,
    claimEndTimestamp: tag.claimEndTimestamp,
    creator: { address: BigInt(creator), nkRoot },
  }));
  const inventory = planDropInventory(drop, ordered.recipients.map(recipient => recipient.originalIndex));
  const contract = addressHex(drop.address);
  if (ordered.recipients.some((recipient, index) =>
    !sameHex(recipient.recipientAddress, contract)
    || recipient.amount !== tag.claimAmount
    || BigInt(recipient.noteSecret) !== inventory[index]!.noteSecret)) return null;
  const dropSeed = bytes32Hex(tag.dropSeed);
  const key = dropKey(chainId, creator, dropSeed);
  return {
    kind: "drop", key, chainId: chainId.toString(), creator, assetId: recovery.assetId.toString(),
    definition: formatAssetDefinition(definition), dropSeed, claimAmount: tag.claimAmount.toString(),
    count: ordered.recipients.length, cutoffBlockNumber: tag.cutoffBlockNumber.toString(),
    claimEndTimestamp: tag.claimEndTimestamp.toString(), funding: ordered.funding,
    recoveryJobId: recovery.recoveryJobId, createdAt: ordered.createdAt, updatedAt: ordered.createdAt,
  };
}

/** Reconcile creator records from canonical sender recovery entries after wallet synchronization. */
export async function recoverTokenRecords<Prepared, Output>(rt: TokensRuntime<Prepared, Output>): Promise<void> {
  const [recoveries, assets, nkRoot] = await Promise.all([
    rt.wallet.bulkRecoveries(),
    rt.wallet.assets(),
    rt.wallet.execute(walletAction("tokens:recover-records", context => context.profile.nkRoot)),
  ]);
  const creator = rt.wallet.address.toLowerCase();
  const chainId = rt.wallet.network.chainId;
  const inScope = (record: TokensRecord) => sameHex(record.creator, creator) && BigInt(record.chainId) === chainId;
  const definitions = new Map(assets.flatMap(asset => asset.definition === null ? [] : [[asset.assetId, asset.definition] as const]));
  const desired = new Map<string, TokensRecord>();
  for (const recovery of recoveries) {
    const complete = recovery.paidOriginalIndexes.length === recovery.recipientCount;
    const observationSafe = recovery.observedThroughTimestamp !== null && recovery.resumeAfterTimestamp !== null
      && recovery.observedThroughTimestamp > recovery.resumeAfterTimestamp;
    if (!complete && (recovery.known || !observationSafe)) continue;
    const definition = definitions.get(recovery.assetId);
    const ordered = orderedRecovery(recovery);
    if (definition === undefined || ordered === null) continue;
    let tag;
    try { tag = parseTokenRecoveryTag(recovery.appTag); } catch { continue; }
    const record = tag.kind === "links"
      ? recoveredLinkRecord(recovery, ordered, definition, rt.wallet.address, rt.wallet.network.chainId, nkRoot, tag.nonce)
      : recoveredDropRecord(recovery, ordered, definition, rt.wallet.address, rt.wallet.network.chainId, nkRoot, tag);
    if (record !== null) desired.set(recovery.recoveryJobId, record);
  }
  for (const record of await rt.store.list()) {
    if (record.recoveryJobId === undefined || !inScope(record) || desired.has(record.recoveryJobId)) continue;
    await rt.store.update(record.key, current => current !== null
      && current.recoveryJobId === record.recoveryJobId && inScope(current) ? null : current);
  }
  for (const record of desired.values()) {
    await rt.store.update(record.key, current => {
      if (current !== null && current.recoveryJobId === undefined) return current;
      if (current?.kind === "drop" && record.kind === "drop"
        && current.publicationContentId !== undefined
        && JSON.stringify(current.funding) === JSON.stringify(record.funding)) {
        return { ...record, publicationContentId: current.publicationContentId };
      }
      return record;
    });
  }
}
