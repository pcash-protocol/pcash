// Transfer rules a wallet recognizes. A rule is standard only when its complete
// ordered VK pair and its configuration opening match a standard rule; any
// other rule is custom, even when one of its keys is familiar.

import { SENDER_DENY_LIST_RULE_VK_HASH } from "../constants/rulePins.ts";
import { toAddressField } from "../crypto/field.ts";
import type { PortableTransferRule } from "../protocol/assetDefinition.ts";
import { beBytes, bytesToBigInt, concatBytes } from "../utils/bytes.ts";
import { denyListConfigurationCommitment, type DenyListConfiguration } from "./senderDenyList.ts";

export type RecognizedTransferRule =
  | { kind: "sender-deny-list"; configuration: DenyListConfiguration }
  | { kind: "custom" };

/**
 * The standard deny list's configuration opening: the contract address (20
 * bytes), the list ID (32 bytes), and the maximum delta (8 bytes).
 */
export function encodeDenyListConfiguration(configuration: DenyListConfiguration): Uint8Array {
  if (configuration.listId.length !== 32) throw new Error("listId must contain 32 bytes");
  return concatBytes(beBytes(toAddressField(configuration.contractAddress, "contractAddress"), 20), configuration.listId,
    beBytes(configuration.maxDelta, 8));
}

/** The transfer rule of an asset whose senders the standard deny list screens. */
export function senderDenyListTransferRule(configuration: DenyListConfiguration): PortableTransferRule {
  return {
    sVkHash: SENDER_DENY_LIST_RULE_VK_HASH,
    lVkHash: SENDER_DENY_LIST_RULE_VK_HASH,
    configurationCommitment: denyListConfigurationCommitment(configuration),
    configuration: encodeDenyListConfiguration(configuration),
  };
}

export function recognizeTransferRule(rule: PortableTransferRule): RecognizedTransferRule {
  if (rule.sVkHash === SENDER_DENY_LIST_RULE_VK_HASH && rule.lVkHash === SENDER_DENY_LIST_RULE_VK_HASH
    && rule.configuration.length === 60) {
    const configuration = {
      contractAddress: bytesToBigInt(rule.configuration.subarray(0, 20)),
      listId: Uint8Array.from(rule.configuration.subarray(20, 52)),
      maxDelta: bytesToBigInt(rule.configuration.subarray(52)),
    };
    if (configuration.maxDelta !== 0n && denyListConfigurationCommitment(configuration) === rule.configurationCommitment) {
      return { kind: "sender-deny-list", configuration };
    }
  }
  return { kind: "custom" };
}
