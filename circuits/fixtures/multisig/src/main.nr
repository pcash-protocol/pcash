// 2-of-3 secp256k1 account rule for a private contract account's transfers
// and asset creations.
//
// Two of the three configured signers approve the action commitment and the
// account address. The action is the asset-creation action for the created
// asset when the private value carries a creation marker, else the transfer
// action.
// The configuration commits the salt, the threshold and the sorted signer
// addresses derived from the witnessed public keys; the salt hides the signer
// set from readers of the published contract body.

use pcash_protocol::authorization::statement::{
    authorization_commitment, owner_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::ledger::private_value::SmallPrivateValue as PrivateValue;
use pcash_protocol::primitives::hash::pcash_hash;
use reference_rule_common::generated::reference_rule_constants::{
    REFERENCE_CONFIGURATION_DOMAIN, REFERENCE_MULTISIG_APPROVAL_DOMAIN,
};
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

global N: u32 = 3;
global K: u32 = 2;

pub struct Approval {
    pub signer_index: Field,
    pub signature: [u8; 64],
}

pub struct Configuration {
    pub configuration_salt: Field,
}

// configurationCommitment = poseidon(REFERENCE_CONFIGURATION_DOMAIN, salt, K,
//                                    signerAddress_0, ..., signerAddress_(N-1)).
pub fn multisig_configuration_commitment(
    configuration: Configuration,
    signer_addresses: [Field; N],
) -> Field {
    let mut preimage: [Field; N + 3] = [0; N + 3];
    preimage[0] = REFERENCE_CONFIGURATION_DOMAIN;
    preimage[1] = configuration.configuration_salt;
    preimage[2] = K as Field;
    for i in 0..N {
        preimage[i + 3] = signer_addresses[i];
    }
    pcash_hash(preimage)
}

// What each signer approves. The action commitment carries the chain ID.
pub fn multisig_approval_digest(action_commitment: Field, account_address: Field) -> Field {
    pcash_hash(
        [REFERENCE_MULTISIG_APPROVAL_DOMAIN, action_commitment, account_address],
    )
}

fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    private_value: PrivateValue,
    // The asset an asset creation creates; a transfer ignores it.
    created_asset_id: Field,
    account_address: Field,
    signers: [Secp256k1PubKey; N],
    approvals: [Approval; K],
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    let action_commitment =
        owner_action_commitment(pcash_chain_id, private_value, created_asset_id);

    let mut addresses: [Field; N] = [0; N];
    for i in 0..N {
        addresses[i] = signers[i].ethereum_address();
    }
    for i in 0..N {
        for j in 0..N {
            if j < i {
                assert(
                    addresses[j].lt(addresses[i]),
                    "signers must be sorted ascending and distinct",
                );
            }
        }
    }

    let message: [u8; 32] =
        multisig_approval_digest(action_commitment, account_address).to_be_bytes();
    let mut used: [u32; K] = [0; K];
    for a in 0..K {
        let index = signer_index_in_range(approvals[a].signer_index);
        Signature { signature: approvals[a].signature }.verify(message, signers[index]);
        used[a] = index;
    }
    for i in 0..K {
        for j in 0..K {
            if j < i {
                assert(used[j] != used[i], "approval signers must be distinct");
            }
        }
    }
    rule_statement(
        authorization_commitment(
            account_address,
            multisig_configuration_commitment(configuration, addresses),
        ),
        action_commitment,
        recent_pcash_block_hash,
        event_entry,
    )
}

fn signer_index_in_range(signer_index: Field) -> u32 {
    let mut selected: u32 = 0;
    let mut is_valid = false;
    for i in 0..N {
        if signer_index == i as Field {
            selected = i;
            is_valid = true;
        }
    }
    assert(is_valid, "signer index must be below the signer count");
    selected
}

mod tests {
    use super::{Configuration, multisig_approval_digest, multisig_configuration_commitment};
    use pcash_protocol::authorization::statement::transfer_action_commitment;

    // The published reference vector (vectors/reference_rule_vectors.json).
    #[test]
    fn test_configuration_commitment_matches_published_vector() {
        let configuration =
            Configuration { configuration_salt: 0x0102030405060708090a0b0c0d0e0f01 };
        assert(
            multisig_configuration_commitment(configuration, [0x1111, 0x2222, 0x3333])
                == 0x198f3472707b88c0bd4841c0b68db6af8c7b7d1df1bf68929a3adef81ee987dc,
        );
    }

    #[test]
    fn test_approval_digest_binds_the_chain_through_the_action() {
        let digest = multisig_approval_digest(transfer_action_commitment(1, 0x111), 0x222);
        assert(digest != multisig_approval_digest(transfer_action_commitment(2, 0x111), 0x222));
    }
}
