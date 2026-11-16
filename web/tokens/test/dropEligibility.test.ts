import assert from "node:assert/strict";
import test from "node:test";
import type { TokensRuntime } from "../src/client/runtime.ts";
import { dropEligibility, type AvailableDrop } from "../src/client/drops.ts";
import { eligibilityDrop, dropTermsForCreator } from "../src/drop.ts";
import { testToken } from "./wallets.ts";

const token = testToken(2n);
const drop = {
  drop: eligibilityDrop(dropTermsForCreator({
    dropSeed: 17n, assetId: token.assetId, claimAmount: 5n,
    cutoffBlockNumber: 7n, claimEndTimestamp: 500n,
    creator: { address: 19n, nkRoot: 23n },
  })),
  definition: token.definition,
} as AvailableDrop;
const WALLET_ADDRESS = "0x0000000000000000000000000000000000000011";

function runtime(time: bigint, spent: boolean) {
  const reads = { markers: 0, walletSecrets: 0, accounts: [] as string[] };
  const node = {
    status: async () => ({ latestBlockTimestamp: time }),
    getCurrentNullifierStatuses: async () => { reads.markers++; return { statuses: [{ spent }] }; },
    getAccountProof: async (address: string) => { reads.accounts.push(address); return { status: "absent" }; },
  };
  const wallet = {
    address: WALLET_ADDRESS,
    execute: async (action: (context: unknown) => unknown) => {
      reads.walletSecrets++;
      return action({ profile: { nkRoot: 29n }, submission: {} });
    },
  };
  return { rt: { node, wallet } as unknown as TokensRuntime, reads };
}

test("an ended drop is reported before reading this wallet's claim marker", async () => {
  const { rt, reads } = runtime(500n, true);
  assert.equal((await dropEligibility(rt, drop)).status, "ended");
  assert.equal(reads.markers, 0);
  assert.equal(reads.walletSecrets, 0);
});

test("this wallet's marker reports its own claim; otherwise the public account check decides", async () => {
  const claimed = runtime(499n, true);
  assert.equal((await dropEligibility(claimed.rt, drop)).status, "claimed");
  assert.deepEqual(claimed.reads.accounts, []);
  const available = runtime(499n, false);
  assert.equal((await dropEligibility(available.rt, drop)).status, "no-account");
  assert.deepEqual(available.reads.accounts, [WALLET_ADDRESS]);
});

test("an explicit address is checked without loading this wallet's secret or marker", async () => {
  const { rt, reads } = runtime(499n, false);
  assert.equal((await dropEligibility(rt, drop, "0x0000000000000000000000000000000000000022")).status, "no-account");
  assert.equal(reads.markers, 0);
  assert.equal(reads.walletSecrets, 0);
});
