// What a transfer of an asset with a transfer rule needs beyond an ordinary
// asset action: the rule's recognition, the owner's standing in the issuer's
// deny list, and the newest publication the proof's anchor holds with its
// opening under that anchor. The wallet keeps its ordinary deadline and
// declines rather than shorten it to fit a publication, so restricted
// transfers carry no unusual deadline.

import type { AssetActionBuild } from "@pcash/sdk/builders";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import {
  assetDefinitionDescriptor,
  restrictedAssetOpening,
  sponsoredTransferActionCommitment,
  transferActionCommitment,
  RECENT_PCASH_BLOCK_WINDOW_SECONDS,
  type AssetDefinition,
  type RestrictedAssetOpening,
} from "@pcash/sdk/protocol";
import { recognizeTransferRule, senderDenyListWitness, type DenyListConfiguration } from "@pcash/sdk/rules";
import type { DenyLists } from "../denyListSync.ts";

export const SENDER_DENY_LIST_PACKAGE = "transfer_rule_sender_deny_list";

export class RestrictedTransferUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestrictedTransferUnavailable";
  }
}

export interface RestrictedTransferPlan {
  restricted: RestrictedAssetOpening;
  /** The deadline: the requested one, or under a ceiling the latest the publication authorizes. */
  validUntilTimestamp: bigint;
  /** The transfer rule's witness for `build`, whose asset inputs `ownerAddress` owns. */
  policy(build: AssetActionBuild, ownerAddress: bigint, role: "transfer" | "sponsored"): { packageName: string; witnessMap: Record<string, unknown> };
}

/** The opening a restricted transfer needs, or undefined for an asset without a transfer rule. */
export async function planRestrictedTransfer(params: {
  definition: AssetDefinition;
  denyLists: DenyLists | undefined;
  /**
   * Fetch the publication's opening from this node now. Only for an action
   * whose asset is already public, such as a Marketplace escrow; a wallet
   * omits it and uses the opening its last sync fetched for `anchor`.
   */
  node?: PcashNodeClient;
  /** The account whose asset inputs move. */
  ownerAddress: bigint;
  anchor: { blockHash: bigint; number: bigint; timestamp: bigint };
  genesisL1Block: bigint;
  /** The chain time the deadline was chosen from, and the deadline. */
  chainNow: bigint;
  validUntilTimestamp: bigint;
  /**
   * "exact", the default, keeps the wallet's ordinary deadline and declines
   * when the publication does not authorize it; "ceiling" lowers the deadline
   * to what the publication authorizes, for actions whose deadline is already
   * their own, such as a marketplace claim.
   */
  validUntilMode?: "exact" | "ceiling";
}): Promise<RestrictedTransferPlan | undefined> {
  const { definition } = params;
  if (definition.transferRule === undefined) return undefined;
  const restricted = restrictedAssetOpening(assetDefinitionDescriptor(definition))!;
  const rule = recognizeTransferRule(definition.transferRule);
  if (rule.kind !== "sender-deny-list") {
    throw new RestrictedTransferUnavailable("this wallet does not support the asset's transfer rule");
  }
  if (params.denyLists === undefined) {
    throw new RestrictedTransferUnavailable("sending this asset needs an Ethereum connection to read its deny list");
  }
  const configuration: DenyListConfiguration = rule.configuration;
  // Without `node` the anchor is the one the wallet's last sync reached, which
  // must stay in the recent-block window for the whole transaction lifetime.
  if (params.node === undefined && params.validUntilTimestamp > params.anchor.timestamp + RECENT_PCASH_BLOCK_WINDOW_SECONDS) {
    throw new RestrictedTransferUnavailable("the wallet's last sync is too old to send this asset; sync and try again");
  }
  const anchored = params.node === undefined
    ? await params.denyLists.prefetched(configuration, params.anchor.blockHash)
    : await params.denyLists.anchored(params.node, configuration, params.anchor, params.genesisL1Block);
  if (anchored === undefined) {
    throw new RestrictedTransferUnavailable("the wallet has not read the asset's deny list at its current block; sync and try again");
  }
  if (anchored === null) throw new RestrictedTransferUnavailable("the asset's deny list has no publication yet");
  const { entry, tree, opening } = anchored;
  if (tree.isDenied(params.ownerAddress)) {
    throw new RestrictedTransferUnavailable("the issuer has frozen this account for this asset");
  }
  if (entry.publication.paused) throw new RestrictedTransferUnavailable("the issuer has paused transfers of this asset");
  if (entry.publication.delta > configuration.maxDelta) {
    throw new RestrictedTransferUnavailable("the deny list's publication window exceeds the asset's maximum; waiting for the issuer to correct it");
  }
  const authorizedUntil = BigInt(opening.l1BlockTimestamp) + entry.publication.delta;
  const validUntilTimestamp = params.validUntilMode === "ceiling" && params.validUntilTimestamp > authorizedUntil
    ? authorizedUntil : params.validUntilTimestamp;
  if (validUntilTimestamp <= params.chainNow) {
    throw new RestrictedTransferUnavailable("waiting for the deny list's next publication; try again after its next heartbeat");
  }
  if (validUntilTimestamp > authorizedUntil) {
    // Even a publication made now would not authorize this deadline.
    throw new RestrictedTransferUnavailable(entry.publication.delta < params.validUntilTimestamp - params.chainNow
      ? "the deny list's publication window is shorter than this wallet's transaction lifetime"
      : "waiting for the deny list's next publication; try again after its next heartbeat");
  }
  return {
    restricted,
    validUntilTimestamp,
    policy(build, ownerAddress, role) {
      return {
        packageName: SENDER_DENY_LIST_PACKAGE,
        witnessMap: senderDenyListWitness({
          assetId: build.assetId,
          ownerAddress,
          validUntilTimestamp: BigInt(build.transaction.global.validUntilTimestamp),
          configuration,
          publicationLog: entry.log,
          publicationOpening: opening,
          gap: tree.gapOpening(ownerAddress),
          actionCommitment: role === "transfer"
            ? transferActionCommitment(build.pcashChainId, build.privateValueCommitment)
            : sponsoredTransferActionCommitment(build.pcashChainId, build.privateValueCommitment),
          recentPcashBlockHash: build.recentPcashBlockHash,
          eventEntry: build.eventOpening.eventEntry,
        }),
      };
    },
  };
}
