use pcash_protocol::events::EVENT_STATEMENT_LENGTH;
use pcash_protocol::generated::private_value_profiles::{L_INPUTS, L_OUTPUTS, L_SHAPE_ID};
use pcash_protocol::ledger::private_value::PrivateValue;
use pcash_protocol::primitives::types::Note;
use reference_event_common::sender_authentication::sender_authentication;

fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    private_value: PrivateValue<L_INPUTS, L_OUTPUTS, L_SHAPE_ID>,
    sponsored: bool,
    input_slot: u32,
    note: Note,
    output_index: Field,
) -> return_data [Field; EVENT_STATEMENT_LENGTH] {
    sender_authentication::<L_INPUTS, L_OUTPUTS, L_SHAPE_ID>(
        pcash_chain_id,
        recent_pcash_block_hash,
        private_value,
        sponsored,
        input_slot,
        note,
        output_index,
    )
}
