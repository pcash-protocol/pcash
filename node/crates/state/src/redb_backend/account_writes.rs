//! Row encoding for the canonical per-block account-write record.

use super::backend;
use crate::codec::{Codec, DecodeError, Reader, Writer};
use crate::{AccountWrite, StateError, B256};

pub(super) fn account_write_key(block_number: u64, ordinal: u32) -> [u8; 12] {
    let mut key = [0u8; 12];
    key[..8].copy_from_slice(&block_number.to_be_bytes());
    key[8..].copy_from_slice(&ordinal.to_be_bytes());
    key
}

pub(super) fn decode_account_write_key(key: &[u8]) -> Result<(u64, u32), StateError> {
    if key.len() != 12 {
        return Err(backend("account-write key has unexpected length"));
    }
    Ok((
        u64::from_be_bytes(key[..8].try_into().unwrap()),
        u32::from_be_bytes(key[8..].try_into().unwrap()),
    ))
}

pub(super) fn encode_account_write_row(block_hash: B256, write: &AccountWrite) -> Vec<u8> {
    let mut row = Writer::default();
    block_hash.write(&mut row);
    write.write(&mut row);
    row.into_bytes()
}

pub(super) fn decode_account_write_row(row: &[u8]) -> Result<(B256, AccountWrite), StateError> {
    let mut r = Reader::new(row);
    let block_hash = B256::read(&mut r).map_err(backend)?;
    let write = AccountWrite::read(&mut r).map_err(backend)?;
    r.finish().map_err(DecodeError::from).map_err(backend)?;
    Ok((block_hash, write))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "tests use direct assertions"
)]
mod tests {
    use super::*;
    use crate::{AccountState, Address, Fr, ML_KEM768_PUBLIC_KEY_LEN};

    fn write(published_receive_key: Option<Vec<u8>>) -> AccountWrite {
        AccountWrite {
            address: Address::repeat_byte(0x41),
            account: AccountState {
                index: 0x0102_0304_0506,
                revision: 7,
                nullifier_key_commitment: Fr::from(11u64),
                account_rule_set_commitment: Fr::from(12u64),
                kind: 1,
                receive_key_hash: B256::repeat_byte(0x13),
            },
            published_receive_key,
        }
    }

    #[test]
    fn rows_round_trip_with_and_without_a_published_key() {
        for published in [None, Some(vec![0x5a; ML_KEM768_PUBLIC_KEY_LEN])] {
            let write = write(published);
            let row = encode_account_write_row(B256::repeat_byte(0x22), &write);
            assert_eq!(
                decode_account_write_row(&row).unwrap(),
                (B256::repeat_byte(0x22), write)
            );
        }
        let row = encode_account_write_row(B256::ZERO, &write(None));
        assert!(decode_account_write_row(&row[..row.len() - 1]).is_err());
        assert!(decode_account_write_row(&[row.as_slice(), &[0]].concat()).is_err());
        assert_eq!(
            decode_account_write_key(&account_write_key(9, 3)).unwrap(),
            (9, 3)
        );
    }
}
