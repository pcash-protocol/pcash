use pcash_protocol::authorization::statement::contract_action_commitment;
use pcash_protocol::events::{event_statement, EVENT_STATEMENT_LENGTH};
use pcash_protocol::ledger::note::full_output_commitment;
use pcash_protocol::ledger::private_value::{private_value_commitment, PrivateValue};
use pcash_protocol::primitives::types::Note;

// The event attests to the owner of one actual input using its note opening.
pub fn sender_authentication<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    sponsored: bool,
    input_slot: u32,
    note: Note,
    output_index: Field,
) -> [Field; EVENT_STATEMENT_LENGTH] {
    assert(
        full_output_commitment(note, output_index) == private_value.input_commitments[input_slot],
        "sender must open an actual input note",
    );
    event_statement(
        contract_action_commitment(
            pcash_chain_id,
            private_value_commitment(private_value),
            sponsored,
        ),
        recent_pcash_block_hash,
        note.owner,
    )
}
