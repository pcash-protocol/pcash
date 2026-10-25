import { applicationSchemaId } from "../../src/protocol/records.ts";
import { orderedRecords } from "../recordHelpers.ts";
// Note discovery & recovery. Decryption alone is NOT
// acceptance: an output is spendable only if kind/outputIndex/owner match AND
// the commitment recomputed from the payload equals the actual tree leaf. Also
// exercises the full builder -> envelope -> scan cross-wallet path.

import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { testForkCapability, testStatus } from "./statusFixture.ts";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { buildNativeTransfer } from "@pcash/sdk/builders";
import { addressHex, randomFieldEntropy, toHex } from "@pcash/sdk/utils";
import {
  assetDefinitionSchema,
  RECORD_SCHEMA,
  claimedSenderSchema,
  sentEnvelopesSchema,
  assetDefinitionAssetId,
  buildArena,
  encodePayload,
  encryptEnvelope,
  generateMlKemKeyPair,
  sealEnvelope,
  sizeClassFiller,
  type AssetDefinition,
  noteBodyCommitment,
  outputCommitment,
  noteNk,
  nullifier,
  ownerCommitment,
} from "@pcash/sdk/protocol";
import type {
  BlockResult,
  PcashNodeClient,
  StatusResult,
} from "@pcash/sdk/clients";
import {
  addPendingNote,
  storedAssetDefinition,
  type WalletFileData,
} from "../../src/wallet/noteStore.ts";
import { type ScanFeedItem, scanFeed, scanWallet, synchronizeWalletInventory } from "../../src/wallet/actions/scan.ts";
import { retainReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { withSyntheticTransferOpenings } from "./builderTestHelpers.ts";
import { requireReceiveKeys } from "../../src/wallet/wallet.ts";
import { TEST_NK_ROOT, TEST_PRIV_KEY, deriveTestWallet } from "./testWallet.ts";
import { syncWallet } from "../../src/wallet/actions/syncWallet.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";
import { ChainSim, type SimNote } from "./chainFixture.ts";
import { deliveredTransaction } from "./arenaFixture.ts";

const chainId = 0x1ff6n;

const randomWallet = () => ({
  ...requireReceiveKeys(deriveTestWallet({
    privKey: new Uint8Array(randomBytes(32)),
    nkRoot: randomFieldEntropy(),
    mlKem: generateMlKemKeyPair(),
  })),
  outgoingKey: new Uint8Array(randomBytes(32)),
});

describe("scanFeed acceptance", () => {
  const alice = randomWallet();
  const amount = 4200n;
  const noteSecret = 0xc0ffee00n;
  const leafIndex = 3n;

  // The real tree leaf for a note Alice owns.
  const body = noteBodyCommitment(ownerCommitment(alice.address, noteSecret), 0n, amount);
  const leaf = outputCommitment(body, leafIndex);

  const envToAlice = encryptEnvelope(
    alice.mlKemPublicKey!,
    encodePayload({ chainId, amount, owner: alice.address, noteSecret, outputIndex: 0 }),
  );

  it("recovers a note whose commitment matches the tree leaf", async () => {
    const feed: ScanFeedItem[] = [{ outputData: envToAlice, kind: 0, shape: 0, outputIndex: 0, leafIndex, outputCommitment: leaf }];
    const report = await scanFeed({
      chainId,
      mlKemSecretKeys: [alice.mlKemSecretKey!],
      owners: [alice.address],
      feed,
    });
    expect(report.recovered).toHaveLength(1);
    const note = report.recovered[0]!;
    expect(note.amount).toBe(amount);
    expect(note.leafIndex).toBe(leafIndex);
    expect(note.owner).toBe(alice.address);
    expect(note.outputCommitment).toBe(leaf);
  });

  it("trial-decrypts with old and new retained keys without duplicate recovery", async () => {
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(0x52));
    const rotatedSecret = 0xc0ffee01n;
    const rotatedIndex = 4n;
    const rotatedBody = noteBodyCommitment(ownerCommitment(alice.address, rotatedSecret), 0n, amount + 1n);
    const rotatedLeaf = outputCommitment(rotatedBody, rotatedIndex);
    const rotatedEnvelope = encryptEnvelope(
      rotated.publicKey,
      encodePayload({
        chainId,
        amount: amount + 1n,
        owner: alice.address,
        noteSecret: rotatedSecret,
        outputIndex: 0,
      }),
    );
    const report = await scanFeed({
      chainId,
      mlKemSecretKeys: [alice.mlKemSecretKey!, rotated.secretKey, alice.mlKemSecretKey!],
      owners: [alice.address],
      feed: [
        { outputData: envToAlice, kind: 0, shape: 0, outputIndex: 0, leafIndex, outputCommitment: leaf },
        { outputData: rotatedEnvelope, kind: 0, shape: 0, outputIndex: 0, leafIndex: rotatedIndex, outputCommitment: rotatedLeaf },
      ],
    });
    expect(report.recovered.map((note) => note.noteSecret)).toEqual([noteSecret, rotatedSecret]);
    expect(report.trialDecryptAttempts).toBe(3);
  });

  it("rejects a foreign envelope (encrypted to a different wallet) as a non-match", async () => {
    const bob = randomWallet();
    const envToBob = encryptEnvelope(
      bob.mlKemPublicKey!,
      encodePayload({ chainId, amount, owner: bob.address, noteSecret, outputIndex: 0 }),
    );
    const report = await scanFeed({
      chainId,
      mlKemSecretKeys: [alice.mlKemSecretKey!],
      owners: [alice.address],
      feed: [{ outputData: envToBob, kind: 0, shape: 0, outputIndex: 0, leafIndex, outputCommitment: leaf }],
    });
    expect(report.trialDecryptAttempts).toBe(1);
    expect(report.decrypted).toBe(0); // never even decrypts for Alice
    expect(report.recovered).toHaveLength(0);
  });

  it("decryption alone is NOT acceptance: a mismatched leaf index is rejected", async () => {
    // Alice CAN decrypt, but the feed claims the wrong leaf index, so the
    // recomputed commitment is not a member of the tree at that index.
    const report = await scanFeed({
      chainId,
      mlKemSecretKeys: [alice.mlKemSecretKey!],
      owners: [alice.address],
      feed: [{ outputData: envToAlice, kind: 0, shape: 0, outputIndex: 0, leafIndex: 7n, outputCommitment: leaf }],
    });
    expect(report.decrypted).toBe(1); // decrypted + decoded
    expect(report.recovered).toHaveLength(0); // but not accepted
  });

  it("recovers change from a fee-bearing account action like a transfer output", async () => {
    const report = await scanFeed({
      chainId,
      mlKemSecretKeys: [alice.mlKemSecretKey!],
      owners: [alice.address],
      feed: [{ outputData: envToAlice, kind: 3, shape: null, outputIndex: 0, leafIndex, outputCommitment: leaf }], // user-account update
    });
    expect(report.decrypted).toBe(1);
    expect(report.recovered).toHaveLength(1);
  });

  it("rejects a decrypted output whose owner is not a local address", async () => {
    const foreignOwner = randomWallet().address;
    // The leaf opens to the foreign owner, so only the owner check rejects it.
    const foreignLeaf = outputCommitment(noteBodyCommitment(ownerCommitment(foreignOwner, noteSecret), 0n, amount), leafIndex);
    const env = encryptEnvelope(
      alice.mlKemPublicKey!,
      encodePayload({ chainId, amount, owner: foreignOwner, noteSecret, outputIndex: 0 }),
    );
    const report = await scanFeed({
      chainId,
      mlKemSecretKeys: [alice.mlKemSecretKey!],
      owners: [alice.address],
      feed: [{ outputData: env, kind: 0, shape: 0, outputIndex: 0, leafIndex, outputCommitment: foreignLeaf }],
    });
    expect(report.decrypted).toBe(1);
    expect(report.recovered).toHaveLength(0);
  });

  it("recovers a note whose secret is zero", async () => {
    const zeroLeaf = outputCommitment(noteBodyCommitment(ownerCommitment(alice.address, 0n), 0n, amount), leafIndex);
    const env = encryptEnvelope(
      alice.mlKemPublicKey!,
      encodePayload({ chainId, amount, owner: alice.address, noteSecret: 0n, outputIndex: 0 }),
    );
    const report = await scanFeed({
      chainId,
      mlKemSecretKeys: [alice.mlKemSecretKey!],
      owners: [alice.address],
      feed: [{ outputData: env, kind: 0, shape: 0, outputIndex: 0, leafIndex, outputCommitment: zeroLeaf }],
    });
    expect(report.recovered.map((note) => note.noteSecret)).toEqual([0n]);
  });
});

describe("builder -> envelope -> scan, cross-wallet", () => {
  it("restores slot 31 of an L airdrop and spends that ordinary note through S", async () => {
    const recipient = deriveTestWallet({ privKey: TEST_PRIV_KEY, nkRoot: TEST_NK_ROOT, mlKem: "deterministic" });
    const sender = randomWallet();
    const build = buildNativeTransfer(withSyntheticTransferOpenings({
      shape: 1, chainId, wallet: sender,
      recipientAddress: recipient.address,
      recipientReceiveKey: recipient.mlKemPublicKey!,
      additionalOutputs: Array.from({ length: 31 }, () => ({
        address: recipient.address, amount: 30n, receiveKey: recipient.mlKemPublicKey!,
      })),
      inputAmount: 1000n, paymentAmount: 69n, openFeeAmount: 1n, issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 1n, validUntilTimestamp: 9_999_999n, noteSecret: 123n,
    }));
    const restored = deriveTestWallet({ privKey: TEST_PRIV_KEY, nkRoot: TEST_NK_ROOT, mlKem: "deterministic" });
    const leafIndex = 131n;
    const leaf = outputCommitment(build.transaction.outputs[31]!.outputBodyCommitment, leafIndex);
    const report = await scanFeed({
      chainId, mlKemSecretKeys: [restored.mlKemSecretKey!], owners: [restored.address],
      feed: [{ kind: 0, shape: 1, outputIndex: 31, leafIndex, outputCommitment: leaf, outputData: build.outputData[31]! }],
    });
    expect(report.recovered).toHaveLength(1);
    const note = report.recovered[0]!;
    expect(note.amount).toBe(30n);
    const spend = buildNativeTransfer(withSyntheticTransferOpenings({
      shape: 0, chainId, wallet: restored, recipientAddress: sender.address,
      recipientReceiveKey: sender.mlKemPublicKey!, inputAmount: note.amount, paymentAmount: 29n,
      openFeeAmount: 1n, issuanceOwnerCommitment: 0n, noteSecret: note.noteSecret, outputIndex: Number(note.leafIndex),
      dummyInputEntropy: 2n, validUntilTimestamp: 9_999_999n,
    }));
    expect(spend.shape).toBe(0);
    expect(spend.transaction.inputs[0]!.nullifier).toBe(nullifier(leaf, noteNk(restored.nkRoot), note.noteSecret));
    expect(spend.publicInputs).toHaveLength(PRIVATE_VALUE_PROFILES.S.publicInputs);
  });
  it("recipient recovers output 0; sender recovers its own change; neither sees the other's", async () => {
    // Bob (sender, signs) pays Alice (recipient). Change goes back to Bob.
    const bob = deriveTestWallet({ privKey: TEST_PRIV_KEY, nkRoot: TEST_NK_ROOT, mlKem: generateMlKemKeyPair() });
    const alice = randomWallet();

    const leaf0Index = 10n;
    const build = buildNativeTransfer(withSyntheticTransferOpenings({
      chainId,
      wallet: bob,
      selfReceiveKey: bob.mlKemPublicKey!,
      recipientAddress: alice.address,
      recipientReceiveKey: alice.mlKemPublicKey!,
      inputAmount: 1000n,
      paymentAmount: 600n,
      openFeeAmount: 0n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 1n,
      validUntilTimestamp: 9_999_999n,
      noteSecret: 0xabcn,
    }));

    // Place the two output commitments at consecutive indices.
    const body0 = build.scenario.body0!;
    const body1 = build.scenario.body1!;
    const leaf0 = outputCommitment(body0, leaf0Index);
    const leaf1 = outputCommitment(body1, leaf0Index + 1n);

    const feed: ScanFeedItem[] = [
      { outputData: build.outputData[0]!, kind: 0, shape: 0, outputIndex: 0, leafIndex: leaf0Index, outputCommitment: leaf0 },
      { outputData: build.outputData[1]!, kind: 0, shape: 0, outputIndex: 1, leafIndex: leaf0Index + 1n, outputCommitment: leaf1 },
    ];

    // Alice recovers exactly the 600 payment.
    const aliceReport = await scanFeed({
      chainId,
      mlKemSecretKeys: [alice.mlKemSecretKey!],
      owners: [alice.address],
      feed,
    });
    expect(aliceReport.recovered).toHaveLength(1);
    expect(aliceReport.recovered[0]!.amount).toBe(600n);
    expect(aliceReport.recovered[0]!.outputIndex).toBe(0);

    // Bob recovers exactly the 400 change.
    const bobReport = await scanFeed({
      chainId,
      mlKemSecretKeys: [bob.mlKemSecretKey!],
      owners: [bob.address],
      feed,
    });
    expect(bobReport.recovered).toHaveLength(1);
    expect(bobReport.recovered[0]!.amount).toBe(400n);
    expect(bobReport.recovered[0]!.outputIndex).toBe(1);
  });
});

const word = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
const genesisHash = word(0xfeedn);

function block(number: bigint, hash: bigint, parentHash: bigint): BlockResult {
  return {
    number,
    hash: word(hash),
    parentHash: word(parentHash),
    timestamp: 1_800_000_000n + number,
    transactionResultsRoot: word(0x1000n + number),
    stateRoot: word(0x2000n + number),
    l1OriginRoot: word(0x3000n + number),
    historyRoot: word(0x3100n + number),
    transactionResults: [],
    transactionResultCount: 0n,
    transactionBytes: null,
    l1Origin: {
      blockNumber: 20_000_000n + number,
      blockHash: word(0x4000n + number),
      blockTimestamp: 1_700_000_000n + number,
      l1LogsRoot: word(0n),
      l1LogCount: 0n,
    },
  };
}

function status(latest: BlockResult, finalized: BlockResult): StatusResult {
  return testStatus({
    latestBlock: latest.number,
    latestBlockHash: latest.hash,
    latestBlockTimestamp: latest.timestamp,
    finalizedBlock: finalized.number,
    finalizedBlockHash: finalized.hash,
    finalizedBlockTimestamp: finalized.timestamp,
    latestL1BlockNumber: latest.l1Origin.blockNumber,
    latestL1BlockHash: latest.l1Origin.blockHash,
    finalizedL1BlockNumber: finalized.l1Origin.blockNumber,
    finalizedL1BlockHash: finalized.l1Origin.blockHash,
    stateRoot: latest.stateRoot,
    l1OriginRoot: latest.l1OriginRoot,
    historyRoot: latest.historyRoot,
    pcashChainId: Number(chainId),
    genesisHash,
    inboxAddress: `0x${"11".repeat(20)}`,
    genesisL1Block: 20_000_000n,
    genesisL1BlockHash: word(0x4000n),
    forkCapability: testForkCapability(chainId, genesisHash, latest.timestamp, word(0x6000n)),
  });
}


function noteTo(wallet: { address: bigint; mlKemPublicKey: Uint8Array }, amount: bigint, noteSecret?: bigint): SimNote {
  return { owner: wallet.address, receiveKey: wallet.mlKemPublicKey, amount, ...(noteSecret === undefined ? {} : { noteSecret }) };
}

function simInventory(sim: ChainSim, address: bigint): WalletFileData {
  return emptyWalletState({ address, network: { chainId, genesisHash: sim.genesisHash } });
}

function simTarget(block: { number: bigint; hash: bigint }): { pcashNumber: bigint; pcashHash: string } {
  return { pcashNumber: block.number, pcashHash: word(block.hash) };
}

/** The simulated node with some of its methods replaced. */
function withMethods(node: PcashNodeClient, methods: Record<string, unknown>): PcashNodeClient {
  return { ...node, ...methods } as unknown as PcashNodeClient;
}

type OutputsRequest = Parameters<PcashNodeClient["getOutputs"]>[0];

describe("dense private-output inventory synchronization", () => {
  it("decrypts each page before requesting the next one", async () => {
    const wallet = randomWallet();
    const head = block(1n, 0x6001n, 0x6000n);
    const noteSecret = 0x6002n;
    const amount = 6n;
    const body = noteBodyCommitment(ownerCommitment(wallet.address, noteSecret), 0n, amount);
    const commitment = outputCommitment(body, 0n);
    const outputData = encryptEnvelope(wallet.mlKemPublicKey, encodePayload({
      chainId,
      amount,
      owner: wallet.address,
      noteSecret,
      outputIndex: 0,
    }));
    let page = 0;
    const node = {
      status: async () => status(head, head),
      getOutputs: async (request: {
        fromOutputIndex: bigint;
        target: { pcashNumber: bigint; pcashHash: string };
        continuation?: Record<string, unknown> | null;
      }) => {
        page += 1;
        if (page === 1) {
          return {
            fromOutputIndex: request.fromOutputIndex,
            target: { ...request.target, outputCount: 1n },
            outputs: [{
              kind: "ordinary" as const,
              outputIndex: 0n,
              outputCommitment: word(commitment),
              outputData,
              transactionId: word(0x6003n),
              transactionType: 0, privateValueShape: 0,
              outputSlot: 0,
              nullifiers: [],
              arena: null,
              origin: request.target,
            }],
            continuation: { page: "0x2" },
            complete: false,
          };
        }
        expect(request.continuation).toEqual({ page: "0x2" });
        wallet.mlKemSecretKey.fill(0);
        return {
          fromOutputIndex: request.fromOutputIndex,
          target: { ...request.target, outputCount: 1n },
          outputs: [],
          continuation: null,
          complete: true,
        };
      },
    } as unknown as PcashNodeClient;

    const report = await scanWallet(node, wallet, chainId);

    expect(page).toBe(2);
    expect(report.recovered).toHaveLength(1);
    expect(report.recovered[0]!.noteSecret).toBe(noteSecret);
  });

  it.each(["chain", "genesis"] as const)("rejects a switched %s before reading wallet material", async (field) => {
    const wallet = randomWallet();
    const head = block(2n, 0x6010n, 0x600fn);
    const nodeStatus = status(head, head);
    if (field === "chain") nodeStatus.pcashChainId += 1;
    else nodeStatus.genesisHash = word(0xdeadn);
    let materialReads = 0;
    const node = {
      status: async () => nodeStatus,
      getAccountChanges: async () => {
        materialReads += 1;
        throw new Error("account material must not be read for another network");
      },
      getOutputs: async () => {
        materialReads += 1;
        throw new Error("note outputs must not be read for another network");
      },
    } as unknown as PcashNodeClient;
    const data: WalletFileData = {
      address: addressHex(wallet.address),
      network: { chainId: chainId.toString(), genesisHash },
      receiveKeys: [],
      notes: [],
    };

    await expect(synchronizeWalletInventory(node, wallet, chainId, data, { store: memoryWalletStateStore(data) }))
      .rejects.toThrow("different PCASH network");
    expect(materialReads).toBe(0);
  });

  it("uses the caller-validated status for the cursor-driving scan", async () => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    for (let count = 0; count < 3; count++) sim.addBlock();
    const data = simInventory(sim, wallet.address);

    await expect(synchronizeWalletInventory(sim.client(), wallet, chainId, data, {
      store: memoryWalletStateStore(data),
      status: sim.status(),
    })).resolves.toMatchObject({ syncedThrough: simTarget(sim.head) });

    expect(sim.calls.map((call) => call.method)).not.toContain("status");
  });

  // The node commits a canonical block and only then advances the derived
  // index, so `pcash_status` routinely reports a canonical tip the index cannot
  // answer for yet. The wallet pins its scan to the index's own ready cursor.
  it("pins a scan to the ready index cursor while it trails the canonical tip", async () => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    for (let count = 0; count < 5; count++) sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }] });
    const indexed = sim.block(4n);
    const nodeStatus = { ...sim.status(), index: { status: "ready" as const, cursor: { blockNumber: indexed.number, blockHash: word(indexed.hash) } } };
    const client = sim.client();
    const targets: bigint[] = [];
    const node = withMethods(client, {
      status: async () => nodeStatus,
      getOutputs: (request: OutputsRequest) => {
        targets.push(request.target.pcashNumber);
        return client.getOutputs(request);
      },
    });
    const data = simInventory(sim, wallet.address);

    await expect(synchronizeWalletInventory(node, wallet, chainId, data, { store: memoryWalletStateStore(data) }))
      .resolves.toMatchObject({ syncedThrough: simTarget(indexed) });
    expect(targets).toEqual([indexed.number]);
    expect(data.syncedThrough).toEqual({ blockNumber: "4", blockHash: word(indexed.hash) });

    await expect(scanWallet(node, wallet, chainId)).resolves.toMatchObject({ recovered: [] });
    expect(targets).toEqual([indexed.number, indexed.number]);
  });

  it("adds nothing while the index trails the synced block", async () => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    sim.addBlock({ transactions: [{ outputs: [noteTo(wallet, 5n), null, null, null, null] }] });
    sim.addBlock();
    const store = memoryWalletStateStore(simInventory(sim, wallet.address));
    await syncWallet({ node: sim.client(), wallet, chainId, store });
    const data = (await store.load())!;
    const before = structuredClone(data);
    const trailing = { ...sim.status(), index: { status: "ready" as const, cursor: { blockNumber: 1n, blockHash: word(sim.block(1n).hash) } } };
    sim.calls.length = 0;
    let persisted = 0;

    const report = await synchronizeWalletInventory(sim.client(), wallet, chainId, data, {
      store,
      status: trailing,
      persist: () => { persisted += 1; },
    });
    expect(report).toMatchObject({ scanned: 0, recovered: [], syncedThrough: simTarget(sim.block(2n)) });
    expect(sim.calls.map((call) => call.method)).toEqual(["getBlockHeader"]);
    expect(persisted).toBe(0);
    expect(data).toEqual(before);
  });

  it("commits a rewind at its checkpoint when the index trails the reorganized chain", async () => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    sim.finalityLag = 100n;
    const store = memoryWalletStateStore(simInventory(sim, wallet.address));
    for (const slot of [0, 1, 2]) {
      const outputs: Array<SimNote | null> = [null, null, null, null, null];
      outputs[slot] = noteTo(wallet, 5n + BigInt(slot));
      sim.addBlock({ transactions: [{ outputs }] });
      await syncWallet({ node: sim.client(), wallet, chainId, store });
    }
    sim.reorg(2n, [{}]);
    const trailing = { ...sim.status(), index: { status: "ready" as const, cursor: { blockNumber: 1n, blockHash: word(sim.block(1n).hash) } } };
    sim.calls.length = 0;

    const { data } = await syncWallet({ node: sim.client(), wallet, chainId, store, status: trailing });
    expect(data.notes.map((note) => note.amount)).toEqual(["5", "6"]);
    expect(data.syncedThrough).toEqual({ blockNumber: "2", blockHash: word(sim.block(2n).hash) });
    expect(await store.readChain((chain) => [chain!.synced.pcashNumber, chain!.outputs.count])).toEqual([2n, 10n]);
    expect(sim.calls.map((call) => call.method)).not.toContain("getOutputs");
  });

  it("refuses to scan against an index that is not serving reads", async () => {
    const wallet = randomWallet();
    const tip = block(5n, 0x6301n, 0x6300n);
    const nodeStatus = {
      ...status(tip, tip),
      index: { status: "catchingUp", cursor: null },
    };
    const node = {
      status: async () => nodeStatus,
      getOutputs: async () => { throw new Error("an unavailable index must not be read"); },
    } as unknown as PcashNodeClient;
    const data: WalletFileData = {
      address: addressHex(wallet.address),
      network: { chainId: chainId.toString(), genesisHash },
      receiveKeys: [],
      notes: [],
    };

    await expect(synchronizeWalletInventory(node, wallet, chainId, data, { store: memoryWalletStateStore(data) }))
      .rejects.toThrow("node derived index is catchingUp");
    await expect(scanWallet(node, wallet, chainId)).rejects.toThrow("node derived index is catchingUp");
  });

  it("anchors a fresh wallet at the index boundary's own output count", async () => {
    const wallet = randomWallet();
    const stranger = randomWallet();
    const sim = new ChainSim(chainId);
    sim.addBlock({ transactions: [{ outputs: [noteTo(stranger, 20n), noteTo(stranger, 21n), noteTo(stranger, 22n)] }] });
    sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }] });
    // The canonical tip holds 8 outputs; the index has committed the first
    // block's 3. Anchoring at the tip's count would leave the cursor past
    // everything the index can serve at the boundary the wallet records.
    const indexed = sim.block(1n);
    const nodeStatus = { ...sim.status(), index: { status: "ready" as const, cursor: { blockNumber: indexed.number, blockHash: word(indexed.hash) } } };
    const client = sim.client();
    const starts: bigint[] = [];
    const node = withMethods(client, {
      getOutputs: (request: OutputsRequest) => {
        starts.push(request.fromOutputIndex);
        return client.getOutputs(request);
      },
    });
    const data = simInventory(sim, wallet.address);

    const report = await synchronizeWalletInventory(node, wallet, chainId, data, {
      store: memoryWalletStateStore(data),
      status: nodeStatus,
      anchorAtTarget: true,
    });

    // No page walked from output zero.
    expect(starts).toEqual([3n]);
    expect(report).toMatchObject({ scanned: 0, recovered: [], startedAtOutputIndex: 3n, nextOutputIndex: 3n });
    expect(data.nextOutputIndex).toBe("3");
    expect(data.historyStartOutputIndex).toBe("3");
    expect(data.syncedThrough).toEqual({ blockNumber: "1", blockHash: word(indexed.hash) });
    expect(data.notes).toEqual([]);
  });

  it.each(["pending note", "outbox"] as const)("refuses to anchor a wallet with a %s", async (activity) => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }] });
    const data = simInventory(sim, wallet.address);
    if (activity === "pending note") {
      addPendingNote(data, word(0x6111n), {
        outputIndex: 0,
        assetId: 0n,
        amount: 1n,
        owner: wallet.address,
        noteSecret: 0x6112n,
      });
    } else {
      data.mempoolOutbox = [{
        contentHash: word(0x6113n),
        transactionHex: "0x00",
        kind: "noteFundedTransfer",
        state: "prepared",
        createdAtUnixMs: "1",
      }];
    }

    await expect(synchronizeWalletInventory(sim.client(), wallet, chainId, data, {
      store: memoryWalletStateStore(data),
      anchorAtTarget: true,
    })).rejects.toThrow("fresh action-free wallet");
    expect(sim.calls.map((call) => call.method)).toEqual(["status"]);
  });

  it("full-rescans old and new deliveries without disclosing owned output membership", async () => {
    const wallet = randomWallet();
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(0x61));
    const sim = new ChainSim(chainId);
    sim.addBlock({
      accounts: [{
        address: addressHex(wallet.address),
        nullifierKeyCommitment: 0x6300n,
        accountRuleSetCommitment: 0x6301n,
        receiveKey: rotated.publicKey,
      }],
      transactions: [{
        outputs: [
          noteTo(wallet, 10n, 0x6100n),
          { owner: wallet.address, receiveKey: rotated.publicKey, amount: 11n, noteSecret: 0x6101n },
        ],
      }],
    });
    const data = simInventory(sim, wallet.address);
    retainReceiveKeyPair(data, rotated);

    const report = await synchronizeWalletInventory(sim.client(), wallet, chainId, data, {
      store: memoryWalletStateStore(data),
      target: simTarget(sim.head),
    });
    expect(report.recovered).toHaveLength(2);
    expect(data.notes.map((note) => note.noteSecret)).toEqual(["0x6100", "0x6101"]);
    expect(data.receiveKeys).toHaveLength(2);
    expect(sim.calls.map((call) => call.method)).toEqual(["status", "getAccountChanges", "getOutputs", "getBlockHeader"]);
  });

  it("records a delivered asset definition beside its note", async () => {
    const wallet = randomWallet();
    const definition: AssetDefinition = {
      initialSupply: 50n,
      assetSecretCommitment: 0x82n,
      metadata: { name: "Scanned Token", symbol: "SCN", decimals: 1, contentDigest: new Uint8Array(32).fill(3) },
    };
    const assetId = assetDefinitionAssetId(definition);
    const noteSecret = 0x6300n;
    const sim = new ChainSim(chainId);
    sim.addBlock({
      transactions: [deliveredTransaction({
        chainId,
        outputs: [{
          receiveKey: wallet.mlKemPublicKey, owner: wallet.address, amount: 20n, assetId, noteSecret,
          records: [assetDefinitionSchema.encode(definition)],
        }],
      })],
    });
    const data = simInventory(sim, wallet.address);

    const report = await synchronizeWalletInventory(sim.client(), wallet, chainId, data, {
      store: memoryWalletStateStore(data),
      target: simTarget(sim.head),
    });
    expect(report.recovered[0]).toMatchObject({ assetId, assetDefinition: definition });
    expect(data.assets).toHaveLength(1);
    expect(BigInt(data.assets![0]!.assetId)).toBe(assetId);
    expect(storedAssetDefinition(data.assets![0]!)).toEqual(definition);
    expect(data.assets![0]!.assetSecret).toBeUndefined();
  });

  it("records a received note's memo and claimed sender", async () => {
    const wallet = randomWallet();
    const payer = 0x4444444444444444444444444444444444444444n;
    const memo = new TextEncoder().encode("rent");
    const noteSecret = 0x6310n;
    const sim = new ChainSim(chainId);
    sim.addBlock({
      transactions: [deliveredTransaction({
        chainId,
        outputs: [{ receiveKey: wallet.mlKemPublicKey, owner: wallet.address, amount: 25n, noteSecret, records: [{ schema: RECORD_SCHEMA.memo, data: memo }, claimedSenderSchema.encode(payer)] }],
      })],
    });
    const data = simInventory(sim, wallet.address);

    await synchronizeWalletInventory(sim.client(), wallet, chainId, data, {
      store: memoryWalletStateStore(data),
      target: simTarget(sim.head),
    });
    expect(data.notes[0]).toMatchObject({ amount: "25", memo: toHex(memo), sender: addressHex(payer) });
  });

  it.each([false, true])("reopens what it sent from its sender region alone (explicit opening: %s)", async (explicit) => {
    const wallet = randomWallet();
    const recipient = randomWallet();
    const sim = new ChainSim(chainId);
    sim.addBlock({ transactions: [{ outputs: [noteTo(wallet, 90n, 0x911n), null, null, null, null] }] });
    const store = memoryWalletStateStore(simInventory(sim, wallet.address));
    await syncWallet({ node: sim.client(), wallet, chainId, store });
    const data = (await store.load())!;
    const memo = new TextEncoder().encode("dinner");
    const noteSecret = 0x912n;
    // The outgoing key is secret, so a transaction that spends none of this
    // wallet's known notes is still its own when the key opens its sender region.
    const b2 = sim.addBlock({
      transactions: [explicit
        ? deliveredTransaction({
          chainId,
          outputs: [
            { body: noteBodyCommitment(ownerCommitment(recipient.address, noteSecret), 0n, 50n), outputData: sizeClassFiller() },
            noteTo(wallet, 40n, 0x914n), null, null, null,
          ],
          sender: { outgoingKey: wallet.outgoingKey },
          sentOpenings: [{ slot: 0, recipientAddress: recipient.address, assetId: 0n, amount: 50n, noteSecret }],
        })
        : deliveredTransaction({
          chainId,
          outputs: [
            { receiveKey: recipient.mlKemPublicKey, owner: recipient.address, amount: 50n, noteSecret,
              records: [{ schema: RECORD_SCHEMA.memo, data: memo }, claimedSenderSchema.encode(wallet.address)], sentTo: recipient.address },
            noteTo(wallet, 40n, 0x914n), null, null, null,
          ],
          sender: { outgoingKey: wallet.outgoingKey },
        })],
    });
    // Another wallet's sender region, also paying the recipient, is not this wallet's history.
    sim.addBlock({
      transactions: [deliveredTransaction({
        chainId,
        outputs: [{ receiveKey: recipient.mlKemPublicKey, owner: recipient.address, amount: 7n, sentTo: recipient.address }, null, null, null, null],
        sender: { outgoingKey: new Uint8Array(randomBytes(32)) },
      })],
    });
    sim.pageSize = 5;

    await synchronizeWalletInventory(sim.client(), wallet, chainId, data, { store, target: simTarget(sim.head) });

    const paid = b2.outputs[0]!;
    if (paid.kind !== "ordinary") throw new Error("fixture");
    expect(data.sentOutputs).toHaveLength(1);
    expect(data.sentOutputs![0]).toEqual({
      transactionId: paid.transactionId.toLowerCase(),
      contentHash: paid.contentHash.toLowerCase(),
      privateValueShape: 0,
      slot: 0,
      leafIndex: "5",
      noteSecret: word(noteSecret),
      recipientAddress: addressHex(recipient.address),
      assetId: "0x0",
      amount: "50",
      ...(explicit ? {} : { memo: toHex(memo) }),
      senderIncluded: !explicit,
      blockNumber: "2",
      blockHash: word(b2.hash),
      blockTimestamp: paid.origin.timestamp.toString(),
    });
  });

  it("restores an asset definition carried only by its sender region", async () => {
    const wallet = randomWallet();
    const recipient = randomWallet();
    const definition: AssetDefinition = {
      initialSupply: 50n,
      assetSecretCommitment: 0x83n,
      metadata: { name: "Imported Token", symbol: "IMP", decimals: 0, contentDigest: new Uint8Array(32).fill(4) },
    };
    const assetId = assetDefinitionAssetId(definition);
    const sim = new ChainSim(chainId);
    const noteSecret = 0x917n;
    const amount = 50n;
    sim.addBlock({ transactions: [deliveredTransaction({
      chainId,
      outputs: [
        { body: noteBodyCommitment(ownerCommitment(recipient.address, noteSecret), assetId, amount), outputData: sizeClassFiller() },
        null, null, null, null,
      ],
      sender: { outgoingKey: wallet.outgoingKey, records: [{ schema: applicationSchemaId("com.example.record009"), data: Uint8Array.of(1, 2, 3) }] },
      sentOpenings: [{ slot: 0, recipientAddress: recipient.address, assetId, amount, noteSecret }],
      assetDefinition: definition,
    })] });
    const data = simInventory(sim, wallet.address);

    await synchronizeWalletInventory(sim.client(), wallet, chainId, data, { store: memoryWalletStateStore(data), target: simTarget(sim.head) });
    expect(data.notes).toHaveLength(0);
    expect(data.sentOutputs).toHaveLength(1);
    expect(data.sentOutputs![0]).toMatchObject({ assetId: `0x${assetId.toString(16)}`, senderRecords: [{ schema: applicationSchemaId("com.example.record009"), data: "0x010203" }] });
    expect(data.sentOutputs![0]!.assetDefinition).toBeDefined();
    expect(data.assets).toHaveLength(1);
    expect(storedAssetDefinition(data.assets![0]!)).toEqual(definition);
  });

  it.each([
    ["an altered amount", { amount: 51n }],
    ["another owner", { owner: "other" as const }],
    ["another slot's commitment", { slot: 3 }],
  ])("ignores a reopened output whose payload does not open the streamed commitment: %s", async (_name, forgery) => {
    const wallet = randomWallet();
    const recipient = randomWallet();
    const other = randomWallet();
    const sim = new ChainSim(chainId);
    // The streamed commitment is the genuine payment of 50 to the recipient at slot 0.
    const noteSecret = 0x922n;
    const genuineBody = noteBodyCommitment(ownerCommitment(recipient.address, noteSecret), 0n, 50n);
    // A lying feed replaces output data while keeping the nullifiers and commitments.
    const payee = "owner" in forgery ? other : recipient;
    const forged = sealEnvelope(recipient.mlKemPublicKey, encodePayload({
      chainId, amount: "amount" in forgery ? forgery.amount : 50n, owner: payee.address, noteSecret, outputIndex: 0,
    }));
    const slot = "slot" in forgery ? forgery.slot : 0;
    const nullifiers = Array.from({ length: PRIVATE_VALUE_PROFILES.S.inputs }, () => randomFieldEntropy());
    const { arena } = buildArena({
      shape: PRIVATE_VALUE_PROFILES.S.shapeId,
      context: { chainId, transactionType: 0, nullifiers },
      sender: {
        outgoingKey: wallet.outgoingKey,
        records: [sentEnvelopesSchema.encode([{ slot, sharedSecret: forged.sharedSecret, recipientAddress: payee.address }])],
      },
      recipients: [],
    });
    const outputs: ({ body: bigint; outputData: Uint8Array } | null)[] = [
      { body: genuineBody, outputData: slot === 0 ? forged.envelope : sizeClassFiller() },
      null,
      null,
      slot === 3 ? { body: 0x924n, outputData: forged.envelope } : null,
      null,
    ];
    sim.addBlock({ transactions: [{ nullifiers: nullifiers.map(word), arena, outputs }] });
    const data = simInventory(sim, wallet.address);

    await synchronizeWalletInventory(sim.client(), wallet, chainId, data, { store: memoryWalletStateStore(data), target: simTarget(sim.head) });
    expect(data.sentOutputs).toBeUndefined();
  });

  it("fails before reading the durable feed when the current receive key is missing locally", async () => {
    const wallet = randomWallet();
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(0x62));
    const sim = new ChainSim(chainId);
    sim.addBlock({
      accounts: [{
        address: addressHex(wallet.address),
        nullifierKeyCommitment: 0x6400n,
        accountRuleSetCommitment: 0x6401n,
        receiveKey: rotated.publicKey,
      }],
    });
    const data = simInventory(sim, wallet.address);

    await expect(synchronizeWalletInventory(sim.client(), wallet, chainId, data, { store: memoryWalletStateStore(data) }))
      .rejects.toThrow("does not own the current authenticated receive key");
    expect(sim.calls.map((call) => call.method)).not.toContain("getOutputs");
  });

  it("pins one target across pages of whole transactions and advances across an empty block", async () => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    sim.addBlock({ transactions: [{ outputs: [noteTo(wallet, 90n, 0x901n), null, null, null, null] }] });
    const store = memoryWalletStateStore(simInventory(sim, wallet.address));
    await syncWallet({ node: sim.client(), wallet, chainId, store });
    const data = (await store.load())!;
    const oldNote = data.notes[0]!;
    const spentNullifier = nullifier(BigInt(oldNote.commitment!), noteNk(wallet.nkRoot), BigInt(oldNote.noteSecret));
    const b2 = sim.addBlock({
      transactions: [
        { nullifiers: [word(spentNullifier)], outputs: [noteTo(wallet, 33n, 0x902n), null, null, null, null] },
        { outputs: [null, null, null, null, null] },
      ],
    });
    const payment = b2.outputs[0]!;
    if (payment.kind !== "ordinary") throw new Error("fixture");
    const b3 = sim.addBlock();
    sim.addBlock();
    sim.pageSize = 7;
    const target = simTarget(b3);
    const requests: OutputsRequest[] = [];
    const persistedAt: string[] = [];
    const client = sim.client();
    const node = withMethods(client, {
      getOutputs: (request: OutputsRequest) => {
        requests.push(request);
        if (requests.length > 1) expect(persistedAt).toEqual([]);
        return client.getOutputs(request);
      },
    });

    const report = await synchronizeWalletInventory(node, wallet, chainId, data, {
      store,
      target,
      persist: (next) => { persistedAt.push(next.syncedThrough!.blockNumber); },
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.target)).toEqual([target, target]);
    expect(requests.map((request) => request.fromOutputIndex)).toEqual([5n, 5n]);
    expect(requests[0]!.continuation).toBeUndefined();
    expect(requests[1]!.continuation).toEqual({ next: "10" });
    expect(persistedAt).toEqual(["3"]);
    expect(report.scanned).toBe(10);
    expect(report.recovered).toHaveLength(1);
    expect(data.notes.find((note) => note.commitment === oldNote.commitment)).toMatchObject({
      spent: true,
    });
    expect(data.notes.find((note) => note.commitment === payment.outputCommitment)).toMatchObject({
      amount: "33",
      spent: false,
      cursor: { kind: "ordinary", payout: null, blockNumber: "2", blockHash: word(b2.hash), transactionId: payment.transactionId.toLowerCase(), outputIndex: "0" },
    });
    expect(data.syncedThrough).toEqual({ blockNumber: "3", blockHash: word(b3.hash) });
  });

  it("recovers 513 owned outputs across a frozen multipage target without gaps", async () => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    const b1 = sim.addBlock({
      transactions: Array.from({ length: 513 }, (_, index) => ({
        outputs: [noteTo(wallet, BigInt(index) + 1n, 0x100_000n + BigInt(index))],
      })),
    });
    sim.pageSize = 257;
    const target = simTarget(b1);
    const requests: OutputsRequest[] = [];
    const client = sim.client();
    const node = withMethods(client, {
      getOutputs: (request: OutputsRequest) => {
        requests.push(request);
        // The head keeps moving while the scan stays pinned.
        sim.addBlock();
        return client.getOutputs(request);
      },
    });
    const data = simInventory(sim, wallet.address);

    const report = await synchronizeWalletInventory(node, wallet, chainId, data, { store: memoryWalletStateStore(data), target });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.target)).toEqual([target, target]);
    expect(requests[1]!.continuation).toEqual({ next: "257" });
    expect(report.scanned).toBe(513);
    expect(report.trialDecryptAttempts).toBe(513);
    expect(report.recovered).toHaveLength(513);
    expect(data.notes).toHaveLength(513);
    expect(data.notes.map((note) => BigInt(note.leafIndex!))).toEqual(
      Array.from({ length: 513 }, (_, index) => BigInt(index)),
    );
    expect(data.syncedThrough).toEqual({ blockNumber: "1", blockHash: word(b1.hash) });
  });

  it("does not publish inventory when the scan target becomes orphaned", async () => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    const b1 = sim.addBlock({ transactions: [{ outputs: [noteTo(wallet, 5n), null, null, null, null] }] });
    const client = sim.client();
    const node = withMethods(client, {
      getOutputs: async (request: OutputsRequest) => {
        const page = await client.getOutputs(request);
        sim.reorg(0n, [{}]);
        return page;
      },
    });
    const data = simInventory(sim, wallet.address);
    const before = structuredClone(data);
    let persisted = 0;

    await expect(synchronizeWalletInventory(node, wallet, chainId, data, {
      store: memoryWalletStateStore(data),
      target: simTarget(b1),
      persist: () => { persisted += 1; },
    })).rejects.toThrow("PCASH head changed during wallet synchronization");
    expect(data).toEqual(before);
    expect(persisted).toBe(0);
  });

  it("rebuilds confirmed inventory when the saved target becomes orphaned", async () => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    sim.addBlock({ transactions: [{ outputs: [noteTo(wallet, 55n), null, null, null, null] }] });
    sim.addBlock({ transactions: [{ outputs: [null, noteTo(wallet, 44n), null, null, null] }] });
    const initial = simInventory(sim, wallet.address);
    retainReceiveKeyPair(initial, generateMlKemKeyPair(new Uint8Array(64).fill(0x71)));
    const retainedReceiveKeys = structuredClone(initial.receiveKeys);
    const store = memoryWalletStateStore(initial);
    await syncWallet({ node: sim.client(), wallet, chainId, store });
    const data = (await store.load())!;
    expect(data.notes.map((note) => note.amount)).toEqual(["55", "44"]);
    sim.reorg(0n, [{}, {}]);
    const target = simTarget(sim.head);
    const persistedAt: string[] = [];

    await synchronizeWalletInventory(sim.client(), wallet, chainId, data, {
      store,
      target,
      persist: (next) => { persistedAt.push(next.syncedThrough!.blockNumber); },
    });

    expect(data.notes).toEqual([]);
    expect(data.syncedThrough).toEqual({ blockNumber: "2", blockHash: target.pcashHash });
    expect(data.receiveKeys).toEqual([
      ...retainedReceiveKeys,
      expect.objectContaining({ mlKemPublicKey: expect.any(String) }),
    ]);
    expect(persistedAt).toEqual(["2"]);
  });

  it("leaves inventory and chain state unchanged when an orphan rebuild cannot read its output page", async () => {
    const wallet = randomWallet();
    const sim = new ChainSim(chainId);
    sim.addBlock({ transactions: [{ outputs: [noteTo(wallet, 5n), null, null, null, null] }] });
    const store = memoryWalletStateStore(simInventory(sim, wallet.address));
    await syncWallet({ node: sim.client(), wallet, chainId, store });
    const data = (await store.load())!;
    const before = structuredClone(data);
    sim.reorg(0n, [{}, {}]);
    const node = withMethods(sim.client(), {
      getOutputs: async () => { throw new Error("output cursor mismatch"); },
    });
    let persisted = 0;

    await expect(synchronizeWalletInventory(node, wallet, chainId, data, {
      store,
      persist: () => { persisted += 1; },
    })).rejects.toThrow("output cursor mismatch");
    expect(data).toEqual(before);
    expect(persisted).toBe(0);
    expect(await store.readChain((chain) => chain!.synced.pcashNumber)).toBe(1n);
  });
});

it("recovers spendable notes while retaining opaque malformed application content", async () => {
  const pair = generateMlKemKeyPair();
  const applicationRecords = [{ schema: applicationSchemaId("com.example.record007"), data: Uint8Array.of(255, 0, 17) }];
  const transaction = deliveredTransaction({
    chainId: 1n,
    outputs: [{ receiveKey: pair.publicKey, owner: 8n, noteSecret: 9n, amount: 10n, records: [...applicationRecords] }],
  });
  const output = transaction.outputs[0] as { body: bigint; outputData: Uint8Array };
  const commitment = outputCommitment(output.body, 0n);
  const item = { kind: 0, shape: 0 as const, outputIndex: 0, leafIndex: 0n, outputCommitment: commitment, outputData: output.outputData };
  const arena = { arena: transaction.arena!, nullifiers: transaction.nullifiers! };
  const report = await scanFeed({ chainId: 1n, mlKemSecretKeys: [pair.secretKey], owners: [8n], feed: [{ ...item, arena }] });
  expect(report.recovered).toHaveLength(1);
  expect(report.recovered[0]!.applicationRecords).toEqual(orderedRecords(applicationRecords));
  expect(report.recovered[0]!.amount).toBe(10n);
  expect(report.recovered[0]!.outputCommitment).toBe(commitment);

  // Records that fail to open leave the note itself recovered.
  const corrupted = Uint8Array.from(arena.arena);
  for (let index = 32; index < corrupted.length; index++) corrupted[index]! ^= 0x5a;
  for (const feed of [
    [item],
    [{ ...item, arena: { ...arena, arena: corrupted } }],
    [{ ...item, arena: { ...arena, nullifiers: arena.nullifiers.slice(1) } }],
    [{ ...item, kind: 1, arena }],
  ]) {
    const degraded = await scanFeed({ chainId: 1n, mlKemSecretKeys: [pair.secretKey], owners: [8n], feed });
    expect(degraded.recovered).toHaveLength(1);
    expect(degraded.recovered[0]!.applicationRecords).toBeUndefined();
    expect(degraded.recovered[0]!.memo).toEqual(new Uint8Array());
  }
});
