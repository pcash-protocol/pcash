import { eventStatementFromKernel } from "../src/protocol/events.ts";
// These tests exercise constraints with real builder witnesses, including the
// last slots of L. ACVM execution does NOT check recursive proofs: key/statement
// splicing is covered separately by recursiveComposition.proving.test.ts.
import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import type { ChonkCircuitMaterial } from "../src/prover/stacks.ts";
import type { WitnessMap } from "../src/protocol/witness.ts";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";
import { assetProfileFixture } from "./assetProfileFixtures.ts";
import { sharedAssetClaimFixture } from "./sharedAssetClaimFixtures.ts";
import { privateValueCommitment } from "../src/protocol/transaction.ts";
import { assetCreationActionCommitment, transferActionCommitment } from "../src/protocol/statement.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import { accountRuleEntryCommitment } from "../src/protocol/account.ts";
import { applicationNullifier, ownerCommitment } from "../src/protocol/notes.ts";
import { SlotClass } from "../src/protocol/transaction.ts";
import { proverAssetsDir } from "./circuitBundle.ts";
import { zeroPaymentFixture } from "./zeroPaymentFixtures.ts";
import { noOpEventApplicationWitness, MISMATCHED_EVENT_APPLICATION_REJECTION, substituteEventApplication } from "./noOpEventApplication.ts";

const resolve = createChonkCircuitResolver({
  artifactDirectory: proverAssetsDir(),
  verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks"),
});

function replace(map: WitnessMap, path: string, value?: unknown): WitnessMap {
  const copy = structuredClone(map);
  const keys = path.split(".");
  let parent = copy;
  for (const key of keys.slice(0, -1)) parent = parent[key] as WitnessMap;
  const key = keys.at(-1)!;
  // Fail in the test, not in ABI encoding, if a witness field is renamed.
  expect(parent[key], path).not.toBeUndefined();
  parent[key] = value ?? `0x${(BigInt(parent[key] as string) + 1n).toString(16)}`;
  return copy;
}

// Account, rule, statement, and snapshot witnesses: none depends on the input
// slots, so every transfer-kernel action, including one with no real input, rejects them.
const AUTHENTICATION_MUTATIONS: [string, unknown?][] = [
  ["account.address"], ["account.nk_root"], ["account.account_revision"], ["account_kind"],
  ["account.receive_key_hash"], ["account.configuration_commitment"], ["account.commitment_blinder"],
  ["account.account_witness.leaf_index"], ["account.account_witness.siblings.39"],
  ["account.account_rule_witness.entry_index", "256"], ["account.account_rule_witness.siblings.7"],
  ["authorization_vk.hash"], ["rule_statement.0"], ["rule_statement.1"],
  ["rule_statement.2"],
  ["block_header_state_siblings.3"], ["state_output_siblings.3"], ["state_account_siblings.3"],
];

// The one message for any difference between a supplied rule statement and the
// statement the kernel derives, including through a derived commitment.
const STATEMENT_MISMATCH = /rule statement must match the kernel's statement/;

async function execute(material: ChonkCircuitMaterial, map: WitnessMap) {
  return new Noir(material.artifact as never).execute(map as never);
}

for (const profile of Object.values(PRIVATE_VALUE_PROFILES)) {
  describe(`${profile.name} sponsored-transfer kernel constraints`, () => {
    let kernel: ChonkCircuitMaterial;
    let map: WitnessMap;
    let fixture: ReturnType<typeof sharedAssetClaimFixture>;
    beforeAll(async () => {
      const primary = await resolve("account_rule_shared_asset_claim", "app");
      const fee = await resolve(profile.name === "S" ? "account_rule_contract_fee_sponsorship_ecdsa" : "account_rule_large_contract_fee_sponsorship_ecdsa", "app");
      fixture = sharedAssetClaimFixture({ shape: profile.shapeId, feePaid: true,
        claimVkHash: BigInt(primary.vkHash), sponsorVkHash: BigInt(fee.vkHash) });
      kernel = await resolve(profile.name === "S" ? "private_value_sponsored_transfer_kernel" : "private_value_large_sponsored_transfer_kernel", "kernel");
      map = fixture.kernelWitnessMap(primary, fee);
      Object.assign(map, await noOpEventApplicationWitness(resolve, map));
    }, 120_000);
    it("accepts the untampered two-account control", async () => {
      await execute(kernel, map);
    }, 120_000);
    it.each([
      "primary.address", "primary.nk_root", "primary.account_rule_witness.siblings.7",
      "fee_payer.address", "fee_payer.nk_root", "fee_payer.account_witness.siblings.39",
      "primary_vk.hash", "fee_vk.hash", "primary_statement.1", "fee_statement.1",
      "primary_statement.0", "fee_statement.0", "native_change.amount", "native_change.secret",
      `asset_output_amounts.${profile.outputs - 1}`,
      `output_owner_commitments.${profile.outputs - 1}`, `replay_ids.${profile.inputs - 1}`,
      "asset_id", "recent_pcash_block_hash", "pcash_chain_id",
    ])("rejects changed sponsor/primary witness %s", async (path) => {
      await expect(execute(kernel, replace(map, path))).rejects.toThrow();
    }, 120_000);
    it("derives the change owner from the fee payer instead of reading it", async () => {
      await expect(execute(kernel, replace(map, "output_owner_commitments.0"))).resolves.toBeDefined();
    }, 120_000);
    it("does not let sponsorship become primary authority", async () => {
      const swapped = structuredClone(map);
      [swapped.primary_statement, swapped.fee_statement] = [swapped.fee_statement, swapped.primary_statement];
      await expect(execute(kernel, swapped)).rejects.toThrow();
    }, 120_000);
    // Composed negative tests for the zero-amount, zero-asset-ID, and burn invariants.
    it("rejects a burn the asset outputs leave no room for", async () => {
      await expect(execute(kernel, replace(map, "choices.asset_burn_amount", "0x1")))
        .rejects.toThrow(/asset inputs must equal asset outputs plus the burn amount/);
    }, 120_000);
    it("rejects a zero asset ID for asset slots", async () => {
      await expect(execute(kernel, replace(map, "asset_id", "0x0"))).rejects.toThrow(/asset ID must be nonzero for an asset slot/);
    }, 120_000);
  });

  describe(`${profile.name} transfer kernel constraints`, () => {
    let kernel: ChonkCircuitMaterial;
    let authorization: ChonkCircuitMaterial;
    let map: WitnessMap;
    let statement: bigint[];
    beforeAll(async () => {
      const { build } = privateValueProfileFixture({ shape: profile.shapeId, scenario: "distribution" });
      authorization = await resolve(build.authorizationCircuit!, "app");
      kernel = await resolve(profile.name === "S" ? "private_value_transfer_kernel" : "private_value_large_transfer_kernel", "kernel");
      map = { ...build.buildKernelWitnessMap(authorization), ...await noOpEventApplicationWitness(resolve, build.buildKernelWitnessMap(authorization)) };
      statement = build.publicInputs;
    }, 120_000);

    it("accepts the control and returns exactly the SDK public statement", async () => {
      const result = await execute(kernel, map);
      expect((result.returnValue as string[]).map(BigInt)).toEqual(statement);
    }, 120_000);

    it("ignores replay IDs outside markers and dummy secrets on real outputs", async () => {
      let changed = replace(map, `replay_ids.${profile.inputs - 1}`, "0x123");
      changed = replace(changed, "output_dummy_secrets.0", "0x456");
      const result = await execute(kernel, changed);
      expect((result.returnValue as string[]).map(BigInt)).toEqual(statement);
    }, 120_000);

    const mutations: [string, unknown?][] = [
      ...AUTHENTICATION_MUTATIONS,
      ["owner_inputs.0.note_secret"], ["owner_inputs.0.amount"],
      ["owner_inputs.0.output_index", "0x10000000000"], ["owner_inputs.0.siblings.39"],
      [`choices.input_slot_classes.${profile.inputs - 1}`, "0x3"],
      [`output_amounts.${profile.outputs - 1}`],
      [`output_owner_commitments.${profile.outputs - 1}`],
      ["choices.delivery_commitment"],
      ["output_amounts.0", "0x100000000000000000000000000000000"],
      ["choices.output_slot_classes.0", "0x4"],
      ["choices.open_fee_amount"], ["choices.asset_burn_amount", "0x1"], ["choices.valid_until_timestamp", "0x0"],
      ["choices.not_before_timestamp", "0x10000000000000000"], ["dummy_input_seed"],
    ];
    it.each(mutations)("rejects tampering with %s", async (path, value) => {
      await expect(execute(kernel, replace(map, path, value))).rejects.toThrow(/Cannot satisfy constraint|assertion|Assertion|failed/i);
    }, 120_000);

    it("rejects an application key that does not hash to its claimed hash", async () => {
      await expect(execute(kernel, replace(map, "authorization_vk.key.0"))).rejects.toThrow(/verification key hash must match the key/);
      await expect(execute(kernel, replace(map, "event_application_vk.key.0"))).rejects.toThrow(/verification key hash must match the key/);
    }, 120_000);

    it("rejects a substituted application VK against the authorized event entry", async () => {
      await expect(execute(kernel, substituteEventApplication(map, authorization))).rejects.toThrow(MISMATCHED_EVENT_APPLICATION_REJECTION);
    }, 120_000);

    it("derives the spent note from the authenticated owner", async () => {
      await expect(execute(kernel, replace(map, "owner_inputs.0.note_secret"))).rejects.toThrow(/input note must be in the output tree/);
      await expect(execute(kernel, replace(map, "account.nk_root"))).rejects.toThrow();
    }, 120_000);

    it("rejects a zero input amount", async () => {
      await expect(execute(kernel, replace(map, "owner_inputs.0.amount", "0x0"))).rejects.toThrow(/input amount must be nonzero/);
    }, 120_000);
    it("rejects a burn with only native inputs", async () => {
      await expect(execute(kernel, replace(map, "choices.asset_burn_amount", "0x1")))
        .rejects.toThrow(/asset inputs must equal asset outputs plus the burn amount/);
    }, 120_000);
  });

  describe(`${profile.name} transfer kernel without a real input`, () => {
    let kernel: ChonkCircuitMaterial;
    let authorization: ChonkCircuitMaterial;
    let fixture: ReturnType<typeof zeroPaymentFixture>;
    let map: WitnessMap;
    beforeAll(async () => {
      fixture = zeroPaymentFixture({ shape: profile.shapeId });
      authorization = await resolve(fixture.build.authorizationCircuit, "app");
      kernel = await resolve(profile.name === "S" ? "private_value_transfer_kernel" : "private_value_large_transfer_kernel", "kernel");
      map = { ...fixture.build.buildKernelWitnessMap(authorization), ...await noOpEventApplicationWitness(resolve, fixture.build.buildKernelWitnessMap(authorization)) };
    }, 120_000);

    it("accepts an all-dummy action and returns exactly the SDK public statement", async () => {
      const result = await execute(kernel, map);
      expect((result.returnValue as string[]).map(BigInt)).toEqual(fixture.build.publicInputs);
    }, 120_000);

    it("authenticates an application marker without spending a note", async () => {
      const replayId = 0x7e57n;
      const entry = accountRuleEntryCommitment(BigInt(authorization.vkHash), fixture.build.configurationCommitment, BigInt((map.account as WitnessMap).commitment_blinder as string));
      const marker = applicationNullifier(fixture.build.address, entry, replayId);
      const tx = {
        ...fixture.build.transaction,
        inputs: fixture.build.transaction.inputs.map((input, index) =>
          index === 0 ? { slotClass: SlotClass.APPLICATION, inputCommitment: 0n, nullifier: marker } : input),
      };
      const changed = replace(map, "choices.input_slot_classes.0", fieldToHex(BigInt(SlotClass.APPLICATION)));
      (changed.replay_ids as string[])[0] = fieldToHex(replayId);
      (changed.rule_statement as string[])[1] = fieldToHex(
        transferActionCommitment(fixture.build.pcashChainId, privateValueCommitment(tx, profile.shapeId)),
      );
      changed.event_statement = eventStatementFromKernel(changed).map(fieldToHex);
      const result = await execute(kernel, changed);
      expect(BigInt((result.returnValue as string[])[2]!)).toBe(marker);
      await expect(execute(kernel, replace(changed, "account.account_witness.siblings.39"))).rejects.toThrow(/account must be in the account state tree/);
      await expect(execute(kernel, replace(changed, "replay_ids.0"))).rejects.toThrow(/event must bind the transaction action/);
      await expect(execute(kernel, replace(changed, "rule_statement.1"))).rejects.toThrow(STATEMENT_MISMATCH);
    }, 120_000);

    it("ignores note-free openings and the unused native-path asset ID", async () => {
      let changed = replace(map, "asset_id", "0x5");
      changed = replace(changed, "owner_inputs.0.amount", "0x123");
      changed = replace(changed, "owner_inputs.0.output_index", "0xffffffffffffffff");
      changed = replace(changed, "owner_inputs.0.siblings.39", "0x456");
      const result = await execute(kernel, changed);
      expect((result.returnValue as string[]).map(BigInt)).toEqual(fixture.build.publicInputs);
    }, 120_000);

    const mutations: [string, string, RegExp][] = [
      ["dummy_input_seed", "0x2", /event must bind the transaction action/],
      ["output_dummy_secrets.0", "0x2", /event must bind the transaction action/],
      ["choices.open_fee_amount", "0x1", /native inputs must equal native outputs plus the open fee/],
      ["choices.asset_burn_amount", "0x1", /asset inputs must equal asset outputs plus the burn amount/],
    ];
    it.each(mutations)("rejects %s = %s", async (path, value, message) => {
      await expect(execute(kernel, replace(map, path, value))).rejects.toThrow(message);
    }, 120_000);

    it("rejects a real zero-valued output in the payment slot", async () => {
      const changed = replace(map, "choices.output_slot_classes.0", fieldToHex(BigInt(SlotClass.NATIVE)));
      (changed.output_dummy_secrets as string[])[0] = "0x0";
      await expect(execute(kernel, changed)).rejects.toThrow(/real output amount must be nonzero/);
    }, 120_000);

    // An all-dummy action spends no existing value, so the kernel binds the
    // supplied account identity and rule but does not assert the account exists
    // (spec §11.4). Fields that only feed the skipped membership root are free,
    // nk_root included: it otherwise derives only real-input nullifiers.
    const MEMBERSHIP_ONLY = new Set([
      "account.nk_root", "account.account_revision", "account_kind", "account.receive_key_hash",
      "account.commitment_blinder", "account.account_witness.leaf_index",
      "account.account_witness.siblings.39", "account.account_rule_witness.siblings.7",
    ]);
    it.each(AUTHENTICATION_MUTATIONS.filter(([path]) => !MEMBERSHIP_ONLY.has(path)))(
      "rejects tampering with %s",
      async (path, value) => {
        await expect(execute(kernel, replace(map, path, value))).rejects.toThrow(/Cannot satisfy constraint|assertion|Assertion|failed/i);
      },
      120_000,
    );

    it.each([...MEMBERSHIP_ONLY])("does not assert account membership through %s", async (path) => {
      const result = await execute(kernel, replace(map, path));
      expect((result.returnValue as string[]).map(BigInt)).toEqual(fixture.build.publicInputs);
    }, 120_000);

    // A well-formed positive real note in the payment slot, with its body
    // bound, so only conservation can reject value created from nothing.
    it.each([
      ["native", SlotClass.NATIVE, 0n, /native inputs must equal native outputs plus the open fee/],
      ["asset", SlotClass.ASSET, 5n, /asset inputs must equal asset outputs plus the burn amount/],
    ] as const)("rejects a positive %s output with no real input", async (_kind, slotClass, assetId, message) => {
      const changed = replace(map, "choices.output_slot_classes.0", fieldToHex(BigInt(slotClass)));
      (changed.output_dummy_secrets as string[])[0] = "0x0";
      (changed.output_amounts as string[])[0] = "0x1";
      (changed.output_owner_commitments as string[])[0] = fieldToHex(ownerCommitment(fixture.wallet.address, 0x5001n));
      changed.asset_id = fieldToHex(assetId);
      await expect(execute(kernel, changed)).rejects.toThrow(message);
    }, 120_000);
  });

  describe(`${profile.name} asset-creation kernel constraints`, () => {
    let kernel: ChonkCircuitMaterial;
    let authorization: ChonkCircuitMaterial;
    let build: ReturnType<typeof assetProfileFixture>["build"];
    let kernelMap: WitnessMap;
    let statement: bigint[];
    beforeAll(async () => {
      const fixture = assetProfileFixture({ shape: profile.shapeId });
      build = fixture.build;
      kernel = await resolve(profile.name === "S" ? "private_value_asset_creation_kernel" : "private_value_large_asset_creation_kernel", "kernel");
      authorization = await resolve(fixture.prepared.authorizationCircuit, "app");
      kernelMap = { ...build.buildAssetCreationKernelWitnessMap(authorization), ...await noOpEventApplicationWitness(resolve, build.buildAssetCreationKernelWitnessMap(authorization)) };
      statement = build.publicInputs;
    }, 120_000);

    it("accepts the control and returns exactly the SDK public statement", async () => {
      const result = await execute(kernel, kernelMap);
      expect((result.returnValue as string[]).map(BigInt)).toEqual(statement);
    }, 120_000);
    it("rejects the transfer action of the same private value", async () => {
      const changed = replace(kernelMap, "rule_statement.1", fieldToHex(
        transferActionCommitment(build.pcashChainId, build.privateValueCommitment),
      ));
      await expect(execute(kernel, changed)).rejects.toThrow(STATEMENT_MISMATCH);
    }, 120_000);
    it("rejects a substituted application VK against the authorized event entry", async () => {
      await expect(execute(kernel, substituteEventApplication(kernelMap, authorization))).rejects.toThrow(MISMATCHED_EVENT_APPLICATION_REJECTION);
    }, 120_000);
    it("ignores the unused note witness in an creation marker slot", async () => {
      await expect(execute(kernel, replace(kernelMap, "native_inputs.0.amount", "0x123"))).resolves.toBeDefined();
    }, 120_000);
    it.each([
      ["asset_secret"], ["initial_supply"], ["metadata_commitment"], ["dummy_input_seed"],
      ["choices.asset_burn_amount", "0x1"], ["choices.input_slot_classes.0", "0x0"],
      ["choices.delivery_commitment"],
      [`output_amounts.${profile.outputs - 1}`], [`output_owner_commitments.${profile.outputs - 1}`],
      ["pcash_chain_id"], ["recent_pcash_block_hash"],
      ["rule_statement.0"], ["rule_statement.1"], ["rule_statement.2"],
      ["authorization_vk.hash"],
      ["account.account_witness.siblings.39"], [`native_inputs.${profile.inputs - 1}.amount`],
      [`native_inputs.${profile.inputs - 1}.note_secret`],
    ] as [string, unknown?][])("rejects changed asset-creation kernel %s", async (path, value) => {
      await expect(execute(kernel, replace(kernelMap, path, value))).rejects.toThrow();
    }, 120_000);

    it("authenticates an application marker of the creating account", async () => {
      const slot = 1;
      expect(build.transaction.inputs[slot]!.slotClass).toBe(SlotClass.DUMMY);
      const replayId = 0x7e57n;
      const entry = accountRuleEntryCommitment(BigInt(authorization.vkHash),
        BigInt((kernelMap.account as WitnessMap).configuration_commitment as string),
        BigInt((kernelMap.account as WitnessMap).commitment_blinder as string));
      const marker = applicationNullifier(build.address, entry, replayId);
      const tx = {
        ...build.transaction,
        inputs: build.transaction.inputs.map((input, index) =>
          index === slot ? { slotClass: SlotClass.APPLICATION, inputCommitment: 0n, nullifier: marker } : input),
      };
      const changed = replace(kernelMap, `choices.input_slot_classes.${slot}`, fieldToHex(BigInt(SlotClass.APPLICATION)));
      (changed.replay_ids as string[])[slot] = fieldToHex(replayId);
      (changed.rule_statement as string[])[1] = fieldToHex(
        assetCreationActionCommitment(build.pcashChainId, privateValueCommitment(tx, profile.shapeId), build.assetId),
      );
      changed.event_statement = eventStatementFromKernel(changed).map(fieldToHex);
      const result = await execute(kernel, changed);
      expect(BigInt((result.returnValue as string[])[2 + slot]!)).toBe(marker);
      await expect(execute(kernel, replace(changed, `replay_ids.${slot}`))).rejects.toThrow(/event must bind the transaction action/);
    }, 120_000);
  });
}
