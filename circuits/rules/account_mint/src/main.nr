// The account-mint rule: one configured account mints the asset whenever its
// own rule approves. The rule reads no private value. The kernel names the
// account it authenticated in the mint context, so the statement matches only
// when that account is the configured one, and the account's rule approves the
// whole mint action: every marker and every output. One verification key
// serves both profiles.

use pcash_protocol::authorization::statement::{rule_statement, RULE_STATEMENT_LENGTH};
use pcash_protocol::ledger::asset::mint_context;
use pcash_protocol::primitives::hash::pcash_hash;
use reference_rule_common::generated::reference_rule_constants::REFERENCE_ACCOUNT_MINT_CONFIGURATION_DOMAIN;

pub fn configuration_commitment(account_address: Field) -> Field {
    pcash_hash(
        [REFERENCE_ACCOUNT_MINT_CONFIGURATION_DOMAIN, account_address],
    )
}

// The kernel binds every input by requiring the returned statement to equal its
// own; `account_address` is both the configured and the authenticated account.
fn main(
    recent_pcash_block_hash: Field,
    asset_id: Field,
    account_address: Field,
    valid_until_timestamp: Field,
    action_commitment: Field,
    event_entry: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    rule_statement(
        mint_context(
            asset_id,
            configuration_commitment(account_address),
            account_address,
            valid_until_timestamp,
        ),
        action_commitment,
        recent_pcash_block_hash,
        event_entry,
    )
}

mod tests {
    use super::{configuration_commitment, main};
    use pcash_protocol::ledger::asset::mint_context;

    #[test]
    fn test_returns_the_configured_accounts_statement() {
        let statement = main(2, 0x7a55e7, 0x0e1, 1000, 0xac7, 0);
        assert(
            statement
                == [
                    mint_context(0x7a55e7, configuration_commitment(0x0e1), 0x0e1, 1000),
                    0xac7,
                    2,
                    0,
                ],
        );
    }

    // Another account derives another configuration, so its statement does not
    // match a context naming the configured account.
    #[test]
    fn test_another_account_yields_another_context() {
        let configured = mint_context(0x7a55e7, configuration_commitment(0x0e1), 0x0f1, 1000);
        let statement = main(2, 0x7a55e7, 0x0f1, 1000, 0xac7, 0);
        assert(statement[0] != configured);
    }
}
