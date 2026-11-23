// Readable mint authorized by the registered owner.
//
// The signer approves the asset ID, every directed output, the fee, the
// transaction context and the validity window. Every asset output is a signed
// declaration, so the signer approves each minted unit; an undirected native
// output is owner change. The transaction context binds every nullifier, mint
// markers included, so an approval cannot be proved under another replay ID.
// The rule returns the mint action for the signed asset ID, which only the mint
// kernel accepts, and only for the asset it derives from the definition it
// opens. The asset's mint rule decides what may be minted, so this one rule
// approves a mint under any of them.

use crate::configuration::Configuration;
use crate::message::{NativeBurn, verify_value_message};
use crate::owner::open_owner;
use crate::value_rule::{assert_output_declarations, assert_relay_terms, OutputDeclaration};
use pcash_protocol::authorization::statement::{
    mint_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, PrivateValue, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
};
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

pub fn mint_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
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
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    let owner = open_owner(signer_address, nk_root, configuration);
    // The mint kernel also admits the account's application markers, which
    // this message cannot describe.
    for i in 0..N_IN {
        assert(
            private_value.input_slot_classes[i] != SLOT_CLASS_APPLICATION,
            "mint input must not be an application marker",
        );
    }
    // The asset's mint rule may set no supply bound, so asset owner change
    // could carry any amount. Native conservation bounds native owner change.
    for i in 0..N_OUT {
        assert(
            (private_value.output_slot_classes[i] != SLOT_CLASS_ASSET)
                | (outputs[i].recipient != 0),
            "mint asset output must be a signed declaration",
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
    rule_statement(
        owner.authorization_commitment,
        mint_action_commitment(
            pcash_chain_id,
            private_value_commitment(private_value),
            asset_id,
        ),
        recent_pcash_block_hash,
        event_entry,
    )
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
    asset_id: Field,
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
    let statement = mint_relation(
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
        [asset_id],
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
    use crate::generated::reference_rule_constants::{S_MINT_TYPE_HASH, S_MINT_WITH_BURN_TYPE_HASH};
    use crate::message::NativeBurn;
    use crate::payout::{note_secret, note_secret_seed};
    use crate::test_support::{
        mint_statement, NO_NATIVE_BURN, SWAPPED_NATIVE_BURN, TEST_ASSET_ID, TEST_CONFIGURATION,
        TEST_NATIVE_BURN, TEST_NATIVE_BURN_AMOUNT, TEST_NK_ROOT, TEST_PCASH_CHAIN_ID,
        TEST_RECENT_BLOCK, TEST_RECIPIENT, TEST_SIGNER, TEST_SIGNING_KEY, TestPrivateValue,
        WRAPPING_NATIVE_BURN,
    };
    use crate::value_rule::OutputDeclaration;
    use super::{authorize, mint_relation};
    use pcash_protocol::authorization::statement::RULE_STATEMENT_LENGTH;
    use pcash_protocol::ledger::asset::{
        asset_core_commitment, asset_id as asset_id_of, mint_marker, mint_rule_commitment,
    };
    use pcash_protocol::ledger::note::{note_body_commitment, note_nk, owner_commitment};
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY, SLOT_CLASS_MINT,
        SLOT_CLASS_NATIVE,
    };
    use signature_common::secp256k1::Signature;

    global ASSET_SECRET: Field = 7;
    global MINTED: Field = 250;

    // An asset whose mint rule takes one mint marker keyed by ASSET_SECRET.
    fn fixed_asset() -> Field {
        asset_id_of(
            asset_core_commitment(5, 6, mint_rule_commitment(1, 2, 3)),
            0,
        )
    }

    // An asset whose mint rule takes any number of markers.
    fn account_mint_asset() -> Field {
        asset_id_of(
            asset_core_commitment(5, 6, mint_rule_commitment(1, 2, 4)),
            0,
        )
    }

    fn undeclared() -> [OutputDeclaration; 5] {
        [OutputDeclaration { recipient: 0, amount: 0, asset_id: 0 }; 5]
    }

    // Output 0 is an asset output; the others are dummies.
    fn mint_transaction(
        input_slot_classes: [Field; 4],
        nullifiers: [Field; 4],
        output_body: Field,
    ) -> TestPrivateValue {
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
            input_commitments: [0, 0, 0x72, 0],
            nullifiers,
            output_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [output_body, 1, 2, 3, 4],
        }
    }

    // The fixed supply's one mint, all of it to TEST_SIGNER under `body`.
    fn fixed_mint(body: Field) -> TestPrivateValue {
        mint_transaction(
            [SLOT_CLASS_MINT, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY, SLOT_CLASS_DUMMY],
            [mint_marker(fixed_asset(), ASSET_SECRET), 11, 12, 13],
            body,
        )
    }

    // Two mints of `asset` under replay IDs 0x51 and `second_replay_id`, funded
    // by a native note, paying MINTED to TEST_RECIPIENT.
    fn several_marker_mint(
        asset: Field,
        second_replay_id: Field,
    ) -> (TestPrivateValue, [OutputDeclaration; 5]) {
        let tx = mint_transaction(
            [SLOT_CLASS_MINT, SLOT_CLASS_MINT, SLOT_CLASS_NATIVE, SLOT_CLASS_DUMMY],
            [mint_marker(asset, 0x51), mint_marker(asset, second_replay_id), 12, 13],
            note_body_commitment(owner_commitment(TEST_RECIPIENT, 0x5001), asset, MINTED),
        );
        let mut outputs = undeclared();
        outputs[0] =
            OutputDeclaration { recipient: TEST_RECIPIENT, amount: MINTED, asset_id: asset };
        (tx, outputs)
    }

    // TEST_SIGNER's implicit secret for owner change in `slot` of `tx`.
    fn change_secret(tx: TestPrivateValue, slot: Field) -> Field {
        note_secret::<4, 5, 0>(
            note_secret_seed(note_nk(TEST_NK_ROOT)),
            tx.nullifiers,
            slot,
            0,
        )
    }

    fn run_relation(
        asset: Field,
        outputs: [OutputDeclaration; 5],
        tx: TestPrivateValue,
        output_note_secrets: [Field; 5],
        owner_change_amounts: [Field; 5],
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        mint_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            TEST_SIGNER,
            TEST_NK_ROOT,
            asset,
            outputs,
            0,
            0,
            tx,
            output_note_secrets,
            owner_change_amounts,
            0,
        )
    }

    // A creator that keeps the whole supply declares its own address.
    #[test]
    fn test_fixed_supply_mint_to_the_signer_returns_the_owner_statement() {
        let tx = fixed_mint(note_body_commitment(
            owner_commitment(TEST_SIGNER, 0x5002),
            fixed_asset(),
            100,
        ));
        let mut outputs = undeclared();
        outputs[0] =
            OutputDeclaration { recipient: TEST_SIGNER, amount: 100, asset_id: fixed_asset() };
        assert(
            run_relation(fixed_asset(), outputs, tx, [0x5002, 0, 0, 0, 0], [0; 5])
                == mint_statement(tx, fixed_asset(), 0),
        );
    }

    // Owner change would mint an amount the message does not show.
    #[test(should_fail_with = "mint asset output must be a signed declaration")]
    fn test_rejects_asset_owner_change() {
        let mut tx = fixed_mint(0);
        tx.output_body_commitments[0] = note_body_commitment(
            owner_commitment(TEST_SIGNER, change_secret(tx, 0)),
            fixed_asset(),
            100,
        );
        let _ = run_relation(fixed_asset(), undeclared(), tx, [0; 5], [100, 0, 0, 0, 0]);
    }

    #[test]
    fn test_mint_under_any_rule_with_several_markers_returns_the_owner_statement() {
        let (tx, outputs) = several_marker_mint(account_mint_asset(), 0x52);
        assert(
            run_relation(
                account_mint_asset(),
                outputs,
                tx,
                [0x5001, 0, 0, 0, 0],
                [0; 5],
            )
                == mint_statement(tx, account_mint_asset(), 0),
        );
    }

    #[test]
    fn test_mint_under_any_rule_returns_native_change_to_the_owner() {
        let (mut tx, outputs) = several_marker_mint(account_mint_asset(), 0x52);
        tx.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[1] =
            note_body_commitment(owner_commitment(TEST_SIGNER, change_secret(tx, 1)), 0, 40);
        assert(
            run_relation(
                account_mint_asset(),
                outputs,
                tx,
                [0x5001, 0, 0, 0, 0],
                [0, 40, 0, 0, 0],
            )
                == mint_statement(tx, account_mint_asset(), 0),
        );
    }

    #[test(should_fail_with = "declared output asset ID must equal the signed asset ID")]
    fn test_rejects_another_signed_asset() {
        let (tx, outputs) = several_marker_mint(account_mint_asset(), 0x52);
        let _ = run_relation(fixed_asset(), outputs, tx, [0x5001, 0, 0, 0, 0], [0; 5]);
    }

    // The mint kernel admits application markers for custom rules; this
    // readable rule cannot describe one.
    #[test(should_fail_with = "mint input must not be an application marker")]
    fn test_rejects_an_application_marker() {
        let (mut tx, outputs) = several_marker_mint(account_mint_asset(), 0x52);
        tx.input_slot_classes[3] = SLOT_CLASS_APPLICATION;
        let _ = run_relation(
            account_mint_asset(),
            outputs,
            tx,
            [0x5001, 0, 0, 0, 0],
            [0; 5],
        );
    }

    // --- Signed tests. ---

    // TEST_SIGNING_KEY's signature over the mint `run_signed_mint` proves on
    // TEST_PCASH_CHAIN_ID with second replay ID 0x52.
    global SIGNED_MINT_SIGNATURE: [u8; 64] = [
        0xd7, 0x75, 0x14, 0xb7, 0xca, 0x6a, 0x3c, 0x66, 0xd3, 0x7f, 0x2d, 0x56, 0xae, 0x85, 0x6e,
        0x57, 0x4c, 0xe3, 0x5b, 0x73, 0x33, 0xd8, 0x03, 0x78, 0x9e, 0x1c, 0xd4, 0x52, 0xdd, 0x72,
        0xee, 0xf9, 0x5d, 0x48, 0xb4, 0xcb, 0x03, 0x2b, 0xc4, 0x5b, 0x71, 0xc5, 0x4a, 0x0e, 0x3b,
        0x2f, 0xdc, 0xb5, 0x8b, 0x63, 0xec, 0x82, 0x33, 0x61, 0x27, 0x0b, 0xcb, 0x99, 0x2c, 0x1b,
        0xbe, 0x8c, 0x43, 0x7b,
    ];

    // Two mints of TEST_ASSET_ID under replay IDs 0x51 and `second_replay_id`.
    fn run_signed_mint(
        signature: [u8; 64],
        second_replay_id: Field,
        native_burn_amount: Field,
        native_burn: NativeBurn,
        pcash_chain_id: Field,
        account_creation_commitment: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let (mut tx, outputs) = several_marker_mint(TEST_ASSET_ID, second_replay_id);
        tx.account_creation_commitment = account_creation_commitment;
        tx.native_burn_amount = native_burn_amount;
        authorize::<4, 5, 0>(
            S_MINT_TYPE_HASH,
            S_MINT_WITH_BURN_TYPE_HASH,
            pcash_chain_id,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            TEST_ASSET_ID,
            outputs,
            0,
            0,
            0,
            native_burn,
            tx,
            0,
            [0x5001, 0, 0, 0, 0],
            [0; 5],
            0,
        )
    }

    #[test]
    fn test_mint_accepts_the_owner_signature() {
        let _ = run_signed_mint(
            SIGNED_MINT_SIGNATURE,
            0x52,
            0,
            NO_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
        );
    }

    // The signed transaction context binds every mint marker, so an approval
    // cannot be proved under another replay ID.
    #[test(should_fail_with = "signature must be valid")]
    fn test_mint_rejects_another_replay_id() {
        let _ = run_signed_mint(
            SIGNED_MINT_SIGNATURE,
            0x53,
            0,
            NO_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
        );
    }

    // The message signs the chain ID the action commitment binds, so a mint
    // signed for one chain cannot be proved on another.
    #[test(should_fail_with = "signature must be valid")]
    fn test_mint_rejects_a_signature_for_another_chain() {
        let _ = run_signed_mint(
            SIGNED_MINT_SIGNATURE,
            0x52,
            0,
            NO_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID + 1,
            0,
        );
    }

    #[test(should_fail_with = "signature must be valid")]
    fn test_mint_rejects_an_unsigned_attachment() {
        let _ = run_signed_mint(
            SIGNED_MINT_SIGNATURE,
            0x52,
            0,
            NO_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            1,
        );
    }

    // --- Native burns. ---

    // TEST_SIGNING_KEY's signature over the WithBurn message of the mint
    // `run_signed_mint` proves, burning TEST_NATIVE_BURN.
    global SIGNED_MINT_WITH_BURN_SIGNATURE: [u8; 64] = [
        0xc2, 0x0f, 0xb8, 0xfb, 0x2c, 0xf3, 0x14, 0xc0, 0xb7, 0x25, 0x75, 0x47, 0xe1, 0x7c, 0xe4,
        0x49, 0xd5, 0xff, 0x28, 0xc6, 0xee, 0x5e, 0x1e, 0x51, 0x3e, 0x36, 0xf2, 0x2f, 0xb7, 0xe5,
        0x49, 0x2b, 0x7e, 0x37, 0xf8, 0x11, 0x6f, 0x2b, 0xfd, 0x76, 0x47, 0xac, 0x47, 0xa1, 0x11,
        0x56, 0x3a, 0xc0, 0x03, 0x3e, 0x4c, 0xc6, 0xc8, 0x1a, 0xaf, 0xf8, 0x05, 0x91, 0xa8, 0x15,
        0x37, 0xcf, 0xe8, 0x92,
    ];

    #[test]
    fn test_mint_accepts_a_signed_burn() {
        let _ = run_signed_mint(
            SIGNED_MINT_WITH_BURN_SIGNATURE,
            0x52,
            TEST_NATIVE_BURN_AMOUNT,
            TEST_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
        );
    }

    // The base message names no burn, so it approves none.
    #[test(should_fail_with = "signature must be valid")]
    fn test_mint_rejects_a_burn_under_the_message_without_one() {
        let _ = run_signed_mint(
            SIGNED_MINT_SIGNATURE,
            0x52,
            TEST_NATIVE_BURN_AMOUNT,
            TEST_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
        );
    }

    #[test(should_fail_with = "native burn must equal the signed network fee plus voluntary burn")]
    fn test_mint_rejects_a_burn_other_than_the_signed_one() {
        let _ = run_signed_mint(
            SIGNED_MINT_WITH_BURN_SIGNATURE,
            0x52,
            TEST_NATIVE_BURN_AMOUNT + 1,
            TEST_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
        );
    }

    #[test(should_fail_with = "call to assert_max_bit_size")]
    fn test_mint_rejects_a_split_that_wraps_the_field() {
        let _ = run_signed_mint(
            SIGNED_MINT_WITH_BURN_SIGNATURE,
            0x52,
            TEST_NATIVE_BURN_AMOUNT,
            WRAPPING_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
        );
    }

    #[test(should_fail_with = "signature must be valid")]
    fn test_mint_rejects_a_split_other_than_the_signed_one() {
        let _ = run_signed_mint(
            SIGNED_MINT_WITH_BURN_SIGNATURE,
            0x52,
            TEST_NATIVE_BURN_AMOUNT,
            SWAPPED_NATIVE_BURN,
            TEST_PCASH_CHAIN_ID,
            0,
        );
    }
}
