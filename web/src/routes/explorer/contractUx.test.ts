import { describe, expect, it } from "vitest";
import {
  formatPresentedValue,
  formatNoirAbiType,
  isConfigurationSalt,
  orderSourceFiles,
  presentationAttribution,
  sourceIdentityConfirmed,
} from "./contractUx.ts";

describe("Explorer contract UX model", () => {
  it("orders application source before directly referenced and generic dependencies", () => {
    const ordered = orderSourceFiles("apps/claim", [
      { path: "libraries/hash/src/lib.nr", content: "pub fn hash() {}" },
      { path: "apps/claim/Nargo.toml", content: "[package]" },
      { path: "libraries/logs/src/lib.nr", content: "use hash::hash;" },
      { path: "apps/claim/src/helpers.nr", content: "pub fn check() {}" },
      { path: "apps/claim/src/main.nr", content: "mod helpers; use logs::check;" },
      { path: "libraries/hash/Nargo.toml", content: "[package]" },
      { path: "libraries/vectors/src/lib.nr", content: "pub fn test_vector() {}" },
    ]);
    expect(ordered.application.map((file) => file.path)).toEqual([
      "apps/claim/src/main.nr",
      "apps/claim/src/helpers.nr",
    ]);
    expect(ordered.dependencies.map((file) => file.path)).toEqual([
      "libraries/logs/src/lib.nr",
    ]);
    expect(ordered.verification.map((file) => file.path)).toEqual([
      "libraries/hash/src/lib.nr",
      "libraries/vectors/src/lib.nr",
    ]);
    expect(ordered.build.map((file) => file.path)).toEqual([
      "apps/claim/Nargo.toml",
      "libraries/hash/Nargo.toml",
    ]);
  });

  it("formats publisher-selected configuration values", () => {
    expect(formatPresentedValue("ethereum-address", "0x12")).toBe(`0x${"0".repeat(38)}12`);
    expect(formatPresentedValue("chain-id", "0xaa36a7")).toBe("11155111");
    expect(isConfigurationSalt("configurationSalt")).toBe(true);
  });

  it("renders compiler ABI types as compact developer-facing labels", () => {
    expect(formatNoirAbiType({ kind: "field" })).toBe("Field");
    expect(formatNoirAbiType({ kind: "array", length: 64, type: { kind: "integer", sign: "unsigned", width: 8 } })).toBe("[u8; 64]");
    expect(formatNoirAbiType({ kind: "struct", path: "signature_common::secp256k1::Signature" })).toBe("Signature");
  });

  it("requires an affirmative source-service identity match for verified content", () => {
    expect(sourceIdentityConfirmed("verified", true)).toBe(true);
    expect(sourceIdentityConfirmed("verified", undefined)).toBe(false);
    expect(sourceIdentityConfirmed("verified", false)).toBe(false);
    expect(sourceIdentityConfirmed("not_verified", true)).toBe(false);
  });

  it("separates self-declared publisher identity from source ingestion provenance", () => {
    expect(presentationAttribution(
      "Fixture Labs",
      "public_submission",
      "submitted_bundle",
    )).toEqual({
      publisher: "Self-declared publisher: Fixture Labs",
      source: "Source: Public submission / Submitted bundle",
    });
    expect(presentationAttribution(
      "Node catalogue",
      "node_operator",
      "node_registry",
    ).source).toBe("Source: Node operator / Node registry");
  });
});
