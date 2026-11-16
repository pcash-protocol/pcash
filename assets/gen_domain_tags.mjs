// PCASH protocol domain-tag generator.
//
//   DOMAIN = poseidon(uint64(L), chunk_0, ..., chunk_(m-1))
//
// over the L bytes of "pcash." || context_string in 16-byte big-endian chunks:
// the poseidonBytes encoding without a leading domain.
//
// Deterministic: running this script regenerates assets/domain_tags.json and
// assets/reference_rule_profile.json byte-for-byte from the context tables
// below.
//
// Run:  node assets/gen_domain_tags.mjs
// Verify (no write):  node assets/gen_domain_tags.mjs --check

import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { BN254_SCALAR_MODULUS as P } from "../sdk/src/crypto/field.ts";
import { domainTag } from "../sdk/src/crypto/poseidon2.ts";
import { runGenerator } from "../scripts/generated_files.mjs";

const DOMAIN_PREFIX = "pcash.";
const FORMULA = 'poseidon(uint64(L), chunk_0, ..., chunk_(m-1)) over the L bytes of "pcash." || context_string';
// Protocol domain-tag table: constant name -> context string. The order fixes
// only the generated files' layout; neither the tag values nor the profile
// digest depend on it.
const CONTEXTS = {
  NULLIFIER_KEY_COMMITMENT_DOMAIN: "nullifier_key_commitment",
  NOTE_NULLIFIER_KEY_DOMAIN: "note_nullifier_key",
  PAYOUT_SEED_DOMAIN: "payout_seed",
  PAYOUT_TX_CONTEXT_DOMAIN: "payout_tx_context",
  PAYOUT_NOTE_SECRET_DOMAIN: "payout_note_secret",
  OWNER_COMMITMENT_DOMAIN: "owner_commitment",
  NOTE_BODY_COMMITMENT_DOMAIN: "note_body_commitment",
  OUTPUT_COMMITMENT_DOMAIN: "output_commitment",
  NULLIFIER_DOMAIN: "nullifier",
  DUMMY_NULLIFIER_DOMAIN: "dummy_nullifier",
  APPLICATION_NULLIFIER_DOMAIN: "application_nullifier",
  ASSET_ID_DOMAIN: "asset_id",
  ASSET_SECRET_COMMITMENT_DOMAIN: "asset_secret_commitment",
  ASSET_CREATION_MARKER_DOMAIN: "asset_creation_marker",
  CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN: "contract_fee_sponsorship_action",
  IMPLICIT_NOTE_SECRET_SEED_DOMAIN: "implicit_note_secret_seed",
  TRANSACT_NOTE_SECRET_DOMAIN: "transact_note_secret",
  EVENT_DOMAIN: "transaction_events",
  EVENT_ENTRY_DOMAIN: "transaction_event_entry",
  PRIVATE_VALUE_COMMITMENT_DOMAIN: "private_value_commitment",
  OUTPUT_DATA_HASH_DOMAIN: "output_data_hash",
  ARENA_HASH_DOMAIN: "arena_hash",
  DELIVERY_COMMITMENT_DOMAIN: "delivery_commitment",
  ACCOUNT_CREATION_ATTACHMENT_DOMAIN: "account_creation_attachment",
  STATE_COMMITMENT_DOMAIN: "state_commitment",
  BLOCK_HEADER_DOMAIN: "block_header",
  GENESIS_PARENT_DOMAIN: "genesis_parent",
  L1_ORIGIN_DOMAIN: "l1_origin",
  L1_LOG_DOMAIN: "l1_log",
  HISTORY_LEAF_DOMAIN: "history_leaf",
  NULLIFIER_LEAF_DOMAIN: "nullifier_leaf",
  TRANSACTION_STATEMENT_DOMAIN: "transaction_statement",
  TRANSACTION_RESULT_DOMAIN: "transaction_result",
  PAYOUT_RESULT_DOMAIN: "payout_result",
  TRANSACTION_RESULTS_ROOT_DOMAIN: "transaction_results_root",
  TRANSACTION_ID_DOMAIN: "transaction_id",
  AUTHORIZATION_COMMITMENT_DOMAIN: "authorization_commitment",
  TRANSFER_ACTION_DOMAIN: "transfer_action",
  ASSET_CREATION_ACTION_DOMAIN: "asset_creation_action",
  SPONSORED_TRANSFER_ACTION_DOMAIN: "sponsored_transfer_action",
  ACCOUNT_UPDATE_ACTION_DOMAIN: "account_update_action",
  ACCOUNT_UPDATE_COMMITMENT_DOMAIN: "account_update_commitment",
  ACCOUNT_STATE_COMMITMENT_DOMAIN: "account_state_commitment",
  RECEIVE_KEY_HASH_DOMAIN: "receive_key_hash",
  ACCOUNT_RULE_ENTRY_DOMAIN: "account_rule_entry",
  CONTRACT_ADDRESS_DOMAIN: "contract_address",
  CARRIER_CONTEXT_DOMAIN: "carrier_context",
};

// Optional reference-rule profile. These constants are not interpreted by the
// PCASH state transition or protocol circuits.
const REFERENCE_CONTEXTS = {
  REFERENCE_CONFIGURATION_DOMAIN: "configuration",
  REFERENCE_MULTISIG_APPROVAL_DOMAIN: "multisig_approval",
  REFERENCE_ASSET_CONFIGURATION_DOMAIN: "asset_configuration",
  REFERENCE_FUNGIBLE_METADATA_DOMAIN: "fungible_metadata",
};

const utf8 = (s) => new TextEncoder().encode(s);
const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toHex32 = (x) => "0x" + x.toString(16).padStart(64, "0");

function assertUniqueDomainRegistries() {
  const contextOwners = new Map();
  const tagOwners = new Map();
  for (const [registry, contexts] of [
    ["protocol", CONTEXTS],
    ["reference", REFERENCE_CONTEXTS],
  ]) {
    for (const [name, context] of Object.entries(contexts)) {
      const owner = `${registry}.${name}`;
      const previousContextOwner = contextOwners.get(context);
      if (previousContextOwner !== undefined) {
        throw new Error(
          `duplicate domain context ${JSON.stringify(context)} in ${previousContextOwner} and ${owner}`,
        );
      }
      contextOwners.set(context, owner);

      const tag = toHex32(domainTag(context));
      const previousTagOwner = tagOwners.get(tag);
      if (previousTagOwner !== undefined) {
        throw new Error(`duplicate field domain tag ${tag} in ${previousTagOwner} and ${owner}`);
      }
      tagOwners.set(tag, owner);
    }
  }
}

assertUniqueDomainRegistries();

const tags = {};
for (const [name, ctx] of Object.entries(CONTEXTS)) {
  tags[name] = toHex32(domainTag(ctx));
}

function fieldDomainProfileDigest() {
  const entries = Object.entries(tags)
    .map(([name, value]) => ({
      tag: keccak_256(utf8(`pcash.field-domain-tag.${name}`)),
      value: Uint8Array.from(Buffer.from(value.slice(2), "hex")),
    }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.tag), Buffer.from(b.tag)));
  const count = new Uint8Array(32);
  count[30] = (entries.length >>> 8) & 0xff;
  count[31] = entries.length & 0xff;
  return hex(sha256(concatBytes(
    keccak_256(utf8("pcash.field-domain-tags")),
    count,
    ...entries.flatMap(({ tag, value }) => [tag, value]),
  )));
}

const protocolAsset = {
  domainPrefix: DOMAIN_PREFIX,
  fieldModulus: toHex32(P),
  formula: FORMULA,
  fieldDomainProfileDigest: fieldDomainProfileDigest(),
  tags,
};

const referenceTags = Object.fromEntries(
  Object.entries(REFERENCE_CONTEXTS).map(([name, context]) => [name, toHex32(domainTag(context))]),
);
const referenceAsset = {
  profile: "pcash-reference-account-rules",
  status: "optional application profile",
  domainPrefix: DOMAIN_PREFIX,
  fieldModulus: toHex32(P),
  formula: FORMULA,
  tags: referenceTags,
};

export const outputs = new Map([
  ["assets/domain_tags.json", JSON.stringify(protocolAsset, null, 2) + "\n"],
  ["assets/reference_rule_profile.json", JSON.stringify(referenceAsset, null, 2) + "\n"],
]);
await runGenerator(import.meta, outputs);
