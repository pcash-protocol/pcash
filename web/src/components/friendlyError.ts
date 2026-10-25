export const NO_RECEIVE_KEY_MESSAGE = "This address hasn't set up PCASH, so it can't receive a private payment yet.";

function causes(cause: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = cause; current !== null && typeof current === "object" && chain.length < 8; current = (current as { cause?: unknown }).cause) chain.push(current);
  return chain;
}

function rejected(chain: unknown[]): boolean {
  return chain.some((entry) => {
    const { name, code, message } = entry as { name?: unknown; code?: unknown; message?: unknown };
    return name === "UserRejectedRequestError"
      || (code === 4001 && typeof message === "string" && /reject|denied/i.test(message));
  });
}

function messageOf(entry: unknown): string {
  const message = (entry as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(entry);
}

/**
 * Conditions a person can act on, most specific first. A string names an error
 * class; a pattern matches a message. Either may sit anywhere in the cause chain.
 */
const RULES: ReadonlyArray<readonly [RegExp | string, string]> = [
  ["RelayJournalConflictError", "An earlier Ethereum submission from this wallet is still pending. Wait for it to land or review it, then try again."],
  // The site's own check before proving a Faster action.
  ["FasterGasError", "Not enough ETH for gas. Add ETH to your Ethereum wallet and try again."],
  // Ethereum RPCs and wallets, viem's InsufficientFundsError, and the SDK's own balance checks.
  [/insufficient (funds|balance)|exceeds the balance of the account|is underfunded|not enough ETH/i,
    "Your Ethereum wallet doesn't have enough ETH for this transaction and its gas."],
  [/nonce too low|nonce has already been used|lower than the current nonce/i,
    "Your Ethereum wallet sent another transaction in this one's place. Check your Ethereum submission before trying again."],
  // Reads and simulated writes both end here.
  [/execution reverted|contract function "[^"]*" reverted/i, "The Ethereum contract rejected this request."],
  // The SDK keeps only the class name of a failed gas or fee read; a cause above names the reason when there is one.
  [/estimating relay gas failed|estimating EIP-1559 fees failed|reading L1 fee history failed/i,
    "Ethereum gas could not be estimated right now. Try again in a moment."],
  // The wallet's note selection, live or as a marketplace record saved its message. It names
  // neither the asset nor whether the balance is short or split across too many notes.
  [/^insufficient notes to cover/, "Not enough funds in one transaction."],
  // Marketplace refresh and listing records.
  [/^Catalog unavailable/, "Could not load listings from the network. Showing listings saved in this browser."],
  [/^Funded offer has not been published to the catalog/, "Your listing is funded but not listed for buyers yet. Continue to list it."],
  [/^(failed to fetch|load failed|networkerror)/i, "Could not reach the network. Check your connection and try again."],
  [/^HTTP request failed/, "The network did not respond. Try again in a moment."],
  [/mempool is full|node is busy|RPC capacity exhausted/i, "The network is busy. Try again in a minute."],
  [/transaction is ineligible at the current state/i,
    "The network no longer accepts this transaction because the chain changed after it was prepared. Refresh and try again."],
  [/derived PCASH profile does not match the account's nullifier-key commitment/,
    "This wallet produced a different key than when the account was created. This can happen with wallets that do not sign the same way twice. Your funds are reachable only from the browser where you first used this account. Do not clear that browser's site data."],
  [/injected wallet is on chain|wallet is connected to chain \d+, but/i, "Your Ethereum wallet is on a different network. Switch networks and try again."],
  [/injected wallet is not connected to relay account/i,
    "Your Ethereum wallet switched accounts. Switch back to the account you connected, then try again."],
  // A public RPC may use its transaction-rejected code for eth_estimateGas. The wallet was not asked to send it.
  ["EstimateGasExecutionError", "Ethereum gas could not be estimated right now. Try again in a moment."],
  // EIP-1474 -32003, which viem calls "Transaction creation failed.", when its details named nothing above.
  ["TransactionRejectedRpcError", "Your Ethereum wallet refused to send this transaction."],
  // The SDK's wording also offers receive codes, which the website does not use.
  [/has no published ML-KEM receive key/, NO_RECEIVE_KEY_MESSAGE],
  // The SDK relay's catch-alls, after every rule that names a cause they wrap.
  ["RelayDeadlineError", "Ethereum or the PCASH node took too long to respond. Check Activity before trying again; it may still go through."],
  ["RelayUpstreamError", "Ethereum or the PCASH node did not respond as expected. Try again in a moment."],
];

/**
 * One sentence a person can act on. Wallet rejections and the conditions above
 * get fixed copy wherever they sit in the cause chain. Anything else keeps its
 * own words: viem's short message instead of the request dump, a PCASH node's
 * message without its code prefix.
 */
export function friendlyError(cause: unknown): string {
  const chain = causes(cause);
  if (rejected(chain)) return "You rejected the request in your wallet.";
  const entries = chain.length === 0 ? [cause] : chain;
  for (const [match, plain] of RULES) {
    if (entries.some((entry) => typeof match === "string" ? (entry as { name?: unknown } | null)?.name === match : match.test(messageOf(entry)))) return plain;
  }
  // A node error is a viem RpcRequestError whose short message is only "RPC Request failed.".
  if ((cause as { name?: unknown } | null)?.name === "PcashNodeRpcError") return messageOf(cause).replace(/^node RPC error -?\d+(?: \([^)]*\))?: /, "");
  const shortMessage = (cause as { shortMessage?: unknown } | null)?.shortMessage;
  return typeof shortMessage === "string" ? shortMessage : messageOf(cause);
}
