// One `pcash_status` shape for the whole suite.
//
// Seven test files each built a StatusResult by hand, and the
// `forkCapability` block inside it was identical in all of them: nothing
// varies except the chain id, the genesis hash, and the head timestamp, all of
// which are already stated elsewhere in the same object. Restating it per file
// meant a field added to the RPC shape had to be added in seven places.
//
// Pass only what the test is actually about; everything else gets a coherent
// default derived from it.

import type { StatusResult } from "../src/clients/nodeClient.ts";

const ZERO_WORD = `0x${"00".repeat(32)}`;

/** The fork capability, which no test varies independently. */
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

/**
 * A complete, internally consistent status response.
 *
 * `overrides` wins over every default, and the fork capability is
 * rebuilt from the resulting chain id, genesis hash, and head timestamp unless
 * the caller supplies its own.
 */
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
    totalSucceeded: null,
    totalFailed: null,
    totalTransactions: null,
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

/**
 * The same capability in its raw JSON-RPC form, for tests that exercise
 * decoding rather than consuming an already-decoded status.
 */
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
