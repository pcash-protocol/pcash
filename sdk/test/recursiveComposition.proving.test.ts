// The cases come from the links circuits/manifest.json declares. For each link
// the folding circuit is given another circuit's key under the folded
// circuit's claimed hash, and separately the values another valid
// transaction's folded circuit handed up through call_data. Noir checks each
// key against its hash, so the first case fails in execution. Nothing in Noir
// checks call_data against what the folded circuit returned: ACVM treats
// recursive verification as a black box, so the second case executes in Noir
// and must fail when the release-pinned backend composes and verifies the
// complete proof. The no-op event application also returns its transaction action and anchor,
// so its links exercise the same statement-splice check. L-profile
// circuits share the S-profile library code, so their S counterparts stand in.
import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { isProverAvailable, nativeChonkBackend } from "../src/node/nativeProver.ts";
import { proveChonkStack, type NativeChonkStep } from "../src/prover/chonk.ts";
import {
  assetCreationStack,
  transferTransactionStack,
  sponsoredTransferStack,
  sponsoredContractCreationStack,
  userAccountUpdateStack,
  type ChonkCircuitResolver,
  type ChonkStack,
} from "../src/prover/stacks.ts";
import { circuitCatalog } from "../../scripts/circuits/catalog.mjs";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";
import { assetProfileFixture } from "./assetProfileFixtures.ts";
import { sharedAssetClaimFixture } from "./sharedAssetClaimFixtures.ts";
import { sponsoredContractCreationFixture, userAccountUpdateFixture } from "./accountActionFixtures.ts";
import { proverAssetsDir } from "./circuitBundle.ts";
import { expectRecursiveProofRejection } from "./proofRejection.ts";
import { verifyGeneratedProof } from "./proofVerification.ts";

/** A control transaction and another of the same circuits whose every layer hands up different values. */
type StackPair = { control: ChonkStack; other: ChonkStack };

const STACKS: Record<string, (resolve: ChonkCircuitResolver) => Promise<StackPair>> = {
  async transfer(resolve) {
    const { build, params } = privateValueProfileFixture({ shape: 0, scenario: "distribution" });
    const other = buildNativeTransfer({ ...params, paymentAmount: params.paymentAmount + 1n });
    const stack = (transfer: typeof build) => transferTransactionStack({ build: transfer,
      authorizationPackage: transfer.authorizationCircuit!, authorizationWitnessMap: transfer.accountRuleWitnessMap!, resolve });
    return { control: await stack(build), other: await stack(other) };
  },
  async assetCreation(resolve) {
    const authorizationVkHash = BigInt((await resolve("account_rule_asset_creation_ecdsa", "app")).vkHash);
    const stack = (deadline?: { validUntilTimestamp: bigint }) => {
      const fixture = assetProfileFixture({ shape: 0, authorizationVkHash, ...deadline });
      return assetCreationStack({ build: fixture.build, resolve,
        authorization: { packageName: fixture.prepared.authorizationCircuit, witnessMap: fixture.signed.witnessMap } });
    };
    return { control: await stack(), other: await stack({ validUntilTimestamp: 999_998n }) };
  },
  async sponsoredTransfer(resolve) {
    const claimVkHash = BigInt((await resolve("account_rule_shared_asset_claim", "app")).vkHash);
    const sponsorVkHash = BigInt((await resolve("account_rule_contract_fee_sponsorship_ecdsa", "app")).vkHash);
    const stack = (deadline?: { validUntilTimestamp: bigint }) => {
      const fixture = sharedAssetClaimFixture({ shape: 0, feePaid: true, claimVkHash, sponsorVkHash, ...deadline });
      return sponsoredTransferStack({ build: fixture.build, resolve, buildKernelWitnessMap: fixture.kernelWitnessMap,
        primary: { packageName: "account_rule_shared_asset_claim", witnessMap: fixture.claimWitnessMap },
        feePayer: { packageName: "account_rule_contract_fee_sponsorship_ecdsa", witnessMap: fixture.signed!.witnessMap } });
    };
    return { control: await stack(), other: await stack({ validUntilTimestamp: 999_998n }) };
  },
  async accountUpdate(resolve) {
    const stack = (deadline?: { validUntilTimestamp: bigint }) =>
      userAccountUpdateStack({ ...userAccountUpdateFixture(deadline), resolve });
    return { control: await stack(), other: await stack({ validUntilTimestamp: 999_999n }) };
  },
  async contractCreation(resolve) {
    const stack = (deadline?: { validUntilTimestamp: bigint }) =>
      sponsoredContractCreationStack({ ...sponsoredContractCreationFixture(deadline), resolve });
    return { control: await stack(), other: await stack({ validUntilTimestamp: 999_999n }) };
  },
};

// The stack whose control exercises each folding circuit.
const STACK_OF: Readonly<Record<string, keyof typeof STACKS>> = {
  private_value_transfer_kernel: "transfer",
  private_value_hiding_kernel: "transfer",
  private_value_asset_creation_kernel: "assetCreation",
  private_value_sponsored_transfer_kernel: "sponsoredTransfer",
  user_account_update_kernel: "accountUpdate",
  user_account_update_hiding_kernel: "accountUpdate",
  contract_creation_kernel: "contractCreation",
  contract_creation_hiding_kernel: "contractCreation",
};

const catalog = circuitCatalog();
type Link = (typeof catalog)[number]["links"][number];
const LINKS = catalog.filter((circuit) => circuit.profile !== "L").flatMap((circuit) =>
  circuit.links.map((link) => ({ circuit, link })));
/** Every folded application returns a statement, including the no-op event application's zero claim. */
const busSlots = (links: readonly Link[]) => links.map((link) => link.callData);

/** Indices of the folding circuit and the circuit it folds through the link. */
function linkSteps(steps: readonly NativeChonkStep[], name: string, callData: number, folds: "application" | string[]) {
  const upper = steps.findIndex((step) => step.name === name);
  // call_data(n >= 1) carries the n-th application folded into the kernel.
  const lower = folds === "application"
    ? steps.flatMap((step, index) => index < upper && step.kind === "app" ? [index] : [])[callData - 1]
    : steps.findIndex((step, index) => index < upper && folds.includes(step.name));
  if (upper < 0 || lower === undefined || lower < 0) throw new Error(`stack does not fold ${name} call_data(${callData})`);
  return { upper, lower };
}

/** The folding circuit's call_data parameter for the link and the key parameter that follows it. */
function linkParameters(step: NativeChonkStep, callData: number, callDataSlots: readonly number[]) {
  const parameters = (step.artifact.abi as { parameters: { name: string; visibility: string }[] }).parameters;
  const buses = parameters.flatMap((parameter, index) => parameter.visibility === "databus" ? [index] : []);
  expect(buses).toHaveLength(callDataSlots.length);
  const bus = buses[[...callDataSlots].sort((a, b) => a - b).indexOf(callData)]!;
  return { statement: parameters[bus]!.name, key: parameters[bus + 1]!.name };
}

const available = isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !available) {
  throw new Error("PCASH_REQUIRE_PROVER=1 but the release-pinned proving stack is unavailable");
}

it("has a control stack for every declared link", () => {
  expect(LINKS.filter(({ circuit }) => !Object.hasOwn(STACK_OF, circuit.packageName)).map(({ circuit }) => circuit.packageName))
    .toEqual([]);
});

(available ? describe : describe.skip)("recursive composition links", () => {
  let resolve: ChonkCircuitResolver;
  const pairs = new Map<string, Promise<StackPair>>();
  // Resolving and proving serially is intentional: native proof jobs are large.
  const pair = (name: keyof typeof STACKS) => {
    if (!pairs.has(name)) {
      pairs.set(name, STACKS[name]!(resolve).then((built) => {
        // A splice must change only what is handed up, never which circuit runs.
        expect(built.other.steps.map((step) => step.name)).toEqual(built.control.steps.map((step) => step.name));
        return built;
      }));
    }
    return pairs.get(name)!;
  };
  beforeAll(() => {
    resolve = createChonkCircuitResolver({
      artifactDirectory: proverAssetsDir(),
      verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks"),
    });
  });

  it.each(Object.keys(STACKS))("proves and verifies the %s control", async (name) => {
    const { control } = await pair(name);
    await verifyGeneratedProof(await proveChonkStack(control.steps, control.publicInputs, nativeChonkBackend(1)), control.publicInputs);
  }, 600_000);

  describe.each(LINKS.map(({ circuit, link }) => [`${circuit.packageName} call_data(${link.callData})`, circuit, link] as const))(
    "%s", (_, circuit, link) => {
      const slots = busSlots(circuit.links);

      it("rejects another circuit's key under the folded circuit's hash", async () => {
        const { control } = await pair(STACK_OF[circuit.packageName]!);
        const { upper, lower } = linkSteps(control.steps, circuit.packageName, link.callData, link.folds);
        const folded = control.steps[lower]!;
        // Another key of the same kind passes bb's host-side size and kind checks.
        const other = catalog.find((entry) => entry.owner === "protocol" && entry.kind === folded.kind
          && entry.packageName !== folded.name)!;
        const otherKey = (await resolve(other.packageName, other.kind)).vkFields;
        const steps = control.steps.map((step) => ({ ...step, witnessMap: structuredClone(step.witnessMap) }));
        const { key } = linkParameters(steps[upper]!, link.callData, slots);
        const original = steps[upper]!.witnessMap[key] as { key: readonly string[]; hash: string };
        expect(otherKey).not.toEqual(original.key);
        steps[upper]!.witnessMap[key] = { ...original, key: otherKey };
        await expect(new Noir(steps[upper]!.artifact as never).execute(steps[upper]!.witnessMap as never))
          .rejects.toThrow(/verification key hash must match the key/);
      }, 600_000);

      it("rejects the values another transaction's folded circuit hands up", async () => {
        const { control, other } = await pair(STACK_OF[circuit.packageName]!);
        const { upper, lower } = linkSteps(control.steps, circuit.packageName, link.callData, link.folds);
        // Take the folded circuit, and everything it folds, from the other transaction.
        const replaced = (index: number) => control.steps[lower]!.kind === "app" ? index === lower : index <= lower;
        const steps = control.steps.map((step, index) => replaced(index) ? other.steps[index]! : step);
        const { statement } = linkParameters(steps[upper]!, link.callData, slots);
        let handedUp: bigint[] | undefined;
        for (const [index, step] of steps.entries()) {
          const result = await new Noir(step.artifact as never).execute(step.witnessMap as never);
          if (index === lower) handedUp = (result.returnValue as string[]).map(BigInt);
        }
        const expected = (steps[upper]!.witnessMap[statement!] as string[]).map(BigInt);
        expect(handedUp).toHaveLength(expected.length);
        expect(handedUp).not.toEqual(expected);
        await expectRecursiveProofRejection(steps, control.publicInputs, nativeChonkBackend(1));
      }, 600_000);
    });
});
