import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { circuitCatalog } from "./catalog.mjs";
import { CIRCUIT_LIBRARIES, workspaceOutputs } from "./workspace.mjs";
import { privateValueProfiles, profileOutputs, readPrivateValueProfiles } from "./profiles.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("launch shapes derive all offsets and exact non-proof wire budgets", () => {
  const [s, l] = readPrivateValueProfiles();
  assert.deepEqual([s.shapeId, s.inputs, s.outputs, s.publicInputs, s.wireInputs, s.arenaBytes], [0, 4, 5, 19, 16, 2632]);
  assert.deepEqual([l.shapeId, l.inputs, l.outputs, l.publicInputs, l.wireInputs, l.arenaBytes], [1, 32, 32, 74, 71, 16672]);
  for (const p of [s, l]) {
    assert.equal(p.offsets.carrierContextHash, p.offsets.validUntil + 1);
    assert.equal(p.offsets.eventsCommitment, p.offsets.carrierContextHash + 1);
    assert.equal(p.offsets.accountCreationCommitment + 1, p.publicInputs);
    // The wire omits chain ID, delivery commitment, and attachment commitment.
    assert.equal(p.publicInputs - 3, p.wireInputs);
    assert.equal(6 + p.wireInputs * 32 + p.outputs * 1213 + p.arenaBytes, 262 + 32 * p.inputs + 1765 * p.outputs);
  }
  assert.equal(126945 - 67 - 4 - (262 + 32 * l.inputs + 1765 * l.outputs), 69108);
});

test("one table reparameterizes both shapes without changing layout code", () => {
  const profiles = privateValueProfiles({ S: { shapeId: 0, inputs: 2, outputs: 3 }, L: { shapeId: 1, inputs: 16, outputs: 8 } });
  const [s, l] = profiles;
  assert.deepEqual([s.publicInputs, s.offsets.deliveryCommitment, s.offsets.issuanceOwner], [15, 7, 9]);
  assert.deepEqual([l.publicInputs, l.offsets.deliveryCommitment, l.offsets.issuanceOwner], [34, 26, 28]);
  const outputs = profileOutputs(profiles);
  const constants = outputs.get("circuits/protocol/lib/src/generated/private_value_profiles.nr");
  assert.match(constants, /S_INPUTS: u32 = 2/);
  assert.match(constants, /S_PUBLIC_INPUTS: u32 = 15/);
  assert.match(constants, /L_PUBLIC_INPUTS: u32 = 34/);
  assert.match(outputs.get("node/crates/derive/src/private_value_profiles.rs"), /public_inputs: 34/);
  assert.match(outputs.get("node/crates/derive/src/private_value_profiles.rs"), /carrier_context_hash_offset: 31/);
  assert.match(outputs.get("sdk/src/constants/privateValueProfiles.ts"), /"outputs": 8/);
  const small = outputs.get("circuits/protocol/private_value/s/transfer_kernel/src/main.nr");
  assert.match(small, /transfer::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>/);
  assert.match(small, /choices: PrivateValueChoices<S_INPUTS, S_OUTPUTS>/);
  assert.match(small, /event_application_vk,\n\s*event_salt,\n/);
  const smallHiding = outputs.get("circuits/protocol/private_value/s/hiding_kernel/src/main.nr");
  assert.match(smallHiding, /nullifier1: pub Field/);
  assert.match(smallHiding, /valid_until_timestamp: pub Field,\n\s*carrier_context_hash: pub Field,\n\s*events_commitment: pub Field,/);
  assert.doesNotMatch(smallHiding, /nullifier2: pub Field/);
  const large = outputs.get("circuits/protocol/private_value/l/transfer_kernel/src/main.nr");
  assert.match(large, /transfer::<L_INPUTS, L_OUTPUTS, L_SHAPE_ID>/);
  const largeHiding = outputs.get("circuits/protocol/private_value/l/hiding_kernel/src/main.nr");
  assert.match(largeHiding, /output_body_commitment7: pub Field/);
  assert.match(largeHiding, /delivery_commitment: pub Field/);
  assert.doesNotMatch(largeHiding, /output_data_hash/);
  assert.match(largeHiding, /transaction_statement: call_data\(0\) \[Field; L_PUBLIC_INPUTS\]/);
  for (const family of ["user_account_update"]) {
    const hiding = outputs.get(`circuits/protocol/${family}/hiding_kernel/src/main.nr`);
    assert.match(hiding, /transaction_statement: call_data\(0\) \[Field; S_PUBLIC_INPUTS \+ 1\]/);
    assert.match(hiding, /nullifier1: pub Field/);
    assert.doesNotMatch(hiding, /nullifier2: pub Field/);
    assert.match(hiding, /output_body_commitment2: pub Field/);
    assert.doesNotMatch(hiding, /output_body_commitment3: pub Field/);
  }
});

test("the catalog accounts for every executable, library, and profile wrapper", () => {
  const catalog = circuitCatalog(root).filter(circuit => circuit.owner === "protocol");
  function packages(directory) {
    return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "target") return packages(path);
      return entry.name === "Nargo.toml" ? [directory] : [];
    });
  }
  assert.deepEqual(packages("circuits").sort(), [
    "circuits", "circuits/vendor/poseidon", "circuits/vendor/keccak256",
    ...Object.values(CIRCUIT_LIBRARIES).map(path => `circuits/${path}`),
    ...catalog.map(circuit => circuit.packagePath),
  ].sort());
  const wrappers = catalog.filter(circuit => circuit.wrapper !== undefined);
  for (const profile of ["S", "L"]) {
    assert.deepEqual(wrappers.filter(circuit => circuit.profile === profile).map(circuit => circuit.wrapper).sort(), [
      "asset_creation", "asset_creation_kernel", "batch_transfer", "contract_fee_sponsorship", "hiding_kernel",
      "sponsored_transfer_kernel", "transfer_kernel",
      ...(profile === "S" ? ["user_account_update_hiding_kernel"] : []),
    ].sort());
  }
  assert.deepEqual(catalog.filter(circuit => circuit.fixture).map(circuit => circuit.packageName).sort(), [
    "account_rule_asset_covenant", "account_rule_event_gate", "account_rule_full_ecdsa", "account_rule_multisig", "account_rule_shared_asset_claim",
    "event_fixture", "event_large_sender_authentication", "event_sender_authentication",
  ]);
  for (const circuit of catalog) assert.equal(circuit.fixture, circuit.packagePath.startsWith("circuits/fixtures/"));
});

test("workspace and package declarations name resolvable dependencies", () => {
  for (const [path, source] of workspaceOutputs(circuitCatalog(root))) {
    for (const match of source.matchAll(/^(\w+) = \{ path = "([^"]+)"/gm)) {
      const dependency = readFileSync(resolve(root, dirname(path), match[2], "Nargo.toml"), "utf8");
      assert.match(dependency, new RegExp(`name = "${match[1]}"`), `${path}: ${match[1]}`);
    }
  }
});

test("a catalog path change moves both the generated wrapper and its package declaration", () => {
  const catalog = circuitCatalog(root).map(circuit => circuit.packageName === "private_value_large_transfer_kernel"
    ? { ...circuit, packagePath: "circuits/protocol/private_value/l/renamed_transfer" } : circuit);
  const wrappers = profileOutputs(readPrivateValueProfiles(), catalog);
  const workspace = workspaceOutputs(catalog);
  assert(wrappers.has("circuits/protocol/private_value/l/renamed_transfer/src/main.nr"));
  assert(!wrappers.has("circuits/protocol/private_value/l/transfer_kernel/src/main.nr"));
  assert(workspace.has("circuits/protocol/private_value/l/renamed_transfer/Nargo.toml"));
  assert.match(workspace.get("circuits/Nargo.toml"), /protocol\/private_value\/l\/renamed_transfer/);
});

test("build configuration rejects unknown dependencies and wrapper generators", () => {
  const circuit = circuitCatalog(root).find(circuit => circuit.packageName === "private_value_transfer_kernel");
  assert.throws(() => workspaceOutputs([{ ...circuit, dependencies: ["missing_library"] }]), /unknown library/);
  assert.throws(() => profileOutputs(readPrivateValueProfiles(), [{ ...circuit, wrapper: "missing_wrapper", links: [] }]), /unknown wrapper/);
});

test("profile configuration cannot add shapes, reassign IDs, or create unbounded arrays", () => {
  const s = { shapeId: 0, inputs: 4, outputs: 5 };
  const l = { shapeId: 1, inputs: 32, outputs: 32 };
  for (const source of [null, {}, { S: s }, { S: s, L: l, XL: l }, { S: l, L: s },
    { S: { ...s, inputs: 0 }, L: l }, { S: s, L: { ...l, outputs: 33 } }, { S: s, L: { ...l, inputs: 65 } },
    { S: { ...s, inputs: 1.5 }, L: l }, { S: { ...s, proofBytes: 23872 }, L: l }]) {
    assert.throws(() => privateValueProfiles(source));
  }
});
