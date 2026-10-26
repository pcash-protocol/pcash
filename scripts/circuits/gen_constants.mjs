// Generate the circuit build files and the constants derived from the
// protocol assets:
// - the protocol domain tags (assets/domain_tags.json) for Noir, TypeScript and
//   Rust, and the reference-rule constants (assets/reference_rule_profile.json)
//   for Noir, TypeScript and the Rust source verifier;
// - the private-value profile constants (assets/private_value_profiles.json)
//   for Noir, TypeScript and Rust;
// - from the circuit manifests: the circuits workspace and the Nargo.toml of
//   every protocol-owned catalog package, the profile-specific Noir entry
//   points (scripts/circuits/wrappers.mjs), and the proving-runtime and SRS
//   tables: the SDK's for every non-lineage catalog circuit and the lineage
//   package's for its own.
//
// Run:                node scripts/circuits/gen_constants.mjs
// Verify (no write):  node scripts/circuits/gen_constants.mjs --check

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readPrivateValueProfiles, profileOutputs } from "./profiles.mjs";
import { applicationTypeHashes } from "./wrappers.mjs";
import { circuitCatalog } from "./catalog.mjs";
import { workspaceOutputs } from "./workspace.mjs";
import { generatedHeader, runGenerator } from "../generated_files.mjs";
import { byteArray, noirGlobal } from "../noir_layout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../..");
const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "domain_tags.json"), "utf8"));
const reference = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "reference_rule_profile.json"), "utf8"));

const bytes = (hex) => Array.from(
  Buffer.from(hex.slice(2), "hex"),
  (byte) => `0x${byte.toString(16).padStart(2, "0")}`,
);
const decimal = (hex) => BigInt(hex).toString();
const header = (...inputs) => generatedHeader("scripts/circuits/gen_constants.mjs", inputs);
const formatRust = (source) => execFileSync("rustfmt", ["--emit", "stdout"], {
  encoding: "utf8",
  input: source,
});

const catalog = circuitCatalog(ROOT);
const profiles = readPrivateValueProfiles(ROOT);
export const outputs = new Map([
  ...profileOutputs(profiles, catalog),
  ...workspaceOutputs(catalog),
]);
for (const [path, entries] of [
  ["sdk/src/constants/circuitRuntimes.ts", catalog.filter(c => c.owner !== "lineage")],
  ["lineage/src/circuitRuntimes.ts", catalog.filter(c => c.owner === "lineage")],
]) {
  outputs.set(path, header(...[...new Set(entries.map(c => c.owner === "protocol" ? "circuits/manifest.json" : `${c.ownerRoot}/circuits.json`))])
    + `export const CIRCUIT_PROVING_RUNTIMES: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(Object.fromEntries(entries.map(c => [c.artifactId, c.provingRuntimes])), null, 2)};\n`
    + `export const CIRCUIT_SRS_POINTS: Readonly<Record<string, number>> = ${JSON.stringify(Object.fromEntries(entries.map(c => [c.artifactId, c.srsPoints])), null, 2)};\n`);
}
for (const [relative, content] of outputs) {
  if (relative.endsWith(".rs")) outputs.set(relative, formatRust(content));
}

let noirProtocol = header("assets/domain_tags.json");
noirProtocol += "// PCASH protocol domain tags.\n\n";
// Tags that only off-circuit code hashes under: the genesis parent, contract
// addresses, the arena and output-data hashes, nullifier-tree leaves and
// transaction IDs. They stay in the authoritative asset and the off-circuit
// outputs only.
const offCircuitProtocolTags = new Set([
  "GENESIS_PARENT_DOMAIN",
  "CONTRACT_ADDRESS_DOMAIN",
  "ACCOUNT_CREATION_ATTACHMENT_DOMAIN",
  "ARENA_HASH_DOMAIN",
  "OUTPUT_DATA_HASH_DOMAIN",
  "NULLIFIER_LEAF_DOMAIN",
  "TRANSACTION_ID_DOMAIN",
]);
for (const [name, value] of Object.entries(protocol.tags)) {
  if (offCircuitProtocolTags.has(name)) continue;
  noirProtocol += noirGlobal(name, "Field", value, { pub: true });
}
outputs.set("circuits/protocol/lib/src/generated/pcash_constants.nr", noirProtocol);

let noirReference = header("assets/reference_rule_profile.json", "assets/private_value_profiles.json", "sdk/src/rules/semanticRuleTypes.ts");
noirReference += "// Optional reference-account-rule constants.\n\n";
// Fungible-asset metadata is hashed off-circuit only.
const offCircuitReferenceTags = new Set(["REFERENCE_FUNGIBLE_METADATA_DOMAIN"]);
for (const [name, value] of Object.entries(reference.tags)) {
  if (offCircuitReferenceTags.has(name)) continue;
  noirReference += noirGlobal(name, "Field", value, { pub: true });
}
noirReference += "\n// keccak256 of each profiled rule message's EIP-712 type string.\n";
for (const [name, hash] of applicationTypeHashes(profiles)) {
  noirReference += noirGlobal(name, "[u8; 32]", byteArray(hash), { pub: true });
}
outputs.set("circuits/rules/lib/src/generated/reference_rule_constants.nr", noirReference);

let tsProtocol = header("assets/domain_tags.json");
tsProtocol += "// PCASH protocol domain tags.\n\n";
for (const [name, value] of Object.entries(protocol.tags)) {
  tsProtocol += `export const ${name} = ${value}n;\n`;
}
outputs.set("sdk/src/constants/domainTags.ts", tsProtocol);

let tsReference = header("assets/reference_rule_profile.json");
tsReference += "// Optional reference-account-rule constants.\n\n";
for (const [name, value] of Object.entries(reference.tags)) {
  tsReference += `export const ${name} = ${value}n;\n`;
}
outputs.set("sdk/src/constants/referenceRuleConstants.ts", tsReference);

const rustConstants = (tags) => Object.entries(tags)
  .map(([name, value]) => `pub const ${name}: Fr = MontFp!("${decimal(value)}");`)
  .join("\n");

let rustProtocol = header("assets/domain_tags.json");
rustProtocol += `//! PCASH protocol domain-tag field constants.\n\nuse crate::Fr;\nuse alloy_primitives::{keccak256, B256};\nuse ark_ff::MontFp;\nuse sha2::{Digest as _, Sha256};\n\n${rustConstants(protocol.tags)}\n\n`;
rustProtocol += `/// Protocol field-domain tags in generator order.\npub const FIELD_DOMAIN_TAGS: &[(&str, Fr)] = &[\n`;
for (const name of Object.keys(protocol.tags)) {
  rustProtocol += `    ("${name}", ${name}),\n`;
}
rustProtocol += `];\n\n`;
rustProtocol += `/// SHA-256 commitment to the complete protocol field-domain table.
pub fn profile_digest() -> B256 {
    let mut entries = FIELD_DOMAIN_TAGS
        .iter()
        .map(|(name, value)| {
            let label = format!("pcash.field-domain-tag.{name}");
            (keccak256(label.as_bytes()), crate::fr_to_bytes(*value))
        })
        .collect::<Vec<_>>();
    entries.sort_unstable_by_key(|(tag, _)| *tag);

    let mut h = Sha256::new();
    h.update(keccak256(b"pcash.field-domain-tags"));
    let mut count = B256::ZERO;
    count[30..].copy_from_slice(&(entries.len() as u16).to_be_bytes());
    h.update(count);
    for (tag, value) in entries {
        h.update(tag);
        h.update(value);
    }
    B256::from(<[u8; 32]>::from(h.finalize()))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod profile_tests {
    use super::*;
    use alloy_primitives::b256;

    #[test]
    fn field_domain_profile_matches_generated_asset() {
        assert_eq!(
            profile_digest(),
            b256!("${protocol.fieldDomainProfileDigest}")
        );
    }

    #[test]
    fn domain_tags_are_nonzero_and_unique() {
        use std::collections::HashSet;
        use ark_ff::Zero;

        let mut names = HashSet::new();
        let mut values = HashSet::new();

        for &(name, value) in FIELD_DOMAIN_TAGS {
            assert!(!name.is_empty(), "tag name must not be empty");
            assert!(names.insert(name), "duplicate domain tag name: {name}");
            assert!(!value.is_zero(), "domain tag {name} must not be zero");
            assert!(values.insert(value), "duplicate domain tag value for: {name}");
        }
    }
}
`;
outputs.set("node/crates/crypto/src/domain_tags.rs", formatRust(rustProtocol));

let rustReference = header("assets/reference_rule_profile.json");
rustReference += "//! Optional reference-account-rule constants used by source verification.\n\nuse pcash_crypto::Fr;\n\n";
rustReference += `const REFERENCE_CONFIGURATION_DOMAIN_BYTES: [u8; 32] = [${bytes(reference.tags.REFERENCE_CONFIGURATION_DOMAIN).join(", ")}];\n`;
rustReference += "\npub(crate) fn reference_configuration_domain() -> Fr {\n    pcash_state::fr_from_internal_word(REFERENCE_CONFIGURATION_DOMAIN_BYTES.into())\n}\n";
outputs.set("node/crates/pscan/src/reference_rules.rs", formatRust(rustReference));

await runGenerator(import.meta, outputs);
