// Readable full-transaction rule for the reference user account. It opens
// every real output and every asset input in the account's exact contribution.
// It serves the transfer and asset-creation kernels and returns the action of
// whichever one the opened private value selects. An asset creation's action
// names the created asset, which the kernel requires to be the asset it
// derives and in whose namespace the declared asset outputs are.
//
// This demonstration's signed schema explicitly names four inputs/five outputs.
// It is a fixed-shape fixture, not a profile-generic wallet rule.

use pcash_protocol::authorization::statement::{
    owner_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::ledger::note::{note_body_commitment, output_commitment, owner_commitment};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_NATIVE,
};
use pcash_protocol::primitives::range::{assert_address, assert_amount, assert_asset_aggregate};
use reference_rule_common::configuration::Configuration;
use reference_rule_common::issuance_opening::assert_issuance_opening;
use reference_rule_common::owner::open_owner;
use reference_rule_common::payout::transaction_context;
use reference_rule_common::value_rule::OutputDeclaration;
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

type PrivateValue = pcash_protocol::ledger::private_value::PrivateValue<4, 5, 0>;

// keccak256 of the SDK TRANSACTION_DETAIL_EIP712_TYPE, written by scripts/circuits/gen_reference_message_types.mjs.
global TRANSACTION_DETAIL_TYPE_HASH: [u8; 32] = [
    0xeb, 0x82, 0x4e, 0x22, 0x69, 0x3e, 0x33, 0xe2, 0xd0, 0x1c, 0xbb, 0xf5, 0xa3, 0x1d, 0x27, 0xf7,
    0x91, 0xc3, 0xc2, 0x62, 0xff, 0x84, 0x63, 0x8e, 0x5f, 0x10, 0xae, 0x0c, 0x05, 0xcc, 0x92, 0xe7,
];

pub struct AssetSpendOpening {
    pub note_secret: Field,
    pub amount: Field,
    pub output_index: Field,
}

// The authorizing account is the signer: asset inputs open under its address.
pub fn transaction_detail_relation(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signer_address: Field,
    nk_root: Field,
    spent_asset_id: Field,
    spent_asset_amount: Field,
    created_asset_id: Field,
    outputs: [OutputDeclaration; 5],
    private_value: PrivateValue,
    output_note_secrets: [Field; 5],
    asset_spends: [AssetSpendOpening; 4],
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    let owner = open_owner(signer_address, nk_root, configuration);

    for i in 0..5 {
        let declaration = outputs[i];
        let slot_class = private_value.output_slot_classes[i];
        if declaration.recipient == 0 {
            assert(declaration.amount == 0, "undeclared slot must be all-zero");
            assert(declaration.asset_id == 0, "undeclared slot must be all-zero");
            assert(
                (slot_class != SLOT_CLASS_NATIVE) & (slot_class != SLOT_CLASS_ASSET),
                "real output slot must be declared",
            );
        } else {
            // The slot is real, and the kernel rejects a zero real-output amount.
            assert_address(declaration.recipient);
            if declaration.asset_id == 0 {
                assert_amount(declaration.amount);
                assert(
                    slot_class == SLOT_CLASS_NATIVE,
                    "declared native output must use a native slot",
                );
            } else {
                assert_amount(declaration.amount);
                assert(
                    slot_class == SLOT_CLASS_ASSET,
                    "declared asset output must use an asset slot",
                );
            }
            assert(
                private_value.output_body_commitments[i]
                    == note_body_commitment(
                        owner_commitment(declaration.recipient, output_note_secrets[i]),
                        declaration.asset_id,
                        declaration.amount,
                    ),
                "declared output must match its declaration",
            );
        }
    }

    let mut declared_spend_total = 0;
    for i in 0..4 {
        let opening = asset_spends[i];
        let slot_class = private_value.input_slot_classes[i];
        // A durable application marker is a state effect this rule cannot
        // display, so it must never be authorized by falling through the else.
        assert(
            slot_class != SLOT_CLASS_APPLICATION,
            "input slot must not be an application marker",
        );
        let is_asset = slot_class == SLOT_CLASS_ASSET;
        // The kernel opens an ASSET input under its nonzero asset ID and a
        // nonzero amount, and the commitment below binds both.
        if is_asset {
            assert_amount(opening.amount);
            let body = note_body_commitment(
                owner_commitment(signer_address, opening.note_secret),
                spent_asset_id,
                opening.amount,
            );
            assert(
                private_value.input_commitments[i] == output_commitment(body, opening.output_index),
                "asset input must open the declared spend",
            );
            declared_spend_total += opening.amount;
        }
    }
    assert_asset_aggregate(spent_asset_amount);
    assert(
        declared_spend_total == spent_asset_amount,
        "declared spends must total the spent asset amount",
    );
    if spent_asset_amount == 0 {
        assert(spent_asset_id == 0, "spent asset ID must be zero without a spend");
    }

    rule_statement(
        owner.authorization_commitment,
        owner_action_commitment(pcash_chain_id, private_value, created_asset_id),
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
    spent_asset_id: Field,
    spent_asset_amount: Field,
    created_asset_id: Field,
    outputs: [OutputDeclaration; 5],
    private_value: PrivateValue,
    issuance_recipient: Field,
    issuance_note_secret: Field,
    output_note_secrets: [Field; 5],
    asset_spends: [AssetSpendOpening; 4],
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    assert_issuance_opening(private_value, issuance_recipient, issuance_note_secret);

    let signer_address = pubkey.ethereum_address();
    let statement = transaction_detail_relation(
        pcash_chain_id,
        recent_pcash_block_hash,
        configuration,
        signer_address,
        nk_root,
        spent_asset_id,
        spent_asset_amount,
        created_asset_id,
        outputs,
        private_value,
        output_note_secrets,
        asset_spends,
        event_entry,
    );
    // The fields of TRANSACTION_DETAIL_EIP712_TYPE, in its order.
    signature.verify(
        configuration.signing_hash(
            TRANSACTION_DETAIL_TYPE_HASH,
            [
                pcash_chain_id,
                signer_address,
                spent_asset_id,
                spent_asset_amount,
                private_value.asset_burn_amount,
                outputs[0].recipient,
                outputs[0].amount,
                outputs[0].asset_id,
                outputs[1].recipient,
                outputs[1].amount,
                outputs[1].asset_id,
                outputs[2].recipient,
                outputs[2].amount,
                outputs[2].asset_id,
                outputs[3].recipient,
                outputs[3].amount,
                outputs[3].asset_id,
                outputs[4].recipient,
                outputs[4].amount,
                outputs[4].asset_id,
                private_value.open_fee_amount,
                issuance_recipient,
                private_value.issuance_owner_commitment,
                private_value.account_creation_commitment,
                transaction_context::<4, 5, 0>(pcash_chain_id, private_value.nullifiers),
                private_value.not_before_timestamp,
                private_value.valid_until_timestamp,
                private_value_commitment(private_value),
            ],
        ),
        pubkey,
    );
    statement
}

// The signature-free relation tests pin the readable boundary: every real
// output is reconstructed from the displayed recipient and a private note
// secret, while every asset input is opened for the one authorizing account.
mod tests {
    use super::{AssetSpendOpening, main, transaction_detail_relation};
    use pcash_protocol::authorization::statement::RULE_STATEMENT_LENGTH;
    use pcash_protocol::ledger::note::{note_body_commitment, output_commitment, owner_commitment};
    use pcash_protocol::ledger::private_value::{
        SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_ASSET_CREATION, SLOT_CLASS_DUMMY,
        SLOT_CLASS_NATIVE,
    };
    use reference_rule_common::test_support::{
        asset_creation_statement, TEST_ASSET_ID, TEST_CONFIGURATION, TEST_NK_ROOT, TEST_NULLIFIERS,
        TEST_PCASH_CHAIN_ID, TEST_RECENT_BLOCK, TEST_RECIPIENT, TEST_SIGNER, TEST_SIGNING_KEY,
        TestPrivateValue, transfer_statement,
    };
    use reference_rule_common::value_rule::OutputDeclaration;
    use signature_common::secp256k1::Signature;

    fn undeclared() -> OutputDeclaration {
        OutputDeclaration { recipient: 0, amount: 0, asset_id: 0 }
    }

    fn no_spend() -> AssetSpendOpening {
        AssetSpendOpening { note_secret: 0, amount: 0, output_index: 0 }
    }

    fn base_case() -> (TestPrivateValue, [OutputDeclaration; 5], [Field; 5]) {
        let secret0 = 0x5001;
        let body0 = note_body_commitment(owner_commitment(TEST_RECIPIENT, secret0), 0, 1000);
        let tx = TestPrivateValue {
            open_fee_amount: 5,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0x61,
            account_creation_commitment: 0,
            input_slot_classes: [SLOT_CLASS_NATIVE, 0, 0, 0],
            input_commitments: [0x71, 0, 0, 0],
            nullifiers: [0x81, 0x82, 0x83, 0x84],
            output_slot_classes: [SLOT_CLASS_NATIVE, 0, 0, 0, 0],
            output_body_commitments: [body0, 0x91, 0x92, 0x93, 0x94],
        };
        let outputs = [
            OutputDeclaration { recipient: TEST_RECIPIENT, amount: 1000, asset_id: 0 },
            undeclared(),
            undeclared(),
            undeclared(),
            undeclared(),
        ];
        (tx, outputs, [secret0, 0, 0, 0, 0])
    }

    fn run_relation(
        tx: TestPrivateValue,
        outputs: [OutputDeclaration; 5],
        secrets: [Field; 5],
        spent_asset_id: Field,
        spent_asset_amount: Field,
        spends: [AssetSpendOpening; 4],
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        run_relation_creating(
            tx,
            outputs,
            secrets,
            spent_asset_id,
            spent_asset_amount,
            0,
            spends,
            event_entry,
        )
    }

    fn run_relation_creating(
        tx: TestPrivateValue,
        outputs: [OutputDeclaration; 5],
        secrets: [Field; 5],
        spent_asset_id: Field,
        spent_asset_amount: Field,
        created_asset_id: Field,
        spends: [AssetSpendOpening; 4],
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        transaction_detail_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            TEST_SIGNER,
            TEST_NK_ROOT,
            spent_asset_id,
            spent_asset_amount,
            created_asset_id,
            outputs,
            tx,
            secrets,
            spends,
            event_entry,
        )
    }

    #[test]
    fn test_detail_relation_accepts_readable_native_flow() {
        let (tx, outputs, secrets) = base_case();
        let statement = run_relation(
            tx,
            outputs,
            secrets,
            0,
            0,
            [no_spend(), no_spend(), no_spend(), no_spend()],
            0,
        );
        assert(statement == transfer_statement(tx, 0));
    }

    // An undeclared slot and an absent spend open nothing, so their witnesses
    // are unread.
    #[test]
    fn test_detail_relation_ignores_unread_openings() {
        let (tx, outputs, mut secrets) = base_case();
        secrets[2] = 0x77;
        let stray = AssetSpendOpening { note_secret: 1, amount: 2, output_index: 3 };
        let statement = run_relation(
            tx,
            outputs,
            secrets,
            0,
            0,
            [no_spend(), no_spend(), stray, no_spend()],
            0,
        );
        assert(statement == transfer_statement(tx, 0));
    }

    #[test(should_fail_with = "real output slot must be declared")]
    fn test_detail_relation_rejects_undeclared_real_output() {
        let (mut tx, outputs, secrets) = base_case();
        tx.output_slot_classes[1] = SLOT_CLASS_ASSET;
        let _ = run_relation(
            tx,
            outputs,
            secrets,
            0,
            0,
            [no_spend(), no_spend(), no_spend(), no_spend()],
            0,
        );
    }

    #[test(should_fail_with = "declared output must match its declaration")]
    fn test_detail_relation_rejects_recipient_substitution() {
        let (tx, mut outputs, secrets) = base_case();
        outputs[0].recipient = TEST_RECIPIENT + 1;
        let _ = run_relation(
            tx,
            outputs,
            secrets,
            0,
            0,
            [no_spend(), no_spend(), no_spend(), no_spend()],
            0,
        );
    }

    // A zero note secret is a weak secret, not an unspendable note: the rule
    // opens the declared output under it like any other.
    #[test]
    fn test_detail_relation_accepts_a_zero_output_note_secret() {
        let (mut tx, outputs, mut secrets) = base_case();
        secrets[0] = 0;
        tx.output_body_commitments[0] =
            note_body_commitment(owner_commitment(TEST_RECIPIENT, 0), 0, 1000);
        let statement = run_relation(
            tx,
            outputs,
            secrets,
            0,
            0,
            [no_spend(), no_spend(), no_spend(), no_spend()],
            0,
        );
        assert(statement == transfer_statement(tx, 0));
    }

    // The account spends its own note under a zero secret like any other.
    #[test]
    fn test_detail_relation_accepts_a_spend_under_a_zero_note_secret() {
        let (mut tx, outputs, secrets) = base_case();
        let asset_id = 9;
        tx.input_slot_classes[1] = SLOT_CLASS_ASSET;
        tx.input_commitments[1] = output_commitment(
            note_body_commitment(owner_commitment(TEST_SIGNER, 0), asset_id, 300),
            42,
        );
        let spend = AssetSpendOpening { note_secret: 0, amount: 300, output_index: 42 };
        let statement = run_relation(
            tx,
            outputs,
            secrets,
            asset_id,
            300,
            [no_spend(), spend, no_spend(), no_spend()],
            0,
        );
        assert(statement == transfer_statement(tx, 0));
    }

    #[test(should_fail_with = "declared spends must total the spent asset amount")]
    fn test_detail_relation_rejects_unopened_spend_total() {
        let (tx, outputs, secrets) = base_case();
        let _ = run_relation(
            tx,
            outputs,
            secrets,
            9,
            500,
            [no_spend(), no_spend(), no_spend(), no_spend()],
            0,
        );
    }

    #[test]
    fn test_account_contribution_accepts_two_asset_inputs() {
        let asset_id = 9;
        let mk = |secret: Field, amount: Field, output_index: Field| {
            output_commitment(
                note_body_commitment(owner_commitment(TEST_SIGNER, secret), asset_id, amount),
                output_index,
            )
        };
        let mut (tx, _, _) = base_case();
        tx.input_slot_classes = [SLOT_CLASS_ASSET, SLOT_CLASS_ASSET, 0, 0];
        tx.input_commitments = [mk(0x6001, 700, 41), mk(0x6002, 300, 42), 0, 0];
        let out_secret = 0x7001;
        tx.output_slot_classes = [SLOT_CLASS_NATIVE, SLOT_CLASS_ASSET, 0, 0, 0];
        tx.output_body_commitments[1] =
            note_body_commitment(owner_commitment(TEST_RECIPIENT, out_secret), asset_id, 1000);
        let outputs = [
            OutputDeclaration { recipient: TEST_RECIPIENT, amount: 1000, asset_id: 0 },
            OutputDeclaration { recipient: TEST_RECIPIENT, amount: 1000, asset_id },
            undeclared(),
            undeclared(),
            undeclared(),
        ];
        let spends = [
            AssetSpendOpening { note_secret: 0x6001, amount: 700, output_index: 41 },
            AssetSpendOpening { note_secret: 0x6002, amount: 300, output_index: 42 },
            no_spend(),
            no_spend(),
        ];
        let _ = run_relation(
            tx,
            outputs,
            [0x5001, out_secret, 0, 0, 0],
            asset_id,
            1000,
            spends,
            0,
        );
    }

    // The full rule is retained as a compiled fixture for the asset-creation
    // kernel's native-fee application. It is not installed in the website's
    // canonical six-rule User Account and must not regain consumer routing.
    #[test]
    fn test_fixture_accepts_funded_asset_creation_fee_authorization() {
        let asset_id = 9;
        let asset_secret = 0x7101;
        let change_secret = 0x7102;
        let asset_amount = 1000;
        let native_change_amount = 45;
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
                SLOT_CLASS_ASSET_CREATION,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            input_commitments: [0, 0x71, 0, 0],
            nullifiers: [0x81, 0x82, 0x83, 0x84],
            output_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [
                note_body_commitment(
                    owner_commitment(TEST_RECIPIENT, asset_secret),
                    asset_id,
                    asset_amount,
                ),
                note_body_commitment(
                    owner_commitment(TEST_SIGNER, change_secret),
                    0,
                    native_change_amount,
                ),
                0x92,
                0x93,
                0x94,
            ],
        };
        let outputs = [
            OutputDeclaration { recipient: TEST_RECIPIENT, amount: asset_amount, asset_id },
            OutputDeclaration { recipient: TEST_SIGNER, amount: native_change_amount, asset_id: 0 },
            undeclared(),
            undeclared(),
            undeclared(),
        ];
        let statement = run_relation_creating(
            tx,
            outputs,
            [asset_secret, change_secret, 0, 0, 0],
            0,
            0,
            asset_id,
            [no_spend(), no_spend(), no_spend(), no_spend()],
            0,
        );
        assert(statement == asset_creation_statement(tx, asset_id, 0));
    }

    // A readable rule cannot display a durable one-shot application effect, so it
    // must reject the marker outright rather than let it fall through the input
    // loop's else branch, which only distinguishes ASSET.
    #[test(should_fail_with = "input slot must not be an application marker")]
    fn test_detail_relation_rejects_an_application_marker() {
        let mut (tx, _, _) = base_case();
        tx.input_slot_classes = [SLOT_CLASS_NATIVE, SLOT_CLASS_APPLICATION, 0, 0];
        tx.input_commitments[1] = 0;
        let outputs = [
            OutputDeclaration { recipient: TEST_RECIPIENT, amount: 1000, asset_id: 0 },
            undeclared(),
            undeclared(),
            undeclared(),
            undeclared(),
        ];
        let _ = run_relation(
            tx,
            outputs,
            [0x5001, 0, 0, 0, 0],
            0,
            0,
            [no_spend(), no_spend(), no_spend(), no_spend()],
            0,
        );
    }

    // --- Signed transaction detail. ---

    global ISSUANCE_RECIPIENT: Field = 0x3333333333333333333333333333333333333333;
    global ISSUANCE_SECRET: Field = 0x5101;

    // Every signed field but the open fee is nonzero and distinct, so the
    // signature fails if the circuit and the SDK disagree on any field's place.
    fn signed_case() -> (TestPrivateValue, [OutputDeclaration; 5], [Field; 5], AssetSpendOpening) {
        let owner = TEST_SIGNING_KEY.ethereum_address();
        let spend = AssetSpendOpening { note_secret: 0x6001, amount: 900, output_index: 41 };
        let mut tx = TestPrivateValue {
            open_fee_amount: 0,
            issuance_owner_commitment: owner_commitment(ISSUANCE_RECIPIENT, ISSUANCE_SECRET),
            not_before_timestamp: 10,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 7,
            delivery_commitment: 0x61,
            account_creation_commitment: 0,
            input_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            input_commitments: [
                output_commitment(
                    note_body_commitment(
                        owner_commitment(owner, spend.note_secret),
                        TEST_ASSET_ID,
                        spend.amount,
                    ),
                    spend.output_index,
                ),
                0x72,
                0,
                0,
            ],
            nullifiers: TEST_NULLIFIERS,
            output_slot_classes: [SLOT_CLASS_ASSET; 5],
            output_body_commitments: [0; 5],
        };
        let mut outputs = [undeclared(); 5];
        let mut secrets = [0; 5];
        for i in 0..5 {
            outputs[i] = OutputDeclaration {
                recipient: TEST_RECIPIENT + i as Field,
                amount: 100 + i as Field,
                asset_id: 0x7701 + i as Field,
            };
            secrets[i] = 0x5001 + i as Field;
            tx.output_body_commitments[i] = note_body_commitment(
                owner_commitment(outputs[i].recipient, secrets[i]),
                outputs[i].asset_id,
                outputs[i].amount,
            );
        }
        (tx, outputs, secrets, spend)
    }

    // TEST_SIGNING_KEY's signature over the SDK's TRANSACTION_DETAIL_EIP712_TYPE
    // message for signed_case() on TEST_PCASH_CHAIN_ID. The SDK parity test
    // re-signs that message and expects these bytes.
    global SIGNED_DETAIL_SIGNATURE: [u8; 64] = [
        0x7f, 0x85, 0xde, 0xec, 0xbf, 0xd8, 0x7e, 0x1c, 0x6e, 0x0a, 0xdd, 0x57, 0xe7, 0xd2, 0x45,
        0x74, 0x89, 0x49, 0xee, 0x0a, 0xe8, 0xd9, 0xca, 0xa4, 0xc2, 0x3d, 0x7b, 0xef, 0xdd, 0x9d,
        0xa5, 0x41, 0x0d, 0x25, 0x73, 0xf5, 0x50, 0xc4, 0xb3, 0x35, 0x4a, 0xf2, 0xc7, 0xe0, 0xa0,
        0xf3, 0xcb, 0x0d, 0xbe, 0x93, 0xde, 0x90, 0x3e, 0x1e, 0x9a, 0xf1, 0xfb, 0x8a, 0x23, 0xec,
        0x15, 0xae, 0xb0, 0x16,
    ];

    fn run_signed_detail(
        tx: TestPrivateValue,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let (_, outputs, secrets, spend) = signed_case();
        main(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature: SIGNED_DETAIL_SIGNATURE },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            TEST_ASSET_ID,
            spend.amount,
            0,
            outputs,
            tx,
            ISSUANCE_RECIPIENT,
            ISSUANCE_SECRET,
            secrets,
            [spend, no_spend(), no_spend(), no_spend()],
            event_entry,
        )
    }

    #[test]
    fn test_fixture_accepts_the_owner_signature() {
        let (tx, _, _, _) = signed_case();
        let _ = run_signed_detail(tx, 0);
    }

    // The message signs the private value commitment, so the signature does not
    // carry over to a transaction that differs only in its delivery commitment.
    #[test(should_fail_with = "signature must be valid")]
    fn test_fixture_rejects_a_signature_over_another_transaction() {
        let (mut tx, _, _, _) = signed_case();
        tx.delivery_commitment = 0x66;
        let _ = run_signed_detail(tx, 0);
    }
}
