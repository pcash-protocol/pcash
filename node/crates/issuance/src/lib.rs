//! Exact fixed-point settlement for the selected bounded-memory ASERT policy.

use alloy_primitives::{I256, U256};
use rug::{integer::Order, ops::DivRounding, Integer};

pub const EXPONENT_RADIX: u32 = 65_536;
pub const FRACTION_BITS: u32 = 128;
pub const DENOMINATION: u32 = 18;
pub const DURATION_SECONDS: u64 = 365 * 86_400;
pub const REFERENCE_INTERVAL_SECONDS: u64 = 12;
pub const HALF_LIFE_SECONDS: u64 = 2 * 86_400;
pub const MAXIMUM_SPEED: u64 = 3;
pub const MAXIMUM_LAG_SECONDS: u64 = 4 * 86_400;
pub const INITIAL_LAG_SECONDS: i64 = 0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IssuanceState {
    pub issued_so_far: U256,
    /// Controller lag in Q128 seconds: positive when issuance is behind the
    /// reference curve, negative when ahead (spec §14.1).
    pub lag_q: I256,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    pub baseline: U256,
    pub internal_offer: U256,
    pub block_allowance: U256,
    pub max_single_action_reward: U256,
    pub multiplier_q: U256,
    pub exhausted: bool,
}

impl Quote {
    /// Whether one qualifying action could receive a positive reward.
    pub fn reward_possible(&self) -> bool {
        self.max_single_action_reward > U256::ZERO
    }
}

/// Issuance terms shared by action admission and settlement of one block.
pub struct BlockTerms {
    pub quote: Quote,
    parent: IssuanceState,
    progress: Integer,
    offer_lag: Integer,
    allowance_q: Integer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub state: IssuanceState,
    pub reward_each: U256,
    pub new_issuance: U256,
}

pub fn supply_cap() -> U256 {
    U256::from(1_000_000_000u64) * U256::from(10).pow(U256::from(DENOMINATION))
}

/// The Q128 fixed-point unit.
pub fn scale() -> U256 {
    U256::from(1) << FRACTION_BITS
}

fn cap() -> Integer {
    integer(supply_cap())
}

fn q() -> Integer {
    Integer::from(1) << FRACTION_BITS
}

pub fn initial_state() -> IssuanceState {
    IssuanceState {
        issued_so_far: U256::ZERO,
        lag_q: signed(&(Integer::from(INITIAL_LAG_SECONDS) * q())),
    }
}

pub fn quote(parent: IssuanceState, elapsed_seconds: u64) -> Quote {
    block_terms(parent, elapsed_seconds).quote
}

pub fn block_terms(parent: IssuanceState, elapsed_seconds: u64) -> BlockTerms {
    if parent.issued_so_far >= supply_cap() {
        return BlockTerms {
            quote: Quote {
                baseline: U256::ZERO,
                internal_offer: U256::ZERO,
                block_allowance: U256::ZERO,
                max_single_action_reward: U256::ZERO,
                multiplier_q: U256::ZERO,
                exhausted: true,
            },
            parent,
            progress: Integer::from(0),
            offer_lag: Integer::from(0),
            allowance_q: Integer::from(0),
        };
    }
    let q = q();
    let issued = integer(parent.issued_so_far);
    let (progress, baseline_q) = progress_and_baseline(&issued);
    let offer_lag = offer_lag(parent.lag_q, elapsed_seconds);
    let multiplier_q = multiplier(&offer_lag);
    let offer_q = Integer::from(&baseline_q * &multiplier_q) / &q;
    let allowance_q = Integer::from(&baseline_q * MAXIMUM_SPEED);
    let baseline = Integer::from(&baseline_q / &q);
    let internal_offer = Integer::from(&offer_q / &q);
    let block_allowance = Integer::from(&allowance_q / &q);
    let remaining = cap() - issued;
    let max_single = internal_offer
        .clone()
        .min(block_allowance.clone())
        .min(remaining);
    BlockTerms {
        quote: Quote {
            baseline: unsigned(&baseline),
            internal_offer: unsigned(&internal_offer),
            block_allowance: unsigned(&block_allowance),
            max_single_action_reward: unsigned(&max_single),
            multiplier_q: unsigned(&multiplier_q),
            exhausted: false,
        },
        parent,
        progress,
        offer_lag,
        allowance_q,
    }
}

/// Settle one produced block. The anchor block passes `elapsed_seconds = 0`.
pub fn transition(
    parent: IssuanceState,
    elapsed_seconds: u64,
    qualifying_actions: u64,
) -> Settlement {
    settle(block_terms(parent, elapsed_seconds), qualifying_actions)
}

pub fn settle(terms: BlockTerms, qualifying_actions: u64) -> Settlement {
    let BlockTerms {
        quote,
        parent,
        progress,
        offer_lag,
        allowance_q,
    } = terms;
    if quote.exhausted {
        return Settlement {
            state: IssuanceState {
                issued_so_far: supply_cap(),
                lag_q: parent.lag_q,
            },
            reward_each: U256::ZERO,
            new_issuance: U256::ZERO,
        };
    }

    let issued = integer(parent.issued_so_far);
    let remaining = Integer::from(&cap() - &issued);
    let reward = if qualifying_actions == 0 {
        Integer::from(0)
    } else {
        let count = Integer::from(qualifying_actions);
        let allowance_each = allowance_q / (&count * q());
        let remaining_each = Integer::from(&remaining / &count);
        integer(quote.internal_offer)
            .min(allowance_each)
            .min(remaining_each)
    };
    let new_issuance = Integer::from(&reward * qualifying_actions);
    let next_issued = Integer::from(&issued + &new_issuance);
    let (next_progress, _) = progress_and_baseline(&next_issued);
    let next_lag = offer_lag - (next_progress - progress);
    Settlement {
        state: IssuanceState {
            issued_so_far: unsigned(&next_issued),
            lag_q: signed(&next_lag),
        },
        reward_each: unsigned(&reward),
        new_issuance: unsigned(&new_issuance),
    }
}

/// Conservative admission predicate: reserve one reward slot per qualifying
/// action exactly when one action could receive a positive reward.
pub fn reward_slot_active(parent: IssuanceState, elapsed_seconds: u64) -> bool {
    quote(parent, elapsed_seconds).reward_possible()
}

pub fn progress_q(issued: U256) -> U256 {
    unsigned(&progress_and_baseline(&integer(issued)).0)
}

pub fn baseline_q(issued: U256) -> U256 {
    unsigned(&progress_and_baseline(&integer(issued)).1)
}

fn offer_lag(lag: I256, elapsed_seconds: u64) -> Integer {
    let q = q();
    let maximum = Integer::from(MAXIMUM_LAG_SECONDS) * &q;
    (signed_integer(lag) + Integer::from(elapsed_seconds) * &q).min(maximum)
}

fn progress_and_baseline(issued: &Integer) -> (Integer, Integer) {
    let cap = cap();
    let q = q();
    if issued >= &cap {
        return (Integer::from(DURATION_SECONDS) * &q, Integer::from(0));
    }
    let remaining = Integer::from(&cap - issued);
    let radicand = (remaining * &q * &q) / &cap;
    let root = radicand.sqrt();
    let progress = Integer::from(DURATION_SECONDS) * Integer::from(&q - &root);
    let baseline = (Integer::from(2) * &cap * REFERENCE_INTERVAL_SECONDS * root) / DURATION_SECONDS;
    (progress, baseline)
}

fn multiplier(offer_lag: &Integer) -> Integer {
    let half_life = Integer::from(HALF_LIFE_SECONDS) * q();
    if offer_lag < &-Integer::from(128 * &half_life) {
        return Integer::from(0);
    }
    let exponent = Integer::from(offer_lag * EXPONENT_RADIX).div_trunc(half_life);
    multiplier_from_exponent(
        exponent
            .to_i32()
            .unwrap_or_else(|| unreachable!("offer lag is within [-128H, 2H]")),
    )
}

/// `2^(exponent / 65536)` in Q128, from a Q16 exponent.
fn multiplier_from_exponent(exponent: i32) -> Integer {
    let radix = EXPONENT_RADIX as i32;
    let shifts = exponent.div_euclid(radix);
    let fraction = exponent.rem_euclid(radix) as u16;
    let scaled = q() * asert_fraction_factor(fraction);
    let scaled = if shifts < 0 {
        scaled >> shifts.unsigned_abs()
    } else {
        scaled << shifts.unsigned_abs()
    };
    scaled >> 16u32
}

/// Bitcoin Cash aserti3-2d approximation of `65536 * 2^(fraction / 65536)`,
/// with its coefficients and operation order unchanged.
fn asert_fraction_factor(fraction: u16) -> u32 {
    let x = u128::from(fraction);
    let polynomial = 195_766_423_245_049 * x + 971_821_376 * x * x + 5_127 * x * x * x + (1 << 47);
    (polynomial >> 48) as u32 + EXPONENT_RADIX
}

fn integer(value: U256) -> Integer {
    Integer::from_digits(&value.to_be_bytes::<32>(), Order::MsfBe)
}

fn signed_integer(value: I256) -> Integer {
    let raw = integer(value.into_raw());
    if value.is_negative() {
        raw - (Integer::from(1) << 256)
    } else {
        raw
    }
}

fn unsigned(value: &Integer) -> U256 {
    U256::from_be_slice(&value.to_digits::<u8>(Order::MsfBe))
}

fn signed(value: &Integer) -> I256 {
    let raw = if value < &0 {
        (Integer::from(1) << 256) + value
    } else {
        value.clone()
    };
    I256::from_raw(unsigned(&raw))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;
    use alloy_primitives::B256;
    use sha2::{Digest, Sha256};

    #[test]
    fn genesis_and_exact_power_of_two_terms() {
        let initial = initial_state();
        assert_eq!(signed_integer(initial.lag_q), Integer::ZERO);
        assert_eq!(progress_q(U256::ZERO), U256::ZERO);
        let first = quote(initial, 0);
        assert_eq!(first.multiplier_q, scale());
        assert_eq!(transition(initial, 0, 1).reward_each, first.internal_offer);
        for (seconds, numerator, denominator) in [
            (-172_800, 1, 2),
            (0, 1, 1),
            (172_800, 2, 1),
            (345_600, 4, 1),
        ] {
            let state = IssuanceState {
                issued_so_far: U256::ZERO,
                lag_q: signed(&(Integer::from(seconds) * &q())),
            };
            assert_eq!(
                quote(state, 0).multiplier_q,
                scale() * U256::from(numerator) / U256::from(denominator)
            );
        }
    }

    #[test]
    fn bounded_memory_and_fixed_allowance() {
        let thirty = transition(initial_state(), 30 * 86_400, 0);
        let ninety = transition(initial_state(), 90 * 86_400, 0);
        assert_eq!(thirty.state, ninety.state);
        let thirty_quote = quote(initial_state(), 30 * 86_400);
        assert_eq!(thirty_quote.multiplier_q, scale() * U256::from(4));
        assert_eq!(
            thirty_quote.block_allowance,
            quote(initial_state(), 90 * 86_400).block_allowance
        );
    }

    #[test]
    fn equal_allowance_and_supply_dust() {
        let saturated = transition(initial_state(), 12 * 86_400, 0).state;
        let one = transition(saturated, 0, 1);
        assert_eq!(one.reward_each, quote(saturated, 0).block_allowance);
        let many = transition(initial_state(), 0, 65);
        assert_eq!(
            many.reward_each,
            quote(initial_state(), 0).block_allowance / U256::from(65)
        );
        assert_eq!(many.new_issuance, many.reward_each * U256::from(65));
        let near = IssuanceState {
            issued_so_far: supply_cap() - U256::from(3),
            lag_q: I256::ZERO,
        };
        let dust = transition(near, 0, 4);
        assert_eq!(dust.reward_each, U256::ZERO);
        let final_one = transition(near, 0, 1);
        assert_eq!(final_one.state.issued_so_far, supply_cap());
        assert_eq!(
            transition(final_one.state, u64::MAX, 10).state,
            final_one.state
        );
    }

    #[test]
    fn halfway_progress_and_underflow_boundary() {
        let issued = supply_cap() * U256::from(3) / U256::from(4);
        assert_eq!(
            progress_q(issued),
            U256::from(DURATION_SECONDS / 2) * scale()
        );
        assert_eq!(baseline_q(issued), baseline_q(U256::ZERO) / U256::from(2));
        let threshold = -Integer::from(128 * HALF_LIFE_SECONDS) * &q();
        assert_eq!(multiplier(&(threshold.clone() - 1)), 0);
        assert_eq!(multiplier(&threshold), 1);
    }

    #[test]
    fn reservation_uses_one_action_reward() {
        assert!(reward_slot_active(initial_state(), 0));
        let threshold = -Integer::from(129 * HALF_LIFE_SECONDS) * &q();
        let underflow = IssuanceState {
            issued_so_far: U256::ZERO,
            lag_q: signed(&threshold),
        };
        assert!(!reward_slot_active(underflow, 0));
        let recovered = transition(underflow, 200 * 86_400, 1);
        assert!(quote(underflow, 200 * 86_400).multiplier_q > U256::ZERO);
        assert!(recovered.reward_each > U256::ZERO);
        assert!(reward_slot_active(underflow, 200 * 86_400));
    }

    const RADIX: i32 = EXPONENT_RADIX as i32;

    fn half_lives(count: i32) -> Integer {
        Integer::from(HALF_LIFE_SECONDS) * &q() * count
    }

    fn power_of_two(halves: i32) -> Integer {
        if halves < 0 {
            Integer::from(&q() >> halves.unsigned_abs())
        } else {
            Integer::from(&q() << halves.unsigned_abs())
        }
    }

    /// The most remembered lag is a whole number of half-lives, so it bounds the multiplier exactly.
    fn maximum_multiplier() -> Integer {
        power_of_two((MAXIMUM_LAG_SECONDS / HALF_LIFE_SECONDS) as i32)
    }

    fn at_lag(issued_so_far: U256, lag: &Integer) -> IssuanceState {
        IssuanceState {
            issued_so_far,
            lag_q: signed(lag),
        }
    }

    /// Smallest value in `(low, high]` that satisfies a monotone predicate
    /// false at `low` and true at `high`.
    fn first(mut low: Integer, mut high: Integer, reached: impl Fn(&Integer) -> bool) -> Integer {
        assert!(!reached(&low) && reached(&high));
        while Integer::from(&high - &low) > 1 {
            let middle = Integer::from(&low + &high) >> 1u32;
            if reached(&middle) {
                high = middle;
            } else {
                low = middle;
            }
        }
        high
    }

    struct SplitMix(u64);

    impl SplitMix {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^ (z >> 31)
        }

        fn below(&mut self, bound: &Integer) -> Integer {
            let mut value = Integer::new();
            for _ in 0..4 {
                value = (value << 64u32) + self.next();
            }
            value % bound
        }
    }

    #[test]
    fn every_fraction_factor() {
        let mut previous = 0;
        for fraction in 0..=u16::MAX {
            let factor = asert_fraction_factor(fraction);
            assert!((65_536..=131_071).contains(&factor), "{fraction}");
            assert!(factor >= previous, "{fraction}");
            previous = factor;
        }
        assert_eq!(asert_fraction_factor(0), 65_536);
        assert_eq!(asert_fraction_factor(u16::MAX), 131_071);
    }

    #[test]
    #[ignore = "exhaustive; run by the issuance conformance workflow"]
    fn every_q16_exponent() {
        let cap = maximum_multiplier();
        let mut digest = Sha256::new();
        let mut previous = Integer::new();
        for exponent in -128 * RADIX..=2 * RADIX {
            let multiplier = multiplier_from_exponent(exponent);
            assert!(multiplier >= previous && multiplier <= cap, "{exponent}");
            if exponent % RADIX == 0 {
                assert_eq!(multiplier, power_of_two(exponent / RADIX));
            }
            // Where the output is exact (shift >= -112), no step exceeds 2^-15.
            if exponent > -112 * RADIX {
                assert!(Integer::from(&multiplier - &previous) << 15u32 <= previous);
            }
            digest.update(unsigned(&multiplier).to_be_bytes::<32>());
            previous = multiplier;
        }
        assert_eq!(
            B256::from_slice(&digest.finalize()),
            alloy_primitives::b256!(
                "9a0bd21cbae0e76629fc374e4e0ffadbba0db4204dd40749320601518346b7b4"
            )
        );
    }

    #[test]
    fn whole_half_lives_are_exact() {
        for halves in -128..=2 {
            let lag = half_lives(halves);
            assert_eq!(multiplier(&lag), power_of_two(halves), "{halves}");
        }
    }

    #[test]
    fn q128_lag_truncates_to_the_q16_exponent_toward_zero() {
        let quantum = half_lives(1) / EXPONENT_RADIX;
        let cutoff = half_lives(-128);
        assert_eq!(multiplier(&Integer::from(&cutoff - 1u32)), 0);
        assert_eq!(multiplier(&cutoff), 1);
        assert_eq!(multiplier(&Integer::from(&cutoff + 1u32)), 1);
        assert_eq!(
            multiplier(&-quantum.clone()),
            Integer::from(&q() * 131_071u32) >> 17u32
        );

        let mut rng = SplitMix(394);
        let span = Integer::from(130 * RADIX + 1);
        let mut exponents = vec![-128 * RADIX, -RADIX - 1, -RADIX, -1, 0, 1, RADIX, 2 * RADIX];
        exponents.extend((0..20_000).map(|_| rng.below(&span).to_i32().unwrap() - 128 * RADIX));
        for k in exponents {
            let boundary = Integer::from(k) * &quantum;
            assert_eq!(multiplier(&boundary), multiplier_from_exponent(k), "{k}");
            if k > -128 * RADIX {
                let below = if k > 0 { k - 1 } else { k };
                let lag = Integer::from(&boundary - 1u32);
                assert_eq!(multiplier(&lag), multiplier_from_exponent(below), "{k}");
            }
            if k < 2 * RADIX {
                let above = if k < 0 { k + 1 } else { k };
                let lag = Integer::from(&boundary + 1u32);
                assert_eq!(multiplier(&lag), multiplier_from_exponent(above), "{k}");
            }
        }

        // Random lags from 2H below the cutoff up to the +2H clamp.
        let low = half_lives(-130);
        let width = half_lives(132) + 1u32;
        let mut lags: Vec<Integer> = (0..20_000)
            .map(|index| {
                if index % 2 == 0 {
                    let k = rng.below(&span).to_i32().unwrap() - 128 * RADIX;
                    let offset = rng.below(&Integer::from(7)) - 3u32;
                    (Integer::from(k) * &quantum + offset).min(half_lives(2))
                } else {
                    &low + rng.below(&width)
                }
            })
            .collect();
        lags.sort();
        let mut previous = Integer::new();
        for lag in lags {
            let multiplier = multiplier(&lag);
            assert!(multiplier >= previous);
            assert!(multiplier <= maximum_multiplier());
            assert_eq!(multiplier == 0, lag < cutoff);
            previous = multiplier;
        }
    }

    #[test]
    fn first_positive_offer_activates_the_reward_slot() {
        let cutoff = half_lives(-128);
        let active = |lag: &Integer| reward_slot_active(at_lag(U256::ZERO, lag), 0);
        let threshold = first(cutoff.clone(), Integer::new(), active);
        let before = at_lag(U256::ZERO, &Integer::from(&threshold - 1u32));
        let after = at_lag(U256::ZERO, &threshold);
        assert!(multiplier(&Integer::from(&threshold - 1u32)) > 0);
        assert_eq!(quote(before, 0).internal_offer, U256::ZERO);
        assert_eq!(quote(after, 0).internal_offer, U256::from(1));
        for count in [1, 2, 65] {
            let unpaid = transition(before, 0, count);
            assert_eq!(unpaid.new_issuance, U256::ZERO);
            assert_eq!(unpaid.state.lag_q, before.lag_q);
            let paid = transition(after, 0, count);
            assert_eq!(paid.reward_each, U256::from(1));
            assert_eq!(paid.new_issuance, U256::from(count));
        }

        // Elapsed time carries an underflowed lag across the cutoff and then
        // to the first positive offer.
        let parent = at_lag(U256::ZERO, &Integer::from(&cutoff - 5 * &q()));
        assert_eq!(quote(parent, 4).multiplier_q, U256::ZERO);
        assert_eq!(quote(parent, 5).multiplier_q, U256::from(1));
        let seconds = first(Integer::from(5), Integer::from(200 * 86_400), |elapsed| {
            reward_slot_active(parent, elapsed.to_u64().unwrap())
        })
        .to_u64()
        .unwrap();
        assert!(!reward_slot_active(parent, seconds - 1));
        let recovered = transition(parent, seconds, 1);
        assert_eq!(recovered.reward_each, U256::from(1));
        assert!(signed_integer(recovered.state.lag_q) < Integer::from(&cutoff + seconds * &q()));
    }

    #[test]
    fn allowance_binds_exactly_where_the_offer_exceeds_it() {
        let cutoff = half_lives(-128);
        let maximum = half_lives(2);
        for count in [1u64, 2, 65, 1_000_000] {
            let exceeds = |lag: &Integer| {
                let quote = quote(at_lag(U256::ZERO, lag), 0);
                quote.internal_offer > quote.block_allowance / U256::from(count)
            };
            if !exceeds(&maximum) {
                assert_eq!(count, 1);
                continue;
            }
            let threshold = first(cutoff.clone(), maximum.clone(), exceeds);
            let below = at_lag(U256::ZERO, &Integer::from(&threshold - 1u32));
            let offer = transition(below, 0, count);
            assert_eq!(offer.reward_each, quote(below, 0).internal_offer, "{count}");
            let at = at_lag(U256::ZERO, &threshold);
            let allowance = transition(at, 0, count);
            let at_quote = quote(at, 0);
            let each = at_quote.block_allowance / U256::from(count);
            assert_eq!(allowance.reward_each, each, "{count}");
            assert!(at_quote.internal_offer > each);
        }
        // One action at the maximum multiplier is held to the allowance.
        let top = at_lag(U256::ZERO, &maximum);
        let one = transition(top, 0, 1);
        assert_eq!(one.reward_each, quote(top, 0).block_allowance);
    }

    #[test]
    fn equal_settlement_at_allowance_equality() {
        // A multiplier near 2^-60 gives an internal offer of a few hundred atoms.
        let lag = half_lives(-60);
        let parent = at_lag(U256::ZERO, &lag);
        let quote = quote(parent, 0);
        let offer = quote.internal_offer;
        assert!(offer > U256::from(100) && offer < U256::from(10_000));
        for each in [offer - U256::from(1), offer, offer + U256::from(1)] {
            let count = quote.block_allowance / each;
            assert_eq!(quote.block_allowance / count, each, "allowance share");
            let settled = transition(parent, 0, count.to::<u64>());
            assert_eq!(settled.reward_each, offer.min(each));
            assert_eq!(settled.new_issuance, settled.reward_each * count);
        }
    }
}
