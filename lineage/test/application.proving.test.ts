import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { lineageFixture } from "../src/fixture.ts";
import { claimEvent } from "../src/policy.ts";
import { proveTransferTransactionChonk } from "@pcash/sdk/prover";
import { nativeChonkBackend } from "@pcash/sdk/node";
import { createChonkCircuitResolver } from "@pcash/sdk/node";
import { blockHash, openBlockHeaderKey, transactionResultLeaf, transactionResultsRoot, transactionStatementHash, type TransactionResultCommitment } from "@pcash/sdk/protocol";
import { noteBodyCommitment } from "@pcash/sdk/protocol";
import { eventsCommitment } from "@pcash/sdk/protocol";
import { fieldToHex as fm } from "@pcash/sdk/crypto";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
const proverAssetsDir = () => join(process.env.PCASH_CIRCUIT_BUNDLE!, "prover-assets");

type Map = Record<string, any>;
const available = process.env.PCASH_CIRCUIT_BUNDLE !== undefined;
if (process.env.PCASH_REQUIRE_PROVER === "1" && !available) throw new Error("release-pinned prover unavailable");

(available ? describe : describe.skip)("lineage application constraints", () => {
  let noir: Noir;
  let source: Map;
  let predecessor: Map;
  let lineageVk: bigint;
  let policyRoot: bigint;
  let fixtureHeader: any;

  beforeAll(async () => {
    const resolve = createChonkCircuitResolver({ artifactDirectory: proverAssetsDir(), verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks") });
    const material = await resolve("event_lineage", "app");
    lineageVk = BigInt(material.vkHash);
    noir = new Noir(material.artifact as never);
    const fixture = await lineageFixture(resolve);
    policyRoot = fixture.policy.root;
    fixtureHeader = fixture.publication.boundary.header;
    source = structuredClone(fixture.eventApplication!.witnessMap);
    predecessor = structuredClone(source);
    const input = predecessor.inputs[0];
    const { offsets, publicInputs } = PRIVATE_VALUE_PROFILES.S;
    const statement = Array<bigint>(publicInputs).fill(0n);
    statement[offsets.chainId] = fixture.build.pcashChainId;
    statement[offsets.outputs] = noteBodyCommitment(BigInt(input.payout.owner_commitment), 0n, 1000n);
    statement[offsets.eventsCommitment] = eventsCommitment(19n, { applicationVkHash: lineageVk, event: claimEvent({ root: fixture.policy.root, applicationVkHash: lineageVk, qualificationMask: 1 }) });
    const result: TransactionResultCommitment = { txType: 0, accountCreation: 0, l1TransactionIndex: 0n, batchItemIndex: 0n, outcome: "succeeded", posterOwnerCommitment: 0n, outputStartIndex: 0n, statementHash: transactionStatementHash(statement) };
    const tree = new SparseMerkleTree(64); tree.setLeaf(0, transactionResultLeaf(result));
    const header = { ...fixture.publication.boundary.header, transactionResultsRoot: transactionResultsRoot([result], []) };
    const hash = blockHash(header);
    predecessor.recent_pcash_block_hash = fm(hash);
    predecessor.history_root_siblings = openBlockHeaderKey(header, 6).siblings.map(fm);
    predecessor.publication.l1_origin_root_siblings = openBlockHeaderKey(header, 5).siblings.map(fm);
    input.is_source = false;
    input.transaction_statement = statement.map(fm);
    input.transaction_result = { tx_type: fm(0n), account_creation: fm(0n), l1_transaction_index: fm(0n), batch_item_index: fm(0n), outcome: fm(0n), poster_owner_commitment: fm(0n), output_start_index: fm(0n), statement_hash: fm(transactionStatementHash(statement)) };
    input.event_salt = fm(19n); input.qualification_mask = fm(1n); input.output_slot = 0;
    input.result_opening = { ...input.result_opening, results_header_siblings: openBlockHeaderKey(header, 3).siblings.map(fm), transaction_count: "1", payout_count: "0", result_siblings: tree.proof(0).siblings.map(fm) };
  });

  it("accepts approved issuance and an authenticated predecessor event", async () => {
    await noir.execute(source as never);
    await noir.execute(predecessor as never);
  });

  it.each([1, 2] as const)("accepts an authenticated predecessor with account creation outcome %s", async accountCreation => {
    const witness = structuredClone(predecessor);
    const input = witness.inputs[0];
    input.transaction_statement[PRIVATE_VALUE_PROFILES.S.offsets.accountCreationCommitment] = fm(77n);
    const statementHash = transactionStatementHash(input.transaction_statement.map(BigInt));
    input.transaction_result.account_creation = fm(BigInt(accountCreation));
    input.transaction_result.statement_hash = fm(statementHash);
    const result: TransactionResultCommitment = { txType: 0, accountCreation, l1TransactionIndex: 0n, batchItemIndex: 0n, outcome: "succeeded", posterOwnerCommitment: 0n, outputStartIndex: 0n, statementHash };
    const tree = new SparseMerkleTree(64); tree.setLeaf(0, transactionResultLeaf(result));
    const header = { ...fixtureHeader, transactionResultsRoot: transactionResultsRoot([result], []) };
    witness.recent_pcash_block_hash = fm(blockHash(header));
    witness.history_root_siblings = openBlockHeaderKey(header, 6).siblings.map(fm);
    witness.publication.l1_origin_root_siblings = openBlockHeaderKey(header, 5).siblings.map(fm);
    input.result_opening = { ...input.result_opening, results_header_siblings: openBlockHeaderKey(header, 3).siblings.map(fm), result_siblings: tree.proof(0).siblings.map(fm) };
    await noir.execute(witness as never);
  });

  it("rejects an authenticated event from another actual VK naming the same root", async () => {
    const witness = structuredClone(predecessor);
    const input = witness.inputs[0];
    input.transaction_statement[PRIVATE_VALUE_PROFILES.S.offsets.eventsCommitment] = fm(eventsCommitment(19n, { applicationVkHash: lineageVk + 1n, event: claimEvent({ root: policyRoot, applicationVkHash: lineageVk, qualificationMask: 1 }) }));
    const statementHash = transactionStatementHash(input.transaction_statement.map(BigInt));
    input.transaction_result.statement_hash = fm(statementHash);
    const result: TransactionResultCommitment = { txType: 0, accountCreation: 0, l1TransactionIndex: 0n, batchItemIndex: 0n, outcome: "succeeded", posterOwnerCommitment: 0n, outputStartIndex: 0n, statementHash };
    const tree = new SparseMerkleTree(64); tree.setLeaf(0, transactionResultLeaf(result));
    const header = { ...fixtureHeader, transactionResultsRoot: transactionResultsRoot([result], []) };
    const hash = blockHash(header);
    witness.recent_pcash_block_hash = fm(hash);
    witness.history_root_siblings = openBlockHeaderKey(header, 6).siblings.map(fm);
    witness.publication.l1_origin_root_siblings = openBlockHeaderKey(header, 5).siblings.map(fm);
    input.result_opening = { ...input.result_opening, results_header_siblings: openBlockHeaderKey(header, 3).siblings.map(fm), result_siblings: tree.proof(0).siblings.map(fm) };
    await expect(noir.execute(witness as never)).rejects.toThrow(/trusted lineage application and policy/);
  });

  it.each([0, 1, 2, 3])("checks qualified value input slot %s", async slot => {
    const witness = structuredClone(source);
    witness.inputs[slot] = structuredClone(source.inputs[0]);
    witness.private_value.input_slot_classes = [fm(0n), fm(0n), fm(0n), fm(0n)];
    witness.private_value.input_commitments = [fm(0n), fm(0n), fm(0n), fm(0n)];
    witness.private_value.input_slot_classes[slot] = fm(1n);
    witness.private_value.input_commitments[slot] = source.private_value.input_commitments[0];
    await noir.execute(witness as never);
    witness.inputs[slot].source_path.siblings[0] = fm(123n);
    await expect(noir.execute(witness as never)).rejects.toThrow(/source must be approved/);
  });

  it("rejects a second unqualified input alongside a qualified input", async () => {
    const witness = structuredClone(source);
    witness.private_value.input_slot_classes[1] = fm(1n);
    witness.private_value.input_commitments[1] = source.private_value.input_commitments[0];
    witness.inputs[1] = structuredClone(source.inputs[0]);
    witness.inputs[1].source_path.siblings[0] = fm(123n);
    await expect(noir.execute(witness as never)).rejects.toThrow(/source must be approved/);
  });

  it.each([
    ["failed predecessor", (w: Map) => { w.inputs[0].transaction_result.outcome = fm(1n); }, /must have succeeded/],
    ["wrong transaction type", (w: Map) => { w.inputs[0].transaction_result.tx_type = fm(1n); }, /private value transaction/],
    ["wrong account creation outcome", (w: Map) => { w.inputs[0].transaction_result.account_creation = fm(1n); }, /block hash must be in the PCASH history tree/],
    ["wrong output slot", (w: Map) => { w.inputs[0].output_slot = 1; }, /output slot must be qualified/],
    ["forged event salt", (w: Map) => { w.inputs[0].event_salt = fm(20n); }, /trusted lineage application and policy/],
    ["unrecognized application", (w: Map) => { w.lineage_vk_identity = fm(lineageVk + 1n); }, /trusted lineage application and policy/],
    ["wrong result path", (w: Map) => { w.inputs[0].result_opening.result_siblings[0] = fm(1n); }, /block hash must be in the PCASH history tree/],
    ["wrong statement", (w: Map) => { w.inputs[0].transaction_statement[6] = fm(1n); }, /statement must match its result/],
    ["denied lower endpoint", (w: Map) => { w.inputs[0].deny_gap.lower_present = true; w.inputs[0].deny_gap.lower = w.private_value.input_commitments[0]; }, /above the denied lower bound/],
    ["denied upper endpoint", (w: Map) => { w.inputs[0].deny_gap.upper_present = true; w.inputs[0].deny_gap.upper = w.private_value.input_commitments[0]; }, /below the denied upper bound/],
  ] as const)("rejects %s", async (_, mutate, error) => {
    const witness = structuredClone(predecessor); mutate(witness);
    await expect(noir.execute(witness as never)).rejects.toThrow(error);
  });
});

(available ? describe : describe.skip)("lineage-gated release", () => {
  let gate: Noir;
  let witness: Map;
  let validEntry: bigint;
  const entryOf = async (w: Map) => BigInt(((await gate.execute(w as never)).returnValue as string[])[3]!);
  beforeAll(async () => {
    const resolve = createChonkCircuitResolver({ artifactDirectory: proverAssetsDir(), verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks") });
    const [material, fixture] = await Promise.all([resolve("lineage_gated", "app"), lineageFixture(resolve)]);
    gate = new Noir(material.artifact as never);
    const application = fixture.eventApplication!;
    const vk = BigInt(application.preparedEvent.application.material.vkHash);
    validEntry = BigInt(application.preparedEvent.eventEntry);
    witness = { pcash_chain_id: fm(fixture.build.pcashChainId), recent_pcash_block_hash: fm(fixture.build.recentPcashBlockHash), address: fm(7n),
      private_value: application.witnessMap.private_value,
      configuration: { salt: fm(11n), policy_root: fm(fixture.policy.root), lineage_vk: fm(vk) } };
  });
  it("folds the gated rule and real lineage application into a transfer", async () => {
    const resolve = createChonkCircuitResolver({ artifactDirectory: proverAssetsDir(), verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks") });
    const fixture = await lineageFixture(resolve, true, true);
    const request = { build: fixture.build, authorizationPackage: "lineage_gated", authorizationWitnessMap: fixture.gateWitness!, eventApplication: fixture.eventApplication!, resolve, backend: nativeChonkBackend(1) };
    const proof = await proveTransferTransactionChonk(request);
    expect(proof.proof.length).toBeGreaterThan(0);
    // The gate itself rejects nothing: the kernel's statement comparison leaves
    // a gate configured for another policy root without a valid proof.
    const otherPolicy = structuredClone(fixture.gateWitness!) as Map;
    otherPolicy.configuration.policy_root = fm(BigInt(otherPolicy.configuration.policy_root) + 1n);
    await expect(proveTransferTransactionChonk({ ...request, authorizationWitnessMap: otherPolicy })).rejects.toThrow(/Failed to verify the generated proof/);
  }, 180_000);
  it("returns the configured lineage event's entry", async () => {
    expect(await entryOf(witness)).toBe(validEntry);
  });
  it.each([
    ["another root", (w: Map) => { w.configuration.policy_root = fm(BigInt(w.configuration.policy_root) + 1n); }],
    ["another lineage VK", (w: Map) => { w.configuration.lineage_vk = fm(BigInt(w.configuration.lineage_vk) + 1n); }],
    ["missing native output coverage", (w: Map) => { w.private_value.output_slot_classes[2] = fm(1n); }],
  ] as const)("returns another entry for %s", async (_, mutate) => {
    const changed = structuredClone(witness); mutate(changed);
    expect(await entryOf(changed)).not.toBe(validEntry);
  });
});
