import assert from "node:assert/strict";
import { test } from "vitest";

import {
  memoryMaximumPages,
  normalizeProverThreads,
  srsPointsForCircuits,
  srsPointsForCircuitSize,
} from "../../src/prover/profile.ts";

test("browser SRS sizing follows the largest circuit in the selected proof plan", () => {
  assert.equal(srsPointsForCircuitSize(191_358), 2 ** 18);
  assert.equal(srsPointsForCircuitSize(1_285_028), 2 ** 21);
  assert.equal(srsPointsForCircuitSize(2_586_213), 2 ** 22);
  assert.equal(
    srsPointsForCircuits(["application", "kernel"], { application: 252_673, kernel: 29_888 }),
    2 ** 18,
  );
  assert.equal(
    srsPointsForCircuits(["claim", "kernel"], { claim: 2_586_213, kernel: 56_636 }),
    2 ** 22,
  );
});

test("browser SRS sizing rejects missing, empty, and unsupported profiles", () => {
  assert.throws(() => srsPointsForCircuitSize(0), /positive integer/);
  assert.throws(() => srsPointsForCircuitSize((2 ** 22) + 1), /exceeds/);
  assert.throws(() => srsPointsForCircuits([], {}), /at least one circuit/);
  assert.throws(() => srsPointsForCircuits(["missing"], {}), /missing gate count/);
});

test("browser prover threads are explicit, bounded, and capped by the device", () => {
  assert.equal(normalizeProverThreads("auto", 18), 8);
  assert.equal(normalizeProverThreads("auto", 2), 2);
  assert.equal(normalizeProverThreads(4, 2), 2);
  assert.equal(normalizeProverThreads(1, 8), 1);
  assert.throws(() => normalizeProverThreads(0, 8), /1 through 8/);
  assert.throws(() => normalizeProverThreads(9, 18), /1 through 8/);
});

test("browser Wasm memory ceilings convert MiB to 64 KiB pages", () => {
  assert.equal(memoryMaximumPages("auto"), undefined);
  assert.equal(memoryMaximumPages(256), 4_096);
  assert.equal(memoryMaximumPages(512), 8_192);
  assert.equal(memoryMaximumPages(768), 12_288);
  assert.equal(memoryMaximumPages(1024), 16_384);
  assert.throws(() => memoryMaximumPages(128), /256, 512, 768, or 1024/);
});
