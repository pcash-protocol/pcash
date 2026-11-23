import { describe, expect, it } from "vitest";
import {
  getAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { assetDefinitionDescriptor, decodeAssetDefinition, encodeAssetDefinition, isRestrictedAssetId, memoSchema } from "@pcash/sdk/protocol";
import { createAccountMintAsset, encodeDepositCode, recognizeMintRule, recognizeTransferRule } from "@pcash/sdk/rules";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { bytes32Hex } from "@pcash/sdk/utils";
import { EthereumWriter } from "../src/ethereumWriter.ts";
import {
  memoryIssuerStateStore,
  redemptionKey,
  redemptionMemo,
  stablecoinDefinition,
  StablecoinIssuer,
  vaultRedemptionId,
  type IssuerStateStore,
} from "../src/issuer.ts";

const METADATA = { name: "Private USD", symbol: "pUSD", decimals: 6, contentDigest: new Uint8Array(32) };
const DENY_LIST = { contractAddress: 0x5fbdb2315678afecb367f032d93f642f64180aa3n, listId: new Uint8Array(32).fill(9), maxDelta: 7_200n };
const VAULT = "0x00000000000000000000000000000000000000c1";
const PAYOUT = getAddress("0x00000000000000000000000000000000000000d1");
const ZERO = "0x0000000000000000000000000000000000000000";

const PCASH_CHAIN_ID = 7;

const hash32 = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;

interface Inclusion { contentHash: string; nullifiers: string[]; l1Block: bigint }
interface BurnIntent {
  amount: bigint;
  retryContentHash?: string;
  settlePollMaxAttempts?: number;
  onPrepared?: (contentHash: string, transactionHex: string) => Promise<void>;
}

/**
 * One PCASH chain with its node and the issuer's wallet, and one Ethereum
 * chain with the vault. Inclusions land at an Ethereum block and are final at
 * or below `pcashFinalizedL1`. The wallet holds an attempt pending until it
 * lands in a finalized block or is expired.
 */
function harness() {
  const definition = stablecoinDefinition({ metadata: METADATA, vault: VAULT, denyList: DENY_LIST, startSalt: 0n });
  const assetId = assetDefinitionDescriptor(definition).assetId;
  let nextHash = 1;
  const pcash = {
    l1Head: 100n,
    finalizedL1: 100n,
    indexBehind: false,
    inclusions: [] as Inclusion[],
    include(contentHash: string, nullifiers: string[] = []) {
      pcash.l1Head += 1n;
      pcash.inclusions.push({ contentHash, nullifiers, l1Block: pcash.l1Head });
    },
    finalize() { pcash.finalizedL1 = pcash.l1Head; },
  };
  const node = {
    status: async () => ({
      pcashChainId: PCASH_CHAIN_ID,
      finalizedL1BlockNumber: pcash.finalizedL1,
      finalizedBlock: pcash.finalizedL1,
      index: { status: "ready", cursor: { blockNumber: pcash.indexBehind ? pcash.finalizedL1 - 1n : pcash.l1Head, blockHash: hash32(0) } },
    }),
    getReceipt: async (query: { contentHash?: string; nullifier?: string }) => pcash.inclusions
      .filter((inclusion) => query.contentHash !== undefined ? inclusion.contentHash === query.contentHash : inclusion.nullifiers.includes(query.nullifier!))
      .map((inclusion) => ({ contentHash: inclusion.contentHash, outcome: "succeeded", inclusion: { l1BlockNumber: inclusion.l1Block }, nullifiers: inclusion.nullifiers })),
    getWitnessSnapshot: async ({ nullifiers }: { nullifiers: string[] }) => ({
      nullifiers: { statuses: nullifiers.map((nullifier) => ({ spent: pcash.inclusions.some((inclusion) => inclusion.nullifiers.includes(nullifier)) })) },
    }),
  } as unknown as PcashNodeClient;

  const wallet = {
    pending: new Set<string>(),
    finalizedThrough: 50n as bigint | null,
    ownedNotes: [] as { leafIndex: bigint; amount: bigint }[],
    rows: [] as unknown[],
    burns: [] as { amount: bigint; contentHash: string; settlePollMaxAttempts?: number }[],
    resumed: [] as string[],
    /** The wallet calls the issuer made, in order. */
    calls: [] as string[],
    onBurn: (contentHash: string) => { pcash.include(contentHash, [hash32(0xb000 + nextHash)]); },
    expire(contentHash: string) { wallet.pending.delete(contentHash); },
    async sync() {
      wallet.calls.push("sync");
      for (const contentHash of wallet.pending) {
        if (pcash.inclusions.some((inclusion) => inclusion.contentHash === contentHash && inclusion.l1Block <= pcash.finalizedL1)) wallet.pending.delete(contentHash);
      }
      return {};
    },
    async snapshot() {
      return {
        pendingContentHashes: [...wallet.pending],
        finalizedThrough: wallet.finalizedThrough === null ? null : { pcashNumber: wallet.finalizedThrough, pcashHash: hash32(0) },
      };
    },
    async burnAsset(intent: BurnIntent) {
      if (intent.retryContentHash !== undefined) {
        wallet.resumed.push(intent.retryContentHash);
        return { contentHash: intent.retryContentHash, queued: false, settled: false };
      }
      const contentHash = hash32(nextHash++);
      await intent.onPrepared?.(contentHash, "0x");
      wallet.pending.add(contentHash);
      wallet.burns.push({
        amount: intent.amount, contentHash,
        ...(intent.settlePollMaxAttempts === undefined ? {} : { settlePollMaxAttempts: intent.settlePollMaxAttempts }),
      });
      wallet.onBurn(contentHash);
      return { contentHash, queued: false, settled: false };
    },
    async notes() { return wallet.ownedNotes; },
    async transactionData({ limit, offset }: { limit: number; offset: number }) { return wallet.rows.slice(offset, offset + limit); },
    async importAssetDefinition() {
      wallet.calls.push("import");
      return { assetId };
    },
  };

  const l1 = {
    head: 20n,
    finalized: 20n,
    paid: new Map<Hex, bigint>(),
    transactions: new Map<Hex, { mined: boolean; status: "success" | "reverted" }>(),
    payouts: [] as { to: Address; amount: bigint; redemptionId: Hex }[],
    /** Every vault write in the order it was sent. */
    writes: [] as { functionName: string; args: readonly unknown[] }[],
    reverts: new Set<string>(),
    /** The vault's credited commitment and nonce pairs, and the deposits its credits emitted. */
    credited: new Set<string>(),
    deposits: [] as { recipientCommitment: Hex; nonce: Hex; amount: bigint }[],
    /** The next write is replaced at its nonce by another transaction from the account. */
    replaceNext: false,
    replacedBy: new Map<Hex, Hex>(),
    /** This many receipt waits time out, after their transaction was mined. */
    receiptTimeouts: 0,
    /** What a payout does once sent; the default mines it in the next block. */
    onPayout: (hash: Hex, redemptionId: Hex) => {
      l1.head += 1n;
      l1.paid.set(redemptionId, l1.head);
      l1.transactions.set(hash, { mined: true, status: "success" });
    },
    finalize() { l1.finalized = l1.head; },
  };
  const publicClient = {
    getBlock: async ({ blockTag }: { blockTag: string }) => {
      if (blockTag !== "finalized") throw new Error("unexpected block tag");
      return { number: l1.finalized };
    },
    getBlockNumber: async () => l1.head,
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (l1.receiptTimeouts > 0) {
        l1.receiptTimeouts -= 1;
        throw new WaitForTransactionReceiptTimeoutError({ hash });
      }
      const transactionHash = l1.replacedBy.get(hash) ?? hash;
      return { status: l1.transactions.get(transactionHash)!.status, transactionHash };
    },
    readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: [Hex]; blockNumber?: bigint }) => {
      if (functionName !== "paidOut") throw new Error(`unexpected read ${functionName}`);
      const at = l1.paid.get(args[0]);
      return at !== undefined && (blockNumber === undefined || at <= blockNumber);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const transaction = l1.transactions.get(hash);
      if (transaction === undefined || !transaction.mined) throw new TransactionReceiptNotFoundError({ hash });
      return { status: transaction.status };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (!l1.transactions.has(hash)) throw new TransactionNotFoundError({ hash });
      return {};
    },
  } as unknown as PublicClient;
  let nextPayout = 1;
  const walletClient = {
    account: { address: "0x00000000000000000000000000000000000000e1" },
    chain: undefined,
    async writeContract({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) {
      if (address !== VAULT) throw new Error(`unexpected contract ${address}`);
      const creditPair = functionName === "credit" ? `${args[0]}:${args[1]}` : undefined;
      // Gas estimation fails for a pair the vault has credited, so nothing is sent.
      if (creditPair !== undefined && l1.credited.has(creditPair)) throw new Error("execution reverted: AlreadyCredited");
      l1.writes.push({ functionName, args });
      const hash = hash32(0xe000 + nextPayout++) as Hex;
      if (l1.replaceNext) {
        l1.replaceNext = false;
        const replacement = hash32(0xf000 + nextPayout++) as Hex;
        l1.head += 1n;
        l1.transactions.set(replacement, { mined: true, status: "success" });
        l1.replacedBy.set(hash, replacement);
        return hash;
      }
      if (creditPair !== undefined) {
        const [recipientCommitment, nonce, amount] = args as [Hex, Hex, bigint];
        l1.credited.add(creditPair);
        l1.deposits.push({ recipientCommitment, nonce, amount });
      }
      if (functionName === "payout") {
        const [to, amount, redemptionId] = args as [Address, bigint, Hex];
        l1.payouts.push({ to, amount, redemptionId });
        l1.onPayout(hash, redemptionId);
        return hash;
      }
      l1.head += 1n;
      l1.transactions.set(hash, { mined: true, status: l1.reverts.has(functionName) ? "reverted" : "success" });
      return hash;
    },
  } as unknown as WalletClient;

  const issuer = (store: IssuerStateStore, screen?: ConstructorParameters<typeof StablecoinIssuer>[0]["screen"]) => new StablecoinIssuer({
    wallet: wallet as never, node, definition,
    ethereum: { publicClient, writer: new EthereumWriter({ publicClient, walletClient }) }, store, ...(screen === undefined ? {} : { screen }),
  });

  let nextLeaf = 1_000n;
  /** A finalized-or-not row paying the issuer `amount` with `memo`, and the note it received. */
  const receive = (memo: string, amount: bigint, blockNumber = 10n) => {
    const leafIndex = nextLeaf;
    nextLeaf += 4n;
    const contentHash = hash32(0xa000 + Number(leafIndex));
    wallet.ownedNotes.push({ leafIndex, amount });
    wallet.rows.push({
      transactionId: hash32(0xc000 + Number(leafIndex)), contentHash, leafIndex: leafIndex.toString(), blockNumber: blockNumber.toString(),
      blockHash: hash32(0), timestamp: "0", received: [{ slot: 0, records: [memoSchema.encode(memo)] }], sent: [], self: [], public: [],
    });
    return redemptionKey(contentHash, 0);
  };

  return { definition, assetId, pcash, node, wallet, l1, issuer, receive };
}

const depositor = (n: number) => `0x00000000000000000000000000000000000000${n.toString(16).padStart(2, "0")}` as Address;

describe("stablecoin definition", () => {
  it("defines a restricted deposit-mint asset for the vault whose transfer rule is the standard deny list", () => {
    const definition = stablecoinDefinition({ metadata: METADATA, vault: VAULT, denyList: DENY_LIST, startSalt: 0n });
    const descriptor = assetDefinitionDescriptor(definition);
    expect(recognizeMintRule(definition.mintRule)).toEqual({ kind: "deposit-mint", configuration: { vault: BigInt(VAULT) } });
    expect(isRestrictedAssetId(descriptor.assetId)).toBe(true);
    const rule = recognizeTransferRule(definition.transferRule!);
    expect(rule.kind).toBe("sender-deny-list");
    expect(decodeAssetDefinition(encodeAssetDefinition(definition))).toEqual(definition);
  });

  it("takes its vault from the definition and refuses an asset of another mint rule", () => {
    const { issuer } = harness();
    expect(issuer(memoryIssuerStateStore()).vault).toBe(VAULT);
    const accountMint = createAccountMintAsset({ metadata: METADATA, accountAddress: 0xabcn, startSalt: 0n }).definition;
    expect(() => new StablecoinIssuer({
      wallet: {} as never, node: {} as never, definition: accountMint,
      ethereum: { publicClient: {} as never, writer: {} as never }, store: memoryIssuerStateStore(),
    })).toThrow("a stablecoin is a deposit-mint asset");
  });

  it("writes a redemption memo for a payout address", () => {
    expect(redemptionMemo("0xAbCdEf0000000000000000000000000000000001")).toBe("redeem 0xabcdef0000000000000000000000000000000001");
  });

  it("keys a redemption by content hash and slot", () => {
    expect(redemptionKey("0xAB", 2)).toBe("0xab:2");
    expect(vaultRedemptionId(redemptionKey("0xab", 2))).toBe(vaultRedemptionId(redemptionKey("0xAB", 2)));
    expect(vaultRedemptionId("0xab:1")).not.toBe(vaultRedemptionId("0xab:2"));
  });
});

describe("vault administration", () => {
  const code = (overrides: { pcashChainId?: bigint; vault?: bigint } = {}) => encodeDepositCode({
    pcashChainId: overrides.pcashChainId ?? BigInt(PCASH_CHAIN_ID), vault: overrides.vault ?? BigInt(VAULT),
    recipientCommitment: 0x1234n, nonce: 0x5678n,
  });

  it("credits the commitment and nonce a deposit code carries", async () => {
    const { l1, issuer } = harness();
    const service = issuer(memoryIssuerStateStore());
    await service.credit({ depositCode: code(), amount: 10n });
    expect(l1.writes).toEqual([{ functionName: "credit", args: [bytes32Hex(0x1234n), bytes32Hex(0x5678n), 10n] }]);
  });

  it("refuses a code for another chain or vault without writing", async () => {
    const { l1, issuer } = harness();
    const service = issuer(memoryIssuerStateStore());
    await expect(service.credit({ depositCode: code({ pcashChainId: 8n }), amount: 10n })).rejects.toThrow("another PCASH chain");
    await expect(service.credit({ depositCode: code({ vault: 0xc2n }), amount: 10n })).rejects.toThrow("another vault");
    expect(l1.writes).toEqual([]);
  });

  it("sets who may deposit, the deposit cap and the deposit pause, and reports a reverted write", async () => {
    const { l1, issuer } = harness();
    const service = issuer(memoryIssuerStateStore());
    await service.allow(depositor(0xa1), true);
    await service.setDepositCap(1_000n);
    await service.setDepositsPaused(true);
    expect(l1.writes).toEqual([
      { functionName: "setAllowed", args: [depositor(0xa1), true] },
      { functionName: "setDepositCap", args: [1_000n] },
      { functionName: "setDepositsPaused", args: [true] },
    ]);
    l1.reverts.add("setDepositsPaused");
    await expect(service.setDepositsPaused(false)).rejects.toThrow(/^setDepositsPaused transaction 0x[0-9a-f]{64} reverted$/);
  });

  it("refuses a credit retried after its first attempt landed while the receipt wait failed", async () => {
    const { l1, issuer } = harness();
    const service = issuer(memoryIssuerStateStore());
    l1.receiptTimeouts = 1;
    await expect(service.credit({ depositCode: code(), amount: 10n })).rejects.toThrow(WaitForTransactionReceiptTimeoutError);
    await expect(service.credit({ depositCode: code(), amount: 10n })).rejects.toThrow("AlreadyCredited");
    expect(l1.writes.map((write) => write.functionName)).toEqual(["credit"]);
    expect(l1.deposits).toEqual([{ recipientCommitment: bytes32Hex(0x1234n), nonce: bytes32Hex(0x5678n), amount: 10n }]);
  });

  it("reports a credit replaced at its nonce as not done, so the same code credits once retried", async () => {
    const { l1, issuer } = harness();
    const service = issuer(memoryIssuerStateStore());
    l1.replaceNext = true;
    await expect(service.credit({ depositCode: code(), amount: 10n })).rejects.toThrow(/^credit transaction 0x[0-9a-f]{64} was replaced by 0x[0-9a-f]{64}; the write is not done$/);
    expect(l1.deposits).toEqual([]);
    await service.credit({ depositCode: code(), amount: 10n });
    expect(l1.deposits).toHaveLength(1);
  });
});

describe("redemptions", () => {
  it("pays a queued burn out only once it succeeds in a finalized block, and counts the payout once final", async () => {
    const { wallet, pcash, l1, issuer, receive } = harness();
    const key = receive(redemptionMemo(PAYOUT), 40n);
    wallet.onBurn = () => {};
    const store = memoryIssuerStateStore();
    const service = issuer(store);
    expect(await service.processRedemptions()).toEqual([]);
    const burn = wallet.burns[0]!.contentHash;
    expect((await store.load()).redemptions).toMatchObject([{ key, redemptionId: vaultRedemptionId(key), payout: PAYOUT, amount: "40", burnContentHash: burn, burned: false }]);
    // Still queued: the recorded burn is resumed, not repeated.
    expect(await service.processRedemptions()).toEqual([]);
    expect(wallet.resumed).toEqual([burn]);
    pcash.include(burn);
    expect(await service.processRedemptions()).toEqual([]);
    expect(l1.payouts).toEqual([]);
    pcash.finalize();
    // The burn is final; the payout mines but is not final yet.
    expect(await service.processRedemptions()).toEqual([]);
    expect(l1.payouts).toEqual([{ to: PAYOUT, amount: 40n, redemptionId: vaultRedemptionId(key) }]);
    l1.finalize();
    expect((await service.processRedemptions()).map((redemption) => redemption.key)).toEqual([key]);
    expect(await service.processRedemptions()).toEqual([]);
    expect(wallet.burns).toHaveLength(1);
    expect(l1.payouts).toHaveLength(1);
  });

  it("imports the definition before its first sync and burns two redemptions in one pass, each polled once", async () => {
    const { wallet, pcash, issuer, receive } = harness();
    receive(redemptionMemo(PAYOUT), 10n);
    receive(redemptionMemo(PAYOUT), 40n);
    wallet.onBurn = (contentHash) => { pcash.include(contentHash); };
    const service = issuer(memoryIssuerStateStore());
    await service.processRedemptions();
    expect(wallet.burns.map(({ amount, settlePollMaxAttempts }) => ({ amount, settlePollMaxAttempts }))).toEqual([
      { amount: 10n, settlePollMaxAttempts: 1 },
      { amount: 40n, settlePollMaxAttempts: 1 },
    ]);
    await service.processRedemptions();
    expect(wallet.calls).toEqual(["import", "sync", "sync"]);
  });

  it("reads a checksummed payout address and pays it", async () => {
    const { wallet, pcash, l1, issuer, receive } = harness();
    const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const key = receive(`redeem ${checksummed}`, 40n);
    receive(`redeem ${checksummed.toLowerCase()}`, 10n);
    wallet.onBurn = (contentHash) => { pcash.include(contentHash); pcash.finalize(); };
    const store = memoryIssuerStateStore();
    await issuer(store).processRedemptions();
    const redemptions = (await store.load()).redemptions;
    expect(redemptions.map((redemption) => redemption.payout)).toEqual([checksummed, checksummed]);
    expect(redemptions[0]!.key).toBe(key);
    expect(l1.payouts.map((payout) => payout.to)).toEqual([checksummed, checksummed]);
  });

  it("resumes a burn recorded before a crash instead of burning again", async () => {
    const { wallet, pcash, l1, issuer, receive } = harness();
    receive(redemptionMemo(PAYOUT), 40n);
    wallet.onBurn = (contentHash) => {
      pcash.include(contentHash);
      throw new Error("process stopped");
    };
    const store = memoryIssuerStateStore();
    await issuer(store).processRedemptions();
    const restarted = issuer(store);
    await restarted.processRedemptions();
    expect(wallet.burns).toHaveLength(1);
    expect(wallet.resumed).toEqual([wallet.burns[0]!.contentHash]);
    pcash.finalize();
    await restarted.processRedemptions();
    l1.finalize();
    expect(await restarted.processRedemptions()).toHaveLength(1);
    expect(wallet.burns).toHaveLength(1);
    expect(l1.payouts).toHaveLength(1);
  });

  it("burns again only once a recorded burn failed for good", async () => {
    const { wallet, pcash, issuer, receive } = harness();
    receive(redemptionMemo(PAYOUT), 40n);
    wallet.onBurn = () => {};
    const service = issuer(memoryIssuerStateStore());
    await service.processRedemptions();
    wallet.expire(wallet.burns[0]!.contentHash);
    wallet.onBurn = (contentHash) => { pcash.include(contentHash); };
    await service.processRedemptions();
    expect(wallet.burns).toHaveLength(2);
  });

  it("recognizes a payout that mined before its hash was stored", async () => {
    const { wallet, pcash, l1, issuer, receive } = harness();
    const key = receive(redemptionMemo(PAYOUT), 40n);
    pcash.finalize();
    const store = memoryIssuerStateStore();
    wallet.onBurn = (contentHash) => { pcash.include(contentHash); pcash.finalize(); };
    const mined = l1.onPayout;
    l1.onPayout = (hash, redemptionId) => {
      mined(hash, redemptionId);
      throw new Error("process stopped");
    };
    expect(await issuer(store).processRedemptions()).toEqual([]);
    expect((await store.load()).redemptions[0]!.payoutTransaction).toBeUndefined();
    const restarted = issuer(store);
    // Paid at the head: not sent again, and complete once final.
    expect(await restarted.processRedemptions()).toEqual([]);
    l1.finalize();
    expect((await restarted.processRedemptions()).map((redemption) => redemption.key)).toEqual([key]);
    expect(l1.payouts).toHaveLength(1);
  });

  it("does not send a recorded payout again while it is pending", async () => {
    const { wallet, pcash, l1, issuer, receive } = harness();
    receive(redemptionMemo(PAYOUT), 40n);
    wallet.onBurn = (contentHash) => { pcash.include(contentHash); pcash.finalize(); };
    l1.onPayout = (hash) => { l1.transactions.set(hash, { mined: false, status: "success" }); };
    const store = memoryIssuerStateStore();
    const service = issuer(store);
    await service.processRedemptions();
    await service.processRedemptions();
    expect(l1.payouts).toHaveLength(1);
    // Dropped from the mempool: sent again.
    l1.transactions.clear();
    await service.processRedemptions();
    expect(l1.payouts).toHaveLength(2);
  });

  it("rejects a zero payout address without blocking another redemption", async () => {
    const { wallet, pcash, l1, issuer, receive } = harness();
    const zero = receive(redemptionMemo(ZERO), 10n);
    const good = receive(redemptionMemo(PAYOUT), 40n);
    wallet.onBurn = (contentHash) => { pcash.include(contentHash); pcash.finalize(); };
    const store = memoryIssuerStateStore();
    const service = issuer(store);
    await service.processRedemptions();
    l1.finalize();
    expect((await service.processRedemptions()).map((redemption) => redemption.key)).toEqual([good]);
    const rejected = (await store.load()).redemptions.find((redemption) => redemption.key === zero)!;
    expect(rejected.rejected).toBe("the payout address is zero");
    expect(wallet.burns.map((burn) => burn.amount)).toEqual([40n]);
    expect(l1.payouts.map((payout) => payout.to)).toEqual([PAYOUT]);
  });

  it("does not let a failing burn block another redemption", async () => {
    const { wallet, pcash, issuer, receive } = harness();
    receive(redemptionMemo(PAYOUT), 10n);
    receive(redemptionMemo(PAYOUT), 40n);
    wallet.onBurn = (contentHash) => {
      if (wallet.burns.at(-1)!.amount === 10n) {
        wallet.pending.delete(contentHash);
        throw new Error("insufficient notes");
      }
      pcash.include(contentHash);
    };
    const store = memoryIssuerStateStore();
    await issuer(store).processRedemptions();
    const state = await store.load();
    expect(state.redemptions.map((redemption) => redemption.lastError)).toEqual(["insufficient notes", undefined]);
    expect(wallet.burns.map((burn) => burn.amount)).toEqual([10n, 40n]);
  });

  it("finds redemptions past the first 1,000 memo rows, and only in finalized blocks", async () => {
    const { wallet, issuer, receive } = harness();
    for (let index = 0; index < 1_200; index += 1) receive("thanks", 1n);
    const late = receive(redemptionMemo(PAYOUT), 40n);
    receive(redemptionMemo(PAYOUT), 50n, 60n);
    wallet.onBurn = () => {};
    const store = memoryIssuerStateStore();
    await issuer(store).processRedemptions();
    expect((await store.load()).redemptions.map((redemption) => redemption.key)).toEqual([late]);
    wallet.finalizedThrough = 60n;
    await issuer(store).processRedemptions();
    expect((await store.load()).redemptions.map((redemption) => redemption.amount)).toEqual(["40", "50"]);
  });
});

describe("one issuer", () => {
  it("runs overlapping calls one at a time, so a command waits for the redemption round's vault writes", async () => {
    const { wallet, pcash, l1, issuer, receive } = harness();
    receive(redemptionMemo(PAYOUT), 40n);
    wallet.onBurn = (contentHash) => { pcash.include(contentHash); pcash.finalize(); };
    const service = issuer(memoryIssuerStateStore());
    await Promise.all([service.processRedemptions(), service.allow(depositor(0xa1), true)]);
    expect(l1.writes.map((write) => write.functionName)).toEqual(["payout", "setAllowed"]);
  });
});
