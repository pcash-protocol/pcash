import { describe, expect, it } from "vitest";
import {
  MAX_ASSET_DEFINITION_BYTES,
  assetDefinitionAssetId,
  assetDefinitionFromCreated,
  decodeAssetDefinition,
  encodeAssetDefinition,
  formatAssetDefinition,
  parseAssetDefinition,
  type AssetDefinition,
} from "../src/protocol/assetDefinition.ts";
import { deriveStandardFungibleAssetFromEntropy } from "../src/protocol/asset.ts";

const created = deriveStandardFungibleAssetFromEntropy({
  assetSecret: 0x5678n,
  initialSupply: 5n * ((1n << 128n) - 1n),
  metadata: { name: "Définition", symbol: "DEF", decimals: 18, contentDigest: new Uint8Array(32).fill(0xab) },
});
const definition = assetDefinitionFromCreated(created);

describe("asset definition", () => {
  it("derives the created assetId and never carries the asset secret", () => {
    expect(assetDefinitionAssetId(definition)).toBe(BigInt(created.descriptor.assetId));
    expect(Object.keys(definition).sort()).toEqual(["assetSecretCommitment", "initialSupply", "metadata"]);
  });

  it("lays out version, supply, secret commitment, then the metadata fields", () => {
    const hex = (value: bigint, bytes: number) => value.toString(16).padStart(bytes * 2, "0");
    const name = new TextEncoder().encode(definition.metadata.name);
    expect(Buffer.from(encodeAssetDefinition(definition)).toString("hex")).toBe(
      "01" + hex(definition.initialSupply, 17) + hex(definition.assetSecretCommitment, 32)
        + hex(BigInt(name.length), 1) + Buffer.from(name).toString("hex")
        + "03" + Buffer.from("DEF").toString("hex") + "12" + "ab".repeat(32),
    );
  });

  it("round-trips the canonical encoding and the share text", () => {
    const bytes = encodeAssetDefinition(definition);
    expect(bytes[0]).toBe(1);
    expect(decodeAssetDefinition(bytes)).toEqual(definition);
    expect(parseAssetDefinition(formatAssetDefinition(definition))).toEqual(definition);
    expect(parseAssetDefinition(` https://pcash.example/token/0x01#d=${formatAssetDefinition(definition)} `)).toEqual(definition);
  });

  it("fits the maximal profile in MAX_ASSET_DEFINITION_BYTES", () => {
    const maximal: AssetDefinition = {
      ...definition,
      metadata: { name: "n".repeat(64), symbol: "S".repeat(12), decimals: 0, contentDigest: new Uint8Array(32) },
    };
    expect(encodeAssetDefinition(maximal).length).toBe(MAX_ASSET_DEFINITION_BYTES);
    expect(MAX_ASSET_DEFINITION_BYTES).toBe(161);
  });

  it("refuses to encode a definition outside the metadata profile or supply bounds", () => {
    expect(() => encodeAssetDefinition({ ...definition, metadata: { ...definition.metadata, decimals: 19 } })).toThrow(/decimals/);
    expect(() => encodeAssetDefinition({ ...definition, initialSupply: 5n * ((1n << 128n) - 1n) + 1n })).toThrow(/initialSupply/);
  });

  it("round-trips a zero-supply definition", () => {
    const empty = { ...definition, initialSupply: 0n };
    expect(decodeAssetDefinition(encodeAssetDefinition(empty))).toEqual(empty);
  });

  const valid = () => encodeAssetDefinition(definition);
  const nameOffset = 1 + 17 + 32;
  it.each([
    ["an unknown version", (b: Uint8Array) => { b[0] = 2; return b; }, /version/],
    ["a secret commitment outside the field", (b: Uint8Array) => { b.set(new Uint8Array(32).fill(0xff), 18); return b; }, /assetSecretCommitment/],
    ["a truncated encoding", (b: Uint8Array) => b.subarray(0, b.length - 1), /truncated/],
    ["trailing bytes", (b: Uint8Array) => Uint8Array.from([...b, 0]), /trailing/],
    ["invalid UTF-8 in the name", (b: Uint8Array) => { b[nameOffset + 1] = 0xff; return b; }, /./],
    ["an empty name", (b: Uint8Array) => Uint8Array.from([...b.subarray(0, nameOffset), 0, ...b.subarray(nameOffset + 1 + b[nameOffset]!)]), /name/],
    ["a supply above five maximal outputs", (b: Uint8Array) => { b.set(new Uint8Array(17).fill(0xff), 1); return b; }, /initialSupply/],
  ])("rejects %s", (_name, corrupt, pattern) => {
    expect(() => decodeAssetDefinition(corrupt(valid()))).toThrow(pattern);
  });

  it("rejects a non-NFC name that would re-encode differently", () => {
    const decomposed = "Définition";
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
