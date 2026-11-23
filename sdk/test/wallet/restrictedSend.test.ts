import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Address, type Hex } from "viem";
import type { AssetActionBuild } from "@pcash/sdk/builders";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import {
  assetDefinitionAssetId,
  generateMlKemKeyPair,
  L1_LOG_TREE_DEPTH,
  nullifierKeyCommitment,
  WIRE_PROOF_BYTES,
} from "@pcash/sdk/protocol";
import {
  buildDenyListTree,
  createAccountMintAsset,
  defaultUserAccountRuleSet,
  LIST_CHANGED_TOPIC0,
  PUBLICATION_TOPIC0,
  senderDenyListTransferRule,
} from "@pcash/sdk/rules";
import { addressHex, fromHex, randomFieldEntropy } from "@pcash/sdk/utils";
import type { DurableSubmissionAdapter } from "../../src/wallet/actions/durableSubmission.ts";
import { OPEN_WALLET_INTERNAL, Wallet } from "../../src/wallet/actions/walletClient.ts";
import type { L1ListedLog, L1LogReader } from "../../src/wallet/denyListSync.ts";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { addWalletAsset } from "../../src/wallet/noteStore.ts";
import { emptyWalletState, WALLET_DATABASE_STATE_STORE, type WalletDatabase } from "../../src/wallet/store.ts";
import { requireReceiveKeys } from "../../src/wallet/wallet.ts";
import { ChainSim } from "./chainFixture.ts";
import { deriveTestWallet } from "./testWallet.ts";

const CHAIN_ID = 0x1ff6n;
const NETWORK = { pcashChainId: CHAIN_ID, l1ChainId: 11_155_111n, inboxAddress: `0x${"66".repeat(20)}` };
const PRIVATE_KEY = new Uint8Array(randomBytes(32));
const profile = derivePcashProfileFromPrivateKey(PRIVATE_KEY, NETWORK);
const signer = privateKeyPcashActionSigner(PRIVATE_KEY);
const recipient = requireReceiveKeys(deriveTestWallet({
  privKey: new Uint8Array(randomBytes(32)), nkRoot: randomFieldEntropy(), mlKem: generateMlKemKeyPair(),
}));

const configuration = { contractAddress: 0x5fbdb2315678afecb367f032d93f642f64180aa3n, listId: new Uint8Array(32).fill(9), maxDelta: 7_200n };
const rule = senderDenyListTransferRule(configuration);
const metadata = { name: "Screened", symbol: "SCR", decimals: 2, contentDigest: new Uint8Array(32).fill(3) };
const { definition } = createAccountMintAsset({
  metadata, accountAddress: 0x0c0ffee000000000000000000000000000000001n, transferRule: rule, startSalt: 0n,
});
const assetId = assetDefinitionAssetId(definition);

/** Ethereum through block 1,000, where block 1 denies one address and publishes the list. */
function l1Reader(): L1LogReader {
  const denied = 0xdeadn;
  const hash = (number: bigint) => `0x${number.toString(16).padStart(64, "0")}` as Hex;
  const log = (topic0: Uint8Array, blockLogIndex: number, data: Hex): L1ListedLog => ({
    blockNumber: 1n, blockHash: hash(1n), transactionHash: hash(0xabcn), transactionIndex: 0, blockLogIndex,
    emitter: configuration.contractAddress, topics: [topic0, configuration.listId], data: fromHex(data),
  });
  const logs = [
    log(LIST_CHANGED_TOPIC0, 0, encodeAbiParameters([{ type: "address[]" }, { type: "address[]" }],
      [[`0x${denied.toString(16).padStart(40, "0")}` as Address], []])),
    log(PUBLICATION_TOPIC0, 1, encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint64" }],
      [buildDenyListTree([denied]).root, false, 3_600n])),
  ];
  return {
    head: async () => ({ number: 1_000n, hash: hash(1_000n) }),
    block: async (number) => number > 1_000n ? null : { number, hash: hash(number) },
    logs: async ({ topics, fromBlock, toBlock }) => logs.filter((item) => item.topics[0]!.every((byte, index) => byte === topics[0]![index])
      && item.blockNumber >= fromBlock && item.blockNumber <= toBlock),
    receiptLogIndex: async (item) => item.blockLogIndex,
  };
}

/**
 * A wallet holding 100 units of the restricted asset and 1,000 of PCASH, whose
 * node records each publication opening it serves and whose prover and
 * submission record each send.
 */
async function restrictedWallet(options: { definitionKnown: boolean }) {
  const sim = new ChainSim(CHAIN_ID, NETWORK);
  const rules = defaultUserAccountRuleSet({ wallet: profile, network: NETWORK, secrets: profile.defaultUserRuleSecrets });
  sim.addBlock({
    accounts: [
      { address: addressHex(profile.address), nullifierKeyCommitment: profile.nullifierKeyCommitment,
        accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: profile.mlKemPublicKey },
      { address: addressHex(recipient.address), nullifierKeyCommitment: nullifierKeyCommitment(recipient.nkRoot),
        accountRuleSetCommitment: 7n, receiveKey: recipient.mlKemPublicKey },
    ],
    transactions: [{ outputs: [
      { owner: profile.address, receiveKey: profile.mlKemPublicKey, amount: 100n, assetId },
      { owner: profile.address, receiveKey: profile.mlKemPublicKey, amount: 1_000n },
      null, null, null,
    ] }],
  });

  const proofRequests: bigint[] = [];
  const client = sim.client();
  const node = Object.assign(Object.create(client), {
    async getL1LogProof(anchorHash: bigint, l1BlockNumber: bigint, transactionIndex: number, logIndex: number) {
      proofRequests.push(anchorHash);
      return {
        recentPcashBlockHash: anchorHash, l1OriginRoot: 0n, l1OriginRootSiblings: Array(4).fill(0n), l1BlockNumber,
        l1BlockHash: new Uint8Array(32), l1BlockTimestamp: sim.status().latestBlockTimestamp, l1OriginIndex: 1n,
        l1OriginSiblings: Array(40).fill(0n), l1LogsRoot: 0n, l1LogCount: 2n, logLeafIndex: 1n,
        logSiblings: Array(L1_LOG_TREE_DEPTH).fill(0n), transactionIndex: BigInt(transactionIndex), logIndex: BigInt(logIndex),
      };
    },
  }) as PcashNodeClient;
  const data = emptyWalletState({ address: profile.address, network: { chainId: CHAIN_ID, genesisHash: sim.genesisHash } });
  if (options.definitionKnown) addWalletAsset(data, { assetId, definition });
  const store = memoryWalletStateStore(data);
  const database: WalletDatabase = { [WALLET_DATABASE_STATE_STORE]: () => store, subscribe: async () => async () => {}, close: async () => {} };
  const proofs: { build: AssetActionBuild; policy?: { packageName: string } }[] = [];
  const prover = {
    shapes: [0] as const,
    proveAndEncode: async (build: AssetActionBuild, _authorization: unknown, policy?: { packageName: string }) => {
      proofs.push({ build, ...(policy === undefined ? {} : { policy }) });
      return build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
    },
  };
  const submitted: Uint8Array[] = [];
  const submission: DurableSubmissionAdapter<string, string> = {
    mode: "mempool", preflight: async () => "prepared",
    submit: async ({ transactionBytes }) => {
      submitted.push(transactionBytes);
      return { accepted: false, queued: true, output: "queued" };
    },
  };
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
    database, node, profile, signer, submission, l1Logs: l1Reader(),
    provers: { assetAction: prover as never }, settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
  });
  const send = () => wallet.sendAsset({ assetId, outputs: [{ to: addressHex(recipient.address), amount: 40n }], openFeeAmount: 0n });
  return { sim, wallet, proofRequests, proofs, submitted, send };
}

describe("restricted asset send", () => {
  it("uses the opening its last sync fetched and requests none during the action", async () => {
    const { sim, wallet, proofRequests, proofs, submitted, send } = await restrictedWallet({ definitionKnown: true });
    try {
      await wallet.sync();
      expect(proofRequests).toEqual([sim.head.hash]);
      const syncedAnchor = sim.head.hash;

      // The tip moves; a synchronization before the send would anchor it at the new block.
      sim.addBlock({});
      await send();
      expect(submitted).toHaveLength(1);
      expect(proofRequests).toEqual([syncedAnchor]);
      expect(proofs[0]!.build.recentPcashBlockHash).toBe(syncedAnchor);
      expect(proofs[0]!.policy?.packageName).toBe("transfer_rule_sender_deny_list");

      await wallet.sync();
      expect(proofRequests).toEqual([syncedAnchor, sim.head.hash]);
    } finally {
      await wallet.close();
    }
  });

  it("sends right after an action's synchronization moved the anchor, with no sync between", async () => {
    const { sim, wallet, proofRequests, proofs, submitted, send } = await restrictedWallet({ definitionKnown: true });
    try {
      await wallet.sync();
      const syncedAnchor = sim.head.hash;
      sim.addBlock({});
      // Reading the receive code synchronizes the wallet to the new block.
      await wallet.receiveCode();
      expect(proofRequests).toEqual([syncedAnchor, sim.head.hash]);
      await send();
      expect(submitted).toHaveLength(1);
      expect(proofs[0]!.build.recentPcashBlockHash).toBe(sim.head.hash);
    } finally {
      await wallet.close();
    }
  });

  it("reads an imported definition's deny list at the current block, so a send needs no sync", async () => {
    const { sim, wallet, proofRequests, proofs, submitted, send } = await restrictedWallet({ definitionKnown: false });
    try {
      await wallet.sync();
      expect(proofRequests).toEqual([]);
      await wallet.importAssetDefinition(definition);
      expect(proofRequests).toEqual([sim.head.hash]);
      await send();
      expect(submitted).toHaveLength(1);
      expect(proofs[0]!.build.recentPcashBlockHash).toBe(sim.head.hash);
    } finally {
      await wallet.close();
    }
  });
});
