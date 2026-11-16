//! Parsers for command-line arguments.
//!
//! These are input ergonomics, not wire encoding: a quantity may be typed as
//! decimal (`42`) or hex (`0x2a`), and a byte string may be typed with or
//! without the `0x` prefix in any case. Everything past this module is a typed
//! value, and `pcash-rpc` owns how it is written on the wire.

use alloy_primitives::{Address, Bytes, B256, U256};
use eyre::{bail, eyre, Result};

/// An unsigned integer, decimal or `0x`-hex.
pub fn u64_arg(value: &str) -> Result<u64> {
    let value = value.trim();
    if value.is_empty() {
        bail!("expected an unsigned integer, got an empty value");
    }
    let parsed = match strip_prefix(value) {
        Some(hex) => u64::from_str_radix(hex, 16),
        None => value.parse::<u64>(),
    };
    parsed.map_err(|_| eyre!("`{value}` is not a valid unsigned integer (decimal or 0x-hex)"))
}

/// A wei amount, decimal or `0x`-hex.
pub fn u256_arg(value: &str) -> Result<U256> {
    let value = value.trim();
    if value.is_empty() {
        bail!("expected an unsigned integer, got an empty value");
    }
    let parsed = match strip_prefix(value) {
        Some(hex) => U256::from_str_radix(hex, 16),
        None => U256::from_str_radix(value, 10),
    };
    parsed.map_err(|_| eyre!("`{value}` is not a valid unsigned integer (decimal or 0x-hex)"))
}

/// A 32-byte value: hash, root, nullifier, content id, or transaction id.
pub fn hash_arg(value: &str) -> Result<B256> {
    Ok(B256::from(fixed::<32>(value, "value")?))
}

/// A 20-byte address.
///
/// Parsed leniently rather than through `Address::from_str`, which rejects a
/// mixed-case address whose EIP-55 checksum does not match; PCASH addresses are
/// not Ethereum accounts and are not checksummed.
pub fn address_arg(value: &str) -> Result<Address> {
    Ok(Address::from(fixed::<20>(value, "address")?))
}

/// An arbitrary-length byte string, such as a raw transaction.
pub fn bytes_arg(value: &str) -> Result<Bytes> {
    let body = strip_prefix(value).unwrap_or_else(|| value.trim());
    let bytes = hex::decode(body).map_err(|e| eyre!("value is not valid hex: {e}"))?;
    Ok(Bytes::from(bytes))
}

fn strip_prefix(value: &str) -> Option<&str> {
    let value = value.trim();
    value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
}

fn fixed<const N: usize>(value: &str, label: &str) -> Result<[u8; N]> {
    let body = strip_prefix(value).unwrap_or_else(|| value.trim());
    let bytes = hex::decode(body).map_err(|e| eyre!("{label} is not valid hex: {e}"))?;
    if bytes.len() != N {
        bail!(
            "{label} must be {N} bytes ({} hex chars), got {}",
            N * 2,
            bytes.len()
        );
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;

    #[test]
    fn quantities_accept_decimal_and_hex() {
        assert_eq!(u64_arg("42").unwrap(), 42);
        assert_eq!(u64_arg("0x2a").unwrap(), 42);
        assert_eq!(u64_arg("0X2A").unwrap(), 42);
        assert_eq!(u256_arg("0x10").unwrap(), U256::from(16));
        assert_eq!(u256_arg("16").unwrap(), U256::from(16));
        assert!(u64_arg("nope").is_err());
        assert!(u256_arg("").is_err());
        assert!(u64_arg("").is_err());
        assert!(u64_arg("0x").is_err());
    }

    #[test]
    fn byte_strings_are_case_and_prefix_insensitive() {
        let expected = Address::from([0xab; 20]);
        assert_eq!(
            address_arg(&format!("0x{}", "AB".repeat(20))).unwrap(),
            expected
        );
        assert_eq!(address_arg(&"ab".repeat(20)).unwrap(), expected);

        assert_eq!(hash_arg(&"00".repeat(32)).unwrap(), B256::ZERO);
        assert_eq!(bytes_arg("0x0102").unwrap(), Bytes::from(vec![1, 2]));
        assert_eq!(bytes_arg("").unwrap(), Bytes::new());
    }

    #[test]
    fn wrong_widths_are_rejected() {
        assert!(address_arg("0x1234").is_err());
        assert!(hash_arg("0x1234").is_err());
        assert!(hash_arg("0xzz").is_err());
    }

    #[test]
    fn a_mixed_case_address_is_not_checksum_validated() {
        // `Address::from_str` would reject this; PCASH addresses carry no EIP-55
        // checksum, so the CLI must accept whatever case the user typed.
        let mixed = "0xaAbBccDDeeFF00112233445566778899aabbccdd";
        assert_eq!(
            address_arg(mixed).unwrap(),
            Address::from([
                0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
                0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            ])
        );
    }
}
