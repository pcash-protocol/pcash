import type { IncomingMessage, ServerResponse } from "node:http";
import { createSelectedRelayQuote, type PcashActionSigner } from "@pcash/sdk/eip712";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { publicErrorMessage } from "@pcash/sdk/relay";
import { networkConfigFromStatus, MAX_TX_BYTES } from "@pcash/sdk/protocol";
import { toHex } from "@pcash/sdk/utils";
import type { PcashProfile } from "@pcash/sdk/wallet";

const MAX_BODY_BYTES = 16_384;

function response(output: ServerResponse, status: number, value: unknown): void {
  output.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" });
  output.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("selected quote request exceeds size limit");
    parts.push(bytes);
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("selected quote request must be an object");
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a decimal string`);
  return BigInt(value);
}

export interface SelectedRelayServiceConfig {
  node: Pick<PcashNodeClient, "status">;
  isAvailable?: () => boolean;
  profile: PcashProfile;
  signer: PcashActionSigner;
  minPrivateFee: bigint;
  minValuePerByte: bigint;
  maxQuoteLifetimeSeconds: bigint;
}

/** Quote-only endpoint; exact proved transactions enter the public PCASH mempool. */
export function selectedRelayHandler(config: SelectedRelayServiceConfig) {
  return async (request: IncomingMessage, output: ServerResponse): Promise<boolean> => {
    if (!request.url?.startsWith("/selected/")) return false;
    if (request.method === "OPTIONS") {
      response(output, 204, null);
      return true;
    }
    if ((request.method === "GET" && request.url === "/selected/info")
      || (request.method === "POST" && request.url === "/selected/quote")) {
      if (config.isAvailable?.() === false) {
        response(output, 503, { error: "selected relay is unavailable" });
        return true;
      }
    }
    try {
      if (request.method === "GET" && request.url === "/selected/info") {
        response(output, 200, { recipient: config.profile.address.toString(),
          maxQuoteLifetimeSeconds: config.maxQuoteLifetimeSeconds.toString() });
        return true;
      }
      if (request.method === "POST" && request.url === "/selected/quote") {
        const input = await body(request);
        let status: Awaited<ReturnType<typeof config.node.status>>;
        try { status = await config.node.status(); }
        catch { response(output, 503, { error: "selected relay node is unavailable" }); return true; }
        if (config.isAvailable?.() === false) {
          response(output, 503, { error: "selected relay is unavailable" });
          return true;
        }
        const pcashChainId = integer(input.pcashChainId, "pcashChainId");
        const recipient = integer(input.recipient, "recipient");
        const privateFeeAmount = integer(input.privateFeeAmount, "privateFeeAmount");
        const transactionContext = integer(input.transactionContext, "transactionContext");
        const quoteBinding = integer(input.quoteBinding, "quoteBinding");
        const maxTransactionBytes = integer(input.maxTransactionBytes, "maxTransactionBytes");
        const validUntilTimestamp = integer(input.validUntilTimestamp, "validUntilTimestamp");
        if (pcashChainId !== BigInt(status.pcashChainId) || recipient !== config.profile.address
          || maxTransactionBytes === 0n || maxTransactionBytes > BigInt(MAX_TX_BYTES)
          || privateFeeAmount < config.minPrivateFee
          || privateFeeAmount < config.minValuePerByte * maxTransactionBytes
          || transactionContext === 0n || quoteBinding === 0n
          || validUntilTimestamp <= status.latestBlockTimestamp
          || validUntilTimestamp > status.latestBlockTimestamp + config.maxQuoteLifetimeSeconds) {
          throw new Error("invalid selected relay quote terms");
        }
        if (input.issuanceEligible !== undefined && typeof input.issuanceEligible !== "boolean") throw new Error("issuanceEligible must be boolean");
        const quote = await createSelectedRelayQuote({
          network: networkConfigFromStatus(status), pcashChainId, recipient,
          nkRoot: config.profile.nkRoot, receiveKey: config.profile.mlKemPublicKey,
          privateFeeAmount, transactionContext, quoteBinding, maxTransactionBytes, validUntilTimestamp,
          issuanceEligible: input.issuanceEligible !== false, signer: config.signer,
        });
        if (config.isAvailable?.() === false) {
          response(output, 503, { error: "selected relay is unavailable" });
          return true;
        }
        response(output, 200, {
          ...quote,
          pcashChainId: pcashChainId.toString(), recipient: recipient.toString(),
          privateFeeAmount: privateFeeAmount.toString(),
          issuanceOwnerCommitment: BigInt(quote.issuanceOwnerCommitment).toString(),
          issuanceNoteSecret: BigInt(quote.issuanceNoteSecret).toString(),
          transactionContext: transactionContext.toString(), quoteBinding: quoteBinding.toString(),
          maxTransactionBytes: maxTransactionBytes.toString(), validUntilTimestamp: validUntilTimestamp.toString(),
          signature: toHex(quote.signature as Uint8Array),
        });
        return true;
      }
      response(output, 404, { error: "unknown selected quote endpoint" });
      return true;
    } catch (error) {
      response(output, 400, { error: publicErrorMessage(error) });
      return true;
    }
  };
}
