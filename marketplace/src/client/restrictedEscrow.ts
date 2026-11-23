// A token escrow of an asset with a transfer rule. The escrow contract owns
// the asset inputs, so the rule's statement names the contract, never the
// claimant or a fee sponsor: freezing the escrow stops both its sale and its
// reclaim. A release's deadline is its own, so it is lowered to what the rule's
// publication authorizes. The listing names its asset publicly, so the
// publication's opening is fetched when the release is built.

import type { AssetActionBuild } from "@pcash/sdk/builders";
import { CIRCUIT_URLS } from "@pcash/sdk/browser-prover";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { AssetDefinition, CurrentBoundaryEnvelope } from "@pcash/sdk/protocol";
import type { DenyLists } from "@pcash/sdk/wallet";
import { planRestrictedTransfer, type RestrictedTransferPlan } from "@pcash/sdk/wallet/actions";

export interface EscrowRestriction {
  plan: RestrictedTransferPlan;
  /** The rule's proving step over the finished release. */
  policy(build: AssetActionBuild, role: "transfer" | "sponsored"): { circuitUrl: string; witnessMap: Record<string, unknown>; label: string };
}

/** The restriction a release of `escrow` carries, or undefined for an asset without a transfer rule. */
export async function escrowRestriction(params: {
  definition: AssetDefinition | null;
  denyLists: DenyLists | undefined;
  node: PcashNodeClient;
  escrow: bigint;
  anchor: CurrentBoundaryEnvelope;
  genesisL1Block: bigint;
  validUntilTimestamp: bigint;
}): Promise<EscrowRestriction | undefined> {
  if (params.definition === null) return undefined;
  const plan = await planRestrictedTransfer({
    definition: params.definition,
    denyLists: params.denyLists,
    node: params.node,
    ownerAddress: params.escrow,
    anchor: {
      blockHash: BigInt(params.anchor.blockHash), number: BigInt(params.anchor.header.number),
      timestamp: BigInt(params.anchor.header.timestamp),
    },
    genesisL1Block: params.genesisL1Block,
    chainNow: BigInt(params.anchor.header.timestamp),
    validUntilTimestamp: params.validUntilTimestamp,
    validUntilMode: "ceiling",
  });
  if (plan === undefined) return undefined;
  return {
    plan,
    policy(build, role) {
      const step = plan.policy(build, params.escrow, role);
      const circuitUrl = (CIRCUIT_URLS as Readonly<Record<string, string>>)[step.packageName];
      if (circuitUrl === undefined) throw new Error("this transfer rule has no browser circuit");
      return { circuitUrl, witnessMap: step.witnessMap, label: "transfer rule" };
    },
  };
}
