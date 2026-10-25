import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { pollReceipt, type PcashNodeClient } from "@pcash/sdk/clients";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { DurablePreBroadcastError, type WalletBulkJob, type WalletBulkRecovery } from "@pcash/sdk/wallet";
import { Notice } from "../../components/Notice.tsx";
import { formatPcashInput } from "../../components/pcashAmount.ts";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { formatTokenAmount, formatTokenInput, parseTokenAmount, type AmountUnit } from "../../components/tokenAmount.ts";
import { errorMessage, useWallet } from "../../lib/WalletProvider.tsx";
import { NAMES_OFF_MESSAGE } from "../../names/NameResolutionSession.ts";
import { useEthereumNameResolver } from "../../names/useEthereumName.ts";
import { normalizeIdentityName } from "../explorer/identityName.ts";
import { transactionPath } from "../explorer/paths.ts";
import { describeRecipient, shortValue } from "../wallet/model.ts";
import { NO_RECEIVE_KEY_MESSAGE } from "../wallet/useRecipient.ts";
import { parseDistributionLines } from "./model.ts";
import { checkedPublication, TokenPublicationFields, usePublicationDraft } from "./TokenPublicationFields.tsx";
import { useTokenTransaction, type TokenPublicationChoice } from "./useTokenTransaction.ts";
import { EthereumSubmissionLock, tokenFailure } from "./EthereumSubmission.tsx";
import styles from "./Tokens.module.css";

const S_SHAPE = PRIVATE_VALUE_PROFILES.S.shapeId;
const DISTRIBUTION_RECOVERY_TAG = Uint8Array.of(0);

function isDistributionRecovery(tag: Uint8Array): boolean {
  return tag.length === 1 && tag[0] === DISTRIBUTION_RECOVERY_TAG[0];
}

interface CheckedRecipient {
  line: number;
  to: string;
  amount: bigint;
}

interface CheckedList {
  recipients: CheckedRecipient[];
  paymentCount: number;
  total: bigint;
  choice: TokenPublicationChoice;
}

/**
 * Recipients a browser proof pays at once: the proof's outputs less the token
 * change and the PCASH change a fee leaves.
 */
export function recipientsPerProof(choice: TokenPublicationChoice): number {
  const fee = choice.mode === "slow" ? choice.openFeeAmount : 0n;
  return PRIVATE_VALUE_PROFILES.S.outputs - 1 - (fee > 0n ? 1 : 0);
}

/** Proofs a distribution to `recipients` takes when each pays a fee, which leaves room for fewer recipients. */
export function feePayingProofs(recipients: number): number {
  return Math.max(1, Math.ceil(recipients / recipientsPerProof({ mode: "slow", openFeeAmount: 1n })));
}

export type DistributionState = "complete" | "needs-review" | "in-progress";

type BulkChunk = WalletBulkJob["chunks"][number];

/** A chunk pays its recipients once the chain accepts it; finality is not awaited. */
function chunkPaid(chunk: BulkChunk, accepted: ReadonlySet<string>): boolean {
  return chunk.outcome === "succeeded" || (chunk.outcome === "unresolved" && accepted.has(chunk.contentHash.toLowerCase()));
}

/** Content hashes of the jobs' unresolved chunks that have an accepted receipt at the node's head. */
async function acceptedChunks(node: PcashNodeClient, jobs: readonly WalletBulkJob[]): Promise<Set<string>> {
  const contentHashes = jobs.flatMap((job) => job.chunks.filter((chunk) => chunk.outcome === "unresolved").map((chunk) => chunk.contentHash.toLowerCase()));
  const receipts = await Promise.all(contentHashes.map((contentHash) => pollReceipt(node, contentHash).catch(() => null)));
  return new Set(contentHashes.filter((_, index) => receipts[index]?.outcome === "succeeded"));
}

export function distributionProgress(job: WalletBulkJob, accepted: ReadonlySet<string> = new Set()) {
  const assigned = job.chunks.reduce((sum, chunk) => sum + chunk.recipientCount, 0);
  const count = (match: (chunk: BulkChunk) => boolean) => job.chunks
    .filter(match).reduce((sum, chunk) => sum + chunk.recipientCount, 0);
  const paid = count((chunk) => chunkPaid(chunk, accepted));
  const submitted = count((chunk) => chunk.outcome === "unresolved" && !accepted.has(chunk.contentHash.toLowerCase()));
  const failed = count((chunk) => chunk.outcome === "expired" || chunk.outcome === "conflicted");
  const state: DistributionState = failed > 0 || job.recovery?.invalidated === true ? "needs-review"
    : paid === job.recipients.length ? "complete" : "in-progress";
  return { assigned, paid, submitted, failed, state };
}

/** Recipients no confirmed or pending proof pays: expired and conflicted proofs, then everyone not yet reached. */
export function unpaidRecipients(job: WalletBulkJob): WalletBulkJob["recipients"] {
  const assigned = job.chunks.reduce((sum, chunk) => sum + chunk.recipientCount, 0);
  return [
    ...job.chunks.filter((chunk) => chunk.outcome === "expired" || chunk.outcome === "conflicted")
      .flatMap((chunk) => job.recipients.slice(chunk.firstRecipient, chunk.firstRecipient + chunk.recipientCount)),
    ...job.recipients.slice(assigned),
  ];
}

function sleep(milliseconds: number, stop: { stopped: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => (stop.stopped || Date.now() - started >= milliseconds ? resolve() : setTimeout(tick, 250));
    tick();
  });
}

export function TokenDistribute({ assetId, unit, spendable }: { assetId: bigint; unit: AmountUnit; spendable: bigint }) {
  const wallet = useWallet();
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const nameResolver = useEthereumNameResolver();
  const { publicationFor } = useTokenTransaction();
  const [text, setText] = useState("");
  const [selectedRecovery, setSelectedRecovery] = useState<WalletBulkRecovery>();
  const [selectedRepair, setSelectedRepair] = useState<WalletBulkJob>();
  // Every proof pays the fee: the default is pre-filled only if the wallet can pay it for the whole list.
  const parsedRecipientCount = parseDistributionLines(text).entries.length;
  const recoveredPaidCount = selectedRecovery?.paidOriginalIndexes.filter(index => index < parsedRecipientCount).length ?? 0;
  const listProofs = feePayingProofs(parsedRecipientCount - recoveredPaidCount);
  const [draft, setDraft] = usePublicationDraft(true, listProofs);
  const [checked, setChecked] = useState<CheckedList>();
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  /** The distribution the list in the box started, until the list is edited. */
  const listJobRef = useRef<string | undefined>(undefined);
  const [problems, setProblems] = useState<{ line: number; message: string }[]>([]);
  const [jobs, setJobs] = useState<WalletBulkJob[]>([]);
  const [recoveries, setRecoveries] = useState<WalletBulkRecovery[]>([]);
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState<{ jobId: string; message: string; proving: boolean }>();
  const [outcome, setOutcome] = useState<{ jobId: string; tone: "error" | "warning" | "success"; message: string; fast?: boolean }>();
  const stopRef = useRef<{ stopped: boolean } | undefined>(undefined);
  const textArea = useRef<HTMLTextAreaElement>(null);

  const refreshJobs = useCallback(async () => {
    const opened = walletRef.current.wallet;
    if (opened === undefined) return;
    const [allJobs, allRecoveries] = await Promise.all([opened.bulkJobs(), opened.bulkRecoveries()]);
    const shown = allJobs.filter((job) => job.kind === "payment" && job.assetId === assetId
      && (job.recovery === null || isDistributionRecovery(job.recovery.appTag))).reverse();
    const found = await acceptedChunks(walletRef.current.node, shown);
    setJobs(shown);
    setRecoveries(allRecoveries.filter((recovery) =>
      !recovery.known && recovery.assetId === assetId && isDistributionRecovery(recovery.appTag)));
    setAccepted(found);
    return found;
  }, [assetId]);
  useEffect(() => { void refreshJobs().catch(() => undefined); }, [refreshJobs, wallet.snapshot]);
  useEffect(() => () => { if (stopRef.current !== undefined) stopRef.current.stopped = true; }, []);

  const edit = (value: string) => { listJobRef.current = undefined; setText(value); setChecked(undefined); setProblems([]); };

  const checkList = async () => {
    setChecking(true);
    setChecked(undefined);
    try {
      const { entries, errors } = parseDistributionLines(text);
      const found = [...errors];
      if (listJobRef.current !== undefined) found.push({ line: 0, message: "The distribution below already pays this list. Continue it there, or change the list to start another." });
      const recipients: CheckedRecipient[] = [];
      const recoveredPaid = new Set(selectedRecovery?.paidOriginalIndexes ?? []);
      for (const [index, entry] of entries.entries()) {
        let amount: bigint;
        try {
          amount = parseTokenAmount(entry.amountText, unit.decimals, { label: "Amount" });
        } catch (cause) {
          found.push({ line: entry.line, message: errorMessage(cause) });
          continue;
        }
        let to = entry.to;
        const name = normalizeIdentityName(entry.to);
        if (name !== undefined) {
          if (nameResolver === undefined) { found.push({ line: entry.line, message: NAMES_OFF_MESSAGE }); continue; }
          const resolved = await nameResolver.resolveName(name).catch(() => undefined);
          if (resolved == null) {
            found.push({ line: entry.line, message: resolved === null ? `${name} does not resolve to an Ethereum address.` : `${name} could not be resolved. Check again.` });
            continue;
          }
          to = resolved.address;
        } else {
          const described = describeRecipient(entry.to);
          if (described.kind === "invalid") { found.push({ line: entry.line, message: described.message }); continue; }
        }
        if (!recoveredPaid.has(index) && await wallet.wallet?.hasReceiveKey(to) === false) { found.push({ line: entry.line, message: NO_RECEIVE_KEY_MESSAGE }); continue; }
        recipients.push({ line: entry.line, to, amount });
      }
      found.sort((a, b) => a.line - b.line);
      if (selectedRecovery !== undefined && recipients.length !== selectedRecovery.recipientCount) {
        found.push({ line: 0, message: `The original list had ${selectedRecovery.recipientCount} recipients.` });
      }
      const remaining = recipients.filter((_, index) => !recoveredPaid.has(index));
      const total = remaining.reduce((sum, recipient) => sum + recipient.amount, 0n);
      if (entries.length === 0 && errors.length === 0) found.push({ line: 0, message: "Add at least one recipient." });
      if (total > spendable) {
        found.push({ line: 0, message: `The list totals ${formatTokenAmount(total, unit, { rounding: "up" })}, more than the ${formatTokenAmount(spendable, unit, { rounding: "down" })} you have available.` });
      }
      const publication = checkedPublication(draft, wallet.funds?.spendablePrivate, true, feePayingProofs(remaining.length));
      if ("problem" in publication) found.push({ line: 0, message: publication.problem });
      setProblems(found);
      if (found.length === 0 && "choice" in publication) setChecked({ recipients, paymentCount: remaining.length, total, choice: publication.choice });
    } catch (cause) {
      setProblems([{ line: 0, message: errorMessage(cause) }]);
    } finally {
      setChecking(false);
    }
  };

  /**
   * Prove and submit chunks one at a time until the job is done, stopped, or
   * needs a person. A saved chunk the chain has not accepted, and this run has
   * not sent, is resubmitted byte for byte before any new one is proved.
   */
  const run = async (jobId: string, choice: TokenPublicationChoice) => {
    // One run at a time: a second click before the first run renders must not start another.
    if (stopRef.current !== undefined) return;
    const token = { stopped: false };
    stopRef.current = token;
    setOutcome(undefined);
    let journaled = false;
    const status = (message: string, proving = false) => { if (stopRef.current === token) setRunning({ jobId, message, proving }); };
    status("Checking this distribution…");
    const acceptedChunk = new Set<string>();
    const sent = new Set<string>();
    // A finished distribution clears the list that started it.
    const paid = () => {
      setOutcome({ jobId, tone: "success", message: "Every recipient is paid." });
      if (listJobRef.current === jobId) edit("");
    };
    try {
      while (!token.stopped) {
        const { wallet: opened, runAction, node } = walletRef.current;
        if (opened === undefined) throw new Error("Open your wallet to continue this distribution.");
        const job = (await opened.bulkJobs()).find((candidate) => candidate.jobId === jobId);
        if (job === undefined) throw new Error("This distribution is no longer in this wallet.");
        let chunkIndex = job.chunks.length;
        for (const [index, chunk] of job.chunks.entries()) {
          const contentHash = chunk.contentHash.toLowerCase();
          if (chunk.outcome !== "unresolved" || acceptedChunk.has(contentHash) || sent.has(contentHash)) continue;
          if ((await pollReceipt(node, contentHash).catch(() => null))?.outcome === "succeeded") {
            acceptedChunk.add(contentHash);
            continue;
          }
          chunkIndex = index;
          break;
        }
        const resubmit = chunkIndex < job.chunks.length;
        const { openFeeAmount: _open, ...route } = await publicationFor(choice, () => undefined);
        status(resubmit ? "Submitting the unconfirmed payment again…" : "Preparing the next payment…", !resubmit);
        journaled = false;
        const step = await runAction(() => opened.runBulkJobStep({
          jobId, chunkIndex, ...route,
          onPrepared: () => { journaled = true; },
        }));
        if (step.state === "submitted") sent.add(step.result.contentHash.toLowerCase());
        const acceptedNow = await refreshJobs();
        if (step.state === "complete") {
          paid();
          return;
        }
        if (step.state === "needs-review") {
          setOutcome({ jobId, tone: "warning", message: "Some payments did not go through, so their recipients were not paid. Distribute to the unpaid recipients to finish." });
          return;
        }
        if (step.state === "limit-reached") {
          setOutcome({ jobId, tone: "warning", message: "This distribution used all the transactions it was approved for. Distribute to the unpaid recipients to finish." });
          return;
        }
        if (step.state === "waiting-for-confirmation") {
          const latest = (await opened.bulkJobs()).find((candidate) => candidate.jobId === jobId)!;
          if (acceptedNow !== undefined && latest.chunks.every((chunk) => chunkPaid(chunk, acceptedNow))) {
            paid();
            return;
          }
          status("Every payment is submitted. Waiting for the last one to reach the chain…");
          await sleep(4_000, token);
        } else if (step.state === "waiting-for-funding") {
          const latest = (await opened.bulkJobs()).find((candidate) => candidate.jobId === jobId)!;
          if (!latest.chunks.some((chunk) => chunk.outcome === "unresolved")) {
            setOutcome({ jobId, tone: "error", message: `Your wallet cannot fund the next payment. It needs enough ${unit.symbol} for the next recipients${choice.mode === "fast" ? "" : " and PCASH for the fee"}.` });
            return;
          }
          status("Waiting for the previous payment’s change before the next one…");
          await sleep(4_000, token);
        }
      }
    } catch (cause) {
      if (stopRef.current !== token) return;
      const ambiguous = journaled && !(cause instanceof DurablePreBroadcastError);
      const failure = tokenFailure(cause, choice.mode === "fast");
      const fast = failure.fast === true ? { fast: true } : {};
      setOutcome(ambiguous
        ? { jobId, tone: "warning", message: "We couldn’t confirm whether the last payment reached the network. Continue submits it again.", ...fast }
        : { jobId, tone: "error", message: failure.blocked ? "An earlier Ethereum submission from this wallet must settle before the next payment."
          : failure.message.includes("another publication mode")
            ? "An unconfirmed payment in this distribution used another submission mode. Choose that mode to submit it again."
            : failure.message, ...fast });
    } finally {
      if (stopRef.current === token) {
        stopRef.current = undefined;
        setRunning(undefined);
      }
    }
  };

  const start = async () => {
    const opened = wallet.wallet;
    if (checked === undefined || opened === undefined) return;
    setStarting(true);
    try {
      let job: WalletBulkJob;
      try {
        job = await wallet.runAction(() => opened.startBulkJob({
          kind: "payment", assetId, recipients: checked.recipients.map(({ to, amount }) => ({ to, amount })),
          openFeeAmount: checked.choice.mode === "slow" ? checked.choice.openFeeAmount : 0n,
          maxTransactions: checked.recipients.length, shape: S_SHAPE,
          recovery: {
            appTag: DISTRIBUTION_RECOVERY_TAG,
            ...(selectedRecovery === undefined ? {} : { resumeRecoveryJobId: selectedRecovery.recoveryJobId }),
            ...(selectedRepair === undefined ? {} : { continueLocalJobId: selectedRepair.jobId }),
          },
        }));
      } catch (cause) {
        setProblems([{ line: 0, message: errorMessage(cause) }]);
        return;
      }
      // The list stays in the box, but only its distribution pays it now.
      listJobRef.current = job.jobId;
      setSelectedRecovery(undefined);
      setSelectedRepair(undefined);
      setChecked(undefined);
      await refreshJobs();
      await run(job.jobId, checked.choice);
    } finally {
      setStarting(false);
    }
  };

  /** Continuing uses the job's approved open fee; the page's route choice applies to new payments. */
  const continuation = (job: WalletBulkJob) => {
    const unstarted = job.recipients.length - job.chunks.reduce((sum, chunk) => sum + chunk.recipientCount, 0);
    const publication = checkedPublication({ ...draft, openFee: formatPcashInput(job.openFeeAmounts[S_SHAPE]) }, wallet.funds?.spendablePrivate, true, feePayingProofs(unstarted));
    if ("problem" in publication) { setOutcome({ jobId: job.jobId, tone: "error", message: publication.problem }); return; }
    void run(job.jobId, publication.choice);
  };

  const distributeUnpaid = (job: WalletBulkJob) => {
    edit(unpaidRecipients(job).map((recipient) => `${recipient.to}, ${formatTokenInput(recipient.amount, unit.decimals)}`).join("\n"));
    setSelectedRecovery(undefined);
    setSelectedRepair(job.recovery === null ? undefined : job);
    textArea.current?.focus();
  };

  const activeJob = running?.jobId;
  const working = starting || running !== undefined;
  const perProof = checked === undefined ? undefined : recipientsPerProof(checked.choice);
  return <div className={styles.form}>
    <p className={styles.hint}>Pay many people at once. Each proof in your browser pays a few recipients, so a long list takes several proofs, one after another. Progress is saved in your wallet: you can leave and continue later.</p>
    {selectedRecovery !== undefined && <Notice>Paste the complete original recipient list. The wallet will match it to the recovered distribution and pay only the recipients it finds no payment for. <button type="button" className={styles.linkButton} disabled={working} onClick={() => { setSelectedRecovery(undefined); setChecked(undefined); setProblems([]); }}>Cancel recovery</button></Notice>}
    {selectedRepair !== undefined && <Notice>This list holds the recipients from the selected distribution who were not paid. They stay part of that distribution, so no one is paid twice. <button type="button" className={styles.linkButton} disabled={working} onClick={() => { setSelectedRepair(undefined); setChecked(undefined); setProblems([]); }}>Cancel retry</button></Notice>}
    <label>Recipients, one per line<textarea ref={textArea} value={text} onChange={(event) => edit(event.target.value)} rows={6} spellCheck={false}
      placeholder={"0x1234…abcd, 100\nalice.eth, 25.5"} disabled={working} /></label>
    <p className={styles.hint}>Write each recipient (address or ENS name), a comma, then the amount in {unit.symbol}.</p>
    <TokenPublicationFields draft={draft} onChange={(next) => { setDraft(next); setChecked(undefined); }} disabled={working} proofs={listProofs} />
    {problems.length > 0 && <ul className={styles.lineErrors} aria-label="Problems with the list">
      {problems.map((problem, index) => <li key={index}>{problem.line > 0 ? `Line ${problem.line}: ` : ""}{problem.message}</li>)}</ul>}
    {checked === undefined
      ? <div className={styles.actions}><button type="button" className="button" disabled={checking || text.trim() === "" || working} onClick={() => void checkList()}>{checking ? "Checking…" : "Check list"}</button></div>
      : <div>
        <dl className={styles.review}>
          <dt>{selectedRecovery === undefined ? "Recipients" : "Recipients left"}</dt><dd>{checked.paymentCount}</dd>
          <dt>{selectedRecovery === undefined ? "Total" : "Remaining total"}</dt><dd><TokenAmount value={checked.total} unit={unit} /></dd>
          <dt>Proofs</dt><dd>About {Math.ceil(checked.paymentCount / perProof!)}, up to {perProof} recipients each</dd>
        </dl>
        <div className={styles.actions}><button type="button" className="button primary" disabled={wallet.busy || working} onClick={() => void start()}>{selectedRecovery !== undefined ? "Resume distribution" : selectedRepair !== undefined ? "Retry unpaid recipients" : "Start distribution"}</button></div>
      </div>}
    {recoveries.length > 0 && <div aria-label="Recovered distributions">
      {recoveries.map((recovery) => {
        const paid = recovery.paidOriginalIndexes.length;
        const waiting = recovery.resumeAfterTimestamp !== null
          && (recovery.observedThroughTimestamp === null || recovery.observedThroughTimestamp <= recovery.resumeAfterTimestamp);
        return <section key={recovery.recoveryJobId} className={styles.job}>
          <div className={styles.jobHead}>
            <strong>Recovered distribution to {recovery.recipientCount} recipients</strong>
            <span className={`${styles.chip} ${paid === recovery.recipientCount ? styles.chipDone : styles.chipWarn}`}>
              {paid === recovery.recipientCount ? "Complete" : "Needs original list"}</span>
          </div>
          <p className={styles.hint}>{paid} paid · {recovery.recipientCount - paid} with no payment found</p>
          {waiting && <p className={styles.hint}>Keep the wallet synchronized until {new Date(Number(recovery.resumeAfterTimestamp!) * 1_000).toLocaleString()} so payments sent before this wallet was restored have time to appear.</p>}
          {paid < recovery.recipientCount && <div className={styles.actions}><button type="button" className="button primary"
            disabled={working || waiting} onClick={() => { setSelectedRecovery(recovery); setSelectedRepair(undefined); setChecked(undefined); setProblems([]); textArea.current?.focus(); }}>Resume with original list</button></div>}
        </section>;
      })}
    </div>}
    {jobs.length > 0 && <div aria-label="Distributions">
      {jobs.map((job) => {
        const progress = distributionProgress(job, accepted);
        const invalidated = job.recovery?.invalidated === true;
        const superseded = job.recovery?.supersededByJobId !== null && job.recovery?.supersededByJobId !== undefined;
        const total = job.recipients.reduce((sum, recipient) => sum + recipient.amount, 0n);
        const percent = (value: number) => `${job.recipients.length === 0 ? 0 : (value / job.recipients.length) * 100}%`;
        const here = activeJob === job.jobId;
        return <section key={job.jobId} className={styles.job} aria-label={`Distribution to ${job.recipients.length} recipients`}>
          <div className={styles.jobHead}>
            <strong>{job.recipients.length} recipients · <TokenAmount value={total} unit={unit} /></strong>
            <span className={`${styles.chip} ${progress.state === "complete" ? styles.chipDone : progress.state === "needs-review" ? styles.chipBad : styles.chipWarn}`}>
              {progress.state === "complete" ? "Complete" : progress.state === "needs-review" ? "Needs review" : here ? "Running" : "In progress"}</span>
          </div>
          <div className={styles.meter} role="img" aria-label={`${progress.paid} of ${job.recipients.length} recipients paid`}>
            <span className={styles.meterSent} style={{ width: percent(progress.paid + progress.submitted) }} />
            <span className={styles.meterPaid} style={{ width: percent(progress.paid) }} />
          </div>
          <p className={styles.hint}>{progress.paid} paid · {progress.submitted} submitted{progress.failed > 0 ? ` · ${progress.failed} not paid` : ""} · {job.recipients.length - progress.assigned} not started</p>
          {here && running !== undefined && (running.proving && wallet.busy
            ? <WorkingProof message={running.message} />
            : <p className={styles.statusLine} role="status"><span className="spinner" aria-hidden="true" />{running.message}</p>)}
          {outcome?.jobId === job.jobId && <Notice tone={outcome.tone}>{outcome.message}</Notice>}
          {outcome?.jobId === job.jobId && outcome.fast === true && <EthereumSubmissionLock />}
          {invalidated && <Notice tone="warning">The chain history this recovery used has changed. Use the recovered distribution above and paste the complete original list again.</Notice>}
          {superseded && <Notice>The unpaid recipients from this distribution are being paid in another saved distribution.</Notice>}
          {job.chunks.length > 0 && <details>
            <summary>Payments</summary>
            <ol className={styles.chunks}>{job.chunks.map((chunk) => <li key={chunk.contentHash}>
              <span>Recipients {chunk.firstRecipient + 1}–{chunk.firstRecipient + chunk.recipientCount} · <Link to={transactionPath(chunk.contentHash)}><code>{shortValue(chunk.contentHash)}</code></Link></span>
              <span className={`${styles.chip} ${chunkPaid(chunk, accepted) ? styles.chipDone : chunk.outcome === "unresolved" ? styles.chipWarn : styles.chipBad}`}>
                {chunkPaid(chunk, accepted) ? "Paid" : chunk.outcome === "unresolved" ? "Submitted" : chunk.outcome === "expired" ? "Expired, not paid" : "Not paid"}</span>
            </li>)}</ol>
          </details>}
          <div className={styles.actions}>
            {invalidated || superseded ? null : here ? <button type="button" className="button" onClick={() => { if (stopRef.current !== undefined) stopRef.current.stopped = true; }}>Pause</button>
              : progress.state === "in-progress"
                && <button type="button" className="button primary" disabled={wallet.busy || running !== undefined || wallet.phase !== "ready"} onClick={() => continuation(job)}>Continue</button>}
            {!invalidated && !superseded && !here && progress.state === "needs-review" && unpaidRecipients(job).length > 0
              && <button type="button" className="button primary" disabled={working} onClick={() => distributeUnpaid(job)}>Distribute to unpaid recipients</button>}
          </div>
        </section>;
      })}
    </div>}
  </div>;
}

function WorkingProof({ message }: { message: string }) {
  const { progress, actionProgress, awaitingSignature } = useWallet();
  return <ProofProgress proof={progress} awaitingSignature={awaitingSignature} label="Paying the next recipients"
    detail={progress === undefined ? actionProgress?.message ?? message : undefined} />;
}
