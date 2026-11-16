// Every SDK typed-data payload must spell exactly its pinned type string — the
// string whose keccak the circuits compile in — under the PCASH domain of the
// network it was built for, and must encode boundary values that viem accepts.
// The digests themselves are pinned by the independent vectors in
// referenceRuleVectors.test.ts and by the proving tests.

import { describe, expect, it } from "vitest";
import {
  accountCreationTypedData,
  accountUpdateTypedData,
  KEY_DERIVATION_TYPE,
  keyDerivationTypedData,
  pcashSigningHash,
  type PcashTypedData,
} from "../src/eip712/eip712.ts";
import { selectedRelayQuoteTypedData, SELECTED_RELAY_QUOTE_TYPE } from "../src/eip712/selectedRelayQuote.ts";
import {
  assetBurnTypedData,
  assetCreationEip712Type,
  assetCreationTypedData,
  assetPaymentTypedData,
  ASSET_BURN_EIP712_TYPE,
  ASSET_PAYMENT_EIP712_TYPE,
  batchTransferEip712Type,
  batchTransferTypedData,
  CONTRACT_FEE_SPONSORSHIP_EIP712_TYPE,
  contractFeeSponsorshipTypedData,
  type AssetCreationMessage,
  type BatchTransferMessage,
} from "../src/rules/semanticRules.ts";
import { PAYMENT_EIP712_TYPE, paymentTypedData } from "../src/rules/readableRules.ts";
import { DOMAIN_TYPE, USER_ACCOUNT_CREATION_TYPE, USER_ACCOUNT_UPDATE_TYPE } from "../src/constants/networkProfile.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { DEFAULT_NETWORK_CONFIG, resolveNetworkConfig, type NetworkConfig } from "../src/protocol/network.ts";
import { addressHex } from "../src/utils/hex.ts";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_ADDRESS = (1n << 160n) - 1n;
const MAX_U64 = (1n << 64n) - 1n;

// A second network proves the domain (L1 chain id and inbox) follows the network.
const NETWORKS: NetworkConfig[] = [
  resolveNetworkConfig(DEFAULT_NETWORK_CONFIG),
  resolveNetworkConfig({
    ...DEFAULT_NETWORK_CONFIG,
    pcashChainId: 0xfffffffen,
    l1ChainId: 11155111n,
    inboxAddress: 0xabcdef0123456789abcdef0123456789abcdef01n,
  }),
];

/** EIP-712 encodeType of one flat struct in a payload. */
function encodeType(typedData: PcashTypedData, primaryType: string): string {
  const fields = typedData.types[primaryType]!.map((field) => `${field.type} ${field.name}`);
  return `${primaryType}(${fields.join(",")})`;
}

/** The payload spells the pinned type under the network's PCASH domain, and viem accepts it. */
function expectPinned(typedData: PcashTypedData, typeString: string, network: NetworkConfig): void {
  expect(encodeType(typedData, typedData.primaryType)).toBe(typeString);
  expect(encodeType(typedData, "EIP712Domain")).toBe(DOMAIN_TYPE);
  expect(typedData.domain).toEqual({
    name: "PCASH",
    version: "1",
    chainId: network.l1ChainId,
    verifyingContract: addressHex(network.inboxAddress),
  });
  expect(pcashSigningHash(typedData)).toHaveLength(32);
}

const SHAPES = Object.values(PRIVATE_VALUE_PROFILES).map((profile) => ({
  shape: profile.shapeId,
  outputs: profile.outputs,
}));

function outputs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    recipient: i === 0 ? MAX_ADDRESS : BigInt(0x1000 + i),
    amount: BigInt(i * 7 + 1),
    assetId: P - 1n - BigInt(i),
  }));
}

const trailing = (network: NetworkConfig) => ({
  pcashChainId: network.pcashChainId,
  openFeeAmount: (1n << 127n) + 3n,
  issuanceRecipient: 0x87c018ef78005f118c53fa9cadf0a4fd367a77a9n,
  issuanceOwnerCommitment: P - 2n,
  relayFeeAmount: 7n,
  relayFeeOwnerCommitment: P - 5n,
  accountCreationCommitment: 0n,
  transactionContext: P - 3n,
  notBefore: 1n,
  validUntil: MAX_U64,
});

describe.each(NETWORKS.map((network) => [network.pcashChainId, network] as const))(
  "EIP-712 typed-data parity on PCASH chain %s",
  (_pcashChainId, network) => {
    it("selected relay quote", () => {
      const message = {
        pcashChainId: network.pcashChainId,
        recipient: MAX_ADDRESS,
        privateFeeAmount: (1n << 128n) - 1n,
        receiveKeyHash: `0x${"11".repeat(32)}`,
        issuanceOwnerCommitment: P - 1n,
  accountCreationCommitment: 0n,
        transactionContext: 5n,
        quoteBinding: 6n,
        maxTransactionBytes: 65_536n,
        validUntilTimestamp: MAX_U64,
      };
      const typedData = selectedRelayQuoteTypedData(network, message);
      expectPinned(typedData, SELECTED_RELAY_QUOTE_TYPE, network);
    });

    it("account creation", () => {
      const message = {
        pcashChainId: network.pcashChainId,
        account: MAX_ADDRESS,
        nullifierKeyCommitment: P - 1n,
        ruleSetCommitment: 7n,
        receiveKeyHash: P - 4n,
        recentPcashBlockHash: P - 5n,
        validUntilTimestamp: MAX_U64,
      };
      const typedData = accountCreationTypedData(network, message);
      expectPinned(typedData, USER_ACCOUNT_CREATION_TYPE, network);
    });

    it("account update, with receive keys present and absent", () => {
      const base = {
        pcashChainId: network.pcashChainId,
        account: MAX_ADDRESS,
        accountIndex: (1n << 40n) - 1n,
        currentAccountRevision: (1n << 32n) - 1n,
        nullifierKeyCommitment: P - 1n,
        currentRuleSetCommitment: 3n,
        currentReceiveKeyHash: BigInt(`0x${"04".repeat(32)}`),
        newRuleSetCommitment: 5n,
        newReceiveKeyHash: BigInt(`0x${"06".repeat(32)}`),
        openFeeAmount: (1n << 128n) - 1n,
        issuanceRecipient: 9n,
        issuanceOwnerCommitment: P - 2n,
        relayFeeAmount: 7n,
        relayFeeOwnerCommitment: P - 5n,
  accountCreationCommitment: 0n,
        transactionContext: 20n,
        notBefore: 0n,
        validUntil: MAX_U64,
      };
      for (const message of [
        base,
        { ...base, currentReceiveKeyHash: 0n },
        { ...base, newReceiveKeyHash: 0n },
      ]) {
        const typedData = accountUpdateTypedData(network, message);
        expectPinned(typedData, USER_ACCOUNT_UPDATE_TYPE, network);
      }
    });

    it("payment", () => {
      const message = { ...trailing(network), recipient: MAX_ADDRESS, amount: P - 1n };
      const typedData = paymentTypedData(network, message);
      expectPinned(typedData, PAYMENT_EIP712_TYPE, network);
    });

    it("asset payment", () => {
      const message = { ...trailing(network), assetId: P - 1n, recipient: MAX_ADDRESS, amount: 100n };
      const typedData = assetPaymentTypedData(network, message);
      expectPinned(typedData, ASSET_PAYMENT_EIP712_TYPE, network);
    });

    it("asset burn", () => {
      const message = { ...trailing(network), assetId: P - 1n, burnAmount: 100n };
      const typedData = assetBurnTypedData(network, message);
      expectPinned(typedData, ASSET_BURN_EIP712_TYPE, network);
    });

    it("contract fee sponsorship", () => {
      const message = { ...trailing(network), sponsoredContract: MAX_ADDRESS };
      const typedData = contractFeeSponsorshipTypedData(network, message);
      expectPinned(typedData, CONTRACT_FEE_SPONSORSHIP_EIP712_TYPE, network);
    });

    it.each(SHAPES)("batch transfer, shape $shape", ({ shape, outputs: count }) => {
      const message: BatchTransferMessage = {
        ...trailing(network),
        assetId: P - 1n,
        assetBurnAmount: 3n,
        outputs: outputs(count),
      };
      const typedData = batchTransferTypedData(network, message, shape);
      expectPinned(typedData, batchTransferEip712Type(shape), network);
    });

    it.each(SHAPES)("asset creation, shape $shape", ({ shape, outputs: count }) => {
      const message: AssetCreationMessage = {
        ...trailing(network),
        assetId: P - 1n,
        metadataCommitment: 3n,
        initialSupply: 100n,
        assetSecretCommitment: 4n,
        outputs: outputs(count),
      };
      const typedData = assetCreationTypedData(network, message, shape);
      expectPinned(typedData, assetCreationEip712Type(shape), network);
    });

    it("key derivation", () => {
      const typedData = keyDerivationTypedData(network, MAX_ADDRESS, "pcash.test-context ✓");
      expectPinned(typedData, KEY_DERIVATION_TYPE, network);
      expect(typedData.message.context).toBe("pcash.test-context ✓");
    });
  },
);
