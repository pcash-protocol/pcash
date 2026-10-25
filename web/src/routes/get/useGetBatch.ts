import { useCallback, useEffect, useRef, useState } from "react";
import type { L1SubmissionAdapter } from "@pcash/sdk/wallet";
import { controlledIssuanceOpening, transactionIdentity } from "@pcash/sdk/protocol";
import { bytes32Hex } from "@pcash/sdk/utils";
import { useWallet, errorMessage } from "../../lib/WalletProvider.tsx";
import { planFastBatch } from "../../lib/fastBatch.ts";
import { inFlightContentHashes, prepareFastBatch } from "../../lib/prepareFastBatch.ts";
import { isRelayAttemptTracking, readRelayHistory, relayDeploymentKey, relayHistoryKey, saveRelayHistory, applyReleasedRelayAttempts, applyRecoveredRelayAttempts, RELAY_ATTEMPTS_RELEASED_EVENT, type RelayAttemptsReleasedDetail, type RelayAttempt } from "../../shared/relayHistory.ts";
import { useGetActivity, confirmDiscardGetWork } from "../../lib/GetActivity.tsx";
import { reconcileGetAttempt } from "./reconcileGetAttempt.ts";

/** An earlier Ethereum submission still blocks this wallet's next one. */
function journalConflict(cause: unknown): boolean {
  for (let error: unknown = cause; error instanceof Error; error = error.cause) {
    if (error.name === "RelayJournalConflictError") return true;
  }
  return false;
}

function unsettled(row: RelayAttempt): boolean {
  return row.status === "wallet" || (isRelayAttemptTracking(row) && row.collectedFee === undefined);
}

export function useGetBatch() {
  const context = useWallet();
  const { setActivity } = useGetActivity();
  const historyKey = context.connectedAccount === undefined || context.status === undefined ? undefined : relayHistoryKey(relayDeploymentKey(context.status), context.connectedAccount);
  const [attempts, setAttempts] = useState<RelayAttempt[]>(() => historyKey === undefined ? [] : readRelayHistory(historyKey));
  // A visit shows the batch it starts, or one an earlier visit left in flight; a finished batch is not shown again.
  const [shownId, setShownId] = useState(() => attempts.find(unsettled)?.id);
  const rows = useRef(attempts);
  const currentContext = useRef(context);
  currentContext.current = context;
  const [progress, setProgress] = useState<{ phase: string; message: string }>();
  const [error, setError] = useState<string>();
  // Whether the failure concerns an Ethereum submission the user can review.
  const [submissionError, setSubmissionError] = useState(false);
  const [trackingError, setTrackingError] = useState<string>();
  const running = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const publishing = useRef(false);
  const [finalCost, setFinalCost] = useState<bigint>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; running.current?.abort(); }; }, []);
  const update = useCallback((change: (rows: RelayAttempt[]) => RelayAttempt[]) => {
    rows.current = change(rows.current);
    if (historyKey !== undefined) saveRelayHistory(historyKey, rows.current);
    if (mounted.current) setAttempts(rows.current);
  }, [historyKey]);

  useEffect(() => {
    const apply = (event: Event) => {
      const detail = (event as CustomEvent<RelayAttemptsReleasedDetail>).detail;
      if (detail?.historyKey !== historyKey) return;
      update(current => applyReleasedRelayAttempts(applyRecoveredRelayAttempts(current, detail.recovered ?? []), detail.released));
    };
    window.addEventListener(RELAY_ATTEMPTS_RELEASED_EVENT, apply);
    return () => window.removeEventListener(RELAY_ATTEMPTS_RELEASED_EVENT, apply);
  }, [historyKey, update]);

  // Re-read canonical outcomes until finality, including when a block is reorganized away.
  useEffect(() => {
    if (context.connectedAccount === undefined || context.profile === undefined) return;
    let cancelled = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        let recoveryError: unknown;
        if (rows.current.some(row => row.status === "wallet" || row.status === "pending")) {
          try {
            const result = await currentContext.current.refreshSubmissionLock();
            if (cancelled) return;
            update(current => applyReleasedRelayAttempts(applyRecoveredRelayAttempts(current, result.recovered ?? []), result.released.flatMap(entry => entry.kind === "batch" ? [{
              resolutionId: entry.resolutionId, transactionHash: entry.transactionHash, selected: entry.selected,
            }] : [])));
          } catch (cause) { recoveryError = cause; }
        }
        const needsHash = rows.current.some(row => row.txHash === undefined && (row.status === "wallet" || row.status === "pending"));
        const recovery = needsHash ? await context.selfPublication?.l1Recovery?.() : undefined;
        const view = await recovery?.show();
        if (cancelled) return;
        if (view !== undefined) update(current => applyRecoveredRelayAttempts(current, view.entries.flatMap(entry => entry.kind === "batch" && entry.transactionHash !== null
          ? [{ resolutionId: entry.resolutionId, transactionHash: entry.transactionHash, selected: entry.selected }] : [])));
        for (const row of rows.current) {
          if (!isRelayAttemptTracking(row) || row.txHash === undefined) continue;
          const next = await reconcileGetAttempt(context.node, row, context.connectedAccount!, context.profile!);
          if (cancelled) return;
          update(current => current.map(old => old.id === row.id && old.status !== "failed" ? next : old));
        }
        if (!cancelled) setTrackingError(recoveryError === undefined ? undefined : errorMessage(recoveryError));
      } catch (cause) { if (!cancelled) setTrackingError(errorMessage(cause)); }
      finally { busy = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [context.node, context.connectedAccount, context.profile, context.selfPublication, update]);

  const start = async (count: number) => {
    const { wallet, selfPublication, profile, connectedAccount } = context;
    if (wallet === undefined || selfPublication === undefined || profile === undefined || connectedAccount === undefined || running.current !== undefined) return;
    const controller = new AbortController();
    running.current = controller;
    publishing.current = false;
    const id = crypto.randomUUID();
    setShownId(id);
    setError(undefined); setSubmissionError(false); setFinalCost(undefined);
    setActivity({ working: true, unsafeToLeave: true });
    setProgress({ phase: "preparing", message: "Selecting pending transactions…" });
    let preparedRow: RelayAttempt | undefined;
    const rememberBroadcast = (hash: string) => {
      if (preparedRow === undefined) return;
      const next: RelayAttempt = { ...preparedRow, txHash: hash, status: "pending" };
      update(current => [next, ...current.filter(row => row.id !== id)]);
      setActivity({ working: true, unsafeToLeave: false });
      if (mounted.current) setProgress({ phase: "confirming", message: "Waiting for Ethereum and PCASH inclusion…" });
    };
    try {
      await context.runAction(async () => {
        // Relaying proves nothing; the preflight quote of the selected transactions decides affordability.
        if (count > 0) await context.assertFasterGas();
        const initial = await context.readStatus();
        controller.signal.throwIfAborted();
        const ownPendingContentHashes = context.snapshot?.pendingContentHashes ?? [];
        // Relaying alone posts this wallet's pending transactions first, then those that pay best.
        const relayOnly = count === 0 ? await planFastBatch({ node: context.node, status: initial, profile,
          ownPendingContentHashes, transactionByteSize: 0n, requiredTransactionCount: 0, excludeContentHashes: await inFlightContentHashes(selfPublication) }) : undefined;
        const relayEntries = relayOnly === undefined ? undefined : [...relayOnly.own, ...relayOnly.companions.transactions];
        if (relayEntries?.length === 0) throw new Error("No worthwhile pending transactions to relay right now.");
        const submission: L1SubmissionAdapter = {
          ...selfPublication,
          async preflight(args) {
            controller.signal.throwIfAborted();
            const required = [args.transactionBytes, ...(args.additionalTransactions ?? [])];
            const status = await context.readStatus();
            const prepared = relayOnly === undefined
              ? await prepareFastBatch(selfPublication, { ...args, status }, { node: context.node, profile, ownPendingContentHashes })
              : await selfPublication.preflight({ ...args, status, companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] },
                requiredCollectibleOpenFee: relayOnly.companions.collectibleOpenFee });
            controller.signal.throwIfAborted();
            const description = selfPublication.describeBatch(prepared);
            const controlled = new Set([bytes32Hex(description.posterOwnerCommitment)]);
            for (const entry of description.transactions) {
              const opening = controlledIssuanceOpening(entry, status.pcashChainId, profile);
              if (opening !== null) controlled.add(bytes32Hex(opening.ownerCommitment));
            }
            preparedRow = { id, at: Date.now(), contentHashes: [...description.selected], controlledCommitments: [...controlled], mineContentHashes: count === 0 ? [] : required.map(entry => transactionIdentity(entry).contentHash), ownContentHashes: [...ownPendingContentHashes], status: "wallet" };
            if (mounted.current) setFinalCost(description.quote.maximumCostWei);
            return prepared;
          },
          async submit(args) {
            publishing.current = true;
            if (preparedRow !== undefined) update(current => [preparedRow!, ...current.filter(row => row.id !== id)]);
            return selfPublication.submit({ ...args, onL1Journaled: async entry => {
              await args.onL1Journaled?.(entry);
              if (preparedRow !== undefined) {
                preparedRow = { ...preparedRow, resolutionId: entry.resolutionId };
                const journaled = preparedRow;
                update(current => current.map(row => row.id === id ? { ...row, resolutionId: journaled.resolutionId! } : row));
              }
            }, onL1Submitted: async hash => {
              await args.onL1Submitted?.(hash);
              rememberBroadcast(hash);
            } });
          },
        };
        const result = await wallet.mineBatch({ count, submission, signal: controller.signal,
          ...(relayEntries === undefined ? {} : { relayEntries }),
          onProgress: (phase, message) => { if (mounted.current) setProgress({ phase, message }); },
        });
        if (result.submission.l1Hash !== undefined) rememberBroadcast(result.submission.l1Hash);
        await context.refreshSubmissionLock();
      });
    } catch (cause) {
      if (mounted.current && !(cause instanceof Error && cause.name === "AbortError")) {
        setError(errorMessage(cause));
        setSubmissionError(publishing.current || journalConflict(cause));
      }
      // A lost wallet response can leave a recoverable broadcast with no hash yet.
      if (publishing.current && preparedRow !== undefined) {
        const recovery = await selfPublication.l1Recovery?.().catch(() => undefined);
        const view = await recovery?.show().catch(() => undefined);
        const selected = new Set(preparedRow.contentHashes.map(value => value.toLowerCase()));
        const journal = view?.entries.find(entry => entry.kind === "batch" && entry.selected.length === selected.size && entry.selected.every(value => selected.has(value.toLowerCase())));
        if (journal?.transactionHash != null) rememberBroadcast(journal.transactionHash);
        else update(current => current.map(row => row.id === id ? { ...row, status: row.txHash !== undefined ? row.status : selfPublication.isDefinitePreBroadcastError?.(cause) === true ? "failed" : "pending", error: errorMessage(cause), ...(journal === undefined ? {} : { resolutionId: journal.resolutionId }) } : row));
        await context.refreshSubmissionLock().catch(() => undefined);
      }
    } finally {
      if (mounted.current) setProgress(undefined);
      running.current = undefined;
      setActivity({ working: false, unsafeToLeave: false });
    }
  };
  return { start, progress, error, submissionError, trackingError, finalCost, attempts, current: attempts.find(row => row.id === shownId), cancel: () => { if (!publishing.current && running.current !== undefined && confirmDiscardGetWork("Cancel this batch? Unsubmitted proof work will be discarded.")) running.current.abort(); } };
}
