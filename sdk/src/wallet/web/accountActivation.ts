// Headless account-activation advancement for browser wallet hosts.
//
// The Wallet activation state machine can pause at an Ethereum transaction
// whose outcome the host must observe (mined, reverted, or still unknown) and
// then wait for PCASH-side derivation. This helper owns that observation
// policy; the host only maps the returned advance onto its own UI phases.

import type { PcashNodeClient } from "@pcash/sdk/clients";
import { sleep } from "@pcash/sdk/utils";
import type { PcashProfile } from "../externalIdentity.ts";
import type { Wallet } from "../actions/walletClient.ts";
import type { RelayJournalRecovery } from "@pcash/sdk/relay";
import { TransactionNotFoundError, type Hash, type PublicClient } from "viem";
import {
  waitForDefaultAccount,
  type WaitForDefaultAccountOptions,
} from "../actions/accountReady.ts";

export type AccountActivationTransaction = { hash: string } & (
  | { state: "pending" | "included" | "missing" }
  | { state: "queued"; nonce: number; nextNonce: number }
);

/** Diagnose a receipt-less transaction using the configured Ethereum RPC. */
export async function inspectAccountActivationTransaction(
  publicClient: Pick<PublicClient, "getTransaction" | "getTransactionCount">,
  hash: string,
): Promise<AccountActivationTransaction> {
  let transaction;
  try {
    transaction = await publicClient.getTransaction({ hash: hash as Hash });
  } catch (cause) {
    if (cause instanceof TransactionNotFoundError) return { hash, state: "missing" };
    throw cause;
  }
  if (transaction.blockNumber !== null) return { hash, state: "included" };
  const nextNonce = await publicClient.getTransactionCount({ address: transaction.from, blockTag: "pending" });
  return transaction.nonce > nextNonce
    ? { hash, state: "queued", nonce: transaction.nonce, nextNonce }
    : { hash, state: "pending" };
}

/** Retire an expired setup only after Ethereum submission recovery has released its journal. */
export async function releaseExpiredAccountActivation(options: {
  wallet: Pick<Wallet, "accountActivation" | "clearAccountActivation">;
  node: Pick<PcashNodeClient, "status">;
  recovery: RelayJournalRecovery;
  contentHash: string;
}): Promise<void> {
  const reconciliation = await options.recovery.reconcile();
  const pending = await options.wallet.accountActivation();
  if (pending === null) return;
  // A different browser tab can change the submission after the user clicks.
  if (pending.contentHash !== options.contentHash) throw new Error("The account transaction changed. Review it before retrying.");
  const status = await options.node.status();
  if (status.latestBlockTimestamp <= BigInt(pending.validUntilTimestamp)) {
    throw new Error("The account transaction has not expired. Check its status before retrying.");
  }
  // Expiry limits PCASH admission, not Ethereum broadcast or delivery. The
  // wallet/RPC can still have a live carrier, or the node may not have derived
  // its successful delivery. Preserve the journal until recovery settles it.
  if (reconciliation.latched) {
    throw new Error(reconciliation.entries.some((entry) => entry.outcome === "unobserved")
      ? "Ethereum confirmed the account transaction. Wait for PCASH to process it before retrying setup."
      : "The earlier Ethereum submission is unresolved. Review it before retrying setup.");
  }
  if ((await options.recovery.show()).latched) {
    // Another tab can start a submission after reconciliation releases the lock.
    throw new Error("Another Ethereum submission needs review before retrying setup.");
  }
  await options.wallet.clearAccountActivation();
}

export type AccountActivationAdvance =
  | { kind: "ready" }
  | { kind: "reset-to-prepared"; message: string }
  | { kind: "l1-unconfirmed"; message: string }
  | { kind: "waiting-derivation" };

export interface AccountActivationAdvanceOptions {
  wallet: Pick<Wallet<unknown, unknown>, "accountActivation" | "resetAccountActivationSubmission" | "defaultAccountReady">;
  profile: PcashProfile;
  node: PcashNodeClient;
  /** One receipt lookup per advance; the host schedules subsequent advances. */
  publicClient: {
    getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{ status: string }>;
  };
  /** Readiness probe; defaults to the authenticated-account check. */
  isReady?: (profile: PcashProfile) => Promise<boolean>;
  /** Account-derivation polling policy; defaults to 25 attempts at 2 s. */
  readiness?: WaitForDefaultAccountOptions;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function waitUntilReady(options: AccountActivationAdvanceOptions): Promise<boolean> {
  if (options.isReady === undefined) {
    return waitForDefaultAccount(options.wallet, options.readiness);
  }
  const attempts = options.readiness?.attempts ?? 25;
  const intervalMs = options.readiness?.intervalMs ?? 2_000;
  const delay = options.readiness?.delay
    ?? sleep;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.readiness?.signal?.aborted) return false;
    if (await options.isReady(options.profile)) return true;
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  return false;
}

/**
 * Advance any pending activation one step. Returns `ready` when the account is
 * fully derived (the caller should clear activation and synchronize), or a
 * description of what the host should communicate while remaining in place.
 */
export async function advanceAccountActivation(
  options: AccountActivationAdvanceOptions,
): Promise<AccountActivationAdvance> {
  const { wallet, publicClient } = options;
  const pending = await wallet.accountActivation();
  if (pending?.state === "l1-submitted" && pending.l1TxHash !== null) {
    // PCASH may already have processed setup while the Ethereum RPC still
    // cannot serve the receipt. Readiness is sufficient to finish activation.
    if (await (options.isReady === undefined
      ? wallet.defaultAccountReady()
      : options.isReady(options.profile))) return { kind: "ready" };
    try {
      await publicClient.getTransactionReceipt({
        hash: pending.l1TxHash as `0x${string}`,
      });
    } catch (cause) {
      return {
        kind: "l1-unconfirmed",
        message: `Ethereum has not confirmed the activation transaction yet: ${message(cause)}`,
      };
    }
    if (!(await waitUntilReady(options))) {
      let receipts;
      try {
        receipts = await options.node.getReceipt({ contentHash: pending.contentHash });
      } catch {
        return { kind: "waiting-derivation" };
      }
      const transactionHash = pending.l1TxHash.toLowerCase();
      receipts = receipts.filter((receipt) => receipt.inclusion.l1TransactionHash.toLowerCase() === transactionHash);
      const failed = receipts.find((receipt) => receipt.outcome !== "succeeded");
      if (failed !== undefined && !receipts.some((receipt) => receipt.outcome === "succeeded")) {
        await wallet.resetAccountActivationSubmission();
        return {
          kind: "reset-to-prepared",
          message: `PCASH did not accept account setup (${failed.outcome}). Review the transaction before retrying.`,
        };
      }
      return {
        kind: "waiting-derivation",
      };
    }
    return { kind: "ready" };
  }
  if (!(await waitUntilReady(options))) return { kind: "waiting-derivation" };
  return { kind: "ready" };
}
