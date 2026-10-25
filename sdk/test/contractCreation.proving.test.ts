import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  WIRE_PROOF_BYTES,
  TX_KIND_CONTRACT_ACCOUNT_CREATION,
  contractCreationPublicInputs,
  decodeTransaction,
} from "../src/protocol/codec.ts";
import { proveSponsoredContractCreationChonk } from "../src/prover/index.ts";
import {
  createChonkCircuitResolver,
  isProverAvailable,
  nativeChonkBackend,
} from "../src/node/index.ts";
import { assertAccountActionStages } from "./accountActionStages.ts";
import { sponsoredContractCreationFixture } from "./accountActionFixtures.ts";

const proverAvailable = isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !proverAvailable) {
  throw new Error("PCASH_REQUIRE_PROVER=1 but the release-pinned proving stack is unavailable");
}
const suite = proverAvailable ? describe : describe.skip;
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const bundle = process.env.PCASH_CIRCUIT_BUNDLE?.trim();
const resolver = createChonkCircuitResolver({
  artifactDirectory: bundle === undefined ? join(root, "circuits", "target") : join(bundle, "prover-assets"),
  ...(bundle === undefined ? {} : { verificationKeyDirectory: join(bundle, "vks") }),
});

suite("sponsored contract creation CHONK proving", () => {
  it("folds the sponsor's installed sponsorship application and encodes type 0x02 with its fee section", async () => {
    const { build, contract, authorizationWitnessMap } = sponsoredContractCreationFixture();
    await assertAccountActionStages({
      resolve: resolver,
      authorizationPackage: "account_rule_contract_fee_sponsorship_ecdsa",
      kernelPackage: "contract_creation_kernel",
      prefix: "contract_creation",
      extraDataName: "contract_address",
      build,
    });
    const result = await proveSponsoredContractCreationChonk({
      build,
      authorizationPackage: "account_rule_contract_fee_sponsorship_ecdsa",
      authorizationWitnessMap,
      resolve: resolver,
      backend: nativeChonkBackend(),
    });
    expect(result.proof).toHaveLength(WIRE_PROOF_BYTES);
    const decoded = decodeTransaction(build.encodeTransaction(result.proof));
    expect(decoded.kind).toBe(TX_KIND_CONTRACT_ACCOUNT_CREATION);
    if (decoded.kind !== TX_KIND_CONTRACT_ACCOUNT_CREATION) throw new Error("unreachable");
    expect(contractCreationPublicInputs(decoded, contract.address)).toEqual(build.publicInputs);
  }, 600_000);
});
