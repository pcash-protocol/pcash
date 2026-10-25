// One `pcash_status` shape for the wallet suite.

import type { StatusResult } from "@pcash/sdk/clients";

const ZERO_WORD = `0x${"00".repeat(32)}`;

export function testForkCapability(
  chainId: bigint,
  genesisHash: string,
  headTimestamp: bigint,
  prefixHash: string = ZERO_WORD,
): StatusResult["forkCapability"] {
  return {
    chainId,
    genesisHash,
    headTimestamp,
    currentForkCount: 0n,
    currentPrefixHash: prefixHash,
    nextActivationTimestamp: 0n,
    nextPrefixHash: prefixHash,
  };
}

export function testStatus(overrides: Partial<StatusResult> = {}): StatusResult {
  const latestBlock = overrides.latestBlock ?? 0n;
  const latestBlockHash = overrides.latestBlockHash ?? ZERO_WORD;
  const latestBlockTimestamp = overrides.latestBlockTimestamp ?? 0n;
  const pcashChainId = overrides.pcashChainId ?? 1;
  const genesisHash = overrides.genesisHash ?? latestBlockHash;

  const base: StatusResult = {
    latestBlock,
    latestBlockHash,
    latestBlockTimestamp,
    finalizedBlock: latestBlock,
    finalizedBlockHash: latestBlockHash,
    finalizedBlockTimestamp: latestBlockTimestamp,
    latestL1BlockNumber: latestBlock,
    latestL1BlockHash: latestBlockHash,
    observedL1BlockNumber: latestBlock,
    derivation: { state: "following", sinceUnixMs: 0n },
    finalizedL1BlockNumber: latestBlock,
    finalizedL1BlockHash: latestBlockHash,
    stateRoot: latestBlockHash,
    l1OriginRoot: latestBlockHash,
    historyRoot: latestBlockHash,
    outputCount: 0n,
    issuedSoFar: 0n,
    supplyCap: 1_000_000_000n * 10n ** 18n,
    totalSucceeded: 0n,
    totalFailed: 0n,
    totalTransactions: 0n,
    index: { status: "ready", cursor: { blockNumber: latestBlock, blockHash: latestBlockHash } },
    proverAssets: null,
    pcashChainId,
    genesisHash,
    acceptedTransactionTypes: [0],
    acceptedBatchVersions: [1],
    l1ChainId: 1n,
    inboxAddress: `0x${"00".repeat(19)}01`,
    genesisL1Block: 0n,
    genesisL1BlockHash: latestBlockHash,
    forkCapability: testForkCapability(BigInt(pcashChainId), genesisHash, latestBlockTimestamp),
  };

  const merged = { ...base, ...overrides };
  return overrides.forkCapability === undefined
    ? {
        ...merged,
        forkCapability: testForkCapability(
          BigInt(merged.pcashChainId),
          merged.genesisHash,
          merged.latestBlockTimestamp,
        ),
      }
    : merged;
}

export function testForkCapabilityDto(
  chainIdHex: string,
  genesisHash: string,
  headTimestampHex: string,
  prefixHash: string,
): Record<string, unknown> {
  return {
    chainId: chainIdHex,
    genesisHash,
    headTimestamp: headTimestampHex,
    currentForkCount: "0x0",
    currentPrefixHash: prefixHash,
    nextActivationTimestamp: "0x0",
    nextPrefixHash: prefixHash,
  };
}
