import { describe, expect, it } from "vitest";
import { paymentTypedData, type PaymentMessage } from "../src/rules/readableRules.ts";
import { assetCreationTypedData, type AssetCreationMessage } from "../src/rules/semanticRules.ts";
import { pcashSigningHash, recoverAddress, signDigest } from "../src/eip712/eip712.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { ownerCommitment } from "../src/protocol/notes.ts";
import { authorizationIssuanceOpening, payoutTransactionContext } from "../src/protocol/payout.ts";
import { deriveTestWallet } from "./testWallet.ts";

const wallet = deriveTestWallet();
const chainId = DEFAULT_NETWORK_CONFIG.pcashChainId;
const nullifiers = [11n, 12n, 13n, 14n];
const issuanceRecipient = 0xabcn;
const issuanceSecret = 0x123n;
const issuanceOwnerCommitment = ownerCommitment(issuanceRecipient, issuanceSecret);
const message: PaymentMessage = {
  pcashChainId: chainId, recipient: 0xdefn, amount: 100n, openFeeAmount: 0n,
  issuanceRecipient, issuanceOwnerCommitment, relayFeeAmount: 0n, relayFeeOwnerCommitment: 0n,
  accountCreationCommitment: 0n,
  transactionContext: payoutTransactionContext(chainId, nullifiers), notBefore: 0n, validUntil: 100n,
};
const paymentSigningHash = (m: PaymentMessage) => pcashSigningHash(paymentTypedData(DEFAULT_NETWORK_CONFIG, m));
const assetCreationSigningHash = (m: AssetCreationMessage) => pcashSigningHash(assetCreationTypedData(DEFAULT_NETWORK_CONFIG, m));

describe("proof-bound payout approvals", () => {
  it("rejects same-recipient fee secret substitution under the unchanged payer signature", () => {
    const signature = signDigest(wallet.privKey, paymentSigningHash(message));
    expect(recoverAddress(paymentSigningHash(message), signature)).toBe(wallet.address);
    const replacement = { ...message, issuanceOwnerCommitment: ownerCommitment(issuanceRecipient, issuanceSecret + 1n) };
    expect(recoverAddress(paymentSigningHash(replacement), signature)).not.toBe(wallet.address);
    expect(() => authorizationIssuanceOpening(issuanceOwnerCommitment, chainId, nullifiers, { recipientAddress: issuanceRecipient, noteSecret: issuanceSecret + 1n, transactionContext: message.transactionContext })).toThrow(/opening/);
  });
  it("binds action context and issuance route to the same authorization", () => {
    const signature = signDigest(wallet.privKey, paymentSigningHash(message));
    for (const changed of [
      { ...message, transactionContext: payoutTransactionContext(chainId, [11n, 12n, 13n, 15n]) },
      { ...message, issuanceOwnerCommitment: issuanceOwnerCommitment + 1n },
    ]) expect(recoverAddress(paymentSigningHash(changed), signature)).not.toBe(wallet.address);
    expect(authorizationIssuanceOpening(issuanceOwnerCommitment, chainId, nullifiers, { recipientAddress: issuanceRecipient, noteSecret: issuanceSecret, transactionContext: message.transactionContext }).issuanceNoteSecret).toBe(issuanceSecret);
  });
  it("binds the asset secret commitment of a readable asset creation", () => {
    const creation: AssetCreationMessage = { ...message, assetId: 1n, metadataCommitment: 3n, initialSupply: 100n, assetSecretCommitment: 4n, outputs: [{ recipient: 0xdefn, amount: 100n, assetId: 1n }, ...Array.from({length:4}, () => ({recipient:0n,amount:0n,assetId:0n}))] };
    const signature = signDigest(wallet.privKey, assetCreationSigningHash(creation));
    expect(recoverAddress(assetCreationSigningHash({...creation, assetSecretCommitment:5n}), signature)).not.toBe(wallet.address);
  });
});
