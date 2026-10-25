// EIP-712 encoding for applications that verify secp256k1 signatures. They
// sign through the reference rules' configuration.

use keccak256::keccak256;

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

mod tests {
    use super::domain_separator;

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
