import { describe, expect, it, vi } from "vitest";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { networkConfigFromStatus, posterPayoutOpening } from "@pcash/sdk/protocol";
import { addressHex, keccak256, toHex } from "@pcash/sdk/utils";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { selectServedWallet, serviceSubmissionFor } from "../../src/service/serve.ts";
import { accountCreationSubmission } from "../../src/service/http.ts";
import { encodeUserAccountCreation } from "@pcash/sdk/protocol";
import { beBytes, concatBytes } from "@pcash/sdk/utils";
import { deriveSeedWalletIdentity } from "@pcash/sdk/wallet";
import { entropyToMnemonic } from "@scure/bip39";
import { english } from "viem/accounts";
import { contractCreationFixture } from "../contractCreationFixture.ts";
import { testStatus } from "../statusFixture.ts";

const posted = vi.hoisted(() => [] as { posterOwnerCommitment: bigint; posterContext: bigint; submitter: unknown }[]);

vi.mock("@pcash/sdk/relay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pcash/sdk/relay")>();
  return {
    ...actual,
    prepareTransactionForL1: vi.fn(async (entry: Uint8Array, preparedAt: StatusResult, submitter: unknown, posterOwnerCommitment: bigint, posterContext: bigint) => {
      posted.push({ posterOwnerCommitment, posterContext, submitter });
      const transactionHex = toHex(entry);
      const entryContentHash = toHex(keccak256(entry));
      return {
        contentHash: entryContentHash, transactionHex, selected: [entryContentHash], orderedTransactions: [transactionHex],
        actionBatchIndex: 0, collectibleOpenFee: 0n, status: preparedAt, batch: "0x", quote: {},
      };
    }),
    submitPreparedTransactionToL1: vi.fn(async () => ({
      txHash: `0x${"77".repeat(32)}`,
      observed: true,
      receipt: { status: 1, blockNumber: 1n, blockHash: `0x${"22".repeat(32)}`, transactionIndex: 0, gasUsed: 1n },
    })),
  };
});

const key = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const stored = (entropy: Uint8Array) => {
  const { profile } = deriveSeedWalletIdentity(entropyToMnemonic(entropy, english), networkConfigFromStatus(status));
  return { address: addressHex(profile.address), profile };
};

const entry = contractCreationFixture(1, 5n);
const contentHash = toHex(keccak256(entry));
const status = testStatus({ pcashChainId: 1, latestBlock: 12n, latestBlockHash: `0x${"22".repeat(32)}`, acceptedTransactionTypes: [0, 1, 2] });

function node(admitted: string[] = [], receiptContentHash: string = contentHash): PcashNodeClient {
  return {
    status: async () => status,
    submitRawTransaction: async (transactionHex: string) => {
      admitted.push(transactionHex);
      return { contentHash: receiptContentHash, statementId: `0x${"01".repeat(32)}`, stableId: `0x${"02".repeat(32)}`, status: "ready", headCheckedBlock: 12n, headCheckedBlockHash: status.latestBlockHash };
    },
    getReceipt: async () => [{
      contentHash: receiptContentHash, transactionId: `0x${"7e".repeat(32)}`, outcome: "succeeded", failureDetail: null,
      l1Sender: `0x${"00".repeat(20)}`, issuanceOwnerCommitment: null,
      settledOpenFeeAmount: 5n, settledIssuanceAmount: 0n, kind: "privateValue", accountCreation: 1,
      inclusion: { l1BlockNumber: 1n, l1BlockHash: `0x${"cc".repeat(32)}`, l1TransactionIndex: 0n, l1TransactionHash: `0x${"7c".repeat(32)}`, batchItemIndex: 0n },
      outputLeafStart: 0n, outputsAdded: 0n, nullifiers: [], account: null,
    }],
  } as unknown as PcashNodeClient;
}

function posterCommitmentOf(privateKey: Uint8Array, posterContext: bigint): bigint {
  const profile = stored(privateKey).profile;
  return posterPayoutOpening(profile.address, profile.nkRoot, posterContext).ownerCommitment;
}

describe("service --submit l1", () => {
  it("posts with the service key but names the selected wallet's own poster commitment", async () => {
    const serviceKey = key(0x31);
    const firstKey = key(0x41);
    const secondKey = key(0x42);
    const wallets = new Map([stored(firstKey), stored(secondKey)].map((wallet) => [wallet.address, wallet]));
    const submissionFor = serviceSubmissionFor({
      node: node(),
      l1Rpc: "http://l1.invalid",
      daMode: "calldata",
      submitterFor: () => ({}) as never,
      profileFor: (wallet) => selectServedWallet(wallets, wallet).profile,
    });

    posted.length = 0;
    const adapter = submissionFor({ submit: "l1" }, stored(secondKey).address);
    const prepared = await adapter.preflight({ transactionBytes: entry, status, retry: false });
    await expect(adapter.submit({ transactionBytes: entry, status, retry: false, prepared })).resolves.toMatchObject({ accepted: true });

    expect(posted).toHaveLength(1);
    const { posterOwnerCommitment, posterContext } = posted[0]!;
    expect(posterOwnerCommitment).toBe(posterCommitmentOf(secondKey, posterContext));
    expect(posterOwnerCommitment).not.toBe(posterCommitmentOf(serviceKey, posterContext));
    expect(posterOwnerCommitment).not.toBe(posterCommitmentOf(firstKey, posterContext));

    // The poster is resolved while preparing, before anything is journaled.
    const unselected = submissionFor({ submit: "l1" }, undefined);
    await expect(unselected.preflight({ transactionBytes: entry, status, retry: false }))
      .rejects.toThrow(/Multiple wallets loaded/);
    expect(posted).toHaveLength(1);
  });

  it("builds the submitter for the request's own L1 endpoint and claims no L1 authority for the wallet", async () => {
    const served = stored(key(0x41));
    const endpoints: [string | undefined, string | undefined][] = [];
    const submitter = {};
    const submissionFor = serviceSubmissionFor({
      node: node(),
      l1Rpc: "http://l1.invalid",
      daMode: "calldata",
      submitterFor: (l1Rpc, wallet) => {
        endpoints.push([l1Rpc, wallet]);
        return submitter as never;
      },
      profileFor: () => served.profile,
    });

    posted.length = 0;
    const adapter = submissionFor({ submit: "l1", l1Rpc: "http://l1.override" }, served.address);
    // The service key is not the wallet's Ethereum account, and the wallet does
    // not own the service's relay journal.
    expect(adapter.l1Sender).toBeUndefined();
    expect(adapter.l1Recovery).toBeUndefined();
    await adapter.preflight({ transactionBytes: entry, status, retry: false });
    expect(endpoints).toEqual([["http://l1.override", served.address]]);
    expect(posted[0]!.submitter).toBe(submitter);
  });

  it("rejects direct-L1 no-wait before preparing anything", () => {
    const submissionFor = serviceSubmissionFor({
      node: node(),
      l1Rpc: "http://l1.invalid",
      daMode: "calldata",
      submitterFor: () => { throw new Error("must not build a submitter"); },
      profileFor: () => stored(key(0x41)).profile,
    });

    posted.length = 0;
    expect(() => submissionFor({ submit: "l1", waitMode: "none" }, undefined)).toThrow(/requires --wait accepted or finalized/);
    expect(posted).toEqual([]);
  });
});

describe("service account creation default", () => {
  const walletKey = key(0x51);
  const served = stored(walletKey);
  // A signed user account creation; its signature is never checked here.
  const creation = encodeUserAccountCreation(1, concatBytes(
    Uint8Array.of(1), beBytes(1n, 32), beBytes(2n, 32),
    Uint8Array.of(0), beBytes(3n, 32), beBytes(100n, 8), beBytes(1n, 32), beBytes(2n, 32), Uint8Array.of(0),
  ));
  const creationContentHash = toHex(keccak256(creation));
  const factory = (admitted: string[], receiptContentHash: string) => serviceSubmissionFor({
    node: node(admitted, receiptContentHash),
    l1Rpc: "http://l1.invalid",
    daMode: "calldata",
    submitterFor: () => ({}) as never,
    profileFor: (wallet) => selectServedWallet(new Map([[served.address, served]]), wallet).profile,
  });
  const run = async (adapter: ReturnType<ReturnType<typeof factory>>, bytes: Uint8Array, id: string) => {
    const prepared = await adapter.preflight({ transactionBytes: bytes, status, retry: false });
    return adapter.submit({ transactionBytes: bytes, status, retry: false, prepared });
  };

  it("self-publishes a signed new account when no path is named", async () => {
    posted.length = 0;
    const admitted: string[] = [];
    const submissionFor = factory(admitted, creationContentHash);
    await run(accountCreationSubmission(submissionFor, {}, undefined, "l1"), creation, creationContentHash);
    expect(posted).toHaveLength(1);
    expect(admitted).toEqual([]);
  });

  it("keeps an explicit mempool creation and the mempool default for other actions", async () => {
    posted.length = 0;
    const admitted: string[] = [];
    const submissionFor = factory(admitted, creationContentHash);
    await run(accountCreationSubmission(submissionFor, { submit: "mempool" }, undefined, "l1"), creation, creationContentHash);
    expect(admitted).toEqual([toHex(creation)]);

    const transferAdmitted: string[] = [];
    await run(factory(transferAdmitted, contentHash)({}, undefined), entry, contentHash);
    expect(transferAdmitted).toEqual([toHex(entry)]);
    expect(posted).toEqual([]);
  });

  describe("in Tor mode", () => {
    const serviceGas = addressHex(privateKeyPcashActionSigner(key(0x61)).address);
    const other = stored(key(0x52));
    const loaded = new Set<string>([served.address, other.address]);
    const torFactory = (gas: { serviceGasAddress?: string }, admitted: string[] = [], receipt = creationContentHash) => serviceSubmissionFor({
      node: node(admitted, receipt),
      l1Rpc: "https://l1.example.org",
      tor: { ...gas, isLoadedWallet: (address) => loaded.has(address) },
      daMode: "calldata",
      submitterFor: () => ({}) as never,
      profileFor: (wallet) => selectServedWallet(new Map([[served.address, served]]), wallet).profile,
    });

    it("registers through the mempool by default and self-publishes registration only when asked", async () => {
      posted.length = 0;
      const admitted: string[] = [];
      const submissionFor = torFactory({}, admitted);
      await run(accountCreationSubmission(submissionFor, {}, undefined, "mempool"), creation, creationContentHash);
      expect(admitted).toEqual([toHex(creation)]);
      expect(posted).toEqual([]);
      await run(accountCreationSubmission(submissionFor, { submit: "l1" }, undefined, "mempool"), creation, creationContentHash);
      expect(posted).toHaveLength(1);
    });

    it("refuses to publish an action to L1 from any loaded wallet's account", async () => {
      posted.length = 0;
      // No gas key, the requesting wallet's own account, or another loaded wallet's account.
      for (const tor of [{}, { serviceGasAddress: served.address }, { serviceGasAddress: other.address }]) {
        expect(() => torFactory(tor)({ submit: "l1" }, undefined)).toThrow(/separate service gas key/);
        // An account request may turn out to be registration, so it is refused when it runs.
        const update = torFactory(tor)({ submit: "l1" }, undefined, "account-update");
        await expect(update.preflight({ transactionBytes: entry, status, retry: false })).rejects.toThrow(/separate service gas key/);
      }
      expect(posted).toEqual([]);
    });

    it("publishes an action to L1 from a separate service gas key", async () => {
      posted.length = 0;
      const adapter = torFactory({ serviceGasAddress: serviceGas }, [], contentHash)({ submit: "l1" }, undefined);
      const prepared = await adapter.preflight({ transactionBytes: entry, status, retry: false });
      await expect(adapter.submit({ transactionBytes: entry, status, retry: false, prepared })).resolves.toMatchObject({ accepted: true });
      expect(posted).toHaveLength(1);
    });

    it("accepts only a request L1 endpoint reachable through Tor", () => {
      const submissionFor = torFactory({ serviceGasAddress: serviceGas });
      expect(() => submissionFor({ submit: "l1", l1Rpc: "http://l1.example.org" }, undefined)).toThrow(/l1Rpc must be https/);
      expect(() => submissionFor({ submit: "l1", l1Rpc: "https://127.0.0.1:8545" }, undefined)).toThrow(/remote host/);
      expect(() => submissionFor({ submit: "l1", l1Rpc: "https://l1.example.org" }, undefined)).not.toThrow();
    });
  });

  it("does not construct an unused L1 creation adapter for a mempool account update", () => {
    const submissionFor = factory([], creationContentHash);
    const body = { waitMode: "none" };
    expect(submissionFor(body, undefined).mode).toBe("mempool");
    expect(() => accountCreationSubmission(submissionFor, body, undefined, "l1")).not.toThrow();
  });

  it("uses L1 registration while allowing an explicit mempool choice", async () => {
    posted.length = 0;
    const admitted: string[] = [];
    const submissionFor = factory(admitted, creationContentHash);
    await run(accountCreationSubmission(submissionFor, {}, undefined, "l1"), creation, creationContentHash);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.posterOwnerCommitment).toBe(posterCommitmentOf(walletKey, posted[0]!.posterContext));
    expect(admitted).toEqual([]);
    await run(accountCreationSubmission(submissionFor, { submit: "mempool" }, undefined, "l1"), creation, creationContentHash);
    expect(admitted).toEqual([toHex(creation)]);
    expect(posted).toHaveLength(1);
  });

  it("registers through the mempool without an L1 gas key", async () => {
    const unconfigured = serviceSubmissionFor({
      node: node([], creationContentHash), daMode: "calldata", submitterFor: () => { throw new Error("must not use L1"); },
      profileFor: () => served.profile,
    });
    const adapter = accountCreationSubmission(unconfigured, { submit: "mempool" }, undefined, "l1");
    expect(adapter.mode).toBe("mempool");
    await expect(run(adapter, creation, creationContentHash)).resolves.toMatchObject({ accepted: true });
  });

  it("exposes journal recovery independently of constructing a registration transport", async () => {
    const recovery = { show: vi.fn(), reconcile: vi.fn(), resolve: vi.fn() };
    const openRecovery = async () => recovery;
    const unavailableTransport = vi.fn(() => { throw new Error("L1 configuration was removed"); });
    const lazy = accountCreationSubmission(unavailableTransport, {}, undefined, "l1", openRecovery);
    await expect(lazy.l1Recovery!()).resolves.toBe(recovery);
    expect(unavailableTransport).not.toHaveBeenCalled();

    const factory = serviceSubmissionFor({
      node: node(), l1Rpc: "http://l1.invalid", daMode: "calldata", recovery: openRecovery,
      submitterFor: unavailableTransport, profileFor: () => served.profile,
    });
    await expect(factory({}, undefined).l1Recovery!()).resolves.toBe(recovery);
    await expect(factory({ submit: "l1" }, undefined).l1Recovery!()).resolves.toBe(recovery);
    expect(unavailableTransport).not.toHaveBeenCalled();
  });
});
