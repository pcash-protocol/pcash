// The protocol stack pins: each pinned circuit's Mega VK hash, compiled into
// the circuits that fold it (circuits/manifest.json declares the links).
import { writeFileSync } from "node:fs";
import { generatedHeader } from "../generated_files.mjs";
import { noirGlobal } from "../noir_layout.mjs";

export const STACK_PINS_PATH = "circuits/protocol/lib/src/generated/protocol_stack_hashes.nr";

/** Pinned circuits in dependency order: each after every pinned circuit it folds. */
function stackPinOrder(catalog) {
  const pinned = catalog.filter((circuit) => circuit.pin !== undefined);
  const folded = (circuit) => circuit.links.flatMap((link) => link.folds === "application" ? [] : link.folds);
  const ordered = [];
  const done = new Set();
  while (ordered.length < pinned.length) {
    const ready = pinned.filter((circuit) => !done.has(circuit.packageName)
      && folded(circuit).every((name) => done.has(name)));
    if (ready.length === 0) throw new Error("circuit links form a cycle");
    for (const circuit of ready) {
      ordered.push(circuit);
      done.add(circuit.packageName);
    }
  }
  return ordered;
}

/** The Noir source of the pin file; pins not yet derived are zero. */
export function stackPinsSource(catalog, hashes) {
  return generatedHeader("scripts/circuits/gen_release_pins.mjs", ["circuits/manifest.json", "the circuit bundle"])
    + "// Bundle generation derives each Mega VK hash in link order (scripts/circuits/stack_pins.mjs).\n\n"
    + catalog.filter((circuit) => circuit.pin !== undefined)
      .map((circuit) => noirGlobal(circuit.pin, "Field", hashes.get(circuit.packageName) ?? "0", { pub: true }))
      .join("");
}

/**
 * Derive every pin in dependency order into `file`. `vkHash(circuit)` compiles
 * the circuit against the pins written so far and returns its Mega VK hash.
 */
export function deriveStackPins(catalog, file, vkHash) {
  const hashes = new Map();
  for (const circuit of stackPinOrder(catalog)) {
    writeFileSync(file, stackPinsSource(catalog, hashes));
    hashes.set(circuit.packageName, vkHash(circuit));
  }
  writeFileSync(file, stackPinsSource(catalog, hashes));
  return hashes;
}
