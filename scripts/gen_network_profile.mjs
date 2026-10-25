// Generate the circuit signing profile and the default deployment profile from
// assets/network_profile.json. The reference rules library receives the
// account-update EIP-712 type hash, TypeScript the EIP-712 strings, and
// TypeScript and Rust the operator-facing default network values.
//
// Run:         node scripts/gen_network_profile.mjs
// Verify only: node scripts/gen_network_profile.mjs --check

import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { generatedHeader, runGenerator } from "./generated_files.mjs";
import { byteArray, noirGlobal } from "./noir_layout.mjs";
import { networkProfile as profile, networks } from "./network_profile.mjs";

const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
};
exactKeys(profile, ["defaultNetwork", "networks", "eip712"], "profile");
exactKeys(profile.eip712, ["name", "version", "domainType", "userAccountCreationType", "userAccountUpdateType"], "eip712");

for (const [name, value] of Object.entries(profile.eip712)) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`eip712.${name} must be nonempty`);
}
const typeStrings = [
  profile.eip712.domainType,
  profile.eip712.userAccountCreationType,
  profile.eip712.userAccountUpdateType,
];
if (new Set(typeStrings).size !== typeStrings.length) throw new Error("EIP-712 type strings must be distinct");

const utf8 = (s) => new TextEncoder().encode(s);
// The admin rule signs account updates under this type. Rules commit the
// domain separator itself, so Noir needs no domain hashes.
const hashes = {
  USER_ACCOUNT_UPDATE_TYPE_HASH: keccak_256(utf8(profile.eip712.userAccountUpdateType)),
};
const jsonString = (value) => JSON.stringify(value);
const rustInteger = (value) => value.toString().replace(/(?<!^)(?=(?:\d{3})+$)/g, "_");
const header = generatedHeader("scripts/gen_network_profile.mjs", ["assets/network_profile.json"]);

let noir = header;
for (const [name, value] of Object.entries(hashes)) noir += `\n${noirGlobal(name, "[u8; 32]", byteArray(value), { pub: true })}`;

let typescript = header;
typescript += "\nexport const NETWORKS = {\n";
for (const [name, network] of Object.entries(networks)) {
  typescript += `  ${name}: {\n`;
  typescript += `    pcashChainId: ${network.pcashChainId}n,\n`;
  typescript += `    l1ChainId: ${network.l1ChainId}n,\n`;
  typescript += `    inboxAddress: ${network.inboxAddress}n,\n`;
  typescript += "  },\n";
}
typescript += "} as const;\n";
typescript += `\nexport const DEFAULT_NETWORK = NETWORKS.${profile.defaultNetwork};\n`;
typescript += `export const {\n  pcashChainId: PCASH_CHAIN_ID,\n  l1ChainId: L1_CHAIN_ID,\n  inboxAddress: INBOX_ADDRESS,\n} = DEFAULT_NETWORK;\n\n`;
typescript += `export const PCASH_DOMAIN_NAME = ${jsonString(profile.eip712.name)};\n`;
typescript += `export const PCASH_DOMAIN_VERSION = ${jsonString(profile.eip712.version)};\n`;
typescript += `export const DOMAIN_TYPE = ${jsonString(profile.eip712.domainType)};\n`;
typescript += `export const USER_ACCOUNT_CREATION_TYPE = ${jsonString(profile.eip712.userAccountCreationType)};\n`;
typescript += `export const USER_ACCOUNT_UPDATE_TYPE = ${jsonString(profile.eip712.userAccountUpdateType)};\n`;

const variant = (name) => name[0].toUpperCase() + name.slice(1);
const rustStart = "// BEGIN GENERATED NETWORK IDENTITIES (scripts/gen_network_profile.mjs)";
const rustEnd = "// END GENERATED NETWORK IDENTITIES";
let rustIdentities = `${rustStart}\n`;
rustIdentities += `pub const DEFAULT_NETWORK: Network = Network::${variant(profile.defaultNetwork)};\n`;
rustIdentities += "pub const PCASH_CHAIN_ID: u32 = DEFAULT_NETWORK.identity().0;\n";
rustIdentities += "pub const L1_CHAIN_ID: u64 = DEFAULT_NETWORK.identity().1;\n";
rustIdentities += "pub const DEFAULT_INBOX: Address = DEFAULT_NETWORK.identity().2;\n\n";
rustIdentities += "impl Network {\n    pub const fn identity(self) -> (u32, u64, Address) {\n        match self {\n";
for (const [name, network] of Object.entries(networks)) {
  rustIdentities += `            Self::${variant(name)} => (\n`;
  rustIdentities += `                ${rustInteger(network.pcashChainId)},\n`;
  rustIdentities += `                ${rustInteger(network.l1ChainId)},\n`;
  rustIdentities += `                address!("${network.inboxAddress}"),\n`;
  rustIdentities += "            ),\n";
}
rustIdentities += `        }\n    }\n}\n${rustEnd}`;
const rustPath = "node/crates/node/src/networks.rs";
const rustSource = readFileSync(new URL(`../${rustPath}`, import.meta.url), "utf8");
const start = rustSource.indexOf(rustStart);
const end = rustSource.indexOf(rustEnd, start);
if (start < 0 || end < 0) throw new Error(`${rustPath}: missing generated network identity markers`);
const rust = rustSource.slice(0, start) + rustIdentities + rustSource.slice(end + rustEnd.length);

export const outputs = new Map([
  ["circuits/rules/lib/src/generated/network_profile.nr", noir],
  ["sdk/src/constants/networkProfile.ts", typescript],
  [rustPath, rust],
]);
await runGenerator(import.meta, outputs);
