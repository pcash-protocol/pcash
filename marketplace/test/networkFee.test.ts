import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCOUNT_WEIGHT, baseFee, MAX_WAIVED_BASE_FEE, PRIVATE_VALUE_PROFILES, quoteNetworkFee } from "@pcash/sdk/browser";
import { assertMarketplaceNetworkFee, marketplaceNetAmount } from "../src/client/networkFee.ts";
import { NativeClaimFeeError, quoteClaim } from "../src/client/claimFlow.ts";
import { reclaimBurn } from "../src/client/reclaimFlow.ts";

// An excess whose base fee is past the waiver, so a fee is required.
const POSITIVE_EXCESS = 1_400_000n;
// An escrow that a required fee, about 10^9 per state unit, leaves something of.
const ESCROW = 10n ** 12n;
const S_INPUTS = BigInt(PRIVATE_VALUE_PROFILES.S.inputs);

describe("marketplace open or private network fees", () => {
  it("keeps a positive net transfer amount", () => {
    assert.doesNotThrow(() => assertMarketplaceNetworkFee(100n, 0n));
    assert.equal(marketplaceNetAmount(100n, 99n), 1n);
    assert.throws(() => marketplaceNetAmount(100n, -1n), /must be nonnegative/);
    assert.throws(() => marketplaceNetAmount(100n, 100n), /must be less than transfer amount/);
  });
});

// An excess the quote projects past the waiver, while the next block's own
// base fee is still waived.
const PROJECTED_ONLY_EXCESS = 1_300_000n;

// The node's tip and an Ethereum head at the same slot, at a 60M gas limit.
const TIP = 1_800_000_000n;
const HEAD = { gasLimit: 60_000_000n, timestamp: TIP };
const at = (feeExcess: bigint, baseFeeNow = baseFee(feeExcess)) => ({ feeExcess, baseFee: baseFeeNow, latestBlockTimestamp: TIP });
const BEFORE_PAYMENT = { ethereumHead: HEAD };
// Worst-case fees through the 15 blocks of the purchase window, computed independently
// from the Ethereum data bound.
const WINDOW_FEE_S = 38_000_000_000n;
const WINDOW_FEE_S_WITH_ACCOUNT = 57_000_000_000n;
// The largest excess from which an hour of full blocks leaves the fee waived.
const WAIVED_FOR_AN_HOUR = 373_765n;

describe("claim and reclaim burns", () => {
  it("quotes at a positive fee", () => {
    assert.ok(baseFee(POSITIVE_EXCESS) > MAX_WAIVED_BASE_FEE);
    assert.ok(baseFee(PROJECTED_ONLY_EXCESS) > 0n && baseFee(PROJECTED_ONLY_EXCESS) <= MAX_WAIVED_BASE_FEE);
    assert.ok(quoteNetworkFee(PROJECTED_ONLY_EXCESS, S_INPUTS) > 0n);
  });

  it("before payment, a native claim burns nothing and keeps its own limit while an hour of full blocks leaves the fee waived", () => {
    for (const excess of [0n, WAIVED_FOR_AN_HOUR]) {
      assert.deepEqual(quoteClaim(at(excess), { assetId: 0n, amount: ESCROW }, BEFORE_PAYMENT), {
        burn: { networkFeeAmount: 0n, voluntaryBurnAmount: 0n },
        assetId: 0n,
        receivedAmount: ESCROW,
        buyerFunded: false,
      });
    }
    // One unit more and the purchase window applies, though its own worst case is still waived.
    const edge = quoteClaim(at(WAIVED_FOR_AN_HOUR + 1n), { assetId: 0n, amount: ESCROW }, BEFORE_PAYMENT);
    assert.equal(edge.burn.networkFeeAmount, 0n);
    assert.equal(edge.feeCoveredUntil, TIP + 180n);
  });

  it("before payment, a native claim burns the worst-case fee through the purchase window, which then ends its limit", () => {
    assert.equal(quoteNetworkFee(POSITIVE_EXCESS, S_INPUTS), 20_000_000_000n);
    assert.deepEqual(quoteClaim(at(POSITIVE_EXCESS), { assetId: 0n, amount: ESCROW }, BEFORE_PAYMENT), {
      burn: { networkFeeAmount: WINDOW_FEE_S, voluntaryBurnAmount: 0n },
      assetId: 0n,
      receivedAmount: ESCROW - WINDOW_FEE_S,
      buyerFunded: false,
      feeCoveredUntil: TIP + 180n,
    });
    // A node two slots behind the head adds two blocks to the window.
    const lagging = quoteClaim(at(POSITIVE_EXCESS), { assetId: 0n, amount: ESCROW }, { ethereumHead: { ...HEAD, timestamp: TIP + 24n } });
    assert.equal(lagging.burn.networkFeeAmount, 42_000_000_000n);
    assert.equal(lagging.feeCoveredUntil, TIP + 24n + 180n);
  });

  it("after payment, a native claim burns the projected fee and keeps its own limit", () => {
    const quote = quoteClaim(at(POSITIVE_EXCESS), { assetId: 0n, amount: ESCROW }, { paid: true });
    assert.deepEqual(quote.burn, { networkFeeAmount: quoteNetworkFee(POSITIVE_EXCESS, S_INPUTS), voluntaryBurnAmount: 0n });
    assert.equal(quote.feeCoveredUntil, undefined);
  });

  it("a claim that creates the buyer's account counts the account", () => {
    const quote = quoteClaim(at(POSITIVE_EXCESS, 0n), { assetId: 0n, amount: ESCROW }, { ...BEFORE_PAYMENT, createsAccount: true, voluntaryBurnAmount: 5n });
    assert.deepEqual(quote.burn, { networkFeeAmount: WINDOW_FEE_S_WITH_ACCOUNT, voluntaryBurnAmount: 5n });
    assert.equal(quote.receivedAmount, ESCROW - WINDOW_FEE_S_WITH_ACCOUNT - 5n);
    const paid = quoteClaim(at(POSITIVE_EXCESS), { assetId: 0n, amount: ESCROW }, { paid: true, createsAccount: true });
    assert.equal(paid.burn.networkFeeAmount, quoteNetworkFee(POSITIVE_EXCESS, S_INPUTS + ACCOUNT_WEIGHT));
  });

  it("a native claim whose burn would take the whole escrow is refused, not thrown as an arithmetic error", () => {
    assert.throws(
      () => quoteClaim(at(POSITIVE_EXCESS), { assetId: 0n, amount: WINDOW_FEE_S }, BEFORE_PAYMENT),
      (error: unknown) => error instanceof NativeClaimFeeError && error.nativeBurnAmount === WINDOW_FEE_S,
    );
    // The same escrow is still claimable after payment at the projected fee.
    assert.equal(quoteClaim(at(POSITIVE_EXCESS), { assetId: 0n, amount: WINDOW_FEE_S }, { paid: true }).receivedAmount,
      WINDOW_FEE_S - quoteNetworkFee(POSITIVE_EXCESS, S_INPUTS));
  });

  it("a token claim pays out in full and burns nothing while the fee stays waived", () => {
    for (const options of [BEFORE_PAYMENT, { paid: true as const }]) {
      assert.deepEqual(quoteClaim(at(0n), { assetId: 9n, amount: 100n }, options), {
        burn: { networkFeeAmount: 0n, voluntaryBurnAmount: 0n },
        assetId: 9n,
        receivedAmount: 100n,
        buyerFunded: false,
      });
    }
  });

  it("before payment, a token claim burns the worst-case fee through the window from the buyer's PCASH", () => {
    assert.deepEqual(quoteClaim(at(PROJECTED_ONLY_EXCESS, 0n), { assetId: 9n, amount: 100n }, BEFORE_PAYMENT), {
      burn: { networkFeeAmount: 7_700_000_000n, voluntaryBurnAmount: 0n },
      assetId: 9n,
      receivedAmount: 100n,
      buyerFunded: true,
      feeCoveredUntil: TIP + 180n,
    });
  });

  // Held excess can keep the projection positive while the next block's fee
  // is zero; a paid token claim then burns nothing and still succeeds.
  it("after payment, a token claim burns nothing while the next block requires no fee and the projected fee from the buyer's PCASH otherwise", () => {
    for (const baseFeeNow of [0n, baseFee(PROJECTED_ONLY_EXCESS)]) {
      assert.deepEqual(
        quoteClaim(at(PROJECTED_ONLY_EXCESS, baseFeeNow), { assetId: 9n, amount: 100n }, { paid: true }),
        { burn: { networkFeeAmount: 0n, voluntaryBurnAmount: 0n }, assetId: 9n, receivedAmount: 100n, buyerFunded: false },
      );
    }
    assert.deepEqual(
      quoteClaim(at(POSITIVE_EXCESS), { assetId: 9n, amount: 100n }, { paid: true }),
      { burn: { networkFeeAmount: quoteNetworkFee(POSITIVE_EXCESS, S_INPUTS), voluntaryBurnAmount: 0n }, assetId: 9n, receivedAmount: 100n, buyerFunded: true },
    );
  });

  it("a token claim's voluntary burn comes from the buyer's PCASH", () => {
    const quote = quoteClaim(at(0n), { assetId: 9n, amount: 100n }, { paid: true, voluntaryBurnAmount: 1n });
    assert.deepEqual(quote.burn, { networkFeeAmount: 0n, voluntaryBurnAmount: 1n });
    assert.equal(quote.buyerFunded, true);
  });

  it("a reclaim burns the quoted fee for its nullifiers and any voluntary burn", () => {
    assert.deepEqual(reclaimBurn({ feeExcess: POSITIVE_EXCESS }, 2n), {
      networkFeeAmount: quoteNetworkFee(POSITIVE_EXCESS, S_INPUTS),
      voluntaryBurnAmount: 2n,
    });
    assert.deepEqual(reclaimBurn({ feeExcess: 0n }), { networkFeeAmount: 0n, voluntaryBurnAmount: 0n });
  });
});
