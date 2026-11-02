import { describe, expect, it } from "vitest";
import { snapshotFromAccountProof } from "../src/builders/index.ts";
import { snapshotWitnessMap } from "../src/builders/witnessMaps.ts";
import type { AccountProofResult } from "../src/clients/index.ts";
import { syntheticRecentBlockFixture } from "@pcash/test-support/protocol-fixtures";

describe("snapshotFromAccountProof", () => {
  it("takes every root and path from the proof's one boundary", () => {
    const recent = syntheticRecentBlockFixture({
      outputRoot: 0x1234n, outputCount: 3, accountStateRoot: 0x5678n, accountCount: 2,
    });
    const proof = {
      status: "present",
      account: {},
      accountStateRoot: 0x5678n,
      accountSiblings: [],
      accountCount: 2n,
      stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
      accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
      boundary: recent.boundary,
    } as unknown as Extract<AccountProofResult, { status: "present" }>;
    const snapshot = snapshotFromAccountProof(proof);
    expect(snapshot).toEqual({
      recentPcashBlockHash: recent.recentPcashBlockHash,
      stateRoot: recent.stateRoot,
      stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
      outputRoot: 0x1234n,
      outputRootStateSiblings: recent.outputRootStateSiblings,
      accountStateRoot: 0x5678n,
      accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
    });
    expect(() => snapshotWitnessMap(snapshot)).not.toThrow();
  });
});
