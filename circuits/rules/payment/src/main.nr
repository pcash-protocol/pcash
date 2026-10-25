// Readable payment rule of the reference user account.
//
// The signer approves the payment, fee, transaction context, and validity
// window. The circuit privately opens the complete transaction: slot 0 pays
// `recipient` (padding when the amount is zero), slot 1 returns native change
// to the signing account under the owner's implicit note secret, the last slot
// may pay a private relayer, and the slots between are padding. Recipients and
// owners are Ethereum addresses.
//
// Positional slot roles are normative for this native payment rule. Asset
// actions use their own semantic rules.

use pcash_protocol::authorization::statement::{
    rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, PrivateValue, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
};
use pcash_protocol::primitives::range::assert_address;
use reference_rule_common::configuration::Configuration;
use reference_rule_common::message::verify_value_message;
use reference_rule_common::owner::open_owner;
use reference_rule_common::value_rule::{assert_relay_terms, assert_value_output, OutputDeclaration};
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

// keccak256 of the SDK PAYMENT_EIP712_TYPE, written by scripts/circuits/gen_reference_message_types.mjs.
global PAYMENT_TYPE_HASH: [u8; 32] = [
    0xcd, 0xf6, 0x90, 0x16, 0x64, 0x20, 0xe8, 0x24, 0xe2, 0x91, 0xe1, 0xd4, 0x2c, 0xc1, 0x04, 0xd9,
    0x0e, 0x74, 0x2b, 0xbe, 0x57, 0x7f, 0xff, 0x1e, 0xd8, 0xc1, 0xb6, 0x5e, 0x23, 0xe4, 0x14, 0x97,
];

// The signature-free relation core, shared by `main` and the negative tests:
// every constraint tying the signed message fields to the opened transaction
// except the transaction context and the issuance route, which `main` derives
// and opens through `verify_value_message`.
pub fn payment_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signer_address: Field,
    nk_root: Field,
    recipient: Field,
    amount: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    native_change_amount: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    recipient_note_secret: Field,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    // This rule is owner-only: the signer is the authenticated owner, and every
    // private change output returns to that owner.
    let owner = open_owner(signer_address, nk_root, configuration);

    // With no asset input, the kernel's asset conservation forces a zero burn.
    for i in 0..N_IN {
        let is_dummy = private_value.input_slot_classes[i] == SLOT_CLASS_DUMMY;
        let is_native = private_value.input_slot_classes[i] == SLOT_CLASS_NATIVE;
        assert(is_dummy | is_native, "payment input must be native or dummy");
    }

    // Slot 0: the payment. The recipient is a real Ethereum address and is
    // signed at every amount. A positive amount is a plain native note to it.
    // A zero amount creates no note: slot 0 is padding, which the kernel
    // builds as an empty note of address zero.
    assert_address(recipient);
    assert(recipient != 0, "payment recipient must be nonzero");
    if N_OUT < 2 {
        assert(
            native_change_amount == 0,
            "native change amount must be zero without a change slot",
        );
    }
    // The relay note takes the last slot, as in every value rule.
    let relay_slot = N_OUT - 1;
    if N_OUT < 3 {
        assert(relay_fee_amount == 0, "relay fee amount must be zero without a relay slot");
    }
    assert_relay_terms(private_value, relay_fee_amount, relay_fee_owner_commitment);
    for i in 0..N_OUT {
        let mut declaration = OutputDeclaration { recipient: 0, amount: 0, asset_id: 0 };
        let mut secret = 0;
        let mut change = 0;
        if i == 0 {
            if amount == 0 {
                assert(
                    private_value.output_slot_classes[i] == SLOT_CLASS_DUMMY,
                    "zero payment slot must be a dummy",
                );
            } else {
                declaration = OutputDeclaration { recipient, amount, asset_id: 0 };
                secret = recipient_note_secret;
            }
        } else if i == 1 {
            // Native change always fits one note, so it has one slot.
            change = native_change_amount;
            if change == 0 {
                assert(
                    private_value.output_slot_classes[i] == SLOT_CLASS_DUMMY,
                    "zero change must be a dummy",
                );
            }
        } else if i == relay_slot {
            if relay_fee_amount == 0 {
                assert(
                    private_value.output_slot_classes[i] == SLOT_CLASS_DUMMY,
                    "absent relay output must be a dummy",
                );
            }
        } else {
            assert(
                private_value.output_slot_classes[i] == SLOT_CLASS_DUMMY,
                "padding slot must be a dummy",
            );
        }
        assert_value_output(
            private_value,
            i,
            signer_address,
            nk_root,
            0,
            declaration,
            relay_fee_amount,
            relay_fee_owner_commitment,
            secret,
            change,
        );
    }
    rule_statement(
        owner.authorization_commitment,
        transfer_action_commitment(pcash_chain_id, private_value_commitment(private_value)),
        recent_pcash_block_hash,
        event_entry,
    )
}

fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signature: Signature,
    pubkey: Secp256k1PubKey,
    nk_root: Field,
    // Signed message fields.
    recipient: Field,
    amount: Field,
    issuance_recipient: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    // Private openings.
    native_change_amount: Field,
    private_value: PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>,
    issuance_note_secret: Field,
    recipient_note_secret: Field,
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    let signer_address = pubkey.ethereum_address();
    let statement = payment_relation(
        pcash_chain_id,
        recent_pcash_block_hash,
        configuration,
        signer_address,
        nk_root,
        recipient,
        amount,
        relay_fee_amount,
        relay_fee_owner_commitment,
        native_change_amount,
        private_value,
        recipient_note_secret,
        event_entry,
    );

    // The signature covers exactly the fields the wallet displayed.
    verify_value_message(
        signature,
        pubkey,
        signer_address,
        configuration,
        PAYMENT_TYPE_HASH,
        pcash_chain_id,
        nk_root,
        [recipient, amount],
        [],
        private_value,
        issuance_recipient,
        issuance_note_secret,
        relay_fee_amount,
        relay_fee_owner_commitment,
    );
    statement
}

mod tests {
    use super::{main, payment_relation};
    use pcash_protocol::authorization::statement::RULE_STATEMENT_LENGTH;
    use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
    use pcash_protocol::ledger::note::{note_body_commitment, owner_commitment};
    use pcash_protocol::ledger::private_value::{
        PrivateValue, SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE,
    };
    use reference_rule_common::test_support::{
        owner_body, owner_change_secret, TEST_CONFIGURATION, TEST_NK_ROOT, TEST_NULLIFIERS,
        TEST_PCASH_CHAIN_ID, TEST_RECENT_BLOCK, TEST_RECIPIENT, TEST_SIGNER, TEST_SIGNING_KEY,
        TestPrivateValue, transfer_statement,
    };
    use signature_common::secp256k1::Signature;

    fn payment_transaction(slot1_class: Field, slot3_class: Field) -> (TestPrivateValue, Field) {
        let recipient_secret = 0x5001;
        let body0 =
            note_body_commitment(owner_commitment(TEST_RECIPIENT, recipient_secret), 0, 1000);
        let tx = TestPrivateValue {
            open_fee_amount: 5,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0x61,
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
                slot1_class,
                SLOT_CLASS_DUMMY,
                slot3_class,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [body0, 0x91, 0x92, 0x93, 0x94],
        };
        (tx, recipient_secret)
    }

    // The relation harness: the owner pays `amount` to TEST_RECIPIENT.
    fn run_payment<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
        tx: PrivateValue<N_IN, N_OUT, SHAPE>,
        amount: Field,
        recipient_secret: Field,
        native_change_amount: Field,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        payment_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            TEST_SIGNER,
            TEST_NK_ROOT,
            TEST_RECIPIENT,
            amount,
            0,
            0,
            native_change_amount,
            tx,
            recipient_secret,
            event_entry,
        )
    }

    // payment_transaction's payment at any dimensions. The signed tests prove it at
    // the S profile; the relation tests run it at alternate dimensions.
    fn profile_transaction<let N_IN: u32, let N_OUT: u32>() -> (PrivateValue<N_IN, N_OUT, S_SHAPE_ID>, Field) {
        let (base, secret) = payment_transaction(SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY);
        let mut tx = PrivateValue {
            open_fee_amount: base.open_fee_amount,
            issuance_owner_commitment: base.issuance_owner_commitment,
            not_before_timestamp: base.not_before_timestamp,
            valid_until_timestamp: base.valid_until_timestamp,
            carrier_context_hash: base.carrier_context_hash,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            input_slot_classes: [SLOT_CLASS_DUMMY; N_IN],
            input_commitments: [0; N_IN],
            nullifiers: [0; N_IN],
            output_slot_classes: [SLOT_CLASS_DUMMY; N_OUT],
            output_body_commitments: [0; N_OUT],
        };
        tx.input_slot_classes[0] = SLOT_CLASS_NATIVE;
        tx.input_commitments[0] = base.input_commitments[0];
        for i in 0..N_IN {
            tx.nullifiers[i] = 0x81 + i as Field;
        }
        for i in 0..N_OUT {
            tx.output_body_commitments[i] = 0x91 + i as Field;
        }
        tx.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[0] = base.output_body_commitments[0];
        (tx, secret)
    }

    // Every input and output slot is padding and the fee is zero: the signer pays
    // nothing to the signed recipient.
    fn zero_payment_transaction() -> TestPrivateValue {
        TestPrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            input_slot_classes: [SLOT_CLASS_DUMMY; 4],
            input_commitments: [0; 4],
            nullifiers: TEST_NULLIFIERS,
            output_slot_classes: [SLOT_CLASS_DUMMY; 5],
            output_body_commitments: [0x90, 0x91, 0x92, 0x93, 0x94],
        }
    }

    #[test]
    fn test_payment_relation_supports_one_input_and_output() {
        let (tx, secret) = profile_transaction::<1, 1>();
        assert(run_payment(tx, 1000, secret, 0, 0) == transfer_statement(tx, 0));
    }

    #[test]
    fn test_payment_relation_supports_larger_profiles() {
        let (tx, secret) = profile_transaction::<6, 7>();
        assert(run_payment(tx, 1000, secret, 0, 0) == transfer_statement(tx, 0));
    }

    #[test(should_fail_with = "padding slot must be a dummy")]
    fn test_payment_relation_rejects_a_payment_in_an_extra_profile_slot() {
        let (mut tx, secret) = profile_transaction::<6, 7>();
        tx.output_slot_classes[4] = SLOT_CLASS_NATIVE;
        let _ = run_payment(tx, 1000, secret, 0, 0);
    }

    // The relay note takes the last slot at any dimensions.
    #[test]
    fn test_payment_relation_pays_the_relay_from_the_last_slot() {
        let (mut tx, secret) = profile_transaction::<6, 7>();
        tx.open_fee_amount = 0;
        tx.output_slot_classes[6] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[6] = note_body_commitment(0x200, 0, 25);
        let statement = payment_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            TEST_SIGNER,
            TEST_NK_ROOT,
            TEST_RECIPIENT,
            1000,
            25,
            0x200,
            0,
            tx,
            secret,
            0,
        );
        assert(statement == transfer_statement(tx, 0));
    }

    #[test(should_fail_with = "payment input must be native or dummy")]
    fn test_payment_relation_rejects_an_asset_in_an_extra_profile_slot() {
        let (mut tx, secret) = profile_transaction::<6, 7>();
        tx.input_slot_classes[5] = SLOT_CLASS_ASSET;
        tx.input_commitments[5] = 0x72;
        let _ = run_payment(tx, 1000, secret, 0, 0);
    }

    #[test]
    fn test_payment_relation_accepts_the_displayed_payment() {
        let (tx, secret) = payment_transaction(SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY);
        assert(run_payment(tx, 1000, secret, 0, 0) == transfer_statement(tx, 0));
    }

    // Change is private, but every real change output still needs its owner opening.
    #[test(should_fail_with = "zero change must be a dummy")]
    fn test_payment_relation_rejects_an_unopened_real_change_output() {
        let (tx, secret) = payment_transaction(SLOT_CLASS_NATIVE, SLOT_CLASS_DUMMY);
        let _ = run_payment(tx, 1000, secret, 0, 0);
    }

    #[test(should_fail_with = "padding slot must be a dummy")]
    fn test_payment_relation_rejects_non_dummy_padding_slot() {
        let (tx, secret) = payment_transaction(SLOT_CLASS_DUMMY, SLOT_CLASS_NATIVE);
        let _ = run_payment(tx, 1000, secret, 0, 0);
    }

    // The opened slot-0 note does not pay the displayed recipient and amount.
    #[test(should_fail_with = "declared output must match its declaration")]
    fn test_payment_relation_rejects_wrong_recipient_note() {
        let (mut tx, secret) = payment_transaction(SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY);
        tx.output_body_commitments[0] = 0x4444;
        let _ = run_payment(tx, 1000, secret, 0, 0);
    }

    // --- Owner change. ---

    #[test]
    fn test_payment_relation_accepts_change_under_the_owner_derived_secret() {
        let (mut tx, recipient_secret) = payment_transaction(SLOT_CLASS_NATIVE, SLOT_CLASS_DUMMY);
        tx.output_body_commitments[1] = owner_body(owner_change_secret(1), 0, 250);
        assert(run_payment(tx, 1000, recipient_secret, 250, 0) == transfer_statement(tx, 0));
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_payment_relation_rejects_change_under_a_free_secret() {
        let (mut tx, recipient_secret) = payment_transaction(SLOT_CLASS_NATIVE, SLOT_CLASS_DUMMY);
        tx.output_body_commitments[1] = owner_body(0x5002, 0, 250);
        let _ = run_payment(tx, 1000, recipient_secret, 250, 0);
    }

    // Slot 1 is the only change slot: owner change in slot 2 is rejected as padding.
    #[test(should_fail_with = "padding slot must be a dummy")]
    fn test_payment_relation_rejects_change_in_the_second_change_slot() {
        let (mut tx, recipient_secret) = payment_transaction(SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY);
        tx.output_slot_classes[2] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[2] = owner_body(owner_change_secret(2), 0, 250);
        let _ = run_payment(tx, 1000, recipient_secret, 0, 0);
    }

    // --- Zero-value payments. ---

    #[test]
    fn test_payment_relation_accepts_a_zero_payment_in_a_dummy_slot() {
        let tx = zero_payment_transaction();
        assert(run_payment(tx, 0, 0, 0, 0) == transfer_statement(tx, 0));
    }

    #[test]
    fn test_payment_relation_accepts_a_zero_payment_returning_inputs_as_change() {
        let mut tx = zero_payment_transaction();
        tx.input_slot_classes[0] = SLOT_CLASS_NATIVE;
        tx.input_commitments[0] = 0x71;
        tx.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[1] = owner_body(owner_change_secret(1), 0, 250);
        assert(run_payment(tx, 0, 0, 250, 0) == transfer_statement(tx, 0));
    }

    #[test(should_fail_with = "zero payment slot must be a dummy")]
    fn test_payment_relation_rejects_a_zero_payment_in_a_real_slot() {
        let mut tx = zero_payment_transaction();
        tx.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[0] =
            note_body_commitment(owner_commitment(TEST_RECIPIENT, 0x5001), 0, 0);
        let _ = run_payment(tx, 0, 0x5001, 0, 0);
    }

    #[test(should_fail_with = "declared native output must use a native slot")]
    fn test_payment_relation_rejects_a_positive_payment_in_a_dummy_slot() {
        let _ = run_payment(zero_payment_transaction(), 1000, 0x5001, 0, 0);
    }

    #[test(should_fail_with = "zero change must be a dummy")]
    fn test_payment_relation_rejects_an_unopened_output_beside_a_zero_payment() {
        let mut tx = zero_payment_transaction();
        tx.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        let _ = run_payment(tx, 0, 0, 0, 0);
    }

    // --- Signed payments. ---

    // TEST_SIGNING_KEY's signature over the payment `run_signed_payment` proves
    // on TEST_PCASH_CHAIN_ID.
    global SIGNED_PAYMENT_SIGNATURE: [u8; 64] = [
        0x0f, 0x49, 0x57, 0xd2, 0xc7, 0x12, 0xc8, 0x32, 0x6b, 0xda, 0xbb, 0xeb, 0x37, 0xf3, 0x4f,
        0x66, 0x34, 0x93, 0xa8, 0xae, 0x3c, 0x5c, 0xbe, 0xb0, 0xe4, 0xbf, 0xc9, 0xa0, 0xf5, 0x35,
        0x02, 0x51, 0x45, 0xa1, 0x30, 0x48, 0xbc, 0x9b, 0x71, 0x3a, 0xdd, 0xea, 0x56, 0xe4, 0xb9,
        0xdc, 0x95, 0x09, 0x26, 0x6a, 0x53, 0xcc, 0xe3, 0x9a, 0x08, 0x27, 0x31, 0x8c, 0x1d, 0x27,
        0xa7, 0x67, 0xe7, 0x3e,
    ];

    fn run_signed_payment(
        pcash_chain_id: Field,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let (tx, recipient_secret) = profile_transaction::<S_INPUTS, S_OUTPUTS>();
        main(
            pcash_chain_id,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature: SIGNED_PAYMENT_SIGNATURE },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            TEST_RECIPIENT,
            1000,
            0,
            0,
            0,
            0,
            tx,
            0,
            recipient_secret,
            event_entry,
        )
    }

    #[test]
    fn test_payment_accepts_the_owner_signature() {
        let _ = run_signed_payment(TEST_PCASH_CHAIN_ID, 0);
    }

    // The message signs the chain ID the action commitment binds, so a payment
    // signed for one chain cannot be proved on another.
    #[test(should_fail_with = "signature must be valid")]
    fn test_payment_rejects_a_signature_for_another_chain() {
        let _ = run_signed_payment(TEST_PCASH_CHAIN_ID + 1, 0);
    }
}
