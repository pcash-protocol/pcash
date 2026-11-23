import { describe, expect, it } from "vitest";
import { emptyWalletState as makeEmptyWalletFile } from "../../src/wallet/store.ts";
import {
  addPendingNote,
  addWalletAsset,
  knownAssetDefinition,
  mergeRecoveredWalletNotes,
  addPendingUserAccountCreation,
  markPendingUserAccountCreationBroadcastRequested,
  markPendingUserAccountCreationPrepared,
  markPendingUserAccountCreationSubmitted,
  type WalletFileData,
  type WalletNote,
} from "../../src/wallet/noteStore.ts";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import {
  assetDefinitionAssetId,
  assetDefinitionOf,
  findAssetDefinition,
  formatAssetDefinition,
  generateMlKemKeyPair,
  type AssetDefinition,
} from "@pcash/sdk/protocol";
import {
  createAccountMintAsset,
  deriveFixedSupplyAsset,
  encodeAccountMintConfiguration,
  encodeFixedSupplyConfiguration,
  fixedSupplySecretCommitment,
  senderDenyListTransferRule,
} from "@pcash/sdk/rules";
import { OPEN_WALLET_INTERNAL, Wallet } from "../../src/wallet/actions/walletClient.ts";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { WALLET_DATABASE_STATE_STORE, type WalletDatabase } from "../../src/wallet/store.ts";
import { testStatus } from "./statusFixture.ts";
import { receiveKeyPairs, retainReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { PCASH_CHAIN_ID } from "@pcash/sdk/constants";

const ADDRESS = 0xabcn;
const NETWORK = {
  chainId: PCASH_CHAIN_ID,
  genesisHash: `0x${"11".repeat(32)}`,
};

const hash = (byte: number): string => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const emptyWalletFile = (): WalletFileData => makeEmptyWalletFile({ address: ADDRESS, network: NETWORK });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function note(
  commitmentByte: number,
  amount: bigint,
  at: { number: bigint; hash: string; transactionByte?: number; outputIndex?: number },
): WalletNote {
  const outputIndex = at.outputIndex ?? 0;
  return {
    leafIndex: BigInt(commitmentByte).toString(),
    outputIndex,
    assetId: "0x0",
    amount: amount.toString(),
    owner: "0xabc",
    noteSecret: `0x${commitmentByte.toString(16)}`,
    commitment: hash(commitmentByte),
    spent: false,
    pending: false,
    cursor: {
      kind: "ordinary",
      payout: null,
      blockNumber: at.number.toString(),
      blockHash: at.hash,
      blockTimestamp: (1_800_000_000n + at.number * 12n).toString(),
      transactionId: hash(at.transactionByte ?? commitmentByte),
      outputIndex: outputIndex.toString(),
    },
  };
}

describe("wallet inventory", () => {
  it("creates a network-bound inventory without profile secrets", () => {
    const data = emptyWalletFile();
    expect(data.address).toBe("0x0000000000000000000000000000000000000abc");
    expect(data.network).toEqual({
      chainId: PCASH_CHAIN_ID.toString(),
      genesisHash: NETWORK.genesisHash,
    });
    expect(data.receiveKeys).toEqual([]);
    expect(data).not.toHaveProperty("defaultUserRuleSecrets");
    expect(data.syncedThrough).toBeUndefined();
    expect(data.nextOutputIndex).toBeUndefined();
  });

  it("advances the direct-L1 account activation journal", () => {
    const data = emptyWalletFile();
    const pending = {
      contentHash: hash(0xaa),
      transactionHex: "0x0201",
      publication: "self" as const,
      address: `0x${"12".repeat(20)}`,
      pcashChainId: PCASH_CHAIN_ID.toString(),
      pcashGenesisHash: NETWORK.genesisHash,
      l1ChainId: "11155111",
      inboxAddress: `0x${"50".repeat(20)}`,
      genesisL1Block: "1",
      genesisL1BlockHash: hash(0x99),
      ruleSetCommitment: "1",
      receiveKeyHash: hash(0x98),
      recentPcashBlockNumber: "2",
      recentPcashBlockHash: hash(0xbb),
      validUntilTimestamp: "200",
      state: "prepared" as const,
      l1TxHash: null,
      preparedAtUnixMs: "100",
    };
    addPendingUserAccountCreation(data, pending);
    markPendingUserAccountCreationBroadcastRequested(data, pending.address);
    markPendingUserAccountCreationPrepared(data, pending.address);
    markPendingUserAccountCreationSubmitted(data, pending.address, hash(0xcc));
    expect(data.pendingUserAccountCreations).toEqual([{
      ...pending,
      state: "l1-submitted",
      l1TxHash: hash(0xcc),
    }]);
  });

  it("retains each receive key once and restores every pair from the stored form", () => {
    const data = emptyWalletFile();
    const first = generateMlKemKeyPair(new Uint8Array(64).fill(0x31));
    const second = generateMlKemKeyPair(new Uint8Array(64).fill(0x32));
    expect(retainReceiveKeyPair(data, first)).toBe(true);
    expect(retainReceiveKeyPair(data, second)).toBe(true);
    expect(retainReceiveKeyPair(data, first)).toBe(false);

    expect(receiveKeyPairs(clone(data))).toEqual([first, second]);
  });
});

describe("dense private-output inventory", () => {
  it.each([5, 6])("keeps a pending L output at slot %i separate from a system payout", (outputIndex) => {
    const data = emptyWalletFile();
    const ordinary = note(0x31, 30n, { number: 1n, hash: hash(1), transactionByte: 0xaa, outputIndex });
    addPendingNote(data, hash(0xaa), {
      outputIndex, assetId: 0n, amount: 30n, owner: ADDRESS, noteSecret: 0x31n,
    });
    const payout = note(0x32, 4n, { number: 1n, hash: hash(1), transactionByte: 0xaa, outputIndex });
    payout.cursor!.kind = "system";
    mergeRecoveredWalletNotes(data, [payout]);
    expect(data.notes.filter(note => note.pending)).toHaveLength(1);
    mergeRecoveredWalletNotes(data, [ordinary]);
    expect(data.notes).toEqual([payout, ordinary]);
  });

  it("keys pending outputs by exact transaction position", () => {
    const data = emptyWalletFile();
    const txOne = hash(0xd0);
    const txTwo = hash(0xd1);
    const opening = {
      outputIndex: 2,
      assetId: 7n,
      amount: 9n,
      owner: ADDRESS,
      noteSecret: 0xd2n,
    };

    addPendingNote(data, txOne, opening);
    addPendingNote(data, txOne, opening);
    expect(data.notes).toHaveLength(1);
    expect(() => addPendingNote(data, txOne, { ...opening, amount: 10n }))
      .toThrow(/different note fields/);

    addPendingNote(data, txTwo, opening);
    expect(data.notes).toHaveLength(2);
    expect(data.notes.map((value) => value.pendingContentHash)).toEqual([txOne, txTwo]);
  });
});

describe("asset definitions", () => {
  const metadata = { name: "Ruled Token", symbol: "RUL", decimals: 2, contentDigest: new Uint8Array(32).fill(5) };
  const standard = senderDenyListTransferRule({ contractAddress: 0x5fbdb2315678afecb367f032d93f642f64180aa3n, listId: new Uint8Array(32).fill(9), maxDelta: 7_200n });
  // One asset per rule; its definitions differ only in the configuration, which the asset ID does not commit to.
  const asset = (rule: typeof standard) => {
    const created = createAccountMintAsset({ metadata, accountAddress: 0xabcn, transferRule: rule });
    return (configuration: Uint8Array) => ({
      assetId: created.descriptor.assetId,
      definition: assetDefinitionOf(created.descriptor, metadata, { mintRule: created.definition.mintRule.configuration, transferRule: configuration }),
    });
  };
  // A definition of the same asset whose mint rule carries another configuration under the same VK hashes and commitment.
  const withMintConfiguration = (definition: AssetDefinition, configuration: Uint8Array): AssetDefinition =>
    ({ ...definition, mintRule: { ...definition.mintRule, configuration } });
  const fixedSupplySecret = 0x77n;
  // Each standard mint rule's genuine definition and a well-formed configuration that does not open its commitment.
  const standardMintRules = [
    ["fixed-supply", deriveFixedSupplyAsset({ metadata, supply: 10n, secret: fixedSupplySecret }).definition,
      encodeFixedSupplyConfiguration({ supply: 11n, secretCommitment: fixedSupplySecretCommitment(fixedSupplySecret) })],
    ["account-mint", createAccountMintAsset({ metadata, accountAddress: ADDRESS, startSalt: 0n }).definition,
      encodeAccountMintConfiguration({ accountAddress: ADDRESS + 1n })],
  ] as const;

  it("records a standard-rule definition only when its configuration opens the commitment", () => {
    const data = emptyWalletFile();
    const define = asset(standard);
    expect(addWalletAsset(data, define(new Uint8Array(60).fill(1)))).toBe(false);
    expect(addWalletAsset(data, define(standard.configuration.subarray(0, 52)))).toBe(false);
    expect(data.assets).toBeUndefined();
    const genuine = define(standard.configuration);
    expect(addWalletAsset(data, genuine)).toBe(true);
    expect(knownAssetDefinition(data, genuine.assetId)).toEqual(genuine.definition);
  });

  it.each(standardMintRules)("records a %s definition only when its mint rule configuration opens the commitment", (_kind, genuine, other) => {
    const data = emptyWalletFile();
    const assetId = assetDefinitionAssetId(genuine);
    for (const configuration of [other, genuine.mintRule.configuration.subarray(1)]) {
      const definition = withMintConfiguration(genuine, configuration);
      expect(assetDefinitionAssetId(definition)).toBe(assetId);
      expect(addWalletAsset(data, { assetId, definition })).toBe(false);
    }
    expect(data.assets).toBeUndefined();
    expect(addWalletAsset(data, { assetId, definition: genuine })).toBe(true);
    expect(knownAssetDefinition(data, assetId)).toEqual(genuine);
  });

  it.each(standardMintRules)("imports a %s definition only when its mint rule configuration opens the commitment", async (_kind, genuine, other) => {
    const networkConfig = { pcashChainId: PCASH_CHAIN_ID, l1ChainId: 11_155_111n, inboxAddress: `0x${"66".repeat(20)}` };
    const profile = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(7), networkConfig);
    const status = testStatus({ pcashChainId: Number(PCASH_CHAIN_ID), genesisHash: NETWORK.genesisHash });
    const store = memoryWalletStateStore(makeEmptyWalletFile({ address: profile.address, network: NETWORK }));
    const database: WalletDatabase = { [WALLET_DATABASE_STATE_STORE]: () => store, subscribe: async () => async () => {}, close: async () => {} };
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database, node: { status: async () => status } as unknown as PcashNodeClient, profile });
    try {
      const forged = withMintConfiguration(genuine, other);
      for (const input of [forged, formatAssetDefinition(forged)]) {
        await expect(wallet.importAssetDefinition(input))
          .rejects.toThrow("the definition's mint rule configuration does not open its commitment");
      }
      expect(store.snapshot()?.assets).toBeUndefined();
      const assetId = assetDefinitionAssetId(genuine);
      expect(await wallet.importAssetDefinition(genuine)).toEqual({ assetId });
      expect(knownAssetDefinition(store.snapshot(), assetId)).toEqual(genuine);
    } finally {
      await wallet.close();
    }
  });

  it("replaces a scan-learned definition of another rule with an imported one", async () => {
    // The standard S key beside another L key is not the standard rule, so the asset ID does not fix its configuration bytes.
    const custom = asset({ ...standard, lVkHash: standard.lVkHash + 1n });
    const learned = custom(new Uint8Array(60).fill(1));
    const shared = custom(new Uint8Array(60).fill(2));
    expect(shared.assetId).toBe(learned.assetId);
    const networkConfig = { pcashChainId: PCASH_CHAIN_ID, l1ChainId: 11_155_111n, inboxAddress: `0x${"66".repeat(20)}` };
    const profile = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(7), networkConfig);
    const data = makeEmptyWalletFile({ address: profile.address, network: NETWORK });
    expect(addWalletAsset(data, learned)).toBe(true);
    expect(addWalletAsset(data, shared)).toBe(false);
    expect(knownAssetDefinition(data, learned.assetId)).toEqual(learned.definition);

    const status = testStatus({ pcashChainId: Number(PCASH_CHAIN_ID), genesisHash: NETWORK.genesisHash });
    const store = memoryWalletStateStore(data);
    const database: WalletDatabase = { [WALLET_DATABASE_STATE_STORE]: () => store, subscribe: async () => async () => {}, close: async () => {} };
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database, node: { status: async () => status } as unknown as PcashNodeClient, profile });
    try {
      expect(await wallet.importAssetDefinition(shared.definition)).toEqual({ assetId: shared.assetId });
      expect(knownAssetDefinition(store.snapshot(), shared.assetId)).toEqual(shared.definition);
      expect(store.snapshot()?.assets).toHaveLength(1);
    } finally {
      await wallet.close();
    }
  });

  it("records a definition of another rule with any configuration", () => {
    const data = emptyWalletFile();
    // The standard S key beside another L key is not the standard rule, so its configuration is opaque.
    const custom = asset({ ...standard, lVkHash: standard.lVkHash + 1n })(new Uint8Array(60).fill(1));
    expect(addWalletAsset(data, custom)).toBe(true);
    expect(knownAssetDefinition(data, custom.assetId)).toEqual(custom.definition);
    const [, { mintRule }] = standardMintRules[1];
    const customMint = findAssetDefinition({ metadata, mintRule: { ...mintRule, lVkHash: mintRule.lVkHash + 1n, configuration: new Uint8Array(20).fill(1) } }, 0n);
    const customMintId = assetDefinitionAssetId(customMint);
    expect(addWalletAsset(data, { assetId: customMintId, definition: customMint })).toBe(true);
    expect(knownAssetDefinition(data, customMintId)).toEqual(customMint);
  });
});
