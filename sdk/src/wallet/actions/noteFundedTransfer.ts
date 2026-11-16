import type { PcashNodeClient } from "@pcash/sdk/clients";
import { missingSpendableCapability } from "../walletCapabilities.ts";
import { walletAction, type WalletAction } from "../walletAction.ts";
import {
  type DurableSubmissionAdapter,
  type DurableSubmissionCallbacks,
  type SettlePollOptions,
} from "./durableSubmission.ts";
import {
  runNoteFundedTransferClient,
  type NoteFundedClientResult,
  type NoteFundedProver,
  type NoteFundedTransferIntent,
} from "./noteFundedClient.ts";
import { WalletCapabilityError } from "./walletRuntime.ts";

export type NoteFundedSubmission<Prepared, Output> =
  (node: PcashNodeClient) => DurableSubmissionAdapter<Prepared, Output>;

/** Application-owned input for a default-rule note-funded transfer. */
export interface NoteFundedTransferActionParams<Prepared = unknown, Output = unknown>
  extends Omit<NoteFundedTransferIntent, "kind">, DurableSubmissionCallbacks, SettlePollOptions {
  prover: NoteFundedProver;
  /** Optional action-specific transport; otherwise the wallet's configured submission is used. */
  submission?: NoteFundedSubmission<Prepared, Output>;
}

/** Build a note-funded transfer that derives all wallet authority at execution time. */
export function noteFundedTransfer<Prepared = unknown, Output = unknown>(
  params: NoteFundedTransferActionParams<Prepared, Output>,
): WalletAction<NoteFundedClientResult<Output>> {
  return walletAction<NoteFundedClientResult<Output>, Prepared, Output>("note-funded-transfer", async (context) => {
    if (!context.spendable()) {
      throw new WalletCapabilityError(missingSpendableCapability(context)!, "note-funded transfer");
    }
    const {
      submission: suppliedSubmission,
      settlePollIntervalMs,
      settlePollMaxAttempts,
      ...intent
    } = params;
    const submission = suppliedSubmission?.(context.node) ?? context.submission;
    if (submission === undefined) {
      throw new WalletCapabilityError("submission", "note-funded transfer");
    }

    return runNoteFundedTransferClient({
      ...intent,
      kind: "payment",
      node: context.node,
      store: context.store,
      wallet: context.profile,
      signer: context.signer,
      chainId: context.network.chainId,
      status: context.status,
      submission,
      settlePollIntervalMs: settlePollIntervalMs ?? context.settlePollIntervalMs,
      settlePollMaxAttempts: settlePollMaxAttempts ?? context.settlePollMaxAttempts,
      synchronize: params.synchronize ?? context.synchronize,
      ...context.lifecycle.durableCallbacks(params),
    });
  });
}
