// Standard-asset burn rule of the reference user account.
//
// The signer approves destroying the transaction's asset burn amount in one
// asset namespace, plus the fee, the transaction context, and the validity
// window. Every real
// output returns to the owner except an optional exact private relay note in
// the final slot. Asset remainder and native change open under the owner's
// implicit note secret, which the owner recomputes from `nk_root` and the
// published nullifiers.
//
// Transfer-plus-burn does not fit this rule and routes to batch.

use pcash_protocol::authorization::statement::{
    rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
use pcash_protocol::ledger::private_value::{private_value_commitment, PrivateValue};
use reference_rule_common::configuration::Configuration;
use reference_rule_common::message::verify_value_message;
use reference_rule_common::owner::open_owner;
use reference_rule_common::value_rule::{
    assert_asset_namespace, assert_ordinary_value_inputs, assert_output_declarations,
    assert_relay_terms, AssetNamespaceOpening, OutputDeclaration,
};
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

// keccak256 of the SDK ASSET_BURN_EIP712_TYPE, written by scripts/circuits/gen_reference_message_types.mjs.
global ASSET_BURN_TYPE_HASH: [u8; 32] = [
    0x69, 0x9a, 0x03, 0x43, 0x1a, 0x76, 0xae, 0xa4, 0xb9, 0xec, 0x69, 0x5c, 0x79, 0xc4, 0x1b, 0xd4,
    0xf8, 0x30, 0xc7, 0xe6, 0x10, 0x0d, 0x3f, 0x8f, 0xce, 0xb2, 0x9c, 0x2a, 0xa8, 0xd7, 0xb9, 0xc7,
];

pub fn asset_burn_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signer_address: Field,
    nk_root: Field,
    asset_id: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    owner_change_amounts: [Field; N_OUT],
    asset_namespace_opening: AssetNamespaceOpening,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    let owner = open_owner(signer_address, nk_root, configuration);

    // A nonzero burn binds `asset_id` to the kernel's nonzero asset ID, through
    // the namespace opening or an asset change body.
    assert(private_value.asset_burn_amount != 0, "burn amount must be nonzero");

    assert_ordinary_value_inputs(private_value);

    assert_relay_terms(private_value, relay_fee_amount, relay_fee_owner_commitment);

    let outputs = [OutputDeclaration { recipient: 0, amount: 0, asset_id: 0 }; N_OUT];
    let has_asset_output = assert_output_declarations(
        private_value,
        signer_address,
        nk_root,
        asset_id,
        outputs,
        relay_fee_amount,
        relay_fee_owner_commitment,
        [0; N_OUT],
        owner_change_amounts,
    );
    assert_asset_namespace(
        private_value,
        asset_id,
        has_asset_output,
        asset_namespace_opening,
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
    // Signed message fields; the burn amount is the private value's.
    asset_id: Field,
    issuance_recipient: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    // Private openings.
    private_value: PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>,
    issuance_note_secret: Field,
    owner_change_amounts: [Field; S_OUTPUTS],
    asset_namespace_opening: AssetNamespaceOpening,
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    let signer_address = pubkey.ethereum_address();
    let statement = asset_burn_relation(
        pcash_chain_id,
        recent_pcash_block_hash,
        configuration,
        signer_address,
        nk_root,
        asset_id,
        relay_fee_amount,
        relay_fee_owner_commitment,
        private_value,
        owner_change_amounts,
        asset_namespace_opening,
        event_entry,
    );

    verify_value_message(
        signature,
        pubkey,
        signer_address,
        configuration,
        ASSET_BURN_TYPE_HASH,
        pcash_chain_id,
        nk_root,
        [asset_id, private_value.asset_burn_amount],
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
    use super::{asset_burn_relation, main};
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
    use reference_rule_common::value_rule::AssetNamespaceOpening;
    use signature_common::secp256k1::Signature;

    global TEST_BURN: Field = 600;

    // Burn 600 of 1500 owned units; 900 returns as asset change, native change in
    // slot 1 pays for the fee remainder.
    fn fixture() -> (TestPrivateValue, [Field; 5], AssetNamespaceOpening) {
        let opening = AssetNamespaceOpening {
            owner_commitment: owner_commitment(TEST_SIGNER, 0x4001),
            amount: 1500,
            output_index: 12,
        };
        let input_body = owner_body(0x4001, TEST_ASSET_ID, 1500);
        let tx = TestPrivateValue {
            open_fee_amount: 5,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: TEST_BURN,
            delivery_commitment: 0x61,
            account_creation_commitment: 0,
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
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [
                owner_body(owner_change_secret(0), TEST_ASSET_ID, 900),
                owner_body(owner_change_secret(1), 0, 400),
                0x92,
                0x93,
                0x94,
            ],
        };
        (tx, [900, 400, 0, 0, 0], opening)
    }

    // The whole asset input burned: no asset change remains.
    fn full_burn() -> (TestPrivateValue, [Field; 5], AssetNamespaceOpening) {
        let (mut tx, mut changes, opening) = fixture();
        tx.asset_burn_amount = 1500;
        tx.output_slot_classes[0] = SLOT_CLASS_DUMMY;
        tx.output_body_commitments[0] = 0x90;
        changes[0] = 0;
        (tx, changes, opening)
    }

    fn run_with(
        asset_id: Field,
        tx: TestPrivateValue,
        owner_change_amounts: [Field; 5],
        opening: AssetNamespaceOpening,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        asset_burn_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            TEST_SIGNER,
            TEST_NK_ROOT,
            asset_id,
            0,
            0,
            tx,
            owner_change_amounts,
            opening,
            event_entry,
        )
    }

    fn run(
        tx: TestPrivateValue,
        owner_change_amounts: [Field; 5],
        opening: AssetNamespaceOpening,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        run_with(
            TEST_ASSET_ID,
            tx,
            owner_change_amounts,
            opening,
            event_entry,
        )
    }

    #[test]
    fn test_accepts_a_partial_burn() {
        let (tx, changes, opening) = fixture();
        assert(run(tx, changes, opening, 0) == transfer_statement(tx, 0));
    }

    #[test]
    fn test_accepts_a_full_burn_with_no_asset_remainder() {
        let (tx, changes, opening) = full_burn();
        assert(run_with(TEST_ASSET_ID, tx, changes, opening, 0) == transfer_statement(tx, 0));
    }

    #[test(should_fail_with = "burn amount must be nonzero")]
    fn test_rejects_a_zero_burn() {
        let (mut tx, changes, opening) = fixture();
        tx.asset_burn_amount = 0;
        let _ = run(tx, changes, opening, 0);
    }

    // The whole point of the rule: a burn signature cannot move value to anyone.
    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_any_third_party_output() {
        let (mut tx, changes, opening) = fixture();
        tx.output_body_commitments[1] = note_body_commitment(
            owner_commitment(TEST_RECIPIENT, owner_change_secret(1)),
            0,
            400,
        );
        let _ = run(tx, changes, opening, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_a_remainder_under_a_free_secret() {
        let (mut tx, changes, opening) = fixture();
        tx.output_body_commitments[0] = owner_body(0x5001, TEST_ASSET_ID, 900);
        let _ = run(tx, changes, opening, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_a_wrong_asset_id() {
        let (tx, changes, opening) = fixture();
        let _ = run_with(TEST_ASSET_ID + 1, tx, changes, opening, 0);
    }

    #[test(should_fail_with = "input slot must not be an application marker")]
    fn test_rejects_an_application_marker() {
        let (mut tx, changes, opening) = fixture();
        tx.input_slot_classes[2] = SLOT_CLASS_APPLICATION;
        let _ = run(tx, changes, opening, 0);
    }

    #[test(should_fail_with = "input slot must not be a creation marker")]
    fn test_rejects_a_creation_marker() {
        let (mut tx, changes, opening) = fixture();
        tx.input_slot_classes[2] = SLOT_CLASS_ASSET_CREATION;
        let _ = run(tx, changes, opening, 0);
    }

    #[test(should_fail_with = "first asset input must open in the signed asset")]
    fn test_full_burn_rejects_a_different_signed_namespace() {
        let (tx, changes, opening) = full_burn();
        let _ = run_with(TEST_ASSET_ID + 1, tx, changes, opening, 0);
    }

    #[test(should_fail_with = "first asset input must open in the signed asset")]
    fn test_full_burn_rejects_a_different_input_opening() {
        let (tx, changes, mut opening) = full_burn();
        opening.owner_commitment += 1;
        let _ = run_with(TEST_ASSET_ID, tx, changes, opening, 0);
    }

    #[test(should_fail_with = "first asset input must open in the signed asset")]
    fn test_full_burn_rejects_a_different_input_index() {
        let (tx, changes, mut opening) = full_burn();
        opening.output_index += 1;
        let _ = run_with(TEST_ASSET_ID, tx, changes, opening, 0);
    }

    #[test]
    fn test_partial_burn_binds_namespace_through_change_without_an_input_opening() {
        let (tx, changes, _) = fixture();
        let _ = run(
            tx,
            changes,
            AssetNamespaceOpening { owner_commitment: 0, amount: 0, output_index: 0 },
            0,
        );
    }

    #[test]
    fn test_full_burn_finds_an_asset_input_after_a_native_slot() {
        let (mut tx, changes, opening) = full_burn();
        let asset_commitment = tx.input_commitments[0];
        tx.input_slot_classes[0] = SLOT_CLASS_NATIVE;
        tx.input_commitments[0] = tx.input_commitments[1];
        tx.input_slot_classes[1] = SLOT_CLASS_ASSET;
        tx.input_commitments[1] = asset_commitment;
        let _ = run_with(TEST_ASSET_ID, tx, changes, opening, 0);
    }

    // --- Signed burns. ---

    // TEST_SIGNING_KEY's signature over the full burn `run_signed_burn` proves on
    // TEST_PCASH_CHAIN_ID.
    global SIGNED_BURN_SIGNATURE: [u8; 64] = [
        0x3f, 0xcd, 0x12, 0xbf, 0x79, 0x7f, 0xc2, 0x5d, 0xb8, 0xcf, 0xca, 0x40, 0x4f, 0x3b, 0x28,
        0x85, 0x5c, 0xe1, 0x36, 0x6e, 0x51, 0x44, 0x98, 0x79, 0x47, 0xd0, 0x45, 0x75, 0xbb, 0xaa,
        0x9f, 0x1c, 0x60, 0xe5, 0xba, 0xc7, 0xf7, 0x24, 0xb1, 0x6c, 0x9c, 0xe5, 0x00, 0x4a, 0x40,
        0x1a, 0xc1, 0x59, 0x78, 0x7a, 0x04, 0x31, 0x74, 0x2d, 0xd1, 0x81, 0x48, 0x4d, 0x0c, 0xde,
        0xb2, 0x42, 0xff, 0xb4,
    ];

    fn run_signed_burn(
        pcash_chain_id: Field,
        burn_amount: Field,
        event_entry: Field,
        account_creation_commitment: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let opening =
            AssetNamespaceOpening { owner_commitment: 0x77, amount: TEST_BURN, output_index: 3 };
        let mut tx = small_transaction(5, 2000000000);
        tx.asset_burn_amount = burn_amount;
        tx.input_slot_classes[0] = SLOT_CLASS_ASSET;
        tx.input_commitments[0] =
            output_commitment(note_body_commitment(0x77, TEST_ASSET_ID, TEST_BURN), 3);
        tx.account_creation_commitment = account_creation_commitment;
        main(
            pcash_chain_id,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature: SIGNED_BURN_SIGNATURE },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            TEST_ASSET_ID,
            0,
            0,
            0,
            tx,
            0,
            [0; S_OUTPUTS],
            opening,
            event_entry,
        )
    }

    #[test]
    fn test_asset_burn_accepts_the_owner_signature() {
        let _ = run_signed_burn(TEST_PCASH_CHAIN_ID, TEST_BURN, 0, 0);
    }

    // The message signs the chain ID the action commitment binds, so a burn
    // signed for one chain cannot be proved on another.
    #[test(should_fail_with = "signature must be valid")]
    fn test_asset_burn_rejects_a_signature_for_another_chain() {
        let _ = run_signed_burn(TEST_PCASH_CHAIN_ID + 1, TEST_BURN, 0, 0);
    }

    // The message signs the private value's burn amount, so a signature does not
    // authorize another burn of the same input.
    #[test(should_fail_with = "signature must be valid")]
    fn test_asset_burn_rejects_a_signature_for_another_burn_amount() {
        let _ = run_signed_burn(TEST_PCASH_CHAIN_ID, TEST_BURN - 1, 0, 0);
    }
    #[test(should_fail_with = "signature must be valid")]
    fn test_burn_rejects_an_unsigned_attachment() {
        let _ = run_signed_burn(TEST_PCASH_CHAIN_ID, TEST_BURN, 0, 1);
    }

}
