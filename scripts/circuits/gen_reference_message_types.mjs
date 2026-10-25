// Pin Noir's EIP-712 type hashes to the reference SDK's readable message types.
// The generated profile wrappers carry their own type hashes (wrappers.mjs).
//
// Run:                node scripts/circuits/gen_reference_message_types.mjs
// Verify (no write):  node scripts/circuits/gen_reference_message_types.mjs --check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as readable from "../../sdk/src/rules/readableRules.ts";
import * as semantic from "../../sdk/src/rules/semanticRules.ts";
import { circuitCatalog } from "./catalog.mjs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { runGenerator } from "../generated_files.mjs";
import { byteArray, noirGlobal } from "../noir_layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = circuitCatalog(root);
const main = name => `${catalog.find(circuit => circuit.packageName === name).packagePath}/src/main.nr`;
const reclaimSource = fs.readFileSync(path.join(root, "marketplace/src/client/reclaimWitness.ts"), "utf8");
const reclaimType = reclaimSource.match(/export const MARKETPLACE_RECLAIM_EIP712_TYPE\s*=\s*"([^"]+)"/)?.[1];
if (!reclaimType) throw new Error("missing Marketplace reclaim type");
const entries = [
  [readable.PAYMENT_EIP712_TYPE, main("account_rule_payment_ecdsa"), "PAYMENT"],
  [readable.TRANSACTION_DETAIL_EIP712_TYPE, main("account_rule_full_ecdsa"), "TRANSACTION_DETAIL"],
  [semantic.ASSET_PAYMENT_EIP712_TYPE, main("account_rule_asset_payment_ecdsa"), "ASSET_PAYMENT"],
  [semantic.ASSET_BURN_EIP712_TYPE, main("account_rule_asset_burn_ecdsa"), "ASSET_BURN"],
  [semantic.CONTRACT_FEE_SPONSORSHIP_EIP712_TYPE, "circuits/rules/lib/src/contract_fee_sponsorship.nr", "CONTRACT_FEE_SPONSORSHIP"],
  [reclaimType, "marketplace/l2-contracts/escrow/reclaim/src/main.nr", "MARKETPLACE_RECLAIM"],
];

/** Each hand-written Noir file with its `<NAME>_TYPE_HASH` global set to the hash of the SDK's type string. */
export const outputs = new Map();
for (const [type, source, constant] of entries) {
  const hash = noirGlobal(`${constant}_TYPE_HASH`, "[u8; 32]", byteArray(keccak_256(new TextEncoder().encode(type))));
  const current = outputs.get(source) ?? fs.readFileSync(path.join(root, source), "utf8");
  const pattern = new RegExp(`global ${constant}_TYPE_HASH: \\[u8; 32\\] = \\[[\\s\\S]*?\\];`);
  if (!pattern.test(current)) throw new Error(`missing ${constant} Noir hash`);
  outputs.set(source, current.replace(pattern, hash.trimEnd()));
}
await runGenerator(import.meta, outputs);
