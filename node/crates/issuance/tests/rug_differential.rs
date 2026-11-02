//! Compares the settlement arithmetic with the former GMP implementation.
#![allow(
    clippy::unwrap_used,
    reason = "tests use direct assertions for fixture setup"
)]

use alloy_primitives::{I256, U256};
use pcash_issuance::{
    IssuanceState, Quote, Settlement, DURATION_SECONDS, EXPONENT_RADIX, HALF_LIFE_SECONDS,
    MAXIMUM_LAG_SECONDS,
};

/// The rug implementation as it was before the num-bigint port.
mod reference {
    use super::{IssuanceState, Quote, Settlement};
    use alloy_primitives::{I256, U256};
    use pcash_issuance::{
        supply_cap, DURATION_SECONDS, EXPONENT_RADIX, FRACTION_BITS, HALF_LIFE_SECONDS,
        INITIAL_LAG_SECONDS, MAXIMUM_LAG_SECONDS, MAXIMUM_SPEED, REFERENCE_INTERVAL_SECONDS,
    };
    use rug::{integer::Order, ops::DivRounding, Integer};

    pub struct BlockTerms {
        pub quote: Quote,
        parent: IssuanceState,
        progress: Integer,
        offer_lag: Integer,
        allowance_q: Integer,
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
        let baseline =
            (Integer::from(2) * &cap * REFERENCE_INTERVAL_SECONDS * root) / DURATION_SECONDS;
        (progress, baseline)
    }

    fn multiplier(offer_lag: &Integer) -> Integer {
        let half_life = Integer::from(HALF_LIFE_SECONDS) * q();
        if offer_lag < &-Integer::from(128 * &half_life) {
            return Integer::from(0);
        }
        let exponent = Integer::from(offer_lag * EXPONENT_RADIX).div_trunc(half_life);
        multiplier_from_exponent(exponent.to_i32().unwrap())
    }

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

    fn asert_fraction_factor(fraction: u16) -> u32 {
        let x = u128::from(fraction);
        let polynomial =
            195_766_423_245_049 * x + 971_821_376 * x * x + 5_127 * x * x * x + (1 << 47);
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

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    /// A value whose bit length is uniform in `0..=256`.
    fn any_width(&mut self) -> U256 {
        let value = U256::from_limbs([self.next(), self.next(), self.next(), self.next()]);
        let width = self.below(257) as usize;
        if width == 0 {
            U256::ZERO
        } else {
            value >> (256 - width)
        }
    }

    fn below_u256(&mut self, bound: U256) -> U256 {
        U256::from_limbs([self.next(), self.next(), self.next(), self.next()]) % bound
    }

    fn pick<T: Copy>(&mut self, values: &[T]) -> T {
        values[self.below(values.len() as u64) as usize]
    }
}

fn q() -> I256 {
    I256::from_raw(pcash_issuance::scale())
}

fn seconds(value: i64) -> I256 {
    I256::try_from(value).unwrap() * q()
}

fn cap() -> U256 {
    pcash_issuance::supply_cap()
}

fn edge_issued() -> Vec<U256> {
    let cap = cap();
    let mut values = vec![
        U256::ZERO,
        U256::from(1),
        U256::from(2),
        U256::from(1_000_000_000_000_000_000u64),
        cap / U256::from(4),
        cap / U256::from(2),
        cap * U256::from(3) / U256::from(4),
        cap * U256::from(3) / U256::from(4) + U256::from(1),
        cap - U256::from(1_000_000_000_000_000_000u64),
        cap + U256::from(1),
        cap * U256::from(2),
        U256::MAX,
    ];
    values.extend((0..=4u64).map(|below| cap - U256::from(below)));
    values
}

fn edge_lags() -> Vec<I256> {
    let half_life = seconds(HALF_LIFE_SECONDS as i64);
    let quantum = half_life / I256::try_from(EXPONENT_RADIX).unwrap();
    let cutoff = -half_life * I256::try_from(128).unwrap();
    let maximum = seconds(MAXIMUM_LAG_SECONDS as i64);
    let one = I256::ONE;
    let mut values = vec![
        I256::ZERO,
        one,
        -one,
        I256::MIN,
        I256::MIN + one,
        I256::MAX,
        I256::MAX - one,
        -seconds(DURATION_SECONDS as i64),
        -half_life * I256::try_from(129).unwrap(),
        -half_life * I256::try_from(60).unwrap(),
    ];
    for base in [cutoff, maximum, quantum, -quantum, half_life, -half_life] {
        for delta in -2..=2 {
            values.push(base + I256::try_from(delta).unwrap());
        }
    }
    values
}

fn edge_elapsed() -> Vec<u64> {
    vec![
        0,
        1,
        2,
        12,
        13,
        HALF_LIFE_SECONDS - 1,
        HALF_LIFE_SECONDS,
        MAXIMUM_LAG_SECONDS,
        MAXIMUM_LAG_SECONDS + 1,
        128 * HALF_LIFE_SECONDS,
        200 * 86_400,
        DURATION_SECONDS,
        u64::from(u32::MAX),
        u64::MAX - 1,
        u64::MAX,
    ]
}

fn edge_actions() -> Vec<u64> {
    vec![0, 1, 2, 3, 4, 65, 1_000, 1_000_000, u64::MAX / 2, u64::MAX]
}

fn random_issued(rng: &mut SplitMix) -> U256 {
    let cap = cap();
    match rng.below(5) {
        0 => rng.below_u256(cap),
        1 => U256::from(rng.below(1 << 20)),
        2 => cap - U256::from(rng.below(1 << 20)),
        3 => rng.any_width(),
        _ => cap - rng.any_width() % cap,
    }
}

fn random_lag(rng: &mut SplitMix) -> I256 {
    let half_life = seconds(HALF_LIFE_SECONDS as i64);
    let quantum = half_life / I256::try_from(EXPONENT_RADIX).unwrap();
    match rng.below(5) {
        // Uniform over two half-lives below the cutoff to just above the clamp.
        0 => {
            let low = -half_life * I256::try_from(130).unwrap();
            let width = (half_life * I256::try_from(134).unwrap()).into_raw();
            low + I256::from_raw(rng.below_u256(width))
        }
        // Next to a Q16 exponent boundary.
        1 => {
            let k =
                rng.below(132 * u64::from(EXPONENT_RADIX)) as i64 - 130 * i64::from(EXPONENT_RADIX);
            let offset = rng.below(7) as i64 - 3;
            quantum * I256::try_from(k).unwrap() + I256::try_from(offset).unwrap()
        }
        // Anywhere a full year of progress can carry the lag.
        2 => {
            let width = seconds(DURATION_SECONDS as i64 + MAXIMUM_LAG_SECONDS as i64);
            seconds(MAXIMUM_LAG_SECONDS as i64) - I256::from_raw(rng.below_u256(width.into_raw()))
        }
        // Any width, either sign.
        3 => {
            let magnitude = I256::from_raw(rng.any_width() >> 1);
            if rng.below(2) == 0 {
                magnitude
            } else {
                -magnitude
            }
        }
        _ => I256::from_raw(rng.any_width()),
    }
}

fn random_elapsed(rng: &mut SplitMix) -> u64 {
    match rng.below(4) {
        0 => rng.below(100),
        1 => rng.below(2 * MAXIMUM_LAG_SECONDS),
        2 => rng.below(400 * 86_400),
        _ => rng.next() >> rng.below(64),
    }
}

fn random_actions(rng: &mut SplitMix) -> u64 {
    match rng.below(4) {
        0 => 0,
        1 => 1 + rng.below(100),
        2 => 1 + rng.below(1 << 24),
        _ => rng.next() >> rng.below(64),
    }
}

fn assert_same(parent: IssuanceState, elapsed_seconds: u64, actions: u64) {
    let expected = reference::block_terms(parent, elapsed_seconds);
    let actual = pcash_issuance::block_terms(parent, elapsed_seconds);
    let context = format!("{parent:?} elapsed {elapsed_seconds} actions {actions}");
    assert_eq!(actual.quote, expected.quote, "{context}");
    assert_eq!(
        pcash_issuance::settle(actual, actions),
        reference::settle(expected, actions),
        "{context}"
    );
}

#[test]
fn initial_state_matches() {
    assert_eq!(pcash_issuance::initial_state(), reference::initial_state());
}

#[test]
fn progress_and_baseline_match() {
    let mut rng = SplitMix(0x1550);
    let mut issued = edge_issued();
    issued.extend((0..20_000).map(|_| random_issued(&mut rng)));
    for value in issued {
        assert_eq!(
            pcash_issuance::progress_q(value),
            reference::progress_q(value),
            "{value}"
        );
        assert_eq!(
            pcash_issuance::baseline_q(value),
            reference::baseline_q(value),
            "{value}"
        );
    }
}

#[test]
fn edge_grid_matches() {
    let issued = edge_issued();
    let lags = edge_lags();
    let elapsed = edge_elapsed();
    let actions = edge_actions();
    for &issued_so_far in &issued {
        for &lag_q in &lags {
            let parent = IssuanceState {
                issued_so_far,
                lag_q,
            };
            for &seconds in &elapsed {
                for &count in &actions {
                    assert_same(parent, seconds, count);
                }
            }
        }
    }
}

#[test]
fn random_blocks_match() {
    let mut rng = SplitMix(0x5eed);
    let issued = edge_issued();
    let lags = edge_lags();
    let elapsed = edge_elapsed();
    let actions = edge_actions();
    for _ in 0..100_000 {
        let parent = IssuanceState {
            issued_so_far: if rng.below(4) == 0 {
                rng.pick(&issued)
            } else {
                random_issued(&mut rng)
            },
            lag_q: if rng.below(4) == 0 {
                rng.pick(&lags)
            } else {
                random_lag(&mut rng)
            },
        };
        let seconds = if rng.below(4) == 0 {
            rng.pick(&elapsed)
        } else {
            random_elapsed(&mut rng)
        };
        let count = if rng.below(4) == 0 {
            rng.pick(&actions)
        } else {
            random_actions(&mut rng)
        };
        assert_same(parent, seconds, count);
    }
}

#[test]
fn chained_trajectories_match() {
    let mut rng = SplitMix(0x7a11);
    for _ in 0..20 {
        let mut state = pcash_issuance::initial_state();
        for _ in 0..2_000 {
            let seconds = match rng.below(8) {
                0 => rng.below(4 * 86_400),
                _ => rng.below(30),
            };
            let count = match rng.below(4) {
                0 => 0,
                1 => 1,
                _ => rng.below(1 << 20),
            };
            assert_same(state, seconds, count);
            state = pcash_issuance::transition(state, seconds, count).state;
            if state.issued_so_far == cap() {
                break;
            }
        }
    }
}
