// General semantic batch transfer rule of the reference user account.
//
// The signer approves every externally-directed output — recipient, amount and
// asset namespace — plus the burn, the fee, the transaction context, and the
// validity window. The circuit privately opens the complete transaction and
// proves that everything the message did not name belongs to the owner.
//
// A declaration with a zero recipient means owner change or padding, except
// the final slot may carry the separately signed private relay output. Owner
// change is proved, never signed, so the user's private change amounts stay out
// of the typed data the injected Ethereum wallet sees. Conservation in the
// parent kernel already bounds the totals, so signing change would buy nothing
// and leak balances. Owner change opens under the owner's implicit note secret,
// so the signer can recompute it from `nk_root` and the published nullifiers.
//
// This rule covers multiple recipients, mixed native/asset outputs, and
// transfer-plus-burn. It is ordinary private-value authority only: it rejects
// application markers, creation markers, and any second asset namespace.

use crate::configuration::Configuration;
use crate::message::verify_value_message;
use crate::owner::open_owner;
use crate::value_rule::{
    assert_asset_namespace, assert_ordinary_value_inputs, assert_output_declarations,
    assert_relay_terms, AssetNamespaceOpening, OutputDeclaration,
};
use pcash_protocol::authorization::statement::{
    rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, PrivateValue, SLOT_CLASS_ASSET,
};
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

pub fn batch_transfer_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signer_address: Field,
    nk_root: Field,
    asset_id: Field,
    outputs: [OutputDeclaration; N_OUT],
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    output_note_secrets: [Field; N_OUT],
    owner_change_amounts: [Field; N_OUT],
    asset_namespace_opening: AssetNamespaceOpening,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    let owner = open_owner(signer_address, nk_root, configuration);

    assert_relay_terms(private_value, relay_fee_amount, relay_fee_owner_commitment);

    let has_asset_output = assert_output_declarations(
        private_value,
        signer_address,
        nk_root,
        asset_id,
        outputs,
        relay_fee_amount,
        relay_fee_owner_commitment,
        output_note_secrets,
        owner_change_amounts,
    );

    // Neither marker class is a value effect this rule can display.
    assert_ordinary_value_inputs(private_value);
    let mut has_asset_input = false;
    for i in 0..N_IN {
        has_asset_input |= private_value.input_slot_classes[i] == SLOT_CLASS_ASSET;
    }
    // The signed namespace must describe the transaction in both directions: a
    // native-only batch names zero, while every asset-bearing batch names its
    // one nonzero namespace. Without the reverse implication a signer could be
    // shown an asset ID for an otherwise native-only action.
    let has_asset = has_asset_input | has_asset_output | (private_value.asset_burn_amount != 0);
    assert(
        (asset_id != 0) == has_asset,
        "asset ID must be nonzero exactly when the transaction carries an asset",
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

pub fn authorize<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    type_hash: [u8; 32],
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signature: Signature,
    pubkey: Secp256k1PubKey,
    nk_root: Field,
    asset_id: Field,
    outputs: [OutputDeclaration; N_OUT],
    issuance_recipient: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    issuance_note_secret: Field,
    output_note_secrets: [Field; N_OUT],
    owner_change_amounts: [Field; N_OUT],
    asset_namespace_opening: AssetNamespaceOpening,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    let signer_address = pubkey.ethereum_address();
    let statement = batch_transfer_relation(
        pcash_chain_id,
        recent_pcash_block_hash,
        configuration,
        signer_address,
        nk_root,
        asset_id,
        outputs,
        relay_fee_amount,
        relay_fee_owner_commitment,
        private_value,
        output_note_secrets,
        owner_change_amounts,
        asset_namespace_opening,
        event_entry,
    );
    verify_value_message(
        signature,
        pubkey,
        signer_address,
        configuration,
        type_hash,
        pcash_chain_id,
        nk_root,
        [asset_id, private_value.asset_burn_amount],
        outputs,
        private_value,
        issuance_recipient,
        issuance_note_secret,
        relay_fee_amount,
        relay_fee_owner_commitment,
    );
    statement
}

mod tests {
    use crate::generated::reference_rule_constants::S_BATCH_TRANSFER_TYPE_HASH;
    use crate::issuance_opening::assert_owner_issuance_opening;
    use crate::payout::{ISSUANCE_ROLE, payout_note_secret, payout_seed, transaction_context};
    use crate::test_support::{
        assert_transfer_kernel_accepts, owner_body, owner_change_secret, TEST_ASSET_ID,
        TEST_ATTACKER, TEST_CONFIGURATION, TEST_NK_ROOT, TEST_NULLIFIERS, TEST_PCASH_CHAIN_ID,
        TEST_RECENT_BLOCK, TEST_RECIPIENT, TEST_SIGNER, TEST_SIGNING_KEY, TestPrivateValue,
        transfer_statement,
    };
    use crate::value_rule::{
        AssetNamespaceOpening, MAX_NOTE_AMOUNT, OutputDeclaration, owner_change_note_secret,
    };
    use super::{authorize, batch_transfer_relation};
    use pcash_protocol::authorization::statement::RULE_STATEMENT_LENGTH;
    use pcash_protocol::ledger::note::{note_body_commitment, output_commitment, owner_commitment};
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY,
        SLOT_CLASS_NATIVE,
    };
    use signature_common::secp256k1::Signature;

    global TEST_RECIPIENT_2: Field = 0x3333333333333333333333333333333333333333;

    fn zero_declaration() -> OutputDeclaration {
        OutputDeclaration { recipient: 0, amount: 0, asset_id: 0 }
    }

    fn no_namespace_opening() -> AssetNamespaceOpening {
        AssetNamespaceOpening { owner_commitment: 0, amount: 0, output_index: 0 }
    }

    fn directed_body(recipient: Field, secret: Field, asset_id: Field, amount: Field) -> Field {
        note_body_commitment(owner_commitment(recipient, secret), asset_id, amount)
    }

    fn run(
        asset_id: Field,
        outputs: [OutputDeclaration; 5],
        private_value: TestPrivateValue,
        output_note_secrets: [Field; 5],
        owner_change_amounts: [Field; 5],
        asset_namespace_opening: AssetNamespaceOpening,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        run_as(
            TEST_SIGNER,
            TEST_NK_ROOT,
            asset_id,
            outputs,
            private_value,
            output_note_secrets,
            owner_change_amounts,
            asset_namespace_opening,
            event_entry,
        )
    }

    // `run` for any signer address and witnessed `nk_root`.
    fn run_as(
        signer_address: Field,
        nk_root: Field,
        asset_id: Field,
        outputs: [OutputDeclaration; 5],
        private_value: TestPrivateValue,
        output_note_secrets: [Field; 5],
        owner_change_amounts: [Field; 5],
        asset_namespace_opening: AssetNamespaceOpening,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        batch_transfer_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            signer_address,
            nk_root,
            asset_id,
            outputs,
            0,
            0,
            private_value,
            output_note_secrets,
            owner_change_amounts,
            asset_namespace_opening,
            event_entry,
        )
    }

    fn native_batch() -> ([OutputDeclaration; 5], TestPrivateValue, [Field; 5], [Field; 5], AssetNamespaceOpening) {
        let outputs = [
            OutputDeclaration { recipient: TEST_RECIPIENT, amount: 1000, asset_id: 0 },
            OutputDeclaration { recipient: TEST_RECIPIENT_2, amount: 250, asset_id: 0 },
            zero_declaration(),
            zero_declaration(),
            zero_declaration(),
        ];
        let secrets = [0x5001, 0x5002, 0, 0, 0];
        let changes = [0, 0, 400, 0, 0];
        let tx = TestPrivateValue {
            open_fee_amount: 5,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
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
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [
                directed_body(TEST_RECIPIENT, 0x5001, 0, 1000),
                directed_body(TEST_RECIPIENT_2, 0x5002, 0, 250),
                owner_body(owner_change_secret(2), 0, 400),
                0x93,
                0x94,
            ],
        };
        (outputs, tx, secrets, changes, no_namespace_opening())
    }

    fn asset_batch() -> ([OutputDeclaration; 5], TestPrivateValue, [Field; 5], [Field; 5], AssetNamespaceOpening) {
        let outputs = [
            OutputDeclaration { recipient: TEST_RECIPIENT, amount: 1000, asset_id: TEST_ASSET_ID },
            zero_declaration(),
            zero_declaration(),
            zero_declaration(),
            zero_declaration(),
        ];
        let input_secret = 0x7001;
        let input_amount = 1250;
        let input_index = 7;
        let input_body = owner_body(input_secret, TEST_ASSET_ID, input_amount);
        let tx = TestPrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 10,
            delivery_commitment: 0x61,
            account_creation_commitment: 0,
            input_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            input_commitments: [output_commitment(input_body, input_index), 0, 0, 0],
            nullifiers: TEST_NULLIFIERS,
            output_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_ASSET,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [
                directed_body(TEST_RECIPIENT, 0x5001, TEST_ASSET_ID, 1000),
                owner_body(owner_change_secret(1), TEST_ASSET_ID, 240),
                0x92,
                0x93,
                0x94,
            ],
        };
        let opening = AssetNamespaceOpening {
            owner_commitment: owner_commitment(TEST_SIGNER, input_secret),
            amount: input_amount,
            output_index: input_index,
        };
        (outputs, tx, [0x5001, 0, 0, 0, 0], [0, 240, 0, 0, 0], opening)
    }

    fn full_burn_batch() -> (TestPrivateValue, AssetNamespaceOpening) {
        let (_, mut tx, _, _, opening) = asset_batch();
        tx.asset_burn_amount = 1250;
        tx.output_slot_classes = [SLOT_CLASS_DUMMY; 5];
        tx.output_body_commitments = [0x91, 0x92, 0x93, 0x94, 0x95];
        (tx, opening)
    }

    global RELAY_OWNER: Field = 0x200;

    fn relay_batch() -> ([OutputDeclaration; 5], TestPrivateValue, [Field; 5], [Field; 5]) {
        relay_batch_to(RELAY_OWNER)
    }

    fn relay_batch_to(
        relay_owner: Field,
    ) -> ([OutputDeclaration; 5], TestPrivateValue, [Field; 5], [Field; 5]) {
        let (outputs, mut tx, secrets, changes, _) = native_batch();
        tx.open_fee_amount = 0;
        tx.issuance_owner_commitment = 0x100;
        tx.output_slot_classes[4] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[4] = note_body_commitment(relay_owner, 0, 25);
        (outputs, tx, secrets, changes)
    }

    fn run_relay_batch(
        outputs: [OutputDeclaration; 5],
        tx: TestPrivateValue,
        secrets: [Field; 5],
        changes: [Field; 5],
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        run_relay_batch_to(RELAY_OWNER, outputs, tx, secrets, changes)
    }

    fn run_relay_batch_to(
        relay_owner: Field,
        outputs: [OutputDeclaration; 5],
        tx: TestPrivateValue,
        secrets: [Field; 5],
        changes: [Field; 5],
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        batch_transfer_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            TEST_SIGNER,
            TEST_NK_ROOT,
            0,
            outputs,
            25,
            relay_owner,
            tx,
            secrets,
            changes,
            no_namespace_opening(),
            0,
        )
    }

    #[test]
    fn test_accepts_a_native_multi_recipient_batch() {
        let (outputs, tx, secrets, changes, opening) = native_batch();
        assert(run(0, outputs, tx, secrets, changes, opening, 0) == transfer_statement(tx, 0));
    }

    #[test]
    fn test_accepts_an_asset_payment_with_private_change_and_burn() {
        let (outputs, tx, secrets, changes, opening) = asset_batch();
        assert(
            run(TEST_ASSET_ID, outputs, tx, secrets, changes, opening, 0)
                == transfer_statement(tx, 0),
        );
    }

    #[test(should_fail_with = "asset ID must be nonzero exactly when the transaction carries an asset")]
    fn test_rejects_a_native_only_batch_with_a_nonzero_asset_id() {
        let (outputs, tx, secrets, changes, opening) = native_batch();
        let _ = run(TEST_ASSET_ID, outputs, tx, secrets, changes, opening, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_change_redirected_to_a_non_owner() {
        let (outputs, mut tx, secrets, changes, opening) = native_batch();
        tx.output_body_commitments[2] =
            directed_body(TEST_RECIPIENT, owner_change_secret(2), 0, 400);
        let _ = run(0, outputs, tx, secrets, changes, opening, 0);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_owner_change_under_a_free_secret() {
        let (outputs, mut tx, secrets, changes, opening) = native_batch();
        tx.output_body_commitments[2] = owner_body(0x5003, 0, 400);
        let _ = run(0, outputs, tx, secrets, changes, opening, 0);
    }

    // Change larger than one note is full notes, then the remainder. Each
    // namespace is split on its own, so the two may interleave.
    #[test]
    fn test_accepts_owner_change_split_into_full_notes_and_a_remainder() {
        let (outputs, mut tx, secrets, _, opening) = asset_batch();
        tx.output_slot_classes = [
            SLOT_CLASS_ASSET,
            SLOT_CLASS_ASSET,
            SLOT_CLASS_NATIVE,
            SLOT_CLASS_ASSET,
            SLOT_CLASS_NATIVE,
        ];
        tx.output_body_commitments[1] =
            owner_body(owner_change_secret(1), TEST_ASSET_ID, MAX_NOTE_AMOUNT);
        tx.output_body_commitments[2] = owner_body(owner_change_secret(2), 0, MAX_NOTE_AMOUNT);
        tx.output_body_commitments[3] = owner_body(owner_change_secret(3), TEST_ASSET_ID, 240);
        tx.output_body_commitments[4] = owner_body(owner_change_secret(4), 0, 77);
        let changes = [0, MAX_NOTE_AMOUNT, MAX_NOTE_AMOUNT, 240, 77];
        assert(
            run(TEST_ASSET_ID, outputs, tx, secrets, changes, opening, 0)
                == transfer_statement(tx, 0),
        );
    }

    // Change that is an exact multiple of the largest note has no remainder.
    #[test]
    fn test_accepts_owner_change_of_only_full_notes() {
        let (outputs, mut tx, secrets, _, opening) = asset_batch();
        tx.output_slot_classes[2] = SLOT_CLASS_ASSET;
        tx.output_body_commitments[1] =
            owner_body(owner_change_secret(1), TEST_ASSET_ID, MAX_NOTE_AMOUNT);
        tx.output_body_commitments[2] =
            owner_body(owner_change_secret(2), TEST_ASSET_ID, MAX_NOTE_AMOUNT);
        let changes = [0, MAX_NOTE_AMOUNT, MAX_NOTE_AMOUNT, 0, 0];
        assert(
            run(TEST_ASSET_ID, outputs, tx, secrets, changes, opening, 0)
                == transfer_statement(tx, 0),
        );
    }

    // A slot between two change notes does not reset the order.
    #[test(should_fail_with = "owner change before the last must hold the largest note amount")]
    fn test_rejects_a_change_note_after_the_remainder_across_padding() {
        let (outputs, mut tx, secrets, _, opening) = asset_batch();
        tx.output_slot_classes = [
            SLOT_CLASS_ASSET,
            SLOT_CLASS_ASSET,
            SLOT_CLASS_ASSET,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_ASSET,
        ];
        tx.output_body_commitments[1] =
            owner_body(owner_change_secret(1), TEST_ASSET_ID, MAX_NOTE_AMOUNT);
        tx.output_body_commitments[2] = owner_body(owner_change_secret(2), TEST_ASSET_ID, 240);
        tx.output_body_commitments[4] = owner_body(owner_change_secret(4), TEST_ASSET_ID, 5);
        let _ = run(
            TEST_ASSET_ID,
            outputs,
            tx,
            secrets,
            [0, MAX_NOTE_AMOUNT, 240, 0, 5],
            opening,
            0,
        );
    }

    // The owner knows only the total, so a free split is change it cannot open.
    #[test(should_fail_with = "owner change before the last must hold the largest note amount")]
    fn test_rejects_owner_change_split_into_arbitrary_amounts() {
        let (outputs, mut tx, secrets, _, opening) = native_batch();
        tx.output_slot_classes[3] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[2] = owner_body(owner_change_secret(2), 0, 123);
        tx.output_body_commitments[3] = owner_body(owner_change_secret(3), 0, 277);
        let _ = run(0, outputs, tx, secrets, [0, 0, 123, 277, 0], opening, 0);
    }

    #[test(should_fail_with = "owner change before the last must hold the largest note amount")]
    fn test_rejects_a_remainder_before_a_full_change_note() {
        let (outputs, mut tx, secrets, _, opening) = asset_batch();
        tx.output_slot_classes[2] = SLOT_CLASS_ASSET;
        tx.output_body_commitments[2] =
            owner_body(owner_change_secret(2), TEST_ASSET_ID, MAX_NOTE_AMOUNT);
        let _ = run(
            TEST_ASSET_ID,
            outputs,
            tx,
            secrets,
            [0, 240, MAX_NOTE_AMOUNT, 0, 0],
            opening,
            0,
        );
    }

    // Owner change derives its own secret, so an undirected slot's secret
    // witness is unread.
    #[test]
    fn test_ignores_the_secret_witness_of_an_undirected_slot() {
        let (outputs, tx, mut secrets, changes, opening) = native_batch();
        secrets[2] = owner_change_secret(2);
        assert(run(0, outputs, tx, secrets, changes, opening, 0) == transfer_statement(tx, 0));
    }

    #[test(should_fail_with = "undeclared slot must be all-zero")]
    fn test_rejects_a_partially_zero_undirected_declaration() {
        let (mut outputs, tx, secrets, changes, opening) = native_batch();
        outputs[3] = OutputDeclaration { recipient: 0, amount: 7, asset_id: 0 };
        let _ = run(0, outputs, tx, secrets, changes, opening, 0);
    }

    #[test(should_fail_with = "declared output must match its declaration")]
    fn test_rejects_a_wrong_declared_amount() {
        let (mut outputs, tx, secrets, changes, opening) = native_batch();
        outputs[0] = OutputDeclaration { recipient: TEST_RECIPIENT, amount: 1001, asset_id: 0 };
        let _ = run(0, outputs, tx, secrets, changes, opening, 0);
    }

    #[test(should_fail_with = "declared output must match its declaration")]
    fn test_rejects_a_wrong_declared_recipient() {
        let (mut outputs, tx, secrets, changes, opening) = native_batch();
        outputs[0] = OutputDeclaration { recipient: TEST_RECIPIENT_2, amount: 1000, asset_id: 0 };
        let _ = run(0, outputs, tx, secrets, changes, opening, 0);
    }

    #[test(should_fail_with = "input slot must not be an application marker")]
    fn test_rejects_an_application_marker() {
        let (outputs, mut tx, secrets, changes, opening) = native_batch();
        tx.input_slot_classes[1] = SLOT_CLASS_APPLICATION;
        let _ = run(0, outputs, tx, secrets, changes, opening, 0);
    }

    #[test(should_fail_with = "input slot must not be a creation marker")]
    fn test_rejects_a_creation_marker() {
        let (outputs, mut tx, secrets, changes, opening) = native_batch();
        tx.input_slot_classes[1] = SLOT_CLASS_ASSET_CREATION;
        let _ = run(0, outputs, tx, secrets, changes, opening, 0);
    }

    #[test(should_fail_with = "declared output asset ID must equal the signed asset ID")]
    fn test_rejects_a_second_asset_namespace() {
        let (mut outputs, mut tx, secrets, changes, opening) = native_batch();
        outputs[0] = OutputDeclaration {
            recipient: TEST_RECIPIENT,
            amount: 1000,
            asset_id: TEST_ASSET_ID + 1,
        };
        tx.output_slot_classes[0] = SLOT_CLASS_ASSET;
        tx.output_body_commitments[0] =
            directed_body(TEST_RECIPIENT, 0x5001, TEST_ASSET_ID + 1, 1000);
        let _ = run(TEST_ASSET_ID, outputs, tx, secrets, changes, opening, 0);
    }

    #[test(should_fail_with = "asset ID must be nonzero exactly when the transaction carries an asset")]
    fn test_rejects_a_native_only_batch_that_burns() {
        let (outputs, mut tx, secrets, changes, opening) = native_batch();
        tx.asset_burn_amount = 10;
        let _ = run(0, outputs, tx, secrets, changes, opening, 0);
    }

    #[test]
    fn test_full_burn_binds_namespace_without_asset_outputs() {
        let (tx, opening) = full_burn_batch();
        let _ = run(
            TEST_ASSET_ID,
            [zero_declaration(); 5],
            tx,
            [0; 5],
            [0; 5],
            opening,
            0,
        );
    }

    #[test(should_fail_with = "first asset input must open in the signed asset")]
    fn test_full_burn_rejects_a_different_signed_namespace() {
        let (tx, opening) = full_burn_batch();
        let _ = run(
            TEST_ASSET_ID + 1,
            [zero_declaration(); 5],
            tx,
            [0; 5],
            [0; 5],
            opening,
            0,
        );
    }

    #[test(should_fail_with = "first asset input must open in the signed asset")]
    fn test_full_burn_rejects_a_different_input_amount() {
        let (tx, mut opening) = full_burn_batch();
        opening.amount += 1;
        let _ = run(
            TEST_ASSET_ID,
            [zero_declaration(); 5],
            tx,
            [0; 5],
            [0; 5],
            opening,
            0,
        );
    }

    #[test]
    fn test_accepts_the_exact_signed_relay() {
        let (outputs, tx, secrets, changes) = relay_batch();
        assert(run_relay_batch(outputs, tx, secrets, changes) == transfer_statement(tx, 0));
    }

    #[test]
    fn test_ignores_the_secret_witness_of_the_relay_slot() {
        let (outputs, tx, mut secrets, changes) = relay_batch();
        secrets[4] = 0x77;
        assert(run_relay_batch(outputs, tx, secrets, changes) == transfer_statement(tx, 0));
    }

    // The relay owner commitment is signed as quoted. Zero, or the issuance
    // owner's commitment, costs only the relayer.
    #[test]
    fn test_accepts_a_zero_relay_owner_commitment() {
        let (outputs, tx, secrets, changes) = relay_batch_to(0);
        assert(run_relay_batch_to(0, outputs, tx, secrets, changes) == transfer_statement(tx, 0));
    }

    #[test]
    fn test_accepts_the_issuance_owner_as_relay_owner() {
        let (outputs, tx, secrets, changes) = relay_batch_to(0x100);
        assert(
            run_relay_batch_to(0x100, outputs, tx, secrets, changes) == transfer_statement(tx, 0),
        );
    }

    #[test(should_fail_with = "relay output must pay the relay fee to the relay owner")]
    fn test_rejects_a_changed_relay_amount() {
        let (outputs, mut tx, secrets, changes) = relay_batch();
        tx.output_body_commitments[4] = note_body_commitment(0x200, 0, 26);
        let _ = run_relay_batch(outputs, tx, secrets, changes);
    }

    #[test(should_fail_with = "relay output must pay the relay fee to the relay owner")]
    fn test_rejects_a_changed_relay_owner() {
        let (outputs, mut tx, secrets, changes) = relay_batch();
        tx.output_body_commitments[4] = note_body_commitment(0x201, 0, 25);
        let _ = run_relay_batch(outputs, tx, secrets, changes);
    }

    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_relay_value_hidden_in_owner_change() {
        let (outputs, mut tx, secrets, changes) = relay_batch();
        tx.output_body_commitments[2] = note_body_commitment(0x200, 0, changes[2]);
        let _ = run_relay_batch(outputs, tx, secrets, changes);
    }

    // --- The installed configuration. ---
    //
    // TEST_SIGNER's account installs the rule under TEST_NK_ROOT's nullifier
    // key commitment. A builder who witnesses another root can derive owner
    // change and self-issuance secrets that pass the rule's checks under that
    // root, but the rule then opens a configuration the account did not
    // install, and the kernel rejects its statement.

    global OTHER_NK_ROOT: Field = 0xbad999;

    // native_batch with its owner change under `nk_root`'s derived secret.
    fn native_batch_with_change_under(
        nk_root: Field,
    ) -> ([OutputDeclaration; 5], TestPrivateValue, [Field; 5], [Field; 5], AssetNamespaceOpening) {
        let (outputs, mut tx, secrets, changes, opening) = native_batch();
        tx.output_body_commitments[2] =
            owner_body(owner_change_note_secret(nk_root, tx, 2), 0, changes[2]);
        (outputs, tx, secrets, changes, opening)
    }

    #[test]
    fn test_kernel_accepts_owner_change_under_the_installed_root() {
        let (outputs, tx, secrets, changes, opening) = native_batch_with_change_under(TEST_NK_ROOT);
        let statement = run(0, outputs, tx, secrets, changes, opening, 0);
        assert_transfer_kernel_accepts(statement, tx, 0);
    }

    #[test(should_fail_with = "rule statement must match the kernel's statement")]
    fn test_kernel_rejects_owner_change_under_another_root() {
        let (outputs, tx, secrets, changes, opening) =
            native_batch_with_change_under(OTHER_NK_ROOT);
        let statement = run_as(
            TEST_SIGNER,
            OTHER_NK_ROOT,
            0,
            outputs,
            tx,
            secrets,
            changes,
            opening,
            0,
        );
        assert_transfer_kernel_accepts(statement, tx, 0);
    }

    // native_batch without owner change, its issuance designated to the
    // signer under `nk_root`'s payout secret. Returns that secret.
    fn self_issuance_batch(
        nk_root: Field,
    ) -> ([OutputDeclaration; 5], TestPrivateValue, [Field; 5], Field) {
        let (outputs, mut tx, secrets, _, _) = native_batch();
        tx.output_slot_classes[2] = SLOT_CLASS_DUMMY;
        let context = transaction_context::<4, 5, 0>(TEST_PCASH_CHAIN_ID, tx.nullifiers);
        let secret = payout_note_secret(payout_seed(nk_root), ISSUANCE_ROLE, context);
        tx.issuance_owner_commitment = owner_commitment(TEST_SIGNER, secret);
        (outputs, tx, secrets, secret)
    }

    // `authorize` without its signature: the self-issuance opening, then the
    // relation, both under `nk_root`.
    fn run_self_issuance(nk_root: Field) -> (TestPrivateValue, [Field; RULE_STATEMENT_LENGTH]) {
        let (outputs, tx, secrets, secret) = self_issuance_batch(nk_root);
        assert_owner_issuance_opening(
            tx,
            transaction_context::<4, 5, 0>(TEST_PCASH_CHAIN_ID, tx.nullifiers),
            TEST_SIGNER,
            nk_root,
            TEST_SIGNER,
            secret,
        );
        let statement = run_as(
            TEST_SIGNER,
            nk_root,
            0,
            outputs,
            tx,
            secrets,
            [0; 5],
            no_namespace_opening(),
            0,
        );
        (tx, statement)
    }

    #[test]
    fn test_kernel_accepts_self_issuance_under_the_installed_root() {
        let (tx, statement) = run_self_issuance(TEST_NK_ROOT);
        assert_transfer_kernel_accepts(statement, tx, 0);
    }

    #[test(should_fail_with = "rule statement must match the kernel's statement")]
    fn test_kernel_rejects_self_issuance_under_another_root() {
        let (tx, statement) = run_self_issuance(OTHER_NK_ROOT);
        assert_transfer_kernel_accepts(statement, tx, 0);
    }

    // The installed root does not let another key act: its address names
    // another account, even with change returned to that address.
    #[test(should_fail_with = "rule statement must match the kernel's statement")]
    fn test_kernel_rejects_another_signer() {
        let (outputs, mut tx, secrets, changes, opening) = native_batch();
        tx.output_body_commitments[2] =
            directed_body(TEST_ATTACKER, owner_change_secret(2), 0, changes[2]);
        let statement = run_as(
            TEST_ATTACKER,
            TEST_NK_ROOT,
            0,
            outputs,
            tx,
            secrets,
            changes,
            opening,
            0,
        );
        assert_transfer_kernel_accepts(statement, tx, 0);
    }

    // --- Signed tests. ---

    // TEST_SIGNING_KEY's signature over the batch `run_signed_batch` proves on
    // TEST_PCASH_CHAIN_ID.
    global SIGNED_BATCH_SIGNATURE: [u8; 64] = [
        0x45, 0x92, 0x15, 0xc0, 0xef, 0xe1, 0x0b, 0xf2, 0x2c, 0x01, 0x1e, 0xf5, 0x49, 0x47, 0x8f,
        0xce, 0xd4, 0x2b, 0xc5, 0x09, 0x24, 0xfe, 0xbb, 0xca, 0xd8, 0xdc, 0x19, 0xa0, 0x4e, 0xe6,
        0x94, 0x9b, 0x56, 0x01, 0x2b, 0xe3, 0xa1, 0xd4, 0x18, 0xec, 0x4b, 0xdc, 0x02, 0xe2, 0x8b,
        0x70, 0xe9, 0x71, 0xbf, 0x4f, 0x9a, 0xed, 0x07, 0x3b, 0x15, 0x8b, 0x1f, 0xda, 0xf6, 0x2e,
        0x11, 0xb1, 0x58, 0x90,
    ];

    fn run_signed_batch(
        pcash_chain_id: Field,
        event_entry: Field,
        account_creation_commitment: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let (mut outputs, mut tx, mut secrets, _, opening) = native_batch();
        outputs[1] = zero_declaration();
        secrets[1] = 0;
        tx.output_slot_classes = [
            SLOT_CLASS_NATIVE,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
        ];
        tx.account_creation_commitment = account_creation_commitment;
        authorize::<4, 5, 0>(
            S_BATCH_TRANSFER_TYPE_HASH,
            pcash_chain_id,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature: SIGNED_BATCH_SIGNATURE },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            0,
            outputs,
            0,
            0,
            0,
            tx,
            0,
            secrets,
            [0; 5],
            opening,
            event_entry,
        )
    }

    #[test]
    fn test_batch_transfer_accepts_the_owner_signature() {
        let _ = run_signed_batch(TEST_PCASH_CHAIN_ID, 0, 0);
    }

    // The message signs the chain ID the action commitment binds, so a batch
    // signed for one chain cannot be proved on another.
    #[test(should_fail_with = "signature must be valid")]
    fn test_batch_transfer_rejects_a_signature_for_another_chain() {
        let _ = run_signed_batch(TEST_PCASH_CHAIN_ID + 1, 0, 0);
    }
    #[test(should_fail_with = "signature must be valid")]
    fn test_batch_rejects_an_unsigned_attachment() {
        let _ = run_signed_batch(TEST_PCASH_CHAIN_ID, 0, 1);
    }

}
