import assert from "node:assert/strict";
import test from "node:test";
import { formatAssetDefinition } from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex } from "@pcash/sdk/utils";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { WalletBulkRecovery } from "@pcash/sdk/wallet";
import { dropTermsForCreator, eligibilityDrop, planDropInventory } from "../src/drop.ts";
import { claimLinkSetSecret, parseClaimLink, planClaimLinks } from "../src/link.ts";
import { dropInventory } from "../src/witness.ts";
import { recoverTokenRecords } from "../src/client/recovery.ts";
import { dropRecoveryTag, linkSetRecoveryTag } from "../src/client/recoveryTag.ts";
import { linkSetStatus, linkSetUrls } from "../src/client/links.ts";
import { MemoryTokensStore } from "../src/client/store.ts";
import type { TokensRuntime } from "../src/client/runtime.ts";
import { testToken } from "./wallets.ts";

const chainId = 8182n;
const creator = 0x1234n;
const nkRoot = 0x5678n;
const token = testToken(9n);
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;

function recovery(params: {
  recoveryJobId: string;
  appTag: Uint8Array;
  recipientCount?: number;
  originalIndexes?: number[];
  recipients: { recipientAddress: string; amount: bigint; noteSecret: bigint }[];
}): WalletBulkRecovery {
  const originalIndexes = params.originalIndexes ?? params.recipients.map((_, index) => index);
  return {
    recoveryJobId: params.recoveryJobId,
    appTag: params.appTag,
    manifestDigest: hash(0xd1),
    assetId: token.assetId,
    recipientCount: params.recipientCount ?? params.recipients.length,
    paidOriginalIndexes: [...originalIndexes],
    chunks: [{
      contentHash: hash(0xc1), shape: 0,
      recipients: params.recipients.map((recipient, position) => ({
        originalIndex: originalIndexes[position]!, recipientAddress: recipient.recipientAddress,
        amount: recipient.amount, noteSecret: bytes32Hex(recipient.noteSecret),
      })),
      inclusion: { blockNumber: 5n, blockHash: hash(0xb1), blockTimestamp: 1_700_000_000n },
    }],
    known: false,
    observedAtTimestamp: 1_700_000_000n,
    observedThroughTimestamp: 1_700_001_800n,
    resumeAfterTimestamp: 1_700_001_800n,
  };
}

function runtime(current: { recoveries: WalletBulkRecovery[] }) {
  const store = new MemoryTokensStore();
  const wallet = {
    address: addressHex(creator), network: { chainId },
    assets: async () => [{ assetId: token.assetId, definition: token.definition }],
    bulkRecoveries: async () => structuredClone(current.recoveries),
    execute: async (action: (context: unknown) => unknown) => action({ profile: { nkRoot }, submission: {} }),
  };
  const node = {
    getReceipt: async () => [{ outcome: "succeeded", outputLeafStart: 100n }],
    getCurrentNullifierStatuses: async (nullifiers: readonly string[]) => ({
      statuses: nullifiers.map(nullifier => ({ nullifier, spent: false })),
    }),
  };
  return { store, rt: { wallet, store, node } as unknown as TokensRuntime };
}

test("rebuilds a funded link set from canonical sender records and removes it after a reorg", async () => {
  const nonce = 0x99n;
  const amounts = [2n, 3n, 4n];
  const indexes = [3, 4, 5];
  const plan = planClaimLinks({ creatorSecret: claimLinkSetSecret(nkRoot, nonce), assetId: token.assetId, amounts, indexes });
  const recovered = recovery({
    recoveryJobId: hash(1), appTag: linkSetRecoveryTag(nonce),
    recipientCount: 6, originalIndexes: indexes,
    recipients: plan.links.map(link => ({ recipientAddress: addressHex(plan.contract.address), amount: link.amount, noteSecret: link.noteSecret })),
  });
  recovered.observedThroughTimestamp = recovered.resumeAfterTimestamp! + 1n;
  const current = { recoveries: [recovered] };
  const { rt, store } = runtime(current);
  await recoverTokenRecords(rt);
  const [record] = await store.list();
  assert.equal(record?.kind, "links");
  assert.deepEqual(record === undefined ? undefined : {
    nonce: record.kind === "links" ? record.nonce : undefined,
    amounts: record.kind === "links" ? record.amounts : undefined,
    definition: record.definition, funding: record.funding,
    recoveryJobId: record.recoveryJobId, createdAt: record.createdAt,
  }, {
    nonce: bytes32Hex(nonce), amounts: amounts.map(String), definition: formatAssetDefinition(token.definition),
    funding: [{ contentHash: hash(0xc1), firstIndex: 3, count: 3 }], recoveryJobId: hash(1), createdAt: 1_700_000_000_000,
  });
  const urls = await linkSetUrls(rt, record!.key, "https://pcash.example/claim");
  assert.deepEqual(urls.map(url => {
    const link = parseClaimLink(url);
    return { slot: link.funding.slot, linkKey: link.linkKey };
  }), plan.links.map((link, slot) => ({ slot, linkKey: link.linkKey })));
  assert.deepEqual((await linkSetStatus(rt, record!.key)).claims?.map(claim => claim.index), indexes);
  current.recoveries = [];
  await recoverTokenRecords(rt);
  assert.deepEqual(await store.list(), []);
});

test("rebuilds funded drop inventory from its compact recovery terms", async () => {
  const terms = {
    dropSeed: 0x77n,
    claimAmount: 5n,
    count: 6,
    cutoffBlockNumber: 42n,
    claimEndTimestamp: 1_800_000_000n,
  };
  const drop = eligibilityDrop(dropTermsForCreator({
    ...terms, assetId: token.assetId, creator: { address: creator, nkRoot },
  }));
  const indexes = [3, 4, 5];
  const inventory = planDropInventory(drop, indexes);
  const recovered = recovery({
    recoveryJobId: hash(2), appTag: dropRecoveryTag(terms),
    recipientCount: terms.count, originalIndexes: indexes,
    recipients: inventory.map(note => ({ recipientAddress: addressHex(drop.address), amount: terms.claimAmount, noteSecret: note.noteSecret })),
  });
  recovered.observedThroughTimestamp = recovered.resumeAfterTimestamp! + 1n;
  const current = { recoveries: [recovered] };
  const { rt, store } = runtime(current);
  await recoverTokenRecords(rt);
  const [record] = await store.list();
  assert.equal(record?.kind, "drop");
  assert.deepEqual(record === undefined ? undefined : {
    dropSeed: record.kind === "drop" ? record.dropSeed : undefined,
    claimAmount: record.kind === "drop" ? record.claimAmount : undefined,
    count: record.kind === "drop" ? record.count : undefined,
    cutoffBlockNumber: record.kind === "drop" ? record.cutoffBlockNumber : undefined,
    claimEndTimestamp: record.kind === "drop" ? record.claimEndTimestamp : undefined,
    funding: record.funding, recoveryJobId: record.recoveryJobId,
  }, {
    dropSeed: bytes32Hex(terms.dropSeed), claimAmount: "5", count: 3,
    cutoffBlockNumber: "42", claimEndTimestamp: "1800000000",
    funding: [{ contentHash: hash(0xc1), firstIndex: 3, count: 3 }], recoveryJobId: hash(2),
  });
  const notes = await dropInventory({
    getReceipt: async () => [{ outcome: "succeeded", outputLeafStart: 100n }],
  } as unknown as PcashNodeClient, drop, record!.funding!);
  assert.deepEqual(notes.map(note => ({ index: note.index, noteSecret: note.noteSecret })),
    inventory.map(note => ({ index: note.index, noteSecret: note.noteSecret })));
  await store.update(record!.key, currentRecord => ({ ...currentRecord!, publicationContentId: hash(0xca) }));
  await recoverTokenRecords(rt);
  const [refreshed] = await store.list();
  assert.equal(refreshed?.kind === "drop" ? refreshed.publicationContentId : undefined, hash(0xca));
});

test("does not finalize a partial token recovery until possible in-flight chunks expire", async () => {
  const nonce = 0x88n;
  const amounts = [7n, 8n];
  const plan = planClaimLinks({ creatorSecret: claimLinkSetSecret(nkRoot, nonce), assetId: token.assetId, amounts });
  const partial = recovery({
    recoveryJobId: hash(3), appTag: linkSetRecoveryTag(nonce),
    recipients: plan.links.map(link => ({ recipientAddress: addressHex(plan.contract.address), amount: link.amount, noteSecret: link.noteSecret })),
  });
  partial.recipientCount = 3;
  partial.resumeAfterTimestamp = partial.observedThroughTimestamp;
  const current = { recoveries: [partial] };
  const { rt, store } = runtime(current);
  await recoverTokenRecords(rt);
  assert.deepEqual(await store.list(), []);
  partial.observedThroughTimestamp = partial.resumeAfterTimestamp! + 1n;
  await recoverTokenRecords(rt);
  const [record] = await store.list();
  assert.equal(record?.kind, "links");
  assert.deepEqual(record?.kind === "links" ? record.amounts : undefined, amounts.map(String));
});

test("preserves gaps between independently landed link funding chunks", async () => {
  const nonce = 0x66n;
  const indexes = [0, 1, 2, 6, 7];
  const amounts = [10n, 11n, 12n, 16n, 17n];
  const plan = planClaimLinks({ creatorSecret: claimLinkSetSecret(nkRoot, nonce), assetId: token.assetId, amounts, indexes });
  const recovered = recovery({
    recoveryJobId: hash(4), appTag: linkSetRecoveryTag(nonce), recipientCount: 8, originalIndexes: indexes,
    recipients: plan.links.map(link => ({ recipientAddress: addressHex(plan.contract.address), amount: link.amount, noteSecret: link.noteSecret })),
  });
  const recipients = recovered.chunks[0]!.recipients;
  recovered.chunks = [
    { ...recovered.chunks[0]!, contentHash: hash(0xc1), recipients: recipients.slice(0, 3) },
    { ...recovered.chunks[0]!, contentHash: hash(0xc2), recipients: recipients.slice(3) },
  ];
  recovered.observedThroughTimestamp = recovered.resumeAfterTimestamp! + 1n;
  const { rt, store } = runtime({ recoveries: [recovered] });
  await recoverTokenRecords(rt);
  const [record] = await store.list();
  assert.deepEqual(record?.funding, [
    { contentHash: hash(0xc1), firstIndex: 0, count: 3 },
    { contentHash: hash(0xc2), firstIndex: 6, count: 2 },
  ]);
  assert.deepEqual(record?.kind === "links" ? record.amounts : undefined, amounts.map(String));
  const urls = await linkSetUrls(rt, record!.key, "https://pcash.example/claim");
  assert.deepEqual(urls.map(url => parseClaimLink(url).linkKey), plan.links.map(link => link.linkKey));
  assert.deepEqual((await linkSetStatus(rt, record!.key)).claims?.map(claim => claim.index), indexes);
});

test("recovery cleanup leaves other wallets and chains in the shared token store", async () => {
  const { rt, store } = runtime({ recoveries: [] });
  const recoveredLink = (key: string, owner: string, recordChainId: bigint, recoveryJobId: string) => ({
    kind: "links" as const, key, chainId: recordChainId.toString(), creator: owner, assetId: token.assetId.toString(),
    definition: formatAssetDefinition(token.definition), nonce: bytes32Hex(BigInt(recoveryJobId)), amounts: ["1"],
    funding: [{ contentHash: hash(0xc1), firstIndex: 0, count: 1 }], recoveryJobId, createdAt: 1, updatedAt: 1,
  });
  const current = recoveredLink("current", addressHex(creator), chainId, "1");
  const foreignOwner = recoveredLink("foreign-owner", addressHex(creator + 1n), chainId, "2");
  const foreignChain = recoveredLink("foreign-chain", addressHex(creator), chainId + 1n, "3");
  await store.update(current.key, () => current);
  await store.update(foreignOwner.key, () => foreignOwner);
  await store.update(foreignChain.key, () => foreignChain);
  await recoverTokenRecords(rt);
  assert.deepEqual((await store.list()).map(record => record.key).sort(), [foreignChain.key, foreignOwner.key].sort());
});
