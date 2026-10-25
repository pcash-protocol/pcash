import { toField } from "@pcash/sdk/crypto";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { defineRecordSchema, eventsCommitment, packed } from "@pcash/sdk/protocol";
import { outputCommitment } from "@pcash/sdk/protocol";
import { verifyResultProof, type ResultPosition, type ResultProofRpc } from "@pcash/sdk/clients";
import { claimEvent, type LineagePolicy } from "./policy.ts";

/** Application evidence only; ownership and spendability remain the wallet's responsibility. */
export interface Handoff { salt: bigint; qualificationMask: number; outputSlot: number }
/**
 * The event opening in each qualified output holder's arena region, identical
 * for every qualified output: salt ‖ qualified output slots. The receiver
 * supplies the policy root and application VK from its own trust context and
 * the output slot from its envelope.
 */
export const handoffSchema = defineRecordSchema("org.pcash.lineage", packed.struct({
  salt: packed.field,
  qualificationMask: packed.u8,
}));
function qualified(qualificationMask: number, outputSlot: number): boolean {
  const outputs = PRIVATE_VALUE_PROFILES.S.outputs;
  return qualificationMask < 1 << outputs && Number.isInteger(outputSlot) && outputSlot >= 0 && outputSlot < outputs && (qualificationMask & (1 << outputSlot)) !== 0;
}

/** The receiver trusts a recent header, policy root and application VK, never the sending holder. `outputSlot` is its note's slot from its envelope. */
export function verifyHandoff(params: {
  handoff: Pick<Handoff, "salt" | "qualificationMask">; outputSlot: number; proof: ResultProofRpc; recentHash: bigint; blockNumber: bigint;
  position: ResultPosition; noteCommitment: bigint; policy: LineagePolicy; trustedVk: bigint;
}): Handoff {
  const { salt, qualificationMask } = params.handoff;
  verifyResultProof(params.proof, params.recentHash, params.blockNumber, params.position);
  const leaf = params.proof.leaf;
  const profile = PRIVATE_VALUE_PROFILES.S;
  if (leaf.kind !== "transaction" || leaf.txType !== 0 || leaf.fundingMode !== 0 || leaf.outcome !== 0 || leaf.statement === null || leaf.statement.words.length !== profile.publicInputs) throw new Error("lineage requires a successful S transfer");
  if (!qualified(qualificationMask, params.outputSlot)) throw new Error("unqualified output slot");
  const words = leaf.statement.words.map(value => toField(value));
  const event = claimEvent({ root: params.policy.root, applicationVkHash: params.trustedVk, qualificationMask });
  if (words[profile.offsets.eventsCommitment] !== eventsCommitment(salt, { applicationVkHash: params.trustedVk, event })) throw new Error("forged event opening");
  const index = BigInt(leaf.outputStartIndex) + BigInt(params.outputSlot);
  if (outputCommitment(words[profile.offsets.outputs + params.outputSlot]!, index) !== params.noteCommitment) throw new Error("claim belongs to another output");
  params.policy.denyWitness(params.noteCommitment);
  return { salt, qualificationMask, outputSlot: params.outputSlot };
}

/** Missing evidence never changes a note's spendability. This store holds only provenance. */
export class LineageStore {
  private records = new Map<string, Handoff>();
  record(commitment: bigint, verified: Handoff): void { this.records.set(commitment.toString(), { ...verified }); }
  get(commitment: bigint): Handoff | undefined {
    const value = this.records.get(commitment.toString());
    return value === undefined ? undefined : { ...value };
  }
  /** JSON entries [commitment, record hex, output slot]. */
  export(): string { return JSON.stringify([...this.records].map(([commitment, handoff]) => [commitment, hex(handoffSchema.encode(handoff).data), handoff.outputSlot])); }
  static restore(backup: string): LineageStore {
    const store = new LineageStore();
    const records: unknown = JSON.parse(backup);
    if (!Array.isArray(records)) throw new Error("invalid lineage backup");
    for (const entry of records) {
      if (!Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== "string" || typeof entry[1] !== "string" || !/^(?:[0-9a-f]{2})+$/.test(entry[1])) throw new Error("invalid lineage backup entry");
      const record = handoffSchema.decode(Uint8Array.from(entry[1].match(/../g)!, byte => Number.parseInt(byte, 16)));
      if (typeof entry[2] !== "number" || !qualified(record.qualificationMask, entry[2])) throw new Error("invalid lineage backup entry");
      store.record(toField(BigInt(entry[0])), { ...record, outputSlot: entry[2] });
    }
    return store;
  }
}
function hex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""); }
