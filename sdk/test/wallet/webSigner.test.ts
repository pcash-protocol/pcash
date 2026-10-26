import { describe, expect, it } from "vitest";
import { createWalletClient, custom, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPcashAuthorizationRequest,
  DEFAULT_NETWORK_CONFIG,
  paymentTypedData,
  requestPcashAuthorization,
} from "@pcash/sdk/browser";
import { viemPcashActionSigner } from "../../src/wallet/web/signer.ts";

const ACCOUNT = privateKeyToAccount(`0x${"01".repeat(32)}`);
const OTHER_ACCOUNT = `0x${"22".repeat(20)}` as Address;
const TO = `0x${"33".repeat(20)}` as Address;

function mutableTransport() {
  let chainId = 11_155_111n;
  let selected: Address | null = ACCOUNT.address;
  const typedData: Array<{ account: unknown; payload: Record<string, unknown> }> = [];
  const transport = custom({
    async request({ method, params }) {
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      if (method === "eth_accounts") return selected === null ? [] : [selected];
      if (method === "eth_signTypedData_v4") {
        const [account, json] = params as readonly unknown[];
        const payload = JSON.parse(String(json)) as Record<string, unknown>;
        typedData.push({ account, payload });
        return ACCOUNT.signTypedData(payload as never);
      }
      throw new Error(`unexpected provider method ${method}`);
    },
  });
  return {
    client: createWalletClient({ transport }),
    typedData,
    setChainId(value: bigint) {
      chainId = value;
    },
    setSelected(value: Address | null) {
      selected = value;
    },
  };
}

describe("viem PCASH action signer", () => {
  it("signs typed data that verifies against the protocol digest", async () => {
    const wallet = mutableTransport();
    const signer = viemPcashActionSigner(wallet.client, ACCOUNT.address);
    const authorizingAddress = BigInt(ACCOUNT.address);
    const message = {
      pcashChainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
      recipient: BigInt(TO),
      amount: 7n,
      openFeeAmount: 1n,
      issuanceRecipient: 0n,
      issuanceOwnerCommitment: 0n,
      relayFeeAmount: 0n,
      relayFeeOwnerCommitment: 0n,
  accountCreationCommitment: 0n,
      transactionContext: 19n,
      notBefore: 0n,
      validUntil: 9n,
    };
    const request = createPcashAuthorizationRequest({
      kind: "payment",
      authorizingAddress,
      typedData: paymentTypedData(DEFAULT_NETWORK_CONFIG, message),
    });

    await expect(requestPcashAuthorization(signer, request)).resolves.toMatchObject({
      address: authorizingAddress,
    });
    expect(wallet.typedData).toHaveLength(1);
    const payload = wallet.typedData[0]!.payload;
    expect(payload.primaryType).toBe("PcashPayment");
    expect(Object.keys(payload.message as Record<string, unknown>)).toEqual([
      "pcashChainId",
      "recipient",
      "amount",
      "openFeeAmount",
      "issuanceRecipient",
      "issuanceOwnerCommitment",
      "relayFeeAmount",
      "relayFeeOwnerCommitment",
      "accountCreationCommitment",
      "transactionContext",
      "notBefore",
      "validUntil",
    ]);
  });

  it("fails before prompting when the account, chain, or authorizing address changed", async () => {
    const wallet = mutableTransport();
    const signer = viemPcashActionSigner(wallet.client, ACCOUNT.address);
    const request = createPcashAuthorizationRequest({
      kind: "fixture",
      authorizingAddress: BigInt(ACCOUNT.address),
      typedData: {
        domain: { name: "PCASH", version: "1", chainId: 11_155_111n, verifyingContract: TO },
        types: { PcashAction: [{ name: "value", type: "uint256" }] },
        primaryType: "PcashAction",
        message: { value: "7" },
      },
    });

    wallet.setSelected(OTHER_ACCOUNT);
    await expect(signer.signTypedData(request)).rejects.toThrow(/changed account/);
    wallet.setSelected(ACCOUNT.address);
    wallet.setChainId(1n);
    await expect(signer.signTypedData(request)).rejects.toThrow(/changed to chain/);
    await expect(signer.signTypedData({
      ...request,
      authorizingAddress: BigInt(OTHER_ACCOUNT),
    })).rejects.toThrow(/does not match/);
    expect(wallet.typedData).toHaveLength(0);
  });
});
