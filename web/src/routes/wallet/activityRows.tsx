import type { ReactNode } from "react";
import type { ReceiptResult, TransactionSummaryResult } from "@pcash/sdk/clients";
import type { WalletNativeActivityEntry, WalletReceivedMessage } from "@pcash/sdk/wallet";
import { addressHex } from "@pcash/sdk/utils";
import { marketplaceBuyerKey, publicationIdentity, type OfferPublication, type StoredOffer } from "@pcash/marketplace/app";
import { EthereumAddress } from "../../components/EthereumAddress.tsx";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { memoText } from "../../lib/memoText.ts";
import type { PendingTransactionState } from "../../lib/pendingTransactionState.ts";
import type { TokenActivity } from "../../lib/tokenActivity.ts";
import type { WalletPaymentActivity } from "../../lib/WalletProvider.tsx";
import { describeFailure } from "../explorer/format.ts";
import { blockPath, transactionPath } from "../explorer/paths.ts";
import { ListingAmount } from "../marketplace/ListingAsset.tsx";
import { offerPath } from "../marketplace/presentation.ts";
import type { ListingSale } from "../marketplace/sales.ts";
import { shortValue } from "./model.ts";

export type ActivityKind =
  | "sent" | "received" | "mined" | "setup"
  | "listed" | "escrow" | "bought" | "sold" | "reclaimed"
  | "token-created" | "token-sent" | "token-burned" | "token-claimed";

/**
 * Completed rows carry no badge. A pending row with a transaction reads that
 * transaction's place on its way to Ethereum; `detail` says where it stands
 * otherwise. `submissionUnknown` marks a marketplace step that may never have
 * left this browser: it shows only once the PCASH mempool or an Ethereum
 * transaction holds it. `whenAbsent` is what the row shows once neither holds
 * the transaction: expired for a token action the wallet no longer tracks, not
 * posted for a prepared marketplace claim.
 */
export type ActivityState =
  | { state: "complete" }
  | { state: "pending"; contentHash?: string; posted?: boolean; detail?: string; submissionUnknown?: boolean; whenAbsent?: ActivityState }
  | { state: "failed"; reason?: string }
  | { state: "expired" };

/** What a row shows once its pending transaction's place on the way to Ethereum is known. */
export function shownState(state: ActivityState, observed: PendingTransactionState | undefined): ActivityState {
  if (state.state !== "pending" || state.contentHash === undefined || observed === undefined) return state;
  if (observed === "confirmed") return { state: "complete" };
  if (observed === "absent" && state.whenAbsent !== undefined) return state.whenAbsent;
  return observed === "mempool" || observed === "ethereum" ? { ...state, posted: observed === "ethereum" } : state;
}

export interface ActivityRow {
  id: string;
  kind: ActivityKind;
  title: ReactNode;
  /** A second line: the memos a payment carried and any sender a received note claims. */
  note?: ReactNode;
  /** Milliseconds; absent when nothing records when it happened. */
  at?: number;
  /** Position among rows, newest first. */
  order: number;
  state: ActivityState;
  href: string;
  payment?: WalletPaymentActivity;
}

export interface ActivitySources {
  owner: bigint;
  payments: readonly WalletPaymentActivity[];
  /** Recovered canonical history; undefined until it is ready. */
  canonical: readonly WalletNativeActivityEntry[] | undefined;
  /** Canonical history is current with the wallet, so a mining row without a payout received nothing. */
  historyCurrent: boolean;
  accountEvents: readonly TransactionSummaryResult[];
  offers: readonly StoredOffer[];
  /** This owner's sold listings by publication identity, with the claim that took each. */
  sold: ReadonlyMap<string, ListingSale>;
  /** This owner's paid purchases whose escrow its own claim spent, by publication identity, with that claim's content hash. */
  purchased: ReadonlyMap<string, string>;
  tokens: readonly TokenActivity[];
  /** The selected receipt for each content hash the feed asked about; null when there is none yet. */
  receipts: ReadonlyMap<string, ReceiptResult | null>;
  /** Content hashes the wallet still tracks as pending. */
  pendingContentHashes: ReadonlySet<string>;
}

/** Content hashes whose receipts the feed needs: web-recorded actions and failed payments. */
export function activityReceiptHashes(sources: Pick<ActivitySources, "owner" | "payments" | "offers" | "tokens">): string[] {
  const buyer = marketplaceBuyerKey(sources.owner);
  const hashes = [
    ...sources.payments.filter((payment) => payment.status === "failed").map((payment) => payment.contentHash),
    ...sources.tokens.map((activity) => activity.contentHash),
    ...sources.offers.flatMap((offer) => {
      const buy = offer.buys?.[buyer];
      return [
        ...ownListing(offer, sources.owner) ? [offer.publish?.l2ContractContentHash, offer.publish?.fundingContentHash, offer.reclaim?.contentHash] : [],
        buy?.txHash === undefined ? undefined : buy.claimContentHash,
      ];
    }),
  ];
  return [...new Set(hashes.flatMap((hash) => hash === undefined ? [] : [hash.toLowerCase()]))];
}

function ownListing(offer: StoredOffer, owner: bigint): boolean {
  return BigInt(offer.pub.reclaimAuthority) === owner;
}

const CLAIM_NOT_POSTED: ActivityState = { state: "pending", detail: "Claim not posted" };
const CLAIM_NEEDED: ActivityState = { state: "pending", detail: "Needs claim" };

function failure(receipt: ReceiptResult | null | undefined): ActivityState {
  return receipt === null || receipt === undefined || receipt.outcome === "succeeded" ? { state: "failed" } : { state: "failed", reason: describeFailure(receipt.outcome) };
}

function paymentState(payment: WalletPaymentActivity, receipt: ReceiptResult | null | undefined): ActivityState {
  switch (payment.status) {
    case "pending":
    case "unknown": return { state: "pending", contentHash: payment.contentHash };
    case "confirmed":
    case "finalized": return { state: "complete" };
    case "failed": return failure(receipt);
    case "expired": return { state: "expired" };
    case "conflicted": return { state: "failed", reason: "Another transaction spent the same funds first." };
  }
}

/** Memos as quoted plain text, one line each; undefined when none has text. */
function memoNote(memos: readonly (Uint8Array | string | undefined)[]): ReactNode | undefined {
  const lines = memos.flatMap((memo) => {
    const text = memo === undefined ? "" : memoText(memo);
    return text === "" ? [] : [`“${text}”`];
  });
  return lines.length === 0 ? undefined : <>{lines.map((line, index) => <span key={index}>{line}</span>)}</>;
}

/**
 * What senders wrote into received notes. Any sender can name any address, so
 * a claimed sender shows as a raw address, never as a resolved name.
 */
function receivedNote(messages: readonly WalletReceivedMessage[]): ReactNode | undefined {
  const lines = messages.flatMap((message, index) => {
    const text = memoText(message.memo);
    const sender = message.sender === null ? undefined : addressHex(message.sender);
    if (text === "" && sender === undefined) return [];
    const quoted = text === "" ? undefined : `“${text}”`;
    return [<span key={index}>
      {quoted}{quoted !== undefined && sender !== undefined && " "}
      {sender !== undefined && <>{quoted === undefined ? "From" : "from"} <code title={sender}>{shortValue(sender, 8, 6)}</code> (unverified)</>}
    </span>];
  });
  return lines.length === 0 ? undefined : <>{lines}</>;
}

function listingTerms(publication: OfferPublication): ReactNode {
  return <><ListingAmount publication={publication} /> for <EtherAmount value={BigInt(publication.terms.ethPriceWei)} /></>;
}

/** What a payment sent, and to whom. */
export function sentTitle(amount: bigint, recipient: string): ReactNode {
  return <>Sent <PcashAmount value={amount} /> to <EthereumAddress address={recipient} short head={8} tail={6} /></>;
}

/** Every source merged into one list of rows, pending first, then newest first. */
export function activityRows(sources: ActivitySources, nowSeconds = BigInt(Math.floor(Date.now() / 1_000))): ActivityRow[] {
  const receipt = (hash: string | undefined) => hash === undefined ? undefined : sources.receipts.get(hash.toLowerCase());
  const canonicalKey = (entry: WalletNativeActivityEntry) => entry.transactionId?.toLowerCase() ?? `poster:${entry.blockHash}`;
  const canonical = new Map((sources.canonical ?? []).map((entry) => [canonicalKey(entry), entry]));
  // A local payment's contentHash names its spend bytes before a receipt names the transaction id.
  const byContentHash = new Map((sources.canonical ?? []).flatMap((entry) => entry.contentHash == null ? [] : [[entry.contentHash.toLowerCase(), canonicalKey(entry)] as const]));
  const claimed = new Set<string>();
  /** The canonical entry a local row stands for, which then appears only once. */
  const position = (transactionReference: string | undefined) => {
    if (transactionReference === undefined) return undefined;
    const key = canonical.has(transactionReference.toLowerCase()) ? transactionReference.toLowerCase() : byContentHash.get(transactionReference.toLowerCase()) ?? transactionReference.toLowerCase();
    claimed.add(key);
    return canonical.get(key);
  };
  const rejected = (hash: string | undefined) => {
    const found = receipt(hash);
    return found !== undefined && found !== null && found.outcome !== "succeeded";
  };
  const acceptedTxId = (hash: string | undefined) => {
    const found = receipt(hash);
    return found?.outcome === "succeeded" ? found.transactionId : undefined;
  };
  const canonicalTime = (hash: string | undefined) => {
    const entry = position(acceptedTxId(hash));
    return entry === undefined ? undefined : Number(entry.timestamp) * 1_000;
  };
  const buyer = marketplaceBuyerKey(sources.owner);
  const rows: ActivityRow[] = [];
  // A listing's escrow funding is a payment to its contract; its escrow row shows it.
  const escrowFunding = new Set(sources.offers.flatMap((offer) => {
    const contentHash = ownListing(offer, sources.owner) ? offer.publish?.fundingContentHash : undefined;
    return contentHash === undefined ? [] : [contentHash.toLowerCase()];
  }));

  for (const payment of sources.payments) {
    const transactionReference = payment.receiptTxId ?? payment.contentHash;
    const entry = position(transactionReference) ?? position(payment.contentHash);
    if (escrowFunding.has(payment.contentHash.toLowerCase())) continue;
    const at = entry !== undefined ? Number(entry.timestamp) * 1_000
      : payment.resolvedAtUnixMs === undefined ? undefined : Number(payment.resolvedAtUnixMs);
    const state = paymentState(payment, receipt(payment.contentHash));
    const mined = entry?.payout?.issuanceAmount ?? (sources.historyCurrent ? 0n : undefined);
    const note = memoNote([payment.memo]);
    rows.push({
      id: payment.contentHash, kind: payment.kind === "mine" ? "mined" : "sent", payment, ...(at === undefined ? {} : { at }), order: at ?? 0,
      title: payment.kind === "mine"
        ? state.state !== "complete" ? "Mining" : <>Mined {mined === undefined ? "PCASH" : <PcashAmount value={mined} />}</>
        : sentTitle(payment.amount, payment.recipientAddress),
      ...(note === undefined ? {} : { note }),
      state,
      href: transactionPath(transactionReference),
    });
  }

  for (const event of sources.accountEvents) {
    if (event.kind !== "userAccountCreation" && event.kind !== "userAccountUpdate") continue;
    claimed.add(event.transactionId.toLowerCase());
    const at = Number(event.timestamp) * 1_000;
    rows.push({
      id: `account:${event.transactionId}`, kind: "setup", at, order: at,
      title: event.kind === "userAccountCreation" ? "Set up account" : "Updated account",
      state: event.outcome === "succeeded" ? { state: "complete" } : { state: "failed", reason: describeFailure(event.outcome) },
      href: transactionPath(event.transactionId),
    });
  }

  for (const offer of sources.offers) {
    const own = ownListing(offer, sources.owner);
    const href = (publication: OfferPublication) => offerPath(publication);
    const publish = own ? offer.publish : undefined;
    if (publish?.l2ContractContentHash !== undefined) {
      const created = publish.l2ContractAcceptedBlock !== undefined || acceptedTxId(publish.l2ContractContentHash) !== undefined
        || ["funding-submitted", "finalizing", "funded"].includes(publish.phase);
      const at = canonicalTime(publish.l2ContractContentHash) ?? offer.savedAt;
      rows.push({
        id: `${offer.key}:listed`, kind: "listed", at, order: at, title: <>Listed {listingTerms(offer.pub)}</>,
        // A created listing whose funding never started is unfinished: its page continues it.
        state: created && publish.fundingContentHash === undefined && publish.phase !== "funded" ? { state: "pending", detail: "Not funded yet" }
          : created ? publish.catalogError === undefined ? { state: "complete" } : { state: "failed" }
          : publish.phase === "failed" || rejected(publish.l2ContractContentHash) ? failure(receipt(publish.l2ContractContentHash))
            : { state: "pending", contentHash: publish.l2ContractContentHash, submissionUnknown: true },
        href: href(offer.pub),
      });
    }
    if (publish?.fundingContentHash !== undefined) {
      const at = canonicalTime(publish.fundingContentHash) ?? publish.fundingFinalizedAt ?? publish.updatedAt;
      const funded = publish.fundingAcceptedBlock !== undefined || publish.phase === "funded" || acceptedTxId(publish.fundingContentHash) !== undefined;
      // Funding completes once the funded listing is published for buyers; a failed publication is the listing row's.
      const published = publish.catalogPublicationId === publicationIdentity(offer.pub) || publish.catalogError !== undefined;
      rows.push({
        id: `${offer.key}:escrow`, kind: "escrow", at, order: at, title: "Funded escrow",
        state: funded ? published ? { state: "complete" } : { state: "pending", detail: "Not published yet" }
          : publish.phase === "failed" || rejected(publish.fundingContentHash) ? failure(receipt(publish.fundingContentHash))
            : { state: "pending", contentHash: publish.fundingContentHash, submissionUnknown: true },
        href: href(offer.pub),
      });
    }
    const reclaim = own ? offer.reclaim : undefined;
    if (reclaim?.contentHash !== undefined) {
      const at = canonicalTime(reclaim.contentHash) ?? reclaim.finalizedAt ?? reclaim.updatedAt;
      rows.push({
        id: `${offer.key}:reclaimed`, kind: "reclaimed", at, order: at, title: "Reclaimed listing",
        state: reclaim.phase === "accepted" || reclaim.phase === "finalized" ? { state: "complete" }
          : reclaim.phase === "failed" ? failure(receipt(reclaim.contentHash))
            : { state: "pending", contentHash: reclaim.contentHash, submissionUnknown: true },
        href: href(reclaim.publication),
      });
    }
    const sale = own ? sources.sold.get(publicationIdentity(offer.pub)) : undefined;
    if (sale !== undefined) {
      rows.push({
        id: `${offer.key}:sold`, kind: "sold", ...(sale.at === undefined ? {} : { at: sale.at }),
        order: sale.at ?? publish?.fundingFinalizedAt ?? publish?.updatedAt ?? offer.savedAt,
        title: <>Sold {listingTerms(offer.pub)}</>, state: { state: "complete" },
        href: sale.transactionId === undefined ? href(offer.pub) : transactionPath(sale.transactionId),
      });
    }
    const buy = offer.buys?.[buyer];
    if (buy?.txHash !== undefined) {
      const at = canonicalTime(buy.claimContentHash) ?? buy.claimedAt ?? buy.paidAt ?? buy.paymentBroadcastRequestedAt ?? offer.savedAt;
      rows.push({
        id: `${offer.key}:bought`, kind: "bought", at, order: at, title: <>Bought {listingTerms(buy.publication)}</>,
        // The `buy` that pays carries the claim. The purchase is complete once this
        // buyer's claim spent the escrow, as reconciliation records it or as read here,
        // whichever of its claims landed. A claim that did not succeed is finished from
        // the listing with Continue until T, after which it has failed.
        state: buy.claimedAt !== undefined || buy.claimAcceptedBlock !== undefined || sources.purchased.has(publicationIdentity(buy.publication)) ? { state: "complete" }
          : rejected(buy.claimContentHash) ? nowSeconds < BigInt(buy.publication.terms.deadlineT) ? CLAIM_NEEDED : failure(receipt(buy.claimContentHash))
            : buy.claimContentHash !== undefined ? { state: "pending", contentHash: buy.claimContentHash, detail: "Paid, claiming", whenAbsent: CLAIM_NOT_POSTED }
              : buy.blockNumber !== undefined ? CLAIM_NOT_POSTED : { state: "pending", posted: true },
        href: href(buy.publication),
      });
    }
  }

  for (const activity of sources.tokens) {
    const found = receipt(activity.contentHash);
    const at = canonicalTime(activity.contentHash) ?? activity.at;
    const amount = <TokenAmount value={activity.amount} unit={activity.unit} />;
    rows.push({
      id: `token:${activity.contentHash}`, kind: activity.kind, at, order: at,
      title: activity.kind === "token-created" ? <>Created {amount}</>
        : activity.kind === "token-sent" ? <>Sent {amount}{activity.to === undefined ? null : <> to <EthereumAddress address={activity.to} short head={8} tail={6} /></>}</>
          : activity.kind === "token-burned" ? <>Burned {amount}</>
            : <>Claimed {amount}</>,
      state: found?.outcome === "succeeded" ? { state: "complete" }
        : found !== undefined && found !== null ? failure(found)
          : { state: "pending", contentHash: activity.contentHash, ...(sources.pendingContentHashes.has(activity.contentHash.toLowerCase()) ? {} : { whenAbsent: { state: "expired" } }) },
      href: transactionPath(found?.transactionId ?? activity.contentHash),
    });
  }

  for (const [key, entry] of canonical) {
    if (claimed.has(key)) continue;
    const at = Number(entry.timestamp) * 1_000;
    // A payment no local row shows, as after a restore: its sender region names what it paid, even when
    // issuance it earned offsets or outweighs the spend, the way a local payment row shows it.
    const sent = entry.sent ?? [];
    const kind: ActivityKind = sent.length > 0 || entry.direction === "spent" ? "sent"
      : entry.payout !== null && entry.payout.issuanceAmount > 0n ? "mined" : "received";
    const note = sent.length > 0 ? memoNote(sent.map((output) => output.memo)) : receivedNote(entry.messages ?? []);
    rows.push({
      id: key, kind, at, order: at,
      title: sent.length === 1
        ? sentTitle(sent[0]!.amount, addressHex(sent[0]!.recipientAddress))
        : sent.length > 1 ? <>Sent <PcashAmount value={sent.reduce((total, output) => total + output.amount, 0n)} /></>
        : <>{kind === "sent" ? "Sent" : kind === "mined" ? "Mined" : "Received"} <PcashAmount value={entry.amount} /></>,
      ...(note === undefined ? {} : { note }),
      state: { state: "complete" },
      href: entry.transactionId === null ? blockPath(entry.blockNumber) : transactionPath(entry.transactionId),
    });
  }

  return rows.sort((a, b) => {
    const pending = Number(b.state.state === "pending") - Number(a.state.state === "pending");
    if (pending !== 0) return pending;
    // An account write precedes the wallet's other transactions in its block: setup mining is posted after the creation in one batch.
    return b.order - a.order || Number(a.kind === "setup") - Number(b.kind === "setup");
  });
}
