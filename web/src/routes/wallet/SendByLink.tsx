import { useState } from "react";
import { CopyButton } from "../../components/CopyButton.tsx";
import { Notice } from "../../components/Notice.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { parsePcashAmount } from "../../components/pcashAmount.ts";
import { SubmissionModeControl } from "../../components/SubmissionModeControl.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { tokenFailure, TokenFailureNotice, type TokenFailure } from "../tokens/EthereumSubmission.tsx";
import { TokensActionProgress } from "../tokens/TokenTransactionStatus.tsx";
import { useTokensApp } from "../tokens/useTokensApp.ts";
import { claimPageUrl, notifyLinkSendsChanged } from "./linkSends.tsx";
import type { SendSpeed } from "./model.ts";
import styles from "./OwnerPanels.module.css";

export type LinkSendPhase = "draft" | "sending" | "sent";

function amountOf(value: string, label: string): { amount?: bigint; problem?: string } {
  if (value.trim() === "") return {};
  try { return { amount: parsePcashAmount(value, { label, allowZero: true }) }; } catch (cause) { return { problem: cause instanceof Error ? cause.message : String(cause) }; }
}

/**
 * Send PCASH as a claim link: a one-link set whose contract holds the amount
 * until whoever has the link claims it. The draft's amount, fee and speed are
 * the send box's own.
 */
export function SendByLink({ amount, fee, speed, maxAmount, estimatedIssuance, networkFee, onAmount, onFee, onSpeed, onMax, onPhase, onSendAnother, onDone, onCancel }: {
  amount: string;
  fee: string;
  speed: SendSpeed;
  maxAmount: bigint | undefined;
  estimatedIssuance: bigint | undefined;
  /** The network fee the SDK quotes now for the link's funding, which also creates the link's contract. */
  networkFee: bigint | undefined;
  onAmount(value: string): void;
  onFee(value: string): void;
  onSpeed(speed: SendSpeed): void;
  onMax(): void;
  onPhase(phase: LinkSendPhase): void;
  onSendAnother(): void;
  onDone: (() => void) | undefined;
  onCancel: (() => void) | undefined;
}) {
  const { busy, funds, selfPublication, runAction } = useWallet();
  const tokens = useTokensApp();
  const [phase, setPhase] = useState<LinkSendPhase>("draft");
  const [error, setError] = useState<TokenFailure>();
  const [sent, setSent] = useState<{ url: string; amount: bigint }>();
  const [resuming, setResuming] = useState<{ key: string; amount: bigint; speed: SendSpeed; openFeeAmount: bigint }>();
  const fast = speed === "fast";
  const linkAmount = amountOf(amount, "Amount");
  const feeAmount = fast ? { amount: 0n } : amountOf(fee, "Relayer fee");
  const sameDraft = resuming !== undefined && resuming.amount === linkAmount.amount && resuming.speed === speed && resuming.openFeeAmount === feeAmount.amount;
  const move = (next: LinkSendPhase) => { setPhase(next); onPhase(next); };

  const blocked = amount.trim() === "" ? "Enter an amount to continue."
    : linkAmount.problem ?? feeAmount.problem
    ?? (linkAmount.amount === 0n ? "A link must hold some PCASH."
      : feeAmount.amount === undefined ? "Enter a relayer fee to continue."
      // A relayer posts the link's contract only for a fee.
      : !fast && feeAmount.amount === 0n ? "A relayer needs a PCASH fee to create the link. Enter a fee or choose Faster."
      : !sameDraft && funds !== undefined && linkAmount.amount! + feeAmount.amount + (networkFee ?? 0n) > funds.spendablePrivate ? "The link and its fees are more than you have available."
      : busy ? "Your wallet is busy." : undefined);

  const send = () => {
    if (blocked !== undefined) return;
    const value = linkAmount.amount!;
    const openFeeAmount = feeAmount.amount!;
    // Freeze the submitted amount and fee so Max and the default fee stop moving with wallet reads.
    onAmount(amount);
    if (!fast) onFee(fee);
    move("sending");
    setError(undefined);
    tokens.clearProgress();
    // Set once the link exists; a failure after that, such as the wallet's refresh, does not reopen the draft.
    let created: { url: string; amount: bigint } | undefined;
    const finish = () => {
      setResuming(undefined);
      setSent(created);
      move("sent");
    };
    void runAction(async () => {
      const app = await tokens.app(speed);
      const existing = sameDraft ? resuming.key : undefined;
      let key = existing;
      try {
        const view = existing !== undefined && app.resumeLinkSet !== undefined
          ? await app.resumeLinkSet(existing, tokens.onProgress)
          : await app.createLinkSet({
            assetId: 0n,
            amounts: [value],
            onProgress: tokens.onProgress,
            onCreated: (stored) => {
              key = stored;
              setResuming({ key: stored, amount: value, speed, openFeeAmount });
            },
            ...(fast ? {} : { openFeeAmount }),
          });
        key = view.key;
        const [link] = await app.linkSetUrls(view.key, claimPageUrl());
        if (link !== undefined) created = { url: link, amount: view.links?.[0]?.amount ?? value };
      } catch (cause) {
        if (key !== undefined) setResuming({ key, amount: value, speed, openFeeAmount });
        throw cause;
      } finally {
        notifyLinkSendsChanged();
      }
    }).then(finish, (cause: unknown) => {
      if (created !== undefined) { finish(); return; }
      setError(tokenFailure(cause, fast));
      move("draft");
    });
  };

  if (phase === "sent" && sent !== undefined) {
    return <div className={styles.sendForm}>
      <div className={styles.directSend} data-testid="link-send">
        <p role="status">Your link holds <PcashAmount value={sent.amount} />. Whoever opens it can claim it, even without PCASH.</p>
        <Notice tone="warning">Anyone with this link can take the PCASH. Send it privately, only to the person it is for. Until it is claimed, you can take it back from Activity.</Notice>
        <input readOnly value={sent.url} aria-label="Claim link" onFocus={(event) => event.currentTarget.select()} />
        <CopyButton label="Copy link" showLabel value={sent.url} />
      </div>
      <div className="actions">
        <button type="button" className="button" onClick={() => { setSent(undefined); move("draft"); onSendAnother(); }}>Send another</button>
        {onDone !== undefined && <button type="button" className="button primary" onClick={onDone}>Done</button>}
      </div>
    </div>;
  }

  const sending = phase === "sending";
  return <form className={styles.sendForm} onSubmit={(event) => { event.preventDefault(); send(); }}>
    <fieldset className={styles.sendFields} disabled={sending}>
      <p className={styles.formHint}>Makes a link that holds the PCASH. Whoever opens it can claim it into their wallet, so you don't need their address.</p>
      <div className={styles.amountField}>
        <div className={styles.amountBox}>
          <label>Amount<input className={styles.amountInput} value={amount} onChange={(event) => onAmount(event.target.value)} inputMode="numeric" placeholder="0" required /></label>
          <span className={styles.unit} aria-hidden="true">PCASH</span>
        </div>
        {funds !== undefined && <p className={styles.available}><span>Available <PcashAmount value={funds.spendablePrivate} rounding="down" /></span>
          <button type="button" disabled={maxAmount === undefined || maxAmount === 0n} onClick={onMax}>Max</button></p>}
      </div>
      <SubmissionModeControl label="Speed" value={speed} onChange={onSpeed} fastDisabled={selfPublication === undefined} />
      {!fast && <div className={styles.feeField}>
        <label>Relayer fee (PCASH)<input className={styles.feeInput} value={fee} onChange={(event) => onFee(event.target.value)} inputMode="numeric" placeholder="0" /></label>
        {estimatedIssuance !== undefined && <p>{estimatedIssuance > 0n ? <>Relayers already earn about <PcashAmount value={estimatedIssuance} /> per transaction</> : "Relayers earn no issuance right now, so this fee is all they get"}</p>}
      </div>}
    </fieldset>
    {linkAmount.amount !== undefined && feeAmount.amount !== undefined && <p className={styles.summary} data-testid="link-split">
      The link holds <PcashAmount value={linkAmount.amount} />{fast ? " · your Ethereum wallet pays the gas" : <> · relayer gets <PcashAmount value={feeAmount.amount} rounding="up" /></>}
      {networkFee !== undefined && networkFee > 0n && <>{" · "}network fee <PcashAmount value={networkFee} rounding="up" /></>}
    </p>}
    {error !== undefined && <TokenFailureNotice failure={error} onCleared={() => setError(undefined)} />}
    {sending ? <TokensActionProgress progress={tokens.progress} />
      : <>
        <div className={styles.sendActions}>
          {onCancel !== undefined && <button className="button" type="button" onClick={onCancel}>Cancel</button>}
          <button className="button primary" type="submit" disabled={blocked !== undefined} aria-describedby={blocked === undefined ? undefined : "link-send-blocked"}>Create link</button>
        </div>
        {blocked !== undefined && <p id="link-send-blocked" className={styles.formHint}>{blocked}</p>}
      </>}
  </form>;
}
