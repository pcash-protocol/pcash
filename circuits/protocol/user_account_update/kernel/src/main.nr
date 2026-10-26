// Fixed protocol kernel for a user-account compare-and-swap update that funds
// its own fee. Any installed rule that returns the account-update action may
// authorize it; the selected rule and its witness remain private.
//
// The update carries a private-value section: the account's native notes fund
// the open fee, an optional private relay output, and account change. The
// public statement is the private-value fields followed by the account update
// commitment, which the node recomputes from live state. The authorizing rule
// approves the update's action commitment, which binds that account update
// commitment together with the exact fee payment, so one authorization covers
// the transition, the fee, its nullifiers, and its change.

use pcash_protocol::authorization::account::{ACCOUNT_KIND_USER, account_update_commitment};
use pcash_protocol::authorization::authentication::open_account_leaf;
use pcash_protocol::authorization::statement::{
    account_update_action_commitment, assert_rule_statement, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::events::{EVENT_STATEMENT_LENGTH, events_commitment, verify_event};
use pcash_protocol::generated::private_value_profiles::{
    S_INPUTS as N_IN, S_OUTPUTS as N_OUT, S_PUBLIC_INPUTS,
};
use pcash_protocol::ledger::fee_payment::{native_fee_payment, NativeChange, NativeRelayOutput};
use pcash_protocol::ledger::opening::open_output_root;
use pcash_protocol::ledger::private_value::{
    account_action_statement, PrivateValueChoices, SmallPrivateValue,
};
use pcash_protocol::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use pcash_protocol::primitives::types::{AccountRuleMembershipWitness, InputNoteWitness};
use pcash_protocol::recursion::{AppVerificationKey, verify_first_app};

fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    choices: PrivateValueChoices<N_IN, N_OUT>,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    native_change: NativeChange,
    native_relay_output: NativeRelayOutput,
    dummy_input_seed: Field,
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
    address: Field,
    nk_root: Field,
    current_account_revision: Field,
    current_receive_key_hash: Field,
    new_account_state_commitment: Field,
    configuration_commitment: Field,
    commitment_blinder: Field,
    account_rule_witness: AccountRuleMembershipWitness,
    native_inputs: [InputNoteWitness; N_IN],
    rule_statement: call_data(1) [Field; RULE_STATEMENT_LENGTH],
    authorization_vk: AppVerificationKey,
    event_statement: call_data(2) [Field; EVENT_STATEMENT_LENGTH],
    event_application_vk: AppVerificationKey,
    event_salt: Field,
) -> return_data [Field; S_PUBLIC_INPUTS + 1] {
    assert(choices.account_creation_commitment == 0, "account updates cannot attach a creation");
    // The node binds both rows, including the successor revision, through the
    // public account update commitment, so only the current row is opened here.
    let (current_account_state_commitment, account) = open_account_leaf(
        address,
        nk_root,
        ACCOUNT_KIND_USER,
        current_account_revision,
        current_receive_key_hash,
        authorization_vk.hash,
        configuration_commitment,
        commitment_blinder,
        account_rule_witness,
    );

    // The fee payment: the account's own notes fund the fee under the recent
    // block's output root.
    let _ = open_output_root(
        recent_pcash_block_hash,
        block_header_state_siblings,
        output_root,
        state_output_siblings,
    );
    let (private_value, commitment): (SmallPrivateValue, Field) = native_fee_payment(
        choices,
        account,
        output_root,
        native_inputs,
        dummy_input_seed,
        output_owner_commitments,
        output_dummy_secrets,
        native_change,
        native_relay_output,
    );

    let update_commitment = account_update_commitment(
        current_account_state_commitment,
        new_account_state_commitment,
    );
    let action = account_update_action_commitment(pcash_chain_id, commitment, update_commitment);
    verify_first_app(authorization_vk);
    let entry = verify_event(
        event_statement,
        event_application_vk,
        action,
        recent_pcash_block_hash,
    );
    assert_rule_statement(
        rule_statement,
        account.authorization,
        action,
        recent_pcash_block_hash,
        entry,
    );
    account_action_statement(
        pcash_chain_id,
        recent_pcash_block_hash,
        private_value,
        events_commitment(entry, event_salt),
        update_commitment,
    )
}
