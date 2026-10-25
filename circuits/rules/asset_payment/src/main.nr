// Standard-asset payment rule of the reference user account.
//
// The signer approves one asset payment — namespace, recipient and amount —
// plus the fee, the transaction context, and the validity window. Output slot 0
// is that payment. Every other real output returns to the owner except an
// optional exact private relay note in the final slot. Asset and native change
// open under the owner's implicit note secret, which the owner recomputes from
// `nk_root` and the published nullifiers; they stay private and never reach the
// injected Ethereum wallet's typed data.
//
// Multiple external recipients do not fit this rule and route to batch.

use pcash_protocol::authorization::statement::{
    rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
use pcash_protocol::ledger::private_value::{private_value_commitment, PrivateValue};
use reference_rule_common::configuration::Configuration;
use reference_rule_common::message::verify_value_message;
use reference_rule_common::owner::open_owner;
use reference_rule_common::value_rule::{
    assert_ordinary_value_inputs, assert_output_declarations, assert_relay_terms, OutputDeclaration,
};
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

// keccak256 of the SDK ASSET_PAYMENT_EIP712_TYPE, written by scripts/circuits/gen_reference_message_types.mjs.
global ASSET_PAYMENT_TYPE_HASH: [u8; 32] = [
    0xe3, 0xef, 0xc9, 0x0c, 0x60, 0x04, 0x04, 0x16, 0x8e, 0xff, 0xcd, 0xb3, 0xf1, 0x83, 0xaa, 0xf6,
    0x62, 0x9f, 0x24, 0x28, 0xe9, 0x4e, 0x09, 0x66, 0x08, 0xde, 0x6c, 0xac, 0x2b, 0x45, 0xc1, 0xe9,
];

pub fn asset_payment_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signer_address: Field,
    nk_root: Field,
    asset_id: Field,
    recipient: Field,
    amount: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    recipient_note_secret: Field,
    owner_change_amounts: [Field; N_OUT],
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    let owner = open_owner(signer_address, nk_root, configuration);

    assert(asset_id != 0, "signed asset ID must be nonzero");
    assert(private_value.asset_burn_amount == 0, "asset burn amount must be zero");
    assert_ordinary_value_inputs(private_value);

    // The mandatory asset payment binds the signed namespace to the kernel's
    // one namespace. Its nonzero asset ID also rejects a zero recipient, since
    // an undeclared slot must be all-zero. Input ownership, conservation, and a
    // nonzero real-output amount are kernel constraints.
    let mut outputs = [OutputDeclaration { recipient: 0, amount: 0, asset_id: 0 }; N_OUT];
    outputs[0] = OutputDeclaration { recipient, amount, asset_id };
    let mut secrets = [0; N_OUT];
    secrets[0] = recipient_note_secret;
    assert_relay_terms(private_value, relay_fee_amount, relay_fee_owner_commitment);
    let _ = assert_output_declarations(
        private_value,
        signer_address,
        nk_root,
        asset_id,
        outputs,
        relay_fee_amount,
        relay_fee_owner_commitment,
        secrets,
        owner_change_amounts,
    );
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
    asset_id: Field,
    recipient: Field,
    amount: Field,
    issuance_recipient: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    // Private openings.
    private_value: PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>,
    issuance_note_secret: Field,
    recipient_note_secret: Field,
    owner_change_amounts: [Field; S_OUTPUTS],
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    let signer_address = pubkey.ethereum_address();
    let statement = asset_payment_relation(
        pcash_chain_id,
        recent_pcash_block_hash,
        configuration,
        signer_address,
        nk_root,
        asset_id,
        recipient,
        amount,
        relay_fee_amount,
        relay_fee_owner_commitment,
        private_value,
        recipient_note_secret,
        owner_change_amounts,
        event_entry,
    );

    verify_value_message(
        signature,
        pubkey,
        signer_address,
        configuration,
        ASSET_PAYMENT_TYPE_HASH,
        pcash_chain_id,
        nk_root,
        [asset_id, recipient, amount],
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
    use super::{asset_payment_relation, main};
    use pcash_protocol::authorization::statement::RULE_STATEMENT_LENGTH;
    use pcash_protocol::generated::private_value_profiles::S_OUTPUTS;
    use pcash_protocol::ledger::note::{note_body_commitment, output_commitment, owner_commitment};
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY,
        SLOT_CLASS_NATIVE,
    };
    use reference_rule_common::test_support::{
        owner_body, owner_change_secret, small_transaction, TEST_ASSET_ID, TEST_CONFIGURATION,
        TEST_NK_ROOT, TEST_NULLIFIERS, TEST_PCASH_CHAIN_ID, TEST_RECENT_BLOCK, TEST_RECIPIENT,
        TEST_SIGNER, TEST_SIGNING_KEY, TestPrivateValue, transfer_statement,
    };
    use signature_common::secp256k1::Signature;

    // One asset payment, asset change in slot 1, native change in slot 2, funded by
    // one owner asset note and one native note.
    fn fixture() -> (TestPrivateValue, [Field; 5]) {
        let input_body = owner_body(0x4001, TEST_ASSET_ID, 1500);
        let tx = TestPrivateValue {
            open_fee_amount: 5,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0x61,
            input_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            input_commitments: [output_commitment(input_body, 12), 0x72, 0, 0],
            nullifiers: TEST_NULLIFIERS,
            output_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_ASSET,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [
                note_body_commitment(
                    owner_commitment(TEST_RECIPIENT, 0x5001),
                    TEST_ASSET_ID,
                    1000,
                ),
                owner_body(owner_change_secret(1), TEST_ASSET_ID, 500),
                owner_body(owner_change_secret(2), 0, 400),
                0x93,
                0x94,
            ],
        };
        (tx, [0, 500, 400, 0, 0])
    }

    fn run_with(
        asset_id: Field,
        recipient: Field,
        amount: Field,
        tx: TestPrivateValue,
        owner_change_amounts: [Field; 5],
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        asset_payment_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            TEST_SIGNER,
            TEST_NK_ROOT,
            asset_id,
            recipient,
            amount,
            0,
            0,
            tx,
            0x5001,
            owner_change_amounts,
            event_entry,
        )
    }

    fn run(
        tx: TestPrivateValue,
        owner_change_amounts: [Field; 5],
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        run_with(
            TEST_ASSET_ID,
            TEST_RECIPIENT,
            1000,
            tx,
            owner_change_amounts,
            event_entry,
        )
    }

    #[test]
    fn test_accepts_the_displayed_asset_payment() {
        let (tx, changes) = fixture();
        assert(run(tx, changes, 0) == transfer_statement(tx, 0));
    }

    #[test(should_fail_with = "declared output must match its declaration")]
    fn test_rejects_a_wrong_recipient() {
        let (tx, changes) = fixture();
        let _ = run_with(TEST_ASSET_ID, TEST_RECIPIENT + 1, 1000, tx, changes, 0);
    }

    #[test(should_fail_with = "declared output must match its declaration")]
    fn test_rejects_a_wrong_amount() {
        let (tx, changes) = fixture();
        let _ = run_with(TEST_ASSET_ID, TEST_RECIPIENT, 1001, tx, changes, 0);
    }

    #[test(should_fail_with = "declared output must match its declaration")]
    fn test_rejects_a_wrong_asset_id() {
        let (tx, changes) = fixture();
        let _ = run_with(TEST_ASSET_ID + 1, TEST_RECIPIENT, 1000, tx, changes, 0);
    }

    #[test(should_fail_with = "asset burn amount must be zero")]
    fn test_rejects_a_burn() {
        let (mut tx, changes) = fixture();
        tx.asset_burn_amount = 1;
        let _ = run(tx, changes, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_change_redirected_to_a_non_owner() {
        let (mut tx, changes) = fixture();
        tx.output_body_commitments[2] = note_body_commitment(
            owner_commitment(TEST_RECIPIENT, owner_change_secret(2)),
            0,
            400,
        );
        let _ = run(tx, changes, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_change_under_a_free_secret() {
        let (mut tx, changes) = fixture();
        tx.output_body_commitments[1] = owner_body(0x5002, TEST_ASSET_ID, 500);
        let _ = run(tx, changes, 0);
    }

    #[test(should_fail_with = "input slot must not be an application marker")]
    fn test_rejects_an_application_marker() {
        let (mut tx, changes) = fixture();
        tx.input_slot_classes[2] = SLOT_CLASS_APPLICATION;
        let _ = run(tx, changes, 0);
    }

    #[test(should_fail_with = "input slot must not be a creation marker")]
    fn test_rejects_a_creation_marker() {
        let (mut tx, changes) = fixture();
        tx.input_slot_classes[2] = SLOT_CLASS_ASSET_CREATION;
        let _ = run(tx, changes, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_a_second_asset_namespace_in_change() {
        let (mut tx, changes) = fixture();
        tx.output_body_commitments[1] = owner_body(owner_change_secret(1), TEST_ASSET_ID + 1, 500);
        let _ = run(tx, changes, 0);
    }

    // --- Signed payments. ---

    // TEST_SIGNING_KEY's signature over the asset payment `run_signed_asset_payment`
    // proves on TEST_PCASH_CHAIN_ID.
    global SIGNED_ASSET_PAYMENT_SIGNATURE: [u8; 64] = [
        0xa7, 0x89, 0x99, 0xfa, 0x72, 0x43, 0x61, 0x36, 0x02, 0x37, 0x31, 0xfd, 0xf1, 0x29, 0x44,
        0x8e, 0x8f, 0x79, 0x7b, 0xab, 0xae, 0x56, 0x18, 0xca, 0x7b, 0x5f, 0xd8, 0x0e, 0xf7, 0x38,
        0xba, 0xff, 0x52, 0x38, 0x81, 0xc9, 0xa8, 0x4c, 0xee, 0x5c, 0xa7, 0x21, 0x8c, 0x5c, 0x29,
        0x04, 0xde, 0xda, 0xf1, 0x97, 0x3c, 0xee, 0xd8, 0x11, 0x0a, 0xdd, 0xbb, 0x04, 0xdf, 0x6f,
        0xd4, 0x16, 0x94, 0xc1,
    ];

    fn run_signed_asset_payment(
        pcash_chain_id: Field,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let mut tx = small_transaction(5, 2000000000);
        tx.input_slot_classes[0] = SLOT_CLASS_ASSET;
        tx.input_commitments[0] = 0x71;
        tx.output_slot_classes[0] = SLOT_CLASS_ASSET;
        tx.output_body_commitments[0] = note_body_commitment(
            owner_commitment(TEST_RECIPIENT, 0x5001),
            TEST_ASSET_ID,
            1000,
        );
        tx.delivery_commitment = 0x61;
        main(
            pcash_chain_id,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature: SIGNED_ASSET_PAYMENT_SIGNATURE },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            TEST_ASSET_ID,
            TEST_RECIPIENT,
            1000,
            0,
            0,
            0,
            tx,
            0,
            0x5001,
            [0; S_OUTPUTS],
            event_entry,
        )
    }

    #[test]
    fn test_asset_payment_accepts_the_owner_signature() {
        let _ = run_signed_asset_payment(TEST_PCASH_CHAIN_ID, 0);
    }

    // The message signs the chain ID the action commitment binds, so a payment
    // signed for one chain cannot be proved on another.
    #[test(should_fail_with = "signature must be valid")]
    fn test_asset_payment_rejects_a_signature_for_another_chain() {
        let _ = run_signed_asset_payment(TEST_PCASH_CHAIN_ID + 1, 0);
    }
}
