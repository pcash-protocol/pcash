import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { isProverAvailable, nativeChonkBackend } from "../src/node/nativeProver.ts";
import { proveChonkStack } from "../src/prover/chonk.ts";
import { NO_OP_EVENT_APPLICATION, prepareEventApplication, sponsoredTransferStack, transferTransactionStack, type ChonkCircuitResolver, type ChonkStack } from "../src/prover/stacks.ts";
import type { FieldNumberish } from "../src/crypto/field.ts";
import { fm, privateValueMap } from "../src/protocol/witness.ts";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";
import { sharedAssetClaimFixture } from "./sharedAssetClaimFixtures.ts";
import { proverAssetsDir } from "./circuitBundle.ts";
import { verifyGeneratedProof } from "./proofVerification.ts";

const available = isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !available) throw new Error("release-pinned prover unavailable");
const gatePackage = "account_rule_event_gate";
const eventPackage = "event_sender_authentication";

(available ? describe : describe.skip)("installed event rule", () => {
  let resolve: ChonkCircuitResolver;
  const controls = new Map<string, ChonkStack>();
  beforeAll(async () => {
    resolve = createChonkCircuitResolver({ artifactDirectory: proverAssetsDir(), verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks") });
    const gate = await resolve(gatePackage, "app");
    const base = privateValueProfileFixture({ shape: 0, scenario: "minimal" });
    const preparedEvent = await prepareEventApplication({ packageName: eventPackage, event: base.wallet.address, resolve });
    const fixture = privateValueProfileFixture({ shape: 0, scenario: "minimal", authorizationVkHash: BigInt(gate.vkHash), ruleConfigurationCommitment: preparedEvent.eventEntry });
    const build = buildNativeTransfer({ ...fixture.params, preparedEvent });
    const gateWitness = (address: FieldNumberish, action: bigint, recent: bigint) => ({
      address: fm(address), action_commitment: fm(action), recent_pcash_block_hash: fm(recent),
      application_vk_hash: preparedEvent.application.material.vkHash, required_event: fm(preparedEvent.application.event),
    });
    controls.set("transfer", await transferTransactionStack({
      build, resolve, authorizationPackage: gatePackage, authorizationWitnessMap: gateWitness(build.address, build.ruleStatement[1], build.recentPcashBlockHash),
      eventApplication: { preparedEvent, witnessMap: {
        pcash_chain_id: fm(build.pcashChainId), recent_pcash_block_hash: fm(build.recentPcashBlockHash), private_value: privateValueMap(build.transaction), sponsored: false, input_slot: "0",
        note: { owner: fm(fixture.wallet.address), note_secret: fm(100n), asset_id: fm(0n), amount: fm(1000n) }, output_index: fm(0n),
      } },
    }));
    const claim = await resolve("account_rule_shared_asset_claim", "app");
    const sponsor = await resolve("account_rule_contract_fee_sponsorship_ecdsa", "app");
    for (const role of ["primary", "fee"] as const) {
      const primaryVk = role === "primary" ? gate : claim;
      const feeVk = role === "fee" ? gate : sponsor;
      const sf = sharedAssetClaimFixture({ shape: 0, feePaid: true, claimVkHash: BigInt(primaryVk.vkHash), sponsorVkHash: BigInt(feeVk.vkHash), preparedEvent,
        ...(role === "primary" ? { primaryConfigurationCommitment: preparedEvent.eventEntry } : { sponsorConfigurationCommitment: preparedEvent.eventEntry }),
      });
      const kernelMap = sf.kernelWitnessMap(primaryVk, feeVk);
      const statement = kernelMap[role === "primary" ? "primary_statement" : "fee_statement"] as string[];
      const actor = role === "primary" ? sf.primary : sf.feePayer;
      const witness = gateWitness(actor.address, BigInt(statement[1]!), sf.build.recentPcashBlockHash);
      controls.set(role, await sponsoredTransferStack({ build: sf.build, resolve, buildKernelWitnessMap: sf.kernelWitnessMap,
        primary: { packageName: role === "primary" ? gatePackage : "account_rule_shared_asset_claim", witnessMap: role === "primary" ? witness : sf.claimWitnessMap },
        feePayer: { packageName: role === "fee" ? gatePackage : "account_rule_contract_fee_sponsorship_ecdsa", witnessMap: role === "fee" ? witness : sf.signed!.witnessMap },
        eventApplication: { preparedEvent, witnessMap: {
          pcash_chain_id: fm(sf.build.pcashChainId), recent_pcash_block_hash: fm(sf.build.recentPcashBlockHash), private_value: privateValueMap(sf.build.transaction), sponsored: true, input_slot: "2",
          note: { owner: fm(sf.sponsor.address), note_secret: fm(446n), asset_id: fm(0n), amount: fm(15n) }, output_index: fm(2n),
        } },
      }));
    }
  }, 600_000);

  it.each(["transfer", "primary", "fee"])("proves an installed gate in the %s role", async role => {
    const stack = controls.get(role)!;
    await verifyGeneratedProof(await proveChonkStack(stack.steps, stack.publicInputs, nativeChonkBackend(1)), stack.publicInputs);
  }, 600_000);

  it.each(["transfer", "primary", "fee"])("rejects missing, wrong-key and changed-content events in the %s role", async role => {
    const stack = controls.get(role)!;
    const kernel = stack.steps.at(-2)!;
    const noOp = await resolve(NO_OP_EVENT_APPLICATION, "app");
    const other = await resolve("event_large_sender_authentication", "app");
    for (const change of ["missing", "key", "content"]) {
      const witness = structuredClone(kernel.witnessMap);
      if (change === "missing") witness.event_application_vk = { key: noOp.vkFields, hash: noOp.vkHash };
      if (change === "key") witness.event_application_vk = { key: other.vkFields, hash: other.vkHash };
      if (change === "missing") (witness.event_statement as string[])[2] = fm(0n);
      if (change === "content") (witness.event_statement as string[])[2] = fm(1n);
      await expect(new Noir(kernel.artifact as never).execute(witness as never)).rejects.toThrow(/rule statement must match the kernel/);
    }
  });
});
