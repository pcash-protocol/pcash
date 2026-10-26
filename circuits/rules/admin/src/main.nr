// Owner-only administration rule of the reference user account.
//
// The signer approves the exact account transition together with the fee that
// funds it: the open fee, the optional private relay note, the transaction
// context, and the validity window. The kernel enforces that the account's
// notes leave only as the fee, that relay note, and change to the payer; this
// rule binds what the signer saw to the funded update it approves and requires
// any other native output to be the one owner-change note under the owner's
// derived secret. An update earns no issuance, so the message names no issuance
// destination and the node supplies the zero issuance word.

use pcash_protocol::authorization::account::{
    ACCOUNT_KIND_USER, account_state_commitment, account_update_commitment,
};
use pcash_protocol::authorization::statement::{
    account_update_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
use pcash_protocol::ledger::private_value::{private_value_commitment, PrivateValue};
use reference_rule_common::configuration::Configuration;
use reference_rule_common::generated::network_profile::USER_ACCOUNT_UPDATE_TYPE_HASH;
use reference_rule_common::owner::open_owner;
use reference_rule_common::payout::transaction_context;
use reference_rule_common::value_rule::assert_native_fee_outputs;
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

/// Returns the rule statement and the nullifier key commitment derived from
/// `nk_root`, which the signer approves.
pub fn admin_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signer_address: Field,
    nk_root: Field,
    current_account_revision: Field,
    current_rule_set_commitment: Field,
    current_receive_key_hash: Field,
    new_rule_set_commitment: Field,
    new_receive_key_hash: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    native_change_amount: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    event_entry: Field,
) -> ([Field; RULE_STATEMENT_LENGTH], Field) {
    // Owner-only: the signer is the account itself, never a configured
    // delegate. The account address therefore derives from the signing key,
    // so no other key can administer this account. Anyone wanting delegated
    // administration installs their own rule.
    let owner = open_owner(signer_address, nk_root, configuration);
    let new_account_revision = current_account_revision + 1;

    let current_account_state_commitment = account_state_commitment(
        signer_address,
        owner.nullifier_key_commitment,
        current_rule_set_commitment,
        ACCOUNT_KIND_USER,
        current_account_revision,
        current_receive_key_hash,
    );
    let new_account_state_commitment = account_state_commitment(
        signer_address,
        owner.nullifier_key_commitment,
        new_rule_set_commitment,
        ACCOUNT_KIND_USER,
        new_account_revision,
        new_receive_key_hash,
    );

    assert_native_fee_outputs(
        private_value,
        signer_address,
        nk_root,
        relay_fee_amount,
        relay_fee_owner_commitment,
        native_change_amount,
    );
    let statement = rule_statement(
        owner.authorization_commitment,
        account_update_action_commitment(
            pcash_chain_id,
            private_value_commitment(private_value),
            account_update_commitment(
                current_account_state_commitment,
                new_account_state_commitment,
            ),
        ),
        recent_pcash_block_hash,
        event_entry,
    );
    (statement, owner.nullifier_key_commitment)
}

fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signature: Signature,
    pubkey: Secp256k1PubKey,
    nk_root: Field,
    // Signed message fields.
    current_account_revision: Field,
    current_rule_set_commitment: Field,
    current_receive_key_hash: Field,
    new_rule_set_commitment: Field,
    new_receive_key_hash: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    // Private openings.
    native_change_amount: Field,
    private_value: PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>,
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    let signer_address = pubkey.ethereum_address();
    let (statement, nullifier_key_commitment) = admin_relation(
        pcash_chain_id,
        recent_pcash_block_hash,
        configuration,
        signer_address,
        nk_root,
        current_account_revision,
        current_rule_set_commitment,
        current_receive_key_hash,
        new_rule_set_commitment,
        new_receive_key_hash,
        relay_fee_amount,
        relay_fee_owner_commitment,
        native_change_amount,
        private_value,
        event_entry,
    );
    // The PcashUserAccountUpdate message of assets/network_profile.json.
    signature.verify(
        configuration.signing_hash(
            USER_ACCOUNT_UPDATE_TYPE_HASH,
            [
                pcash_chain_id,
                signer_address,
                current_account_revision,
                nullifier_key_commitment,
                current_rule_set_commitment,
                current_receive_key_hash,
                new_rule_set_commitment,
                new_receive_key_hash,
                private_value.open_fee_amount,
                relay_fee_amount,
                relay_fee_owner_commitment,
                transaction_context::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(
                    pcash_chain_id,
                    private_value.nullifiers,
                ),
                private_value.not_before_timestamp,
                private_value.valid_until_timestamp,
            ],
        ),
        pubkey,
    );
    statement
}

mod tests {
    use super::{admin_relation, main};
    use pcash_protocol::authorization::account::{
        ACCOUNT_KIND_USER, account_state_commitment, account_update_commitment,
    };
    use pcash_protocol::authorization::statement::{
        account_update_action_commitment, authorization_commitment, rule_statement,
        RULE_STATEMENT_LENGTH,
    };
    use pcash_protocol::ledger::note::{
        note_body_commitment, nullifier_key_commitment, owner_commitment,
    };
    use pcash_protocol::ledger::private_value::{
        private_value_commitment, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
    };
    use reference_rule_common::configuration::configuration_commitment;
    use reference_rule_common::generated::network_profile::USER_ACCOUNT_UPDATE_TYPE_HASH;
    use reference_rule_common::test_support::{
        small_transaction, TEST_ATTACKER, TEST_CHANGE_AMOUNT, TEST_CONFIGURATION, TEST_NK_ROOT,
        TEST_NULLIFIERS, TEST_PCASH_CHAIN_ID, TEST_RECENT_BLOCK, TEST_SIGNER, TEST_SIGNING_KEY,
        TestPrivateValue,
    };
    use reference_rule_common::value_rule::owner_change_note_secret;
    use signature_common::secp256k1::Signature;

    // Another key's address: only ever used to show it cannot administer
    // TEST_SIGNER's account.
    global TEST_DELEGATE: Field = 0x2222222222222222222222222222222222222222;
    global TEST_VALID_UNTIL: Field = 12;

    fn owner_change_body(private_value: TestPrivateValue, slot: u32, amount: Field) -> Field {
        note_body_commitment(
            owner_commitment(
                TEST_SIGNER,
                owner_change_note_secret(TEST_NK_ROOT, private_value, slot),
            ),
            0,
            amount,
        )
    }

    fn fixture() -> TestPrivateValue {
        let mut private_value = TestPrivateValue {
            open_fee_amount: 500,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: TEST_VALID_UNTIL,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0x61,
            account_creation_commitment: 0,
            input_slot_classes: [
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            input_commitments: [0x71, 0, 0, 0],
            nullifiers: TEST_NULLIFIERS,
            output_slot_classes: [
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [0, 0x91, 0x92, 0x93, 0x94],
        };
        private_value.output_body_commitments[0] =
            owner_change_body(private_value, 0, TEST_CHANGE_AMOUNT);
        private_value
    }

    // The statement the account-update kernel expects for revision 7 -> 8 of
    // TEST_SIGNER's account, funded by `private_value`.
    fn kernel_statement(
        private_value: TestPrivateValue,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let nk_commitment = nullifier_key_commitment(TEST_NK_ROOT);
        let current_account =
            account_state_commitment(TEST_SIGNER, nk_commitment, 6, ACCOUNT_KIND_USER, 7, 8);
        let new_account =
            account_state_commitment(TEST_SIGNER, nk_commitment, 10, ACCOUNT_KIND_USER, 8, 0);
        rule_statement(
            authorization_commitment(
                TEST_SIGNER,
                configuration_commitment(TEST_CONFIGURATION, nk_commitment),
            ),
            account_update_action_commitment(
                TEST_PCASH_CHAIN_ID,
                private_value_commitment(private_value),
                account_update_commitment(current_account, new_account),
            ),
            TEST_RECENT_BLOCK,
            event_entry,
        )
    }

    // `signer` approves the update kernel_statement describes: revision 7 -> 8,
    // rule set 6 -> 10, receive key 8 -> 0.
    fn run_relation(
        signer: Field,
        private_value: TestPrivateValue,
        native_change_amount: Field,
        relay_fee_amount: Field,
        relay_fee_owner_commitment: Field,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let (statement, _) = admin_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            signer,
            TEST_NK_ROOT,
            7,
            6,
            8,
            10,
            0,
            relay_fee_amount,
            relay_fee_owner_commitment,
            native_change_amount,
            private_value,
            event_entry,
        );
        statement
    }

    #[test]
    fn test_admin_relation_accepts_exact_update() {
        let tx = fixture();
        assert(
            run_relation(TEST_SIGNER, tx, TEST_CHANGE_AMOUNT, 0, 0, 0) == kernel_statement(tx, 0),
        );
    }

    // Change returns to the owner only under the secret the owner derives.
    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_admin_relation_rejects_change_under_a_free_secret() {
        let mut changed = fixture();
        changed.output_body_commitments[0] =
            note_body_commitment(owner_commitment(TEST_SIGNER, 0x777), 0, TEST_CHANGE_AMOUNT);
        let _ = run_relation(TEST_SIGNER, changed, TEST_CHANGE_AMOUNT, 0, 0, 0);
    }

    #[test]
    fn test_admin_relation_accepts_a_private_relay_and_change() {
        let relay_owner = owner_commitment(TEST_DELEGATE, 0x5e1f);
        let mut tx = fixture();
        tx.open_fee_amount = 0;
        tx.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[1] = note_body_commitment(relay_owner, 0, 500);
        assert(
            run_relation(TEST_SIGNER, tx, TEST_CHANGE_AMOUNT, 500, relay_owner, 0)
                == kernel_statement(tx, 0),
        );
    }

    // Without a signed relay, the kernel's relay slot cannot carry a second
    // change note: the change is one note the owner can recompute.
    #[test(should_fail_with = "native change must be exactly one owner change output")]
    fn test_admin_relation_rejects_change_split_across_two_notes() {
        let half = TEST_CHANGE_AMOUNT / 2;
        let mut tx = fixture();
        tx.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[0] = owner_change_body(tx, 0, half);
        tx.output_body_commitments[1] = owner_change_body(tx, 1, half);
        let _ = run_relation(TEST_SIGNER, tx, half, 0, 0, 0);
    }

    #[test(should_fail_with = "relay fee must pay exactly one relay output")]
    fn test_admin_relation_rejects_a_repeated_relay_output() {
        let relay_owner = owner_commitment(TEST_DELEGATE, 0x5e1f);
        let mut tx = fixture();
        tx.open_fee_amount = 0;
        tx.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        tx.output_slot_classes[2] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[1] = note_body_commitment(relay_owner, 0, 500);
        tx.output_body_commitments[2] = note_body_commitment(relay_owner, 0, 500);
        let _ = run_relation(TEST_SIGNER, tx, TEST_CHANGE_AMOUNT, 500, relay_owner, 0);
    }

    // The account is administered by its own key and nothing else: another key
    // opens its own account, so its approval names a different update and account.
    #[test]
    fn test_admin_relation_binds_the_signer_account() {
        let mut tx = fixture();
        tx.output_slot_classes[0] = SLOT_CLASS_DUMMY;
        let statement = run_relation(TEST_DELEGATE, tx, 0, 0, 0, 0);
        let expected = kernel_statement(tx, 0);
        assert(statement[0] != expected[0]);
        assert(statement[1] != expected[1]);
    }

    // Signed relay 0 and open fee 500; the remainder is a native output to an
    // attacker presented as change.
    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_admin_relation_rejects_zero_relay_change_to_an_attacker() {
        let attacker_owner = owner_commitment(TEST_ATTACKER, 0xbad);
        let mut tx = fixture();
        tx.output_body_commitments[0] = note_body_commitment(attacker_owner, 0, TEST_CHANGE_AMOUNT);
        let _ = run_relation(TEST_SIGNER, tx, TEST_CHANGE_AMOUNT, 0, 0, 0);
    }

    // Signed relay of 1 opens to the account itself; the large remainder is a
    // native output to an attacker presented as change.
    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_admin_relation_rejects_swapped_relay_and_change_roles() {
        let self_owner = owner_commitment(TEST_SIGNER, 0x5e1f);
        let attacker_owner = owner_commitment(TEST_ATTACKER, 0xbad);
        let mut tx = fixture();
        tx.open_fee_amount = 0;
        tx.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[0] = note_body_commitment(self_owner, 0, 1);
        tx.output_body_commitments[1] = note_body_commitment(attacker_owner, 0, 1_000_000);
        let _ = run_relation(TEST_SIGNER, tx, 1_000_000, 1, self_owner, 0);
    }

    // --- Signed updates. ---

    // TEST_SIGNING_KEY's signature over the update `run_signed_update` proves on
    // TEST_PCASH_CHAIN_ID.
    global SIGNED_UPDATE_SIGNATURE: [u8; 64] = [
        0x98, 0x07, 0xa3, 0x11, 0x8b, 0xb7, 0xa5, 0xa0, 0x0f, 0x19, 0xd9, 0x0e, 0x70, 0x9b, 0x42,
        0x15, 0x82, 0x4f, 0x25, 0xac, 0xfa, 0x5f, 0x77, 0x49, 0xb8, 0x5f, 0x31, 0xa8, 0xf5, 0x21,
        0xb0, 0x37, 0x74, 0x10, 0x35, 0xde, 0xf0, 0x88, 0x14, 0xc8, 0x0a, 0xa4, 0xf9, 0x6c, 0x3e,
        0xab, 0x4e, 0x33, 0x73, 0xef, 0xab, 0x50, 0x0e, 0x65, 0xde, 0x2e, 0xac, 0x44, 0x87, 0xe5,
        0x46, 0x66, 0x47, 0x3f,
    ];

    fn run_signed_update(
        pcash_chain_id: Field,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let mut tx = small_transaction(500, TEST_VALID_UNTIL);
        tx.input_slot_classes[0] = SLOT_CLASS_NATIVE;
        tx.input_commitments[0] = 0x71;
        main(
            pcash_chain_id,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature: SIGNED_UPDATE_SIGNATURE },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            7,
            6,
            8,
            10,
            0,
            0,
            0,
            0,
            tx,
            event_entry,
        )
    }

    #[test]
    fn test_admin_accepts_the_owner_signature() {
        let _ = run_signed_update(TEST_PCASH_CHAIN_ID, 0);
    }

    // The message signs the chain ID the action commitment binds, so an update
    // signed for one chain cannot be proved on another.
    #[test(should_fail_with = "signature must be valid")]
    fn test_admin_rejects_a_signature_for_another_chain() {
        let _ = run_signed_update(TEST_PCASH_CHAIN_ID + 1, 0);
    }

    #[test]
    fn test_account_update_signing_hash_matches_viem() {
        // Frozen viem EIP-712 digests for L1 chain 11155111 and inbox
        // 0x5043...0000. The receive-key hashes are bytes32 of their field values;
        // the current one is uint256(0xff...ff) mod p.
        let expected = [
            [
                0x7f, 0x29, 0xec, 0xf5, 0x32, 0x77, 0xc8, 0xcf, 0x5e, 0x8a, 0x20, 0x1c, 0xd3, 0x3c,
                0x30, 0xa0, 0x91, 0x55, 0x46, 0x8e, 0xfc, 0x33, 0x21, 0xc8, 0xd0, 0xca, 0xaa, 0x8c,
                0x4d, 0x7a, 0xa7, 0x97,
            ],
            [
                0xe2, 0xdc, 0x46, 0x01, 0xa8, 0xa1, 0x90, 0x21, 0xfa, 0xe8, 0xed, 0xc8, 0x37, 0x18,
                0x04, 0x19, 0x5b, 0x8f, 0x18, 0x78, 0xef, 0xdd, 0x5a, 0x05, 0x26, 0x54, 0x14, 0x52,
                0x31, 0x1d, 0xb2, 0x4b,
            ],
        ];
        for i in 0..2 {
            let digest = TEST_CONFIGURATION.signing_hash(
                USER_ACCOUNT_UPDATE_TYPE_HASH,
                [
                    0x50435348,
                    0x1234 + i as Field,
                    1,
                    2,
                    3,
                    0x0e0a77c19a07df2f666ea36f7879462e36fc76959f60cd29ac96341c4ffffffa,
                    5,
                    0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef,
                    8,
                    9,
                    19,
                    20,
                    21,
                    22,
                ],
            );
            assert(digest == expected[i]);
        }
    }
}
