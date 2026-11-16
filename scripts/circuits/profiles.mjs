// Compile-time private-value dimensions. This module does not select release
// proof sizes or keys: those must be measured from the resulting circuits.
import { PROFILE_SOURCE } from "./profile_config.mjs";
import { circuitCatalog } from "./catalog.mjs";
export { PROFILE_SOURCE, privateValueProfiles, readPrivateValueProfiles } from "./profile_config.mjs";
import { wrapperSource } from "./wrappers.mjs";
import { generatedHeader } from "../generated_files.mjs";
import { noirGlobal } from "../noir_layout.mjs";

const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export function profileOutputs(profiles, catalog = circuitCatalog()) {
  const header = generatedHeader("scripts/circuits/gen_constants.mjs", [PROFILE_SOURCE]);
  const maxInputs = Math.max(...profiles.map(p => p.inputs));
  const maxOutputs = Math.max(...profiles.map(p => p.outputs));
  let noir = header + noirGlobal("MAX_INPUTS", "u32", maxInputs, { pub: true })
    + noirGlobal("MAX_OUTPUTS", "u32", maxOutputs, { pub: true });
  for (const profile of profiles) {
    for (const field of ["shapeId", "inputs", "outputs", "publicInputs"]) {
      noir += noirGlobal(`${profile.name}_${snake(field).toUpperCase()}`, "u32", profile[field], { pub: true });
    }
  }
  const ts = header + `export const PRIVATE_VALUE_MAX_INPUTS = ${maxInputs};\nexport const PRIVATE_VALUE_MAX_OUTPUTS = ${maxOutputs};\nexport const PRIVATE_VALUE_PROFILES = ${JSON.stringify(Object.fromEntries(profiles.map((p) => [p.name, p])), null, 2)} as const;\n\n`
    + `export type PrivateValueShape = (typeof PRIVATE_VALUE_PROFILES)[keyof typeof PRIVATE_VALUE_PROFILES]["shapeId"];\n`
    + `export type PrivateValueProfile = (typeof PRIVATE_VALUE_PROFILES)[keyof typeof PRIVATE_VALUE_PROFILES];\n\n`
    + `/** Decode a client/L1-supplied shape selector, never vector lengths. */\n`
    + `export function privateValueProfile(shape: number): PrivateValueProfile {\n`
    + `  switch (shape) {\n${profiles.map((p) => `    case ${p.shapeId}: return PRIVATE_VALUE_PROFILES.${p.name};`).join("\n")}\n`
    + `    default: throw new Error(\x60unknown private-value shape \${shape}\x60);\n  }\n}\n`;
  let rust = header + `#[derive(Clone, Copy, Debug, PartialEq, Eq)]\npub struct PrivateValueProfile {\n`;
  for (const field of ["shapeId", "inputs", "outputs", "publicInputs", "wireInputs", "arenaBytes"]) {
    rust += `    pub ${snake(field)}: ${field === "shapeId" ? "u8" : "usize"},\n`;
  }
  for (const key of Object.keys(profiles[0].offsets).filter(key => key !== "eventsCommitment")) rust += `    pub ${snake(key)}_offset: usize,\n`;
  rust += `}\n\n`;
  for (const p of profiles) {
    rust += `pub const ${p.name}: PrivateValueProfile = PrivateValueProfile {\n`;
    for (const field of ["shapeId", "inputs", "outputs", "publicInputs", "wireInputs", "arenaBytes"]) rust += `    ${snake(field)}: ${p[field]},\n`;
    for (const [key, offset] of Object.entries(p.offsets).filter(([key]) => key !== "eventsCommitment")) rust += `    ${snake(key)}_offset: ${offset},\n`;
    rust += `};\n\n`;
  }
  rust += `pub const fn private_value_profile(shape: u8) -> Option<PrivateValueProfile> {\n    match shape {\n`
    + profiles.map((p) => `        ${p.shapeId} => Some(${p.name}),`).join("\n")
    + `\n        _ => None,\n    }\n}\n`;
  rust += `\n#[derive(Clone, Copy, Debug, PartialEq, Eq)]\n#[repr(u8)]\npub enum PrivateValueShape {\n`
    + profiles.map((p) => `    ${p.name} = ${p.shapeId},`).join("\n")
    + `\n}\nimpl PrivateValueShape {\n    pub const fn from_wire_byte(value: u8) -> Option<Self> {\n        match value {\n`
    + profiles.map((p) => `            ${p.shapeId} => Some(Self::${p.name}),`).join("\n")
    + `\n            _ => None,\n        }\n    }\n    pub const fn profile(self) -> PrivateValueProfile {\n        match self {\n`
    + profiles.map((p) => `            Self::${p.name} => ${p.name},`).join("\n")
    + `\n        }\n    }\n}\n`;
  return new Map([
    ["circuits/protocol/lib/src/generated/private_value_profiles.nr", noir],
    ["sdk/src/constants/privateValueProfiles.ts", ts],
    ["node/crates/derive/src/private_value_profiles.rs", rust],
    ...profiles.flatMap(profile => catalog
      .filter(circuit => circuit.profile === profile.name && circuit.wrapper !== undefined)
      .map(circuit => {
        // Pin constants of the circuits the wrapper folds, from its declared links.
        const pins = circuit.links.flatMap((link) => link.folds === "application" ? [] : link.folds)
          .map((name) => catalog.find((entry) => entry.packageName === name).pin);
        const source = wrapperSource(circuit.wrapper, profile, pins);
        // The manifest selects a known generator for each concrete profile.
        if (source === undefined) throw new Error(`${circuit.releaseId}: unknown wrapper ${circuit.wrapper}`);
        return [`${circuit.packagePath}/src/main.nr`, source];
      })),
  ]);
}
