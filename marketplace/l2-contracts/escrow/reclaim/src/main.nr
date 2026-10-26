// Escrow reclaim authorization. The seller signs the offer, escrow contract,
// asset, payout, open fee, optional private relay output, issuance route, and
// validity window. The exact private escrow opening and payout note remain
// circuit witnesses. A native escrow funds its own network fees in the transfer
// role; a token escrow returns in full, and the seller's own account funds any
// fee through the sponsored-transfer kernel.

use escrow_common::assert_escrow_release;
use pcash_protocol::authorization::statement::{
    authorization_commitment, contract_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
use pcash_protocol::ledger::note::owner_commitment;
use pcash_protocol::ledger::private_value::{
    delivery_commitment, private_value_commitment, SmallPrivateValue as PrivateValue,
};
use pcash_protocol::primitives::hash::pcash_hash;
use pcash_protocol::primitives::range::{assert_address, timestamp_le};
use pcash_protocol::primitives::types::Note;
use reference_rule_common::configuration::Configuration as SigningDomain;
use reference_rule_common::generated::reference_rule_constants::REFERENCE_CONFIGURATION_DOMAIN;
use reference_rule_common::issuance_opening::assert_issuance_opening;
use reference_rule_common::payout::transaction_context;
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

// The seller's reclaim terms and the EIP-712 domain separator the seller signs
// under, as two 128-bit halves. The seller is derived from the signing key.
pub struct Configuration {
    pub configuration_salt: Field,
    pub offer_id: Field,
    pub deadline_t: Field,
    pub domain_separator_high: Field,
    pub domain_separator_low: Field,
}

pub fn reclaim_configuration_commitment(seller: Field, configuration: Configuration) -> Field {
    pcash_hash([
        REFERENCE_CONFIGURATION_DOMAIN,
        configuration.configuration_salt,
        seller,
        configuration.offer_id,
        configuration.deadline_t,
        configuration.domain_separator_high,
        configuration.domain_separator_low,
    ])
}

// The part of the escrow note the contract does not fix: the escrow contract
// owns it.
pub struct EscrowNoteOpening {
    pub note_secret: Field,
    pub asset_id: Field,
    pub amount: Field,
}

// keccak256 of MARKETPLACE_RECLAIM_EIP712_TYPE in marketplace/src/client/reclaimWitness.ts,
// written by scripts/circuits/gen_reference_message_types.mjs.
global MARKETPLACE_RECLAIM_TYPE_HASH: [u8; 32] = [
    0xbc, 0xf6, 0x71, 0xa2, 0x3c, 0xb8, 0x41, 0x93, 0xb5, 0x60, 0x61, 0x93, 0xb8, 0x63, 0x2c, 0x16,
    0x78, 0xfc, 0x47, 0x81, 0x94, 0x2a, 0xbc, 0x36, 0x6c, 0xea, 0x86, 0x8f, 0x18, 0x0a, 0xa8, 0xdb,
];

// RECLAIM_PAYOUT_OPENING_DOMAIN: the domain tag of context "escrow_reclaim_payout_opening"
global RECLAIM_PAYOUT_OPENING_DOMAIN: Field =
    0x2881c3c5884c7b6f25f880e448cfc78e5d28f5d313d6890207b568221c727626;

// The payout opening commitment the seller signs binds the payout owner, the
// slot-0 output data hash, and the arena hash, both opened from the delivery
// commitment.
fn payout_opening_commitment(
    private_value: PrivateValue,
    output_data_hashes: [Field; S_OUTPUTS],
    arena_hash: Field,
    payout_owner_commitment: Field,
    payout_opening_blinder: Field,
) -> Field {
    assert(
        delivery_commitment(output_data_hashes, arena_hash) == private_value.delivery_commitment,
        "output data hashes and arena hash must open the delivery commitment",
    );
    pcash_hash([
        RECLAIM_PAYOUT_OPENING_DOMAIN,
        payout_opening_blinder,
        payout_owner_commitment,
        output_data_hashes[0],
        arena_hash,
    ])
}

// Seller-signed reclaim terms. A designated issuance route opens to the
// signed recipient; an open route carries no recipient.
fn reclaim_message(
    pcash_chain_id: Field,
    escrow_contract: Field,
    offer_id: Field,
    asset_id: Field,
    recipient: Field,
    payout_amount: Field,
    private_value: PrivateValue,
    issuance_recipient: Field,
    issuance_note_secret: Field,
    payout_opening: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
) -> [Field; 16] {
    assert_issuance_opening(private_value, issuance_recipient, issuance_note_secret);
    [
        pcash_chain_id,
        escrow_contract,
        offer_id,
        asset_id,
        recipient,
        payout_amount,
        private_value.open_fee_amount,
        issuance_recipient,
        private_value.issuance_owner_commitment,
        relay_fee_amount,
        relay_fee_owner_commitment,
        private_value.account_creation_commitment,
        transaction_context::<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>(
            pcash_chain_id,
            private_value.nullifiers,
        ),
        private_value.not_before_timestamp,
        private_value.valid_until_timestamp,
        payout_opening,
    ]
}

fn main(
    recent_pcash_block_hash: Field,
    pcash_chain_id: Field,
    fee_paid: bool,
    configuration: Configuration,
    signature: Signature,
    pubkey: Secp256k1PubKey,
    escrow_contract: Field,
    recipient: Field,
    issuance_recipient: Field,
    issuance_note_secret: Field,
    payout_opening_blinder: Field,
    private_value: PrivateValue,
    output_data_hashes: [Field; S_OUTPUTS],
    arena_hash: Field,
    escrow_note: EscrowNoteOpening,
    escrow_output_index: Field,
    payout_note_secret: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    // The seller signs the recipient as an address.
    assert_address(recipient);
    let payout_owner_commitment = owner_commitment(recipient, payout_note_secret);
    let (_, payout_amount) = assert_escrow_release(
        private_value,
        fee_paid,
        Note {
            owner: escrow_contract,
            note_secret: escrow_note.note_secret,
            asset_id: escrow_note.asset_id,
            amount: escrow_note.amount,
        },
        escrow_output_index,
        payout_owner_commitment,
        relay_fee_amount,
        relay_fee_owner_commitment,
    );
    let payout_opening = payout_opening_commitment(
        private_value,
        output_data_hashes,
        arena_hash,
        payout_owner_commitment,
        payout_opening_blinder,
    );

    // The signed message carries the same chain ID the action commitment binds.
    let signing_domain = SigningDomain {
        domain_separator_high: configuration.domain_separator_high,
        domain_separator_low: configuration.domain_separator_low,
    };
    signature.verify(
        signing_domain.signing_hash(
            MARKETPLACE_RECLAIM_TYPE_HASH,
            reclaim_message(
                pcash_chain_id,
                escrow_contract,
                configuration.offer_id,
                escrow_note.asset_id,
                recipient,
                payout_amount,
                private_value,
                issuance_recipient,
                issuance_note_secret,
                payout_opening,
                relay_fee_amount,
                relay_fee_owner_commitment,
            ),
        ),
        pubkey,
    );

    // A claim must expire by `deadline_t`, and the buyer checks before paying
    // that both functions commit the same deadline, so a reclaim executes only
    // after every timely claim could have.
    assert(
        !timestamp_le(private_value.not_before_timestamp, configuration.deadline_t),
        "reclaim must start after the offer deadline",
    );

    let seller = pubkey.ethereum_address();
    rule_statement(
        authorization_commitment(
            escrow_contract,
            reclaim_configuration_commitment(seller, configuration),
        ),
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
        Configuration, payout_opening_commitment, reclaim_configuration_commitment, reclaim_message,
        RECLAIM_PAYOUT_OPENING_DOMAIN,
    };
    use escrow_common::test_support::{
        RELEASE_ARENA_HASH, release_output_data_hashes, release_transaction, sample_escrow_note,
    };
    use pcash_protocol::ledger::note::owner_commitment;
    use pcash_protocol::ledger::private_value::SmallPrivateValue as PrivateValue;
    use pcash_protocol::primitives::hash::pcash_hash;

    global DESIGNATED_RECIPIENT: Field = 0xabc;
    global DESIGNATED_SECRET: Field = 0x123;

    fn private_value(issuance_owner_commitment: Field) -> PrivateValue {
        let mut private_value = release_transaction(sample_escrow_note(0), 7, 0x55, 93, 7);
        private_value.issuance_owner_commitment = issuance_owner_commitment;
        private_value.not_before_timestamp = 1000;
        private_value.valid_until_timestamp = 2000;
        private_value
    }

    fn designated() -> PrivateValue {
        private_value(owner_commitment(DESIGNATED_RECIPIENT, DESIGNATED_SECRET))
    }

    fn message_on(
        pcash_chain_id: Field,
        tx: PrivateValue,
        issuance_recipient: Field,
        issuance_note_secret: Field,
    ) -> [Field; 16] {
        reclaim_message(
            pcash_chain_id,
            0x2222,
            0x42,
            0,
            0x3333,
            93,
            tx,
            issuance_recipient,
            issuance_note_secret,
            0x44,
            0,
            0,
        )
    }

    fn message(
        tx: PrivateValue,
        issuance_recipient: Field,
        issuance_note_secret: Field,
    ) -> [Field; 16] {
        message_on(7, tx, issuance_recipient, issuance_note_secret)
    }

    fn configuration() -> Configuration {
        Configuration {
            configuration_salt: 1,
            offer_id: 0x42,
            deadline_t: 1000,
            domain_separator_high: 0xfaf4c1be8b91555f6d023ae6675c7aff,
            domain_separator_low: 0x300bb3b6d97d0305ac50dd198dd16bff,
        }
    }

    #[test]
    fn test_reclaim_configuration_commitment_binds_authority_time_and_signing_domain() {
        let base = reclaim_configuration_commitment(0xabc, configuration());
        assert(base != reclaim_configuration_commitment(0xabd, configuration()));
        let mut changed = configuration();
        changed.configuration_salt = 2;
        assert(base != reclaim_configuration_commitment(0xabc, changed));
        changed = configuration();
        changed.offer_id = 0x43;
        assert(base != reclaim_configuration_commitment(0xabc, changed));
        changed = configuration();
        changed.deadline_t = 1001;
        assert(base != reclaim_configuration_commitment(0xabc, changed));
        changed = configuration();
        changed.domain_separator_high += 1;
        assert(base != reclaim_configuration_commitment(0xabc, changed));
        changed = configuration();
        changed.domain_separator_low += 1;
        assert(base != reclaim_configuration_commitment(0xabc, changed));
    }

    #[test]
    fn test_signs_the_pcash_chain() {
        let fields = message_on(7, private_value(0), 0, 0);
        assert(fields[0] == 7);
        assert(fields != message_on(8, private_value(0), 0, 0));
    }

    #[test]
    fn test_signs_the_open_route() {
        let fields = message(private_value(0), 0, 0);
        assert(fields[6] == 7);
        assert(fields[7] == 0);
        assert(fields[8] == 0);
    }

    #[test]
    fn test_signs_the_designated_route() {
        let tx = designated();
        let fields = message(tx, DESIGNATED_RECIPIENT, DESIGNATED_SECRET);
        assert(fields[7] == DESIGNATED_RECIPIENT);
        assert(fields[8] == tx.issuance_owner_commitment);
        assert(fields != message(private_value(0), 0, 0));
    }

    #[test]
    fn test_signs_the_escrow_asset() {
        let native = message(private_value(0), 0, 0);
        let token = reclaim_message(
            7,
            0x2222,
            0x42,
            0x7070,
            0x3333,
            93,
            private_value(0),
            0,
            0,
            0x44,
            0,
            0,
        );
        assert(native[3] == 0);
        assert(token[3] == 0x7070);
        assert(native != token);
    }

    fn opening_over(blinder: Field, output_data_hash: Field, arena_hash: Field) -> Field {
        pcash_hash(
            [RECLAIM_PAYOUT_OPENING_DOMAIN, blinder, 0x55, output_data_hash, arena_hash],
        )
    }

    #[test]
    fn test_payout_opening_binds_the_slot_0_data_hash_and_arena_hash() {
        let opening = payout_opening_commitment(
            private_value(0),
            release_output_data_hashes(),
            RELEASE_ARENA_HASH,
            0x55,
            0x77,
        );
        assert(opening == opening_over(0x77, release_output_data_hashes()[0], RELEASE_ARENA_HASH));
        assert(opening != opening_over(0x77, release_output_data_hashes()[1], RELEASE_ARENA_HASH));
    }

    // The seller's software chooses the blinder, zero included.
    #[test]
    fn test_payout_opening_accepts_a_zero_blinder() {
        let opening = payout_opening_commitment(
            private_value(0),
            release_output_data_hashes(),
            RELEASE_ARENA_HASH,
            0x55,
            0,
        );
        assert(opening == opening_over(0, release_output_data_hashes()[0], RELEASE_ARENA_HASH));
    }

    #[test(should_fail_with = "output data hashes and arena hash must open the delivery commitment")]
    fn test_payout_opening_rejects_an_arena_hash_outside_the_delivery_commitment() {
        let _ = payout_opening_commitment(
            private_value(0),
            release_output_data_hashes(),
            RELEASE_ARENA_HASH + 1,
            0x55,
            0x77,
        );
    }

    #[test(should_fail_with = "issuance owner commitment must open to the named recipient")]
    fn test_rejects_another_designated_recipient() {
        let _ = message(designated(), DESIGNATED_RECIPIENT + 1, DESIGNATED_SECRET);
    }

    #[test(should_fail_with = "issuance owner commitment must open to the named recipient")]
    fn test_rejects_another_designated_secret() {
        let _ = message(designated(), DESIGNATED_RECIPIENT, DESIGNATED_SECRET + 1);
    }

    #[test(should_fail_with = "open issuance recipient must be zero")]
    fn test_rejects_a_named_recipient_on_the_open_route() {
        let _ = message(private_value(0), DESIGNATED_RECIPIENT, 0);
    }

    // The open route opens nothing, so its secret witness is unread.
    #[test]
    fn test_open_route_ignores_the_secret_witness() {
        assert(message(private_value(0), 0, DESIGNATED_SECRET) == message(private_value(0), 0, 0));
    }
}
