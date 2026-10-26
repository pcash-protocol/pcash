// Fixtures the tests of the reference rules and fixtures share.
//
// TEST_SIGNING_KEY is a fixed secp256k1 key: private key 0x7e57, address
// 0xaba220742442621625bb1160961d2cfcb64c7682. Each signed test signs its
// message offline with this key under TEST_CONFIGURATION, the PCASH domain of
// L1 chain 11155111 and inbox 0x5043534800000000000000000000000000000000.
// Relation tests take the signer address directly and use TEST_SIGNER.

use crate::configuration::{Configuration, configuration_commitment};
use crate::payout::{note_secret, note_secret_seed};
use pcash_protocol::authorization::statement::{
    assert_rule_statement, asset_creation_action_commitment, authorization_commitment,
    rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS};
use pcash_protocol::ledger::note::{
    note_body_commitment, note_nk, nullifier_key_commitment, owner_commitment,
};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, PrivateValue, SLOT_CLASS_DUMMY, SmallPrivateValue,
};
use signature_common::secp256k1::Secp256k1PubKey;

pub global TEST_SIGNING_KEY: Secp256k1PubKey = Secp256k1PubKey {
    x: [
        0x06, 0x30, 0xed, 0x59, 0x20, 0xf4, 0x3e, 0x10, 0x88, 0x0c, 0x68, 0x27, 0x00, 0x92, 0x50,
        0x37, 0x65, 0x0c, 0x87, 0xb2, 0x84, 0x06, 0x2a, 0x21, 0x07, 0xd6, 0x97, 0xdd, 0x62, 0x9e,
        0xe7, 0x0c,
    ],
    y: [
        0x61, 0xee, 0x86, 0x96, 0x72, 0x57, 0xfc, 0x62, 0x49, 0xcb, 0x03, 0xbb, 0x64, 0x26, 0x41,
        0xab, 0xf5, 0xb7, 0xa8, 0x69, 0x95, 0x16, 0x92, 0xad, 0x5e, 0xcc, 0x98, 0x7a, 0x2a, 0xb1,
        0x10, 0x69,
    ],
};

pub global TEST_CONFIGURATION: Configuration = Configuration {
    domain_separator_high: 0xfaf4c1be8b91555f6d023ae6675c7aff,
    domain_separator_low: 0x300bb3b6d97d0305ac50dd198dd16bff,
};

pub global TEST_SIGNER: Field = 0x1111111111111111111111111111111111111111;
pub global TEST_RECIPIENT: Field = 0x2222222222222222222222222222222222222222;
pub global TEST_PCASH_CHAIN_ID: Field = 1346589512;
pub global TEST_RECENT_BLOCK: Field = 0x5eb;
pub global TEST_NK_ROOT: Field = 0x999;
pub global TEST_ASSET_ID: Field = 0x7777;
pub global TEST_NULLIFIERS: [Field; 4] = [0x81, 0x82, 0x83, 0x84];
pub global TEST_ATTACKER: Field = 0xa77ac4e7;
pub global TEST_CHANGE_AMOUNT: Field = 1500;

pub type TestPrivateValue = PrivateValue<4, 5, 0>;

/// A transaction in the S profile a rule's main takes, every slot a dummy. Under
/// the default profile its nullifiers are TEST_NULLIFIERS and its output bodies
/// 0x90 + slot, as in the TestPrivateValue fixtures. A signed test fills slot 0
/// only, since the S profile may have one input and one output.
pub fn small_transaction(
    open_fee_amount: Field,
    valid_until_timestamp: Field,
) -> SmallPrivateValue {
    let mut private_value = SmallPrivateValue {
        open_fee_amount,
        issuance_owner_commitment: 0,
        not_before_timestamp: 0,
        valid_until_timestamp,
        carrier_context_hash: 0,
        asset_burn_amount: 0,
        delivery_commitment: 0,
        account_creation_commitment: 0,
        input_slot_classes: [SLOT_CLASS_DUMMY; S_INPUTS],
        input_commitments: [0; S_INPUTS],
        nullifiers: [0; S_INPUTS],
        output_slot_classes: [SLOT_CLASS_DUMMY; S_OUTPUTS],
        output_body_commitments: [0; S_OUTPUTS],
    };
    for i in 0..S_INPUTS {
        private_value.nullifiers[i] = 0x81 + i as Field;
    }
    for i in 0..S_OUTPUTS {
        private_value.output_body_commitments[i] = 0x90 + i as Field;
    }
    private_value
}

/// A note body TEST_SIGNER owns under `secret`.
pub fn owner_body(secret: Field, asset_id: Field, amount: Field) -> Field {
    note_body_commitment(owner_commitment(TEST_SIGNER, secret), asset_id, amount)
}

/// The secret owner change opens under in `slot` of a transaction that spends
/// TEST_NULLIFIERS: TEST_NK_ROOT's implicit note secret with zero entropy.
pub fn owner_change_secret(slot: Field) -> Field {
    note_secret::<4, 5, 0>(
        note_secret_seed(note_nk(TEST_NK_ROOT)),
        TEST_NULLIFIERS,
        slot,
        0,
    )
}

/// The authorization commitment the kernel expects from TEST_SIGNER's account
/// with the reference rule installed under TEST_CONFIGURATION and TEST_NK_ROOT's
/// nullifier key commitment.
pub fn installed_authorization_commitment() -> Field {
    authorization_commitment(
        TEST_SIGNER,
        configuration_commitment(TEST_CONFIGURATION, nullifier_key_commitment(TEST_NK_ROOT)),
    )
}

fn signer_statement(
    action_commitment: Field,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    rule_statement(
        installed_authorization_commitment(),
        action_commitment,
        TEST_RECENT_BLOCK,
        event_entry,
    )
}

/// The statement the transfer kernel expects from TEST_SIGNER's rule for
/// `private_value` on TEST_PCASH_CHAIN_ID.
pub fn transfer_statement<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    signer_statement(
        transfer_action_commitment(TEST_PCASH_CHAIN_ID, private_value_commitment(private_value)),
        event_entry,
    )
}

/// The transfer kernel's check of a rule's `statement` for `private_value`
/// against TEST_SIGNER's account and its installed reference rule.
pub fn assert_transfer_kernel_accepts<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    statement: [Field; RULE_STATEMENT_LENGTH],
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    event_entry: Field,
) {
    assert_rule_statement(
        statement,
        installed_authorization_commitment(),
        transfer_action_commitment(TEST_PCASH_CHAIN_ID, private_value_commitment(private_value)),
        TEST_RECENT_BLOCK,
        event_entry,
    );
}

/// The statement the asset-creation kernel expects from TEST_SIGNER's rule for
/// `private_value` creating `asset_id` on TEST_PCASH_CHAIN_ID.
pub fn asset_creation_statement<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    asset_id: Field,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    signer_statement(
        asset_creation_action_commitment(
            TEST_PCASH_CHAIN_ID,
            private_value_commitment(private_value),
            asset_id,
        ),
        event_entry,
    )
}
