import { purchaseCutoff } from "@pcash/marketplace/client";
import { describe, expect, it } from "vitest";
import {
  assertRichSeedEvidence,
  partitionSeedEntries,
  planSeedWaveCarriers,
  seedErrorKind,
  seedErrorSummary,
  SEED_MAX_BATCH_CALLDATA_BYTES,
  SEED_UNPAID_OFFER_DEADLINE_LEAD_SECONDS,
  type SeedEntry,
  type RichSeedResult,
} from "../src/seed/richSeed.ts";
import {
  EXCLUDED_CARRIER_CONTROLS,
  isItemExclusion,
  plannedOutcomes,
  seedFee,
  SEED_WAVE_COUNT,
  seedWave,
} from "../src/seed/richSeedPlan.ts";
import { MAX_TX_BYTES, TRANSACTION_OUTCOMES } from "@pcash/sdk/protocol";
import { MAX_PCASH_BATCH_BYTES } from "@pcash/sdk/l1";

describe("rich seed wave plan", () => {
  it("carries the oversized-item control in blobs, beyond the calldata budget", () => {
    const label = "control-item-too-large";
    const wave = Array.from({ length: SEED_WAVE_COUNT }, (_, index) => seedWave(index))
      .find((candidate) => candidate.entries.some((entry) => entry.label === label))!;
    expect(wave.entries.find((entry) => entry.label === label)?.carrier ?? wave.carrier).toBe("blobs");
    const entries = [{ label, entry: new Uint8Array(MAX_TX_BYTES + 1), contentHash: "0x00", expectedOutcome: "itemTooLarge" as const }];
    expect(() => partitionSeedEntries(entries)).toThrow(/cannot fit/);
    expect(partitionSeedEntries(entries, MAX_PCASH_BATCH_BYTES)).toEqual([entries]);
    expect(planSeedWaveCarriers(wave, entries)).toEqual([{ carrier: "blobs", entries }]);
  });

  it("declares a unique exact order and outcome for every wave entry", () => {
    for (let index = 0; index < SEED_WAVE_COUNT; index += 1) {
      const wave = seedWave(index);
      const labels = wave.entries.map((entry) => entry.label);
      expect(new Set(labels).size).toBe(labels.length);
      expect(wave.requiredLabels.every((label) => labels.includes(label))).toBe(true);
    }
    expect(() => seedWave(SEED_WAVE_COUNT)).toThrow(/unknown rich seed wave/);
  });

  it("creates contracts in both funding modes", () => {
    const outcomes = new Map(seedWave(0).entries.map((entry) => [entry.label, entry.expectedOutcome]));
    expect(outcomes.get("private-vault:contract")).toBe("succeeded");
    expect(outcomes.get("unfunded-vault:contract")).toBe("succeeded");
    expect(outcomes.get("control-contract-funding-mode")).toBe("unknownFundingMode");
  });

  it("waits for actor O before constructing its duplicate-account control", () => {
    expect(seedWave(0).requiredLabels).toContain("account-o");
    expect(seedWave(0).entries.map((entry) => [entry.label, entry.expectedOutcome])).toContainEqual([
      "control-account-already-exists",
      "accountAlreadyExists",
    ]);
  });

  it("orders precedence-sensitive controls before the entry whose state change would preempt them", () => {
    const position = (index: number, label: string) => seedWave(index).entries.findIndex((entry) => entry.label === label);
    expect(position(2, "control-proof-rejected")).toBeLessThan(position(2, "transfer-m-r"));
    expect(position(2, "control-transfer-output-byte-zero")).toBeLessThan(position(2, "transfer-m-r"));
    expect(position(2, "control-nullifier-reuse")).toBeGreaterThan(position(2, "transfer-m-r"));
    for (const label of ["control-update-proof-rejected", "control-update-commitment"]) {
      expect(position(4, label)).toBeLessThan(position(4, "update-r-receive-key"));
    }
    expect(seedWave(5).entries.map((entry) => entry.label)).toContain("control-update-identical-key");
  });

  it("accounts for every outcome, item exclusion, and carrier exclusion", () => {
    const outcomes = plannedOutcomes();
    const notSeeded = [
      "outputCapacity",
      "accountCapacity",
      "accountRevisionExhausted",
    ];
    const expected = [
      "succeeded", "publicInputNotInField", "recentPcashBlockNotInWindow", "expired", "notYetValid",
      "carrierContextMismatch", "zeroNullifier", "duplicateInputNullifier", "nullifierAlreadySpent", "proofRejected", "invalidAccountSignature",
      "accountNotFound", "accountAlreadyExists", "wrongAccountKind", "clearWithoutReceiveKey", "replaceWithIdenticalReceiveKey",
      "accountUpdateCommitmentMismatch", "nonCanonicalAccountField", "contractAddressExists",
      "nonCanonicalContractField", "emptyContractFunctionSet", "selectorsNotStrictlyIncreasing",
    ];
    expect([...expected, ...notSeeded].sort()).toEqual([...TRANSACTION_OUTCOMES].sort());
    for (const outcome of expected) expect(outcomes.has(outcome as never), outcome).toBe(true);
    for (const outcome of notSeeded) expect(outcomes.has(outcome as never), outcome).toBe(false);
    const exclusions = [...outcomes].filter(isItemExclusion);
    expect(exclusions.sort()).toEqual([
      "empty", "itemTooLarge", "trailingBytes", "truncated", "unknownFundingMode", "unknownKind", "unknownPublishesNkRootFlag",
      "unknownReceiveKeyMode", "unknownYParity", "wrongChainId",
    ]);
    expect(seedWave(2).entries.find((entry) => entry.label === "control-item-too-large")?.carrier).toBe("blobs");
    expect(seedWave(5).carrier).toBe("blobs");
    expect(EXCLUDED_CARRIER_CONTROLS.map((control) => control.reason)).toEqual(["unsupportedBatchVersion", "trailingBatchBytes"]);
  });

  it("keeps calldata at the conservative boundary and rejects one byte beyond it", () => {
    expect(SEED_MAX_BATCH_CALLDATA_BYTES).toBe(128_000);
    const seedEntry = (length: number): SeedEntry => ({
      label: "control-empty-item",
      entry: new Uint8Array(length),
      contentHash: "0x01",
      expectedOutcome: "empty",
    });
    expect(partitionSeedEntries([seedEntry(SEED_MAX_BATCH_CALLDATA_BYTES - 71)])).toHaveLength(1);
    expect(() => partitionSeedEntries([seedEntry(SEED_MAX_BATCH_CALLDATA_BYTES - 70)]))
      .toThrow(/cannot fit in one rich seed carrier transaction/);
  });

  it("splits the oversized item-only control onto its requested blob carrier", () => {
    const prepared = (label: string, expectedOutcome: SeedEntry["expectedOutcome"], length: number): SeedEntry => ({
      label,
      entry: new Uint8Array(length),
      contentHash: `0x${label.length.toString(16)}`,
      expectedOutcome,
    });
    const planned = planSeedWaveCarriers(seedWave(2), [
      prepared("control-empty-item", "empty", 0),
      prepared("control-item-too-large", "itemTooLarge", SEED_MAX_BATCH_CALLDATA_BYTES + 1),
    ]);
    expect(planned.map(({ carrier, entries }) => [carrier, entries.map((entry) => entry.label)]))
      .toEqual([
        ["calldata", ["control-empty-item"]],
        ["blobs", ["control-item-too-large"]],
      ]);
  });

  it("charges one percent, or nothing when the payment cannot carry a fee", () => {
    expect(seedFee(10_000n)).toBe(100n);
    expect(seedFee(99n)).toBe(0n);
  });

  it("preserves useful seed errors while redacting credentials", () => {
    const error = new Error(
      "relayer has 0.37 ETH, requires 0.56 ETH; https://user:password@rpc.example/v3/secret-path?apiKey=secret-query; Authorization: Bearer secret-token",
    );
    error.name = "HttpRequestError";
    expect(seedErrorKind(error)).toBe("HttpRequestError");
    const summary = seedErrorSummary(error, { PCASH_E2E_L1_KEY: `0x${"12".repeat(32)}` });
    expect(summary).toMatch(/^HttpRequestError: relayer has 0\.37 ETH, requires 0\.56 ETH;/);
    expect(summary).toContain("<redacted-url>");
    expect(summary).toContain("Authorization: <redacted>");
    for (const secret of ["user", "password", "secret-path", "secret-query", "secret-token"]) {
      expect(summary).not.toContain(secret);
    }
    expect(seedErrorKind("https://rpc.example/secret")).toBe("UnknownError");
    expect(seedErrorSummary("request failed at https://rpc.example/private"))
      .toBe("UnknownError: request failed at <redacted-url>");
    error.name = "https://rpc.example/secret";
    expect(seedErrorKind(error)).toBe("UnknownError");
  });

  it("keeps an unpaid Marketplace offer open for new purchases for a full day", () => {
    expect(purchaseCutoff(SEED_UNPAID_OFFER_DEADLINE_LEAD_SECONDS)).toBe(86_400n);
  });

  it("accepts complete evidence and rejects regressions", () => {
    const evidence = validRichSeedEvidence();
    expect(() => assertRichSeedEvidence(evidence)).not.toThrow();
    expect(() => assertRichSeedEvidence({
      ...evidence,
      richness: { ...evidence.richness, sellerChangeInputCount: 2 },
    })).toThrow(/change, or multi-input coverage/);
    expect(() => assertRichSeedEvidence({
      ...evidence,
      richness: { ...evidence.richness, recipientMultiInputCount: 1 },
    })).toThrow(/change, or multi-input coverage/);
    expect(() => assertRichSeedEvidence({
      ...evidence,
      canonicalEntries: evidence.canonicalEntries.filter((entry) => entry.observedOutcome !== "expired"),
    })).toThrow(/missing outcome expired/);
    expect(() => assertRichSeedEvidence({
      ...evidence,
      canonicalEntries: evidence.canonicalEntries.map((entry) => ({ ...entry, settledOpenFeeAmount: 0n })),
    })).toThrow(/settle public open fees/);
    expect(() => assertRichSeedEvidence({
      ...evidence,
      waves: evidence.waves.map((wave) => ({ ...wave, carriers: wave.carriers.map((carrier) => ({ ...carrier, carrierType: "calldata" as const })) })),
    })).toThrow(/blob carrier/);
    expect(() => assertRichSeedEvidence({
      ...evidence,
      waves: evidence.waves.map((wave) => ({
        ...wave,
        carriers: wave.carriers.map((carrier) => ({
          ...carrier,
          entries: carrier.entries.map((entry) => entry.expectedOutcome === "itemTooLarge"
            ? { ...entry, expectedOutcome: "empty" as const }
            : entry),
        })),
      })),
    })).toThrow(/itemTooLarge control must use a blob carrier/);
    expect(() => assertRichSeedEvidence({
      ...evidence,
      explorer: { ...evidence.explorer, excludedCarriers: [] },
    })).toThrow(/excluded L1 carrier/);
    expect(() => assertRichSeedEvidence({
      ...evidence,
      contracts: { ...evidence.contracts, unverified: [] },
    })).toThrow(/unverified private vault/);
  });
});

function validRichSeedEvidence(): RichSeedResult {
  const outcomes = [...plannedOutcomes()];
  const actors = Object.fromEntries(["S", "R", "M", "X", "O", "F"].map((name) => [name, `actor-${name}`]));
  const canonicalEntries = outcomes.map((outcome, index) => ({
    label: `entry-${index}`,
    expectedOutcome: outcome,
    observedOutcome: outcome,
    transactionId: isItemExclusion(outcome) ? null : `tx-${index}`,
    kind: outcome === "succeeded" ? "privateValue" : "userAccountCreation",
    settledOpenFeeAmount: outcome === "succeeded" ? 5n : 0n,
  }));
  canonicalEntries.push({
    label: "sponsored",
    expectedOutcome: "succeeded",
    observedOutcome: "succeeded",
    transactionId: "tx-sponsored",
    kind: "privateValue",
    settledOpenFeeAmount: 0n,
  });
  return {
    canonicalEntries,
    waves: [
      { carriers: [{ carrierType: "calldata", entries: [{ batchItemIndex: 0n }, { batchItemIndex: 1n }] }] },
      { carriers: [{ carrierType: "blob", entries: [{ batchItemIndex: 0n, expectedOutcome: "itemTooLarge" }] }] },
    ],
    contracts: { marketplace: ["paid", "unpaid"], verified: ["paid", "unpaid"], unverified: ["vault"] },
    explorer: {
      relayerAddress: "relayer",
      keylessAccountAddress: "keyless",
      privateVaultAddress: "vault",
      excludedCarriers: EXCLUDED_CARRIER_CONTROLS.map((control) => ({ label: control.label, l1TransactionHash: "0x01", exclusionReason: control.reason })),
      volumeTransferCount: 8,
    },
    marketplace: {
      paidOffer: { claimContentHash: "claim", paymentTxHash: "0x01" },
      unpaidOffer: { fundingContentHash: "fund" },
    },
    pending: {
      contentHashes: ["one", "two", "three"],
      conflicts: [
        { contentHash: "one", conflictKeys: ["a"] },
        { contentHash: "two", conflictKeys: ["b"] },
      ],
    },
    richness: {
      repeatedEarningIssuance: 1n,
      sellerChangeInputCount: 1,
      recipientMultiInputCount: 2,
    },
    assets: { controls: { reshapedRecreationRejected: "nullifier already spent" } },
    actors,
    finalPrivateBalances: actors,
  } as unknown as RichSeedResult;
}
