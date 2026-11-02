import { IDBFactory } from "fake-indexeddb";
import { createPublicClient, createWalletClient, custom, type Address } from "viem";
import { vi } from "vitest";
import { decodeBatch, transactionId } from "@pcash/sdk/protocol";
import { fromHex, keccak256, toHex } from "@pcash/sdk/utils";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";

export function browserSubmissionHarness(node: PcashNodeClient, status: StatusResult, account: Address) {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, run: () => unknown) => run() } });
  const sent: Record<string, string>[] = [];
  const hash = `0x${"ab".repeat(32)}`;
  const blockHash = `0x${"cd".repeat(32)}`;
  let send: () => Promise<string> = async () => hash;
  let balance = 10n ** 20n;
  let estimateGas: (data: string) => bigint = () => 123_456n;
  const read = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    switch (method) {
      case "eth_chainId": return `0x${status.l1ChainId.toString(16)}`;
      case "eth_blockNumber": return "0xa";
      case "eth_getTransactionByHash": return { ...sent.at(-1), hash, input: sent.at(-1)?.data, blockNumber: "0xa", blockHash, transactionIndex: "0x0" };
      case "eth_getBlockByNumber": return { hash: (params as string[])[0] === `0x${status.genesisL1Block.toString(16)}` ? status.genesisL1BlockHash : blockHash, number: "0xa", baseFeePerGas: "0x1" };
      case "eth_maxPriorityFeePerGas": return "0x2";
      case "eth_feeHistory": return { oldestBlock: "0x1", baseFeePerGas: ["0x1", "0x2"], gasUsedRatio: [0.5], reward: [[]] };
      case "eth_getTransactionCount": return "0x0";
      case "eth_getBalance": return `0x${balance.toString(16)}`;
      case "eth_estimateGas": return `0x${estimateGas((params as [{ data: string }])[0].data).toString(16)}`;
      case "eth_getTransactionReceipt": return { transactionHash: hash, blockNumber: "0xa", blockHash, transactionIndex: "0x0", gasUsed: "0x1e240", cumulativeGasUsed: "0x1e240", effectiveGasPrice: "0x2", logs: [], type: "0x2", status: "0x1", from: account, to: status.inboxAddress };
      default: throw new Error(`unexpected public RPC ${method}`);
    }
  });
  const provider = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    switch (method) {
      case "eth_chainId": return `0x${status.l1ChainId.toString(16)}`;
      case "eth_accounts": return [account];
      case "eth_sendTransaction": sent.push((params as Record<string,string>[])[0]!); return send();
      case "eth_getTransactionByHash": return { ...sent.at(-1), hash, input: sent.at(-1)?.data };
      default: throw new Error(`unexpected wallet RPC ${method}`);
    }
  });
  const publicClient = createPublicClient({ transport: custom({ request: read }, { retryCount: 0 }) });
  const walletClient = createWalletClient({ transport: custom({ request: provider }, { retryCount: 0 }) });
  const outcomes = new Map<number, string>();
  const items = () => decodeBatch(fromHex(sent.at(-1)!.data!)).items.map((entry, index) => (
    { batchItemIndex: BigInt(index), contentHash: toHex(keccak256(entry)), exclusionReason: null }
  ));
  Object.assign(node, {
    getInboxDeliveryBatch: async () => ({ l1TransactionHash: hash, l1BlockHash: blockHash, l1TransactionIndex: 0n, exclusionReason: null, items: items() }),
    getReceipt: async (query: { inclusionId: { batchItemIndex: number } }) => sent.length === 0 ? [] : items().filter((item) => item.batchItemIndex === BigInt(query.inclusionId.batchItemIndex)).map((item) => ({
      transactionId: toHex(transactionId({ l1BlockHash: fromHex(blockHash), l1TransactionIndex: 0n, batchItemIndex: item.batchItemIndex })),
      contentHash: item.contentHash,
      outcome: outcomes.get(Number(item.batchItemIndex)) ?? "succeeded", kind: "privateValue",
      inclusion: { l1BlockHash: blockHash, l1TransactionIndex: 0n, batchItemIndex: item.batchItemIndex },
    })),
  });
  return { payoutRecipient: { address: BigInt(account), nkRoot: 123n }, publicClient, walletClient, sent, read, provider,
    setOutcome: (index: number, outcome: string) => { outcomes.set(index, outcome); },
    setSend: (operation: () => Promise<string>) => { send = operation; },
    setBalance: (value: bigint) => { balance = value; },
    setEstimateGas: (estimate: (data: string) => bigint) => { estimateGas = estimate; },
  };
}
