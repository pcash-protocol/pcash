// The application pins: the Mega VK hash of every account rule and external
// application in the circuit catalog. Rules are pinned in the SDK; each
// external owner's applications are pinned in that owner's module, and its
// callable contract functions are also pinned in contract manifests.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { generatedHeader } from "../generated_files.mjs";

export const RULE_PINS_PATH = "sdk/src/constants/rulePins.ts";

function externalApplications(catalog) {
  return catalog.filter((circuit) => circuit.owner !== "protocol");
}

// A contract directory holds its manifest.json and one package per function,
// named for the function.
function contractManifests(catalog) {
  return Map.groupBy(externalApplications(catalog).filter(circuit => circuit.contractManifest !== false), (circuit) => posix.join(posix.dirname(circuit.packagePath), "manifest.json"));
}

// Each external owner's own pin module.
function applicationPinModules(catalog) {
  return Map.groupBy(externalApplications(catalog), (circuit) => `${circuit.ownerRoot}/src/applicationPins.ts`);
}

/** The pin constant's name: rules by what they authorize, external applications by package. */
export function applicationPinName(circuit) {
  if (circuit.packageName === "no_op_event_application") return "NO_OP_EVENT_APPLICATION_VK_HASH";
  if (circuit.owner === "protocol") {
    return `${circuit.packageName.replace(/^account_rule_/, "").replace(/_ecdsa$/, "").toUpperCase()}_RULE_VK_HASH`;
  }
  return `${circuit.packageName.toUpperCase()}_APPLICATION_VK_HASH`;
}

function pinModule(circuits, manifest, hashes) {
  return generatedHeader("scripts/circuits/gen_release_pins.mjs", [manifest, "the circuit bundle"])
    + circuits.map((circuit) => `\n/** Mega VK hash of \`${circuit.packageName}\`. */\n`
      + `export const ${applicationPinName(circuit)} = ${hashes.get(circuit.packageName)}n;\n`).join("");
}

/**
 * The SDK's rule pin module. `hashes` maps package name to 0x-prefixed VK hash.
 * The no-op event-application identity is an SDK default, not a consensus pin.
 */
export function rulePinsSource(catalog, hashes) {
  const rules = catalog.filter((circuit) => circuit.owner === "protocol" && circuit.role === "application"
    && circuit.pin === undefined);
  return pinModule(rules, "circuits/manifest.json", hashes);
}

/** Every file the application pins are written to. */
export function applicationPinPaths(catalog) {
  return [
    RULE_PINS_PATH,
    ...applicationPinModules(catalog).keys(),
    ...contractManifests(catalog).keys(),
  ];
}

/**
 * Each application pin file's text. A contract manifest under `root` keeps
 * every field but its functions' `applicationVkHash`.
 */
export function applicationPinOutputs(catalog, hashes, root) {
  const outputs = new Map([[RULE_PINS_PATH, rulePinsSource(catalog, hashes)]]);
  for (const [path, functions] of applicationPinModules(catalog)) {
    outputs.set(path, pinModule(functions, `${functions[0].ownerRoot}/circuits.json`, hashes));
  }
  for (const [path, functions] of contractManifests(catalog)) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    for (const circuit of functions) {
      manifest.functions.find((entry) => entry.name === posix.basename(circuit.packagePath))
        .applicationVkHash = hashes.get(circuit.packageName);
    }
    outputs.set(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return outputs;
}
