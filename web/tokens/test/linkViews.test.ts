import assert from "node:assert/strict";
import test from "node:test";
import { formatAssetDefinition } from "@pcash/sdk/protocol";
import { addressHex } from "@pcash/sdk/utils";
import type { TokensRuntime } from "../src/client/runtime.ts";
import { MemoryTokensStore, type LinkSetRecord } from "../src/client/store.ts";
import { linkSets, linkSetStatus } from "../src/client/links.ts";
import { claimLinkSetSecret, planClaimLinks } from "../src/link.ts";
import { testToken } from "./wallets.ts";

const NK_ROOT = 19n;
const NONCE = 0x1234n;
const creator = addressHex(17n);
const token = testToken(3n);
const amounts = Array.from({ length: 24 }, (_, index) => BigInt(index + 1));
const hash = (index: number) => `0x${index.toString(16).padStart(64, "0")}`;

async function runtime(funded: boolean) {
  const store = new MemoryTokensStore();
  const record: LinkSetRecord = {
    kind: "links", key: "set", chainId: "1", creator, nonce: `0x${NONCE.toString(16)}`, assetId: token.assetId.toString(),
    definition: formatAssetDefinition(token.definition), amounts: amounts.map(String), createdAt: 1, updatedAt: 1,
    ...(funded ? { funding: Array.from({ length: amounts.length / 4 }, (_, index) => ({ contentHash: hash(index + 1), firstIndex: index * 4, count: 4 })) } : {}),
  };
  await store.update(record.key, () => record);
  const nullifierReads: (readonly string[])[] = [];
  const node = {
    getReceipt: async ({ contentHash }: { contentHash: string }) =>
      [{ outcome: "succeeded", outputLeafStart: 10n * BigInt(contentHash), transactionId: hash(Number(BigInt(contentHash)) + 0x1000), contentHash }],
    getCurrentNullifierStatuses: async (nullifiers: readonly string[]) => {
      nullifierReads.push(nullifiers);
      return { statuses: nullifiers.map(() => ({ spent: false })) };
    },
  };
  const wallet = {
    network: { chainId: 1n }, address: creator,
    assets: async () => [], bulkRecoveries: async () => [],
    execute: async (action: (context: unknown) => unknown) => action({ profile: { nkRoot: NK_ROOT }, submission: {} }),
  };
  const rt = { store, node, wallet, prover: {}, pollIntervalMs: 0, pollMaxAttempts: 1, now: () => 0 } as unknown as TokensRuntime;
  return { rt, record, nullifierReads };
}

const plannedAddress = addressHex(planClaimLinks({
  creatorSecret: claimLinkSetSecret(NK_ROOT, NONCE),
  assetId: token.assetId,
  amounts,
}).contract.address);

test("listed link sets carry the contract that full link planning builds", async () => {
  const { rt, record } = await runtime(false);
  const sets = await linkSets(rt);
  assert.equal(sets.length, 1);
  assert.equal(sets[0]!.contractAddress, plannedAddress);
  assert.equal(sets[0]!.phase, "creating-contract");
  assert.deepEqual(sets[0]!.links, record.amounts.map((amount, index) => ({ index, amount: BigInt(amount) })));
});

test("an unfunded set's status has no claims", async () => {
  const { rt, nullifierReads } = await runtime(false);
  const status = await linkSetStatus(rt, "set");
  assert.equal(status.contractAddress, plannedAddress);
  assert.equal(status.claims, null);
  assert.equal(nullifierReads.length, 0);
});

test("a funded set's status reads every link's nullifier in one request", async () => {
  const { rt, record, nullifierReads } = await runtime(true);
  const status = await linkSetStatus(rt, record.key);
  assert.equal(status.contractAddress, plannedAddress);
  assert.equal(status.phase, "ready");
  assert.deepEqual(status.claims, record.amounts.map((amount, index) => ({ index, amount: BigInt(amount), state: "unclaimed" })));
  assert.equal(nullifierReads.length, 1);
  assert.equal(nullifierReads[0]!.length, record.amounts.length);
});
