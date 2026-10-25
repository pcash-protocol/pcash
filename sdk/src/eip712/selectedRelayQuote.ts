import { type FieldNumberish, fieldToHex, toField, toAddressField } from "../crypto/field.ts";
import { ML_KEM_768_PUBLIC_KEY_LENGTH } from "../constants/params.ts";
import { uintBelow, U128_LIMIT } from "../utils/validate.ts";
import { fromHex, toHex } from "../utils/hex.ts";
import { receiveKeyHash } from "../protocol/account.ts";
import { networkForChain, type NetworkConfigLike } from "../protocol/network.ts";
import { ownerCommitment } from "../protocol/notes.ts";
import { payoutSeed, payoutNoteSecret, PayoutRole, type DesignatedIssuanceOpening } from "../protocol/payout.ts";
import { pcashTypedData, serializeEcdsaSignature, type EcdsaSignatureInput, type PcashTypedData } from "./eip712.ts";
import { createPcashAuthorizationRequest, requestPcashAuthorization, verifyPcashAuthorization, type PcashActionSigner } from "./authorization.ts";

export const SELECTED_RELAY_QUOTE_TYPE = "PcashSelectedRelayQuote(uint256 pcashChainId,address recipient,uint256 privateFeeAmount,bytes32 receiveKeyHash,uint256 issuanceOwnerCommitment,uint256 transactionContext,uint256 quoteBinding,uint32 maxTransactionBytes,uint64 validUntilTimestamp)";

export interface SelectedRelayQuoteMessage {
  pcashChainId: FieldNumberish;
  recipient: FieldNumberish;
  privateFeeAmount: FieldNumberish;
  receiveKeyHash: string;
  issuanceOwnerCommitment: FieldNumberish;
  transactionContext: FieldNumberish;
  quoteBinding: FieldNumberish;
  maxTransactionBytes: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
}

export interface SelectedRelayQuote extends SelectedRelayQuoteMessage {
  receiveKey: string;
  issuanceNoteSecret: FieldNumberish;
  signature: EcdsaSignatureInput;
}

export function selectedRelayQuoteTypedData(network: NetworkConfigLike, message: SelectedRelayQuoteMessage): PcashTypedData<"PcashSelectedRelayQuote"> {
  return pcashTypedData(networkForChain(message.pcashChainId, network), SELECTED_RELAY_QUOTE_TYPE, {
    pcashChainId: message.pcashChainId,
    recipient: message.recipient,
    privateFeeAmount: uintBelow(message.privateFeeAmount, U128_LIMIT, "privateFeeAmount"),
    receiveKeyHash: message.receiveKeyHash,
    issuanceOwnerCommitment: message.issuanceOwnerCommitment,
    transactionContext: message.transactionContext,
    quoteBinding: message.quoteBinding,
    maxTransactionBytes: message.maxTransactionBytes,
    validUntilTimestamp: message.validUntilTimestamp,
  });
}

function request(network: NetworkConfigLike, message: SelectedRelayQuoteMessage) {
  return createPcashAuthorizationRequest({ kind: "selected-relay-quote", authorizingAddress: message.recipient,
    typedData: selectedRelayQuoteTypedData(network, message) });
}

/** Authenticate private receive material and a separate one-time issuance destination. */
export async function createSelectedRelayQuote(params: {
  network: NetworkConfigLike;
  pcashChainId: FieldNumberish;
  recipient: FieldNumberish;
  nkRoot: FieldNumberish;
  receiveKey: Uint8Array;
  privateFeeAmount: FieldNumberish;
  transactionContext: FieldNumberish;
  quoteBinding: FieldNumberish;
  maxTransactionBytes: FieldNumberish;
  issuanceEligible?: boolean;
  validUntilTimestamp: FieldNumberish;
  signer: PcashActionSigner;
}): Promise<SelectedRelayQuote> {
  if (params.receiveKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) throw new Error("selected relay receive key has invalid length");
  const designated = params.issuanceEligible !== false;
  const issuanceNoteSecret = designated
    ? payoutNoteSecret(payoutSeed(params.nkRoot), PayoutRole.ISSUANCE, params.transactionContext)
    : 0n;
  const message: SelectedRelayQuoteMessage = {
    pcashChainId: params.pcashChainId, recipient: params.recipient,
    privateFeeAmount: params.privateFeeAmount, receiveKeyHash: fieldToHex(receiveKeyHash(params.receiveKey)),
    issuanceOwnerCommitment: designated ? ownerCommitment(params.recipient, issuanceNoteSecret) : 0n,
    transactionContext: params.transactionContext, quoteBinding: params.quoteBinding,
    maxTransactionBytes: params.maxTransactionBytes,
    validUntilTimestamp: params.validUntilTimestamp,
  };
  const signed = await requestPcashAuthorization(params.signer, request(params.network, message));
  return { ...message, receiveKey: toHex(params.receiveKey), issuanceNoteSecret, signature: serializeEcdsaSignature(signed) };
}

/** Verify the exact amount, recipient, context, receive key, and issuance route before proving. */
export function verifySelectedRelayQuote(network: NetworkConfigLike, quote: SelectedRelayQuote, expected: {
  recipient: FieldNumberish;
  pcashChainId: FieldNumberish;
  privateFeeAmount: FieldNumberish;
  transactionContext: FieldNumberish;
  quoteBinding: FieldNumberish;
  maxTransactionBytes: FieldNumberish;
  nowTimestamp: bigint;
}): { issuanceOwnerCommitment: bigint; designatedIssuanceOpening?: DesignatedIssuanceOpening; receiveKey: Uint8Array; privateFeeAmount: bigint } {
  if (toField(quote.pcashChainId) !== toField(expected.pcashChainId) || toAddressField(quote.recipient) !== toAddressField(expected.recipient)
    || toField(quote.privateFeeAmount) !== toField(expected.privateFeeAmount)
    || toField(quote.transactionContext) !== toField(expected.transactionContext)
    || toField(quote.quoteBinding) !== toField(expected.quoteBinding)
    || toField(quote.maxTransactionBytes) !== toField(expected.maxTransactionBytes)) {
    throw new Error("selected relay quote does not match the requested recipient, chain, amount, context, and binding");
  }
  if (BigInt(quote.validUntilTimestamp) < expected.nowTimestamp) throw new Error("selected relay quote expired");
  const receiveKey = fromHex(quote.receiveKey);
  if (receiveKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH || fieldToHex(receiveKeyHash(receiveKey)) !== quote.receiveKeyHash.toLowerCase()) {
    throw new Error("selected relay quote receive key mismatch");
  }
  const secret = toField(quote.issuanceNoteSecret, "issuance note secret");
  const commitment = toField(quote.issuanceOwnerCommitment, "issuanceOwnerCommitment");
  if (commitment === 0n ? secret !== 0n : ownerCommitment(quote.recipient, secret) !== commitment) {
    throw new Error("selected relay quote issuance opening mismatch");
  }
  verifyPcashAuthorization(request(network, quote), quote.signature);
  return { issuanceOwnerCommitment: commitment,
    ...(commitment === 0n ? {} : { designatedIssuanceOpening: { recipientAddress: quote.recipient, noteSecret: secret, transactionContext: quote.transactionContext } }),
    receiveKey, privateFeeAmount: toField(quote.privateFeeAmount) };
}

export interface SelectedRelayQuoteRequest {
  pcashChainId: bigint;
  recipient: bigint;
  privateFeeAmount: bigint;
  transactionContext: bigint;
  quoteBinding: bigint;
  maxTransactionBytes: bigint;
  issuanceEligible?: boolean;
  validUntilTimestamp: bigint;
}

export interface SelectedRelayQuoteProvider {
  recipient: bigint;
  maxQuoteLifetimeSeconds?: bigint;
  requestQuote(request: SelectedRelayQuoteRequest): Promise<SelectedRelayQuote>;
}
