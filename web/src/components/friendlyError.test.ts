import { expect, it } from "vitest";
import { EstimateGasExecutionError, HttpRequestError, InsufficientFundsError, NonceTooLowError, RpcRequestError, TransactionRejectedRpcError, UnknownRpcError, WaitForTransactionReceiptTimeoutError } from "viem";
import { PcashNodeRpcError } from "@pcash/sdk/clients";
import { RelayJournalConflictError, relayFailure } from "@pcash/sdk/relay";
import { friendlyError } from "./friendlyError.ts";

const NO_ETH = "Your Ethereum wallet doesn't have enough ETH for this transaction and its gas.";
const REVERTED = "The Ethereum contract rejected this request.";

/** A viem error: a short message over a multi-line request dump, with its cause. */
function viemError(name: string, shortMessage: string, cause?: unknown) {
  return Object.assign(new Error(`${shortMessage}\n\nRequest Arguments:\n  data: 0x${"ab".repeat(400)}\n\nVersion: viem@2`, cause === undefined ? undefined : { cause }), { name, shortMessage });
}

it("names a wallet rejection anywhere in the cause chain", () => {
  expect(friendlyError(new Error("Submission failed", { cause: Object.assign(new Error("User rejected the request."), { code: 4001 }) }))).toBe("You rejected the request in your wallet.");
  expect(friendlyError(Object.assign(new Error("x"), { name: "UserRejectedRequestError" }))).toBe("You rejected the request in your wallet.");
});

it("keeps a 4001 whose message is not a rejection", () => {
  expect(friendlyError(Object.assign(new Error("Network changed. Unsent work was canceled."), { code: 4001 }))).toBe("Network changed. Unsent work was canceled.");
});

it("prefers a short message and explains unreachable endpoints", () => {
  expect(friendlyError(viemError("ChainMismatchError", "The current chain of the wallet does not match the target chain."))).toBe("The current chain of the wallet does not match the target chain.");
  expect(friendlyError(new TypeError("Failed to fetch"))).toBe("Could not reach the network. Check your connection and try again.");
  expect(friendlyError(new HttpRequestError({ url: "https://rpc.example", cause: new TypeError("Failed to fetch") }))).toBe("Could not reach the network. Check your connection and try again.");
  expect(friendlyError(new HttpRequestError({ url: "https://rpc.example", status: 502, details: "Bad gateway" }))).toBe("The network did not respond. Try again in a moment.");
  expect(friendlyError("plain")).toBe("plain");
  expect(friendlyError({ code: -32000, message: "header not found" })).toBe("header not found");
});

it("explains a recipient without a published receive key without mentioning receive codes", () => {
  expect(friendlyError(new Error("recipient 0x00000000000000000000000000000000000000aa has no published ML-KEM receive key; they must publish an account with one or share an extended code before receiving")))
    .toBe("This address hasn't set up PCASH, so it can't receive a private payment yet.");
});

it("explains a profile-signature mismatch without exposing the raw sync error", () => {
  const raw = "derived PCASH profile does not match the account's nullifier-key commitment; the wallet returned a different profile signature or the account uses another profile";
  expect(friendlyError(new Error(raw))).toBe("This wallet produced a different key than when the account was created. This can happen with wallets that do not sign the same way twice. Your funds are reachable only from the browser where you first used this account. Do not clear that browser's site data.");
});

it("explains missing ETH however the wallet, RPC, viem or SDK words it", () => {
  // An injected wallet refusing the Fast submission with -32003, which viem calls "Transaction creation failed.", as the SDK wraps it.
  const rejected = new TransactionRejectedRpcError(new RpcRequestError({ body: { method: "eth_sendTransaction" }, url: "https://rpc.example",
    error: { code: -32003, message: "insufficient funds for gas * price + value: balance 0, tx cost 2100000000" } }));
  expect(friendlyError(rejected)).toBe(NO_ETH);
  const refused = new Error(`injected wallet refused relay submission: [-32003] ${rejected.shortMessage}`, { cause: rejected });
  expect(friendlyError(Object.assign(new Error(refused.message, { cause: refused }), { name: "DurablePreBroadcastError" }))).toBe(NO_ETH);
  // viem's action-level mapping of the same node message.
  expect(friendlyError(new EstimateGasExecutionError(new InsufficientFundsError(), {}))).toBe(NO_ETH);
  expect(friendlyError(new Error(`L1 submitter 0x${"11".repeat(20)} is underfunded: balance 1 wei < maximum relay cost 2 wei`))).toBe(NO_ETH);
  expect(friendlyError(new Error("not enough ETH for payment, payment gas, and direct-L1 claim gas reserve"))).toBe(NO_ETH);
  expect(friendlyError(new Error("insufficient balance for transfer"))).toBe(NO_ETH);
  // A gas estimate that failed for lack of ETH says so, not that the estimate failed.
  expect(friendlyError(new Error("estimating relay gas failed (EstimateGasExecutionError)", {
    cause: viemError("EstimateGasExecutionError", "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account."),
  }))).toBe(NO_ETH);
});

it("explains Ethereum conditions a user can act on", () => {
  const replaced = "Your Ethereum wallet sent another transaction in this one's place. Check your Ethereum submission before trying again.";
  expect(friendlyError(new Error("Wallet did not confirm whether the transaction was sent: [-32000] nonce too low"))).toBe(replaced);
  expect(friendlyError(new NonceTooLowError({ nonce: 3 }))).toBe(replaced);
  // The same words fit a simulated write and a read-only call.
  expect(friendlyError(viemError("ContractFunctionExecutionError", "The contract function \"pay\" reverted.")))
    .toBe(REVERTED);
  expect(friendlyError(viemError("ContractFunctionExecutionError", "The contract function \"quoteExactInput\" reverted.")))
    .toBe(REVERTED);
  expect(friendlyError(new Error("estimating relay gas failed (EstimateGasExecutionError)", { cause: viemError("ExecutionRevertedError", "Execution reverted for an unknown reason.") })))
    .toBe(REVERTED);
  expect(friendlyError(new Error("estimating relay gas failed (EstimateGasExecutionError)", { cause: viemError("EstimateGasExecutionError", "An unknown RPC error occurred.") })))
    .toBe("Ethereum gas could not be estimated right now. Try again in a moment.");
  const opaqueEstimate = new EstimateGasExecutionError(new TransactionRejectedRpcError(new RpcRequestError({
    body: { method: "eth_estimateGas" }, url: "https://rpc.example", error: { code: -32003, message: "tx fee exceeds the configured cap" },
  })), {});
  expect(friendlyError(opaqueEstimate)).toBe("Ethereum gas could not be estimated right now. Try again in a moment.");
  expect(friendlyError(new EstimateGasExecutionError(new HttpRequestError({ url: "https://rpc.example", cause: new TypeError("Failed to fetch") }), {})))
    .toBe("Could not reach the network. Check your connection and try again.");
  expect(friendlyError(new EstimateGasExecutionError(new HttpRequestError({ url: "https://rpc.example", status: 502, details: "Bad gateway" }), {})))
    .toBe("The network did not respond. Try again in a moment.");
  expect(friendlyError(new Error("injected wallet is on chain 1, expected 11155111"))).toBe("Your Ethereum wallet is on a different network. Switch networks and try again.");
  expect(friendlyError(new Error(`injected wallet is not connected to relay account 0x${"11".repeat(20)}`)))
    .toBe("Your Ethereum wallet switched accounts. Switch back to the account you connected, then try again.");
  // A -32003 refusal whose details name no known condition.
  expect(friendlyError(new TransactionRejectedRpcError(new RpcRequestError({ body: { method: "eth_sendTransaction" }, url: "https://rpc.example",
    error: { code: -32003, message: "tx fee exceeds the configured cap" } })))).toBe("Your Ethereum wallet refused to send this transaction.");
  expect(friendlyError(Object.assign(new Error("relay journal abc is in flight"), { name: "RelayJournalConflictError" })))
    .toBe("An earlier Ethereum submission from this wallet is still pending. Wait for it to land or review it, then try again.");
});

it("shows a PCASH node's own words instead of viem's generic RPC failure", () => {
  const node = (code: number, message: string, data?: unknown) => new PcashNodeRpcError({ code, message, data }, { method: "pcash_test", url: "https://node.example" });
  expect(friendlyError(node(-32602, "unknown block"))).toBe("unknown block");
  expect(friendlyError(node(-32602, "no such contract", { kind: "not_found" }))).toBe("no such contract");
  expect(friendlyError(node(-32012, "mempool is full"))).toBe("The network is busy. Try again in a minute.");
  expect(friendlyError(node(-32016, "node is busy: unpaid admission budget exhausted"))).toBe("The network is busy. Try again in a minute.");
  expect(friendlyError(node(-32017, "transaction is ineligible at the current state: NullifierAlreadySpent { nullifier: 0x01 }")))
    .toBe("The network no longer accepts this transaction because the chain changed after it was prepared. Refresh and try again.");
});

it("explains a spend larger than one transaction can fund without base units, live or as a saved record's message", () => {
  const message = "insufficient notes to cover 5000000000000000000: most spendable in one transfer is 1";
  expect(friendlyError(Object.assign(new Error(message), { name: "InsufficientNotesError" }))).toBe("Not enough funds in one transaction.");
  expect(friendlyError(message)).toBe("Not enough funds in one transaction.");
});

it("explains marketplace catalog and listing record failures in plain words", () => {
  expect(friendlyError("Catalog unavailable; showing durable local offers only. HTTP request failed. URL: https://node.example"))
    .toBe("Could not load listings from the network. Showing listings saved in this browser.");
  expect(friendlyError("Funded offer has not been published to the catalog"))
    .toBe("Your listing is funded but not listed for buyers yet. Continue to list it.");
});

it("explains SDK relay failures that name no specific cause", () => {
  const unreachable = "Ethereum or the PCASH node did not respond as expected. Try again in a moment.";
  const balance = relayFailure("reading the relay balance", new UnknownRpcError(new Error("socket hang up")));
  expect(balance.message).toBe("reading the relay balance failed (UnknownRpcError)");
  expect(friendlyError(balance)).toBe(unreachable);
  expect(friendlyError(new Error("Submission failed", { cause: balance }))).toBe(unreachable);
  const inclusion = relayFailure("waiting for relay inclusion", new WaitForTransactionReceiptTimeoutError({ hash: `0x${"ab".repeat(32)}` }));
  expect(inclusion.message).toBe("waiting for relay inclusion timed out");
  expect(friendlyError(inclusion)).toBe("Ethereum or the PCASH node took too long to respond. Check Activity before trying again; it may still go through.");
});

it("keeps specific copy for a cause a relay failure wraps", () => {
  expect(friendlyError(relayFailure("reading the relay balance", Object.assign(new Error("User rejected the request."), { code: 4001 }))))
    .toBe("You rejected the request in your wallet.");
  expect(friendlyError(relayFailure("estimating relay gas", new EstimateGasExecutionError(new InsufficientFundsError(), {})))).toBe(NO_ETH);
  expect(friendlyError(relayFailure("estimating relay gas", viemError("EstimateGasExecutionError", "An unknown RPC error occurred.")))).toBe("Ethereum gas could not be estimated right now. Try again in a moment.");
  expect(friendlyError(relayFailure("submitting the relay batch", new NonceTooLowError({ nonce: 3 }))))
    .toBe("Your Ethereum wallet sent another transaction in this one's place. Check your Ethereum submission before trying again.");
  expect(friendlyError(relayFailure("submitting the relay batch", new RelayJournalConflictError("relay journal abc is in flight"))))
    .toBe("An earlier Ethereum submission from this wallet is still pending. Wait for it to land or review it, then try again.");
});
