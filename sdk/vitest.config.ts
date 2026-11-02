import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: process.env.PCASH_TEST_SUITE === "fast" ? [
      ...configDefaults.exclude,
      "test/**/*.proving.test.ts",
      ...["allDummyCircuits", "eventFamilies", "fullBurnNamespace", "kernelTamper", "multisigContract",
        "proverArtifacts", "readableRuleAdversarial", "witnessMaps", "browser/proverClient"]
        .map(name => `test/${name}.test.ts`),
    ] : configDefaults.exclude,
  },
});
