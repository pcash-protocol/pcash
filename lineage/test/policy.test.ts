import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPolicy, gapLeaf, claimEvent } from "../src/policy.ts";
import { rootFromIndex } from "@pcash/sdk/crypto";
import { handoffSchema, LineageStore } from "../src/handoff.ts";
import { ancestryGrowth } from "../src/growth.ts";

test("deny gaps exclude exact hits and cover edges and intermediate values", () => {
  const policy = buildPolicy(9n, [100n, 101n], [10n, 20n]);
  for (const value of [0n, 9n, 11n, 19n, 21n]) {
    const witness = policy.denyWitness(value);
    assert.equal(rootFromIndex(gapLeaf(witness), witness.leafIndex, witness.siblings), policy.gapTree.root);
  }
  for (const value of [10n, 20n]) assert.throws(() => policy.denyWitness(value), /denied/);
  assert.throws(() => policy.sourceWitness(102n), /unapproved/);
});

test("claim binds policy, application and output slots", () => {
  const base = { root: 1n, applicationVkHash: 2n, qualificationMask: 3 };
  const expected = claimEvent(base);
  for (const changed of [{ ...base, root: 2n }, { ...base, applicationVkHash: 3n }, { ...base, qualificationMask: 2 }]) assert.notEqual(claimEvent(changed), expected);
});

test("handoff and provenance-only backup round trip without predecessor secrets", () => {
  const handoff = { salt: 4n, qualificationMask: 3, outputSlot: 1 };
  const { data } = handoffSchema.encode(handoff);
  // salt (32) ‖ mask (1): a struct with no flag or optional field has no bitmap byte.
  assert.deepEqual(data, Uint8Array.of(...new Uint8Array(31), 4, 3));
  assert.deepEqual(handoffSchema.decode(data), { salt: 4n, qualificationMask: 3 });
  const store = new LineageStore(); store.record(99n, handoff);
  assert.deepEqual(LineageStore.restore(store.export()).get(99n), handoff);
  assert.equal(new LineageStore().get(99n), undefined);
  assert.throws(() => handoffSchema.decode(data.slice(1)));
  assert.throws(() => handoffSchema.decode(Uint8Array.of(...data, 0)), /trailing/);
  assert.throws(() => handoffSchema.decode(new Uint8Array(33).fill(0xff).fill(3, 32)), /field element/);
  const [[commitment, record]] = JSON.parse(store.export()) as [string, string, number][];
  assert.throws(() => LineageStore.restore('[["99", "broken", 1]]'), /invalid/);
  for (const slot of [2, 5, 1.5, "1"]) assert.throws(() => LineageStore.restore(JSON.stringify([[commitment, record, slot]])), /invalid/);
  // Slot 0 is set, but a mask naming a slot past the S outputs is not a lineage claim.
  assert.throws(() => LineageStore.restore(JSON.stringify([[commitment, `${record.slice(0, 64)}21`, 0]])), /invalid/);
});

test("mixing grows ancestry unions while one-input transfers retain one source", () => {
  const one = ancestryGrowth({ population: 32, rounds: 8, fanIn: 1, seed: 703 });
  const four = ancestryGrowth({ population: 32, rounds: 8, fanIn: 4, seed: 703 });
  assert.equal(one.samples.at(-1)!.meanSources, 1);
  assert.ok(four.samples.at(-1)!.meanSources > 20);
  assert.ok(four.samples.at(-1)!.meanHopProofs > one.samples.at(-1)!.meanHopProofs);
});
