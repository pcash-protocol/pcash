// The no-op event application makes no additional claim about the transaction.
fn main(action_commitment: Field, recent_pcash_block_hash: Field) -> return_data [Field; 3] {
    [action_commitment, recent_pcash_block_hash, 0]
}
