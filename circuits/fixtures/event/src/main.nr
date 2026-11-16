// A permissionless event fixture for testing kernel statement linkage.
use pcash_protocol::events::{event_statement, EVENT_STATEMENT_LENGTH};

fn main(
    action_commitment: Field,
    recent_pcash_block_hash: Field,
    event: Field,
) -> return_data [Field; EVENT_STATEMENT_LENGTH] {
    event_statement(action_commitment, recent_pcash_block_hash, event)
}
