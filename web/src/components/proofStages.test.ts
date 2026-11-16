import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import { describe, expect, it } from "vitest";
import { proofProgressMessage } from "./ProgressIndicator.tsx";
import { proofCompletion, proofStage, readProofTimings, recordProofTiming, type ProofTimings } from "./proofStages.ts";

const base = { phase: "proving", message: "", elapsedMs: 0 } as const;

/** Start updates for an N-circuit stack, in the order the browser prover sends them. */
function run(circuitCount: number): ProveStatus[] {
  const circuits = (step: "load" | "execute" | "prove") => Array.from({ length: circuitCount }, (_, circuitIndex): ProveStatus =>
    ({ ...base, step, ...(step === "load" ? {} : { scope: "circuit" as const }), circuit: `c${circuitIndex}`, circuitIndex, circuitCount }));
  const stack = (step: "prove" | "artifacts", operation: string): ProveStatus => ({ ...base, step, scope: "stack", operation, circuitCount });
  return [...circuits("load"), ...circuits("execute"), stack("prove", "start"), ...circuits("prove"), stack("prove", "finalize"), stack("artifacts", "compress")];
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

const throwingStorage = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
} as unknown as Storage;

describe("proof stages", () => {
  it("place every update of a four- or five-circuit stack in order", () => {
    for (const circuitCount of [4, 5]) {
      const stages = run(circuitCount).map(proofStage);
      expect(stages.map((stage) => stage?.index)).toEqual(Array.from({ length: 3 * circuitCount + 3 }, (_, index) => index));
      expect(stages.every((stage) => stage?.count === 3 * circuitCount + 3 && stage.completed === false)).toBe(true);
    }
  });

  it("ignore updates that belong to no stack", () => {
    expect(proofStage(undefined)).toBeUndefined();
    expect(proofStage({ ...base, step: "crs" })).toBeUndefined();
    expect(proofStage({ ...base, step: "prove", scope: "stack" })).toBeUndefined();
  });

  it("name the stage, the circuit and the stack size", () => {
    const messages = run(4).map(proofProgressMessage);
    expect(messages[0]).toBe("Loading the proof circuits…");
    expect(messages[5]).toBe("Running circuit 2 of 4…");
    expect(messages[8]).toBe("Starting the proof…");
    expect(messages[12]).toBe("Proving circuit 4 of 4…");
    expect(messages[13]).toBe("Finishing the proof. This step takes longest.");
    expect(messages[14]).toBe("Compressing the proof…");
    expect(proofProgressMessage({ ...base, step: "crs" })).toBe("Loading proving data. The first run can take longer.");
    expect(proofProgressMessage(undefined)).toBe("Generating your proof on this device. Keep this page open.");
  });
});

describe("proof completion", () => {
  it("grows through the run and stays below full until the proof completes", () => {
    const fractions = run(5).map((status) => proofCompletion(proofStage(status)!, 0, {}).fraction);
    expect(fractions.every((fraction, index) => index === 0 || fraction > fractions[index - 1]!)).toBe(true);
    const last = proofStage({ ...run(5).at(-1)!, durationMs: 1 })!;
    expect(proofCompletion(last, 0, {}).fraction).toBeLessThan(1);
  });

  it("estimates the time left only from this device's own measurements", () => {
    const finalize = proofStage(run(4)[13]!)!;
    expect(proofCompletion(finalize, 1_000, {}).remainingMs).toBeUndefined();
    const measured: ProofTimings = {
      load: 100, execute: 500, fold: 1_000, "start:4": 200, "finalize:4": 8_000, "compress:4": 1_000,
    };
    expect(proofCompletion(finalize, 1_000, measured).remainingMs).toBe(7_000 + 1_000);
  });

  it("holds the current operation short of done and drops the estimate when it overruns", () => {
    const measured: ProofTimings = {
      load: 100, execute: 500, fold: 1_000, "start:4": 200, "finalize:4": 8_000, "compress:4": 1_000,
    };
    const finalize = proofStage(run(4)[13]!)!;
    const overran = proofCompletion(finalize, 60_000, measured);
    expect(overran.remainingMs).toBeUndefined();
    expect(overran.fraction).toBeCloseTo((4 * 100 + 4 * 500 + 200 + 4 * 1_000 + 0.95 * 8_000) / 15_600);
  });
});

describe("proof timings", () => {
  it("record measured durations and average repeat measurements", () => {
    const storage = memoryStorage();
    const finalized = { ...run(4)[13]!, durationMs: 8_000 };
    recordProofTiming(finalized, storage);
    recordProofTiming({ ...finalized, durationMs: 6_000 }, storage);
    recordProofTiming(run(4)[13]!, storage);
    expect(readProofTimings(storage)).toEqual({ "finalize:4": 7_000 });
  });

  it("read as empty when storage is missing, blocked or malformed", () => {
    expect(readProofTimings(undefined)).toEqual({});
    expect(readProofTimings(throwingStorage)).toEqual({});
    expect(readProofTimings(memoryStorage({ "pcash:proof-timings": "not json" }))).toEqual({});
    expect(readProofTimings(memoryStorage({ "pcash:proof-timings": "{\"fold\":\"slow\",\"load\":-1}" }))).toEqual({});
    expect(() => recordProofTiming({ ...run(4)[13]!, durationMs: 1 }, throwingStorage)).not.toThrow();
  });
});
