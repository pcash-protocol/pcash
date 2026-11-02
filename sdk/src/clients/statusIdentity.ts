// Network identity comparators shared by wallet hosts, submission adapters,
// and the SDK relay stack. Every check is exact: a node on another chain, a
// forked genesis, or a moved L1 anchor must fail loudly instead of being
// silently absorbed into a session opened against different consensus.

import type { StatusResult } from "./nodeClient.ts";
import { isAddressEqual, type Address } from "viem";
import { sameHex } from "../utils/hex.ts";

/** A PCASH network as a stored binding names it. */
export interface PcashIdentity {
  chainId: bigint | number | string;
  genesisHash: string;
}

/** The PCASH network a node status reports. */
export function statusPcashIdentity(status: StatusResult): PcashIdentity {
  return { chainId: status.pcashChainId, genesisHash: status.genesisHash };
}

/** Same PCASH network: chain id and genesis hash. */
export function samePcashIdentity(left: PcashIdentity, right: PcashIdentity): boolean {
  return BigInt(left.chainId) === BigInt(right.chainId)
    && sameHex(left.genesisHash, right.genesisHash);
}

/** Same L1 deployment: chain id, inbox contract, and genesis anchor. */
export function sameL1Identity(left: StatusResult, right: StatusResult): boolean {
  return BigInt(left.l1ChainId) === BigInt(right.l1ChainId)
    && isAddressEqual(left.inboxAddress as Address, right.inboxAddress as Address)
    && left.genesisL1Block === right.genesisL1Block
    && sameHex(left.genesisL1BlockHash, right.genesisL1BlockHash);
}

/**
 * Reject a node whose PCASH chain id differs from the configured one. The
 * expectation is mandatory: a build that never configured a chain id must fail
 * loudly rather than silently accept whatever node it is pointed at.
 * Configuration parsing stays with the host; this asserts the parsed value.
 */
export function assertExpectedNetwork(
  status: StatusResult,
  expectedChainId: bigint | string | undefined,
): void {
  if (expectedChainId === undefined || expectedChainId === "") {
    throw new Error("This build has no configured PCASH chain id; set PCASH_CHAIN_ID and rebuild.");
  }
  if (BigInt(expectedChainId) !== BigInt(status.pcashChainId)) {
    throw new Error(
      `The configured node reported PCASH chain ${status.pcashChainId}, expected ${BigInt(expectedChainId)}.`,
    );
  }
}
