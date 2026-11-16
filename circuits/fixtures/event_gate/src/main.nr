// A permissionless rule whose installed configuration requires one event.
use pcash_protocol::authorization::statement::{
    authorization_commitment, rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::generated::pcash_constants::EVENT_ENTRY_DOMAIN;
use pcash_protocol::primitives::hash::pcash_hash;

fn main(
    address: Field,
    action_commitment: Field,
    recent_pcash_block_hash: Field,
    application_vk_hash: Field,
    required_event: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    let required_entry = pcash_hash([EVENT_ENTRY_DOMAIN, application_vk_hash, required_event]);
    // The installed configuration binds the application identity and contents.
    rule_statement(
        authorization_commitment(address, required_entry),
        action_commitment,
        recent_pcash_block_hash,
        required_entry,
    )
}

mod tests {
    use super::main;
    use pcash_protocol::authorization::statement::{assert_rule_statement, authorization_commitment};
    use pcash_protocol::events::event_entry;

    #[test]
    fn configured_event_can_authorize_each_sponsored_role() {
        let entry = event_entry(7, 9);
        // Each role has its own account and action, while both see the same event.
        assert_rule_statement(
            main(1, 11, 3, 7, 9),
            authorization_commitment(1, entry),
            11,
            3,
            entry,
        );
        assert_rule_statement(
            main(2, 12, 3, 7, 9),
            authorization_commitment(2, entry),
            12,
            3,
            entry,
        );
    }

    #[test(should_fail_with = "rule statement must match the kernel's statement")]
    fn primary_cannot_return_a_different_entry() {
        let entry = event_entry(7, 9);
        assert_rule_statement(
            main(1, 11, 3, 7, 9),
            authorization_commitment(1, entry),
            11,
            3,
            event_entry(8, 9),
        );
    }

    #[test(should_fail_with = "rule statement must match the kernel's statement")]
    fn sponsor_cannot_return_a_different_entry() {
        let entry = event_entry(7, 9);
        assert_rule_statement(
            main(2, 12, 3, 7, 9),
            authorization_commitment(2, entry),
            12,
            3,
            0,
        );
    }
}
