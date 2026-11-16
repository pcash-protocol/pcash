import { describe, expect, it } from "vitest";
import {
  ACCOUNT_UPDATE_UNITS,
  ACCOUNT_WEIGHT,
  baseFee,
  boundedNetworkFee,
  fakeExponential,
  FEE_UPDATE_FRACTION,
  feeBucket,
  MAX_FEE_EXCESS,
  MAX_UNIT_DENSITY,
  MAX_WAIVED_BASE_FEE,
  maxUnitsPerBlock,
  nativeBurnAmount,
  nextFeeExcess,
  NO_BURN,
  privateValueUnits,
  QUOTE_WINDOW_UNITS,
  quoteNativeBurn,
  quoteNetworkFee,
  requiredProtocolFee,
  TARGET_UNITS_PER_BLOCK,
  transactionNativeBurn,
  transactionRequiredFee,
  transactionUnits,
} from "../src/protocol/fee.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import {
  encodeAccountCreationAttachment,
  privateValueTransactionSize,
  userAccountUpdateSize,
  type RawTransaction,
} from "../src/protocol/codec.ts";

/** The excess at which the base fee first reaches one atomic unit. */
const FIRST_NONZERO_EXCESS = 43_670n;
/** The excess at which the base fee first exceeds the waiver. */
const FIRST_UNWAIVED_EXCESS = 1_305_566n;

describe("fake_exponential", () => {
  // go-ethereum's TestFakeExponential cases for EIP-4844's integer approximation.
  it.each([
    [1n, 0n, 1n, 1n],
    [38_493n, 0n, 1_000n, 38_493n],
    [0n, 1_234n, 2_345n, 0n],
    [1n, 2n, 1n, 6n],
    [1n, 4n, 2n, 6n],
    [1n, 3n, 1n, 16n],
    [1n, 6n, 2n, 18n],
    [1n, 4n, 1n, 49n],
    [1n, 8n, 2n, 50n],
    [10n, 8n, 2n, 542n],
    [11n, 8n, 2n, 596n],
    [1n, 5n, 1n, 136n],
    [1n, 5n, 2n, 11n],
    [2n, 5n, 2n, 23n],
    [1n, 50_000_000n, 2_225_652n, 5_709_098_764n],
    [1n, 380_928n, 3_338_477n, 1n],
  ])("fake_exponential(%s, %s, %s) = %s", (factor, numerator, denominator, expected) => {
    expect(fakeExponential(factor, numerator, denominator)).toBe(expected);
  });
});

describe("base fee", () => {
  it("is zero from genesis until the excess reaches about 44,000 units", () => {
    expect(baseFee(0n)).toBe(0n);
    expect(baseFee(FIRST_NONZERO_EXCESS - 1n)).toBe(0n);
    expect(baseFee(FIRST_NONZERO_EXCESS)).toBe(1n);
  });

  it("keeps the fee for the widest transaction below 2^128 at the excess cap", () => {
    expect(MAX_FEE_EXCESS).toBe(85n * FEE_UPDATE_FRACTION);
    expect(MAX_FEE_EXCESS).toBe(5_355_000n);
    const capped = fakeExponential(1n, MAX_FEE_EXCESS, FEE_UPDATE_FRACTION) - 1n;
    expect(capped).toBe(8_223_012_714_622_779_069_284_684_628_868_332_034n);
    expect(capped).toBe(baseFee(MAX_FEE_EXCESS));
    // Profile L plus one new account.
    const widest = BigInt(PRIVATE_VALUE_PROFILES.L.inputs) + ACCOUNT_WEIGHT;
    expect(widest).toBe(34n);
    expect(capped * widest < 1n << 128n).toBe(true);
  });

  it("waives the fee up to its maximum base fee, then requires the whole fee", () => {
    expect(MAX_WAIVED_BASE_FEE).toBe(1_000_000_000n);
    expect(requiredProtocolFee(0n, 34n)).toBe(0n);
    expect(requiredProtocolFee(baseFee(FIRST_NONZERO_EXCESS), 4n)).toBe(0n);
    expect(requiredProtocolFee(MAX_WAIVED_BASE_FEE, 34n)).toBe(0n);
    expect(requiredProtocolFee(MAX_WAIVED_BASE_FEE + 1n, 4n)).toBe(4_000_000_004n);
    expect(baseFee(FIRST_UNWAIVED_EXCESS - 1n)).toBe(999_988_084n);
    expect(requiredProtocolFee(baseFee(FIRST_UNWAIVED_EXCESS - 1n), 34n)).toBe(0n);
    expect(baseFee(FIRST_UNWAIVED_EXCESS)).toBe(1_000_003_982n);
    expect(requiredProtocolFee(baseFee(FIRST_UNWAIVED_EXCESS), 4n)).toBe(4_000_015_928n);
    expect(requiredProtocolFee(baseFee(2_200_000n), 6n)).toBe(baseFee(2_200_000n) * 6n);
  });

  it("waives no standalone creation: it needs a zero base fee", () => {
    const waived = baseFee(FIRST_NONZERO_EXCESS);
    expect(transactionRequiredFee({ kind: 1 } as RawTransaction, 0n, false)).toBe(0n);
    expect(transactionRequiredFee({ kind: 1 } as RawTransaction, waived, false)).toBe(waived * ACCOUNT_WEIGHT);
    expect(transactionRequiredFee({ kind: 2 } as RawTransaction, waived, false)).toBe(waived * ACCOUNT_WEIGHT);
    expect(transactionRequiredFee({ kind: 0, shape: PRIVATE_VALUE_PROFILES.S.shapeId } as RawTransaction, waived, false)).toBe(0n);
    expect(transactionRequiredFee({ kind: 3 } as RawTransaction, waived, false)).toBe(0n);
  });
});

describe("fee excess", () => {
  it("advances by the units above the target, floored at zero and capped", () => {
    expect(TARGET_UNITS_PER_BLOCK).toBe(1_200n);
    expect(nextFeeExcess(0n, 1_200n)).toBe(0n);
    expect(nextFeeExcess(0n, 0n)).toBe(0n);
    expect(nextFeeExcess(500n, 0n)).toBe(0n);
    expect(nextFeeExcess(500n, 1_000n)).toBe(300n);
    expect(nextFeeExcess(0n, 2_400n)).toBe(1_200n);
    expect(nextFeeExcess(MAX_FEE_EXCESS - 10n, 1_300n)).toBe(MAX_FEE_EXCESS);
    expect(nextFeeExcess(MAX_FEE_EXCESS, 1_200n)).toBe(MAX_FEE_EXCESS);
  });
});

describe("fee bucket", () => {
  it("rounds up to two significant decimal digits and keeps zero", () => {
    expect(feeBucket(0n)).toBe(0n);
    for (let amount = 1n; amount <= 99n; amount += 1n) expect(feeBucket(amount)).toBe(amount);
    expect(feeBucket(100n)).toBe(100n);
    expect(feeBucket(101n)).toBe(110n);
    expect(feeBucket(110n)).toBe(110n);
    expect(feeBucket(999n)).toBe(1_000n);
    expect(feeBucket(12_345n)).toBe(13_000n);
    expect(feeBucket(13_000n)).toBe(13_000n);
    expect(feeBucket(-5n)).toBe(0n);
  });
});

describe("network fee quote", () => {
  it("is zero while the projected base fee is waived, however far above zero", () => {
    expect(QUOTE_WINDOW_UNITS).toBe(6_000n);
    expect(quoteNetworkFee(0n, 4n)).toBe(0n);
    expect(quoteNetworkFee(FIRST_NONZERO_EXCESS, 34n)).toBe(0n);
    expect(baseFee(44_800n)).toBe(1n);
    expect([requiredProtocolFee(baseFee(44_800n), 4n), quoteNetworkFee(44_800n, 4n)]).toEqual([0n, 0n]);
    expect(quoteNetworkFee(FIRST_UNWAIVED_EXCESS - QUOTE_WINDOW_UNITS - 1n, 34n)).toBe(0n);
  });

  it("turns positive a quote window before the waiver ends, at the whole projected fee", () => {
    const excess = FIRST_UNWAIVED_EXCESS - QUOTE_WINDOW_UNITS;
    expect(requiredProtocolFee(baseFee(excess), 4n)).toBe(0n);
    expect(quoteNetworkFee(excess, 4n)).toBe(feeBucket(4_000_015_928n));
    expect(quoteNetworkFee(excess, 4n)).toBe(4_100_000_000n);
  });

  it("prices the projected base fee, not a percentage of the current one", () => {
    const excess = 2_200_000n;
    const projected = baseFee(excess + QUOTE_WINDOW_UNITS) * 4n;
    expect(quoteNetworkFee(excess, 4n)).toBe(feeBucket(projected));
    expect(quoteNetworkFee(excess, 4n)).toBeGreaterThanOrEqual(requiredProtocolFee(baseFee(excess + QUOTE_WINDOW_UNITS), 4n));
    expect(quoteNetworkFee(excess, 4n)).toBeGreaterThan(requiredProtocolFee(baseFee(excess), 4n));
  });

  it("projects no further than the excess cap", () => {
    const atCap = feeBucket(baseFee(MAX_FEE_EXCESS) * 34n);
    expect(quoteNetworkFee(MAX_FEE_EXCESS, 34n)).toBe(atCap);
    expect(quoteNetworkFee(MAX_FEE_EXCESS - QUOTE_WINDOW_UNITS / 2n, 34n)).toBe(atCap);
    expect(atCap < 1n << 128n).toBe(true);
  });
});

describe("state units", () => {
  it("counts each nullifier and a newly allocated account", () => {
    expect(privateValueUnits(4, false)).toBe(4n);
    expect(privateValueUnits(4, true)).toBe(6n);
    expect(privateValueUnits(32, true)).toBe(34n);
    expect(ACCOUNT_UPDATE_UNITS).toBe(4n);
  });

  it("counts a transaction's attachment only when told it allocates", () => {
    const small = { kind: 0, shape: PRIVATE_VALUE_PROFILES.S.shapeId } as RawTransaction;
    const attached = { ...small, accountCreation: { kind: "contract", body: new Uint8Array() } } as RawTransaction;
    const large = { kind: 0, shape: PRIVATE_VALUE_PROFILES.L.shapeId } as RawTransaction;
    expect(transactionUnits(small, true)).toBe(4n);
    expect(transactionUnits(attached, false)).toBe(4n);
    expect(transactionUnits(attached, true)).toBe(6n);
    expect(transactionUnits(large, false)).toBe(32n);
    expect(transactionUnits({ kind: 3 } as RawTransaction, false)).toBe(ACCOUNT_UPDATE_UNITS);
    expect(transactionUnits({ kind: 1 } as RawTransaction, false)).toBe(ACCOUNT_WEIGHT);
    expect(transactionUnits({ kind: 2 } as RawTransaction, false)).toBe(ACCOUNT_WEIGHT);
  });

  it("reads no burn from a standalone creation", () => {
    expect(transactionNativeBurn({ kind: 1 } as RawTransaction)).toBe(0n);
    expect(transactionNativeBurn({ kind: 2 } as RawTransaction)).toBe(0n);
  });
});

describe("native burn", () => {
  it("is the network fee plus any voluntary burn", () => {
    expect(nativeBurnAmount(NO_BURN)).toBe(0n);
    expect(nativeBurnAmount({ networkFeeAmount: 40n, voluntaryBurnAmount: 2n })).toBe(42n);
  });

  it("quotes the projected network fee and carries the voluntary burn", () => {
    expect(quoteNativeBurn(0n, 4n)).toEqual({ networkFeeAmount: 0n, voluntaryBurnAmount: 0n });
    expect(quoteNativeBurn(0n, 4n, 7n)).toEqual({ networkFeeAmount: 0n, voluntaryBurnAmount: 7n });
    const excess = FIRST_UNWAIVED_EXCESS - QUOTE_WINDOW_UNITS;
    expect(quoteNativeBurn(excess, 6n, 3n)).toEqual({ networkFeeAmount: feeBucket(baseFee(FIRST_UNWAIVED_EXCESS) * 6n), voluntaryBurnAmount: 3n });
    expect(() => quoteNativeBurn(0n, 4n, -1n)).toThrow(/voluntaryBurnAmount/);
  });
});

describe("worst-case fee bound", () => {
  const S_UNITS = privateValueUnits(4, false);
  const GAS_LIMIT = 60_000_000n;

  it("counts profile L attaching the smallest contract body as the densest form", () => {
    // 6 + 72 words + 22,432 proof + 32 × 1,213 output data + 16,672 arena, then the 36-byte attachment.
    expect(MAX_UNIT_DENSITY).toEqual({ units: 34n, bytes: 80_266n });
    const smallest = new Uint8Array([0, ...new Uint8Array(32), 0, 0]);
    expect(encodeAccountCreationAttachment({ kind: "contract", body: smallest }, 1).length).toBe(36);
    expect(() => encodeAccountCreationAttachment({ kind: "contract", body: smallest.subarray(0, 34) }, 1)).toThrow();
    const attached = { kind: "contract" as const, body: smallest };
    for (const [units, bytes] of [
      [4n, privateValueTransactionSize(PRIVATE_VALUE_PROFILES.S.shapeId)],
      [6n, privateValueTransactionSize(PRIVATE_VALUE_PROFILES.S.shapeId, attached)],
      [32n, privateValueTransactionSize(PRIVATE_VALUE_PROFILES.L.shapeId)],
      [ACCOUNT_UPDATE_UNITS, userAccountUpdateSize(0)],
    ] as const) expect(units * MAX_UNIT_DENSITY.bytes).toBeLessThan(MAX_UNIT_DENSITY.units * BigInt(bytes));
  });

  // Computed independently from the wire layout: (gasLimit / 8 + 21 blobs of payload) × 34 / 80,266.
  it.each([[60_000_000n, 4_306n], [36_000_000n, 3_035n], [0n, 1_129n]])("bounds a %s-gas block at %s units", (gasLimit, units) => {
    expect(maxUnitsPerBlock(gasLimit)).toBe(units);
  });

  it.each([
    [1_400_000n, 15n, 38_000_000_000n],
    [2_500_000n, 15n, 1_500_000_000_000_000_000n],
    [373_765n, 300n, 0n],
    [373_766n, 300n, 4_100_000_000n],
  ])("from excess %s over %s blocks quotes %s", (feeExcess, blocks, fee) => {
    expect(boundedNetworkFee(feeExcess, S_UNITS, blocks, GAS_LIMIT)).toBe(fee);
  });

  it("stops at the excess cap, and adds nothing while a block cannot carry more than the target", () => {
    expect(boundedNetworkFee(MAX_FEE_EXCESS - 1_000n, S_UNITS, 15n, GAS_LIMIT)).toBe(feeBucket(baseFee(MAX_FEE_EXCESS) * S_UNITS));
    expect(boundedNetworkFee(2_500_000n, S_UNITS, 15n, 0n)).toBe(feeBucket(baseFee(2_500_000n) * S_UNITS));
    expect(boundedNetworkFee(2_500_000n, S_UNITS, 15n, GAS_LIMIT)).toBeGreaterThan(quoteNetworkFee(2_500_000n, S_UNITS));
  });
});
