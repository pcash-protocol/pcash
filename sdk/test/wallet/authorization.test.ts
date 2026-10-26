import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import {
  createPcashAuthorizationRequest,
  privateKeyPcashActionSigner,
  requestPcashAuthorization,
  verifyPcashAuthorization,
} from "@pcash/sdk/eip712";
import {
  type PcashTypedData,
  accountCreationTypedData,
  accountUpdateTypedData,
  pcashSigningHash,
  serializeEcdsaSignature,
  signDigest,
} from "@pcash/sdk/eip712";
import { DEFAULT_NETWORK_CONFIG, resolveNetworkConfig } from "@pcash/sdk/protocol";
import { paymentTypedData } from "@pcash/sdk/rules";
import { deriveWalletIdentity } from "@pcash/sdk/eip712";

const NETWORK = resolveNetworkConfig(DEFAULT_NETWORK_CONFIG);
const PRIV = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const WALLET = deriveWalletIdentity(PRIV);
const PAYMENT = {
  pcashChainId: NETWORK.pcashChainId,
  recipient: 0x2222222222222222222222222222222222222222n,
  amount: 11n,
  openFeeAmount: 13n,
  issuanceRecipient: 0n,
  issuanceOwnerCommitment: 0n,
  relayFeeAmount: 0n,
  relayFeeOwnerCommitment: 0n,
  accountCreationCommitment: 0n, transactionContext: 19n,
  notBefore: 14n,
  validUntil: 15n,
};
const paymentOf = (amount: bigint) => paymentTypedData(NETWORK, { ...PAYMENT, amount });

const hex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

/** The digest a wallet computes from the payload a viem signer forwards (no EIP712Domain type). */
function walletDigest(typedData: PcashTypedData): string {
  return hashTypedData({
    domain: typedData.domain as never,
    types: { [typedData.primaryType]: typedData.types[typedData.primaryType] } as never,
    primaryType: typedData.primaryType as never,
    message: typedData.message as never,
  } as never);
}

describe("canonical PCASH authorization", () => {
  it("emits typed data whose wallet digest is the signing hash", () => {
    const expectWalletDigest = (typedData: PcashTypedData) =>
      expect(walletDigest(typedData)).toBe(hex(pcashSigningHash(typedData)));
    const account = {
      pcashChainId: NETWORK.pcashChainId,
      account: WALLET.address,
      nullifierKeyCommitment: 8n,
      ruleSetCommitment: 9n,
      receiveKeyHash: BigInt(`0x${"0a".repeat(32)}`),
      recentPcashBlockHash: 11n,
      validUntilTimestamp: 12n,
    };
    expectWalletDigest(accountCreationTypedData(NETWORK, account));

    const accountUpdate = {
      pcashChainId: NETWORK.pcashChainId,
      account: WALLET.address,
      currentAccountRevision: 1n,
      nullifierKeyCommitment: 8n,
      currentRuleSetCommitment: 9n,
      currentReceiveKeyHash: BigInt(`0x${"0a".repeat(32)}`),
      newAccountRevision: 2n,
      newRuleSetCommitment: 13n,
      newReceiveKeyHash: 0n,
      openFeeAmount: 15n,
      relayFeeAmount: 0n,
      relayFeeOwnerCommitment: 0n,
      accountCreationCommitment: 0n, transactionContext: 19n,
      notBefore: 0n,
      validUntil: 14n,
    };
    expectWalletDigest(accountUpdateTypedData(NETWORK, accountUpdate));
    expect(pcashSigningHash(accountUpdateTypedData(NETWORK, {
      ...accountUpdate,
      newRuleSetCommitment: accountUpdate.newRuleSetCommitment + 1n,
    }))).not.toEqual(pcashSigningHash(accountUpdateTypedData(NETWORK, accountUpdate)));

    expectWalletDigest(paymentTypedData(NETWORK, PAYMENT));
  });

  it("verifies one async signer response against the exact request and account", async () => {
    const request = createPcashAuthorizationRequest({
      kind: "fixture",
      authorizingAddress: WALLET.address,
      typedData: paymentOf(321n),
    });
    const verified = await requestPcashAuthorization(
      privateKeyPcashActionSigner(PRIV),
      request,
    );
    expect(verified.address).toBe(WALLET.address);
    expect(verified.pubX).toEqual(WALLET.pubX);
    expect(verified.pubY).toEqual(WALLET.pubY);
  });

  it("rejects the wrong selected signer and a signature over another digest", async () => {
    const request = createPcashAuthorizationRequest({
      kind: "fixture",
      authorizingAddress: WALLET.address,
      typedData: paymentOf(1n),
    });
    const otherKey = Uint8Array.from({ length: 32 }, (_, i) => i + 34);
    await expect(requestPcashAuthorization(privateKeyPcashActionSigner(otherKey), request)).rejects
      .toThrow("does not match");

    const wrongSignature = serializeEcdsaSignature(signDigest(
      PRIV,
      pcashSigningHash(paymentOf(2n)),
    ));
    expect(() => verifyPcashAuthorization(request, wrongSignature)).toThrow("expected");
  });
});
