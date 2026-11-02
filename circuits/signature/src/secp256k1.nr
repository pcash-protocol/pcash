// Shared secp256k1 public-key and ECDSA-signature verification.
//
// The signing address is derived from the witnessed public key and kept private:
//   address = low160(keccak256(publicKeyX || publicKeyY))
// The signature (r||s, 64 bytes) is checked against the public key with the Noir
// stdlib secp256k1 verifier, which enforces the ECDSA relation over the curve.

use keccak256::keccak256;

pub struct Secp256k1PubKey {
    // Affine coordinates, 32-byte big-endian each.
    pub x: [u8; 32],
    pub y: [u8; 32],
}

pub struct Signature {
    // r (32) || s (32). The SDK emits canonical low-s signatures; this relation
    // delegates ECDSA validity to the pinned black box. Replay protection uses
    // transaction nullifiers, never the signature encoding.
    pub signature: [u8; 64],
}

impl Secp256k1PubKey {
    // address = low160(keccak256(x || y)) — the low 20 bytes of the digest.
    pub fn ethereum_address(self) -> Field {
        let mut preimage: [u8; 64] = [0; 64];
        for i in 0..32 {
            preimage[i] = self.x[i];
            preimage[32 + i] = self.y[i];
        }

        let hash = keccak256(preimage, 64);
        let mut address: Field = 0;
        for i in 12..32 {
            address = address * 256 + hash[i] as Field;
        }

        address
    }
}

impl Signature {
    pub fn verify(self, signing_hash: [u8; 32], signer: Secp256k1PubKey) {
        let ok = std::ecdsa_secp256k1::verify_signature(
            signer.x,
            signer.y,
            self.signature,
            signing_hash,
        );
        assert(ok, "signature must be valid");
    }
}
