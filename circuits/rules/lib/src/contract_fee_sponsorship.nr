// Contract-targeted fee sponsorship rule of the reference user account.
//
// A User Account sponsor approves one open fee or private relay payment for a
// named Contract Account. The message names the contract, payout terms,
// transaction context, and validity window. The signed transaction context
// fixes every nullifier, including the primary's, so the signature can fund
// only the one transaction that spends exactly those inputs.
//
// The sponsored-transfer kernel enforces the rest — that the sponsor owns every
// native input, that the primary owns every asset and application input, and
// that native value leaves only as the open fee, one relay note, and change to
// the sponsor. This rule binds what the sponsor saw and requires any native
// output other than the signed relay note to be the one owner-change note
// under the sponsor's derived secret.

use crate::configuration::Configuration;
use crate::message::verify_value_message;
use crate::owner::open_owner;
use crate::value_rule::assert_native_fee_outputs;
use pcash_protocol::authorization::statement::{
    contract_fee_sponsorship_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::ledger::private_value::{private_value_commitment, PrivateValue};
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

// keccak256 of the SDK CONTRACT_FEE_SPONSORSHIP_EIP712_TYPE, written by scripts/circuits/gen_reference_message_types.mjs.
global CONTRACT_FEE_SPONSORSHIP_TYPE_HASH: [u8; 32] = [
    0xa2, 0x57, 0x0d, 0x8b, 0x6b, 0x95, 0xa3, 0xaa, 0xa9, 0x8d, 0x5d, 0xb0, 0x7f, 0x94, 0x9a, 0x0f,
    0x8a, 0x69, 0x83, 0x44, 0x2d, 0xff, 0xea, 0x10, 0x3b, 0x03, 0x7a, 0x64, 0xff, 0xd4, 0x69, 0x26,
];

pub fn contract_fee_sponsorship_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signer_address: Field,
    nk_root: Field,
    sponsored_contract: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    native_change_amount: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    let owner = open_owner(signer_address, nk_root, configuration);
    assert_native_fee_outputs(
        private_value,
        signer_address,
        nk_root,
        relay_fee_amount,
        relay_fee_owner_commitment,
        native_change_amount,
    );
    // No open or bearer sponsorship: the kernel builds this action from the
    // contract it authenticated, so it matches only the signed contract.
    rule_statement(
        owner.authorization_commitment,
        contract_fee_sponsorship_action_commitment(
            pcash_chain_id,
            private_value_commitment(private_value),
            sponsored_contract,
        ),
        recent_pcash_block_hash,
        event_entry,
    )
}

pub fn authorize<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    configuration: Configuration,
    signature: Signature,
    pubkey: Secp256k1PubKey,
    nk_root: Field,
    sponsored_contract: Field,
    issuance_recipient: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    native_change_amount: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    issuance_note_secret: Field,
    event_entry: Field,
) -> [Field; RULE_STATEMENT_LENGTH] {
    let signer_address = pubkey.ethereum_address();
    let statement = contract_fee_sponsorship_relation(
        pcash_chain_id,
        recent_pcash_block_hash,
        configuration,
        signer_address,
        nk_root,
        sponsored_contract,
        relay_fee_amount,
        relay_fee_owner_commitment,
        native_change_amount,
        private_value,
        event_entry,
    );
    verify_value_message(
        signature,
        pubkey,
        signer_address,
        configuration,
        CONTRACT_FEE_SPONSORSHIP_TYPE_HASH,
        pcash_chain_id,
        nk_root,
        [sponsored_contract],
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
    use crate::configuration::configuration_commitment;
    use crate::test_support::{
        TEST_ATTACKER, TEST_CHANGE_AMOUNT, TEST_CONFIGURATION, TEST_NK_ROOT, TEST_PCASH_CHAIN_ID,
        TEST_RECENT_BLOCK, TEST_SIGNING_KEY, TestPrivateValue,
    };
    use crate::value_rule::owner_change_note_secret;
    use super::{authorize, contract_fee_sponsorship_relation};
    use pcash_protocol::authorization::statement::{
        authorization_commitment, contract_fee_sponsorship_action_commitment, rule_statement,
        RULE_STATEMENT_LENGTH,
    };
    use pcash_protocol::ledger::note::{
        note_body_commitment, nullifier_key_commitment, owner_commitment,
    };
    use pcash_protocol::ledger::private_value::{
        private_value_commitment, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY,
        SLOT_CLASS_NATIVE,
    };
    use signature_common::secp256k1::Signature;

    global TEST_SPONSOR: Field = 0x1111111111111111111111111111111111111111;
    global TEST_CONTRACT: Field = 0x2222222222222222222222222222222222222222;
    global TEST_OTHER_CONTRACT: Field = 0x3333333333333333333333333333333333333333;

    fn sponsor_change_body(private_value: TestPrivateValue, slot: u32, amount: Field) -> Field {
        note_body_commitment(
            owner_commitment(
                TEST_SPONSOR,
                owner_change_note_secret(TEST_NK_ROOT, private_value, slot),
            ),
            0,
            amount,
        )
    }

    // The primary's asset input sits at slot 0 and its application marker at slot
    // 2; the sponsor's native note is at slot 1 and its change at output slot 1.
    fn fixture() -> TestPrivateValue {
        let mut private_value = TestPrivateValue {
            open_fee_amount: 500,
            issuance_owner_commitment: 0x4444444444444444444444444444444444444444,
            not_before_timestamp: 0,
            valid_until_timestamp: 2000000000,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0x61,
            account_creation_commitment: 0,
            input_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_APPLICATION,
                SLOT_CLASS_DUMMY,
            ],
            input_commitments: [0x71, 0x72, 0, 0],
            nullifiers: [0x81, 0x82, 0x83, 0x84],
            output_slot_classes: [
                SLOT_CLASS_ASSET,
                SLOT_CLASS_NATIVE,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
                SLOT_CLASS_DUMMY,
            ],
            output_body_commitments: [0x90, 0, 0x92, 0x93, 0x94],
        };
        private_value.output_body_commitments[1] =
            sponsor_change_body(private_value, 1, TEST_CHANGE_AMOUNT);
        private_value
    }

    // The statement the sponsored-transfer kernel expects from the sponsor for
    // `private_value` and the contract it authenticated.
    fn kernel_statement(
        private_value: TestPrivateValue,
        contract_address: Field,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        rule_statement(
            authorization_commitment(
                TEST_SPONSOR,
                configuration_commitment(
                    TEST_CONFIGURATION,
                    nullifier_key_commitment(TEST_NK_ROOT),
                ),
            ),
            contract_fee_sponsorship_action_commitment(
                TEST_PCASH_CHAIN_ID,
                private_value_commitment(private_value),
                contract_address,
            ),
            TEST_RECENT_BLOCK,
            event_entry,
        )
    }

    fn run_relation(
        sponsored_contract: Field,
        private_value: TestPrivateValue,
        native_change_amount: Field,
        relay_fee_amount: Field,
        relay_fee_owner_commitment: Field,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        contract_fee_sponsorship_relation(
            TEST_PCASH_CHAIN_ID,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            TEST_SPONSOR,
            TEST_NK_ROOT,
            sponsored_contract,
            relay_fee_amount,
            relay_fee_owner_commitment,
            native_change_amount,
            private_value,
            event_entry,
        )
    }

    fn run_with(
        sponsored_contract: Field,
        private_value: TestPrivateValue,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        run_relation(
            sponsored_contract,
            private_value,
            TEST_CHANGE_AMOUNT,
            0,
            0,
            event_entry,
        )
    }

    #[test]
    fn test_accepts_the_authenticated_contract_target() {
        let tx = fixture();
        assert(run_with(TEST_CONTRACT, tx, 0) == kernel_statement(tx, TEST_CONTRACT, 0));
    }

    // A sponsorship signed for one contract cannot be replayed against another:
    // the kernel builds the action from the primary it authenticated.
    #[test]
    fn test_binds_the_signed_contract() {
        let tx = fixture();
        assert(run_with(TEST_OTHER_CONTRACT, tx, 0) != kernel_statement(tx, TEST_CONTRACT, 0));
    }

    #[test]
    fn test_accepts_a_signed_zero_fee() {
        let mut tx = fixture();
        tx.open_fee_amount = 0;
        assert(run_with(TEST_CONTRACT, tx, 0) == kernel_statement(tx, TEST_CONTRACT, 0));
    }

    // Change returns to the sponsor only under the secret the sponsor derives.
    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_change_under_a_free_secret() {
        let mut changed = fixture();
        changed.output_body_commitments[1] = note_body_commitment(
            owner_commitment(TEST_SPONSOR, 0xdeadbeef),
            0,
            TEST_CHANGE_AMOUNT,
        );
        let _ = run_with(TEST_CONTRACT, changed, 0);
    }

    // Without a signed relay, the kernel's relay slot cannot carry a second
    // change note: the change is one note the sponsor can recompute.
    #[test(should_fail_with = "native change must be exactly one owner change output")]
    fn test_rejects_change_split_across_two_notes() {
        let half = TEST_CHANGE_AMOUNT / 2;
        let mut tx = fixture();
        tx.output_slot_classes[2] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[1] = sponsor_change_body(tx, 1, half);
        tx.output_body_commitments[2] = sponsor_change_body(tx, 2, half);
        let _ = run_relation(TEST_CONTRACT, tx, half, 0, 0, 0);
    }

    #[test]
    fn test_accepts_a_private_relay_and_change() {
        let relay_owner = owner_commitment(TEST_OTHER_CONTRACT, 0x5e1f);
        let mut tx = fixture();
        tx.open_fee_amount = 0;
        tx.output_slot_classes[2] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[2] = note_body_commitment(relay_owner, 0, 500);
        let _ = run_relation(TEST_CONTRACT, tx, TEST_CHANGE_AMOUNT, 500, relay_owner, 0);
    }

    // Signed relay 0 and open fee 500; the sponsor's remainder is a native output
    // to an attacker presented as change.
    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_zero_relay_change_to_an_attacker() {
        let attacker_owner = owner_commitment(TEST_ATTACKER, 0xbad);
        let mut tx = fixture();
        tx.issuance_owner_commitment = 0;
        tx.output_body_commitments[1] = note_body_commitment(attacker_owner, 0, TEST_CHANGE_AMOUNT);
        let _ = run_with(TEST_CONTRACT, tx, 0);
    }

    // Signed relay of 1 opens to the sponsor itself; the large remainder is a
    // native output to an attacker presented as change.
    #[test(should_fail_with = "owner change must return to the owner under the derived secret")]
    fn test_rejects_swapped_relay_and_change_roles() {
        let attacker_owner = owner_commitment(TEST_ATTACKER, 0xbad);
        let self_owner = owner_commitment(TEST_SPONSOR, 0x5e1f);
        let mut tx = fixture();
        tx.open_fee_amount = 0;
        tx.output_slot_classes[2] = SLOT_CLASS_NATIVE;
        tx.output_body_commitments[1] = note_body_commitment(self_owner, 0, 1);
        tx.output_body_commitments[2] = note_body_commitment(attacker_owner, 0, 1_000_000);
        let _ = run_relation(TEST_CONTRACT, tx, 1_000_000, 1, self_owner, 0);
    }

    // --- Signed tests. ---

    // TEST_SIGNING_KEY's signature over the sponsorship `run_signed_sponsorship`
    // proves on TEST_PCASH_CHAIN_ID.
    global SIGNED_SPONSORSHIP_SIGNATURE: [u8; 64] = [
        0x00, 0xb6, 0xc3, 0x17, 0x56, 0xaa, 0xdc, 0xb0, 0xce, 0x0e, 0x54, 0x4a, 0xc3, 0xd1, 0x6f,
        0xf7, 0x7a, 0xfb, 0xe4, 0x28, 0x2a, 0x71, 0x93, 0x12, 0x8f, 0x4c, 0xc9, 0x99, 0xa0, 0xa6,
        0xd0, 0x65, 0x24, 0x45, 0xd2, 0x4e, 0x92, 0xac, 0x40, 0x16, 0x3a, 0xdd, 0x35, 0x81, 0x70,
        0x61, 0x33, 0x67, 0x5f, 0xde, 0x42, 0xa1, 0xc0, 0xce, 0x34, 0xf1, 0xff, 0x1b, 0x63, 0xf0,
        0x01, 0x5a, 0xfd, 0x8d,
    ];

    fn run_signed_sponsorship(
        pcash_chain_id: Field,
        event_entry: Field,
        account_creation_commitment: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        let mut tx = fixture();
        tx.issuance_owner_commitment = 0;
        tx.output_slot_classes[1] = SLOT_CLASS_DUMMY;
        tx.account_creation_commitment = account_creation_commitment;
        authorize::<4, 5, 0>(
            pcash_chain_id,
            TEST_RECENT_BLOCK,
            TEST_CONFIGURATION,
            Signature { signature: SIGNED_SPONSORSHIP_SIGNATURE },
            TEST_SIGNING_KEY,
            TEST_NK_ROOT,
            TEST_CONTRACT,
            0,
            0,
            0,
            0,
            tx,
            0,
            event_entry,
        )
    }

    #[test]
    fn test_sponsorship_accepts_the_sponsor_signature() {
        let _ = run_signed_sponsorship(TEST_PCASH_CHAIN_ID, 0, 0);
    }

    // The message signs the chain ID the action commitment binds, so a
    // sponsorship signed for one chain cannot be proved on another.
    #[test(should_fail_with = "signature must be valid")]
    fn test_sponsorship_rejects_a_signature_for_another_chain() {
        let _ = run_signed_sponsorship(TEST_PCASH_CHAIN_ID + 1, 0, 0);
    }
    #[test(should_fail_with = "signature must be valid")]
    fn test_sponsorship_rejects_an_unsigned_attachment() {
        let _ = run_signed_sponsorship(TEST_PCASH_CHAIN_ID, 0, 1);
    }

}
