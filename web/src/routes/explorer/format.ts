import { normalizeIdentityName } from "./identityName.ts";
import type {
  FailureDetail,
  ReceiptResult,
  TransactionOutcome,
} from "@pcash/sdk/clients";
import type { ContractFundingMode } from "@pcash/sdk/protocol";

/** Truncated hex for a table cell. Full values live on detail pages. */
export function shortHex(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatCount(value: bigint | number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTime(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

/** Compact age, the way every explorer writes it: `2s`, `14m`, `3h`, `9d`. */
export function relativeTime(seconds: bigint, now = Date.now()): string {
  return compactDuration(Math.floor(now / 1000 - Number(seconds)));
}

/** The compact time left until `seconds`; 0s once it has passed. */
export function timeLeft(seconds: bigint, now = Date.now()): string {
  return compactDuration(Math.floor(Number(seconds) - now / 1000));
}

function compactDuration(seconds: number): string {
  const span = Math.max(0, seconds);
  if (span < 60) return `${span}s`;
  if (span < 3600) return `${Math.floor(span / 60)}m`;
  if (span < 86_400) return `${Math.floor(span / 3600)}h`;
  return `${Math.floor(span / 86_400)}d`;
}

/** `privateValue` -> `Private payment`, the reader-facing name for a kind. */
export function formatKind(kind: string): string {
  switch (kind) {
    case "privateValue":
      return "Private payment";
    case "userAccountCreation":
      return "Account creation";
    case "userAccountUpdate":
      return "Account update";
    case "contractAccount":
      return "Contract creation";
    default:
      return kind.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  }
}

/** How a contract creation was funded. */
export function formatFundingMode(mode: ContractFundingMode): string {
  return mode === "sponsored" ? "Sponsored" : "Unfunded";
}

/** Lists name only whether a transaction failed; the reason is on its page. */
export function outcomeLabel(outcome: TransactionOutcome): "Succeeded" | "Failed" {
  return outcome === "succeeded" ? "Succeeded" : "Failed";
}

const FAILURE_REASONS: Record<Exclude<TransactionOutcome, "succeeded">, string> = {
  publicInputNotInField: "One of the transaction's public values was out of range.",
  recentPcashBlockNotInWindow: "This transaction referenced a PCASH block that was too old by the time it was included.",
  expired: "This transaction expired before it was included.",
  notYetValid: "This transaction was included before the time it allowed.",
  zeroNullifier: "One of the transaction's spent notes had an empty identifier.",
  duplicateInputNullifier: "This transaction tried to spend the same note twice.",
  nullifierAlreadySpent: "This transaction tried to spend a note that had already been spent.",
  proofRejected: "The transaction's proof did not verify.",
  outputCapacity: "The chain had no room left for this transaction's new notes.",
  accountCapacity: "The chain had no room left for a new account.",
  invalidAccountSignature: "The account signature was malformed or did not recover a signer.",
  accountNotFound: "The account this transaction updates does not exist.",
  accountAlreadyExists: "An account already exists at this address.",
  accountRevisionExhausted: "The account cannot be updated any further.",
  wrongAccountKind: "This transaction updates a contract as if it were a user account.",
  clearWithoutReceiveKey: "This transaction removed a receive key the account did not have.",
  replaceWithIdenticalReceiveKey: "This transaction replaced the account's receive key with the same key.",
  accountUpdateCommitmentMismatch: "The account update did not match what its proof committed to.",
  nonCanonicalAccountField: "One of the account's values was out of range.",
  contractAddressExists: "An account already exists at the new contract's address.",
  nonCanonicalContractField: "One of the new contract's values was out of range.",
  emptyContractFunctionSet: "The new contract has no functions.",
  selectorsNotStrictlyIncreasing: "The new contract's functions were out of order or repeated.",
  carrierContextMismatch: "This transaction required a different carrier than the one that delivered it.",
};

/** Why a transaction failed, in one sentence. */
export function describeFailure(outcome: Exclude<TransactionOutcome, "succeeded">): string {
  return FAILURE_REASONS[outcome];
}

export function formatBytes(value: bigint): string {
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export type Tone = "good" | "bad" | "warn" | "info";

export function outcomeTone(outcome: TransactionOutcome): Tone {
  return outcome === "succeeded" ? "good" : "bad";
}

/**
 * What a transaction did to the note set. This is the column that replaces
 * Etherscan's Value: amounts and parties are encrypted, but the shape of the
 * effect is public by construction.
 */
export function describeEffect(summary: {
  kind: string;
  outcome: TransactionOutcome;
  nullifiers: string[] | null;
  outputsAdded: bigint;
  account: { address: string } | null;
}): string {
  if (summary.outcome !== "succeeded") return "None — the transaction failed";
  if (summary.account !== null) return summary.account.address;
  const spent = summary.nullifiers?.length ?? 0;
  return `${spent} in → ${summary.outputsAdded} out`;
}

/** Whether a block is final, given the node's reported finalized height. */
export function isFinalized(blockNumber: bigint, finalizedBlock: bigint | null): boolean {
  return finalizedBlock !== null && blockNumber <= finalizedBlock;
}

const ETHERSCAN_BY_CHAIN: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
};

/**
 * A link to the L1 transaction that carried a batch. Absent for a chain with
 * no public explorer, in which case the page shows the hash and no link.
 */
export function etherscanTransactionUrl(l1ChainId: number, hash: string): string | undefined {
  const base = ETHERSCAN_BY_CHAIN[l1ChainId];
  return base === undefined ? undefined : `${base}/tx/${hash}`;
}

export function etherscanAddressUrl(l1ChainId: number, address: string): string | undefined {
  const base = ETHERSCAN_BY_CHAIN[l1ChainId];
  return base === undefined ? undefined : `${base}/address/${address}`;
}

/**
 * A failed transaction's reason, rendered as operands rather than a code. The
 * detail is committed, so every operand named here is a fact about the chain.
 */
export interface FailureOperand {
  label: string;
  value: string;
  /** A transaction id or block number the operand points at. */
  link?: { kind: "transaction" | "block"; value: string };
}

export function failureOperands(detail: FailureDetail): FailureOperand[] {
  const hex = (value: string): string => value;
  switch (detail.type) {
    case "nullifierAlreadySpent":
      return [
        { label: "Nullifier", value: hex(detail.nullifier) },
        { label: "Operand", value: `input ${detail.inputSlot + 1n} of 4` },
        {
          label: "First spent in",
          value: shortHex(detail.spendingTransactionId),
          link: { kind: "transaction", value: detail.spendingTransactionId },
        },
      ];
    case "duplicateInputNullifier":
      return [
        { label: "Nullifier", value: hex(detail.nullifier) },
        { label: "First input", value: String(detail.firstInputSlot + 1n) },
        { label: "Duplicate input", value: String(detail.duplicateInputSlot + 1n) },
      ];
    case "zeroNullifier":
      return [{ label: "Operand", value: `input ${detail.inputSlot + 1n}` }];
    case "expired":
      return [
        { label: "Valid until", value: formatTime(detail.validUntil) },
        { label: "Block timestamp", value: formatTime(detail.blockTimestamp) },
      ];
    case "notYetValid":
      return [
        { label: "Not before", value: formatTime(detail.notBefore) },
        { label: "Block timestamp", value: formatTime(detail.blockTimestamp) },
      ];
    case "recentPcashBlockNotInWindow":
      return [
        { label: "Referenced block", value: hex(detail.referencedBlockHash) },
        { label: "Window start", value: formatTime(detail.windowStartTimestamp) },
        { label: "Window end", value: formatTime(detail.windowEndTimestamp) },
      ];
    case "accountAlreadyExists":
      return [
        { label: "Address", value: detail.address },
        { label: "Existing revision", value: String(detail.existingRevision) },
      ];
    case "accountNotFound":
    case "clearWithoutReceiveKey":
      return [{ label: "Address", value: detail.address }];
    case "outputCapacity":
    case "accountCapacity":
      return [
        { label: "Requested", value: String(detail.requestedCount) },
        { label: "Limit", value: String(detail.limit) },
      ];
    case "publicInputNotInField":
      return [
        { label: "Public input", value: String(detail.publicInputIndex) },
        { label: "Supplied", value: hex(detail.supplied) },
      ];
    case "carrierContextMismatch":
      return [
        { label: "Required carrier context", value: hex(detail.required) },
        { label: "Delivering carrier context", value: hex(detail.carrier) },
      ];
    default:
      return Object.entries(detail)
        .filter(([key]) => key !== "type")
        .map(([key, value]) => ({
          label: key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
          value: String(value),
        }));
  }
}

export type SearchTarget =
  | { kind: "block"; number: bigint }
  | { kind: "address"; address: string }
  | { kind: "name"; name: string }
  | { kind: "hash"; hash: string };

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_20 = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;

/**
 * A query is resolved by shape alone where it can be. A 32-byte hash names
 * four different things, so it becomes a `hash` target that the search page
 * resolves against the node.
 */
export function parseSearchTarget(input: string): SearchTarget {
  const value = input.trim();
  if (DECIMAL.test(value)) return { kind: "block", number: BigInt(value) };
  if (HEX_20.test(value)) return { kind: "address", address: value };
  if (HEX_32.test(value)) return { kind: "hash", hash: value.toLowerCase() };
  const name = normalizeIdentityName(value);
  if (name !== undefined) return { kind: "name", name };
  throw new Error("Enter a block number, an address or ENS, .gwei or .wei name, or a 32-byte hash.");
}
