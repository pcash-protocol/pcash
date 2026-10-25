// Escrow claim authorization. The claim-key holder authorizes the escrow input
// to pay the buyer in full, in a transaction that requires the payment router's
// `PcashBatch` carrier context for the offer's payment. A native escrow also
// funds the optional private relay output and open fee in the transfer role;
// `relay_fee_amount` is that escrow-funded relay payment. A token escrow
// carries no native value of its own, so its `relay_fee_amount` is zero: its
// transfer role has no native slot, and its sponsored role leaves the fee
// payer's native inputs, change, and relay payment to the sponsored-transfer
// kernel. The payment binds the claim key and exact escrow note; publication
// and issuance are chosen at claim time.

use escrow_common::assert_escrow_release;
use pcash_protocol::authorization::statement::{
    authorization_commitment, contract_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, SmallPrivateValue as PrivateValue,
};
use pcash_protocol::primitives::hash::pcash_hash;
use pcash_protocol::primitives::range::timestamp_le;
use pcash_protocol::primitives::types::Note;
use pcash_protocol::state::carrier_context::{carrier_context_hash, CARRIER_KIND_EVENT};
use reference_rule_common::generated::reference_rule_constants::REFERENCE_CONFIGURATION_DOMAIN;

// The offer terms. `offer_id` is a per-offer instance value, so two otherwise
// identical offers (same seller, price, deadline) have distinct commitments and
// cannot be claimed by the same L1 payment. `asset_id` 0 is native PCASH.
pub struct Configuration {
    pub configuration_salt: Field,
    pub router: Field,
    pub seller: Field,
    pub offer_id: Field,
    pub asset_id: Field,
    pub amount: Field,
    pub eth_price_wei: Field,
    pub deadline_t: Field,
}

pub fn claim_configuration_commitment(configuration: Configuration) -> Field {
    pcash_hash([
        REFERENCE_CONFIGURATION_DOMAIN,
        configuration.configuration_salt,
        configuration.router,
        configuration.seller,
        configuration.offer_id,
        configuration.asset_id,
        configuration.amount,
        configuration.eth_price_wei,
        configuration.deadline_t,
    ])
}

// The part of the escrow note neither the offer nor the account fixes: the
// escrow contract's address owns it, and the offer fixes its asset and amount.
pub struct EscrowNoteOpening {
    pub note_secret: Field,
}

// CLAIM_KEY_COMMITMENT_DOMAIN: the domain tag of context "escrow_claim_key_commitment"
global CLAIM_KEY_COMMITMENT_DOMAIN: Field =
    0x19da12774714919e93812df8ba5c02a9830fe550055e12910e97421d3cbd0191;

// The payment commits a secret claim key and one exact funded escrow output.
// The immutable claim configuration and the router's carrier context bind
// offer terms. Publication and issuance routing are chosen when the claim is
// built.
pub fn claim_key_commitment(claim_key: Field, escrow_output_commitment: Field) -> Field {
    pcash_hash(
        [CLAIM_KEY_COMMITMENT_DOMAIN, claim_key, escrow_output_commitment],
    )
}

global PAYMENT_CONTEXT_LENGTH: u32 = 128;

// The router's `PcashBatch` context for a payment:
//
//   abi.encode(bytes32 offerId, address seller, uint256 price, bytes32 claimKeyCommitment)
//
// four 32-byte big-endian words, `price` the gross ETH payment. A configured
// seller wider than 160 bits encodes to a word the router never emits, so the
// claim needs no range check on it.
pub fn payment_context(
    configuration: Configuration,
    claim_key_commitment: Field,
) -> [u8; PAYMENT_CONTEXT_LENGTH] {
    let words = [
        configuration.offer_id,
        configuration.seller,
        configuration.eth_price_wei,
        claim_key_commitment,
    ];
    let mut context = [0; PAYMENT_CONTEXT_LENGTH];
    for word in 0..4 {
        let bytes: [u8; 32] = words[word].to_be_bytes();
        for i in 0..32 {
            context[word * 32 + i] = bytes[i];
        }
    }
    context
}

// The carrier context of the configured router's `PcashBatch` for a payment.
pub fn payment_carrier_context_hash(
    configuration: Configuration,
    claim_key_commitment: Field,
) -> Field {
    carrier_context_hash(
        CARRIER_KIND_EVENT,
        configuration.router,
        payment_context(configuration, claim_key_commitment),
    )
}

fn main(
    recent_pcash_block_hash: Field,
    address: Field,
    pcash_chain_id: Field,
    fee_paid: bool,
    configuration: Configuration,
    claim_key: Field,
    private_value: PrivateValue,
    escrow_note: EscrowNoteOpening,
    escrow_output_index: Field,
    payout_owner_commitment: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    // The claimant chooses the payout owner, so the claim opens only its
    // commitment.
    let (escrow_commitment, _) = assert_escrow_release(
        private_value,
        fee_paid,
        Note {
            owner: address,
            note_secret: escrow_note.note_secret,
            asset_id: configuration.asset_id,
            amount: configuration.amount,
        },
        escrow_output_index,
        payout_owner_commitment,
        relay_fee_amount,
        relay_fee_owner_commitment,
    );
    assert(
        timestamp_le(
            private_value.valid_until_timestamp,
            configuration.deadline_t,
        ),
        "claim must expire by the offer deadline",
    );

    // Only the router's `PcashBatch` for this offer's payment, whose context
    // names the claim key's commitment to this escrow note, can carry the
    // claim.
    assert(
        private_value.carrier_context_hash
            == payment_carrier_context_hash(
                configuration,
                claim_key_commitment(claim_key, escrow_commitment),
            ),
        "claim must require the router's payment carrier context",
    );

    rule_statement(
        authorization_commitment(address, claim_configuration_commitment(configuration)),
        contract_action_commitment(
            pcash_chain_id,
            private_value_commitment(private_value),
            fee_paid,
        ),
        recent_pcash_block_hash,
        event_entry,
    )
}

mod tests {
    use super::{
        claim_configuration_commitment, claim_key_commitment, CLAIM_KEY_COMMITMENT_DOMAIN,
        Configuration, EscrowNoteOpening, main, payment_carrier_context_hash, payment_context,
    };
    use escrow_common::test_support::{release_transaction, with_sponsor_slots};
    use pcash_protocol::authorization::statement::{
        authorization_commitment, rule_statement, RULE_STATEMENT_LENGTH,
        sponsored_transfer_action_commitment, transfer_action_commitment,
    };
    use pcash_protocol::ledger::note::{
        full_output_commitment, note_body_commitment, owner_commitment,
    };
    use pcash_protocol::ledger::private_value::{
        private_value_commitment, SLOT_CLASS_NATIVE, SmallPrivateValue as PrivateValue,
    };
    use pcash_protocol::primitives::hash::pcash_hash;
    use pcash_protocol::primitives::types::Note;
    use pcash_protocol::state::carrier_context::{carrier_context_hash, CARRIER_KIND_INBOX};

    // One coherent claim whose transaction requires the router's carrier
    // context for the payment that published the claim key's commitment to the
    // escrow note.
    struct ClaimFixture {
        configuration: Configuration,
        claim_key: Field,
        published_commitment: Field,
        private_value: PrivateValue,
        escrow_note: EscrowNoteOpening,
        relay_fee_amount: Field,
        relay_fee_owner_commitment: Field,
    }

    global TEST_RECENT_PCASH_BLOCK_HASH: Field = 0x5eed;
    global TEST_CHAIN_ID: Field = 7;
    global TEST_ROUTER: Field = 0x1111;
    global TEST_SELLER: Field = 0x2222;
    global TEST_OFFER_ID: Field = 0x42;
    global TEST_PRICE: Field = 5;
    global TEST_CLAIM_KEY: Field = 0x1234;
    global TEST_ESCROW_INDEX: Field = 3;
    global TEST_ESCROW_CONTRACT: Field = 0x77;
    global TEST_ESCROW_SECRET: Field = 0x99;
    global TEST_PAYOUT_OWNER: Field = 0x55;
    global TEST_PAYOUT_SECRET: Field = 0x66;
    global TEST_TOKEN: Field = 0x7070;

    fn designated_route() -> Field {
        owner_commitment(0xdef, 0x123)
    }

    fn payout_owner_commitment() -> Field {
        owner_commitment(TEST_PAYOUT_OWNER, TEST_PAYOUT_SECRET)
    }

    fn escrow_commitment(asset_id: Field, amount: Field) -> Field {
        full_output_commitment(
            Note { owner: TEST_ESCROW_CONTRACT, note_secret: TEST_ESCROW_SECRET, asset_id, amount },
            TEST_ESCROW_INDEX,
        )
    }

    // The carrier context of a `PcashBatch` that `emitter` emitted for a
    // payment of `price` for `offer_id` from `seller`.
    fn emitted_context_hash(
        emitter: Field,
        offer_id: Field,
        seller: Field,
        price: Field,
        published_commitment: Field,
    ) -> Field {
        payment_carrier_context_hash(
            Configuration {
                configuration_salt: 0,
                router: emitter,
                seller,
                offer_id,
                asset_id: 0,
                amount: 0,
                eth_price_wei: price,
                deadline_t: 0,
            },
            published_commitment,
        )
    }

    // A native escrow pays a 10-unit open fee on the open route; a token escrow
    // pays no fee from escrow value.
    fn claim_fixture_for(asset_id: Field, transaction_route: Field) -> ClaimFixture {
        let configuration = Configuration {
            configuration_salt: 1,
            router: TEST_ROUTER,
            seller: TEST_SELLER,
            offer_id: TEST_OFFER_ID,
            asset_id,
            amount: 100,
            eth_price_wei: TEST_PRICE,
            deadline_t: 2000000000,
        };
        let escrow = Note {
            owner: TEST_ESCROW_CONTRACT,
            note_secret: TEST_ESCROW_SECRET,
            asset_id,
            amount: 100,
        };
        let open_fee = if (asset_id == 0) & (transaction_route == 0) {
            10
        } else {
            0
        };
        let payout = 100 - open_fee;
        let mut private_value = release_transaction(
            escrow,
            TEST_ESCROW_INDEX,
            payout_owner_commitment(),
            payout,
            open_fee,
        );
        private_value.issuance_owner_commitment = transaction_route;
        private_value.valid_until_timestamp = 1900000000;
        let published_commitment = claim_key_commitment(
            TEST_CLAIM_KEY,
            full_output_commitment(escrow, TEST_ESCROW_INDEX),
        );
        private_value.carrier_context_hash = emitted_context_hash(
            TEST_ROUTER,
            TEST_OFFER_ID,
            TEST_SELLER,
            TEST_PRICE,
            published_commitment,
        );
        ClaimFixture {
            configuration,
            claim_key: TEST_CLAIM_KEY,
            published_commitment,
            private_value,
            escrow_note: EscrowNoteOpening { note_secret: TEST_ESCROW_SECRET },
            relay_fee_amount: 0,
            relay_fee_owner_commitment: 0,
        }
    }

    fn claim_fixture(transaction_route: Field) -> ClaimFixture {
        claim_fixture_for(0, transaction_route)
    }

    fn token_claim_fixture(transaction_route: Field) -> ClaimFixture {
        claim_fixture_for(TEST_TOKEN, transaction_route)
    }

    // A buyer sponsors the token claim with native fee and change slots.
    fn sponsored_token_claim_fixture() -> ClaimFixture {
        let mut fixture = token_claim_fixture(0);
        fixture.private_value = with_sponsor_slots(fixture.private_value);
        fixture.private_value.open_fee_amount = 10;
        fixture
    }

    fn claim_by(
        fixture: ClaimFixture,
        address: Field,
        fee_paid: bool,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        main(
            TEST_RECENT_PCASH_BLOCK_HASH,
            address,
            TEST_CHAIN_ID,
            fee_paid,
            fixture.configuration,
            fixture.claim_key,
            fixture.private_value,
            fixture.escrow_note,
            TEST_ESCROW_INDEX,
            payout_owner_commitment(),
            fixture.relay_fee_amount,
            fixture.relay_fee_owner_commitment,
            event_entry,
        )
    }

    fn claim_as(
        fixture: ClaimFixture,
        fee_paid: bool,
        event_entry: Field,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        claim_by(fixture, TEST_ESCROW_CONTRACT, fee_paid, event_entry)
    }

    fn run_claim(fixture: ClaimFixture) {
        let _ = claim_as(fixture, false, 0);
    }

    #[test]
    fn test_claim_accepts_open_and_designated_routes_with_the_payment_context() {
        run_claim(claim_fixture(0));
        run_claim(claim_fixture(designated_route()));
    }

    #[test]
    fn test_claim_accepts_selected_private_relay_output() {
        let mut fixture = claim_fixture(designated_route());
        let relay_owner = owner_commitment(0xabc, 0x999);
        fixture.relay_fee_amount = 1;
        fixture.relay_fee_owner_commitment = relay_owner;
        fixture.private_value.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        fixture.private_value.output_body_commitments[0] =
            note_body_commitment(payout_owner_commitment(), 0, 99);
        fixture.private_value.output_body_commitments[1] = note_body_commitment(relay_owner, 0, 1);
        run_claim(fixture);
    }

    #[test]
    fn test_claim_reproof_can_change_dummy_nullifiers_for_the_same_payment() {
        let mut fixture = claim_fixture(designated_route());
        fixture.private_value.nullifiers[1] = 0x888;
        run_claim(fixture);
    }

    #[test(should_fail_with = "claim must expire by the offer deadline")]
    fn test_claim_rejects_validity_past_the_offer_deadline() {
        let mut fixture = claim_fixture(0);
        fixture.private_value.valid_until_timestamp = fixture.configuration.deadline_t + 1;
        run_claim(fixture);
    }

    #[test(should_fail_with = "claim must require the router's payment carrier context")]
    fn test_claim_rejects_a_transaction_with_no_carrier_context() {
        let mut fixture = claim_fixture(0);
        fixture.private_value.carrier_context_hash = 0;
        run_claim(fixture);
    }

    // Another contract that emits the router's exact context bytes is not the
    // router.
    #[test(should_fail_with = "claim must require the router's payment carrier context")]
    fn test_claim_rejects_the_payment_context_from_another_emitter() {
        let mut fixture = claim_fixture(0);
        fixture.private_value.carrier_context_hash = emitted_context_hash(
            TEST_ROUTER + 1,
            TEST_OFFER_ID,
            TEST_SELLER,
            TEST_PRICE,
            fixture.published_commitment,
        );
        run_claim(fixture);
    }

    // An Inbox transaction the router's address sent is not the router's event.
    #[test(should_fail_with = "claim must require the router's payment carrier context")]
    fn test_claim_rejects_the_router_as_an_inbox_sender() {
        let mut fixture = claim_fixture(0);
        fixture.private_value.carrier_context_hash = carrier_context_hash(
            CARRIER_KIND_INBOX,
            TEST_ROUTER,
            payment_context(fixture.configuration, fixture.published_commitment),
        );
        run_claim(fixture);
    }

    #[test(should_fail_with = "claim must require the router's payment carrier context")]
    fn test_claim_rejects_a_payment_for_another_offer_id() {
        let mut fixture = claim_fixture(0);
        fixture.private_value.carrier_context_hash = emitted_context_hash(
            TEST_ROUTER,
            TEST_OFFER_ID + 1,
            TEST_SELLER,
            TEST_PRICE,
            fixture.published_commitment,
        );
        run_claim(fixture);
    }

    #[test(should_fail_with = "claim must require the router's payment carrier context")]
    fn test_claim_rejects_a_payment_to_another_seller() {
        let mut fixture = claim_fixture(0);
        fixture.private_value.carrier_context_hash = emitted_context_hash(
            TEST_ROUTER,
            TEST_OFFER_ID,
            TEST_SELLER + 1,
            TEST_PRICE,
            fixture.published_commitment,
        );
        run_claim(fixture);
    }

    #[test(should_fail_with = "claim must require the router's payment carrier context")]
    fn test_claim_rejects_a_payment_of_another_price() {
        let mut fixture = claim_fixture(0);
        fixture.private_value.carrier_context_hash = emitted_context_hash(
            TEST_ROUTER,
            TEST_OFFER_ID,
            TEST_SELLER,
            TEST_PRICE - 1,
            fixture.published_commitment,
        );
        run_claim(fixture);
    }

    #[test(should_fail_with = "claim must require the router's payment carrier context")]
    fn test_claim_rejects_another_claim_key() {
        let mut fixture = claim_fixture(0);
        fixture.claim_key = TEST_CLAIM_KEY + 1;
        run_claim(fixture);
    }

    // The payment's claim-key commitment names one escrow note; spending
    // another note of the same offer under the same payment fails.
    #[test(should_fail_with = "claim must require the router's payment carrier context")]
    fn test_claim_rejects_spending_another_escrow_note() {
        let mut fixture = claim_fixture(0);
        fixture.escrow_note.note_secret = 0x98;
        fixture.private_value.input_commitments[0] = full_output_commitment(
            Note { owner: TEST_ESCROW_CONTRACT, note_secret: 0x98, asset_id: 0, amount: 100 },
            TEST_ESCROW_INDEX,
        );
        run_claim(fixture);
    }

    // The account's address is the escrow note's owner: another account cannot
    // open the escrow note.
    #[test(should_fail_with = "escrow input must open the escrow note")]
    fn test_claim_by_another_account_fails_the_escrow_opening() {
        let _ = claim_by(claim_fixture(0), TEST_ESCROW_CONTRACT + 1, false, 0);
    }

    #[test]
    fn test_unsponsored_claim_returns_the_transfer_statement() {
        let fixture = claim_fixture(0);
        assert(
            claim_as(fixture, false, 0)
                == rule_statement(
                    authorization_commitment(
                        TEST_ESCROW_CONTRACT,
                        claim_configuration_commitment(fixture.configuration),
                    ),
                    transfer_action_commitment(
                        TEST_CHAIN_ID,
                        private_value_commitment(fixture.private_value),
                    ),
                    TEST_RECENT_PCASH_BLOCK_HASH,
                    0,
                ),
        );
    }

    #[test]
    fn test_token_claim_accepts_transfer_role_on_open_and_designated_routes() {
        run_claim(token_claim_fixture(0));
        run_claim(token_claim_fixture(designated_route()));
    }

    #[test]
    fn test_sponsored_token_claim_returns_the_sponsored_transfer_action() {
        let fixture = sponsored_token_claim_fixture();
        let statement = claim_as(fixture, true, 0);
        assert(
            statement[1]
                == sponsored_transfer_action_commitment(
                    TEST_CHAIN_ID,
                    private_value_commitment(fixture.private_value),
                ),
        );
    }

    #[test(should_fail_with = "non-escrow input must be dummy or the fee payer's native input")]
    fn test_sponsored_token_transaction_cannot_take_the_transfer_role() {
        let _ = claim_as(sponsored_token_claim_fixture(), false, 0);
    }

    #[test(should_fail_with = "escrow input must open the escrow note")]
    fn test_token_claim_rejects_escrow_in_another_asset() {
        let mut fixture = token_claim_fixture(0);
        fixture.private_value.input_commitments[0] = escrow_commitment(TEST_TOKEN + 1, 100);
        run_claim(fixture);
    }

    #[test(should_fail_with = "escrow input must open the escrow note")]
    fn test_native_offer_rejects_token_escrow() {
        let mut fixture = claim_fixture(designated_route());
        fixture.private_value.input_commitments[0] = escrow_commitment(TEST_TOKEN, 100);
        run_claim(fixture);
    }

    #[test(should_fail_with = "escrow input must open the escrow note")]
    fn test_claim_rejects_escrow_of_another_amount() {
        let mut fixture = claim_fixture(designated_route());
        fixture.private_value.input_commitments[0] = escrow_commitment(0, 101);
        run_claim(fixture);
    }

    #[test(should_fail_with = "payout output must pay the payout owner")]
    fn test_token_claim_rejects_open_fee_taken_from_token_value() {
        let mut fixture = sponsored_token_claim_fixture();
        fixture.private_value.output_body_commitments[0] =
            note_body_commitment(payout_owner_commitment(), TEST_TOKEN, 90);
        let _ = claim_as(fixture, true, 0);
    }

    // Frozen: the router's context for these terms as Solidity encodes it
    // (`cast abi-encode "f(bytes32,address,uint256,bytes32)"`, equal to viem's
    // `encodeAbiParameters`), hashed by the SDK's `carrierContextHash` as an
    // event carrier from the router.
    #[test]
    fn test_payment_carrier_context_hash_matches_the_solidity_encoding() {
        let configuration = Configuration {
            configuration_salt: 0,
            router: 0x5fbdb2315678afecb367f032d93f642f64180aa3,
            seller: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8,
            offer_id: 0x1d6e0c3e5c1f2e5b9b0f4a7e8c3d2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a,
            asset_id: 0,
            amount: 0,
            eth_price_wei: 1000000000000000000,
            deadline_t: 0,
        };
        assert_eq(
            payment_carrier_context_hash(
                configuration,
                0x077961001bbcf8fe10a31b578b3f8bf9643c91f96e7a5ad26f7b213cffc2e291,
            ),
            0x0279fb617ca3786d2a4cff0ebf82eb1d49007d9fd6e196e34812c1dc1008a0c2,
        );
    }

    #[test]
    fn test_claim_key_commitment_matches_formula() {
        let c = claim_key_commitment(0x1234567890abcdef, 0x99);
        assert(c == pcash_hash([CLAIM_KEY_COMMITMENT_DOMAIN, 0x1234567890abcdef, 0x99]));
        assert(c != claim_key_commitment(0x1234567890abcdee, 0x99));
        assert(c != claim_key_commitment(0x1234567890abcdef, 0x98));
    }

    // The buyer chooses the claim key, zero included.
    #[test]
    fn test_claim_key_commitment_takes_a_zero_key() {
        assert(claim_key_commitment(0, 0x99) == pcash_hash([CLAIM_KEY_COMMITMENT_DOMAIN, 0, 0x99]));
    }

    #[test]
    fn test_claim_configuration_commitment_binds_all_params() {
        let configuration = Configuration {
            configuration_salt: 1,
            router: 0xaaaa,
            seller: 0xbbbb,
            offer_id: 0x11,
            asset_id: 0,
            amount: 1000,
            eth_price_wei: 1500,
            deadline_t: 2000,
        };
        let base = claim_configuration_commitment(configuration);
        // Changing any parameter changes the commitment.
        let mut changed = configuration;
        changed.configuration_salt = 2;
        assert(base != claim_configuration_commitment(changed));
        changed = configuration;
        changed.router = 0xaaab;
        assert(base != claim_configuration_commitment(changed));
        changed = configuration;
        changed.seller = 0xbbbc;
        assert(base != claim_configuration_commitment(changed));
        changed = configuration;
        changed.offer_id = 0x12;
        assert(base != claim_configuration_commitment(changed));
        changed = configuration;
        changed.asset_id = 9;
        assert(base != claim_configuration_commitment(changed));
        changed = configuration;
        changed.amount = 1001;
        assert(base != claim_configuration_commitment(changed));
        changed = configuration;
        changed.eth_price_wei = 1501;
        assert(base != claim_configuration_commitment(changed));
        changed = configuration;
        changed.deadline_t = 2001;
        assert(base != claim_configuration_commitment(changed));
    }
}
