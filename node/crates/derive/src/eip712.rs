//! EIP-712 user-account-creation authorization.
//!
//! A kind-1 user-account creation is authorized either by the Ethereum sender
//! of its carrier or by an Ethereum ECDSA signature over the
//! `PcashUserAccountCreation` typed-data message under the domain. The
//! authorization names the account: the sender, or the signer derivation
//! recovers node-side.

use alloy_primitives::{keccak256, Address, U256};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use pcash_state::{CircuitWord, DerivationSource};

use crate::transaction::{AccountCreationAuthorization, UserAccountCreation};

const USER_ACCOUNT_CREATION_TYPE: &str = "PcashUserAccountCreation(uint256 pcashChainId,uint256 nullifierKeyCommitment,uint256 ruleSetCommitment,bytes32 receiveKeyHash,bytes32 recentPcashBlockHash,uint256 validUntilTimestamp)";

/// `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`.
pub fn domain_type_hash() -> CircuitWord {
    keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
}

/// `keccak256("PcashUserAccountCreation(...)")` — the primary type.
pub fn account_type_hash() -> CircuitWord {
    keccak256(USER_ACCOUNT_CREATION_TYPE.as_bytes())
}

pub fn domain_name_hash() -> CircuitWord {
    keccak256(b"PCASH")
}

pub fn domain_version_hash() -> CircuitWord {
    keccak256(b"1")
}

/// Left-pad a 20-byte address into an EIP-712 `address` word (32 bytes).
fn address_word(addr: Address) -> [u8; 32] {
    addr.into_word().0
}

/// Encode an integer as a big-endian 32-byte EIP-712 `uint256`.
fn uint_word(x: u64) -> [u8; 32] {
    U256::from(x).to_be_bytes()
}

/// The domain separator with `name="PCASH"`, `version="1"`,
/// `chainId=L1_CHAIN_ID`, `verifyingContract=INBOX_ADDRESS`.
fn domain_separator(l1_chain_id: u64, inbox_address: Address) -> CircuitWord {
    let mut buf = Vec::with_capacity(32 * 5);
    buf.extend_from_slice(domain_type_hash().as_slice());
    buf.extend_from_slice(domain_name_hash().as_slice());
    buf.extend_from_slice(domain_version_hash().as_slice());
    buf.extend_from_slice(&uint_word(l1_chain_id));
    buf.extend_from_slice(&address_word(inbox_address));
    keccak256(&buf)
}

impl UserAccountCreation {
    /// The signer of a signed creation. `None` for a direct creation, or when
    /// the signature is malformed, non-canonical, or does not recover.
    pub fn signer(&self, source: &DerivationSource) -> Option<Address> {
        recover_signer(self, source, self.receive_key_hash())
    }

    /// The account this creation writes on the network `source`, given its
    /// [`Self::receive_key_hash`]: the carrier's Ethereum sender `l1_sender`
    /// in direct mode, else the signer its signature recovers to under that
    /// network's signing domain. `None` when the signature is malformed,
    /// non-canonical, or does not recover, or in direct mode without a
    /// sender.
    pub(crate) fn account_with_receive_key_hash(
        &self,
        l1_sender: Option<Address>,
        source: &DerivationSource,
        receive_key_hash: CircuitWord,
    ) -> Option<Address> {
        match self.authorization {
            AccountCreationAuthorization::DirectL1 => l1_sender,
            AccountCreationAuthorization::Eip712 { .. } => {
                recover_signer(self, source, receive_key_hash)
            }
        }
    }
}

/// Recover a signed creation's signer, requiring `0 < r < n` and
/// `0 < s <= n/2`.
fn recover_signer(
    creation: &UserAccountCreation,
    source: &DerivationSource,
    receive_key_hash: CircuitWord,
) -> Option<Address> {
    let AccountCreationAuthorization::Eip712 {
        sig_r,
        sig_s,
        y_parity,
    } = &creation.authorization
    else {
        return None;
    };
    // `from_scalars` rejects r==0 / s==0 and any value >= n.
    let sig = Signature::from_scalars(sig_r.0, sig_s.0).ok()?;
    // Reject high-s (malleable) signatures. `normalize_s` returns `Some` only
    // when the input was high-s.
    if sig.normalize_s().is_some() {
        return None;
    }
    let digest = account_signing_hash_with_receive_key_hash(creation, source, receive_key_hash);
    let recid = RecoveryId::new(*y_parity, false);
    let vk = VerifyingKey::recover_from_prehash(digest.as_slice(), &sig, recid).ok()?;
    Some(address_from_verifying_key(&vk))
}

/// The `PcashUserAccountCreation` `hashStruct` on the network
/// `pcash_chain_id`.
fn account_struct_hash(
    creation: &UserAccountCreation,
    pcash_chain_id: u32,
    receive_key_hash: CircuitWord,
) -> CircuitWord {
    let mut buf = Vec::with_capacity(32 * 7);
    buf.extend_from_slice(account_type_hash().as_slice());
    buf.extend_from_slice(&uint_word(u64::from(pcash_chain_id))); // pcashChainId
    buf.extend_from_slice(creation.nullifier_key_commitment.as_slice()); // nullifierKeyCommitment
    buf.extend_from_slice(creation.rule_set_commitment.as_slice()); // ruleSetCommitment
    buf.extend_from_slice(receive_key_hash.as_slice()); // receiveKeyHash
    buf.extend_from_slice(creation.recent_pcash_block_hash.as_slice()); // recentPcashBlockHash
    buf.extend_from_slice(&uint_word(creation.valid_until_timestamp)); // validUntilTimestamp
    keccak256(&buf)
}

/// The EIP-712 signing digest `keccak256(0x1901 || domainSeparator || hashStruct)`
/// for the given account creation on the network `source`: its PCASH chain ID
/// in the message, and its L1 chain ID and inbox in the domain.
pub fn account_signing_hash(
    creation: &UserAccountCreation,
    source: &DerivationSource,
) -> CircuitWord {
    account_signing_hash_with_receive_key_hash(creation, source, creation.receive_key_hash())
}

fn account_signing_hash_with_receive_key_hash(
    creation: &UserAccountCreation,
    source: &DerivationSource,
    receive_key_hash: CircuitWord,
) -> CircuitWord {
    let ds = domain_separator(source.l1_chain_id, source.inbox_address);
    let sh = account_struct_hash(creation, source.pcash_chain_id, receive_key_hash);
    let mut buf = Vec::with_capacity(2 + 32 + 32);
    buf.extend_from_slice(&[0x19, 0x01]);
    buf.extend_from_slice(ds.as_slice());
    buf.extend_from_slice(sh.as_slice());
    keccak256(&buf)
}

/// Ethereum address of a secp256k1 public key: `low160(keccak256(X || Y))`.
fn address_from_verifying_key(vk: &VerifyingKey) -> Address {
    let point = vk.to_encoded_point(false); // 0x04 || X(32) || Y(32)
    let bytes = point.as_bytes();
    let hash = keccak256(&bytes[1..65]);
    pcash_state::address_from_word(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_primary_type_matches_the_network_profile() {
        let profile: serde_json::Value =
            serde_json::from_str(include_str!("../../../../assets/network_profile.json"))
                .unwrap_or_default();
        assert!(!profile.is_null());
        assert_eq!(
            profile["eip712"]["userAccountCreationType"].as_str(),
            Some(USER_ACCOUNT_CREATION_TYPE)
        );
        assert_eq!(
            account_type_hash(),
            keccak256(USER_ACCOUNT_CREATION_TYPE.as_bytes())
        );
    }
}
