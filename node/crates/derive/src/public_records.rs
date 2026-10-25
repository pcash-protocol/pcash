//! The plaintext public segment of a private-value arena: application records
//! anyone can read. This is a wallet convention, not consensus: derivation
//! checks only the arena's length and hash, so these bytes are untrusted and
//! every malformed segment reads as no records.
//!
//! ```text
//! arena   = salt (32) ‖ cell_0 ‖ ... ‖ cell_(C-1)        65-byte cells
//! segment = "PCASHPUB" ‖ length (2) ‖ record list ‖ zeros, over cells 0..k-1
//! record  = application id (4, top bit set) ‖ uvarint length ‖ data
//! ```
//!
//! Records are strictly ordered by identifier and the segment stops short of
//! the last cell, which every arena reserves for the sender region.

use pcash_state::codec::codec_struct;

use crate::private_value_profiles::{L, S};

const SALT_BYTES: usize = 32;
const CELL_BYTES: usize = 65;
const MARKER: &[u8; 8] = b"PCASHPUB";
const HEADER_BYTES: usize = MARKER.len() + 2;
const APPLICATION_FLAG: u8 = 0x80;
const MAX_RECORD_BYTES: usize = 0xffff;

/// One application record: a four-byte identifier with its top bit set, and
/// opaque data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicRecord {
    pub schema: [u8; 4],
    pub data: Vec<u8>,
}

codec_struct!(PublicRecord { schema, data });

fn cell_offset(cell: usize) -> usize {
    SALT_BYTES + CELL_BYTES * cell
}

/// A canonical unsigned LEB128 no larger than [`MAX_RECORD_BYTES`].
fn read_length(bytes: &[u8], at: &mut usize) -> Option<usize> {
    let mut value = 0usize;
    for index in 0..3 {
        let byte = *bytes.get(*at)?;
        *at += 1;
        value |= usize::from(byte & 0x7f) << (7 * index);
        if byte & 0x80 == 0 {
            if byte == 0 && index > 0 {
                return None;
            }
            return (value <= MAX_RECORD_BYTES).then_some(value);
        }
    }
    None
}

/// The arena's public records, or `None` when the arena has no well-formed
/// public segment.
pub fn read_public_records(arena: &[u8]) -> Option<Vec<PublicRecord>> {
    if ![S.arena_bytes, L.arena_bytes].contains(&arena.len()) {
        return None;
    }
    let start = cell_offset(0);
    if arena.get(start..start + MARKER.len())? != MARKER {
        return None;
    }
    let length = usize::from(u16::from_be_bytes([
        arena[start + MARKER.len()],
        arena[start + MARKER.len() + 1],
    ]));
    let cells = (HEADER_BYTES + length).div_ceil(CELL_BYTES);
    if length == 0 || cell_offset(cells + 1) > arena.len() {
        return None;
    }
    let end = start + HEADER_BYTES + length;
    if arena[end..cell_offset(cells)].iter().any(|byte| *byte != 0) {
        return None;
    }
    let list = &arena[start + HEADER_BYTES..end];
    let mut records = Vec::new();
    let mut at = 0;
    while at < list.len() {
        // A standard one-byte identifier is SDK-managed and never public.
        if list[at] & APPLICATION_FLAG == 0 {
            return None;
        }
        let schema: [u8; 4] = list.get(at..at + 4)?.try_into().ok()?;
        at += 4;
        if records
            .last()
            .is_some_and(|previous: &PublicRecord| previous.schema >= schema)
        {
            return None;
        }
        let length = read_length(list, &mut at)?;
        let data = list.get(at..at + length)?.to_vec();
        at += length;
        records.push(PublicRecord { schema, data });
    }
    Some(records)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests use direct assertions")]
mod tests {
    use super::*;

    fn arena_with(list: &[u8]) -> Vec<u8> {
        let mut arena = vec![0u8; S.arena_bytes];
        let start = cell_offset(0);
        arena[start..start + 8].copy_from_slice(MARKER);
        arena[start + 8..start + 10].copy_from_slice(&(list.len() as u16).to_be_bytes());
        arena[start + 10..start + 10 + list.len()].copy_from_slice(list);
        arena
    }

    #[test]
    fn reads_ordered_application_records() {
        let mut list = vec![0x81, 1, 2, 3, 2, 0xaa, 0xbb];
        list.extend([0x90, 0, 0, 0, 0x80, 0x01]);
        list.extend(vec![7u8; 128]);
        let records = read_public_records(&arena_with(&list)).unwrap();
        assert_eq!(
            records,
            vec![
                PublicRecord {
                    schema: [0x81, 1, 2, 3],
                    data: vec![0xaa, 0xbb]
                },
                PublicRecord {
                    schema: [0x90, 0, 0, 0],
                    data: vec![7u8; 128]
                },
            ]
        );
    }

    #[test]
    fn refuses_malformed_segments() {
        let valid = [0x81, 1, 2, 3, 1, 9];
        assert!(read_public_records(&arena_with(&valid)).is_some());
        // Wrong arena length, missing marker, empty segment.
        assert!(read_public_records(&arena_with(&valid)[1..]).is_none());
        assert!(read_public_records(&vec![0u8; S.arena_bytes]).is_none());
        assert!(read_public_records(&arena_with(&[])).is_none());
        // A standard identifier, a repeated identifier, a truncated record.
        assert!(read_public_records(&arena_with(&[0x01, 1, 2, 3, 1, 9])).is_none());
        assert!(read_public_records(&arena_with(&[0x81, 1, 2, 3, 0, 0x81, 1, 2, 3, 0])).is_none());
        assert!(read_public_records(&arena_with(&[0x81, 1, 2, 3, 2, 9])).is_none());
        // A noncanonical length, nonzero padding.
        assert!(read_public_records(&arena_with(&[0x81, 1, 2, 3, 0x81, 0x00, 9])).is_none());
        let mut padded = arena_with(&valid);
        padded[cell_offset(0) + HEADER_BYTES + valid.len()] = 1;
        assert!(read_public_records(&padded).is_none());
    }
}
