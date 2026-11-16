import type { MempoolItemResult, PcashNodeClient } from "@pcash/sdk/clients";
import { controlledIssuanceOpening } from "@pcash/sdk/protocol";
import { bytes32Hex, fromHex } from "@pcash/sdk/utils";

type IssuanceOffer = Pick<MempoolItemResult, "issuanceRoute" | "issuanceOwnerCommitment">;

/**
 * Whether this relayer collects a transaction's issuance: an open route pays the
 * poster whose inclusion succeeds, a designated route only a commitment this
 * wallet controls.
 */
export function controlsIssuance(item: IssuanceOffer, controlled: ReadonlySet<bigint>): boolean {
  if (item.issuanceRoute === "open") return true;
  if (item.issuanceRoute !== "designated") return false;
  const commitment = BigInt(item.issuanceOwnerCommitment);
  return controlled.has(commitment);
}

/**
 * The designated commitments among `items` that this wallet's seed opens. Each
 * transaction is read at its own shape, so every profile's nullifier range counts.
 */
export async function discoverControlledCommitments(
  node: Pick<PcashNodeClient, "getMempoolTransaction">,
  items: readonly MempoolItemResult[],
  profile: { address: bigint; nkRoot: bigint } | undefined,
  chainId: number,
): Promise<string[]> {
  if (profile === undefined) return [];
  const owned = new Set<string>();
  const designated = items.filter((item) => item.issuanceRoute === "designated");
  for (let offset = 0; offset < designated.length; offset += 8) {
    await Promise.allSettled(designated.slice(offset, offset + 8).map(async (item) => {
      const raw = item.rawTransaction ?? (await node.getMempoolTransaction(item.contentHash))?.rawTransaction;
      if (raw == null) return;
      const opening = controlledIssuanceOpening(fromHex(raw), chainId, profile);
      if (opening !== null) owned.add(bytes32Hex(opening.ownerCommitment));
    }));
  }
  return [...owned].sort();
}
