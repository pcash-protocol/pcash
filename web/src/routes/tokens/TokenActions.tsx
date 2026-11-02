import { useState, type FormEvent, type ReactNode } from "react";
import { FittedCode } from "../../components/EthereumAddress.tsx";
import { friendlyError } from "../../components/friendlyError.ts";
import { Notice } from "../../components/Notice.tsx";
import { formatTokenAmount, parseTokenAmount, type AmountUnit } from "../../components/tokenAmount.ts";
import { withLeadingZero } from "../../components/pcashAmount.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { NAMES_OFF_MESSAGE } from "../../names/NameResolutionSession.ts";
import { NO_RECEIVE_KEY_MESSAGE, useRecipientInput, useRecipientReceiveKey } from "../wallet/useRecipient.ts";
import { checkedPublication, TokenPublicationFields, usePublicationDraft } from "./TokenPublicationFields.tsx";
import { TokenFailureNotice } from "./EthereumSubmission.tsx";
import { SentTransaction, TokenProofProgress, UnknownTransaction } from "./TokenTransactionStatus.tsx";
import { useTokenTransaction, type TokenPublication, type TokenPublicationChoice } from "./useTokenTransaction.ts";
import { useSubmitLock } from "./useSubmitLock.ts";
import styles from "./Tokens.module.css";

interface TokenActionProps {
  assetId: bigint;
  unit: AmountUnit;
  spendable: bigint;
}

/** A resubmission names only the route; the journaled transaction already fixed its fees. */
function exactRoute({ openFeeAmount: _open, ...route }: TokenPublication) {
  return route;
}

/** A submitted token action under its button: progress, the result, and what to do when it did not land. */
function ActionOutcome({ tx, noun, onRetry, onRestart, sentActions }: {
  tx: ReturnType<typeof useTokenTransaction>;
  noun: string;
  onRetry(): void;
  onRestart(): void;
  sentActions: ReactNode;
}) {
  const { stage } = tx;
  if (stage.state === "working" || stage.state === "submitting") return <TokenProofProgress stage={stage} label={`Preparing your ${noun}`} />;
  if (stage.state === "sent") {
    return <SentTransaction key={stage.contentHash} contentHash={stage.contentHash} mode={stage.mode} l1Hash={stage.l1Hash} noun={noun}
      onExpired={<div className={styles.actions}><button type="button" className="button primary" onClick={onRestart}>Try again</button></div>}>
      <div className={styles.actions}>{sentActions}</div>
    </SentTransaction>;
  }
  if (stage.state === "unknown") {
    return <UnknownTransaction key={stage.contentHash} contentHash={stage.contentHash} noun={noun} fast={stage.mode === "fast"} fate={tx.fate}
      onConfirmed={() => tx.setStage({ state: "sent", contentHash: stage.contentHash, mode: stage.mode, accepted: true })}
      onRetry={onRetry} onCleared={<button type="button" className="button primary" onClick={onRestart}>Try again</button>} />;
  }
  if (stage.state === "failed") {
    return <div className={styles.status}><TokenFailureNotice failure={stage} /></div>;
  }
  return null;
}

interface SubmittedSend {
  to: string;
  amount: bigint;
  choice: TokenPublicationChoice;
}

export function TokenSend({ assetId, unit, spendable }: TokenActionProps) {
  const wallet = useWallet();
  const tx = useTokenTransaction();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [draft, setDraft] = usePublicationDraft();
  const [submitted, setSubmitted] = useState<SubmittedSend>();
  const [error, setError] = useState<string>();
  const lookup = useSubmitLock();
  const { name, nameResolver, recipient, resolvingName } = useRecipientInput(to);
  const missingReceiveKey = useRecipientReceiveKey(recipient?.kind === "address" ? recipient.address : undefined) === "missing";

  const send = (next: SubmittedSend, retryContentHash?: string) => {
    const opened = wallet.wallet;
    if (opened === undefined) return;
    void tx.run(next.choice, (publication) => opened.sendAsset({
      assetId, outputs: [{ to: next.to, amount: next.amount }],
      ...(retryContentHash === undefined ? publication : { ...exactRoute(publication), retryContentHash }),
    }), { kind: "token-sent", amount: next.amount, unit, to: next.to });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    tx.reset();
    setSubmitted(undefined);
    // The recipient lookups run before anything is proved; the form stays locked through them.
    lookup.hold(() => (async () => {
      if (name !== undefined && nameResolver === undefined) throw new Error(NAMES_OFF_MESSAGE);
      if (name === undefined && recipient?.kind === "invalid") throw new Error(recipient.message);
      const value = parseTokenAmount(amount, unit.decimals, { label: "Amount" });
      if (value > spendable) throw new Error(`You have ${formatTokenAmount(spendable, unit, { rounding: "down" })} available to send.`);
      const publication = checkedPublication(draft, wallet.funds?.spendablePrivate);
      if ("problem" in publication) throw new Error(publication.problem);
      // A display-cache entry must never choose the destination of a new transfer.
      const fresh = name === undefined ? undefined : await nameResolver!.resolveName(name);
      if (fresh === null) throw new Error("This name does not resolve to an Ethereum address.");
      const next: SubmittedSend = { to: fresh?.address ?? to.trim(), amount: value, choice: publication.choice };
      if (await wallet.wallet?.hasReceiveKey(next.to) === false) throw new Error(NO_RECEIVE_KEY_MESSAGE);
      setSubmitted(next);
      send(next);
    })().catch((cause) => setError(friendlyError(cause))));
  };
  const another = () => { tx.reset(); setAmount(""); };
  // The fields keep their values: locked from submission until the user moves on, unlocked by a failure.
  const locked = lookup.locked || (tx.stage.state !== "idle" && tx.stage.state !== "failed");
  // A name resolves to an address the field does not show; once submitted, the freshly resolved one is paid.
  const payee = locked && submitted !== undefined ? submitted.to : recipient?.kind === "address" ? recipient.address : undefined;

  return <form className={styles.form} onSubmit={submit} aria-label="Send token">
    <fieldset className={styles.fields} disabled={locked}>
      <label>Recipient<input value={to} onChange={(event) => { setTo(event.target.value); setError(undefined); }} placeholder="Address or ENS, .gwei or .wei name" autoComplete="off" required /></label>
      {resolvingName && <p className={styles.hint} role="status">Resolving recipient…</p>}
      {recipient?.kind === "invalid" && <p className={styles.fieldError}>{recipient.message}</p>}
      {missingReceiveKey && <p className={styles.fieldError}>{NO_RECEIVE_KEY_MESSAGE}</p>}
      {payee !== undefined && payee.toLowerCase() !== to.trim().toLowerCase() && !resolvingName && <p className={styles.fieldOk}>Pays <FittedCode text={payee} /></p>}
      <label>Amount ({unit.symbol})<input value={amount} onChange={(event) => { setAmount(withLeadingZero(event.target.value)); setError(undefined); }} inputMode="decimal" placeholder="0" autoComplete="off" required /></label>
      <TokenPublicationFields draft={draft} onChange={setDraft} />
    </fieldset>
    <div className={styles.actions}><button className="button primary" type="submit" disabled={locked || wallet.busy || resolvingName || missingReceiveKey || to.trim() === "" || amount.trim() === ""}>{lookup.locked ? "Checking…" : tx.stage.state === "failed" ? "Try again" : "Send"}</button></div>
    {error !== undefined && <Notice tone="error">{error}</Notice>}
    {submitted !== undefined && <ActionOutcome tx={tx} noun="transfer" onRetry={() => { if (tx.stage.state === "unknown") send(submitted, tx.stage.contentHash); }}
      onRestart={() => send(submitted)}
      sentActions={<button type="button" className="button" disabled={wallet.busy} onClick={another}>Send another</button>} />}
  </form>;
}

export function TokenBurn({ assetId, unit, spendable }: TokenActionProps) {
  const wallet = useWallet();
  const tx = useTokenTransaction();
  const [amount, setAmount] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [draft, setDraft] = usePublicationDraft();
  const [submitted, setSubmitted] = useState<{ amount: bigint; choice: TokenPublicationChoice }>();
  const [error, setError] = useState<string>();

  const burn = (next: { amount: bigint; choice: TokenPublicationChoice }, retryContentHash?: string) => {
    const opened = wallet.wallet;
    if (opened === undefined) return;
    void tx.run(next.choice, (publication) => opened.burnAsset({
      assetId, amount: next.amount,
      ...(retryContentHash === undefined ? publication : { ...exactRoute(publication), retryContentHash }),
    }), { kind: "token-burned", amount: next.amount, unit });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    tx.reset();
    try {
      const value = parseTokenAmount(amount, unit.decimals, { label: "Amount" });
      if (value > spendable) throw new Error(`You have ${formatTokenAmount(spendable, unit, { rounding: "down" })} available to burn.`);
      const publication = checkedPublication(draft, wallet.funds?.spendablePrivate);
      if ("problem" in publication) throw new Error(publication.problem);
      const next = { amount: value, choice: publication.choice };
      setSubmitted(next);
      burn(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const done = () => { tx.reset(); setAmount(""); setUnderstood(false); };
  const locked = tx.stage.state !== "idle" && tx.stage.state !== "failed";

  return <form className={styles.form} onSubmit={submit} aria-label="Burn token">
    <fieldset className={styles.fields} disabled={locked}>
      <p className={styles.hint}>Burning destroys tokens from your balance. Burns are private: no one can see how much of a token has been burned.</p>
      <label>Amount to burn ({unit.symbol})<input value={amount} onChange={(event) => { setAmount(withLeadingZero(event.target.value)); setError(undefined); }} inputMode="decimal" placeholder="0" autoComplete="off" required /></label>
      <TokenPublicationFields draft={draft} onChange={setDraft} />
      <label className={styles.check}><input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
        <span>I understand burned tokens are destroyed permanently. They cannot be recovered, and no one can create them again.</span></label>
    </fieldset>
    <div className={styles.actions}><button className={`button ${styles.danger}`} type="submit" disabled={locked || wallet.busy || !understood || amount.trim() === ""}>{tx.stage.state === "failed" ? "Try again" : "Burn permanently"}</button></div>
    {error !== undefined && <Notice tone="error">{error}</Notice>}
    {submitted !== undefined && <ActionOutcome tx={tx} noun="burn" onRetry={() => { if (tx.stage.state === "unknown") burn(submitted, tx.stage.contentHash); }}
      onRestart={() => burn(submitted)}
      sentActions={<button type="button" className="button" disabled={wallet.busy} onClick={done}>Done</button>} />}
  </form>;
}
