import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { domainSeparator, type TypedDataDomain } from "viem";
import { utf8 } from "../src/utils/bytes.ts";
import { keccak256 } from "../src/utils/keccak.ts";
import {
  pcashSigningHash,
  pcashTypedData,
  pcashTypedDataDomain,
} from "../src/eip712/eip712.ts";
import { DOMAIN_TYPE } from "../src/constants/networkProfile.ts";
import {
  ecdsaRuleConfigurationCommitment,
  multisigRuleConfigurationCommitment,
  referenceDomainSeparatorHalves,
} from "../src/rules/referenceRules.ts";
import { referenceConfigurationCommitment } from "../src/rules/referenceRules.ts";
import { REFERENCE_ASSET_CONFIGURATION_DOMAIN, REFERENCE_CONFIGURATION_DOMAIN } from "../src/constants/referenceRuleConstants.ts";
import { DEFAULT_NETWORK_CONFIG, resolveNetworkConfig } from "../src/protocol/network.ts";
import { poseidon } from "../src/crypto/poseidon2.ts";
import {
  assetCovenantSuccessorConfigurationCommitment,
} from "../src/protocol/asset.ts";
import {
  PAYMENT_EIP712_TYPE,
  TRANSACTION_DETAIL_EIP712_TYPE,
  paymentTypedData,
} from "../src/rules/readableRules.ts";

const V = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../vectors/reference_ecdsa_rule_vectors.json", import.meta.url)),
    "utf8",
  ),
);
const RULE_V = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../vectors/reference_rule_vectors.json", import.meta.url)),
    "utf8",
  ),
);
const bytesHex = (value: Uint8Array): string =>
  `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
const typeHash = (type: string): string => bytesHex(keccak256(utf8(type)));
/** Field names of a flat EIP-712 type string, in order. */
const typeFieldNames = (type: string): string[] =>
  /\((.*)\)$/.exec(type)![1]!.split(",").map((entry) => entry.split(" ")[1]!);

describe("reference ECDSA rule vectors", () => {
  it("matches every reference configuration commitment", () => {
    const vector = RULE_V.configurationCommitments;
    const salt = BigInt(vector.salt);
    expect(referenceConfigurationCommitment(salt, vector.generic.fields.map(BigInt))).toBe(
      BigInt(vector.generic.value),
    );
    const network = {
      ...DEFAULT_NETWORK_CONFIG,
      l1ChainId: BigInt(vector.ecdsa.l1ChainId),
      inboxAddress: BigInt(vector.ecdsa.inboxAddress),
    };
    const separator = BigInt(vector.ecdsa.domainSeparator);
    expect(referenceDomainSeparatorHalves(network)).toEqual({
      high: BigInt(vector.ecdsa.domainSeparatorHigh128),
      low: BigInt(vector.ecdsa.domainSeparatorLow128),
    });
    expect((BigInt(vector.ecdsa.domainSeparatorHigh128) << 128n) | BigInt(vector.ecdsa.domainSeparatorLow128))
      .toBe(separator);
    expect(ecdsaRuleConfigurationCommitment(network, BigInt(vector.ecdsa.nullifierKeyCommitment)))
      .toBe(BigInt(vector.ecdsa.value));
    expect(Object.keys(vector.multisig).sort()).toEqual(["signerAddresses", "threshold", "value"]);
    expect(multisigRuleConfigurationCommitment(
      salt,
      BigInt(vector.multisig.threshold),
      vector.multisig.signerAddresses.map(BigInt),
    )).toBe(BigInt(vector.multisig.value));
    const covenantVector = vector.assetCovenantSuccessor;
    const covenant = covenantVector.fields.map(BigInt);
    expect(assetCovenantSuccessorConfigurationCommitment({
      maxNativeOpenFeeAmount: covenant[0],
      successorAddress: covenant[1],
      successorNullifierKeyCommitment: covenant[2],
      successorRuleSetCommitment: covenant[3],
      successorAccountRevision: covenant[4],
      successorReceiveKeyHash: covenant[5],
    })).toBe(BigInt(covenantVector.value));
  });

  it("commits zero asset covenant successor fields like any other value", () => {
    expect(assetCovenantSuccessorConfigurationCommitment({
      maxNativeOpenFeeAmount: 0n,
      successorAddress: 0n,
      successorNullifierKeyCommitment: 0n,
      successorRuleSetCommitment: 0n,
      successorAccountRevision: 0n,
      successorReceiveKeyHash: 0n,
    })).toBe(poseidon([REFERENCE_ASSET_CONFIGURATION_DOMAIN, 3n, 0n, 0n, 0n, 0n, 0n, 0n]));
  });

  it("matches the ECDSA configuration commitment", () => {
    const vector = V.configurationCommitment;
    expect(REFERENCE_CONFIGURATION_DOMAIN).toBe(
      BigInt(vector.domain),
    );
    const value = poseidon([
      REFERENCE_CONFIGURATION_DOMAIN,
      BigInt(vector.domainSeparatorHigh128),
      BigInt(vector.domainSeparatorLow128),
      BigInt(vector.nullifierKeyCommitment),
    ]);
    expect(value).toBe(BigInt(vector.value));
    expect(ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, BigInt(vector.nullifierKeyCommitment)))
      .toBe(value);
  });

  it("matches the EIP-712 domain the rules sign under", () => {
    const vector = V.eip712.domain;
    expect(typeHash(DOMAIN_TYPE)).toBe(vector.typeHash);
    expect(typeHash("PCASH")).toBe(vector.nameHash);
    expect(typeHash("1")).toBe(vector.versionHash);
    const domain = pcashTypedDataDomain(resolveNetworkConfig({
      ...DEFAULT_NETWORK_CONFIG,
      l1ChainId: BigInt(vector.l1ChainId),
      inboxAddress: BigInt(vector.verifyingContract),
    }));
    expect(domainSeparator({ domain: domain as TypedDataDomain })).toBe(vector.separator);
  });
});

describe("readable rule vectors", () => {
  it("pins the payment rule type, struct hash, and signing hash", () => {
    const vector = V.readableRules.payment;
    expect(PAYMENT_EIP712_TYPE).toBe(vector.type);
    expect(typeHash(PAYMENT_EIP712_TYPE)).toBe(vector.typeHash);
    const fields = vector.fields.map(BigInt) as bigint[];
    expect(fields[5]).not.toBe(0n);
    const message = {
      pcashChainId: fields[0]!,
      recipient: fields[1]!,
      amount: fields[2]!,
      openFeeAmount: fields[3]!,
      issuanceRecipient: fields[4]!,
      issuanceOwnerCommitment: fields[5]!,
      relayFeeAmount: fields[6]!,
      relayFeeOwnerCommitment: fields[7]!,
  accountCreationCommitment: fields[8]!,
      transactionContext: fields[9]!,
      notBefore: fields[10]!,
      validUntil: fields[11]!,
    };
    const network = { ...DEFAULT_NETWORK_CONFIG, pcashChainId: message.pcashChainId };
    expect(bytesHex(pcashSigningHash(paymentTypedData(network, message)))).toBe(vector.signingHash);
  });

  it("pins the full-transaction rule type and signing hash", () => {
    const vector = V.readableRules.transactionDetail;
    expect(TRANSACTION_DETAIL_EIP712_TYPE).toBe(vector.type);
    expect(typeHash(TRANSACTION_DETAIL_EIP712_TYPE)).toBe(vector.typeHash);
    const fields = vector.fields.map(BigInt) as bigint[];
    const names = typeFieldNames(TRANSACTION_DETAIL_EIP712_TYPE);
    expect(names).toHaveLength(fields.length);
    const typedData = pcashTypedData(
      { ...DEFAULT_NETWORK_CONFIG, pcashChainId: fields[0]! },
      TRANSACTION_DETAIL_EIP712_TYPE,
      Object.fromEntries(names.map((name, index) => [name, fields[index]!])),
    );
    expect(bytesHex(pcashSigningHash(typedData))).toBe(vector.signingHash);
  });
});
