// Readable one-shot asset creation authorized by the registered owner.
//
// The signer approves the asset's identity (metadata, initial supply and
// asset secret commitment) and the asset ID they derive, every directed
// output, the fee, the transaction context and the validity window. Every
// undirected real output is owner change. The rule returns the asset-creation
// action for that asset ID, which only the asset-creation kernel accepts, and
// only for the asset it derives; that kernel also binds the single creation
// marker to the asset ID.

use crate::configuration::Configuration;
use crate::message::verify_value_message;
use crate::owner::open_owner;
use crate::value_rule::{assert_output_declarations, assert_relay_terms, OutputDeclaration};
use pcash_protocol::authorization::statement::{
    asset_creation_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::ledger::asset::standard_fungible_asset_id;
use pcash_protocol::ledger::private_value::{
    private_value_commitment, PrivateValue, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY,
    SLOT_CLASS_NATIVE,
};
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

// Returns the rule statement and the asset ID the signed asset fields derive.
pub fn asset_creation_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signer_address: Field,
    nk_root: Field,
    metadata_commitment: Field,
    initial_supply: Field,
    asset_secret_commitment: Field,
    outputs: [OutputDeclaration; N_OUT],
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    output_note_secrets: [Field; N_OUT],
    owner_change_amounts: [Field; N_OUT],
    event_entry: Field,
) -> ([Field; RULE_STATEMENT_LENGTH], Field) {
    let owner = open_owner(signer_address, nk_root, configuration);
    let asset_id =
        standard_fungible_asset_id(metadata_commitment, initial_supply, asset_secret_commitment);
    // The asset-creation kernel requires the one creation marker and binds it
    // to the asset ID; it also admits application markers, which this message
    // cannot describe. Every ASSET output body is bound to this rule's asset ID.
    for i in 0..N_IN {
        let class = private_value.input_slot_classes[i];
        assert(
            (class == SLOT_CLASS_NATIVE)
                | (class == SLOT_CLASS_DUMMY)
                | (class == SLOT_CLASS_ASSET_CREATION),
            "creation input must be native, dummy or the creation marker",
        );
    }
    assert_relay_terms(private_value, relay_fee_amount, relay_fee_owner_commitment);
    let _ = assert_output_declarations(
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
    let statement = rule_statement(
        owner.authorization_commitment,
        asset_creation_action_commitment(
            pcash_chain_id,
            private_value_commitment(private_value),
            asset_id,
        ),
        recent_pcash_block_hash,
        event_entry,
    );
    (statement, asset_id)
}

pub fn authorize<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    type_hash: [u8; 32],
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signature: Signature,
    pubkey: Secp256k1PubKey,
    nk_root: Field,
    metadata_commitment: Field,
    initial_supply: Field,
    asset_secret_commitment: Field,
    outputs: [OutputDeclaration; N_OUT],
    issuance_recipient: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    issuance_note_secret: Field,
    output_note_secrets: [Field; N_OUT],
    owner_change_amounts: [Field; N_OUT],
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    let signer_address = pubkey.ethereum_address();
    let (statement, asset_id) = asset_creation_relation(
        pcash_chain_id,
        recent_pcash_block_hash,
        configuration,
        signer_address,
        nk_root,
        metadata_commitment,
        initial_supply,
        asset_secret_commitment,
        outputs,
        relay_fee_amount,
        relay_fee_owner_commitment,
        private_value,
        output_note_secrets,
        owner_change_amounts,
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
        [asset_id, metadata_commitment, initial_supply, asset_secret_commitment],
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
    use crate::generated::reference_rule_constants::S_ASSET_CREATION_TYPE_HASH;
    use crate::payout::{note_secret, note_secret_seed};
    use crate::test_support::{
        asset_creation_statement, TEST_CONFIGURATION, TEST_NK_ROOT, TEST_PCASH_CHAIN_ID,
        TEST_RECENT_BLOCK, TEST_RECIPIENT, TEST_SIGNER, TEST_SIGNING_KEY, TestPrivateValue,
    };
    use crate::value_rule::OutputDeclaration;
    use super::{asset_creation_relation, authorize};
    use pcash_protocol::authorization::statement::RULE_STATEMENT_LENGTH;
    use pcash_protocol::ledger::asset::{asset_creation_marker, standard_fungible_asset_id};
    use pcash_protocol::ledger::note::{note_body_commitment, note_nk, owner_commitment};
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY,
    };
    use signature_common::secp256k1::Signature;

    fn creation_transaction(input_slot_classes: [Field; 4]) -> TestPrivateValue {
        let asset_id = standard_fungible_asset_id(6, 100, 7);
        let nullifiers = [asset_creation_marker(asset_id, 8), 11, 12, 13];
        let secret =
            note_secret::<4, 5, 0>(note_secret_seed(note_nk(TEST_NK_ROOT)), nullifiers, 0, 0);
        TestPrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 1000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            input_slot_classes,
            input_commitments: [0; 4],
            nullifiers,
            output_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [
                note_body_commitment(owner_commitment(TEST_SIGNER, secret), asset_id, 100),
                1,
                2,
                3,
                4,
            ],
        }
    }

    fn run_creation_with_classes(
        metadata: Field,
        input_slot_classes: [Field; 4],
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let (statement, _) = asset_creation_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            TEST_SIGNER,
            TEST_NK_ROOT,
            metadata,
            100,
            7,
            [OutputDeclaration { recipient: 0, amount: 0, asset_id: 0 }; 5],
            0,
            0,
            creation_transaction(input_slot_classes),
            [0; 5],
            [100, 0, 0, 0, 0],
            event_entry,
        );
        statement
    }

    fn run_creation(metadata: Field, event_entry: Field) -> [Field; RULE_STATEMENT_LENGTH] {
        run_creation_with_classes(
            metadata,
            [SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY],
            event_entry,
        )
    }

    #[test]
    fn test_zero_native_input_creation_returns_the_owner_statement() {
        let tx = creation_transaction([
            SLOT_CLASS_ASSET_CREATION,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
        ]);
        assert(
            run_creation(6, 0)
                == asset_creation_statement(tx, standard_fungible_asset_id(6, 100, 7), 0),
        );
    }

    // Other metadata derives another asset ID, which the asset change body does
    // not carry.
    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_substituted_asset_metadata() {
        let _ = run_creation(9, 0);
    }

    // The asset-creation kernel admits application markers for custom rules;
    // this readable rule cannot describe one.
    #[test(should_fail_with = "creation input must be native, dummy or the creation marker")]
    fn test_rejects_an_application_marker() {
        let _ = run_creation_with_classes(
            6,
            [SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_APPLICATION, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY],
            0,
        );
    }

    // --- Signed tests. ---

    // TEST_SIGNING_KEY's signature over the creation `run_signed_creation`
    // proves on TEST_PCASH_CHAIN_ID.
    global SIGNED_CREATION_SIGNATURE: [u8; 64] = [
        0x81, 0x87, 0xf7, 0x5f, 0xcc, 0x27, 0xad, 0xfa, 0x1a, 0x60, 0x76, 0x52, 0xbc, 0x41, 0xae,
        0xab, 0x12, 0x8e, 0x71, 0x53, 0xf2, 0x79, 0x46, 0x95, 0x7b, 0x07, 0xdf, 0x56, 0x4f, 0x67,
        0x2b, 0xe4, 0x70, 0x4b, 0x43, 0xcd, 0x83, 0x3c, 0x99, 0x0a, 0xc7, 0x4d, 0xfb, 0xe5, 0x24,
        0x05, 0x99, 0xfc, 0xfe, 0x75, 0x7f, 0x76, 0xa1, 0x21, 0x8f, 0xb7, 0x5c, 0x14, 0x04, 0x4e,
        0x2a, 0x46, 0x8f, 0x62,
    ];

    fn run_signed_creation(
        pcash_chain_id: Field,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let asset_id = standard_fungible_asset_id(6, 100, 7);
        let mut tx = creation_transaction([
            SLOT_CLASS_ASSET_CREATION,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
            SLOT_CLASS_DUMMY,
        ]);
        tx.output_body_commitments[0] =
            note_body_commitment(owner_commitment(TEST_RECIPIENT, 0x5001), asset_id, 100);
        let mut outputs = [OutputDeclaration { recipient: 0, amount: 0, asset_id: 0 }; 5];
        outputs[0] = OutputDeclaration { recipient: TEST_RECIPIENT, amount: 100, asset_id };
        authorize::<4, 5, 0>(
            S_ASSET_CREATION_TYPE_HASH,
            pcash_chain_id,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature: SIGNED_CREATION_SIGNATURE },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            6,
            100,
            7,
            outputs,
            0,
            0,
            0,
            tx,
            0,
            [0x5001, 0, 0, 0, 0],
            [0; 5],
            event_entry,
        )
    }

    #[test]
    fn test_creation_accepts_the_owner_signature() {
        let _ = run_signed_creation(TEST_PCASH_CHAIN_ID, 0);
    }

    // The message signs the chain ID the action commitment binds, so a
    // creation signed for one chain cannot be proved on another.
    #[test(should_fail_with = "signature must be valid")]
    fn test_creation_rejects_a_signature_for_another_chain() {
        let _ = run_signed_creation(TEST_PCASH_CHAIN_ID + 1, 0);
    }
}
