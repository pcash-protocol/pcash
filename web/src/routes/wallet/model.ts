import {
  DEFAULT_ACCOUNT_ADMIN_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX,
  DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX,
  DEFAULT_CONTRACT_FEE_RULE_ENTRY_INDEX,
  DEFAULT_USER_RULE_ENTRY_INDEX,
} from "@pcash/sdk/rules";
import type { PublicationMode } from "@pcash/sdk/wallet";
import { parsePcashAmount } from "../../components/pcashAmount.ts";
import { identityNameFromPath } from "../explorer/identityName.ts";
import { isAddressPath } from "../explorer/paths.ts";

/** Fast posts the payment to Ethereum from the connected wallet; slow leaves it in the node mempool for a relayer. */
export type SendSpeed = "fast" | "slow";

export interface SendDraft {
  to: string;
  amount: string;
  fee: string;
  speed: SendSpeed;
  memo: string;
  includeSender: boolean;
}

export interface SendIntent {
  to: string;
  amount: bigint;
  openFeeAmount?: bigint;
  publication?: PublicationMode;
  /** Text for the recipient, carried in its note. */
  memo?: string;
  /** The recipient's note names this wallet as the sender. */
  includeSender?: boolean;
  /** A fresh payment, never a resubmission of a pending one that pays the same recipient and amount. */
  newAction?: true;
  retryContentHash?: string;
}

export interface SendOutcome {
  contentHash: string;
  accepted: boolean;
  queued: boolean;
  settled: boolean;
  recovered: boolean;
}

export type PaymentActivityStatus = "pending" | "confirmed" | "unknown";

export const ZERO_PAYMENT_MESSAGE = "A zero payment can't carry a message.";

export function sendIntent(draft: SendDraft): SendIntent {
  const to = draft.to.trim();
  if (to === "") throw new Error("Enter a recipient");
  // Zero is an ordinary payment: it creates no recipient note, so it carries no memo or sender.
  const amount = parsePcashAmount(draft.amount, { label: "Amount", allowZero: true });
  const memo = draft.memo.trim();
  if (amount === 0n && memo !== "") throw new Error(ZERO_PAYMENT_MESSAGE);
  const records = {
    ...(memo === "" ? {} : { memo }),
    ...(draft.includeSender && amount > 0n ? { includeSender: true } : {}),
  };
  // Self-publication pays Ethereum gas and no relayer fee.
  if (draft.speed === "fast") return { to, amount, ...records, publication: "self", newAction: true };
  return {
    to,
    amount,
    ...records,
    newAction: true,
    ...(draft.fee.trim() === ""
      ? {}
      : { openFeeAmount: parsePcashAmount(draft.fee, { label: "Relayer fee", allowZero: true }) }),
  };
}

export const DEFAULT_AUTHORIZATION_METHODS = Object.freeze([
  {
    entryIndex: DEFAULT_USER_RULE_ENTRY_INDEX,
    title: "Private payments",
    description: "Send private PCASH to one recipient.",
  },
  {
    entryIndex: DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX,
    title: "Asset payments",
    description: "Send one standard asset to one recipient.",
  },
  {
    entryIndex: DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX,
    title: "Asset burns",
    description: "Destroy units of one standard asset you hold.",
  },
  {
    entryIndex: DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX,
    title: "Batch transfers",
    description: "Pay several recipients at once, or transfer and burn together.",
  },
  {
    entryIndex: DEFAULT_ACCOUNT_ADMIN_RULE_ENTRY_INDEX,
    title: "Account changes",
    description: "Update receive keys and authorization settings.",
  },
  {
    entryIndex: DEFAULT_CONTRACT_FEE_RULE_ENTRY_INDEX,
    title: "Contract fee sponsorship",
    description: "Pay the network fee for a named contract's action.",
  },
] as const);

/** What a recipient field that is not a name resolves to. */
export type ResolvedRecipient =
  | { kind: "address"; address: string }
  | { kind: "invalid"; message: string };

/**
 * The recipient a scanned QR code names: an address as is, the account of a
 * profile link (`https://…/0x…` or `https://…/alice.eth`), or the address of an
 * EIP-681 `ethereum:` URI from another wallet.
 */
export function recipientFromScan(text: string): string {
  const trimmed = text.trim();
  const eip681 = /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?=$|[@/?])/.exec(trimmed);
  if (eip681) return eip681[1]!;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const { pathname } = new URL(trimmed);
      if (isAddressPath(pathname)) return pathname.slice(1);
      const name = identityNameFromPath(pathname);
      if (name !== undefined) return name;
    } catch { /* Not a URL after all: use the text. */ }
  }
  return trimmed;
}

export function describeRecipient(to: string): ResolvedRecipient {
  const trimmed = to.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return { kind: "address", address: trimmed.toLowerCase() };
  if (/^0x[0-9a-fA-F]*$/.test(trimmed)) return { kind: "invalid", message: "An Ethereum address is 0x followed by 40 hex characters." };
  return { kind: "invalid", message: "Enter an Ethereum address or ENS name." };
}

export function shortValue(value: string, head = 10, tail = 8): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** Drop the exact-retry selection so a retired payment re-preflights as a fresh payment. */
export function withoutRetrySelection(intent: SendIntent): SendIntent {
  return {
    to: intent.to,
    amount: intent.amount,
    ...(intent.openFeeAmount === undefined ? {} : { openFeeAmount: intent.openFeeAmount }),
    ...(intent.publication === undefined ? {} : { publication: intent.publication }),
    ...(intent.memo === undefined ? {} : { memo: intent.memo }),
    ...(intent.includeSender === undefined ? {} : { includeSender: intent.includeSender }),
    newAction: true,
  };
}

export function outcomeMessage(outcome: SendOutcome): string {
  if (outcome.accepted) return `Transaction ${shortValue(outcome.contentHash)} is confirmed.`;
  if (outcome.queued) return `Transaction ${shortValue(outcome.contentHash)} is pending.`;
  if (outcome.recovered) return `Transaction ${shortValue(outcome.contentHash)} is ready to resume.`;
  return `The status of transaction ${shortValue(outcome.contentHash)} could not be confirmed.`;
}

export function paymentActivityStatus(
  acceptedByChain: boolean,
  presentInMempool: boolean,
): PaymentActivityStatus {
  if (acceptedByChain) return "confirmed";
  if (presentInMempool) return "pending";
  return "unknown";
}
