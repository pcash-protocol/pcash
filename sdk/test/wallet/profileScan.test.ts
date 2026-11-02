import { describe, expect, it } from "vitest";
import { addressHex } from "@pcash/sdk/utils";
import { encodePayload, encryptEnvelope, generateMlKemKeyPair } from "@pcash/sdk/protocol";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { DEFAULT_NETWORK_CONFIG } from "@pcash/sdk/protocol";
import { noteBodyCommitment, outputCommitment, ownerCommitment } from "@pcash/sdk/protocol";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { assertPcashProfileAccount, scanWallet } from "../../src/wallet/actions/scan.ts";
import { syncWallet } from "../../src/wallet/actions/syncWallet.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import type { WalletFileData } from "../../src/wallet/noteStore.ts";
import { retainReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { ChainSim, chainRecords, type AccountRow } from "./chainFixture.ts";

const profile = derivePcashProfileFromPrivateKey(
  new Uint8Array(32).fill(0x19),
  DEFAULT_NETWORK_CONFIG,
);
const chainId = DEFAULT_NETWORK_CONFIG.pcashChainId;
const status = {
  pcashChainId: Number(DEFAULT_NETWORK_CONFIG.pcashChainId),
  l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId,
  inboxAddress: `0x${DEFAULT_NETWORK_CONFIG.inboxAddress.toString(16).padStart(40, "0")}`,
  latestBlock: 4n,
  latestBlockHash: `0x${"44".repeat(32)}`,
  index: { status: "ready", cursor: { blockNumber: 4n, blockHash: `0x${"44".repeat(32)}` } },
} as StatusResult;
const rules = defaultUserAccountRuleSet({
  wallet: profile,
  network: DEFAULT_NETWORK_CONFIG,
  secrets: profile.defaultUserRuleSecrets,
});

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    address: addressHex(profile.address),
    nullifierKeyCommitment: profile.nullifierKeyCommitment,
    accountRuleSetCommitment: rules.accountRuleSetCommitment,
    receiveKey: profile.mlKemPublicKey,
    ...overrides,
  };
}

/** A chain on the profile's network whose first block registers `row`. */
function profileChain(row: AccountRow): ChainSim {
  const sim = new ChainSim(chainId, {
    l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId,
    inboxAddress: status.inboxAddress,
  });
  sim.addBlock({ accounts: [row] });
  return sim;
}

function inventory(sim: ChainSim): WalletFileData {
  return emptyWalletState({ address: profile.address, network: { chainId, genesisHash: sim.genesisHash } });
}

describe("canonical user-profile scan", () => {
  it("fails on a changed profile before reading the wallet feed", async () => {
    const sim = profileChain(account({ nullifierKeyCommitment: profile.nullifierKeyCommitment + 1n }));
    const store = memoryWalletStateStore(inventory(sim));

    await expect(syncWallet({ node: sim.client(), wallet: profile, chainId, store }))
      .rejects.toThrow("nullifier-key commitment");
    expect(sim.calls.map((call) => call.method)).not.toContain("getOutputs");
  });

  it("checks a restored profile against its locally synced account", async () => {
    const sim = profileChain(account());
    const store = memoryWalletStateStore(inventory(sim));
    await expect(assertPcashProfileAccount(store, profile, sim.status())).rejects.toThrow("sync first");
    await syncWallet({ node: sim.client(), wallet: profile, chainId, store });
    await expect(assertPcashProfileAccount(store, profile, sim.status()))
      .resolves.toMatchObject({ address: addressHex(profile.address), index: 0n });

    const changedRow = account({ nullifierKeyCommitment: profile.nullifierKeyCommitment + 1n });
    const changed = profileChain(changedRow);
    const seeded = memoryWalletStateStore(
      inventory(changed),
      chainRecords({ outputs: [], accounts: [changedRow], anchor: changed.head.envelope }),
    );
    await expect(assertPcashProfileAccount(seeded, profile, changed.status()))
      .rejects.toThrow("nullifier-key commitment");
  });

  it("scans the status-pinned feed without reading an account", async () => {
    const node = {
      status: async () => status,
      getOutputs: async (request: { fromOutputIndex: bigint; target: { pcashNumber: bigint; pcashHash: string } }) => ({
        fromOutputIndex: request.fromOutputIndex,
        target: { ...request.target, outputCount: 0n },
        outputs: [],
        continuation: null,
        complete: true,
      }),
    } as unknown as PcashNodeClient;

    await expect(scanWallet(node, profile, DEFAULT_NETWORK_CONFIG.pcashChainId))
      .resolves.toEqual({
        scanned: 0,
        trialDecryptAttempts: 0,
        decrypted: 0,
        recovered: [],
        sent: [],
        receivedData: [],
        transactionRecords: [],
      });
  });

  it("recovers a rotated-key delivery only with the retained key pair", async () => {
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(0x52));
    const noteSecret = 0x5201n;
    const amount = 52n;
    const leafIndex = 0n;
    const commitment = outputCommitment(
      noteBodyCommitment(ownerCommitment(profile.address, noteSecret), 0n, amount),
      leafIndex,
    );
    const node = {
      status: async () => status,
      getOutputs: async (request: { fromOutputIndex: bigint; target: { pcashNumber: bigint; pcashHash: string } }) => ({
        fromOutputIndex: request.fromOutputIndex,
        target: { ...request.target, outputCount: 1n },
        outputs: [{
          kind: "ordinary" as const, privateValueShape: 0, outputSlot: 0,
          outputIndex: leafIndex,
          outputCommitment: `0x${commitment.toString(16).padStart(64, "0")}`,
          outputData: encryptEnvelope(rotated.publicKey, encodePayload({
                chainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
                amount,
                owner: profile.address,
                noteSecret,
                outputIndex: 0,
          })),
          transactionId: `0x${"55".repeat(32)}`,
          transactionType: 0,
          nullifiers: [],
          arena: null,
          origin: request.target,
        }],
        continuation: null,
        complete: true,
      }),
    } as unknown as PcashNodeClient;

    await expect(scanWallet(node, profile, DEFAULT_NETWORK_CONFIG.pcashChainId))
      .resolves.toMatchObject({ recovered: [] });

    const report = await scanWallet(node, profile, DEFAULT_NETWORK_CONFIG.pcashChainId, {
      receiveKeyPairs: [rotated],
    });
    expect(report.recovered).toHaveLength(1);
    expect(report.recovered[0]!.noteSecret).toBe(noteSecret);
  });

  it("requires the rotated current key before reading the feed and then recovers its delivery", async () => {
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(0x52));
    const sim = profileChain(account({ receiveKey: rotated.publicKey }));
    sim.addBlock({
      transactions: [{ outputs: [{ owner: profile.address, receiveKey: rotated.publicKey, amount: 52n, noteSecret: 0x5201n }] }],
    });
    const store = memoryWalletStateStore(inventory(sim));

    await expect(syncWallet({ node: sim.client(), wallet: profile, chainId, store }))
      .rejects.toThrow("does not own the current authenticated receive key");
    expect(sim.calls.map((call) => call.method)).not.toContain("getOutputs");

    const data = (await store.load())!;
    retainReceiveKeyPair(data, rotated);
    await store.save(data);
    const { data: synced } = await syncWallet({ node: sim.client(), wallet: profile, chainId, store });
    expect(synced.notes.map((note) => note.noteSecret)).toEqual(["0x5201"]);
  });

  it("still scans historical deliveries after the current receive key is cleared", async () => {
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(0x53));
    const sim = profileChain(account({ receiveKey: null }));
    sim.addBlock({
      transactions: [{ outputs: [null, { owner: profile.address, receiveKey: rotated.publicKey, amount: 53n, noteSecret: 0x5301n }] }],
    });
    const data = inventory(sim);
    retainReceiveKeyPair(data, rotated);

    const { data: synced } = await syncWallet({ node: sim.client(), wallet: profile, chainId, store: memoryWalletStateStore(data) });
    expect(synced.notes.map((note) => note.noteSecret)).toEqual(["0x5301"]);
  });
});
