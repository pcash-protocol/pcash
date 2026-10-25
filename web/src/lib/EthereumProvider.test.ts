import { describe, expect, it } from "vitest";
import { parseL1ChainId } from "./l1Chain.ts";

describe("Ethereum chain configuration", () => {
  it("defaults to the local Anvil chain", () => {
    expect(parseL1ChainId(undefined)).toBe(31_337);
    expect(parseL1ChainId("")).toBe(31_337);
  });

  it("accepts explicitly configured chains", () => {
    expect(parseL1ChainId("11155111")).toBe(11_155_111);
    expect(parseL1ChainId("31338")).toBe(31_338);
  });

  it("rejects invalid chain ids", () => {
    expect(() => parseL1ChainId("0")).toThrow(/positive decimal/);
    expect(() => parseL1ChainId("1.5")).toThrow(/positive decimal/);
    expect(() => parseL1ChainId("9007199254740992")).toThrow(/safe integer/);
  });
});
