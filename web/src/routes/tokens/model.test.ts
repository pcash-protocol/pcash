import { describe, expect, it } from "vitest";
import { assetDefinitionAssetId, encodeAssetDefinition, findAssetDefinition, formatAssetDefinition } from "@pcash/sdk/protocol";
import { createAccountMintAsset, createDepositMintAsset, senderDenyListTransferRule } from "@pcash/sdk/rules";
import { toBase64Url } from "@pcash/sdk/utils";
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
  tokenTerms,
  durationText,
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

  it("shows a definition of the token whose standard rule configuration does not open as invalid", () => {
    const metadata = { name: "Pilot USD", symbol: "pUSD", decimals: 6, contentDigest: new Uint8Array(32) };
    const contractAddress = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
    const rule = senderDenyListTransferRule({ contractAddress, listId: new Uint8Array(32).fill(9), maxDelta: 7_200n });
    const genuine = createAccountMintAsset({ metadata, accountAddress: 0xabcn, transferRule: rule }).definition;
    // Another list's configuration under the genuine commitment: the token ID does not change.
    const other = senderDenyListTransferRule({ contractAddress, listId: new Uint8Array(32).fill(10), maxDelta: 7_200n });
    const corrupted = { ...genuine, transferRule: { ...rule, configuration: other.configuration } };
    const assetId = assetDefinitionAssetId(genuine);
    expect(assetDefinitionAssetId(corrupted)).toBe(assetId);
    expect(checkDefinition(tokenShareLink("https://pcash.example", genuine), assetId).state).toBe("verified");
    expect(checkDefinition(tokenShareLink("https://pcash.example", corrupted), assetId))
      .toEqual({ state: "invalid", message: "This definition's rule settings do not match its token ID." });
    expect(checkDefinition(formatAssetDefinition(corrupted)).state).toBe("invalid");
  });

  it("explains unreadable definitions in plain words", () => {
    expect(checkDefinition("")).toMatchObject({ state: "invalid", message: "Paste a token definition or a token link." });
    expect(checkDefinition("not-a-definition")).toMatchObject({ state: "invalid", message: "This is not a readable token definition." });
    expect(checkDefinition(`https://pcash.example/token/0x${"0a".repeat(32)}`)).toMatchObject({ state: "invalid", message: "This link does not carry a readable token definition." });
    const definition = testDefinition();
    const encoded = formatAssetDefinition(definition);
    expect(checkDefinition(encoded.slice(0, -4)).state).toBe("invalid");
    // Editing a committed field yields another token's definition, or none when the edited ID leaves its asset class.
    const bytes = encodeAssetDefinition(definition);
    const edits = new Set(Array.from({ length: 256 }, (_, value) => value).filter((value) => value !== bytes.at(-1)).map((value) => {
      const edited = Uint8Array.from(bytes);
      edited[edited.length - 1] = value;
      return checkDefinition(toBase64Url(edited), assetDefinitionAssetId(definition)).state;
    }));
    expect(edits).toEqual(new Set(["mismatch", "invalid"]));
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

  it("labels mint and transfer rules from the definition, and a mixed rule pair as custom", () => {
    expect(tokenTerms(testDefinition()).mint).toEqual({ kind: "fixed-supply", supply: 100_000_000n });
    expect(tokenTerms(testDefinition()).transfers).toEqual({ kind: "unrestricted" });
    const metadata = { name: "Pilot USD", symbol: "pUSD", decimals: 6, contentDigest: new Uint8Array(32) };
    const contract = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
    const standard = senderDenyListTransferRule({ contractAddress: contract, listId: new Uint8Array(32).fill(9), maxDelta: 7_200n });
    const define = (rule: typeof standard) => createAccountMintAsset({ metadata, accountAddress: 0xabcn, transferRule: rule }).definition;
    expect(tokenTerms(define(standard))).toEqual({
      mint: { kind: "account-mint", account: "0x0000000000000000000000000000000000000abc" },
      transfers: { kind: "sender-deny-list", contract: "0x5fbdb2315678afecb367f032d93f642f64180aa3", listId: `0x${"09".repeat(32)}`, maxDelta: 7_200n },
    });
    expect([durationText(7_200n), durationText(5_400n), durationText(86_400n), durationText(45n)])
      .toEqual(["2 hours", "90 minutes", "1 day", "45 seconds"]);
    // The standard S key beside an unknown L key is not the standard rule.
    expect(tokenTerms(define({ ...standard, lVkHash: standard.lVkHash + 1n })).transfers).toEqual({ kind: "custom" });
    const accountMint = define(standard).mintRule;
    expect(tokenTerms(findAssetDefinition({ mintRule: { ...accountMint, lVkHash: accountMint.lVkHash + 1n }, metadata })).mint)
      .toEqual({ kind: "custom" });
    const deposit = createDepositMintAsset({ metadata, vault: 0xc1n, transferRule: standard }).definition;
    expect(tokenTerms(deposit).mint).toEqual({ kind: "deposit-mint", vault: "0x00000000000000000000000000000000000000c1" });
    // The deposit-mint rule names no L key; a definition that adds one is not the standard rule.
    expect(tokenTerms(findAssetDefinition({ mintRule: { ...deposit.mintRule, lVkHash: deposit.mintRule.sVkHash }, metadata })).mint)
      .toEqual({ kind: "custom" });
  });
});
