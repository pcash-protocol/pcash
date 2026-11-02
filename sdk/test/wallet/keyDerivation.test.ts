import { describe, expect, it } from "vitest";
import { defaultEcdsaRuleSet } from "@pcash/sdk/builders";
import { BN254_SCALAR_MODULUS } from "@pcash/sdk/crypto";
import {
  generateDefaultUserRuleSecrets,
  type DefaultUserRuleSecrets,
} from "@pcash/sdk/rules";
import { deriveTestWallet } from "./testWallet.ts";

const wallet = deriveTestWallet();

function encodeSecrets(secrets: DefaultUserRuleSecrets): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(secrets).map(([name, value]) => [name, `0x${BigInt(value).toString(16)}`]),
  ));
}

// Key-agnostic on purpose: the default rule set grows as rules are added, and
// this round-trip should keep working without being edited each time.
function decodeSecrets(encoded: string): DefaultUserRuleSecrets {
  const parsed = JSON.parse(encoded) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(parsed).map(([name, value]) => [name, BigInt(value)]),
  ) as unknown as DefaultUserRuleSecrets;
}

describe("SDK key and rule-secret derivation", () => {
  it("samples one independent nonzero commitment blinder per default rule", () => {
    const first = generateDefaultUserRuleSecrets();
    const second = generateDefaultUserRuleSecrets();
    const firstValues = Object.values(first).map(BigInt);
    expect(firstValues.every((value) => value > 0n && value < BN254_SCALAR_MODULUS)).toBe(true);
    // Every scalar is independent: no two entries may collide.
    expect(new Set(firstValues).size).toBe(firstValues.length);
    expect(Object.keys(first).every((name) => name.endsWith("CommitmentBlinder"))).toBe(true);
    expect(second).not.toEqual(first);
  });

  it("reconstructs the registered rule set from stored blinders", () => {
    const secrets = generateDefaultUserRuleSecrets();
    const before = defaultEcdsaRuleSet({
      wallet,
      secrets,
    });
    const restored = decodeSecrets(encodeSecrets(secrets));
    const after = defaultEcdsaRuleSet({
      wallet,
      secrets: restored,
    });
    expect(restored).toEqual(secrets);
    expect(after).toEqual(before);
  });
});
