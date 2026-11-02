import { describe, expect, it } from "vitest";
import type { StatusResult } from "../src/clients/index.ts";
import {
  assertExpectedNetwork,
  sameL1Identity,
  samePcashIdentity,
  statusPcashIdentity,
} from "../src/clients/statusIdentity.ts";
import { NETWORKS } from "../src/constants/networkProfile.ts";
import { networkConfigFromStatus } from "../src/protocol/network.ts";

function status(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    latestBlock: 10n,
    latestBlockHash: `0x${"aa".repeat(32)}`,
    latestBlockTimestamp: 0n,
    finalizedBlock: 9n,
    finalizedBlockHash: `0x${"aa".repeat(32)}`,
    finalizedBlockTimestamp: 0n,
    latestL1BlockNumber: 5n,
    latestL1BlockHash: `0x${"bb".repeat(32)}`,
    finalizedL1BlockNumber: 4n,
    finalizedL1BlockHash: `0x${"bb".repeat(32)}`,
    stateRoot: `0x${"cc".repeat(32)}`,
    l1OriginRoot: `0x${"dd".repeat(32)}`,
    historyRoot: `0x${"ee".repeat(32)}`,
    issuedSoFar: 0n,
    supplyCap: 1_000_000_000n * 10n ** 18n,
    index: { status: "ready", cursor: null },
    pcashChainId: 8191,
    genesisHash: `0x${"11".repeat(32)}`,
    acceptedTransactionTypes: [0],
    acceptedBatchVersions: [1],
    l1ChainId: 11_155_111n,
    inboxAddress: `0x${"22".repeat(20)}`,
    genesisL1Block: 3n,
    genesisL1BlockHash: `0x${"33".repeat(32)}`,
    forkCapability: {
      chainId: 8191n,
      genesisHash: `0x${"11".repeat(32)}`,
      headTimestamp: 0n,
      currentForkCount: 0n,
      currentPrefixHash: `0x${"00".repeat(32)}`,
      nextActivationTimestamp: 0n,
      nextPrefixHash: `0x${"00".repeat(32)}`,
    },
    ...overrides,
  } as StatusResult;
}

describe("statusPcashIdentity", () => {
  it("reads the PCASH chain id and genesis hash", () => {
    expect(statusPcashIdentity(status())).toEqual({ chainId: 8191, genesisHash: `0x${"11".repeat(32)}` });
  });
});

describe("samePcashIdentity", () => {
  const identity = (overrides: Partial<StatusResult> = {}) => statusPcashIdentity(status(overrides));

  it("accepts identical networks regardless of hash case", () => {
    const upperGenesis = `0x${"11".repeat(32)}`.toUpperCase();
    expect(samePcashIdentity(identity(), identity({ genesisHash: upperGenesis }))).toBe(true);
  });

  it("compares chain ids numerically", () => {
    expect(samePcashIdentity(identity(), { chainId: 8191n, genesisHash: `0x${"11".repeat(32)}` })).toBe(true);
    expect(samePcashIdentity(identity(), { chainId: "8191", genesisHash: `0x${"11".repeat(32)}` })).toBe(true);
    expect(samePcashIdentity(identity(), identity({ pcashChainId: 8192 }))).toBe(false);
  });

  it("rejects a different genesis", () => {
    expect(samePcashIdentity(identity(), identity({ genesisHash: `0x${"44".repeat(32)}` }))).toBe(false);
  });
});

describe("sameL1Identity", () => {
  it("accepts the same deployment", () => {
    expect(sameL1Identity(status(), status())).toBe(true);
  });

  it.each([
    ["chain id", { l1ChainId: 1n }],
    ["inbox address", { inboxAddress: `0x${"55".repeat(20)}` }],
    ["genesis block number", { genesisL1Block: 4n }],
    ["genesis block hash", { genesisL1BlockHash: `0x${"66".repeat(32)}` }],
  ])("rejects a changed %s", (_label, overrides) => {
    expect(sameL1Identity(status(), status(overrides as Partial<StatusResult>))).toBe(false);
  });
});

describe("assertExpectedNetwork", () => {
  it("accepts a matching chain id in either representation", () => {
    expect(() => assertExpectedNetwork(status(), 8191n)).not.toThrow();
    expect(() => assertExpectedNetwork(status(), "8191")).not.toThrow();
  });

  it("refuses to skip the check when no chain id was configured", () => {
    expect(() => assertExpectedNetwork(status(), undefined))
      .toThrow("This build has no configured PCASH chain id; set PCASH_CHAIN_ID and rebuild.");
    expect(() => assertExpectedNetwork(status(), "")).toThrow(/no configured PCASH chain id/);
  });

  it("reports a chain mismatch with the configured value", () => {
    expect(() => assertExpectedNetwork(status(), "8192"))
      .toThrow("The configured node reported PCASH chain 8191, expected 8192.");
  });
});

describe("networkConfigFromStatus", () => {
  const testnet = { pcashChainId: NETWORKS.testnet.pcashChainId, l1ChainId: NETWORKS.testnet.l1ChainId };
  const compiledInbox = `0x${NETWORKS.testnet.inboxAddress.toString(16).padStart(40, "0")}`;
  const otherInbox = `0x${"22".repeat(20)}`;

  it("refuses an inbox other than the one a compiled PCASH chain id names", () => {
    expect(() => networkConfigFromStatus({ ...testnet, inboxAddress: otherInbox })).toThrow(/whose inbox is/);
    expect(networkConfigFromStatus({ ...testnet, inboxAddress: compiledInbox }).inboxAddress)
      .toBe(NETWORKS.testnet.inboxAddress);
  });

  it("leaves the L1 chain id of a compiled PCASH chain id and every value of other chain ids to the node", () => {
    expect(networkConfigFromStatus({ ...testnet, l1ChainId: 31_337n, inboxAddress: compiledInbox }).l1ChainId).toBe(31_337n);
    expect(networkConfigFromStatus({ pcashChainId: 8191, l1ChainId: 31_337n, inboxAddress: otherInbox }).inboxAddress)
      .toBe(BigInt(otherInbox));
  });
});
