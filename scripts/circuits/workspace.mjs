import { posix } from "node:path";
import { generatedHeader } from "../generated_files.mjs";

// Libraries are authored packages; executable packages come from the catalog.
export const CIRCUIT_LIBRARIES = {
  pcash_protocol: "protocol/lib",
  signature_common: "signature",
  reference_event_common: "fixtures/event_lib",
  reference_rule_common: "rules/lib",
};

export function workspaceOutputs(catalog) {
  const circuits = catalog.filter(circuit => circuit.owner === "protocol");
  const members = [...Object.values(CIRCUIT_LIBRARIES), ...circuits.map(circuit =>
    posix.relative("circuits", circuit.packagePath))].sort();
  const header = generatedHeader("scripts/circuits/gen_constants.mjs", ["circuits/manifest.json"], "#");
  const outputs = new Map([["circuits/Nargo.toml", header
    + `[workspace]\nmembers = [\n${members.map(path => `    "${path}",`).join("\n")}\n]\n`]]);
  for (const circuit of circuits) {
    const dependencies = circuit.dependencies.map(name => {
      // Dependency names are supplied by the build manifest, not by Noir code.
      const library = CIRCUIT_LIBRARIES[name];
      if (library === undefined) throw new Error(`${circuit.releaseId}: unknown library ${name}`);
      return `${name} = { path = "${posix.relative(circuit.packagePath, `circuits/${library}`)}" }`;
    });
    outputs.set(`${circuit.packagePath}/Nargo.toml`, header
      + `[package]\nname = "${circuit.packageName}"\ntype = "bin"\ncompiler_version = "=1.0.0"\n\n`
      + `[dependencies]\n${dependencies.join("\n")}\n`);
  }
  return outputs;
}
