import { describe, expect, it } from "vitest";
import {
  MAX_ASSET_DEFINITION_BYTES,
  MAX_RULE_CONFIGURATION_BYTES,
  assetDefinitionAssetId,
  assetDefinitionOf,
  decodeAssetDefinition,
  encodeAssetDefinition,
  findAssetDefinition,
  formatAssetDefinition,
  parseAssetDefinition,
  type AssetDefinition,
  type PortableAssetRule,
} from "../src/protocol/assetDefinition.ts";
import { deriveAssetDescriptor, fungibleMetadataCommitment } from "../src/protocol/asset.ts";
import { createAccountMintAsset } from "../src/rules/accountMint.ts";
import { createDepositMintAsset } from "../src/rules/depositMint.ts";
import { MAX_FIXED_SUPPLY, createFixedSupplyAsset, deriveFixedSupplyAsset, fixedSupplySecretCommitment } from "../src/rules/fixedSupply.ts";
import { recognizeMintRule } from "../src/rules/mintRules.ts";
import { recognizeTransferRule, senderDenyListTransferRule } from "../src/rules/transferRules.ts";

const metadata = { name: "Définition", symbol: "DEF", decimals: 18, contentDigest: new Uint8Array(32).fill(0xab) };
const created = deriveFixedSupplyAsset({ secret: 0x5678n, supply: MAX_FIXED_SUPPLY, metadata });
const definition = created.definition;

const transferRule: PortableAssetRule = {
  sVkHash: 0x5111n, lVkHash: 0x1111n, configurationCommitment: 0xc0ffeen, configuration: Uint8Array.from({ length: 52 }, (_, i) => i),
};
const accountMint = createAccountMintAsset({ metadata, accountAddress: 0xab12n, transferRule, startSalt: 0n });
const restricted = accountMint.definition;
const denyList = senderDenyListTransferRule({ contractAddress: 0xde11n, listId: new Uint8Array(32).fill(0x11), maxDelta: 3_600n });

const hex = (value: bigint, bytes: number) => value.toString(16).padStart(bytes * 2, "0");
const bytesHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const ruleHex = (rule: PortableAssetRule) => hex(rule.sVkHash, 32) + hex(rule.lVkHash, 32) + hex(rule.configurationCommitment, 32)
  + hex(BigInt(rule.configuration.length), 1) + bytesHex(rule.configuration);
const metadataHex = () => {
  const name = new TextEncoder().encode(metadata.name);
  return hex(BigInt(name.length), 1) + bytesHex(name) + "03" + bytesHex(new TextEncoder().encode("DEF")) + "12" + "ab".repeat(32);
};

describe("asset definition", () => {
  it("derives the created assetId and carries the secret's commitment, never the secret", () => {
    expect(assetDefinitionAssetId(definition)).toBe(created.descriptor.assetId);
    expect(Object.keys(definition).sort()).toEqual(["instanceSalt", "metadata", "mintRule"]);
    const fresh = createFixedSupplyAsset({ metadata, supply: 1_000n });
    const encoded = bytesHex(encodeAssetDefinition(fresh.definition));
    expect(encoded).toContain(hex(fixedSupplySecretCommitment(fresh.secret), 32));
    expect(encoded).not.toContain(hex(fresh.secret, 32));
  });

  it("derives a restricted account-mint asset's assetId from its transfer rule", () => {
    expect(assetDefinitionAssetId(restricted)).toBe(accountMint.descriptor.assetId);
    expect(restricted.transferRule).toEqual(transferRule);
  });

  it("lays out version, salt, the mint rule with its configuration, no transfer rule, then the metadata fields", () => {
    expect(bytesHex(definition.mintRule.configuration))
      .toBe(hex(MAX_FIXED_SUPPLY, 17) + hex(fixedSupplySecretCommitment(created.secret), 32));
    expect(bytesHex(encodeAssetDefinition(definition))).toBe(
      "01" + hex(definition.instanceSalt, 32) + ruleHex(definition.mintRule) + "00" + metadataHex(),
    );
  });

  it("lays out an account-mint rule and a transfer rule with their configurations", () => {
    expect(bytesHex(restricted.mintRule.configuration)).toBe(hex(0xab12n, 20));
    expect(bytesHex(encodeAssetDefinition(restricted))).toBe(
      "01" + hex(restricted.instanceSalt, 32) + ruleHex(restricted.mintRule) + "01" + ruleHex(transferRule) + metadataHex(),
    );
  });

  it("matches a frozen encoding", () => {
    const frozen = findAssetDefinition({
      mintRule: { sVkHash: 0x3131n, lVkHash: 0x3232n, configurationCommitment: 0xc0f8n, configuration: Uint8Array.of(0xaa) },
      transferRule: { sVkHash: 0x5151n, lVkHash: 0x1a1an, configurationCommitment: 0xc0f9n, configuration: Uint8Array.of(0xbb, 0xcc) },
      metadata: { name: "Frozen", symbol: "FRZ", decimals: 2, contentDigest: new Uint8Array(32).fill(0x0f) },
    }, 0n);
    const bytes = encodeAssetDefinition(frozen);
    expect(bytesHex(bytes)).toBe(FROZEN_DEFINITION_HEX);
    expect(decodeAssetDefinition(bytes)).toEqual(frozen);
  });

  it.each([
    ["fixed supply", deriveFixedSupplyAsset({ metadata, supply: 1_000n, secret: 0x77n }).definition, "fixed-supply", undefined],
    ["fixed supply with a deny list", deriveFixedSupplyAsset({ metadata, supply: 1_000n, secret: 0x77n, transferRule: denyList }).definition,
      "fixed-supply", "sender-deny-list"],
    ["account mint", createAccountMintAsset({ metadata, accountAddress: 0xab12n, startSalt: 0n }).definition, "account-mint", undefined],
    ["account mint with a deny list", createAccountMintAsset({ metadata, accountAddress: 0xab12n, transferRule: denyList, startSalt: 0n }).definition,
      "account-mint", "sender-deny-list"],
    ["deposit mint with a deny list", createDepositMintAsset({ metadata, vault: 0x5fbdb2315678afecb367f032d93f642f64180aa3n, transferRule: denyList,
      startSalt: 0n }).definition, "deposit-mint", "sender-deny-list"],
    ["maximal fixed supply", definition, "fixed-supply", undefined],
    ["account mint with a custom transfer rule", restricted, "account-mint", "custom"],
  ] as const)("round-trips %s through the canonical encoding and the share text", (_name, shared: AssetDefinition, mintKind, transferKind) => {
    const bytes = encodeAssetDefinition(shared);
    expect(bytes[0]).toBe(1);
    const decoded = decodeAssetDefinition(bytes);
    expect(decoded).toEqual(shared);
    expect(parseAssetDefinition(formatAssetDefinition(shared))).toEqual(shared);
    expect(parseAssetDefinition(` https://pcash.example/token/0x01#d=${formatAssetDefinition(shared)} `)).toEqual(shared);
    expect(recognizeMintRule(decoded.mintRule).kind).toBe(mintKind);
    expect(decoded.transferRule === undefined ? undefined : recognizeTransferRule(decoded.transferRule).kind).toBe(transferKind);
  });

  it("fits the maximal definition in MAX_ASSET_DEFINITION_BYTES", () => {
    const maximalRule = (sVkHash: bigint): PortableAssetRule => ({
      sVkHash, lVkHash: sVkHash + 1n, configurationCommitment: 0xc0n, configuration: new Uint8Array(MAX_RULE_CONFIGURATION_BYTES).fill(0xee),
    });
    const maximal = findAssetDefinition({
      mintRule: maximalRule(0x31n),
      transferRule: maximalRule(0x51n),
      metadata: { name: "n".repeat(64), symbol: "S".repeat(12), decimals: 0, contentDigest: new Uint8Array(32) },
    }, 0n);
    expect(MAX_ASSET_DEFINITION_BYTES).toBe(467);
    expect(encodeAssetDefinition(maximal).length).toBe(MAX_ASSET_DEFINITION_BYTES);
    expect(decodeAssetDefinition(encodeAssetDefinition(maximal))).toEqual(maximal);
  });

  it("refuses to encode a definition outside the metadata profile or the configuration bound", () => {
    const oversized = new Uint8Array(MAX_RULE_CONFIGURATION_BYTES + 1);
    expect(() => encodeAssetDefinition({ ...definition, metadata: { ...definition.metadata, decimals: 19 } })).toThrow(/decimals/);
    expect(() => encodeAssetDefinition({ ...definition, mintRule: { ...definition.mintRule, configuration: oversized } }))
      .toThrow(/mint rule configuration exceeds 64 bytes/);
    expect(() => encodeAssetDefinition({ ...restricted, transferRule: { ...transferRule, configuration: oversized } }))
      .toThrow(/transfer rule configuration exceeds 64 bytes/);
    expect(() => findAssetDefinition({ mintRule: { ...definition.mintRule, configuration: oversized }, metadata }, 0n))
      .toThrow(/mint rule configuration exceeds/);
  });

  it("builds a descriptor's definition from its metadata and rule configurations", () => {
    expect(assetDefinitionOf(created.descriptor, metadata, { mintRule: definition.mintRule.configuration })).toEqual(definition);
    expect(assetDefinitionOf(accountMint.descriptor, metadata, {
      mintRule: restricted.mintRule.configuration, transferRule: transferRule.configuration,
    })).toEqual(restricted);
  });

  it("refuses a definition whose metadata or transfer rule configuration the descriptor does not match", () => {
    const mintRule = definition.mintRule.configuration;
    // Other metadata whose commitment keeps the asset ID in its class, so only the ID comparison rejects it.
    const other = ["OTHER0", "OTHER1", "OTHER2", "OTHER3", "OTHER4", "OTHER5", "OTHER6", "OTHER7"]
      .map((symbol) => ({ ...metadata, symbol }))
      .find((candidate) => {
        try {
          deriveAssetDescriptor({ ...created.descriptor, metadataCommitment: fungibleMetadataCommitment(candidate) });
          return true;
        } catch {
          return false;
        }
      })!;
    expect(() => assetDefinitionOf(created.descriptor, other, { mintRule })).toThrow(/metadata does not match/);
    expect(() => assetDefinitionOf(accountMint.descriptor, metadata, { mintRule: restricted.mintRule.configuration }))
      .toThrow(/transfer rule configuration/);
    expect(() => assetDefinitionOf(created.descriptor, metadata, { mintRule, transferRule: transferRule.configuration }))
      .toThrow(/transfer rule configuration/);
  });

  it("round-trips a zero-supply definition", () => {
    const empty = deriveFixedSupplyAsset({ secret: 0x5678n, supply: 0n, metadata }).definition;
    expect(decodeAssetDefinition(encodeAssetDefinition(empty))).toEqual(empty);
  });

  const valid = () => encodeAssetDefinition(definition);
  const mintRuleOffset = 1 + 32;
  const configurationLengthOffset = mintRuleOffset + 96;
  const transferRuleOffset = configurationLengthOffset + 1 + definition.mintRule.configuration.length;
  const nameOffset = transferRuleOffset + 1;
  // About two thirds of salts put an unrestricted asset's ID outside its class.
  const outOfClassSalt = (() => {
    for (let salt = 0n; ; salt += 1n) {
      try {
        deriveAssetDescriptor({ instanceSalt: salt, metadataCommitment: fungibleMetadataCommitment(metadata), mintRule: definition.mintRule });
      } catch {
        return salt;
      }
    }
  })();
  /** The encoding with the mint rule's configuration replaced by `length` bytes. */
  const withConfigurationLength = (b: Uint8Array, length: number) => Uint8Array.from([
    ...b.subarray(0, configurationLengthOffset), length, ...new Uint8Array(length), ...b.subarray(transferRuleOffset),
  ]);
  it.each([
    ["an unknown version", (b: Uint8Array) => { b[0] = 2; return b; }, /version/],
    ["an instance salt outside the field", (b: Uint8Array) => { b.set(new Uint8Array(32).fill(0xff), 1); return b; }, /instanceSalt/],
    ["an instance salt outside the asset's class", (b: Uint8Array) => { b.set(Buffer.from(hex(outOfClassSalt, 32), "hex"), 1); return b; }, /instance salt/],
    ["a mint rule VK hash outside the field", (b: Uint8Array) => { b.set(new Uint8Array(32).fill(0xff), mintRuleOffset); return b; }, /mint rule sVkHash/],
    ["a mint rule configuration commitment outside the field",
      (b: Uint8Array) => { b.set(new Uint8Array(32).fill(0xff), mintRuleOffset + 64); return b; }, /mint rule configurationCommitment/],
    ["a mint rule configuration running past the end", (b: Uint8Array) => { b[configurationLengthOffset] = 0xff; return b; }, /truncated/],
    ["a mint rule configuration over 64 bytes", (b: Uint8Array) => withConfigurationLength(b, MAX_RULE_CONFIGURATION_BYTES + 1),
      /mint rule configuration exceeds/],
    ["an unknown transfer rule tag", (b: Uint8Array) => { b[transferRuleOffset] = 2; return b; }, /transfer rule tag/],
    ["a truncated encoding", (b: Uint8Array) => b.subarray(0, b.length - 1), /truncated/],
    ["trailing bytes", (b: Uint8Array) => Uint8Array.from([...b, 0]), /trailing/],
    ["invalid UTF-8 in the name", (b: Uint8Array) => { b[nameOffset + 1] = 0xff; return b; }, /./],
    ["an empty name", (b: Uint8Array) => Uint8Array.from([...b.subarray(0, nameOffset), 0, ...b.subarray(nameOffset + 1 + b[nameOffset]!)]), /name/],
  ])("rejects %s", (_name, corrupt, pattern) => {
    expect(() => decodeAssetDefinition(corrupt(valid()))).toThrow(pattern);
  });

  it("accepts a mint rule configuration of any length up to the bound", () => {
    for (const length of [0, MAX_RULE_CONFIGURATION_BYTES]) {
      const decoded = decodeAssetDefinition(withConfigurationLength(valid(), length));
      expect(decoded.mintRule.configuration).toEqual(new Uint8Array(length));
      // The asset ID commits to the configuration commitment, not to the opening.
      expect(assetDefinitionAssetId(decoded)).toBe(created.descriptor.assetId);
      expect(recognizeMintRule(decoded.mintRule).kind).toBe("custom");
    }
  });

  it("rejects a non-NFC name that would re-encode differently", () => {
    const decomposed = "De\u0301finition";
    const bytes = encodeAssetDefinition(definition);
    const name = new TextEncoder().encode(decomposed);
    const tampered = Uint8Array.from([
      ...bytes.subarray(0, nameOffset), name.length, ...name, ...bytes.subarray(nameOffset + 1 + bytes[nameOffset]!),
    ]);
    expect(() => decodeAssetDefinition(tampered)).toThrow(/NFC/);
  });

  it("rejects a share link without a definition", () => {
    expect(() => parseAssetDefinition("https://pcash.example/token/0x01#x=1")).toThrow(/d=/);
  });
});

/** Explicit rule keys, so the bytes do not depend on release pins. */
const FROZEN_DEFINITION_HEX = "01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031310000000000000000000000000000000000000000000000000000000000003232000000000000000000000000000000000000000000000000000000000000c0f801aa0100000000000000000000000000000000000000000000000000000000000051510000000000000000000000000000000000000000000000000000000000001a1a000000000000000000000000000000000000000000000000000000000000c0f902bbcc0646726f7a656e0346525a020f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
