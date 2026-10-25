// Application policy: all native value inputs qualify under one fixed root.
mod policy;

use pcash_protocol::authorization::statement::transfer_action_commitment;
use pcash_protocol::events::{
    event_entry, event_statement, EVENT_STATEMENT_LENGTH, events_commitment,
};
use pcash_protocol::generated::private_value_profiles::{S_INPUTS, S_OUTPUTS, S_PUBLIC_INPUTS};
use pcash_protocol::ledger::note::{note_body_commitment, output_commitment};
use pcash_protocol::ledger::private_value::{
    private_value_commitment, SLOT_CLASS_ASSET, SLOT_CLASS_NATIVE, SmallPrivateValue,
};
use pcash_protocol::primitives::params::BLOCK_HEADER_TREE_DEPTH;
use pcash_protocol::state::block::{block_header_fact, BLOCK_HEADER_KEY_HISTORY_ROOT};
use pcash_protocol::state::l1_logs::{
    assert_normalized_log, L1LogGrounding, normalized_log_leaf, split_bytes32_128,
};
use pcash_protocol::state::results::{
    assert_result, payout_result_leaf, PayoutResult, ResultOpening, statement_hash,
    transaction_result_leaf, TransactionResult,
};
use policy::{approved_source, DenyGap, lineage_claim, not_denied, policy_root, PolicyPath};

struct LineageInput {
    is_source: bool,
    result_opening: ResultOpening,
    payout: PayoutResult,
    source_path: PolicyPath,
    transaction_result: TransactionResult,
    transaction_statement: [Field; S_PUBLIC_INPUTS],
    output_slot: u32,
    event_salt: Field,
    qualification_mask: Field,
    deny_gap: DenyGap,
}

fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    private_value: SmallPrivateValue,
    provider: Field,
    approved_sources_root: Field,
    deny_gaps_root: Field,
    root_sequence: u64,
    publication: L1LogGrounding,
    lineage_vk_identity: Field,
    history_root: Field,
    history_root_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    inputs: [LineageInput; S_INPUTS],
) -> return_data [Field; EVENT_STATEMENT_LENGTH] {
    let root = policy_root(provider, approved_sources_root, deny_gaps_root);
    let root_bytes: [u8; 32] = root.to_be_bytes();
    let (root_high, root_low) = split_bytes32_128(root_bytes);
    let log = normalized_log_leaf(
        publication.transaction_index,
        publication.log_index,
        provider,
        1,
        [0x3296e74c5b880bf6433decb15707da1c, 0xff416a6f6f9cebbfccc66deed185c63f, 0, 0, 0, 0, 0, 0],
        64,
        [root_high, root_low, 0, root_sequence as Field, 0, 0, 0, 0],
    );
    assert_normalized_log(recent_pcash_block_hash, publication, log);
    block_header_fact(
        recent_pcash_block_hash,
        BLOCK_HEADER_KEY_HISTORY_ROOT,
        history_root,
        history_root_siblings,
    );
    for i in 0..S_INPUTS {
        assert(
            private_value.input_slot_classes[i] != SLOT_CLASS_ASSET,
            "lineage supports native value only",
        );
        if private_value.input_slot_classes[i] == SLOT_CLASS_NATIVE {
            let input = inputs[i];
            let commitment = private_value.input_commitments[i];
            not_denied(deny_gaps_root, commitment, input.deny_gap);
            let mut result_leaf = 0;
            if input.is_source {
                // The kernel opens this input with a nonzero amount, which is
                // the issuance amount once the fee is zero.
                assert(input.payout.open_fee_amount == 0, "fees are not approved issuance sources");
                let body = note_body_commitment(
                    input.payout.owner_commitment,
                    0,
                    input.payout.issuance_amount,
                );
                assert(
                    output_commitment(body, input.payout.output_index) == commitment,
                    "source must be the spent input note",
                );
                approved_source(approved_sources_root, commitment, input.source_path);
                result_leaf = payout_result_leaf(input.payout);
            } else {
                assert(
                    input.transaction_result.tx_type == 0,
                    "lineage predecessor must be a private value transaction",
                );
                assert(
                    input.transaction_result.funding_mode == 0,
                    "private value predecessor funding mode must be zero",
                );
                assert(
                    input.transaction_result.outcome == 0,
                    "lineage predecessor must have succeeded",
                );
                assert(
                    input.transaction_statement[0] == pcash_chain_id,
                    "lineage predecessor must use the same chain",
                );
                assert(
                    statement_hash(input.transaction_statement)
                        == input.transaction_result.statement_hash,
                    "predecessor statement must match its result",
                );
                assert(input.output_slot < S_OUTPUTS, "predecessor output slot must be in range");
                let mask: [bool; S_OUTPUTS] = input.qualification_mask.to_le_bits();
                assert(mask[input.output_slot], "predecessor output slot must be qualified");
                let previous_claim =
                    lineage_claim(root, lineage_vk_identity, input.qualification_mask);
                assert(
                    events_commitment(
                        event_entry(lineage_vk_identity, previous_claim),
                        input.event_salt,
                    )
                        == input.transaction_statement[S_PUBLIC_INPUTS - 1],
                    "predecessor event must use the trusted lineage application and policy",
                );
                let body = input.transaction_statement[2 + S_INPUTS + input.output_slot];
                let output_index =
                    input.transaction_result.output_start_index + input.output_slot as Field;
                assert(
                    output_commitment(body, output_index) == commitment,
                    "predecessor output must be the spent input note",
                );
                result_leaf = transaction_result_leaf(input.transaction_result);
            }
            assert_result(
                recent_pcash_block_hash,
                history_root,
                input.result_opening,
                result_leaf,
                input.is_source,
            );
        }
    }
    let mut qualification_mask: u32 = 0;
    for i in 0..S_OUTPUTS {
        assert(
            private_value.output_slot_classes[i] != SLOT_CLASS_ASSET,
            "lineage supports native outputs only",
        );
        if private_value.output_slot_classes[i] == SLOT_CLASS_NATIVE {
            qualification_mask += 1 << i;
        }
    }
    event_statement(
        transfer_action_commitment(pcash_chain_id, private_value_commitment(private_value)),
        recent_pcash_block_hash,
        lineage_claim(root, lineage_vk_identity, qualification_mask as Field),
    )
}
