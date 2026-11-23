// The deposit-mint rule: the asset is minted once per deposit to one Ethereum
// vault, to the PCASH address the deposit commits to. The configuration names
// the vault. The rule opens one `Deposit(depositor, recipientCommitment, nonce,
// amount)` log of the vault through the recent block's L1 origin tree, opens
// the recipient commitment to the chain, the asset, an address and a salt, and
// requires one mint marker keyed by the log's position and the salt and one
// asset output of the deposited amount to that address. The commitment names
// the chain and the asset, so a deposit mints on one chain and one asset only,
// however many assets name the same vault. Only a holder of the commitment's
// opening can prove the mint; any account may submit and pay for it. The
// commitment fixes the salt, so a deposit has one replay ID whatever the
// payer, the anchor or the attempt. The rule opens the S private value: a
// deposit mints one note, which S always fits, and a definition names no L
// verification key.

use pcash_protocol::authorization::statement::{
    mint_action_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_SHAPE_ID};
use pcash_protocol::ledger::asset::{mint_context, mint_marker};
use pcash_protocol::ledger::note::{note_body_commitment, owner_commitment};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, PrivateValue, SLOT_CLASS_ASSET, SLOT_CLASS_MINT,
};
use pcash_protocol::primitives::hash::pcash_hash;
use pcash_protocol::state::l1_logs::{assert_normalized_log, L1LogGrounding, normalized_log_leaf};
use reference_rule_common::generated::reference_rule_constants::{
    REFERENCE_DEPOSIT_MINT_CONFIGURATION_DOMAIN, REFERENCE_DEPOSIT_RECIPIENT_DOMAIN,
    REFERENCE_DEPOSIT_REPLAY_DOMAIN,
};

// keccak256("Deposit(address,bytes32,bytes32,uint256)") as big-endian 128-bit
// halves.
pub global DEPOSIT_TOPIC0_HIGH: Field = 0x6d06ca7726c7d8bc263bc28d3b225203;
pub global DEPOSIT_TOPIC0_LOW: Field = 0xf440dc69a5650bc9ce8bdf6a5687cce3;
// abi.encode(recipientCommitment, nonce, amount).
global DEPOSIT_DATA_LENGTH: Field = 96;
global TWO_POW_128: Field = 0x100000000000000000000000000000000;

// The log's indexed depositor and its data as the log's 128-bit chunks carry
// them, and the log's opening. `amount` is the low chunk of its word.
pub struct Deposit {
    pub depositor_high: Field,
    pub depositor_low: Field,
    pub recipient_commitment_high: Field,
    pub recipient_commitment_low: Field,
    pub nonce_high: Field,
    pub nonce_low: Field,
    pub amount: Field,
    pub log: L1LogGrounding,
}

pub fn configuration_commitment(vault: Field) -> Field {
    pcash_hash([REFERENCE_DEPOSIT_MINT_CONFIGURATION_DOMAIN, vault])
}

pub fn recipient_commitment(
    pcash_chain_id: Field,
    asset_id: Field,
    recipient_address: Field,
    salt: Field,
) -> Field {
    pcash_hash([
        REFERENCE_DEPOSIT_RECIPIENT_DOMAIN,
        pcash_chain_id,
        asset_id,
        recipient_address,
        salt,
    ])
}

// The replay ID of the deposit at a log position: the log's Ethereum block,
// its leaf index in that block's normalized log tree, which is its index among
// the block's logs, and the salt of its recipient commitment.
pub fn deposit_replay_id(l1_block_number: Field, log_leaf_index: Field, salt: Field) -> Field {
    pcash_hash(
        [REFERENCE_DEPOSIT_REPLAY_DOMAIN, l1_block_number, log_leaf_index, salt],
    )
}

pub fn deposit_mint_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    asset_id: Field,
    account_address: Field,
    event_entry: Field,
    vault: Field,
    deposit: Deposit,
    recipient_address: Field,
    salt: Field,
    note_secret: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
) -> [Field; RULE_STATEMENT_LENGTH] {
    // The leaf fixes the amount word's high chunk to zero, so the amount is
    // below 2^128.
    let log_leaf = normalized_log_leaf(
        deposit.log.transaction_index,
        deposit.log.log_index,
        vault,
        2,
        [
            DEPOSIT_TOPIC0_HIGH,
            DEPOSIT_TOPIC0_LOW,
            deposit.depositor_high,
            deposit.depositor_low,
            0,
            0,
            0,
            0,
        ],
        DEPOSIT_DATA_LENGTH,
        [
            deposit.recipient_commitment_high,
            deposit.recipient_commitment_low,
            deposit.nonce_high,
            deposit.nonce_low,
            0,
            deposit.amount,
            0,
            0,
        ],
    );
    assert_normalized_log(recent_pcash_block_hash, deposit.log, log_leaf);

    // A word at or above the field modulus recomposes to its residue; the
    // deposit still mints once, to whoever opens that residue.
    assert(
        deposit.recipient_commitment_high * TWO_POW_128 + deposit.recipient_commitment_low
            == recipient_commitment(pcash_chain_id, asset_id, recipient_address, salt),
        "recipient commitment must open to the chain, asset, recipient address and salt",
    );

    let marker = mint_marker(
        asset_id,
        deposit_replay_id(
            deposit.log.l1_block_number,
            deposit.log.log_leaf_index,
            salt,
        ),
    );
    let mut markers: Field = 0;
    for i in 0..N_IN {
        if private_value.input_slot_classes[i] == SLOT_CLASS_MINT {
            assert(
                private_value.nullifiers[i] == marker,
                "mint marker must be the deposit's marker",
            );
            markers += 1;
        }
    }
    assert(markers == 1, "a deposit mint carries exactly one mint marker");

    let note_body = note_body_commitment(
        owner_commitment(recipient_address, note_secret),
        asset_id,
        deposit.amount,
    );
    let mut asset_outputs: Field = 0;
    for i in 0..N_OUT {
        if private_value.output_slot_classes[i] == SLOT_CLASS_ASSET {
            assert(
                private_value.output_body_commitments[i] == note_body,
                "asset output must be the deposited amount to the recipient",
            );
            asset_outputs += 1;
        }
    }
    assert(asset_outputs == 1, "a deposit mint carries exactly one asset output");

    rule_statement(
        mint_context(
            asset_id,
            configuration_commitment(vault),
            account_address,
            private_value.valid_until_timestamp,
        ),
        mint_action_commitment(
            pcash_chain_id,
            private_value_commitment(private_value),
            asset_id,
        ),
        recent_pcash_block_hash,
        event_entry,
    )
}

// The kernel binds `asset_id`, `account_address`, the chain, the anchor and
// the event entry by requiring the returned statement to equal its own.
fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    asset_id: Field,
    account_address: Field,
    event_entry: Field,
    vault: Field,
    deposit: Deposit,
    recipient_address: Field,
    salt: Field,
    note_secret: Field,
    private_value: PrivateValue<S_INPUTS, S_OUTPUTS, S_SHAPE_ID>,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    deposit_mint_relation(
        pcash_chain_id,
        recent_pcash_block_hash,
        asset_id,
        account_address,
        event_entry,
        vault,
        deposit,
        recipient_address,
        salt,
        note_secret,
        private_value,
    )
}

mod tests {
    use super::{
        configuration_commitment, Deposit, deposit_mint_relation, deposit_replay_id,
        DEPOSIT_TOPIC0_HIGH, DEPOSIT_TOPIC0_LOW, main, recipient_commitment,
    };
    use pcash_protocol::authorization::statement::{mint_action_commitment, RULE_STATEMENT_LENGTH};
    use pcash_protocol::ledger::asset::{mint_context, mint_marker};
    use pcash_protocol::ledger::note::{note_body_commitment, owner_commitment};
    use pcash_protocol::ledger::private_value::{
        private_value_commitment, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET, SLOT_CLASS_DUMMY,
        SLOT_CLASS_MINT, SLOT_CLASS_NATIVE,
    };
    use pcash_protocol::primitives::params::{L1_LOG_TREE_DEPTH, L1_ORIGIN_TREE_DEPTH};
    use pcash_protocol::state::block::{block_hash_from_opening, BLOCK_HEADER_KEY_L1_ORIGIN_ROOT};
    use pcash_protocol::state::l1_logs::{
        l1_origin_leaf, L1LogGrounding, normalized_log_leaf, split_bytes32_128,
    };
    use pcash_protocol::state::merkle::binary_root_from_index;
    use reference_rule_common::test_support::{small_transaction, TestPrivateValue};

    global CHAIN: Field = 7;
    global ASSET: Field = 0x1000000000000000000000000000000000000000000000000000000000000abc;
    global ACCOUNT: Field = 0x0e1;
    global EVENT_ENTRY: Field = 0xe7;
    global VAULT: Field = 0x5fbdb2315678afecb367f032d93f642f64180aa3;
    global DEPOSITOR: Field = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8;
    global RECIPIENT: Field = 0x2000000000000000000000000000000000000002;
    global SALT: Field = 0x5a175a175a17;
    global NOTE_SECRET: Field = 0x5ec2e7;
    global NONCE_HIGH: Field = 0x0123456789abcdef0123456789abcdef;
    global NONCE_LOW: Field = 0xfedcba9876543210fedcba9876543210;
    global AMOUNT: Field = 25_000_000;
    global BLOCK: Field = 100;
    global BLOCK_TIME: Field = 1700000000;
    global TRANSACTION: Field = 5;
    global LOG: Field = 2;
    // The log's index among its block's logs, its leaf index in the block's
    // normalized log tree.
    global LEAF: Field = 9;
    global VALID_UNTIL: Field = 1700000600;

    // Frozen from the SDK (sdk/test/depositMint.test.ts asserts the same
    // values): the configuration of VAULT, the commitment to (CHAIN, ASSET,
    // RECIPIENT, SALT), the replay ID of the deposit at block 100, leaf 9 with
    // SALT, and that deposit's log leaf at transaction 5, log 2 with topic0
    // keccak256("Deposit(address,bytes32,bytes32,uint256)").
    global KAT_CONFIGURATION_COMMITMENT: Field =
        0x06b24a08cbfb721b7ccd71c0805827fd569c9fb2d8ccc449a5dc6e31a7f85966;
    global KAT_RECIPIENT_COMMITMENT: Field =
        0x0f5c1561fce3763c7ae4953554d2821ea9c79431f923ea92b9a155ea1624350e;
    global KAT_REPLAY_ID: Field =
        0x2d9331bd5d257f4c2bf113e8c1d8c4da60c693afbadeb1540e285bb979766ffb;
    global KAT_LOG_LEAF: Field = 0x0bf98494c808c146f56dfe018766bacebabe0a5608e76973ebe43ad929443569;

    fn halves(value: Field) -> (Field, Field) {
        split_bytes32_128(value.to_be_bytes())
    }

    // The log the node commits for a deposit to `committed_recipient` from
    // `emitter`, with `amount_high` above AMOUNT in the amount word.
    fn committed_leaf(emitter: Field, committed_recipient: Field, amount_high: Field) -> Field {
        let (depositor_high, depositor_low) = halves(DEPOSITOR);
        let (recipient_high, recipient_low) = halves(committed_recipient);
        normalized_log_leaf(
            TRANSACTION,
            LOG,
            emitter,
            2,
            [DEPOSIT_TOPIC0_HIGH, DEPOSIT_TOPIC0_LOW, depositor_high, depositor_low, 0, 0, 0, 0],
            96,
            [recipient_high, recipient_low, NONCE_HIGH, NONCE_LOW, amount_high, AMOUNT, 0, 0],
        )
    }

    // The rule's deposit witness for a log carrying `committed_recipient`,
    // opened at leaf index LEAF against a recent block, built as the tests in
    // pcash_protocol::state::l1_logs build theirs.
    fn opened(committed_recipient: Field, leaf: Field) -> (Field, Deposit) {
        let log_siblings: [Field; L1_LOG_TREE_DEPTH] = [0; L1_LOG_TREE_DEPTH];
        let logs_root = binary_root_from_index(leaf, LEAF, log_siblings);
        let block_leaf = l1_origin_leaf(BLOCK, 0xaaaa, 0xbbbb, BLOCK_TIME, logs_root, LEAF + 1);
        let l1_origin_siblings: [Field; L1_ORIGIN_TREE_DEPTH] = [0; L1_ORIGIN_TREE_DEPTH];
        let l1_origin_root = binary_root_from_index(block_leaf, 0, l1_origin_siblings);
        let header_siblings = [7, 8, 9, 10];
        let recent = block_hash_from_opening(
            l1_origin_root,
            BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
            header_siblings,
        );
        let log = L1LogGrounding {
            l1_origin_root_siblings: header_siblings,
            l1_block_number: BLOCK,
            l1_block_hash_high: 0xaaaa,
            l1_block_hash_low: 0xbbbb,
            l1_block_timestamp: BLOCK_TIME,
            l1_origin_index: 0,
            l1_origin_siblings,
            log_count: LEAF + 1,
            log_leaf_index: LEAF,
            log_siblings,
            transaction_index: TRANSACTION,
            log_index: LOG,
        };
        let (depositor_high, depositor_low) = halves(DEPOSITOR);
        let (recipient_commitment_high, recipient_commitment_low) = halves(committed_recipient);
        (
            recent,
            Deposit {
                depositor_high,
                depositor_low,
                recipient_commitment_high,
                recipient_commitment_low,
                nonce_high: NONCE_HIGH,
                nonce_low: NONCE_LOW,
                amount: AMOUNT,
                log,
            },
        )
    }

    fn marker(block: Field, leaf: Field, salt: Field) -> Field {
        mint_marker(ASSET, deposit_replay_id(block, leaf, salt))
    }

    fn note(recipient: Field, amount: Field) -> Field {
        note_body_commitment(owner_commitment(recipient, NOTE_SECRET), ASSET, amount)
    }

    // A mint whose slot 0 carries `mint_marker`, slot 1 the paying account's
    // native note, and whose output slot 1 is `asset_output` after a native
    // change output in slot 0.
    fn private_value(mint_marker: Field, asset_output: Field) -> TestPrivateValue {
        let mut value = TestPrivateValue {
            open_fee_amount: 1,
            native_burn_amount: 0,
            issuance_owner_commitment: 0,
            not_before_timestamp: 0,
            valid_until_timestamp: VALID_UNTIL,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            account_creation_commitment: 0,
            input_slot_classes: [SLOT_CLASS_DUMMY; 4],
            input_commitments: [0; 4],
            nullifiers: [100, 101, 102, 103],
            output_slot_classes: [SLOT_CLASS_DUMMY; 5],
            output_body_commitments: [200, 201, 202, 203, 204],
        };
        value.input_slot_classes[0] = SLOT_CLASS_MINT;
        value.nullifiers[0] = mint_marker;
        value.input_slot_classes[1] = SLOT_CLASS_NATIVE;
        value.input_commitments[1] = 1;
        value.output_slot_classes[0] = SLOT_CLASS_NATIVE;
        value.output_slot_classes[1] = SLOT_CLASS_ASSET;
        value.output_body_commitments[1] = asset_output;
        value
    }

    fn valid_private_value() -> TestPrivateValue {
        private_value(marker(BLOCK, LEAF, SALT), note(RECIPIENT, AMOUNT))
    }

    // A deposit to RECIPIENT as the vault emits it.
    fn deposited() -> (Field, Deposit) {
        let committed = recipient_commitment(CHAIN, ASSET, RECIPIENT, SALT);
        opened(committed, committed_leaf(VAULT, committed, 0))
    }

    fn run(
        recent: Field,
        deposit: Deposit,
        recipient: Field,
        salt: Field,
        value: TestPrivateValue,
    ) -> [Field; RULE_STATEMENT_LENGTH] {
        deposit_mint_relation(
            CHAIN,
            recent,
            ASSET,
            ACCOUNT,
            EVENT_ENTRY,
            VAULT,
            deposit,
            recipient,
            salt,
            NOTE_SECRET,
            value,
        )
    }

    fn run_with(value: TestPrivateValue) {
        let (recent, deposit) = deposited();
        let _ = run(recent, deposit, RECIPIENT, SALT, value);
    }

    #[test]
    fn test_formulas_match_the_sdk() {
        assert(configuration_commitment(VAULT) == KAT_CONFIGURATION_COMMITMENT);
        assert(recipient_commitment(CHAIN, ASSET, RECIPIENT, SALT) == KAT_RECIPIENT_COMMITMENT);
        assert(deposit_replay_id(BLOCK, LEAF, SALT) == KAT_REPLAY_ID);
        assert(committed_leaf(VAULT, KAT_RECIPIENT_COMMITMENT, 0) == KAT_LOG_LEAF);
    }

    #[test]
    fn test_accepts_a_deposit_mint() {
        let (recent, deposit) = deposited();
        let value = valid_private_value();
        let statement = run(recent, deposit, RECIPIENT, SALT, value);
        assert(
            statement
                == [
                    mint_context(ASSET, KAT_CONFIGURATION_COMMITMENT, ACCOUNT, VALID_UNTIL),
                    mint_action_commitment(CHAIN, private_value_commitment(value), ASSET),
                    recent,
                    EVENT_ENTRY,
                ],
        );
    }

    // The S profile may have one input and one output: a mint without native
    // input fills both.
    #[test]
    fn test_main_accepts_a_deposit_mint_in_slot_zero() {
        let (recent, deposit) = deposited();
        let mut value = small_transaction(0, VALID_UNTIL);
        value.input_slot_classes[0] = SLOT_CLASS_MINT;
        value.nullifiers[0] = marker(BLOCK, LEAF, SALT);
        value.output_slot_classes[0] = SLOT_CLASS_ASSET;
        value.output_body_commitments[0] = note(RECIPIENT, AMOUNT);
        let statement = main(
            CHAIN,
            recent,
            ASSET,
            ACCOUNT,
            EVENT_ENTRY,
            VAULT,
            deposit,
            RECIPIENT,
            SALT,
            NOTE_SECRET,
            value,
        );
        assert(
            statement
                == [
                    mint_context(ASSET, KAT_CONFIGURATION_COMMITMENT, ACCOUNT, VALID_UNTIL),
                    mint_action_commitment(CHAIN, private_value_commitment(value), ASSET),
                    recent,
                    EVENT_ENTRY,
                ],
        );
    }

    // The paying account's own application markers are its rule's business.
    #[test]
    fn test_ignores_the_accounts_application_markers() {
        let mut value = valid_private_value();
        value.input_slot_classes[2] = SLOT_CLASS_APPLICATION;
        run_with(value);
    }

    #[test(should_fail_with = "a deposit mint carries exactly one mint marker")]
    fn test_rejects_a_second_marker() {
        let mut value = valid_private_value();
        value.input_slot_classes[2] = SLOT_CLASS_MINT;
        value.nullifiers[2] = marker(BLOCK, LEAF, SALT);
        run_with(value);
    }

    #[test(should_fail_with = "a deposit mint carries exactly one mint marker")]
    fn test_rejects_a_missing_marker() {
        let mut value = valid_private_value();
        value.input_slot_classes[0] = SLOT_CLASS_DUMMY;
        run_with(value);
    }

    #[test(should_fail_with = "mint marker must be the deposit's marker")]
    fn test_rejects_a_marker_keyed_by_another_salt() {
        run_with(
            private_value(marker(BLOCK, LEAF, SALT + 1), note(RECIPIENT, AMOUNT)),
        );
    }

    #[test(should_fail_with = "mint marker must be the deposit's marker")]
    fn test_rejects_a_marker_keyed_by_another_block() {
        run_with(
            private_value(marker(BLOCK + 1, LEAF, SALT), note(RECIPIENT, AMOUNT)),
        );
    }

    #[test(should_fail_with = "mint marker must be the deposit's marker")]
    fn test_rejects_a_marker_keyed_by_another_leaf() {
        run_with(
            private_value(marker(BLOCK, LEAF + 1, SALT), note(RECIPIENT, AMOUNT)),
        );
    }

    // The replay ID is keyed by the block-wide leaf index, not the log's index
    // within its receipt.
    #[test(should_fail_with = "mint marker must be the deposit's marker")]
    fn test_rejects_a_marker_keyed_by_the_receipt_local_index() {
        run_with(
            private_value(marker(BLOCK, LOG, SALT), note(RECIPIENT, AMOUNT)),
        );
    }

    #[test(should_fail_with = "a deposit mint carries exactly one asset output")]
    fn test_rejects_a_second_asset_output() {
        let mut value = valid_private_value();
        value.output_slot_classes[2] = SLOT_CLASS_ASSET;
        value.output_body_commitments[2] = note(RECIPIENT, AMOUNT);
        run_with(value);
    }

    #[test(should_fail_with = "a deposit mint carries exactly one asset output")]
    fn test_rejects_a_missing_asset_output() {
        let mut value = valid_private_value();
        value.output_slot_classes[1] = SLOT_CLASS_DUMMY;
        run_with(value);
    }

    #[test(should_fail_with = "asset output must be the deposited amount to the recipient")]
    fn test_rejects_an_output_to_another_recipient() {
        run_with(
            private_value(marker(BLOCK, LEAF, SALT), note(RECIPIENT + 1, AMOUNT)),
        );
    }

    #[test(should_fail_with = "asset output must be the deposited amount to the recipient")]
    fn test_rejects_another_amount() {
        run_with(
            private_value(marker(BLOCK, LEAF, SALT), note(RECIPIENT, AMOUNT + 1)),
        );
    }

    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_a_log_from_another_emitter() {
        let committed = recipient_commitment(CHAIN, ASSET, RECIPIENT, SALT);
        let (recent, deposit) = opened(committed, committed_leaf(VAULT + 1, committed, 0));
        let _ = run(recent, deposit, RECIPIENT, SALT, valid_private_value());
    }

    // A word of 2^128 + AMOUNT has the same low chunk as AMOUNT.
    #[test(should_fail_with = "block header field must be in the block header tree")]
    fn test_rejects_an_amount_whose_high_chunk_is_nonzero() {
        let committed = recipient_commitment(CHAIN, ASSET, RECIPIENT, SALT);
        let (recent, deposit) = opened(committed, committed_leaf(VAULT, committed, 1));
        let _ = run(recent, deposit, RECIPIENT, SALT, valid_private_value());
    }

    fn run_committed(committed: Field) {
        let (recent, deposit) = opened(committed, committed_leaf(VAULT, committed, 0));
        let _ = run(recent, deposit, RECIPIENT, SALT, valid_private_value());
    }

    // A deposit committed to another address does not open to RECIPIENT.
    #[test(should_fail_with = "recipient commitment must open to the chain, asset, recipient address and salt")]
    fn test_rejects_a_recipient_commitment_to_another_address() {
        run_committed(recipient_commitment(CHAIN, ASSET, RECIPIENT + 1, SALT));
    }

    // A deposit for one asset does not mint another asset that names the same
    // vault.
    #[test(should_fail_with = "recipient commitment must open to the chain, asset, recipient address and salt")]
    fn test_rejects_a_deposit_for_another_asset() {
        run_committed(recipient_commitment(CHAIN, ASSET + 1, RECIPIENT, SALT));
    }

    // A deposit for one chain does not mint on another chain that derives from
    // the same Ethereum.
    #[test(should_fail_with = "recipient commitment must open to the chain, asset, recipient address and salt")]
    fn test_rejects_a_deposit_for_another_chain() {
        run_committed(recipient_commitment(CHAIN + 1, ASSET, RECIPIENT, SALT));
    }
}
