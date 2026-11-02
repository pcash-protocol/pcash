#!/usr/bin/env node
// Regenerate every checked-in file that is derived from assets/, the circuit
// catalog and the SDK without the prover toolchain: domain tags, the network
// profile, protocol constants and circuit wrappers, EIP-712 type hashes, and
// the conformance vectors.
//
// Run:                node scripts/generate.mjs        (just generate)
// Verify (no write):  node scripts/generate.mjs --check

import { checkRequested, emit, report } from "./generated_files.mjs";

// A generator reads what the ones before it wrote, so each is loaded only once
// its predecessors' outputs are on disk.
const GENERATORS = [
  "../assets/gen_domain_tags.mjs",
  "./gen_network_profile.mjs",
  "./circuits/gen_constants.mjs",
  "./circuits/gen_reference_message_types.mjs",
  "./gen_vectors.mjs",
  "./gen_catalog_artifact_vectors.mjs",
];

const check = checkRequested();
const stale = [];
for (const generator of GENERATORS) {
  const { outputs } = await import(generator);
  stale.push(...emit(outputs, { check }));
}
await report(stale, { check, regenerate: "just generate" });
