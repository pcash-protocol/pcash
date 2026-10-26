// The rule statement: what an account's selected rule returns to the kernel,
// [authorizationCommitment, actionCommitment, recentPcashBlockHash, eventEntry].
//
// The kernel computes the same four values from the account and rule entry it
// authenticated, the private value it built, and the role it proves, and
// requires the rule's return to equal them. Every action commitment is one
// formula over (actionDomain, pcashChainId, privateValueCommitment, extraData);
// each role has its own constructor, so an action domain is never a free input.
// Each distinct approval has its own domain. Two kernels share one only when
// the approval means the same thing to the signer and the rule's checks do not
// depend on which kernel runs.

use crate::generated::pcash_constants::{
    ACCOUNT_UPDATE_ACTION_DOMAIN, ASSET_CREATION_ACTION_DOMAIN, AUTHORIZATION_COMMITMENT_DOMAIN,
    CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN, SPONSORED_TRANSFER_ACTION_DOMAIN,
    TRANSFER_ACTION_DOMAIN,
};
use crate::ledger::private_value::{
    private_value_commitment, PrivateValue, SLOT_CLASS_ASSET_CREATION,
};
use crate::primitives::hash::pcash_hash;

pub global RULE_STATEMENT_LENGTH: u32 = 4;

// Which account acts, named by its address, under which settings of the
// selected rule.
pub fn authorization_commitment(address: Field, configuration_commitment: Field) -> Field {
    pcash_hash(
        [AUTHORIZATION_COMMITMENT_DOMAIN, address, configuration_commitment],
    )
}

fn action_commitment(
    action_domain: Field,
    pcash_chain_id: Field,
    private_value_commitment: Field,
    extra_data: Field,
) -> Field {
    pcash_hash(
        [action_domain, pcash_chain_id, private_value_commitment, extra_data],
    )
}

// One account moves its own value: the transfer kernel.
pub fn transfer_action_commitment(pcash_chain_id: Field, private_value_commitment: Field) -> Field {
    action_commitment(
        TRANSFER_ACTION_DOMAIN,
        pcash_chain_id,
        private_value_commitment,
        0,
    )
}

// One account creates an asset and its supply: the asset-creation kernel. The
// extra data is the ID of the asset the kernel derives.
pub fn asset_creation_action_commitment(
    pcash_chain_id: Field,
    private_value_commitment: Field,
    asset_id: Field,
) -> Field {
    action_commitment(
        ASSET_CREATION_ACTION_DOMAIN,
        pcash_chain_id,
        private_value_commitment,
        asset_id,
    )
}

// A rule that opens the private value and serves both one-account kernels
// chooses between their actions by its slot classes: the asset-creation action
// for `created_asset_id` when an input is a creation marker, else the transfer
// action, which ignores `created_asset_id`.
pub fn owner_action_commitment<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    created_asset_id: Field,
) -> Field {
    let commitment = private_value_commitment(private_value);
    let mut creates_asset = false;
    for i in 0..N_IN {
        creates_asset |= private_value.input_slot_classes[i] == SLOT_CLASS_ASSET_CREATION;
    }
    if creates_asset {
        asset_creation_action_commitment(pcash_chain_id, commitment, created_asset_id)
    } else {
        transfer_action_commitment(pcash_chain_id, commitment)
    }
}

// The contract side of a sponsored transfer: the contract moves the asset and
// another account pays the native fee.
pub fn sponsored_transfer_action_commitment(
    pcash_chain_id: Field,
    private_value_commitment: Field,
) -> Field {
    action_commitment(
        SPONSORED_TRANSFER_ACTION_DOMAIN,
        pcash_chain_id,
        private_value_commitment,
        0,
    )
}

// A user account pays the native fee for one named contract: its asset action
// in a sponsored transfer, or its creation.
pub fn contract_fee_sponsorship_action_commitment(
    pcash_chain_id: Field,
    private_value_commitment: Field,
    contract_address: Field,
) -> Field {
    action_commitment(
        CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN,
        pcash_chain_id,
        private_value_commitment,
        contract_address,
    )
}

// A user-account update together with the fee payment that funds it.
pub fn account_update_action_commitment(
    pcash_chain_id: Field,
    private_value_commitment: Field,
    account_update_commitment: Field,
) -> Field {
    action_commitment(
        ACCOUNT_UPDATE_ACTION_DOMAIN,
        pcash_chain_id,
        private_value_commitment,
        account_update_commitment,
    )
}

// A contract function that serves both the transfer and the sponsored-transfer
// role chooses between them with `fee_paid`.
pub fn contract_action_commitment(
    pcash_chain_id: Field,
    private_value_commitment: Field,
    fee_paid: bool,
) -> Field {
    if fee_paid {
        sponsored_transfer_action_commitment(pcash_chain_id, private_value_commitment)
    } else {
        transfer_action_commitment(pcash_chain_id, private_value_commitment)
    }
}

pub fn rule_statement(
    authorization_commitment: Field,
    action_commitment: Field,
    recent_pcash_block_hash: Field,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    [authorization_commitment, action_commitment, recent_pcash_block_hash, event_entry]
}

// The kernel's check of a rule's return against the four fields it computes.
pub fn assert_rule_statement(
    statement: [Field; RULE_STATEMENT_LENGTH],
    authorization_commitment: Field,
    action_commitment: Field,
    recent_pcash_block_hash: Field,
    event_entry: Field,
) {
    assert(
        statement
            == rule_statement(
                authorization_commitment,
                action_commitment,
                recent_pcash_block_hash,
                event_entry,
            ),
        "rule statement must match the kernel's statement",
    );
}

mod tests {
    use crate::generated::pcash_constants::{
        ASSET_CREATION_ACTION_DOMAIN, AUTHORIZATION_COMMITMENT_DOMAIN, TRANSFER_ACTION_DOMAIN,
    };
    use crate::ledger::private_value::{
        private_value_commitment, PrivateValue, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
        SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
    };
    use crate::primitives::hash::pcash_hash;
    use super::{
        account_update_action_commitment, asset_creation_action_commitment,
        authorization_commitment, contract_action_commitment,
        contract_fee_sponsorship_action_commitment, owner_action_commitment,
        sponsored_transfer_action_commitment, transfer_action_commitment,
    };

    #[test]
    fn test_action_commitments_separate_roles_and_chains() {
        let transfer = transfer_action_commitment(1, 0x10);
        assert(transfer == pcash_hash([TRANSFER_ACTION_DOMAIN, 1, 0x10, 0]));
        assert(transfer != transfer_action_commitment(2, 0x10));
        let asset_creation = asset_creation_action_commitment(1, 0x10, 0x50);
        assert(asset_creation == pcash_hash([ASSET_CREATION_ACTION_DOMAIN, 1, 0x10, 0x50]));
        assert(transfer != asset_creation_action_commitment(1, 0x10, 0));
        assert(asset_creation != asset_creation_action_commitment(2, 0x10, 0x50));
        assert(asset_creation != asset_creation_action_commitment(1, 0x10, 0x51));
        assert(transfer != sponsored_transfer_action_commitment(1, 0x10));
        assert(transfer != contract_fee_sponsorship_action_commitment(1, 0x10, 0));
        assert(transfer != account_update_action_commitment(1, 0x10, 0));
        assert(contract_action_commitment(1, 0x10, false) == transfer);
        assert(
            contract_action_commitment(1, 0x10, true)
                == sponsored_transfer_action_commitment(1, 0x10),
        );
        assert(
            contract_fee_sponsorship_action_commitment(1, 0x10, 0x20)
                != contract_fee_sponsorship_action_commitment(1, 0x10, 0x21),
        );
    }

    fn private_value(input_slot_classes: [Field; 2]) -> PrivateValue<2, 1, 0> {
        let mut input_commitments = [0; 2];
        for i in 0..2 {
            if (input_slot_classes[i] == SLOT_CLASS_NATIVE)
                | (input_slot_classes[i] == SLOT_CLASS_ASSET) {
                input_commitments[i] = 0x30 + i as Field;
            }
        }
        PrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 1000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
            input_slot_classes,
            input_commitments,
            nullifiers: [0x21, 0x22],
            output_slot_classes: [SLOT_CLASS_ASSET],
            output_body_commitments: [0x40],
        }
    }

    // A creation marker selects the asset-creation action for the created
    // asset; every other input class leaves the transfer action.
    #[test]
    fn test_owner_action_selects_the_asset_creation_action_by_creation_marker() {
        let creation = private_value([SLOT_CLASS_NATIVE, SLOT_CLASS_ASSET_CREATION]);
        assert(
            owner_action_commitment(1, creation, 0x50)
                == asset_creation_action_commitment(1, private_value_commitment(creation), 0x50),
        );
        let other_classes =
            [SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE, SLOT_CLASS_ASSET, SLOT_CLASS_APPLICATION];
        for class in other_classes {
            let transfer = private_value([SLOT_CLASS_NATIVE, class]);
            assert(
                owner_action_commitment(1, transfer, 0x50)
                    == transfer_action_commitment(1, private_value_commitment(transfer)),
            );
        }
    }

    #[test]
    fn test_authorization_commitment_binds_address_and_configuration() {
        let commitment = authorization_commitment(0x1, 0x2);
        assert(commitment == pcash_hash([AUTHORIZATION_COMMITMENT_DOMAIN, 0x1, 0x2]));
        assert(commitment != authorization_commitment(0x2, 0x1));
    }
}
