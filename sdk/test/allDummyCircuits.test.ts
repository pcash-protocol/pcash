import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import type { ChonkCircuitMaterial } from "../src/prover/stacks.ts";
import type { WitnessMap } from "../src/protocol/witness.ts";
import { allDummyFixture } from "./allDummyFixtures.ts";
import { dummyNullifier } from "../src/protocol/notes.ts";
import { proverAssetsDir } from "./circuitBundle.ts";
import { noOpEventApplicationWitness } from "./noOpEventApplication.ts";

/** One of the kernel's `choices` arrays, for in-place edits of a cloned witness. */
const choices = (witness: WitnessMap, key: string) => (witness.choices as WitnessMap)[key] as string[];

const resolve = createChonkCircuitResolver({ artifactDirectory: proverAssetsDir(), verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks") });
describe.each([0, 1] as const)("ordinary all-dummy transfer profile %s", (shape) => {
  let material: ChonkCircuitMaterial;
  let application: ChonkCircuitMaterial;
  let map: WitnessMap;
  beforeAll(async () => {
    const { build } = allDummyFixture({ shape });
    material = await resolve(shape === 0 ? "private_value_transfer_kernel" : "private_value_large_transfer_kernel", "kernel");
    application = await resolve(build.authorizationCircuit, "app");
    map = build.buildKernelWitnessMap(application);
  });
  const execute = async (witness: WitnessMap) => new Noir(material.artifact as never).execute({ ...witness, ...await noOpEventApplicationWitness(resolve, witness) } as never);
  it.each([false, true])("accepts an ordinary all-dummy action (registered: %s)", async (registered) => {
    const { build } = allDummyFixture({ shape, registered });
    await expect(execute(build.buildKernelWitnessMap(application))).resolves.toBeDefined();
    expect(build.publicInputs).toHaveLength(shape === 0 ? 19 : 74);
  });
  it("retains real spending and rejects unregistered mixed real/dummy inputs", async () => {
    const valid = allDummyFixture({ shape, registered: true, inputAmounts: [5n] }).build;
    await expect(execute(valid.buildKernelWitnessMap(application))).resolves.toBeDefined();
    const invalid = valid.buildKernelWitnessMap(application);
    const witness = (invalid.account as WitnessMap).account_witness as { siblings: string[] };
    witness.siblings[0] = String(BigInt(witness.siblings[0]!) + 1n);
    await expect(execute(invalid)).rejects.toThrow("account must be in the account state tree");
    expect(() => allDummyFixture({ shape, inputAmounts: [5n] })).toThrow("account fields do not open under accountStateRoot");
  });
  it.each([
    "account.configuration_commitment",
    "dummy_input_seed", "output_dummy_secrets.0", "choices.delivery_commitment", "choices.open_fee_amount",
    "choices.asset_burn_amount",
    "rule_statement.0", "rule_statement.1", "authorization_vk.hash",
    "recent_pcash_block_hash", "account_state_root",
  ])("rejects a modified %s", async (path) => {
    const witness = structuredClone(map);
    const keys = path.split(".");
    let parent = witness;
    for (const key of keys.slice(0, -1)) parent = parent[key] as WitnessMap;
    const key = keys.at(-1)!;
    parent[key] = `0x${(BigInt(parent[key] as string) + 1n).toString(16)}`;
    await expect(execute(witness)).rejects.toThrow();
  });
  it("accepts a zero dummy seed", async () => {
    const { build } = allDummyFixture({ shape, dummyInputEntropy: 0n });
    const witness = build.buildKernelWitnessMap(application);
    expect(BigInt(witness.dummy_input_seed as string)).toBe(0n);
    expect(build.transaction.inputs.map((input) => input.nullifier))
      .toEqual(build.transaction.inputs.map((_, i) => dummyNullifier(0n, i)));
    await expect(execute(witness)).resolves.toBeDefined();
  });
  it("does not exempt an APPLICATION input", async () => {
    const witness = structuredClone(map);
    choices(witness, "input_slot_classes")[0] = "4";
    (witness.replay_ids as string[])[0] = "1";
    await expect(execute(witness)).rejects.toThrow("account must be in the account state tree");
  });
  it("does not admit an ASSET_CREATION input", async () => {
    const witness = allDummyFixture({ shape, registered: true }).build.buildKernelWitnessMap(application);
    choices(witness, "input_slot_classes")[0] = "3";
    await expect(execute(witness)).rejects.toThrow("transfer input must not be a creation marker");
  });
  it("cannot create a funded output", async () => {
    const witness = structuredClone(map);
    choices(witness, "output_slot_classes")[0] = "1";
    (witness.output_amounts as string[])[0] = "1";
    (witness.output_dummy_secrets as string[])[0] = "0";
    await expect(execute(witness)).rejects.toThrow("native inputs must equal native outputs plus the open fee");
  });
});
