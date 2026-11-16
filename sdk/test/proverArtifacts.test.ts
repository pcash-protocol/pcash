import { describe, expect, it } from "vitest";
import { PROVER_ARTIFACT_SHA256 } from "../src/constants/proverArtifacts.ts";
import { CIRCUIT_URLS } from "../src/browser-prover/requests.ts";

describe("prover artifact pins", () => {
  it("covers every protocol circuit URL and its CHONK VK", () => {
    for (const url of Object.values(CIRCUIT_URLS)) {
      expect(PROVER_ARTIFACT_SHA256[url], url).toMatch(/^[0-9a-f]{64}$/);
      const vkUrl = `/chonk-vks/${
        url.replace(/^\/prover\//, "").replace(/\.json$/, "")
      }.vk`;
      expect(PROVER_ARTIFACT_SHA256[vkUrl], vkUrl).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
