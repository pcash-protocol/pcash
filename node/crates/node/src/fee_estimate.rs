//! Relay fee estimation behind `pcash_estimateFee`.
//!
//! Each tier takes the larger fee-density percentile from recently included
//! transactions and ready local pool entries that pay a positive open-route
//! fee, scaled to the requested encoded size. The estimate is the fee to pay
//! for open publication, so zero-fee actions funded by issuance are not
//! samples. No observations yields zero; no exchange rate is assumed.

use std::cmp::Ordering;

use alloy_primitives::{U256, U512};
use pcash_rpc::{FeeEstimateBasisDto, FeeTiersDto};

/// Canonical blocks consulted for included fees.
pub const WINDOW_BLOCKS: u64 = 64;
/// Newest included receipts sampled inside the window.
pub const MAX_INCLUSION_SAMPLES: usize = 256;

const TIER_PERCENTILES: [u64; 3] = [25, 50, 90];

/// Declared open fee and encoded size of one transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeSample {
    pub fee: U256,
    pub bytes: u64,
}

pub struct FeeEstimateInputs<'a> {
    /// Accepted transactions inside the window.
    pub included: &'a [FeeSample],
    /// Ready entries in the local pool.
    pub pending: &'a [FeeSample],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeEstimate {
    pub byte_size: u64,
    pub tiers: FeeTiersDto,
    pub basis: FeeEstimateBasisDto,
}

pub fn estimate(inputs: &FeeEstimateInputs<'_>, byte_size: u64) -> FeeEstimate {
    let included = percentile_tiers(inputs.included, byte_size);
    let pending = percentile_tiers(inputs.pending, byte_size);
    let tier = |select: fn(&FeeTiersDto) -> U256| {
        included
            .as_ref()
            .map_or(U256::ZERO, select)
            .max(pending.as_ref().map_or(U256::ZERO, select))
    };
    FeeEstimate {
        byte_size,
        tiers: FeeTiersDto {
            low: tier(|t| t.low),
            standard: tier(|t| t.standard),
            fast: tier(|t| t.fast),
        },
        basis: FeeEstimateBasisDto {
            included_samples: inputs.included.len() as u64,
            included,
            pending_samples: inputs.pending.len() as u64,
            pending,
        },
    }
}

/// Fee-density percentiles of `samples`, each scaled to `byte_size`.
fn percentile_tiers(samples: &[FeeSample], byte_size: u64) -> Option<FeeTiersDto> {
    let mut sorted = samples.to_vec();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_unstable_by(density_order);
    let at = |percent: u64| {
        let index = ((sorted.len() as u64 - 1) * percent / 100) as usize;
        let sample = sorted[index];
        mul_div(sample.fee, U256::from(byte_size), U256::from(sample.bytes))
    };
    Some(FeeTiersDto {
        low: at(TIER_PERCENTILES[0]),
        standard: at(TIER_PERCENTILES[1]),
        fast: at(TIER_PERCENTILES[2]),
    })
}

fn density_order(left: &FeeSample, right: &FeeSample) -> Ordering {
    let left_scaled = U512::from(left.fee) * U512::from(right.bytes);
    let right_scaled = U512::from(right.fee) * U512::from(left.bytes);
    left_scaled.cmp(&right_scaled)
}

/// `value × numerator / denominator` without intermediate overflow, saturating
/// at `U256::MAX` on a result that cannot fit. Callers never pass a zero
/// denominator.
fn mul_div(value: U256, numerator: U256, denominator: U256) -> U256 {
    let scaled = U512::from(value) * U512::from(numerator) / U512::from(denominator);
    U256::saturating_from(scaled)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PCASH: u128 = 1_000_000_000_000_000_000;

    fn sample(fee: u128, bytes: u64) -> FeeSample {
        FeeSample {
            fee: U256::from(fee),
            bytes,
        }
    }

    fn run(included: &[FeeSample], pending: &[FeeSample], byte_size: u64) -> FeeEstimate {
        estimate(&FeeEstimateInputs { included, pending }, byte_size)
    }

    fn tiers(low: U256, standard: U256, fast: U256) -> FeeTiersDto {
        FeeTiersDto {
            low,
            standard,
            fast,
        }
    }

    #[test]
    fn empty_inputs_estimate_zero_at_the_requested_size() {
        let out = run(&[], &[], 1_000);
        assert_eq!(out.byte_size, 1_000);
        assert_eq!(out.tiers, tiers(U256::ZERO, U256::ZERO, U256::ZERO));
        assert_eq!(out.basis.included_samples, 0);
        assert_eq!(out.basis.pending_samples, 0);
        assert_eq!(out.basis.included, None);
        assert_eq!(out.basis.pending, None);
    }

    #[test]
    fn repeated_identical_size_quotes_remain_flat_after_inclusion() {
        let byte_size = 33_057;
        let observed = U256::from(7 * PCASH);
        let mut included = vec![FeeSample {
            fee: observed,
            bytes: byte_size,
        }];
        for _ in 0..300 {
            let quote = run(&included, &[], byte_size);
            assert_eq!(quote.tiers, tiers(observed, observed, observed));
            included.push(FeeSample {
                fee: quote.tiers.standard,
                bytes: byte_size,
            });
            if included.len() > MAX_INCLUSION_SAMPLES {
                included.remove(0);
            }
        }
    }

    #[test]
    fn percentiles_follow_density_not_absolute_fee_and_scale_to_the_size() {
        let included = [
            sample(300 * PCASH, 100),
            sample(5_000 * PCASH, 1_000),
            sample(10 * PCASH, 10),
            sample(400 * PCASH, 100),
            sample(2 * PCASH, 1),
        ];
        let out = run(&included, &[], 10);
        // Sorted densities are 1..=5; floor-rank p25/p50/p90 select 2, 3, and 4.
        let expected = tiers(
            U256::from(20 * PCASH),
            U256::from(30 * PCASH),
            U256::from(40 * PCASH),
        );
        assert_eq!(out.tiers, expected);
        assert_eq!(out.basis.included, Some(expected));
        assert_eq!(out.basis.included_samples, 5);
    }

    #[test]
    fn each_tier_takes_the_larger_included_or_pending_density() {
        let included = [10, 20, 30, 40, 50].map(|fee| sample(fee, 1));
        let pending = [1, 2, 100, 200, 300].map(|fee| sample(fee, 1));
        let out = run(&included, &pending, 10);
        assert_eq!(
            out.tiers,
            tiers(U256::from(200), U256::from(1_000), U256::from(2_000))
        );
        assert_eq!(out.basis.included_samples, 5);
        assert_eq!(out.basis.pending_samples, 5);
    }

    #[test]
    fn a_single_sample_fills_every_tier_and_empty_other_pool_adds_nothing() {
        let expected = tiers(
            U256::from(6 * PCASH),
            U256::from(6 * PCASH),
            U256::from(6 * PCASH),
        );
        let included = run(&[sample(3 * PCASH, 3)], &[], 6);
        let pending = run(&[], &[sample(3 * PCASH, 3)], 6);
        assert_eq!(included.tiers, expected);
        assert_eq!(pending.tiers, expected);
        assert_eq!(pending.basis.pending, Some(expected));
    }

    #[test]
    fn zero_observed_fee_and_zero_requested_size_stay_zero() {
        for out in [
            run(&[sample(0, 1)], &[], u64::MAX),
            run(&[], &[sample(9, 1)], 0),
        ] {
            assert_eq!(out.tiers, tiers(U256::ZERO, U256::ZERO, U256::ZERO));
        }
    }

    #[test]
    fn wide_density_comparison_and_scaling_do_not_overflow() {
        let sparse = FeeSample {
            fee: U256::MAX,
            bytes: u64::MAX,
        };
        let dense = FeeSample {
            fee: U256::MAX >> 1,
            bytes: 1,
        };
        assert_eq!(density_order(&sparse, &dense), Ordering::Less);
        let out = run(&[sparse], &[], u64::MAX);
        assert_eq!(out.tiers, tiers(U256::MAX, U256::MAX, U256::MAX));
        let out = run(&[], &[dense], u64::MAX);
        assert_eq!(out.tiers, tiers(U256::MAX, U256::MAX, U256::MAX));
        assert_eq!(
            mul_div(U256::MAX, U256::from(1), U256::from(2)),
            U256::MAX >> 1
        );
    }
}
