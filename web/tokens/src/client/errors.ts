/** Why a token action cannot proceed, in terms a page can show directly. */
export type TokensErrorCode =
  /** The wallet has no synced state, signer, or receive key this action needs. */
  | "wallet-not-ready"
  /** The wallet holds no verified definition for the token. */
  | "unknown-asset"
  /** The wallet cannot spend enough of the token. */
  | "insufficient-funds"
  /** The node's publication catalog is unavailable or refuses drops. */
  | "catalog-unavailable"
  | "link-claimed"
  | "link-unfunded"
  /** A saved claim transaction pays another recipient and cannot be changed on retry. */
  | "claim-recipient-mismatch"
  /** The link opens no note: it is malformed or for another chain. */
  | "link-invalid"
  | "drop-claimed"
  | "drop-ineligible"
  | "drop-not-started"
  | "drop-no-account"
  | "drop-exhausted"
  | "drop-ended"
  /** The drop's claim window has not closed, so the creator cannot reclaim yet. */
  | "drop-open"
  /** Nothing is left to reclaim. */
  | "nothing-to-reclaim"
  /** Every link in the set has already been claimed. */
  | "links-all-claimed"
  /** The wallet cannot fund the requested fee from its native notes. */
  | "insufficient-fee-notes"
  /** A funding transaction expired or conflicted; the wallet's bulk job needs review. */
  | "funding-needs-review"
  /** A submitted transaction is still waiting for inclusion; resume later. */
  | "pending"
  | "unknown-record";

export class TokensError extends Error {
  readonly code: TokensErrorCode;

  constructor(code: TokensErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokensError";
    this.code = code;
  }
}

export function isTokensError(error: unknown, code?: TokensErrorCode): error is TokensError {
  return error instanceof TokensError && (code === undefined || error.code === code);
}
