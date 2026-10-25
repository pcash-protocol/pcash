import { useState } from "react";
import { defaultOpenFee } from "@pcash/sdk/wallet/actions";
import { formatPcashInput, parsePcashAmount } from "../../components/pcashAmount.ts";
import { SubmissionModeControl } from "../../components/SubmissionModeControl.tsx";
import { prefilledOpenFee } from "../../lib/openFee.ts";
import { usePaymentIssuance } from "../../lib/usePaymentIssuance.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { useWebsiteSettings, type SubmissionMode } from "../../lib/WebsiteSettings.tsx";
import { missingPcashMessage, type TokenPublicationChoice } from "./useTokenTransaction.ts";
import styles from "./Tokens.module.css";

export interface PublicationDraft {
  mode: SubmissionMode;
  openFee: string;
}

/**
 * A form's submission draft: the default mode, and the default open fee until
 * the user edits it. Where a zero fee is allowed, a wallet that cannot pay the
 * default for each of the action's `proofs` starts at 0.
 */
export function usePublicationDraft(zeroFeeAllowed = true, proofs = 1): [PublicationDraft, (draft: PublicationDraft) => void] {
  const { getDefaultSubmissionMode } = useWebsiteSettings();
  const { funds } = useWallet();
  const [mode, setMode] = useState<SubmissionMode>(getDefaultSubmissionMode);
  const [openFee, setOpenFee] = useState<string>();
  const { issuance } = usePaymentIssuance(mode === "slow");
  const limit = funds === undefined ? undefined : funds.spendablePrivate / BigInt(proofs);
  const draft = { mode, openFee: openFee ?? formatPcashInput(prefilledOpenFee(defaultOpenFee(issuance), limit, zeroFeeAllowed)) };
  return [draft, (next) => {
    setMode(next.mode);
    if (next.openFee !== draft.openFee) setOpenFee(next.openFee);
  }];
}

export function publicationChoice(draft: PublicationDraft): TokenPublicationChoice {
  return {
    mode: draft.mode,
    openFeeAmount: draft.mode === "slow" ? parsePcashAmount(draft.openFee, { label: "Relayer fee", allowZero: true }) : 0n,
  };
}

/** The draft's publication choice, or the reason it cannot be used as entered for `proofs` proofs. */
export function checkedPublication(draft: PublicationDraft, spendablePcash: bigint | undefined, zeroFeeAllowed = true, proofs = 1): { choice: TokenPublicationChoice } | { problem: string } {
  let choice: TokenPublicationChoice;
  try {
    choice = publicationChoice(draft);
  } catch (cause) {
    return { problem: cause instanceof Error ? cause.message : String(cause) };
  }
  const missing = missingPcashMessage(choice, spendablePcash, zeroFeeAllowed, proofs);
  return missing === undefined ? { choice } : { problem: missing };
}

/** A token contract's creator steps: Fast pays Ethereum gas; a relayer needs a positive PCASH fee. */
export function contractPublication(draft: PublicationDraft, spendablePcash: bigint | undefined): { mode: SubmissionMode; openFeeAmount?: bigint } | { problem: string } {
  if (draft.mode === "fast") return { mode: "fast" };
  const checked = checkedPublication(draft, spendablePcash, false);
  if ("problem" in checked) return checked;
  if (checked.choice.openFeeAmount === 0n) return { problem: "A relayer needs a PCASH fee to create a contract. Enter a fee or choose Faster." };
  return { mode: "slow", openFeeAmount: checked.choice.openFeeAmount };
}

/** A template action a creator runs on its own contract, such as claiming its unclaimed links: a zero fee needs no PCASH. */
export function templatePublication(draft: PublicationDraft, spendablePcash: bigint | undefined): { mode: SubmissionMode; openFeeAmount?: bigint } | { problem: string } {
  if (draft.mode === "fast") return { mode: "fast" };
  const checked = checkedPublication(draft, spendablePcash);
  return "problem" in checked ? checked : { mode: "slow", openFeeAmount: checked.choice.openFeeAmount };
}

export function TokenPublicationFields({ draft, onChange, disabled = false, proofs, contract = false }: {
  draft: PublicationDraft;
  onChange(draft: PublicationDraft): void;
  disabled?: boolean;
  /** Proofs the action takes, each paying the fee; set for an action of several. */
  proofs?: number;
  /** Creator steps pay their relayer only through the open fee. */
  contract?: "creator" | "claim" | false;
}) {
  const { selfPublication, funds } = useWallet();
  let missing: string | undefined;
  try {
    missing = missingPcashMessage(publicationChoice(draft), funds?.spendablePrivate, contract !== "creator", proofs);
  } catch {
    missing = undefined;
  }
  const each = proofs === undefined ? "" : " for each proof";
  return <div className={styles.form}>
    <SubmissionModeControl label="Submission" value={draft.mode} onChange={(mode) => onChange({ ...draft, mode })} disabled={disabled}
      fastDisabled={selfPublication === undefined} />
    {draft.mode === "fast" && <p className={styles.hint}>Your Ethereum wallet posts it{each}. You pay Ethereum gas and no PCASH.</p>}
    {draft.mode === "slow" && <>
      <label>Relayer fee (PCASH){each}<input value={draft.openFee} disabled={disabled} inputMode="numeric" placeholder="0"
        onChange={(event) => onChange({ ...draft, openFee: event.target.value })} /></label>
      <p className={styles.hint}>{contract === "creator"
        ? "Any relayer can post each step from the public mempool for a PCASH fee. Faster needs no PCASH."
        : "Any relayer can post it from the public mempool. Relayers earn issuance for posting; a fee in PCASH adds to that. A zero fee needs no PCASH."}</p>
    </>}
    {missing !== undefined && <p className={styles.fieldError} role="status">{missing}</p>}
  </div>;
}
