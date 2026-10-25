import { useCallback, useEffect, useRef, useState } from "react";
import { pollReceipt } from "@pcash/sdk/clients";
import { DurablePreBroadcastError, type DurableSubmissionAdapter, type DurableSubmissionCallbacks, type L1SubmissionAdapter } from "@pcash/sdk/wallet";
import { formatPcashAmount } from "../../components/pcashAmount.ts";
import { prepareFastBatch } from "../../lib/prepareFastBatch.ts";
import { forgetTokenActivity, markTokenActivitySubmitted, readTokenActivity, recordTokenActivity, walletTokenActivityKey, type TokenActivity } from "../../lib/tokenActivity.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import type { SubmissionMode } from "../../lib/WebsiteSettings.tsx";
import { tokenFailure, type TokenFailure } from "./EthereumSubmission.tsx";

/** How the action reaches Ethereum, and the PCASH it pays for that. */
export interface TokenPublicationChoice {
  mode: SubmissionMode;
  /** Open relay only. */
  openFeeAmount: bigint;
}

export interface TokenPublication extends DurableSubmissionCallbacks {
  submission?: DurableSubmissionAdapter;
  openFeeAmount?: bigint;
}

export interface TokenTransactionResult {
  contentHash: string;
  accepted: boolean;
}

export type TokenRunOutcome<Result> =
  | { state: "sent"; result: Result; l1Hash?: string }
  | { state: "broadcast"; contentHash: string; l1Hash: string }
  | { state: "unknown"; contentHash: string }
  | ({ state: "failed" } & TokenFailure);

export type TokenTxStage =
  | { state: "idle" }
  | { state: "working" }
  | { state: "submitting"; contentHash: string }
  | { state: "sent"; contentHash: string; mode: SubmissionMode; accepted: boolean; l1Hash?: string }
  | { state: "unknown"; contentHash: string; mode: SubmissionMode }
  | ({ state: "failed" } & TokenFailure);

/** What a journaled transaction became: included, still waiting, or gone without effect. */
export type TokenTransactionFate = "confirmed" | "pending" | "cleared";

/** The PCASH a publication choice spends. Fast pays Ethereum gas instead. */
export function pcashFeeFor(choice: TokenPublicationChoice): bigint {
  return choice.mode === "fast" ? 0n : choice.openFeeAmount;
}

/**
 * Plain words for a fee the wallet cannot pay, or undefined when it can or the
 * balance is not known yet. An action of several proofs pays the fee for each.
 */
export function missingPcashMessage(choice: TokenPublicationChoice, spendablePcash: bigint | undefined, zeroFeeAllowed = true, proofs = 1): string | undefined {
  const fee = pcashFeeFor(choice);
  const total = fee * BigInt(proofs);
  if (fee === 0n || spendablePcash === undefined || spendablePcash >= total) return undefined;
  const amount = formatPcashAmount(fee, { rounding: "up" });
  return `This relayer fee is paid in PCASH: ${proofs > 1 ? `${amount} for each of ${proofs} proofs, ${formatPcashAmount(total, { rounding: "up" })} in all` : amount}. Your wallet has ${formatPcashAmount(spendablePcash, { rounding: "down" })} available. Choose Faster to pay Ethereum gas instead${zeroFeeAllowed ? ", or set the relayer fee to 0" : ""}.`;
}

/**
 * One token action at a time: its publication route, proof progress,
 * submission, and the ambiguous state where the exact bytes are journaled but
 * the network's answer never arrived.
 */
export function useTokenTransaction() {
  const wallet = useWallet();
  const [stage, setStage] = useState<TokenTxStage>({ state: "idle" });
  const attemptRef = useRef(0);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  useEffect(() => () => { attemptRef.current += 1; }, []);

  const publicationFor = useCallback(async (choice: TokenPublicationChoice, onL1Hash: (hash: string) => void): Promise<TokenPublication> => {
    const { node, selfPublication, profile, snapshot } = walletRef.current;
    if (choice.mode === "fast") {
      if (selfPublication === undefined) throw new Error("Connect an Ethereum wallet to publish it yourself.");
      await walletRef.current.assertFasterGas();
      const adapter = selfPublication;
      const submission: L1SubmissionAdapter = {
        ...adapter,
        // Carrying other pending work in the same batch is an optimization; without it the action posts alone.
        preflight: (context) => profile === undefined ? adapter.preflight(context)
          : prepareFastBatch(adapter, context, { node, profile, ownPendingContentHashes: snapshot?.pendingContentHashes ?? [] }),
        submit: async (params) => {
          const result = await adapter.submit({
            ...params,
            onL1Submitted: async (hash) => {
              onL1Hash(hash);
              await params.onL1Submitted?.(hash);
            },
          });
          if (result.l1Hash !== undefined) onL1Hash(result.l1Hash);
          return result;
        },
      };
      return { submission: submission as DurableSubmissionAdapter };
    }
    return { openFeeAmount: choice.openFeeAmount };
  }, []);

  /** Prove and submit once. The stage and the returned outcome say where it ended. */
  const run = useCallback(async <Result extends TokenTransactionResult>(
    choice: TokenPublicationChoice,
    execute: (publication: TokenPublication) => Promise<Result>,
    /** What the action does, recorded for the Activity feed once its exact bytes are journaled. */
    activity?: Omit<TokenActivity, "contentHash" | "at" | "awaitingSubmission">,
  ): Promise<TokenRunOutcome<Result>> => {
    const attempt = ++attemptRef.current;
    const current = () => attemptRef.current === attempt;
    let key: string | undefined;
    const activityKey = () => activity === undefined ? undefined : key ??= walletTokenActivityKey(walletRef.current);
    const known = (target: string, contentHash: string) => readTokenActivity(target).some((entry) => entry.contentHash === contentHash.toLowerCase());
    // Set only when this attempt created the entry: a refusal before broadcast then removes it again.
    let recordedContentHash: string | undefined;
    const prepared = (contentHash: string) => {
      const target = activityKey();
      if (target === undefined || known(target, contentHash)) return;
      recordTokenActivity(target, { ...activity!, contentHash, at: Date.now(), awaitingSubmission: true });
      recordedContentHash = contentHash;
    };
    const submitted = (contentHash: string) => {
      const target = activityKey();
      if (target === undefined) return;
      if (known(target, contentHash)) markTokenActivitySubmitted(target, contentHash);
      else recordTokenActivity(target, { ...activity!, contentHash, at: Date.now() });
    };
    let journaledContentHash: string | undefined;
    let l1Hash: string | undefined;
    setStage({ state: "working" });
    try {
      const result = await walletRef.current.runAction(async () => {
        const publication = await publicationFor(choice, (hash) => {
          l1Hash = hash;
          if (journaledContentHash !== undefined) submitted(journaledContentHash);
        });
        return execute({
          ...publication,
          onPrepared: (contentHash) => {
            journaledContentHash = contentHash;
            prepared(contentHash);
            if (current()) setStage({ state: "submitting", contentHash });
          },
        });
      });
      submitted(result.contentHash);
      if (current()) setStage({ state: "sent", contentHash: result.contentHash, mode: choice.mode, accepted: result.accepted, ...(l1Hash === undefined ? {} : { l1Hash }) });
      return { state: "sent", result, ...(l1Hash === undefined ? {} : { l1Hash }) };
    } catch (cause) {
      // A broadcast Ethereum transaction is known even if the receipt wait failed.
      const outcome: TokenRunOutcome<Result> = journaledContentHash !== undefined && l1Hash !== undefined
        ? { state: "broadcast", contentHash: journaledContentHash, l1Hash }
        : journaledContentHash !== undefined && !(cause instanceof DurablePreBroadcastError)
          ? { state: "unknown", contentHash: journaledContentHash }
          : { state: "failed", ...tokenFailure(cause, choice.mode === "fast") };
      if (outcome.state === "broadcast") submitted(outcome.contentHash);
      else if (outcome.state === "failed" && recordedContentHash !== undefined) forgetTokenActivity(key!, recordedContentHash);
      if (current()) {
        setStage(outcome.state === "broadcast" ? { state: "sent", contentHash: outcome.contentHash, mode: choice.mode, accepted: false, l1Hash: outcome.l1Hash }
          : outcome.state === "unknown" ? { state: "unknown", contentHash: outcome.contentHash, mode: choice.mode }
            : outcome);
      }
      return outcome;
    }
  }, [publicationFor]);

  /** Synchronize, then ask the chain and the journal what became of one exact transaction. */
  const fate = useCallback(async (contentHash: string): Promise<TokenTransactionFate> => {
    const { wallet: opened, node, synchronize } = walletRef.current;
    if (opened === undefined) throw new Error("Open your wallet to check this transaction.");
    await synchronize();
    // Journal first: the wallet retires an entry only after finality or expiry, so a
    // missing entry with no accepted receipt means the transaction had no effect.
    const pending = (await opened.snapshot()).pendingContentHashes.includes(contentHash.toLowerCase());
    const receipt = await pollReceipt(node, contentHash);
    if (receipt?.outcome === "succeeded") return "confirmed";
    return pending ? "pending" : "cleared";
  }, []);

  const reset = useCallback(() => {
    attemptRef.current += 1;
    setStage({ state: "idle" });
  }, []);

  return { stage, setStage, run, fate, reset, publicationFor };
}
