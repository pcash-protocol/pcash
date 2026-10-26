// Shared compile-time profile metadata, independent of wrapper generation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROFILE_SOURCE = "assets/private_value_profiles.json";

export function readPrivateValueProfiles(root = fileURLToPath(new URL("../../", import.meta.url))) {
  return privateValueProfiles(JSON.parse(readFileSync(join(root, PROFILE_SOURCE), "utf8")));
}

export function privateValueProfiles(source) {
  // Build configuration is a trust boundary. Bounding slots also bounds
  // generated arrays and keeps all conservation intermediates below the field.
  if (!source || Object.keys(source).sort().join(",") !== "L,S") {
    throw new Error("private-value profiles must contain exactly S and L");
  }
  return ["S", "L"].map((name) => {
    const value = source[name];
    if (!value || Object.keys(value).sort().join(",") !== "inputs,outputs,shapeId"
      || value.shapeId !== (name === "S" ? 0 : 1)) {
      throw new Error(`${name} must define its assigned shapeId, inputs, and outputs`);
    }
    // Each output takes eight arena cells, and a cell index is one byte
    // (spec Appendix B.4), so a profile has at most 32 outputs.
    for (const [field, max] of [["inputs", 64], ["outputs", 32]]) {
      if (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > max) {
        throw new Error(`${name}.${field} must be an integer from 1 through ${max}`);
      }
    }
    const { shapeId, inputs, outputs } = value;
    const outputStart = 2 + inputs;
    const deliveryCommitment = outputStart + outputs;
    const openFeeAmount = deliveryCommitment + 1;
    return {
      name, shapeId, inputs, outputs,
      publicInputs: inputs + outputs + 10,
      wireInputs: inputs + outputs + 7,
      // A 32-byte salt plus 520 bytes per output: eight 65-byte cells.
      arenaBytes: 32 + 520 * outputs,
      offsets: { chainId: 0, recentBlockHash: 1, nullifiers: 2, outputs: outputStart,
        deliveryCommitment, openFeeAmount, issuanceOwner: openFeeAmount + 1,
        notBefore: openFeeAmount + 2, validUntil: openFeeAmount + 3, carrierContextHash: openFeeAmount + 4,
        eventsCommitment: openFeeAmount + 5, accountCreationCommitment: openFeeAmount + 6 },
    };
  });
}
