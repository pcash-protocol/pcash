//! The protocol fee: a base fee per state unit that follows the excess of
//! used units over a per-block target, as EIP-4844's blob base fee does.

use alloy_primitives::U256;

pub const TARGET_UNITS_PER_BLOCK: u64 = 1_200;
pub const FEE_UPDATE_FRACTION: u64 = 63_000;
pub const ACCOUNT_WEIGHT: u64 = 2;
/// Bounds the base fee so that it times any transaction's units fits 128 bits.
pub const MAX_FEE_EXCESS: u64 = 85 * FEE_UPDATE_FRACTION;
/// The largest base fee at which a transaction with a private-value section
/// owes no protocol fee.
pub const MAX_WAIVED_BASE_FEE: u64 = 1_000_000_000;

/// EIP-4844's integer approximation of `factor * e^(numerator / denominator)`.
pub fn fake_exponential(factor: U256, numerator: U256, denominator: U256) -> U256 {
    let mut i = U256::from(1);
    let mut output = U256::ZERO;
    let mut numerator_accum = factor * denominator;
    while numerator_accum > U256::ZERO {
        output += numerator_accum;
        numerator_accum = (numerator_accum * numerator) / (denominator * i);
        i += U256::from(1);
    }
    output / denominator
}

/// The base fee per state unit of a block whose parent's excess is `fee_excess`.
pub fn base_fee(fee_excess: u64) -> U256 {
    fake_exponential(
        U256::from(1),
        U256::from(fee_excess),
        U256::from(FEE_UPDATE_FRACTION),
    ) - U256::from(1)
}

/// The excess after a block that used `used_units`.
pub fn next_fee_excess(fee_excess: u64, used_units: u64) -> u64 {
    (fee_excess + used_units)
        .saturating_sub(TARGET_UNITS_PER_BLOCK)
        .min(MAX_FEE_EXCESS)
}

/// The state units of a transaction that inserts `nullifiers` nullifiers and
/// allocates `new_accounts` accounts.
pub const fn state_units(nullifiers: u64, new_accounts: u64) -> u64 {
    nullifiers + ACCOUNT_WEIGHT * new_accounts
}

/// The base fee times `units`.
pub fn unit_fee(base_fee: U256, units: u64) -> U256 {
    base_fee * U256::from(units)
}

/// The burn a transaction with a private-value section must declare for
/// `units` state units: nothing while the base fee is at most
/// [`MAX_WAIVED_BASE_FEE`], the whole [`unit_fee`] above it.
pub fn required_fee(base_fee: U256, units: u64) -> U256 {
    if base_fee <= U256::from(MAX_WAIVED_BASE_FEE) {
        U256::ZERO
    } else {
        unit_fee(base_fee, units)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_excess_charges_nothing() {
        assert_eq!(base_fee(0), U256::ZERO);
        assert_eq!(base_fee(43_669), U256::ZERO);
        assert_eq!(base_fee(43_670), U256::from(1));
        assert_eq!(base_fee(2_175_943), U256::from(1_000_001_357_991_838u64));
    }

    #[test]
    fn maximum_fee_times_the_largest_units_fits_128_bits() {
        let maximum = base_fee(MAX_FEE_EXCESS);
        assert_eq!(
            maximum,
            U256::from(8_223_012_714_622_779_069_284_684_628_868_332_034u128)
        );
        // Profile L's 32 nullifiers plus one new account.
        let units = state_units(32, 1);
        assert_eq!(units, 34);
        assert!(required_fee(maximum, units) < U256::from(1) << 128);
    }

    #[test]
    fn the_waiver_ends_at_its_maximum_base_fee_and_then_the_whole_fee_is_owed() {
        let waived = U256::from(MAX_WAIVED_BASE_FEE);
        assert_eq!(required_fee(waived, 34), U256::ZERO);
        assert_eq!(
            required_fee(waived + U256::from(1), 4),
            U256::from(4_000_000_004u64)
        );
        assert_eq!(base_fee(1_305_565), U256::from(999_988_084u64));
        assert_eq!(required_fee(base_fee(1_305_565), 34), U256::ZERO);
        let first = base_fee(1_305_566);
        assert_eq!(first, U256::from(1_000_003_982u64));
        assert_eq!(required_fee(first, 4), unit_fee(first, 4));
    }

    #[test]
    fn excess_rises_above_the_target_decays_below_and_is_capped() {
        assert_eq!(next_fee_excess(0, 0), 0);
        assert_eq!(next_fee_excess(0, TARGET_UNITS_PER_BLOCK), 0);
        assert_eq!(next_fee_excess(0, TARGET_UNITS_PER_BLOCK + 7), 7);
        assert_eq!(next_fee_excess(5_000, TARGET_UNITS_PER_BLOCK), 5_000);
        assert_eq!(next_fee_excess(5_000, 200), 4_000);
        assert_eq!(next_fee_excess(500, 0), 0);
        assert_eq!(
            next_fee_excess(MAX_FEE_EXCESS, TARGET_UNITS_PER_BLOCK + 1),
            MAX_FEE_EXCESS
        );
        assert_eq!(
            next_fee_excess(MAX_FEE_EXCESS - 3, TARGET_UNITS_PER_BLOCK + 10),
            MAX_FEE_EXCESS
        );
    }

    #[test]
    fn a_minute_at_twice_the_target_raises_the_fee_about_ten_percent() {
        // Five blocks at twice the target add 6,000 units of excess.
        let start = 2_175_943;
        let after = (0..5).fold(start, |excess, _| {
            next_fee_excess(excess, 2 * TARGET_UNITS_PER_BLOCK)
        });
        assert_eq!(after, start + 6_000);
        let ratio = base_fee(after) * U256::from(1_000) / base_fee(start);
        assert_eq!(ratio, U256::from(1_099));
    }
}
