import { describe, expect, it } from "vitest";

import { fieldToHex } from "../src/crypto/field.ts";
import {
  VK_LEN,
  chonkVkArtifacts,
} from "../src/protocol/account.ts";
import { vkWitnessMap } from "../src/builders/witnessMaps.ts";

describe("CHONK VK material hash", () => {
  it.each(["app", "kernel"] as const)("checks %s material against the installed rule", (kind) => {
    const source = Array.from({ length: VK_LEN }, (_, index) => fieldToHex(BigInt(index + 1)));
    const material = chonkVkArtifacts(source, kind);

    vkWitnessMap(material, "matching pin", material.vkHash);
    expect(() => vkWitnessMap(material, "wrong pin", fieldToHex(999n)))
      .toThrow(/installed rule/);
  });
});
