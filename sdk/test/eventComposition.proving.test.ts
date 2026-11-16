import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { isProverAvailable, nativeChonkBackend } from "../src/node/nativeProver.ts";
import { proveChonkStack } from "../src/prover/chonk.ts";
import { prepareEventApplication, sponsoredTransferStack, transferTransactionStack, type ChonkCircuitResolver, type ChonkStack } from "../src/prover/stacks.ts";
import { privateValueProfile } from "../src/constants/privateValueProfiles.ts";
import { sharedAssetClaimFixture } from "./sharedAssetClaimFixtures.ts";
import { fm, privateValueMap } from "../src/protocol/witness.ts";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";
import { proverAssetsDir } from "./circuitBundle.ts";
import { expectRecursiveProofRejection } from "./proofRejection.ts";
import { verifyGeneratedProof } from "./proofVerification.ts";

const available = isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !available) throw new Error("release-pinned prover unavailable");

(available ? describe : describe.skip).each([0, 1] as const)("transaction event recursive composition shape %s", (shape) => {
  const profile = privateValueProfile(shape);
  const eventPackage = shape === 0 ? "event_sender_authentication" : "event_large_sender_authentication";
  const sponsorPackage = shape === 0 ? "account_rule_contract_fee_sponsorship_ecdsa" : "account_rule_large_contract_fee_sponsorship_ecdsa";
  let resolve: ChonkCircuitResolver;
  let control: ChonkStack;
  let noOp: ChonkStack;
  let sponsored: ChonkStack;
  const clone = (stack: ChonkStack) => ({ ...stack, steps: stack.steps.map((step) => ({ ...step, witnessMap: structuredClone(step.witnessMap) })) });

  beforeAll(async () => {
    resolve = createChonkCircuitResolver({ artifactDirectory: proverAssetsDir(), verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks") });
    const rule = await resolve(shape === 0 ? "account_rule_payment_ecdsa" : "account_rule_large_batch_transfer_ecdsa", "app");
    const fixture = privateValueProfileFixture({ shape, scenario: "minimal", authorizationVkHash: BigInt(rule.vkHash) });
    const preparedEvent = await prepareEventApplication({ packageName: eventPackage, event: fixture.wallet.address, eventSalt: 123n, resolve });
    const build = buildNativeTransfer({ ...fixture.params, preparedEvent });
    const input = fixture.params.inputs[0]!;
    control = await transferTransactionStack({ build, authorizationPackage: build.authorizationCircuit!, authorizationWitnessMap: build.accountRuleWitnessMap!, resolve,
      eventApplication: { preparedEvent, witnessMap: {
        pcash_chain_id: fm(build.pcashChainId), recent_pcash_block_hash: fm(build.recentPcashBlockHash), private_value: privateValueMap(build.transaction), sponsored: false, input_slot: "0",
        note: { owner: fm(fixture.wallet.address), note_secret: fm(input.noteSecret), asset_id: fm(0n), amount: fm(input.amount) }, output_index: fm(input.outputIndex),
      } },
    });
    noOp = await transferTransactionStack({ build: fixture.build, authorizationPackage: fixture.build.authorizationCircuit!, authorizationWitnessMap: fixture.build.accountRuleWitnessMap!, resolve });
    const claimVkHash = BigInt((await resolve("account_rule_shared_asset_claim", "app")).vkHash);
    const sponsorVkHash = BigInt((await resolve(sponsorPackage, "app")).vkHash);
    const sponsorOwner = sharedAssetClaimFixture({ shape, feePaid: true, claimVkHash, sponsorVkHash }).sponsor.address;
    const sponsoredEvent = await prepareEventApplication({ packageName: eventPackage, event: sponsorOwner, resolve });
    const sf = sharedAssetClaimFixture({ shape, feePaid: true, claimVkHash, sponsorVkHash, preparedEvent: sponsoredEvent });
    sponsored = await sponsoredTransferStack({ build: sf.build, resolve, buildKernelWitnessMap: sf.kernelWitnessMap,
      primary: { packageName: "account_rule_shared_asset_claim", witnessMap: sf.claimWitnessMap },
      feePayer: { packageName: sponsorPackage, witnessMap: sf.signed!.witnessMap },
      eventApplication: { preparedEvent: sponsoredEvent, witnessMap: {
        pcash_chain_id: fm(sf.build.publicInputs[0]!), recent_pcash_block_hash: fm(sf.build.publicInputs[1]!), private_value: privateValueMap(sf.build.transaction), sponsored: true, input_slot: String(profile.inputs - 2),
        note: { owner: fm(sf.sponsor.address), note_secret: fm(446n), asset_id: fm(0n), amount: fm(15n) }, output_index: fm(2n),
      } },
    });
  }, 600_000);

  it("proves and verifies an input-owner event and the same kernel's no-op path", async () => {
    for (const stack of [control, noOp]) {
      await verifyGeneratedProof(await proveChonkStack(stack.steps, stack.publicInputs, nativeChonkBackend(1)), stack.publicInputs);
    }
    expect(control.steps.map((step) => step.kind)).toEqual(noOp.steps.map((step) => step.kind));
    expect(control.steps[2]!.verificationKey).toEqual(noOp.steps[2]!.verificationKey);
  }, 600_000);

  it("proves and verifies an actual event in the sponsored third application slot", async () => {
    await verifyGeneratedProof(await proveChonkStack(sponsored.steps, sponsored.publicInputs, nativeChonkBackend(1)), sponsored.publicInputs);
    expect(sponsored.steps).toHaveLength(5);
  }, 600_000);

  it.each(["primary_statement", "fee_statement"])("rejects an event entry changed in %s", async (field) => {
    const stack = clone(sponsored);
    const statement = stack.steps[3]!.witnessMap[field] as string[];
    statement[3] = fm(BigInt(statement[3]!) + 1n);
    await expect(new Noir(stack.steps[3]!.artifact as never).execute(stack.steps[3]!.witnessMap as never)).rejects.toThrow();
  });

  it("rejects an ordinary event statement spliced into the sponsored event slot", async () => {
    const stack = clone(sponsored);
    stack.steps[2]!.witnessMap.sponsored = false;
    await new Noir(stack.steps[2]!.artifact as never).execute(stack.steps[2]!.witnessMap as never);
    await expectRecursiveProofRejection(stack.steps, stack.publicInputs, nativeChonkBackend(1));
  }, 600_000);

  it.each(["pcash_chain_id", "recent_pcash_block_hash", "private_value"])("rejects folded event for another %s", async (field) => {
    const stack = clone(control);
    const witness = stack.steps[1]!.witnessMap;
    if (field === "private_value") {
      const value = witness.private_value as Record<string, unknown>;
      value.valid_until_timestamp = fm(BigInt(value.valid_until_timestamp as string) - 1n);
    } else witness[field] = fm(BigInt(witness[field] as string) + 1n);
    // Both circuits execute separately: rejection must come from native databus composition.
    await new Noir(stack.steps[1]!.artifact as never).execute(witness as never);
    await new Noir(stack.steps[2]!.artifact as never).execute(stack.steps[2]!.witnessMap as never);
    await expectRecursiveProofRejection(stack.steps, stack.publicInputs, nativeChonkBackend(1));
  }, 600_000);

  it("rejects a changed last output in the event's transaction context", async () => {
    const stack = clone(sponsored);
    const witness = stack.steps[2]!.witnessMap;
    const value = witness.private_value as { output_body_commitments: string[] };
    const last = profile.outputs - 1;
    value.output_body_commitments[last] = fm(BigInt(value.output_body_commitments[last]!) + 1n);
    await new Noir(stack.steps[2]!.artifact as never).execute(witness as never);
    await expectRecursiveProofRejection(stack.steps, stack.publicInputs, nativeChonkBackend(1));
  }, 600_000);

  it("rejects a substituted folded application even when the claimed key is unchanged", async () => {
    const stack = clone(control);
    stack.steps[1] = noOp.steps[1]!;
    await expectRecursiveProofRejection(stack.steps, stack.publicInputs, nativeChonkBackend(1));
  }, 600_000);

  it.each([
    ["another action", "event_statement", [fm(1n), fm(2n), fm(3n)], /event must bind the transaction action/],
  ] as const)("rejects %s during kernel witness execution", async (_, field, value, error) => {
    const stack = clone(control);
    stack.steps[2]!.witnessMap[field] = field === "event_statement"
      ? [fm(1n), (stack.steps[2]!.witnessMap.event_statement as string[])[1], (stack.steps[2]!.witnessMap.event_statement as string[])[2]]
      : value;
    await expect(new Noir(stack.steps[2]!.artifact as never).execute(stack.steps[2]!.witnessMap as never)).rejects.toThrow(error);
  });

  it("does not let an event application authorize the spend", async () => {
    const stack = clone(control);
    stack.steps[2]!.witnessMap.authorization_vk = stack.steps[2]!.witnessMap.event_application_vk;
    await expect(new Noir(stack.steps[2]!.artifact as never).execute(stack.steps[2]!.witnessMap as never)).rejects.toThrow(/account must be in the account state tree/);
  });

  it("rejects a no-op event application returning another action through the databus", async () => {
    const stack = clone(noOp);
    stack.steps[1]!.witnessMap.action_commitment = fm(BigInt(stack.steps[1]!.witnessMap.action_commitment as string) + 1n);
    await new Noir(stack.steps[1]!.artifact as never).execute(stack.steps[1]!.witnessMap as never);
    await new Noir(stack.steps[2]!.artifact as never).execute(stack.steps[2]!.witnessMap as never);
    await expectRecursiveProofRejection(stack.steps, stack.publicInputs, nativeChonkBackend(1));
  }, 600_000);
});
