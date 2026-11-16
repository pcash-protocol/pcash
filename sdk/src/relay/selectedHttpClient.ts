import type { SelectedRelayQuote, SelectedRelayQuoteProvider, SelectedRelayQuoteRequest } from "../eip712/selectedRelayQuote.ts";

/** Carries every request this client makes, e.g. through a proxy. */
export type SelectedRelayFetch = (url: string, init?: RequestInit) => Promise<Response>;

const globalFetch: SelectedRelayFetch = (url, init) => fetch(url, init);

/** Browser-safe quote provider. Proved transactions use the ordinary public mempool. */
export class SelectedRelayHttpClient implements SelectedRelayQuoteProvider {
  readonly recipient: bigint;
  readonly maxQuoteLifetimeSeconds: bigint;
  readonly url: string;
  readonly #fetch: SelectedRelayFetch;

  constructor(url: string, recipient: bigint, maxQuoteLifetimeSeconds: bigint, fetchFn: SelectedRelayFetch = globalFetch) {
    this.url = url.replace(/\/$/, "");
    this.recipient = recipient;
    this.maxQuoteLifetimeSeconds = maxQuoteLifetimeSeconds;
    this.#fetch = fetchFn;
  }

  static async connect(url: string, fetchFn: SelectedRelayFetch = globalFetch): Promise<SelectedRelayHttpClient> {
    const normalized = url.replace(/\/$/, "");
    const response = await fetchFn(`${normalized}/selected/info`);
    if (!response.ok) throw new Error(`selected relay info returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("recipient" in value)
      || !("maxQuoteLifetimeSeconds" in value)
      || typeof value.maxQuoteLifetimeSeconds !== "string"
      || !/^[1-9][0-9]*$/.test(value.maxQuoteLifetimeSeconds)) {
      throw new Error("invalid selected relay info response");
    }
    return new SelectedRelayHttpClient(normalized, BigInt(String(value.recipient)), BigInt(value.maxQuoteLifetimeSeconds), fetchFn);
  }

  /** The same relay, with its quotes carried by `fetchFn`. */
  withFetch(fetchFn: SelectedRelayFetch): SelectedRelayHttpClient {
    return new SelectedRelayHttpClient(this.url, this.recipient, this.maxQuoteLifetimeSeconds, fetchFn);
  }

  async requestQuote(request: SelectedRelayQuoteRequest): Promise<SelectedRelayQuote> {
    if (request.recipient !== this.recipient) throw new Error("selected relay recipient mismatch");
    const response = await this.#fetch(`${this.url}/selected/quote`, {
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
