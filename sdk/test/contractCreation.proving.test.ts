import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  WIRE_PROOF_BYTES,
  privateValuePublicInputs,
  decodeTransaction,
} from "../src/protocol/codec.ts";
import { proveTransferTransactionChonk } from "../src/prover/index.ts";
import {
  createChonkCircuitResolver,
  isProverAvailable,
  nativeChonkBackend,
} from "../src/node/index.ts";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { buildContractBody, functionSelector } from "../src/protocol/contract.ts";

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

suite("attached contract creation CHONK proving", () => {
  it("funds an attached contract with one transfer proof", async () => {
    const { params } = privateValueProfileFixture({ shape: 0, scenario: "minimal" });
    const contract = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 0x5151n },
      functions: [{ selector: functionSelector(0), applicationVkHash: 0x1234n, configurationCommitment: 0x5678n }] });
    const build = buildNativeTransfer({ ...params, recipientAddress: contract.address,
      accountCreation: { kind: "contract", body: contract.body } });
    const result = await proveTransferTransactionChonk({
      build, authorizationPackage: build.authorizationCircuit!, authorizationWitnessMap: build.accountRuleWitnessMap!,
      resolve: resolver, backend: nativeChonkBackend(),
    });
    expect(result.proof).toHaveLength(WIRE_PROOF_BYTES);
    const decoded = decodeTransaction(build.encodeTransaction(result.proof));
    if (decoded.kind !== 0) throw new Error("expected private value");
    expect(decoded.accountCreation).toEqual({ kind: "contract", body: contract.body });
    expect(privateValuePublicInputs(decoded)).toEqual(build.publicInputs);
  }, 600_000);
});
