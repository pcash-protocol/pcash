// PCASH range checks.

use crate::primitives::params::{ADDRESS_BITS, AMOUNT_BITS, ASSET_AGGREGATE_BITS, VALID_UNTIL_BITS};

pub fn assert_address(x: Field) {
    x.assert_max_bit_size::<ADDRESS_BITS>();
}

pub fn assert_amount(x: Field) {
    x.assert_max_bit_size::<AMOUNT_BITS>();
}

pub fn assert_asset_aggregate(x: Field) {
    x.assert_max_bit_size::<ASSET_AGGREGATE_BITS>();
}

// A 64-bit timestamp: a validity bound, where a zero not-before bound is
// unconstrained, or a deadline.
pub fn assert_timestamp(x: Field) {
    x.assert_max_bit_size::<VALID_UNTIL_BITS>();
}

// `a <= b` for two timestamps, each range-checked to the timestamp width.
pub fn timestamp_le(a: Field, b: Field) -> bool {
    assert_timestamp(a);
    assert_timestamp(b);
    (a as u64) <= (b as u64)
}

mod tests {
    use crate::primitives::params::ASSET_AGGREGATE_BITS;
    use super::{
        assert_address, assert_amount, assert_asset_aggregate, assert_timestamp, timestamp_le,
    };

    #[test]
    fn test_range_helpers_accept_in_range() {
        assert_address(0xffffffffffffffffffffffffffffffffffffffff); // 2^160 - 1
        assert_amount(0xffffffffffffffffffffffffffffffff); // 2^128 - 1
        assert_asset_aggregate((2 as Field).pow_32(ASSET_AGGREGATE_BITS as Field) - 1);
        assert_timestamp(0xffffffffffffffff); // 2^64 - 1
    }

    #[test(should_fail)]
    fn test_amount_rejects_2_to_128() {
        assert_amount(0x100000000000000000000000000000000);
    }

    #[test(should_fail)]
    fn test_asset_aggregate_rejects_aggregate_limit() {
        assert_asset_aggregate((2 as Field).pow_32(ASSET_AGGREGATE_BITS as Field));
    }

    #[test(should_fail)]
    fn test_address_rejects_2_to_160() {
        assert_address(0x10000000000000000000000000000000000000000);
    }

    #[test(should_fail)]
    fn test_timestamp_rejects_2_to_64() {
        assert_timestamp(0x10000000000000000);
    }

    #[test]
    fn test_timestamp_le_compares_in_range_values() {
        assert(timestamp_le(100, 200));
        assert(timestamp_le(200, 200));
        assert(!timestamp_le(201, 200));
        assert(timestamp_le(0xffffffffffffffff, 0xffffffffffffffff));
    }

    #[test(should_fail)]
    fn test_timestamp_le_rejects_a_value_above_the_timestamp_width() {
        let _ = timestamp_le(0, 0x10000000000000000);
    }

    #[test(should_fail)]
    fn test_amount_rejects_negative_field_representative() {
        assert_amount(-1);
    }
}
