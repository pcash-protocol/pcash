import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { deliveryCommitment, randomArena } from "../src/protocol/transfer.ts";
import { expect, it, vi } from "vitest";
import { WIRE_PROOF_BYTES, encodePrivateValueTransaction, decodeBatch, transactionOpenFee } from "../src/protocol/codec.ts";
import { buildUnfundedContractCreation } from "../src/builders/contractCreation.ts";
import { functionSelector } from "../src/protocol/contract.ts";
import { prepareTransactionForL1, submitTransactionToL1, submitPreparedTransactionToL1 } from "../src/relay/direct.ts";
import { buildDirectReferenceUserAccountCreation } from "../src/builders/index.ts";
import { encodeUserAccountCreation } from "../src/protocol/index.ts";
import { TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet } from "./testWallet.ts";
import { fromHex, toHex, keccak256 } from "../src/utils/index.ts";
import type { PcashNodeClient } from "../src/clients/nodeClient.ts";
import type { RelaySubmitter } from "../src/relay/relayer.ts";

it.each([undefined, "calldata", "blobs"] as const)("posts an exact zero-fee batch with carrier policy %s and no mempool APIs", async (daMode) => {
  const data = sizeClassFiller();
  const arena = randomArena(0);
  const outputData = [data, data, data, data, data];
  const entry = encodePrivateValueTransaction({ publicInputs: [1n, ...Array(10).fill(0n), deliveryCommitment(outputData, arena), 0n, 0n, 0n, 1n, 0n, 0n, 0n], proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena });
  const status = { pcashChainId: 1, genesisHash: `0x${"11".repeat(32)}`, l1ChainId: 1n, inboxAddress: `0x${"22".repeat(20)}`, genesisL1Block: 0n, genesisL1BlockHash: `0x${"33".repeat(32)}`, acceptedTransactionTypes: [0], acceptedBatchVersions: [1], latestBlock: 5n, latestBlockHash: `0x${"11".repeat(32)}` };
  const node = { status: async () => status } as unknown as PcashNodeClient;
  const quote = { carrier: "calldata", balanceWei: 100n, maximumCostWei: 1n };
  const submitter = {
    address: `0x${"22".repeat(20)}`, supportedCarriers: ["calldata", "blobs"], assertAvailable: vi.fn(async () => {}),
    quote: vi.fn(async () => ({ selected: quote })),
    send: vi.fn(async () => ({ txHash: `0x${"33".repeat(32)}`, settle: async () => ({ txHash: `0x${"33".repeat(32)}`, observed: true }) })),
  };
  expect(transactionOpenFee(entry)).toBe(0n);
  await submitTransactionToL1(node, entry, submitter as unknown as RelaySubmitter, 1n, 0n, daMode);
  const [checkedStatus, batch, selectedQuote, metadata] = submitter.send.mock.calls[0] as unknown as [unknown, string, unknown, unknown];
  expect(checkedStatus).toBe(status);
  expect(decodeBatch(fromHex(batch)).items).toEqual([entry]);
  expect(submitter.quote).toHaveBeenCalledWith(status, batch, daMode ?? "auto");
  expect(selectedQuote).toBe(quote);
  expect(metadata).toMatchObject({ selected: [toHex(keccak256(entry))], source: "direct", observationMode: "batch", batchItemIndexes: [0] });
});

it("carries companion mempool entries after the caller's entry and reports what the poster collects", async () => {
  const data = sizeClassFiller();
  const arena = randomArena(0);
  const outputData = [data, data, data, data, data];
  const entryWith = (nonce: bigint) => encodePrivateValueTransaction({ publicInputs: [1n, nonce, ...Array(9).fill(0n), deliveryCommitment(outputData, arena), 0n, 0n, 0n, 1n, 0n, 0n, 0n], proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena });
  const [entry, first, second] = [entryWith(1n), entryWith(2n), entryWith(3n)];
  const status = { pcashChainId: 1, genesisHash: `0x${"11".repeat(32)}`, l1ChainId: 1n, inboxAddress: `0x${"22".repeat(20)}`, genesisL1Block: 0n, genesisL1BlockHash: `0x${"33".repeat(32)}`, acceptedTransactionTypes: [0], acceptedBatchVersions: [1], latestBlock: 5n, latestBlockHash: `0x${"11".repeat(32)}` };
  const node = { status: async () => status } as unknown as PcashNodeClient;
  const submitter = {
    address: `0x${"22".repeat(20)}`, supportedCarriers: ["calldata"], assertAvailable: vi.fn(async () => {}),
    quote: vi.fn(async () => ({ selected: { carrier: "calldata", balanceWei: 100n, maximumCostWei: 1n } })),
    send: vi.fn(async () => ({ txHash: `0x${"33".repeat(32)}`, settle: async () => ({ txHash: `0x${"33".repeat(32)}`, observed: true }) })),
  };
  const prepared = await prepareTransactionForL1(entry, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "auto", { required: [first, second], collectibleOpenFee: 7n });
  expect(decodeBatch(fromHex(prepared.batch)).items).toEqual([entry, first, second]);
  expect(prepared.contentHash).toBe(toHex(keccak256(entry)));
  await submitPreparedTransactionToL1(node, prepared, submitter as unknown as RelaySubmitter);
  const metadata = (submitter.send.mock.calls[0] as unknown as unknown[])[3];
  expect(metadata).toMatchObject({
    selected: [entry, first, second].map((item) => toHex(keccak256(item))),
    batchItemIndexes: [0, 1, 2],
    collectibleOpenFee: 7n,
  });
});

function independentEntry(nonce: bigint, nullifierNonce = nonce, contract = false): Uint8Array {
  const data = sizeClassFiller();
  const arena = randomArena(0);
  const outputData = Array<Uint8Array>(5).fill(data);
  const section = {
    publicInputs: [1n, 0n, ...Array.from({ length: 4 }, (_, index) => nullifierNonce * 10n + BigInt(index)),
      ...Array.from({ length: 5 }, (_, index) => nonce * 100n + BigInt(index)),
      deliveryCommitment(outputData, arena), 1n, 0n, 0n, 100n, 0n, 0n, 0n],
    outputData,
    arena,
  };
  // publishesNkRoot ‖ material ‖ receive-key mode ‖ function count.
  return contract
    ? encodePrivateValueTransaction({ ...section, proof: new Uint8Array(WIRE_PROOF_BYTES), accountCreation: { kind: "contract", body: new Uint8Array(35) } })
    : encodePrivateValueTransaction({ ...section, proof: new Uint8Array(WIRE_PROOF_BYTES) });
}
function directHarness() {
  const status = { pcashChainId: 1, genesisHash: `0x${"11".repeat(32)}`, l1ChainId: 1n, inboxAddress: `0x${"22".repeat(20)}`, genesisL1Block: 0n, genesisL1BlockHash: `0x${"33".repeat(32)}`, acceptedTransactionTypes: [0], acceptedBatchVersions: [1], latestBlock: 5n, latestBlockHash: `0x${"11".repeat(32)}` };
  const node = { status: async () => status } as unknown as PcashNodeClient;
  const submitter = {
    address: `0x${"22".repeat(20)}`, supportedCarriers: ["calldata"], assertAvailable: vi.fn(async () => {}),
    quote: vi.fn(async (_status: unknown, _batch: string) => ({ selected: { carrier: "calldata", balanceWei: 100n, maximumCostWei: 1n } })),
    send: vi.fn(async () => ({ txHash: `0x${"33".repeat(32)}`, settle: async () => ({ txHash: `0x${"33".repeat(32)}`, observed: true }) })),
  };
  return { status, node, submitter };
}

function unfundedEntry() {
  return buildUnfundedContractCreation({
    pcashChainId: 1n,
    contract: { nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 1n }, functions: [{ selector: functionSelector(0), applicationVkHash: 2n, configurationCommitment: 3n }] },
    recentPcashBlockHash: 1n,
    validUntilTimestamp: 100n,
  });
}

it("reports the funding address, L1 chain, required gas reserve and available balance before broadcast", async () => {
  const { status, submitter } = directHarness();
  submitter.quote.mockResolvedValueOnce({ selected: { carrier: "calldata", balanceWei: 0n, maximumCostWei: 987_654n } });
  await expect(prepareTransactionForL1(independentEntry(1n), status as never, submitter as unknown as RelaySubmitter, 1n, 0n))
    .rejects.toThrow(`not enough ETH for direct submission gas. Fund Ethereum address ${submitter.address} on L1 chain 1: direct submission requires 987654 wei for gas; available 0 wei`);
  expect(submitter.send).not.toHaveBeenCalled();
});

it("prepares and submits unfunded contract creation from any connected L1 account", async () => {
  const { status, node, submitter } = directHarness();
  status.acceptedTransactionTypes.push(2);
  const { transactionBytes: entry, address } = unfundedEntry();
  expect(address).not.toBe(BigInt(submitter.address));
  const prepared = await prepareTransactionForL1(entry, status as never, submitter as unknown as RelaySubmitter, 1n, 0n);
  expect(decodeBatch(fromHex(prepared.batch)).items).toEqual([entry]);
  expect(prepared.collectibleOpenFee).toBe(0n);
  await submitPreparedTransactionToL1(node, prepared, submitter as unknown as RelaySubmitter);
  expect(submitter.send).toHaveBeenCalledOnce();
  expect((submitter.send.mock.calls[0] as unknown as unknown[])[1]).toBe(prepared.batch);
});

it.each([0, 1, 2])("shuffles every independent entry and binds payment at index %s", async desired => {
  const { status, node, submitter } = directHarness();
  const entries = [1n, 2n, 3n].map(nonce => independentEntry(nonce));
  const draws = desired === 0 ? [1, 1] : desired === 1 ? [2, 0] : [0, 1];
  const prepared = await prepareTransactionForL1(entries[0]!, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "calldata", {
    companions: { transactions: entries.slice(1), collectibleOpenFee: 2n, collectibleOpenFees: [1n, 1n] }, randomIndex: () => draws.shift()!,
  });
  expect(prepared.actionBatchIndex).toBe(desired);
  expect(prepared.orderedTransactions[desired]).toBe(toHex(entries[0]!));
  expect([...prepared.orderedTransactions].sort()).toEqual(entries.map(toHex).sort());
  expect(new Set(prepared.selected).size).toBe(3);
  expect(submitter.quote.mock.calls[0]![1]).toBe(prepared.batch);
  await submitPreparedTransactionToL1(node, prepared, submitter as unknown as RelaySubmitter);
  const call = submitter.send.mock.calls[0] as unknown as unknown[];
  expect(call[1]).toBe(prepared.batch);
  expect(call[3]).toMatchObject({ selected: prepared.selected, batchItemIndexes: [0, 1, 2] });
  expect(submitter.quote).toHaveBeenCalledOnce();
});

it("drops duplicate and conflicting companions before shuffling, retaining the payment", async () => {
  const { status, submitter } = directHarness();
  const entry = independentEntry(1n);
  const usable = independentEntry(2n);
  const conflict = independentEntry(3n, 1n);
  const prepared = await prepareTransactionForL1(entry, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "calldata", {
    companions: { transactions: [entry, conflict, usable, usable, Uint8Array.of(255)], collectibleOpenFee: 5n, collectibleOpenFees: [1n, 1n, 1n, 1n, 1n] }, randomIndex: () => 0,
  });
  expect(prepared.orderedTransactions).toEqual([toHex(usable), toHex(entry)]);
  expect(prepared.actionBatchIndex).toBe(1);
  expect(prepared.collectibleOpenFee).toBe(1n);
});

it("shuffles multiple required claims and rejects companions conflicting with any claim", async () => {
  const { status, submitter } = directHarness();
  const claims = [independentEntry(1n), independentEntry(2n)];
  const usable = independentEntry(3n);
  const prepared = await prepareTransactionForL1(claims[0]!, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "calldata", {
    required: claims.slice(1),
    companions: { transactions: [claims[1]!, independentEntry(4n, 2n), usable], collectibleOpenFee: 3n, collectibleOpenFees: [1n, 1n, 1n] },
    randomIndex: () => 0,
  });
  expect(prepared.orderedTransactions).toEqual([claims[1], usable, claims[0]].map(item => toHex(item!)));
  expect(prepared.actionBatchIndex).toBe(2);
  expect(prepared.collectibleOpenFee).toBe(1n);
});

it("keeps all selected claims when the carrier cannot afford companions", async () => {
  const { status, submitter } = directHarness();
  const claims = [independentEntry(1n), independentEntry(2n)];
  submitter.quote.mockResolvedValueOnce({ selected: { carrier: "calldata", balanceWei: 1n, maximumCostWei: 2n } });
  const prepared = await prepareTransactionForL1(claims[0]!, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "calldata", {
    required: claims.slice(1),
    companions: { transactions: [independentEntry(3n)], collectibleOpenFee: 1n, collectibleOpenFees: [1n] },
  });
  expect(prepared.orderedTransactions).toEqual(claims.map(toHex));
  expect(prepared.collectibleOpenFee).toBe(0n);
});

it("re-quotes a standalone payment when the shuffled batch cannot be quoted", async () => {
  const { status, submitter } = directHarness();
  submitter.quote.mockRejectedValueOnce(new Error("batch unavailable"));
  const entry = independentEntry(1n);
  const prepared = await prepareTransactionForL1(entry, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "calldata", {
    companions: { transactions: [independentEntry(2n)], collectibleOpenFee: 1n, collectibleOpenFees: [1n] }, randomIndex: () => 0,
  });
  expect(prepared.orderedTransactions).toEqual([toHex(entry)]);
  expect(prepared.actionBatchIndex).toBe(0);
  expect(prepared.collectibleOpenFee).toBe(0n);
  expect(submitter.quote).toHaveBeenCalledTimes(2);
});

it("retains independent entries with repeated output bodies at distinct tree positions", async () => {
  const { status, submitter } = directHarness();
  const payment = independentEntry(1n);
  const companion = independentEntry(1n, 2n);
  const prepared = await prepareTransactionForL1(payment, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "calldata", {
    companions: { transactions: [companion], collectibleOpenFee: 1n, collectibleOpenFees: [1n] }, randomIndex: () => 0,
  });
  expect(prepared.orderedTransactions).toEqual([toHex(companion), toHex(payment)]);
});

it("interleaves the wallet's own selected companions with other entries", async () => {
  const { status, submitter } = directHarness();
  const [payment, ownFirst, ownSecond, other] = [1n, 2n, 3n, 4n].map(nonce => independentEntry(nonce));
  const draws = [1, 0, 1];
  const prepared = await prepareTransactionForL1(payment!, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "calldata", {
    companions: { transactions: [ownFirst!, ownSecond!, other!], collectibleOpenFee: 1n, collectibleOpenFees: [0n, 0n, 1n] }, randomIndex: () => draws.shift()!,
  });
  expect(prepared.orderedTransactions).toEqual([ownSecond!, other!, payment!, ownFirst!].map(toHex));
  expect(prepared.actionBatchIndex).toBe(2);
});


it.each([0, 1, 2])("randomizes a pending contract creation at index %s and excludes conflicting spends", async desired => {
  const { status, node, submitter } = directHarness();
  status.acceptedTransactionTypes.push(2);
  const contract = independentEntry(1n, 1n, true);
  const companions = [independentEntry(2n), independentEntry(3n)];
  const draws = desired === 0 ? [1, 1] : desired === 1 ? [2, 0] : [0, 1];
  const prepared = await prepareTransactionForL1(contract, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "calldata", {
    companions: { transactions: [independentEntry(4n, 1n), ...companions, contract], collectibleOpenFee: 4n, collectibleOpenFees: [1n, 1n, 1n, 1n] },
    randomIndex: () => draws.shift()!,
  });
  expect(prepared.actionBatchIndex).toBe(desired);
  expect(prepared.orderedTransactions[desired]).toBe(toHex(contract));
  expect([...prepared.orderedTransactions].sort()).toEqual([contract, ...companions].map(toHex).sort());
  expect(prepared.collectibleOpenFee).toBe(2n);
  await submitPreparedTransactionToL1(node, prepared, submitter as unknown as RelaySubmitter);
  expect(submitter.send).toHaveBeenCalledOnce();
});

it("randomizes an unfunded contract creation among private-value companions", async () => {
  const { status, submitter } = directHarness();
  status.acceptedTransactionTypes.push(2);
  const { transactionBytes: contract } = unfundedEntry();
  const companions = [independentEntry(2n), independentEntry(3n)];
  const prepared = await prepareTransactionForL1(contract, status as never, submitter as unknown as RelaySubmitter, 1n, 0n, "calldata", {
    companions: { transactions: [...companions, contract], collectibleOpenFee: 3n, collectibleOpenFees: [1n, 1n, 1n] },
    randomIndex: () => 0,
  });
  expect([...prepared.orderedTransactions].sort()).toEqual([contract, ...companions].map(toHex).sort());
  expect(prepared.orderedTransactions[prepared.actionBatchIndex]).toBe(toHex(contract));
  expect(prepared.actionBatchIndex).not.toBe(0);
  expect(prepared.collectibleOpenFee).toBe(2n);
});

// A direct creation registers at the batch's L1 sender, so node-supplied bytes must not carry one.
function directCreation(): Uint8Array {
  return encodeUserAccountCreation(1n, buildDirectReferenceUserAccountCreation({ chainId: 1n, wallet: deriveTestWallet(),
    defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS, recentPcashBlockHash: 0x1234n, validUntilTimestamp: 987654n }).body);
}

it("takes only private-value transactions from the node's optional items", async () => {
  const { status, submitter } = directHarness();
  const accepting = { ...status, acceptedTransactionTypes: [0, 1, 2, 3] };
  const [entry, companion] = [independentEntry(1n), independentEntry(2n)];
  const prepared = await prepareTransactionForL1(entry, accepting as never, submitter as unknown as RelaySubmitter, 1n, 0n, "auto", {
    optional: [directCreation(), companion],
  });
  expect(decodeBatch(fromHex(prepared.batch)).items).toEqual([entry, companion]);
});

it("takes only private-value companions after dependent required transactions", async () => {
  const { status, submitter } = directHarness();
  const accepting = { ...status, acceptedTransactionTypes: [0, 1, 2, 3] };
  const [entry, contract, companion] = [independentEntry(1n), unfundedEntry().transactionBytes, independentEntry(3n)];
  const prepared = await prepareTransactionForL1(entry, accepting as never, submitter as unknown as RelaySubmitter, 1n, 0n, "auto", {
    required: [contract],
    companions: { transactions: [directCreation(), companion], collectibleOpenFee: 6n, collectibleOpenFees: [5n, 1n] },
  });
  expect(decodeBatch(fromHex(prepared.batch)).items).toEqual([entry, contract, companion]);
  expect(prepared.collectibleOpenFee).toBe(1n);
});
