import type { SelectedRelayQuote, SelectedRelayQuoteProvider, SelectedRelayQuoteRequest } from "../eip712/selectedRelayQuote.ts";

/** Browser-safe quote provider. Proved transactions use the ordinary public mempool. */
export class SelectedRelayHttpClient implements SelectedRelayQuoteProvider {
  readonly recipient: bigint;
  readonly maxQuoteLifetimeSeconds: bigint;
  readonly url: string;

  constructor(url: string, recipient: bigint, maxQuoteLifetimeSeconds: bigint) {
    this.url = url.replace(/\/$/, "");
    this.recipient = recipient;
    this.maxQuoteLifetimeSeconds = maxQuoteLifetimeSeconds;
  }

  static async connect(url: string): Promise<SelectedRelayHttpClient> {
    const normalized = url.replace(/\/$/, "");
    const response = await fetch(`${normalized}/selected/info`);
    if (!response.ok) throw new Error(`selected relay info returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("recipient" in value)
      || !("maxQuoteLifetimeSeconds" in value)
      || typeof value.maxQuoteLifetimeSeconds !== "string"
      || !/^[1-9][0-9]*$/.test(value.maxQuoteLifetimeSeconds)) {
      throw new Error("invalid selected relay info response");
    }
    return new SelectedRelayHttpClient(normalized, BigInt(String(value.recipient)), BigInt(value.maxQuoteLifetimeSeconds));
  }

  async requestQuote(request: SelectedRelayQuoteRequest): Promise<SelectedRelayQuote> {
    if (request.recipient !== this.recipient) throw new Error("selected relay recipient mismatch");
    const response = await fetch(`${this.url}/selected/quote`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pcashChainId: request.pcashChainId.toString(), recipient: request.recipient.toString(),
        privateFeeAmount: request.privateFeeAmount.toString(),
        transactionContext: request.transactionContext.toString(),
        quoteBinding: request.quoteBinding.toString(),
        maxTransactionBytes: request.maxTransactionBytes.toString(),
        validUntilTimestamp: request.validUntilTimestamp.toString(),
        issuanceEligible: request.issuanceEligible ?? true,
      }),
    });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(typeof value === "object" && value !== null && "error" in value
      ? String(value.error) : `selected relay returned HTTP ${response.status}`);
    if (typeof value !== "object" || value === null) throw new Error("invalid selected relay quote response");
    return value as SelectedRelayQuote;
  }
}
