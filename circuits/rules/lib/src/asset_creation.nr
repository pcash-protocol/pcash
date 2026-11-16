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
use crate::message::{NativeBurn, verify_value_message};
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
    with_burn_type_hash: [u8; 32],
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
    native_burn: NativeBurn,
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
        with_burn_type_hash,
        pcash_chain_id,
        nk_root,
        [asset_id, metadata_commitment, initial_supply, asset_secret_commitment],
        outputs,
        private_value,
        issuance_recipient,
        issuance_note_secret,
        relay_fee_amount,
        relay_fee_owner_commitment,
        native_burn,
    );
    statement
}

mod tests {
    use crate::generated::reference_rule_constants::{
        S_ASSET_CREATION_TYPE_HASH, S_ASSET_CREATION_WITH_BURN_TYPE_HASH,
    };
    use crate::message::NativeBurn;
    use crate::payout::{note_secret, note_secret_seed};
    use crate::test_support::{
        asset_creation_statement, NO_NATIVE_BURN, SWAPPED_NATIVE_BURN, TEST_CONFIGURATION,
        TEST_NATIVE_BURN, TEST_NATIVE_BURN_AMOUNT, TEST_NK_ROOT, TEST_PCASH_CHAIN_ID,
        TEST_RECENT_BLOCK, TEST_RECIPIENT, TEST_SIGNER, TEST_SIGNING_KEY, TestPrivateValue,
        WRAPPING_NATIVE_BURN,
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
            native_burn_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 1000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
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
        0x8a, 0xb1, 0x3a, 0x43, 0x0b, 0x3b, 0x88, 0x2f, 0xa2, 0xd1, 0xc4, 0x3f, 0x0c, 0x70, 0x54,
        0x0b, 0xc0, 0xba, 0x3b, 0x62, 0xe3, 0x79, 0xe2, 0x4d, 0xb4, 0x75, 0xff, 0x18, 0x4c, 0x4a,
        0xb5, 0xfc, 0x74, 0x0f, 0x75, 0xdf, 0x5a, 0xd9, 0xdc, 0x22, 0xd9, 0x71, 0x32, 0xca, 0xeb,
        0xc9, 0x07, 0x0b, 0x02, 0x05, 0xe4, 0x3d, 0x72, 0x4d, 0xba, 0x53, 0x5a, 0xcc, 0xc9, 0x2b,
        0xa5, 0x97, 0x7b, 0x84,
    ];

    fn run_signed_creation(
        signature: [u8; 64],
        native_burn_amount: Field,
        native_burn: NativeBurn,
        pcash_chain_id: Field,
        event_entry: Field,
        account_creation_commitment: Field,
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
        tx.account_creation_commitment = account_creation_commitment;
        tx.native_burn_amount = native_burn_amount;
        authorize::<4, 5, 0>(
            S_ASSET_CREATION_TYPE_HASH,
            S_ASSET_CREATION_WITH_BURN_TYPE_HASH,
            pcash_chain_id,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            6,
            100,
            7,
            outputs,
            0,
            0,
            0,
            native_burn,
            tx,
            0,
            [0x5001, 0, 0, 0, 0],
            [0; 5],
            event_entry,
        )
    }

    #[test]
    fn test_creation_accepts_the_owner_signature() {
        let _ = run_signed_creation(
            SIGNED_CREATION_SIGNATURE,
            0,
            NO_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
            0,
        );
    }

    // The message signs the chain ID the action commitment binds, so a
    // creation signed for one chain cannot be proved on another.
    #[test(should_fail_with = "signature must be valid")]
    fn test_creation_rejects_a_signature_for_another_chain() {
        let _ = run_signed_creation(
            SIGNED_CREATION_SIGNATURE,
            0,
            NO_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID + 1,
            0,
            0,
        );
    }
    #[test(should_fail_with = "signature must be valid")]
    fn test_creation_rejects_an_unsigned_attachment() {
        let _ = run_signed_creation(
            SIGNED_CREATION_SIGNATURE,
            0,
            NO_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
            1,
        );
    }

    // --- Native burns. ---

    // TEST_SIGNING_KEY's signature over the WithBurn message of the creation
    // `run_signed_creation` proves, burning TEST_NATIVE_BURN.
    global SIGNED_CREATION_WITH_BURN_SIGNATURE: [u8; 64] = [
        0x1b, 0xf3, 0xee, 0xca, 0xce, 0xa0, 0x79, 0x9f, 0xd6, 0x7e, 0xc9, 0x98, 0x12, 0xb6, 0x0f,
        0x8e, 0xcc, 0xdf, 0xf6, 0x86, 0x53, 0x3f, 0x39, 0x9e, 0x9b, 0x0d, 0xa6, 0x57, 0x18, 0x83,
        0x51, 0x29, 0x37, 0x98, 0xeb, 0xae, 0x85, 0xc7, 0x22, 0xa3, 0xa2, 0x6c, 0x64, 0x93, 0x29,
        0x98, 0xdc, 0xc9, 0x66, 0x14, 0x01, 0x43, 0x4b, 0xf4, 0x86, 0xaa, 0x11, 0x08, 0x03, 0xf3,
        0xac, 0x9a, 0xb7, 0x2f,
    ];

    #[test]
    fn test_creation_accepts_a_signed_burn() {
        let _ = run_signed_creation(
            SIGNED_CREATION_WITH_BURN_SIGNATURE,
            TEST_NATIVE_BURN_AMOUNT,
            TEST_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
            0,
        );
    }

    // The base message names no burn, so it approves none.
    #[test(should_fail_with = "signature must be valid")]
    fn test_creation_rejects_a_burn_under_the_message_without_one() {
        let _ = run_signed_creation(
            SIGNED_CREATION_SIGNATURE,
            TEST_NATIVE_BURN_AMOUNT,
            TEST_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
            0,
        );
    }

    #[test(should_fail_with = "native burn must equal the signed network fee plus voluntary burn")]
    fn test_creation_rejects_a_burn_other_than_the_signed_one() {
        let _ = run_signed_creation(
            SIGNED_CREATION_WITH_BURN_SIGNATURE,
            TEST_NATIVE_BURN_AMOUNT + 1,
            TEST_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
            0,
        );
    }

    #[test(should_fail_with = "call to assert_max_bit_size")]
    fn test_creation_rejects_a_split_that_wraps_the_field() {
        let _ = run_signed_creation(
            SIGNED_CREATION_WITH_BURN_SIGNATURE,
            TEST_NATIVE_BURN_AMOUNT,
            WRAPPING_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
            0,
        );
    }

    #[test(should_fail_with = "signature must be valid")]
    fn test_creation_rejects_a_split_other_than_the_signed_one() {
        let _ = run_signed_creation(
            SIGNED_CREATION_WITH_BURN_SIGNATURE,
            TEST_NATIVE_BURN_AMOUNT,
            SWAPPED_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
            0,
        );
    }
}
