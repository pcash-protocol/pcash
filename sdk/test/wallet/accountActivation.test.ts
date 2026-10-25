// advanceAccountActivation policy against injected fakes. No IndexedDB, no
// viem network: every collaborator is a vi.fn.

import { describe, expect, it, vi } from "vitest";
import { advanceAccountActivation, inspectAccountActivationTransaction, releaseExpiredAccountActivation } from "../../src/wallet/web/accountActivation.ts";
import { TransactionNotFoundError } from "viem";
import type { RelayJournalEntry } from "@pcash/sdk/relay";
import type { Wallet } from "../../src/wallet/actions/walletClient.ts";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { TEST_PRIV_KEY } from "./testWallet.ts";

const PROFILE = derivePcashProfileFromPrivateKey(TEST_PRIV_KEY, {
  pcashChainId: 1n,
  l1ChainId: 11_155_111n,
  inboxAddress: `0x${"22".repeat(20)}`,
});

describe("account setup recovery", () => {
  function recoveryCase() {
    const pending = { ...l1Submitted(), validUntilTimestamp: "100" };
    return {
      contentHash: pending.contentHash,
      wallet: {
        accountActivation: vi.fn().mockResolvedValue(pending),
        clearAccountActivation: vi.fn().mockResolvedValue(undefined),
      },
      node: { status: vi.fn().mockResolvedValue({ latestBlockTimestamp: 101n }) },
      recovery: {
        reconcile: vi.fn().mockResolvedValue({ latched: false, entries: [{ outcome: "cleared", resolutionId: "setup" }] }),
        show: vi.fn().mockResolvedValue({ latched: false, entries: [] }),
        resolve: vi.fn().mockResolvedValue({ latched: false, resolutionId: "setup" }),
      },
    };
  }

  it.each(["cleared", "empty"])("retires the selected expired setup after recovery reports %s", async (outcome) => {
    const options = recoveryCase();
    options.recovery.reconcile.mockResolvedValue({
      latched: false,
      entries: outcome === "empty" ? [] : [{ outcome, resolutionId: "setup" }],
    });
    await releaseExpiredAccountActivation(options);
    expect(options.recovery.resolve).not.toHaveBeenCalled();
    expect(options.wallet.clearAccountActivation).toHaveBeenCalledTimes(1);
  });

  it.each(["ambiguous", "unobserved", "pending"])("preserves an expired activation and its %s Ethereum carrier", async (outcome) => {
    const options = recoveryCase();
    const entry = { kind: "batch", resolutionId: "setup", selected: [options.contentHash] } as RelayJournalEntry;
    options.recovery.reconcile.mockResolvedValue({ latched: true, entries: [{ outcome, resolutionId: "setup" }] });
    options.recovery.show.mockResolvedValue({ latched: true, entries: [entry] });
    await expect(releaseExpiredAccountActivation(options)).rejects.toThrow(
      outcome === "unobserved" ? "Wait for PCASH to process it" : "Ethereum submission is unresolved",
    );
    expect(options.recovery.resolve).not.toHaveBeenCalled();
    expect(options.wallet.clearAccountActivation).not.toHaveBeenCalled();
  });

  it("keeps tracking an activation through its inclusive deadline", async () => {
    const options = recoveryCase();
    options.node.status.mockResolvedValue({ latestBlockTimestamp: 100n });
    await expect(releaseExpiredAccountActivation(options)).rejects.toThrow("has not expired");
    expect(options.recovery.resolve).not.toHaveBeenCalled();
    expect(options.wallet.clearAccountActivation).not.toHaveBeenCalled();
  });

  it("does not discard a submission changed in another tab or an unrelated batch", async () => {
    const options = recoveryCase();
    await expect(releaseExpiredAccountActivation({ ...options, contentHash: "old-selection" })).rejects.toThrow("transaction changed");
    options.recovery.show.mockResolvedValue({
      latched: true,
      entries: [{ kind: "batch", resolutionId: "another", selected: [options.contentHash, "other-action"] }],
    });
    await expect(releaseExpiredAccountActivation(options)).rejects.toThrow("Another Ethereum submission");
    expect(options.recovery.resolve).not.toHaveBeenCalled();
    expect(options.wallet.clearAccountActivation).not.toHaveBeenCalled();
  });

  it("preserves the activation when Ethereum recovery or the subsequent journal read fails", async () => {
    const options = recoveryCase();
    options.recovery.reconcile.mockRejectedValueOnce(new Error("Ethereum offline"));
    await expect(releaseExpiredAccountActivation(options)).rejects.toThrow("Ethereum offline");
    expect(options.recovery.resolve).not.toHaveBeenCalled();
    options.recovery.show.mockRejectedValueOnce(new Error("journal unavailable"));
    await expect(releaseExpiredAccountActivation(options)).rejects.toThrow("journal unavailable");
    expect(options.wallet.clearAccountActivation).not.toHaveBeenCalled();
  });

  it("preserves a matching carrier that another tab records after reconciliation", async () => {
    const options = recoveryCase();
    options.recovery.show.mockResolvedValue({ latched: true, entry: { selected: [options.contentHash], resolutionId: "new-carrier" } });
    await expect(releaseExpiredAccountActivation(options)).rejects.toThrow("Another Ethereum submission");
    expect(options.recovery.resolve).not.toHaveBeenCalled();
    expect(options.wallet.clearAccountActivation).not.toHaveBeenCalled();
  });

  it("leaves a newly observed account alone", async () => {
    const options = recoveryCase();
    options.wallet.accountActivation.mockResolvedValue(null);
    await releaseExpiredAccountActivation(options);
    expect(options.recovery.resolve).not.toHaveBeenCalled();
    expect(options.wallet.clearAccountActivation).not.toHaveBeenCalled();
  });

  it("distinguishes a nonce gap, an ordinary pending transaction, and inclusion", async () => {
    const hash = l1Submitted().l1TxHash;
    const publicClient = {
      getTransaction: vi.fn().mockResolvedValue({ from: PROFILE.address, nonce: 2, blockNumber: null }),
      getTransactionCount: vi.fn().mockResolvedValue(1),
    };
    await expect(inspectAccountActivationTransaction(publicClient, hash)).resolves.toEqual({ hash, state: "queued", nonce: 2, nextNonce: 1 });
    expect(publicClient.getTransactionCount).toHaveBeenCalledWith({ address: PROFILE.address, blockTag: "pending" });
    publicClient.getTransactionCount.mockResolvedValue(3);
    await expect(inspectAccountActivationTransaction(publicClient, hash)).resolves.toEqual({ hash, state: "pending" });
    publicClient.getTransaction.mockResolvedValue({ blockNumber: 3n });
    await expect(inspectAccountActivationTransaction(publicClient, hash)).resolves.toEqual({ hash, state: "included" });
    expect(publicClient.getTransactionCount).toHaveBeenCalledTimes(2);
  });

  it("reports a missing transaction without mistaking an RPC outage for one", async () => {
    const hash = l1Submitted().l1TxHash;
    const publicClient = { getTransaction: vi.fn().mockRejectedValueOnce(new TransactionNotFoundError({ hash })), getTransactionCount: vi.fn() };
    await expect(inspectAccountActivationTransaction(publicClient, hash)).resolves.toEqual({ hash, state: "missing" });
    publicClient.getTransaction.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(inspectAccountActivationTransaction(publicClient, hash)).rejects.toThrow("RPC unavailable");
    expect(publicClient.getTransactionCount).not.toHaveBeenCalled();
  });
});

function fakeWallet(pending: Awaited<ReturnType<Wallet["accountActivation"]>>) {
  return {
    wallet: {
      accountActivation: vi.fn(async () => pending),
      resetAccountActivationSubmission: vi.fn(async () => undefined),
      defaultAccountReady: vi.fn(async () => false),
    },
  };
}

function l1Submitted() {
  return {
    contentHash: `0x${"11".repeat(32)}`,
    transactionHex: "0x02",
    address: `0x${"33".repeat(20)}`,
    pcashChainId: "1",
    pcashGenesisHash: `0x${"44".repeat(32)}`,
    l1ChainId: "11155111",
    inboxAddress: `0x${"22".repeat(20)}`,
    genesisL1Block: "0",
    genesisL1BlockHash: `0x${"55".repeat(32)}`,
    ruleSetCommitment: "0",
    receiveKeyHash: `0x${"66".repeat(32)}`,
    recentPcashBlockNumber: "0",
    recentPcashBlockHash: `0x${"77".repeat(32)}`,
    validUntilTimestamp: "9999999999",
    preparedAtUnixMs: "0",
    state: "l1-submitted" as const,
    l1TxHash: `0x${"88".repeat(32)}` as `0x${string}`,
  };
}

const node = { getReceipt: async () => [] } as unknown as Parameters<typeof advanceAccountActivation>[0]["node"];
const readyProbe = async () => true;

describe("advanceAccountActivation", () => {
  it("reports a failed registration independently of its batch's mining action", async () => {
    const pending = { ...l1Submitted(), miningTransactionHex: "0x00" };
    const { wallet } = fakeWallet(pending);
    const getReceipt = vi.fn(async () => [{ outcome: "expired", inclusion: { l1TransactionHash: l1Submitted().l1TxHash } }]);
    const result = await advanceAccountActivation({ wallet, profile: PROFILE,
      node: { getReceipt } as unknown as typeof node,
      publicClient: { getTransactionReceipt: async () => ({ status: "success" }) },
      isReady: async () => false, readiness: { attempts: 1 } });
    expect(result).toMatchObject({ kind: "reset-to-prepared" });
    expect((result as { message: string }).message).toContain("expired");
    expect(getReceipt).toHaveBeenCalledWith({ contentHash: pending.contentHash });
    expect(wallet.resetAccountActivationSubmission).toHaveBeenCalledOnce();
    expect(pending.miningTransactionHex).toBe("0x00");
  });
  it("keeps polling after a transient PCASH receipt query failure", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    const getReceipt = vi.fn().mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce([{ outcome: "expired", inclusion: { l1TransactionHash: l1Submitted().l1TxHash } }]);
    const options = { wallet, profile: PROFILE,
      node: { getReceipt } as unknown as typeof node,
      publicClient: { getTransactionReceipt: async () => ({ status: "success" as const }) },
      isReady: async () => false, readiness: { attempts: 1 } };
    await expect(advanceAccountActivation(options)).resolves.toEqual({ kind: "waiting-derivation" });
    expect(wallet.resetAccountActivationSubmission).not.toHaveBeenCalled();
    await expect(advanceAccountActivation(options)).resolves.toMatchObject({ kind: "reset-to-prepared" });
    expect(wallet.resetAccountActivationSubmission).toHaveBeenCalledOnce();
  });

  it("does not swallow a failure to persist a rejected registration", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    vi.mocked(wallet.resetAccountActivationSubmission).mockRejectedValueOnce(new Error("store unavailable"));
    await expect(advanceAccountActivation({ wallet, profile: PROFILE,
      node: { getReceipt: async () => [{ outcome: "expired", inclusion: { l1TransactionHash: l1Submitted().l1TxHash } }] } as unknown as typeof node,
      publicClient: { getTransactionReceipt: async () => ({ status: "success" }) },
      isReady: async () => false, readiness: { attempts: 1 },
    })).rejects.toThrow("store unavailable");
  });

  it.each(["pending", "succeeded", "failed"] as const)("uses only the current Ethereum inclusion when its derivation is %s", async (current) => {
    const pending = { ...l1Submitted(), l1TxHash: `0x${"ab".repeat(32)}` };
    const { wallet } = fakeWallet(pending);
    const oldReceipt = { outcome: "outputCapacityExceeded", inclusion: { l1TransactionHash: `0x${"cd".repeat(32)}` } };
    const currentReceipt = { outcome: current === "failed" ? "expired" : "succeeded",
      inclusion: { l1TransactionHash: `0x${"AB".repeat(32)}` } };
    const getReceipt = vi.fn(async () => current === "pending" ? [oldReceipt] : [oldReceipt, currentReceipt]);
    const result = await advanceAccountActivation({ wallet, profile: PROFILE,
      node: { getReceipt } as unknown as typeof node,
      publicClient: { getTransactionReceipt: async () => ({ status: "success" }) },
      isReady: async () => false, readiness: { attempts: 1 },
    });
    expect(getReceipt).toHaveBeenCalledWith({ contentHash: pending.contentHash });
    if (current === "failed") {
      expect(result).toMatchObject({ kind: "reset-to-prepared", message: expect.stringContaining("expired") });
      expect(wallet.resetAccountActivationSubmission).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({ kind: "waiting-derivation" });
      expect(wallet.resetAccountActivationSubmission).not.toHaveBeenCalled();
    }
  });

  it("reports ready once the mined transaction derived the account", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    const publicClient = {
      getTransactionReceipt: vi.fn(async () => ({ status: "success" as const })),
    };
    const result = await advanceAccountActivation({
      wallet,
      profile: PROFILE,
      node,
      publicClient,
      isReady: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });

    expect(result).toEqual({ kind: "ready" });
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: l1Submitted().l1TxHash });
    expect(wallet.resetAccountActivationSubmission).not.toHaveBeenCalled();
  });

  it("accepts canonical activation even when the Ethereum carrier reverted", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    const publicClient = {
      getTransactionReceipt: vi.fn(async () => ({ status: "reverted" as const })),
    };
    const result = await advanceAccountActivation({
      wallet,
      profile: PROFILE,
      node,
      publicClient,
      isReady: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });

    expect(result).toEqual({ kind: "ready" });
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: l1Submitted().l1TxHash });
    expect(wallet.resetAccountActivationSubmission).not.toHaveBeenCalled();
  });

  it("waits for PCASH after a reverted Ethereum carrier without resetting authorization", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    const result = await advanceAccountActivation({
      wallet, profile: PROFILE, node,
      publicClient: { getTransactionReceipt: vi.fn(async () => ({ status: "reverted" })) },
      isReady: async () => false,
      readiness: { attempts: 1 },
    });
    expect(result).toEqual({ kind: "waiting-derivation" });
    expect(wallet.resetAccountActivationSubmission).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed transaction without resetting the submission", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    const publicClient = {
      getTransactionReceipt: vi.fn(async () => {
        throw new Error("backend still indexing");
      }),
    };
    const result = await advanceAccountActivation({
      wallet,
      profile: PROFILE,
      node,
      publicClient,
      isReady: async () => false,
    });

    expect(result).toMatchObject({ kind: "l1-unconfirmed" });
    expect((result as { message: string }).message).toContain("backend still indexing");
    expect(wallet.resetAccountActivationSubmission).not.toHaveBeenCalled();
  });

  it("keeps waiting while PCASH trails a mined activation", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    const publicClient = {
      getTransactionReceipt: vi.fn(async () => ({ status: "success" as const })),
    };
    const result = await advanceAccountActivation({
      wallet,
      profile: PROFILE,
      node,
      publicClient,
      isReady: async () => false,
      readiness: { attempts: 1 },
    });

    expect(result).toEqual({ kind: "waiting-derivation" });
    expect(wallet.accountActivation).toHaveBeenCalledTimes(1);
  });

  it("polls for PCASH derivation after a mined activation", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    const publicClient = {
      getTransactionReceipt: vi.fn(async () => ({ status: "success" as const })),
    };
    const isReady = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const delay = vi.fn(async () => undefined);

    const result = await advanceAccountActivation({
      wallet,
      profile: PROFILE,
      node,
      publicClient,
      isReady,
      readiness: { attempts: 5, intervalMs: 250, delay },
    });

    expect(result).toEqual({ kind: "ready" });
    expect(isReady).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(250);
  });

  it("skips receipt observation with no pending L1 stage and checks readiness directly", async () => {
    const { wallet } = fakeWallet(null);
    const publicClient = {
      getTransactionReceipt: vi.fn(),
    };
    const ready = await advanceAccountActivation({
      wallet,
      profile: PROFILE,
      node,
      publicClient,
      isReady: readyProbe,
    });
    const waiting = await advanceAccountActivation({
      wallet,
      profile: PROFILE,
      node,
      publicClient,
      isReady: async () => false,
      readiness: { attempts: 1 },
    });

    expect(ready).toEqual({ kind: "ready" });
    expect(waiting).toEqual({ kind: "waiting-derivation" });
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe("activation with a lagging Ethereum RPC", () => {
  it("finishes an already-derived account without asking Ethereum for its receipt", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    wallet.defaultAccountReady.mockResolvedValue(true);
    const publicClient = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error("receipt unavailable")) };
    await expect(advanceAccountActivation({ wallet, profile: PROFILE, node, publicClient })).resolves.toEqual({ kind: "ready" });
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("checks readiness again on the next advance after a missing receipt", async () => {
    const { wallet } = fakeWallet(l1Submitted());
    const publicClient = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error("receipt unavailable")) };
    const options = { wallet, profile: PROFILE, node, publicClient };
    await expect(advanceAccountActivation(options)).resolves.toMatchObject({ kind: "l1-unconfirmed" });
    wallet.defaultAccountReady.mockResolvedValue(true);
    await expect(advanceAccountActivation(options)).resolves.toEqual({ kind: "ready" });
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(wallet.resetAccountActivationSubmission).not.toHaveBeenCalled();
  });
});
