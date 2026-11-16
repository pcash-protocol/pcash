// EIP-712 encoding for applications that verify secp256k1 signatures. They
// sign through the reference rules' configuration.

use keccak256::keccak256;
use std::hash::keccakf1600;

global KECCAK_RATE: u32 = 136;
global KECCAK_RATE_LANES: u32 = 17;

fn write_bytes32<let N: u32>(src: [u8; 32], buf: &mut [u8; N], offset: u32) {
    for i in 0..32 {
        buf[offset + i] = src[i];
    }
}

fn write_field_as_u256<let N: u32>(value: Field, buf: &mut [u8; N], offset: u32) {
    let bytes: [u8; 32] = value.to_be_bytes();
    write_bytes32(bytes, buf, offset);
}

// The 32-byte domain separator an application commits as two 128-bit halves,
// high half first. The range checks make the halves a unique encoding of the
// separator.
pub fn domain_separator(high: Field, low: Field) -> [u8; 32] {
    high.assert_max_bit_size::<128>();
    low.assert_max_bit_size::<128>();
    let high_bytes: [u8; 16] = high.to_be_bytes();
    let low_bytes: [u8; 16] = low.to_be_bytes();
    let mut separator: [u8; 32] = [0; 32];
    for i in 0..16 {
        separator[i] = high_bytes[i];
        separator[16 + i] = low_bytes[i];
    }
    separator
}

fn eip712_signing_hash(domain_separator: [u8; 32], struct_hash: [u8; 32]) -> [u8; 32] {
    let mut preimage: [u8; 66] = [0; 66];
    preimage[0] = 0x19;
    preimage[1] = 0x01;
    for i in 0..32 {
        preimage[2 + i] = domain_separator[i];
        preimage[34 + i] = struct_hash[i];
    }
    keccak256(preimage, 66)
}

// hashStruct of a message whose fields are all single 32-byte words.
fn flat_struct_hash<let N: u32>(type_hash: [u8; 32], fields: [Field; N]) -> [u8; 32] {
    let mut preimage: [u8; 32 * (N + 1)] = [0; 32 * (N + 1)];
    write_bytes32(type_hash, &mut preimage, 0);
    for i in 0..N {
        write_field_as_u256(fields[i], &mut preimage, 32 * (i + 1));
    }
    keccak256(preimage, 32 * (N + 1))
}

pub fn flat_message_signing_hash<let N: u32>(
    domain_separator: [u8; 32],
    type_hash: [u8; 32],
    fields: [Field; N],
) -> [u8; 32] {
    eip712_signing_hash(domain_separator, flat_struct_hash(type_hash, fields))
}

// The signing hash of a flat message under one of two types: `type_hash` over
// `fields`, or, when `extended`, `extended_type_hash` over `fields` with
// `extension` inserted before `fields[at]`. Callers pass a constant `at`, so
// every word is a field or a choice between two, and one Keccak absorbs the
// selected encoding.
pub fn flat_message_signing_hash_either<let N: u32, let K: u32>(
    domain_separator: [u8; 32],
    type_hash: [u8; 32],
    extended_type_hash: [u8; 32],
    fields: [Field; N],
    at: u32,
    extension: [Field; K],
    extended: bool,
) -> [u8; 32] {
    let mut preimage: [u8; 32 * (N + K + 1)] = [0; 32 * (N + K + 1)];
    for i in 0..32 {
        preimage[i] = if extended {
            extended_type_hash[i]
        } else {
            type_hash[i]
        };
    }
    for i in 0..N + K {
        let base = if i < N { fields[i] } else { 0 };
        let inserted = if i < at {
            fields[i]
        } else if i < at + K {
            extension[i - at]
        } else {
            fields[i - K]
        };
        write_field_as_u256(
            if extended { inserted } else { base },
            &mut preimage,
            32 * (i + 1),
        );
    }
    eip712_signing_hash(
        domain_separator,
        keccak256_prefix_or_full(preimage, 32 * (N + 1), extended),
    )
}

// Byte `i` of Keccak's pad10*1 after a `length`-byte message: 0x01 right after
// the message, 0x80 at the end of its last block, 0x81 when they coincide.
fn keccak_padding(length: u32, i: u32) -> Field {
    let last = (length / KECCAK_RATE + 1) * KECCAK_RATE - 1;
    (if i == length { 0x01 } else { 0 }) + (if i == last { 0x80 } else { 0 })
}

// Keccak-256 of `input`, or of its first `prefix` bytes when not `full`. With
// a constant `prefix`, each padded byte is an input byte, a padding constant,
// or a choice between them, so one sponge absorbs the longer message and
// returns the state after the selected message's last block.
fn keccak256_prefix_or_full<let N: u32>(input: [u8; N], prefix: u32, full: bool) -> [u8; 32] {
    let prefix_blocks = prefix / KECCAK_RATE + 1;
    let mut state: [u64; 25] = [0; 25];
    let mut prefix_state = state;
    for b in 0..N / KECCAK_RATE + 1 {
        for j in 0..KECCAK_RATE_LANES {
            let mut lane: Field = 0;
            let mut weight: Field = 1;
            for k in 0..8 {
                let i = b * KECCAK_RATE + 8 * j + k;
                let full_byte = if i < N {
                    input[i] as Field
                } else {
                    keccak_padding(N, i)
                };
                let prefix_byte = if i < prefix {
                    input[i] as Field
                } else {
                    keccak_padding(prefix, i)
                };
                lane += weight * (if full { full_byte } else { prefix_byte });
                weight *= 256;
            }
            state[j] = state[j] ^ (lane as u64);
        }
        state = keccakf1600(state);
        if b + 1 == prefix_blocks {
            prefix_state = state;
        }
    }
    let state = if full { state } else { prefix_state };
    let mut digest = [0; 32];
    for i in 0..4 {
        let lane: [u8; 8] = (state[i] as Field).to_le_bytes();
        for j in 0..8 {
            digest[8 * i + j] = lane[j];
        }
    }
    digest
}

mod tests {
    use super::{
        domain_separator, flat_message_signing_hash, flat_message_signing_hash_either,
        keccak256_prefix_or_full,
    };
    use keccak256::keccak256;

    unconstrained fn opaque<T>(value: T) -> T {
        value
    }

    // Input byte i is (i * 7 + 3) mod 256, as in the Keccak boundary tests.
    fn probe<let N: u32>() -> [u8; N] {
        let mut input: [u8; N] = [0; N];
        for i in 0..N {
            input[i] = ((i * 7 + 3) % 256) as u8;
        }
        input
    }

    // Both selections against the vendored Keccak, with the choice a witness.
    fn assert_prefix_or_full<let N: u32, let M: u32>() {
        let input = probe::<N>();
        let mut prefix: [u8; M] = [0; M];
        for i in 0..M {
            prefix[i] = input[i];
        }
        // Safety: the test only makes the choice a witness.
        let (full, short) = unsafe { (opaque(true), opaque(false)) };
        assert(keccak256_prefix_or_full(input, M, full) == keccak256(input, N));
        assert(keccak256_prefix_or_full(input, M, short) == keccak256(prefix, M));
    }

    #[test]
    fn test_prefix_or_full_keccak_matches_keccak256() {
        // The same block count, one block more, the 0x81 padding byte, and a
        // prefix that ends exactly at a block boundary.
        assert_prefix_or_full::<480, 416>();
        assert_prefix_or_full::<448, 384>();
        assert_prefix_or_full::<136, 135>();
        assert_prefix_or_full::<300, 136>();
    }

    global FIELDS: [Field; 5] = [1, 2, 3, 4, 5];
    global TYPE_HASH: [u8; 32] = [0x11; 32];
    global EXTENDED_TYPE_HASH: [u8; 32] = [0x22; 32];

    #[test]
    fn test_either_signing_hash_signs_the_selected_type() {
        let separator = [0x33; 32];
        // Safety: the test only makes the choice a witness.
        let (extended, base) = unsafe { (opaque(true), opaque(false)) };
        assert(
            flat_message_signing_hash_either(
                separator,
                TYPE_HASH,
                EXTENDED_TYPE_HASH,
                FIELDS,
                2,
                [8, 9],
                base,
            )
                == flat_message_signing_hash(separator, TYPE_HASH, FIELDS),
        );
        assert(
            flat_message_signing_hash_either(
                separator,
                TYPE_HASH,
                EXTENDED_TYPE_HASH,
                FIELDS,
                2,
                [8, 9],
                extended,
            )
                == flat_message_signing_hash(separator, EXTENDED_TYPE_HASH, [1, 2, 8, 9, 3, 4, 5]),
        );
    }

    // The PCASH domain for L1 chain 11155111 and inbox 0x5043...0000, from viem's hashDomain.
    global SEPARATOR: [u8; 32] = [
        0xfa, 0xf4, 0xc1, 0xbe, 0x8b, 0x91, 0x55, 0x5f, 0x6d, 0x02, 0x3a, 0xe6, 0x67, 0x5c, 0x7a,
        0xff, 0x30, 0x0b, 0xb3, 0xb6, 0xd9, 0x7d, 0x03, 0x05, 0xac, 0x50, 0xdd, 0x19, 0x8d, 0xd1,
        0x6b, 0xff,
    ];

    #[test]
    fn test_domain_separator_joins_its_halves_high_first() {
        assert(
            domain_separator(
                0xfaf4c1be8b91555f6d023ae6675c7aff,
                0x300bb3b6d97d0305ac50dd198dd16bff,
            )
                == SEPARATOR,
        );
    }

    #[test(should_fail)]
    fn test_domain_separator_rejects_a_half_wider_than_128_bits() {
        let _ = domain_separator(0x100000000000000000000000000000000, 0);
    }
}
