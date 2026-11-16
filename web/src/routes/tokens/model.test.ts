import { describe, expect, it } from "vitest";
import { assetDefinitionAssetId, formatAssetDefinition } from "@pcash/sdk/protocol";
import {
  assetIdHex,
  checkDefinition,
  definitionFromHash,
  parseAssetIdSegment,
  parseContentDigest,
  parseDistributionLines,
  sha256,
  tokenPath,
  tokenShareLink,
} from "./model.ts";
import { testDefinition } from "./tokenTestSupport.ts";

describe("token model", () => {
  it("names a token page by its full 32-byte ID", () => {
    const definition = testDefinition();
    const assetId = assetDefinitionAssetId(definition);
    expect(tokenPath(assetId)).toBe(`/token/${assetIdHex(assetId)}`);
    expect(assetIdHex(assetId)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parseAssetIdSegment(assetIdHex(assetId))).toBe(assetId);
    expect(parseAssetIdSegment(assetIdHex(assetId).toUpperCase().replace("0X", "0x"))).toBe(assetId);
    for (const bad of ["", "0x12", assetIdHex(assetId).slice(2), `0x${"00".repeat(32)}`, `0x${"ff".repeat(32)}`]) {
      expect(parseAssetIdSegment(bad), bad).toBeUndefined();
    }
  });

  it("verifies a share link against the ID it derives, and rejects another token's definition", () => {
    const definition = testDefinition();
    const assetId = assetDefinitionAssetId(definition);
    const link = tokenShareLink("https://pcash.example", definition);
    expect(link).toBe(`https://pcash.example/token/${assetIdHex(assetId)}#d=${formatAssetDefinition(definition)}`);
    expect(definitionFromHash(new URL(link).hash)).toBe(formatAssetDefinition(definition));
    const verified = checkDefinition(link, assetId);
    expect(verified.state).toBe("verified");
    expect(checkDefinition(formatAssetDefinition(definition)).state).toBe("verified");
    const other = testDefinition("Other", "OTH");
    const mismatch = checkDefinition(formatAssetDefinition(other), assetId);
    expect(mismatch).toMatchObject({ state: "mismatch", assetId: assetDefinitionAssetId(other) });
  });

  it("explains unreadable definitions in plain words", () => {
    expect(checkDefinition("")).toMatchObject({ state: "invalid", message: "Paste a token definition or a token link." });
    expect(checkDefinition("not-a-definition")).toMatchObject({ state: "invalid", message: "This is not a readable token definition." });
    expect(checkDefinition(`https://pcash.example/token/0x${"0a".repeat(32)}`)).toMatchObject({ state: "invalid", message: "This link does not carry a readable token definition." });
    const definition = testDefinition();
    const encoded = formatAssetDefinition(definition);
    expect(checkDefinition(encoded.slice(0, -4)).state).toBe("invalid");
    // Editing any committed field yields a readable definition of some other token.
    expect(checkDefinition(`${encoded.slice(0, -2)}AA`, assetDefinitionAssetId(definition)).state).toBe("mismatch");
    expect(definitionFromHash("#wallet")).toBeUndefined();
    expect(definitionFromHash("")).toBeUndefined();
  });

  it("reads content digests and hashes bytes with SHA-256", async () => {
    expect(parseContentDigest(`0x${"ab".repeat(32)}`)).toEqual(new Uint8Array(32).fill(0xab));
    expect(() => parseContentDigest("0x1234")).toThrow(/64 hex digits/);
    const digest = await sha256(new TextEncoder().encode("abc"));
    expect(Buffer.from(digest).toString("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("splits distribution lines at the first separator and keeps amount grouping", () => {
    const { entries, errors } = parseDistributionLines([
      `0x${"12".repeat(20)}, 100`,
      "",
      "alice.eth,1,000.5",
      `0x${"34".repeat(20)}\t7`,
      "just-one-field",
    ].join("\n"));
    expect(entries).toEqual([
      { line: 1, to: `0x${"12".repeat(20)}`, amountText: "100" },
      { line: 3, to: "alice.eth", amountText: "1,000.5" },
      { line: 4, to: `0x${"34".repeat(20)}`, amountText: "7" },
    ]);
    expect(errors).toEqual([{ line: 5, message: "Write the recipient, a comma, then the amount." }]);
  });
});
