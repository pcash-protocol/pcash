import { describe, expect, it } from "vitest";
import {
  canonicalReleaseJson,
  parseCircuitReleaseArgs,
} from "../../scripts/circuits/check_release.mts";

describe("circuit release command", () => {
  it("parses the output directory and known-answer selection", () => {
    expect(parseCircuitReleaseArgs(["--out", "candidate"], {})).toEqual({ out: "candidate", runtimeKatsOnly: false });
    expect(parseCircuitReleaseArgs(["--out", "candidate", "--runtime-kats-only"], {})).toEqual({
      out: "candidate",
      runtimeKatsOnly: true,
    });
  });

  it("renders canonical portable JSON", () => {
    expect(canonicalReleaseJson({ z: 1, path: "vks/private_value_hiding_kernel.chonk.vk", a: 2 })).toBe(
      '{\n  "a": 2,\n  "path": "vks/private_value_hiding_kernel.chonk.vk",\n  "z": 1\n}\n',
    );
    expect(() => canonicalReleaseJson({ path: "/Users/example/vk" })).toThrow(
      "contains an absolute path",
    );
  });
});
