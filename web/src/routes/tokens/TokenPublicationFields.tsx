import { useState } from "react";
import { defaultOpenFee } from "@pcash/sdk/wallet/actions";
import { formatPcashInput, parsePcashAmount } from "../../components/pcashAmount.ts";
import { SubmissionModeControl } from "../../components/SubmissionModeControl.tsx";
import { prefilledOpenFee } from "../../lib/openFee.ts";
import { usePaymentIssuance } from "../../lib/usePaymentIssuance.ts";
import { S_ACTION_UNITS, useNetworkFee } from "../../lib/useNetworkFee.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { useWebsiteSettings, type SubmissionMode } from "../../lib/WebsiteSettings.tsx";
import { missingPcashMessage, pcashFeeFor, type TokenPublicationChoice } from "./useTokenTransaction.ts";
import styles from "./Tokens.module.css";

export interface PublicationDraft {
  mode: SubmissionMode;
  openFee: string;
}

/**
 * A form's submission draft: the default mode, and the default open fee until
 * the user edits it. Where a zero fee is allowed, a wallet that cannot pay the
 * default for each of the action's `proofs` starts at 0. A fee paid out of a
 * native link's `linkValue` is limited by the link instead of the wallet.
 * `preferredMode` replaces the default until the user picks a mode.
 */
export function usePublicationDraft(zeroFeeAllowed = true, proofs = 1, linkValue?: bigint, preferredMode?: SubmissionMode): [PublicationDraft, (draft: PublicationDraft) => void] {
  const { getDefaultSubmissionMode } = useWebsiteSettings();
  const { funds } = useWallet();
  const [defaultMode] = useState<SubmissionMode>(getDefaultSubmissionMode);
  const [chosenMode, setMode] = useState<SubmissionMode>();
  const mode = chosenMode ?? preferredMode ?? defaultMode;
  const [openFee, setOpenFee] = useState<string>();
  const { issuance } = usePaymentIssuance(mode === "slow");
  const limit = linkValue !== undefined ? linkValue - 1n
    : funds === undefined ? undefined : funds.spendablePrivate / BigInt(proofs);
  const draft = { mode, openFee: openFee ?? formatPcashInput(prefilledOpenFee(defaultOpenFee(issuance), limit, zeroFeeAllowed)) };
  return [draft, (next) => {
    if (next.mode !== mode) setMode(next.mode);
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

/** A native link's fee comes out of the link, which must keep a positive amount for the claimant. */
function linkFeeProblem(choice: TokenPublicationChoice, linkValue: bigint): string | undefined {
  return pcashFeeFor(choice) >= linkValue ? "The relayer fee must be less than the link’s amount. Lower it, or choose Faster." : undefined;
}

/** A native link claim's publication choice: its fee is paid from the link, not the wallet. */
export function checkedLinkPublication(draft: PublicationDraft, linkValue: bigint): { choice: TokenPublicationChoice } | { problem: string } {
  const checked = checkedPublication(draft, undefined);
  if ("problem" in checked) return checked;
  const problem = linkFeeProblem(checked.choice, linkValue);
  return problem === undefined ? checked : { problem };
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

export function TokenPublicationFields({ draft, onChange, disabled = false, proofs, contract = false, linkValue }: {
  draft: PublicationDraft;
  onChange(draft: PublicationDraft): void;
  disabled?: boolean;
  /** Proofs the action takes, each paying the fee; set for an action of several. */
  proofs?: number;
  /** Creator steps pay their relayer only through the open fee. */
  contract?: "creator" | "claim" | false;
  /** A native link's value, which pays the relayer fee instead of the wallet. */
  linkValue?: bigint;
}) {
  const { selfPublication, funds } = useWallet();
  // While the network fee is above zero every step burns PCASH: a native link's from the link, otherwise this wallet's.
  const networkFee = useNetworkFee(S_ACTION_UNITS);
  const burnsWalletPcash = linkValue === undefined && networkFee !== undefined && networkFee > 0n;
  let missing: string | undefined;
  try {
    const choice = publicationChoice(draft);
    missing = linkValue !== undefined ? linkFeeProblem(choice, linkValue)
      : missingPcashMessage(choice, funds?.spendablePrivate, contract !== "creator", proofs);
  } catch {
    missing = undefined;
  }
  const each = proofs === undefined ? "" : " for each proof";
  return <div className={styles.form}>
    <SubmissionModeControl label="Submission" value={draft.mode} onChange={(mode) => onChange({ ...draft, mode })} disabled={disabled}
      fastDisabled={selfPublication === undefined} />
    {draft.mode === "fast" && <p className={styles.hint}>Your Ethereum wallet posts it{each}. {burnsWalletPcash
      ? "You pay Ethereum gas, and the network fee in PCASH."
      : "You pay Ethereum gas and no PCASH."}</p>}
    {draft.mode === "slow" && <>
      <label>Relayer fee (PCASH){each}<input value={draft.openFee} disabled={disabled} inputMode="numeric" placeholder="0"
        onChange={(event) => onChange({ ...draft, openFee: event.target.value })} /></label>
      <p className={styles.hint}>{contract === "creator"
        ? `Any relayer can post each step from the public mempool for a PCASH fee. ${burnsWalletPcash ? "The network fee is also paid in PCASH." : "Faster needs no PCASH."}`
        : linkValue !== undefined
          ? "Any relayer can post it from the public mempool. The fee comes out of the link, so you need no PCASH; relayers also earn issuance for posting."
          : `Any relayer can post it from the public mempool. Relayers earn issuance for posting; a fee in PCASH adds to that. ${burnsWalletPcash ? "The network fee is also paid in PCASH." : "A zero fee needs no PCASH."}`}</p>
    </>}
    {missing !== undefined && <p className={styles.fieldError} role="status">{missing}</p>}
  </div>;
}
