// Deposit codes, finding a wallet's deposits from a vault's Ethereum logs, and
// minting one, against a fake Ethereum log reader and a fake node.

import { PRIVATE_VALUE_PROFILES } from "../../src/constants/privateValueProfiles.ts";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { AssetActionBuild } from "@pcash/sdk/builders";
import type { L1LogProofResult, PcashNodeClient } from "@pcash/sdk/clients";
import { privateValueProfile } from "@pcash/sdk/constants";
import { fieldToHex } from "@pcash/sdk/crypto";
import { privateKeyPcashActionSigner, type PcashActionSigner } from "@pcash/sdk/eip712";
import type { MintRuleApplication } from "@pcash/sdk/prover";
import {
  decodePayload,
  decodeTransaction,
  decryptEnvelope,
  encodePrivateValueTransaction,
  mintMarker,
  normalizedL1LogLeaf,
  normalizeL1Logs,
  privateValuePublicInputs,
  SlotClass,
  WIRE_PROOF_BYTES,
  type L1LogInput,
  type RawPrivateValueTransaction,
} from "@pcash/sdk/protocol";
import {
  createAccountMintAsset,
  createDepositMintAsset,
  decodeDepositCode,
  DEPOSIT_MINT_RULE_CIRCUIT,
  defaultUserAccountRuleSet,
  depositLog,
  depositReplayId,
  depositSalt,
} from "@pcash/sdk/rules";
import { addressHex, bytes32Hex } from "@pcash/sdk/utils";
import type { L1ListedLog, L1LogReader } from "../../src/wallet/denyListSync.ts";
import {
  createDepositCode,
  listDeposits as listDepositsWith,
  runDepositMintClient,
  type DepositScans,
  type WalletDeposit,
} from "../../src/wallet/actions/depositMintClient.ts";
import type { DurableSubmissionAdapter } from "../../src/wallet/actions/durableSubmission.ts";
import { derivePcashProfileFromPrivateKey, type PcashProfile } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { OPEN_WALLET_INTERNAL, Wallet } from "../../src/wallet/actions/walletClient.ts";
import { storedReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { emptyWalletState, WALLET_DATABASE_STATE_STORE, type WalletDatabase } from "../../src/wallet/store.ts";
import { anchoredChain, ChainSim } from "./chainFixture.ts";
import { testStatus } from "./statusFixture.ts";

const network = { pcashChainId: 0x1ff6n, l1ChainId: 11_155_111n, inboxAddress: `0x${"66".repeat(20)}` };
const genesisHash: Hex = `0x${"11".repeat(32)}`;
const privateKey = Uint8Array.from(Buffer.from("10112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"));
const otherKey = Uint8Array.from(Buffer.from("20112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"));
const wallet = derivePcashProfileFromPrivateKey(privateKey, network);
const other = derivePcashProfileFromPrivateKey(otherKey, network);
const chainId = network.pcashChainId;
const VAULT = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
const DEPOSITOR = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n;
const GENESIS_L1_BLOCK = 1_000n;
const metadata = { name: "Deposit Dollar", symbol: "DUSD", decimals: 6, contentDigest: new Uint8Array(32) };
const { definition: asset, descriptor } = createDepositMintAsset({ metadata, vault: VAULT, startSalt: 0n });

const hash = (tag: number, value: bigint) => `0x${tag.toString(16).padStart(2, "0")}${value.toString(16).padStart(62, "0")}` as Hex;

/** The vault's log for a deposit to `code`, listed as eth_getLogs lists it; its receipt-local index is one less than its block index. */
function deposited(code: string, amount: bigint, blockNumber: bigint, blockLogIndex = 3, pcashChainId = chainId): L1ListedLog {
  const { recipientCommitment, nonce } = decodeDepositCode(code, { pcashChainId, vault: VAULT });
  const log = depositLog({ vault: VAULT, depositor: DEPOSITOR, recipientCommitment, nonce, amount, transactionIndex: 4, logIndex: blockLogIndex - 1 });
  return {
    blockNumber, blockHash: hash(1, blockNumber), transactionHash: hash(2, blockNumber), transactionIndex: 4, blockLogIndex,
    emitter: VAULT, topics: log.topics, data: log.data,
  };
}

/**
 * An Ethereum reader over `logs` whose block hashes are `hash(chain.fork + 1,
 * number)` from `chain.forkFrom` on; it records the ranges it lists and the
 * transactions whose receipts it reads.
 */
function fakeReader(logs: readonly L1ListedLog[], head = 100_000n) {
  const chain = { fork: 0, forkFrom: 0n, ranges: [] as [bigint, bigint][], receipts: [] as Hex[] };
  const hashAt = (number: bigint) => hash(number >= chain.forkFrom ? chain.fork + 1 : 1, number);
  const reader: L1LogReader = {
    head: async () => ({ number: head, hash: hashAt(head) }),
    block: async (number) => number > head ? null : { number, hash: hashAt(number) },
    logs: async ({ address, topics, fromBlock, toBlock }) => {
      chain.ranges.push([fromBlock, toBlock]);
      return logs.filter((log) => log.emitter === address && log.blockNumber >= fromBlock && log.blockNumber <= toBlock
        && topics.every((topic, index) => Buffer.from(topic).equals(log.topics[index]!)));
    },
    receiptLogIndex: async (log) => {
      chain.receipts.push(log.transactionHash);
      return log.blockLogIndex - 1;
    },
  };
  return Object.assign(chain, { reader });
}

/** `listDeposits` with a fresh scan cache unless `scans` is given. */
const listDeposits = (params: Omit<Parameters<typeof listDepositsWith>[0], "scans"> & { scans?: DepositScans }) =>
  listDepositsWith({ ...params, scans: params.scans ?? new Map() });

/**
 * The normalized logs of a block whose leaf `logIndex + 1` is `log`, as the
 * fake reader's blocks hold a deposit: one log before its receipt's first.
 */
function blockLogs(log: L1LogInput) {
  const leafIndex = Number(log.logIndex) + 1;
  const earlier = Array.from({ length: leafIndex }, (_, index) => ({
    transactionIndex: 0, logIndex: index, emitter: 1n, topics: [], data: new Uint8Array(),
  }));
  const tree = normalizeL1Logs([...earlier, log]);
  return { root: tree.root, count: BigInt(leafIndex + 1), leafIndex: BigInt(leafIndex), siblings: tree.proof(leafIndex) };
}

/** A node whose head derives Ethereum block GENESIS_L1_BLOCK + latestBlock and whose spent set holds `spent`. */
function fakeNode(params: { latestBlock?: bigint; spent?: readonly bigint[] } = {}) {
  const asked: string[][] = [];
  const spent = new Set<string>((params.spent ?? []).map((value) => bytes32Hex(value)));
  const status = testStatus({
    pcashChainId: Number(chainId), genesisHash, l1ChainId: network.l1ChainId, inboxAddress: network.inboxAddress,
    genesisL1Block: GENESIS_L1_BLOCK, latestBlock: params.latestBlock ?? 50n, latestBlockTimestamp: 500n,
  });
  const node = {
    status: async () => status,
    getWitnessSnapshot: async (query: { nullifiers: string[] }) => {
      asked.push(query.nullifiers);
      return { status, nullifiers: { statuses: query.nullifiers.map((nullifier) => ({ nullifier, spent: spent.has(nullifier) })) } };
    },
  } as unknown as PcashNodeClient;
  return { node, asked };
}

const markerOf = (owner: PcashProfile, deposit: WalletDeposit) => mintMarker(descriptor.assetId, depositReplayId(
  deposit.position.l1BlockNumber, deposit.position.blockLogIndex, depositSalt(owner.nkRoot, chainId, VAULT, deposit.nonce)));

describe("deposit codes", () => {
  it("commits to the chain, the asset and the wallet's address under a fresh nonce for the asset's vault", () => {
    const first = decodeDepositCode(createDepositCode({ asset, wallet, chainId }), { pcashChainId: chainId, vault: VAULT });
    const second = decodeDepositCode(createDepositCode({ asset, wallet, chainId }), { pcashChainId: chainId, vault: VAULT });
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.recipientCommitment).not.toBe(second.recipientCommitment);
  });

  it("refuses an asset that is not minted by deposit", () => {
    const accountMint = createAccountMintAsset({ metadata, accountAddress: wallet.address, startSalt: 0n }).definition;
    expect(() => createDepositCode({ asset: accountMint, wallet, chainId })).toThrow("this asset is not minted by deposit");
  });
});

describe("finding deposits", () => {
  const mine = [createDepositCode({ asset, wallet, chainId }), createDepositCode({ asset, wallet, chainId })];
  const theirs = createDepositCode({ asset, wallet: other, chainId });
  const malformed = { ...deposited(mine[0]!, 1n, 1_015n), data: new Uint8Array(64) };
  const logs = [
    deposited(mine[0]!, 25_000_000n, 1_010n),
    deposited(theirs, 7_000_000n, 1_020n),
    malformed,
    deposited(mine[1]!, 3_000_000n, 1_030n, 9),
    // Past the Ethereum block the node's head derives.
    deposited(mine[0]!, 1_000_000n, 1_051n),
  ];

  it("finds this wallet's deposits through the block PCASH has derived, and not another wallet's, reading no receipt", async () => {
    const source = fakeReader(logs);
    const deposits = await listDeposits({ reader: source.reader, node: fakeNode().node, wallet, chainId, asset });
    expect(deposits.map((deposit) => [deposit.position, deposit.amount, deposit.minted])).toEqual([
      [{ l1BlockNumber: 1_010n, l1BlockHash: hash(1, 1_010n), transactionIndex: 4, blockLogIndex: 3 }, 25_000_000n, false],
      [{ l1BlockNumber: 1_030n, l1BlockHash: hash(1, 1_030n), transactionIndex: 4, blockLogIndex: 9 }, 3_000_000n, false],
    ]);
    expect(deposits[0]!.depositor).toBe(DEPOSITOR);
    expect(deposits[0]!.transactionHash).toBe(hash(2, 1_010n));
    const others = await listDeposits({ reader: source.reader, node: fakeNode().node, wallet: other, chainId, asset });
    expect(others.map((deposit) => deposit.amount)).toEqual([7_000_000n]);
    expect(source.receipts).toEqual([]);
  });

  it("does not find a deposit to the same vault for another asset or another chain", async () => {
    const copycat = createDepositMintAsset({ metadata: { ...metadata, symbol: "COPY" }, vault: VAULT, startSalt: 0n }).definition;
    const forCopycat = deposited(createDepositCode({ asset: copycat, wallet, chainId }), 2_000_000n, 1_040n);
    const forOtherChain = deposited(createDepositCode({ asset, wallet, chainId: chainId + 1n }), 4_000_000n, 1_041n, 3, chainId + 1n);
    const { reader } = fakeReader([...logs, forCopycat, forOtherChain]);
    expect((await listDeposits({ reader, node: fakeNode().node, wallet, chainId, asset })).map((deposit) => deposit.amount))
      .toEqual([25_000_000n, 3_000_000n]);
    expect((await listDeposits({ reader, node: fakeNode().node, wallet, chainId, asset: copycat })).map((deposit) => deposit.amount))
      .toEqual([2_000_000n]);
  });

  it("reads minted from the node's spent set, asking only for this wallet's markers", async () => {
    const { reader } = fakeReader(logs);
    const unminted = await listDeposits({ reader, node: fakeNode().node, wallet, chainId, asset });
    const { node, asked } = fakeNode({ spent: [markerOf(wallet, unminted[0]!)] });
    const deposits = await listDeposits({ reader, node, wallet, chainId, asset });
    expect(deposits.map((deposit) => deposit.minted)).toEqual([true, false]);
    expect(asked).toEqual([unminted.map((deposit) => bytes32Hex(markerOf(wallet, deposit)))]);
  });

  it("finds the same deposits in a wallet restored from its key, with no local state", async () => {
    const { reader } = fakeReader(logs);
    const restored = derivePcashProfileFromPrivateKey(privateKey, network);
    expect(await listDeposits({ reader, node: fakeNode().node, wallet: restored, chainId, asset }))
      .toEqual(await listDeposits({ reader, node: fakeNode().node, wallet, chainId, asset }));
  });

  it("reads the vault in ranges of 10,000 blocks up to the derived block or the Ethereum head", async () => {
    const derived = fakeReader([]);
    await listDeposits({ reader: derived.reader, node: fakeNode({ latestBlock: 25_000n }).node, wallet, chainId, asset });
    expect(derived.ranges).toEqual([[1_000n, 10_999n], [11_000n, 20_999n], [21_000n, 26_000n]]);
    const lagging = fakeReader([], 1_500n);
    await listDeposits({ reader: lagging.reader, node: fakeNode({ latestBlock: 25_000n }).node, wallet, chainId, asset });
    expect(lagging.ranges).toEqual([[1_000n, 1_500n]]);
  });

  it("reads only blocks after the last listing, and the minted status of every deposit again", async () => {
    const later = deposited(mine[1]!, 5_000_000n, 1_055n);
    const source = fakeReader([...logs, later]);
    const scans: DepositScans = new Map();
    expect((await listDeposits({ reader: source.reader, node: fakeNode().node, wallet, chainId, asset, scans }))
      .map((deposit) => deposit.amount)).toEqual([25_000_000n, 3_000_000n]);
    expect(source.ranges).toEqual([[1_000n, 1_050n]]);
    expect(await listDeposits({ reader: source.reader, node: fakeNode().node, wallet, chainId, asset, scans })).toHaveLength(2);
    expect(source.ranges).toEqual([[1_000n, 1_050n]]);
    const { node, asked } = fakeNode({ latestBlock: 60n });
    const deposits = await listDeposits({ reader: source.reader, node, wallet, chainId, asset, scans });
    expect(deposits.map((deposit) => deposit.amount)).toEqual([25_000_000n, 3_000_000n, 1_000_000n, 5_000_000n]);
    expect(source.ranges).toEqual([[1_000n, 1_050n], [1_051n, 1_060n]]);
    expect(asked).toEqual([deposits.map((deposit) => bytes32Hex(markerOf(wallet, deposit)))]);
    // Another asset's listing starts from the genesis block.
    const copycat = createDepositMintAsset({ metadata: { ...metadata, symbol: "COPY" }, vault: VAULT, startSalt: 0n }).definition;
    await listDeposits({ reader: source.reader, node: fakeNode({ latestBlock: 60n }).node, wallet, chainId, asset: copycat, scans });
    expect(source.ranges.at(-1)).toEqual([1_000n, 1_060n]);
  });

  it("reads the vault again from the genesis block once the last block it read is no longer canonical", async () => {
    const source = fakeReader(logs);
    const scans: DepositScans = new Map();
    await listDeposits({ reader: source.reader, node: fakeNode().node, wallet, chainId, asset, scans });
    source.fork = 1;
    source.forkFrom = 1_045n;
    const { node } = fakeNode({ latestBlock: 60n });
    expect((await listDeposits({ reader: source.reader, node, wallet, chainId, asset, scans })).map((deposit) => deposit.amount))
      .toEqual([25_000_000n, 3_000_000n, 1_000_000n]);
    expect(source.ranges).toEqual([[1_000n, 1_050n], [1_000n, 1_060n]]);
    expect(scans.get(descriptor.assetId)?.scannedHash).toBe(hash(2, 1_060n));
  });

  it("refuses an asset that is not minted by deposit", async () => {
    const accountMint = createAccountMintAsset({ metadata, accountAddress: wallet.address, startSalt: 0n }).definition;
    await expect(listDeposits({ reader: fakeReader(logs).reader, node: fakeNode().node, wallet, chainId, asset: accountMint }))
      .rejects.toThrow("this asset is not minted by deposit");
  });
});

describe("minting a deposit", () => {
  const rules = defaultUserAccountRuleSet({ wallet, network, secrets: wallet.defaultUserRuleSecrets });
  const chain = anchoredChain({ accounts: [{
    address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
    accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: wallet.mlKemPublicKey,
  }] });
  const store = () => memoryWalletStateStore({
    address: addressHex(wallet.address), network: { chainId: chainId.toString(), genesisHash },
    receiveKeys: [storedReceiveKeyPair({ publicKey: wallet.mlKemPublicKey, secretKey: wallet.mlKemSecretKey })], notes: [],
  }, chain.records);
  const code = createDepositCode({ asset, wallet, chainId });
  const listed = deposited(code, 25_000_000n, 1_010n);
  const theirs = deposited(createDepositCode({ asset, wallet: other, chainId }), 7_000_000n, 1_020n);

  function mintNode(spent: readonly bigint[] = []) {
    const { node, asked } = fakeNode({ spent });
    const proofs: { args: [bigint, bigint | number, bigint | number, bigint | number]; log: L1LogInput }[] = [];
    Object.assign(node, {
      getIssuanceQuote: async () => { throw new Error("fee planning reads no issuance quote"); },
      estimateFee: async () => { throw new Error("a fee-less action needs no fee estimate"); },
      getReceipt: async () => [],
      getMempoolTransaction: async () => null,
      getL1LogProof: async (anchor: bigint, l1BlockNumber: bigint, transactionIndex: number, logIndex: number, log: L1LogInput): Promise<L1LogProofResult> => {
        proofs.push({ args: [anchor, l1BlockNumber, transactionIndex, logIndex], log });
        const block = blockLogs(log);
        return {
          recentPcashBlockHash: anchor, l1OriginRoot: 0n, l1OriginRootSiblings: [0n, 0n, 0n, 0n], l1BlockNumber: BigInt(l1BlockNumber),
          l1BlockHash: new Uint8Array(32).fill(0xb0), l1BlockTimestamp: 400n, l1LogsRoot: block.root, l1LogCount: block.count, l1OriginIndex: 10n,
          l1OriginSiblings: Array<bigint>(40).fill(0n), boundary: chain.boundary, logLeafIndex: block.leafIndex, logSiblings: block.siblings,
          transactionIndex: BigInt(transactionIndex), logIndex: BigInt(logIndex),
        };
      },
    });
    return { node, asked, proofs };
  }
  const submission: DurableSubmissionAdapter<string, string> = {
    mode: "mempool",
    preflight: async () => "prepared",
    submit: async () => ({ accepted: false, queued: true, output: "queued" }),
  };
  async function mint(
    node: PcashNodeClient,
    deposit: WalletDeposit,
    signer: PcashActionSigner = privateKeyPcashActionSigner(privateKey),
    source = fakeReader([]),
  ) {
    const builds: AssetActionBuild[] = [];
    const mintRules: MintRuleApplication[] = [];
    const walletStore = store();
    const result = await runDepositMintClient({
      reader: source.reader, node, store: walletStore, wallet, signer, chainId, asset, deposit,
      prover: { shapes: [PRIVATE_VALUE_PROFILES.S.shapeId], proveAndEncode: async (build, _authorization, mintRule) => {
        builds.push(build);
        mintRules.push(mintRule);
        return encodePrivateValueTransaction({ publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES),
          outputData: build.outputData, arena: build.arena });
      } },
      submission, settlePollMaxAttempts: 1, settlePollIntervalMs: 0,
    });
    return { result, builds, mintRules, walletStore };
  }
  const depositOf = async (log: L1ListedLog, owner: PcashProfile) =>
    (await listDeposits({ reader: fakeReader([log]).reader, node: fakeNode().node, wallet: owner, chainId, asset }))[0]!;

  it("mints the deposited amount to the wallet under one marker, opening the vault's log under the action's anchor", async () => {
    const deposit = await depositOf(listed, wallet);
    const { node, proofs } = mintNode();
    const source = fakeReader([]);
    const { result, builds, mintRules, walletStore } = await mint(node, deposit, undefined, source);
    // One receipt read, for the log's index within its receipt.
    expect(source.receipts).toEqual([listed.transactionHash]);
    const build = builds[0]!;
    expect(result.assetId).toBe(descriptor.assetId);
    expect(build.transaction.inputs.filter((input) => input.slotClass === SlotClass.MINT).map((input) => input.nullifier))
      .toEqual([markerOf(wallet, deposit)]);
    expect(build.transaction.outputs.filter((output) => output.slotClass === SlotClass.ASSET)).toHaveLength(1);
    expect(decodePayload(decryptEnvelope(wallet.mlKemSecretKey, build.outputData[0]!)!, { chainId })).toMatchObject({
      amount: 25_000_000n, assetId: descriptor.assetId,
    });
    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.args).toEqual([chain.boundary.blockHash, 1_010n, 4, 2]);
    expect(normalizedL1LogLeaf(proofs[0]!.log)).toBe(normalizedL1LogLeaf({ ...listed, transactionIndex: 4, logIndex: 2 }));
    expect(mintRules.map((rule) => rule.packageName)).toEqual([DEPOSIT_MINT_RULE_CIRCUIT]);
    expect(mintRules[0]!.witnessMap.recipient_address).toBe(fieldToHex(wallet.address));
    expect(mintRules[0]!.witnessMap.account_address).toBe(fieldToHex(wallet.address));
    expect(walletStore.snapshot()?.pendingAssetActions?.[0]?.ownedOutputs).toEqual([{
      outputIndex: 0, assetId: fieldToHex(descriptor.assetId), owner: addressHex(wallet.address),
      noteSecret: fieldToHex(build.outputNoteSecrets[0]!), amount: "25000000",
    }]);
  });

  it("refuses a deposit whose marker is spent before reading anything else", async () => {
    const deposit = await depositOf(listed, wallet);
    const { node, proofs } = mintNode([markerOf(wallet, deposit)]);
    const source = fakeReader([]);
    await expect(mint(node, deposit, undefined, source)).rejects.toThrow("this deposit is already minted");
    expect(proofs).toEqual([]);
    expect(source.receipts).toEqual([]);
  });

  it("refuses another wallet's deposit before asking for a signature", async () => {
    const deposit = await depositOf(theirs, other);
    const signer = privateKeyPcashActionSigner(privateKey);
    let signatures = 0;
    const counting: PcashActionSigner = { ...signer, signTypedData: async (...args: Parameters<typeof signer.signTypedData>) => {
      signatures += 1;
      return signer.signTypedData(...args);
    } };
    await expect(mint(mintNode().node, deposit, counting))
      .rejects.toThrow("the deposit's recipient commitment does not open to the chain, asset, recipient and salt");
    expect(signatures).toBe(0);
  });
});

describe("wallet deposit API", () => {
  /**
   * A wallet over a simulated chain whose account has a registered receive key,
   * an Ethereum reader holding `logs`, and a node that opens any log and reads
   * the spent set of the transactions the simulator included.
   */
  function setting() {
    const sim = new ChainSim(chainId, network);
    const rules = defaultUserAccountRuleSet({ wallet, network, secrets: wallet.defaultUserRuleSecrets });
    sim.addBlock({ accounts: [{ address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: wallet.mlKemPublicKey }] });
    const logs: L1ListedLog[] = [];
    const spent = new Set<string>();
    const client = sim.client();
    const node = Object.assign(Object.create(client), {
      getWitnessSnapshot: async (query: { nullifiers: string[] }) => ({
        status: sim.status(), nullifiers: { statuses: query.nullifiers.map((nullifier) => ({ nullifier, spent: spent.has(nullifier) })) },
      }),
      getL1LogProof: async (anchor: bigint, l1BlockNumber: bigint, transactionIndex: number, logIndex: number, log: L1LogInput) => {
        const block = blockLogs(log);
        return {
          recentPcashBlockHash: anchor, l1OriginRoot: 0n, l1OriginRootSiblings: [0n, 0n, 0n, 0n], l1BlockNumber,
          l1BlockHash: new Uint8Array(32), l1BlockTimestamp: 0n, l1LogsRoot: block.root, l1LogCount: block.count, l1OriginIndex: l1BlockNumber,
          l1OriginSiblings: Array<bigint>(40).fill(0n), logLeafIndex: block.leafIndex, logSiblings: block.siblings,
          transactionIndex: BigInt(transactionIndex), logIndex: BigInt(logIndex),
        };
      },
    }) as PcashNodeClient;
    const submitted: Uint8Array[] = [];
    const include = (entry: Uint8Array) => {
      const decoded = decodeTransaction(entry) as RawPrivateValueTransaction;
      const profile = privateValueProfile(decoded.shape);
      for (const nullifier of privateValuePublicInputs(decoded).slice(profile.offsets.nullifiers, profile.offsets.nullifiers + profile.inputs)) {
        spent.add(bytes32Hex(nullifier));
      }
      sim.include(entry);
    };
    const open = (l1Logs?: L1LogReader) => {
      const store = memoryWalletStateStore(emptyWalletState({ address: wallet.address, network: { chainId, genesisHash: sim.genesisHash } }));
      const database: WalletDatabase = { [WALLET_DATABASE_STATE_STORE]: () => store, subscribe: async () => async () => {}, close: async () => {} };
      return Wallet[OPEN_WALLET_INTERNAL]({
        database, node, profile: wallet, signer: privateKeyPcashActionSigner(privateKey),
        submission: { mode: "mempool", preflight: async () => "prepared", submit: async ({ transactionBytes }) => {
          submitted.push(transactionBytes);
          return { accepted: false, queued: true, output: "queued" };
        } },
        provers: { assetCreation: { shapes: [PRIVATE_VALUE_PROFILES.S.shapeId], proveAndEncode: async (build) => build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)) } },
        ...(l1Logs === undefined ? {} : { l1Logs }),
        settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
      });
    };
    return { sim, logs, submitted, include, open, reader: () => fakeReader(logs, 10n).reader };
  }

  it("mints a deposit to a code it gave out, and a wallet restored with no local state finds the deposit and the note", async () => {
    const { sim, logs, submitted, include, open, reader } = setting();
    const first = await open(reader());
    let found: WalletDeposit[];
    try {
      logs.push(deposited(first.createDepositCode({ asset }), 25_000_000n, 1n));
      const [deposit, ...rest] = await first.listDeposits({ asset });
      expect(rest).toEqual([]);
      expect(deposit!.minted).toBe(false);
      await first.mintDeposit({ asset, deposit: deposit! });
      expect(submitted).toHaveLength(1);
      include(submitted[0]!);
      sim.addBlock({});
      await first.sync();
      expect(await first.balances({ assetId: descriptor.assetId })).toEqual([
        { assetId: descriptor.assetId, private: 25_000_000n, spendable: 25_000_000n },
      ]);
      found = await first.listDeposits({ asset });
      expect(found.map((item) => item.minted)).toEqual([true]);
    } finally {
      await first.close();
    }
    const restored = await open(reader());
    try {
      await restored.sync();
      expect((await restored.balances({ assetId: descriptor.assetId }))[0]?.private).toBe(25_000_000n);
      expect((await restored.assets()).map((item) => item.definition?.mintRule.configuration)).toContainEqual(asset.mintRule.configuration);
      expect(await restored.listDeposits({ asset })).toEqual(found);
    } finally {
      await restored.close();
    }
  });

  it("needs an Ethereum reader to find or mint deposits", async () => {
    const { open, logs, reader } = setting();
    logs.push(deposited(createDepositCode({ asset, wallet, chainId }), 25_000_000n, 1n));
    const withReader = await open(reader());
    const [deposit] = await withReader.listDeposits({ asset });
    await withReader.close();
    const offline = await open();
    try {
      await expect(offline.listDeposits({ asset })).rejects.toThrow("finding deposits needs an Ethereum connection");
      await expect(offline.mintDeposit({ asset, deposit: deposit! })).rejects.toThrow("minting a deposit needs an Ethereum connection");
      expect(decodeDepositCode(offline.createDepositCode({ asset }), { pcashChainId: chainId, vault: VAULT }).nonce).toBeGreaterThan(0n);
    } finally {
      await offline.close();
    }
  });
});
