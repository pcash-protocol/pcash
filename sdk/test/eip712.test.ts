// Protocol-defined EIP-712 signing: the pinned type strings are the ones the
// circuits are compiled against, and the SDK's secp256k1 sign/recover must
// round-trip.

import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  accountCreationTypedData,
  accountUpdateTypedData,
  keyDerivationTypedData,
  pcashSigningHash,
  recoverAddress,
  signDigest,
  type AccountUpdateMessage,
} from "../src/eip712/eip712.ts";
import {
  DOMAIN_TYPE,
  USER_ACCOUNT_CREATION_TYPE,
  USER_ACCOUNT_UPDATE_TYPE,
} from "../src/constants/networkProfile.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const wallet = deriveTestWallet();

describe("EIP-712 types match the compiled circuit constants", () => {
  it("domain (signature/src/eip712.nr)", () => {
    expect(hex(keccak_256(new TextEncoder().encode(DOMAIN_TYPE)))).toBe(
      "8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
    );
  });

  it("account creation and update use the pinned type strings", () => {
    expect(USER_ACCOUNT_CREATION_TYPE).toBe(
      "PcashUserAccountCreation(uint256 pcashChainId,uint256 nullifierKeyCommitment,uint256 ruleSetCommitment,bytes32 receiveKeyHash,bytes32 recentPcashBlockHash,uint256 validUntilTimestamp)",
    );
    expect(USER_ACCOUNT_UPDATE_TYPE).toBe(
      "PcashUserAccountUpdate(uint256 pcashChainId,address account,uint256 currentAccountRevision,uint256 nullifierKeyCommitment,uint256 currentRuleSetCommitment,bytes32 currentReceiveKeyHash,uint256 newRuleSetCommitment,bytes32 newReceiveKeyHash,uint256 openFeeAmount,uint256 relayFeeAmount,uint256 relayFeeOwnerCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil)",
    );
  });

  it("recovers the signer of a raw digest", () => {
    const digest = keccak_256(new Uint8Array([1, 2, 3, 4, 5]));
    const sig = signDigest(wallet.privKey, digest);
    expect([0, 1]).toContain(sig.yParity);
    expect(recoverAddress(digest, sig)).toBe(wallet.address);
    expect(recoverAddress(digest, { r: sig.r, s: sig.s, yParity: sig.yParity })).toBe(
      wallet.address,
    );
  });

});

describe("account-update action signing", () => {
  it("binds every displayed current and proposed field", () => {
    const wallet = deriveTestWallet();
    const message = {
      pcashChainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
      account: wallet.address,
      currentAccountRevision: 1n,
      nullifierKeyCommitment: 2n,
      currentRuleSetCommitment: 3n,
      currentReceiveKeyHash: BigInt(`0x${"04".repeat(32)}`),
      newRuleSetCommitment: 5n,
      newReceiveKeyHash: BigInt(`0x${"06".repeat(32)}`),
      openFeeAmount: 8n,
      relayFeeAmount: 9n,
      relayFeeOwnerCommitment: 19n,
      transactionContext: 20n,
      notBefore: 21n,
      validUntil: 22n,
    };
    const digestOf = (m: AccountUpdateMessage) => hex(pcashSigningHash(accountUpdateTypedData(
      m.pcashChainId === DEFAULT_NETWORK_CONFIG.pcashChainId
        ? DEFAULT_NETWORK_CONFIG
        : { ...DEFAULT_NETWORK_CONFIG, pcashChainId: m.pcashChainId },
      m,
    )));
    const digest = digestOf(message);
    const mutations = [
      { ...message, pcashChainId: message.pcashChainId + 1n },
      { ...message, account: message.account + 1n },
      { ...message, currentAccountRevision: message.currentAccountRevision + 1n },
      { ...message, nullifierKeyCommitment: message.nullifierKeyCommitment + 1n },
      { ...message, currentRuleSetCommitment: message.currentRuleSetCommitment + 1n },
      { ...message, currentReceiveKeyHash: 0n },
      { ...message, currentReceiveKeyHash: BigInt(`0x${"08".repeat(32)}`) },
      { ...message, newRuleSetCommitment: message.newRuleSetCommitment + 1n },
      { ...message, newReceiveKeyHash: 0n },
      { ...message, newReceiveKeyHash: BigInt(`0x${"09".repeat(32)}`) },
      { ...message, openFeeAmount: message.openFeeAmount + 1n },
      { ...message, relayFeeAmount: message.relayFeeAmount + 1n },
      { ...message, relayFeeOwnerCommitment: message.relayFeeOwnerCommitment + 1n },
    ];
    for (const mutation of mutations) {
      expect(digestOf(mutation)).not.toBe(digest);
    }
  });
});

describe("typed data rejects values outside their declared types", () => {
  it("rejects an account outside uint160 in key derivation", () => {
    expect(() => keyDerivationTypedData(DEFAULT_NETWORK_CONFIG, 2n << 160n, "context"))
      .toThrow(/account must fit in 160 bits/);
  });

  it("carries no account in account creation: the signer is the account", () => {
    const typedData = accountCreationTypedData(DEFAULT_NETWORK_CONFIG, {
      pcashChainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
      nullifierKeyCommitment: 1n,
      ruleSetCommitment: 2n,
      receiveKeyHash: 0n,
      recentPcashBlockHash: 3n,
      validUntilTimestamp: 4n,
    });
    expect(typedData.types.PcashUserAccountCreation!.map(({ name }) => name)).not.toContain("account");
    expect(typedData.message).not.toHaveProperty("account");
  });

  it("rejects commitment fields at or above the field modulus", () => {
    const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(() => accountCreationTypedData(DEFAULT_NETWORK_CONFIG, {
      pcashChainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
      nullifierKeyCommitment: p,
      ruleSetCommitment: 2n,
      receiveKeyHash: 0n,
      recentPcashBlockHash: 3n,
      validUntilTimestamp: 4n,
    })).toThrow(/nullifierKeyCommitment/);
    expect(() => accountCreationTypedData(DEFAULT_NETWORK_CONFIG, {
      pcashChainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
      nullifierKeyCommitment: 1n,
      ruleSetCommitment: p,
      receiveKeyHash: 0n,
      recentPcashBlockHash: 3n,
      validUntilTimestamp: 4n,
    })).toThrow(/ruleSetCommitment/);
  });
});
describe("EIP-712 domain schema isolation", () => {
  it("does not share the array between returned typed-data payloads", () => {
    const message = {
      pcashChainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
      nullifierKeyCommitment: 2n,
      ruleSetCommitment: 3n,
      receiveKeyHash: BigInt(`0x${"04".repeat(32)}`),
      recentPcashBlockHash: 5n,
      validUntilTimestamp: 99n,
    };
    const first = accountCreationTypedData(DEFAULT_NETWORK_CONFIG, message);
    const second = accountCreationTypedData(DEFAULT_NETWORK_CONFIG, message);
    expect(first.types.EIP712Domain).not.toBe(second.types.EIP712Domain);
    first.types.EIP712Domain![0]!.name = "tampered";
    expect(second.types.EIP712Domain![0]!.name).toBe("name");
  });
});
