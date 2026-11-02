// Witness execution checks each kernel's rule-entry and public commitment wiring.
// Recursive databus linkage is covered by eventComposition.proving.test.ts.
import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { describe, expect, it } from "vitest";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { eventStatementFromKernel } from "../src/protocol/events.ts";
import { fm, type WitnessMap } from "../src/protocol/witness.ts";
import { prepareEventApplication, type ChonkCircuitMaterial } from "../src/prover/stacks.ts";
import { assetProfileFixture } from "./assetProfileFixtures.ts";
import { userAccountUpdateFixture } from "./accountActionFixtures.ts";
import { proverAssetsDir } from "./circuitBundle.ts";

const resolve = createChonkCircuitResolver({
  artifactDirectory: proverAssetsDir(),
  verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks"),
});
const execute = (circuit: ChonkCircuitMaterial, witness: WitnessMap) =>
  new Noir(circuit.artifact as never).execute(witness as never);

// Both private-value profiles share an asset-creation relation; account actions use S.
describe.each(["asset S", "asset L", "account update"] as const)("substantive transaction event in %s", (family) => {
  it("accepts the configured entry and rejects a zero or different rule entry", async () => {
    const event = 789n;
    const preparedEvent = await prepareEventApplication({ packageName: "event_fixture", event, eventSalt: 456n, resolve });
    let kernelName: string;
    let authorizationName: string;
    let build: { publicInputs: readonly bigint[] };
    let kernelMap: WitnessMap;
    let authorizationMap: WitnessMap;
    if (family === "asset S" || family === "asset L") {
      const shape = family === "asset S" ? 0 : 1;
      const fixture = assetProfileFixture({ shape, preparedEvent });
      build = fixture.build;
      authorizationName = fixture.prepared.authorizationCircuit;
      kernelName = shape === 0 ? "private_value_asset_creation_kernel" : "private_value_large_asset_creation_kernel";
      kernelMap = fixture.build.buildAssetCreationKernelWitnessMap(await resolve(authorizationName, "app"));
      authorizationMap = fixture.signed.witnessMap;
    } else {
      const fixture = userAccountUpdateFixture({ preparedEvent });
      build = fixture.build;
      authorizationName = fixture.authorizationPackage;
      kernelName = "user_account_update_kernel";
      kernelMap = fixture.build.buildKernelWitnessMap(await resolve(authorizationName, "app"));
      authorizationMap = fixture.authorizationWitnessMap;
    }
    const eventStatement = eventStatementFromKernel(kernelMap, event);
    const material = preparedEvent.application.material;
    const eventResult = await execute(material, {
      action_commitment: fm(eventStatement[0]),
      recent_pcash_block_hash: fm(eventStatement[1]),
      event: fm(event),
    });
    expect((eventResult.returnValue as string[]).map(BigInt)).toEqual(eventStatement);
    const rule = await execute(await resolve(authorizationName, "app"), authorizationMap);
    expect(BigInt((rule.returnValue as string[])[3]!)).toBe(preparedEvent.eventEntry);
    kernelMap.event_statement = eventStatement.map(fm);
    kernelMap.event_application_vk = { key: material.vkFields, hash: material.vkHash };
    const kernel = await resolve(kernelName, "kernel");
    const result = await execute(kernel, kernelMap);
    expect((result.returnValue as string[]).map(BigInt)).toEqual(build.publicInputs);
    const statementName = "rule_statement";
    for (const wrongEntry of [0n, preparedEvent.eventEntry + 1n]) {
      const changed = structuredClone(kernelMap);
      (changed[statementName] as string[])[3] = fm(wrongEntry);
      await expect(execute(kernel, changed)).rejects.toThrow(/rule statement must match the kernel's statement/);
    }
  }, 120_000);
});
