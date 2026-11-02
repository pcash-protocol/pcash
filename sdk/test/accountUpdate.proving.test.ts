import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Barretenberg, BackendType } from "@aztec-foundation/bb.js";
import { field32 } from "../src/utils/bytes.ts";
import { proverReleaseConfig } from "../src/node/nativeProver.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { describe, expect, it } from "vitest";

import {
  WIRE_PROOF_BYTES,
  TX_KIND_USER_ACCOUNT_UPDATE,
  decodeTransaction,
} from "../src/protocol/codec.ts";
import { proveUserAccountUpdateChonk } from "../src/prover/index.ts";
import {
  createChonkCircuitResolver,
  isProverAvailable,
  nativeChonkBackend,
} from "../src/node/index.ts";
import { assertAccountActionStages } from "./accountActionStages.ts";
import { userAccountUpdateFixture } from "./accountActionFixtures.ts";

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

suite("user account update CHONK proving", () => {
  it("folds the installed administration application and encodes type 0x03 with its fee", async () => {
    const { build, authorizationWitnessMap } = userAccountUpdateFixture();
    await assertAccountActionStages({
      resolve: resolver,
      authorizationPackage: "account_rule_admin_ecdsa",
      kernelPackage: "user_account_update_kernel",
      prefix: "user_account_update",
      extraDataName: "account_update_commitment",
      build,
    });
    const result = await proveUserAccountUpdateChonk({
      build,
      authorizationPackage: "account_rule_admin_ecdsa",
      authorizationWitnessMap,
      resolve: resolver,
      backend: nativeChonkBackend(),
    });
    expect(result.proof).toHaveLength(WIRE_PROOF_BYTES);
    const api = await Barretenberg.new({ backend: BackendType.NativeUnixSocket, bbPath: proverReleaseConfig().bb, threads: 1 });
    try {
      const { offsets, publicInputs } = PRIVATE_VALUE_PROFILES.S;
      for (const changedIndex of [null, offsets.chainId, offsets.deliveryCommitment, offsets.issuanceOwner, offsets.validUntil, offsets.eventsCommitment, publicInputs]) {
        const inputs = build.publicInputs.map((value, i) => i === changedIndex ? value + 1n : value);
        const { proof } = await api.chonkDecompressProof({
          compressedProof: Uint8Array.from([...inputs.flatMap(value => [...field32(value)]), ...result.proof]),
        });
        expect((await api.chonkVerify({ proof, vk: result.hidingVerificationKey })).valid).toBe(changedIndex === null);
      }
    } finally { await api.destroy(); }

    expect(decodeTransaction(build.encodeTransaction(result.proof)).kind).toBe(TX_KIND_USER_ACCOUNT_UPDATE);
  }, 600_000);
});
