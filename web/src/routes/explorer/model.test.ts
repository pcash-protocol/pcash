import { describe, expect, it } from "vitest";
import {
  contractBlockHash,
  contractBlockNumber,
  contractBadge,
  contractFunctionSetCommitment,
  contractReceiveKeyPublished,
  implementationSourceState,
  nodeSyncState,
  reproductionCommand,
  selectorHex,
} from "./model.ts";
import type { ContractSourceView } from "./types.ts";

function view(status: ContractSourceView["verificationStatus"]): ContractSourceView {
  return {
    address: "0x1111111111111111111111111111111111111111",
    verificationStatus: status,
    contract: {
      status: "contract",
      address: "0x1111111111111111111111111111111111111111",
      accountProof: {
        status: "present",
        account: {
          address: "0x1111111111111111111111111111111111111111",
          index: 0n,
          accountRevision: 1n,
          accountKind: 1,
          nullifierKeyCommitment: `0x${"22".repeat(32)}`,
          accountRuleSetCommitment: `0x${"33".repeat(32)}`,
          receiveKeyHash: `0x${"00".repeat(32)}`,
          material: { status: "notPresent" },
        },
        accountStateRoot: BigInt(`0x${"44".repeat(32)}`),
        accountSiblings: [],
        accountCount: 1n,
        stateRootHeaderSiblings: [],
        accountStateRootStateSiblings: [],
        boundary: {
          state: {
            outputRoot: 0n,
            outputCount: 0n,
            issuedSoFar: 0n,
            lagQ: 0n,
            accountStateRoot: BigInt(`0x${"44".repeat(32)}`),
            accountCount: 1n,
            nullifierRoot: 0n,
            nullifierCount: 0n,
          },
          header: {
            parentHash: 0n,
            number: 1n,
            timestamp: 1n,
            transactionResultsRoot: 0n,
            stateRoot: BigInt(`0x${"66".repeat(32)}`),
            l1OriginRoot: BigInt(`0x${"77".repeat(32)}`),
            historyRoot: BigInt(`0x${"78".repeat(32)}`),
          },
          blockHash: BigInt(`0x${"88".repeat(32)}`),
        },
      },
      publishesNkRoot: true,
      nkRoot: null,
      functions: [],
      transaction: "0x",
      origin: {
        l1BlockNumber: 1n,
        l1BlockHash: `0x${"99".repeat(32)}`,
        l1TransactionIndex: 0n,
        batchItemIndex: 0n,
      },
    },
    implementations: [],
    configurationOpenings: [],
    presentation: null,
  };
}

describe("Explorer contract view model", () => {
  it("reports node sync against the observed Ethereum head", () => {
    expect(nodeSyncState(100n, null)).toEqual({ kind: "checking" });
    expect(nodeSyncState(100n, 100n)).toEqual({ kind: "caughtUp", blocksBehind: 0n });
    expect(nodeSyncState(100n, 102n)).toEqual({ kind: "caughtUp", blocksBehind: 2n });
    expect(nodeSyncState(100n, 103n)).toEqual({ kind: "behind", blocksBehind: 3n });
    expect(nodeSyncState(103n, 102n)).toEqual({ kind: "caughtUp", blocksBehind: 0n });
  });

  it("keeps verification binary at the contract boundary", () => {
    expect(contractBadge(view("verified"))).toBe("Contract Source Code Verified");
    expect(contractBadge(view("not_verified"))).toBe("Contract Source Code Not Verified");
  });

  it("derives contract display facts from the authenticated proof envelope", () => {
    const contract = view("verified");
    expect(contractBlockNumber(contract)).toBe(1n);
    expect(contractBlockHash(contract)).toBe(`0x${"88".repeat(32)}`);
    expect(contractFunctionSetCommitment(contract)).toBe(`0x${"33".repeat(32)}`);
    expect(contractReceiveKeyPublished(contract)).toBe(false);
  });

  it("renders selectors deterministically", () => {
    expect(selectorHex(0)).toBe("0x00");
    expect(selectorHex(255)).toBe("0xff");
  });

  it("publishes the repository reproduction entry point", () => {
    expect(reproductionCommand()).toContain("source:reproduce");
  });

  it("distinguishes implementation source loading from terminal absence", () => {
    const hash = `0x${"22".repeat(32)}`;
    expect(implementationSourceState("not_verified", hash, new Map(), false)).toBe("unverified");
    expect(implementationSourceState("verified", hash, new Map(), true)).toBe("loading");
    expect(implementationSourceState("verified", hash, new Map([[hash, null]]), false)).toBe("unavailable");
    expect(implementationSourceState("verified", hash, new Map([[hash, {}]]), false)).toBe("available");
  });
});
