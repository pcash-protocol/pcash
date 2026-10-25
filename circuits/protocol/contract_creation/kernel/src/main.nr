// Contract-account creation whose protocol fee is paid by a sponsor.
//
// A contract has nothing to spend before it exists, so a User Account sponsor
// contributes native PCASH for the open fee or an optional private relay output
// and receives at most one change note back. The sponsor's installed rule
// authorizes the contract-fee sponsorship action bound to the address being
// created, so the same readable sponsorship rule that pays for a contract's
// asset actions pays for its creation. The node derives the address from the
// unsigned body and supplies it as the last public input, so a proof for one
// body cannot fund another.

use pcash_protocol::authorization::account::ACCOUNT_KIND_USER;
use pcash_protocol::authorization::authentication::{authenticate, AuthorizedAccount};
use pcash_protocol::authorization::statement::{
    assert_rule_statement, contract_fee_sponsorship_action_commitment, RULE_STATEMENT_LENGTH,
};
use pcash_protocol::events::{EVENT_STATEMENT_LENGTH, events_commitment, verify_event};
use pcash_protocol::generated::private_value_profiles::{
    S_INPUTS as N_IN, S_OUTPUTS as N_OUT, S_PUBLIC_INPUTS,
};
use pcash_protocol::ledger::fee_payment::{native_fee_payment, NativeChange, NativeRelayOutput};
use pcash_protocol::ledger::opening::open_value_state;
use pcash_protocol::ledger::private_value::{
    account_action_statement, PrivateValueChoices, SmallPrivateValue,
};
use pcash_protocol::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use pcash_protocol::primitives::types::InputNoteWitness;
use pcash_protocol::recursion::{AppVerificationKey, verify_first_app};

fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    contract_address: Field,
    choices: PrivateValueChoices<N_IN, N_OUT>,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    native_change: NativeChange,
    native_relay_output: NativeRelayOutput,
    dummy_input_seed: Field,
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
    account_state_root: Field,
    state_account_siblings: [Field; STATE_TREE_DEPTH],
    fee_payer: AuthorizedAccount,
    native_inputs: [InputNoteWitness; N_IN],
    fee_statement: call_data(1) [Field; RULE_STATEMENT_LENGTH],
    fee_vk: AppVerificationKey,
    event_statement: call_data(2) [Field; EVENT_STATEMENT_LENGTH],
    event_application_vk: AppVerificationKey,
    event_salt: Field,
) -> return_data [Field; S_PUBLIC_INPUTS + 1] {
    open_value_state(
        recent_pcash_block_hash,
        block_header_state_siblings,
        output_root,
        state_output_siblings,
        account_state_root,
        state_account_siblings,
    );

    // The sponsor is a user account.
    let sponsor = authenticate(
        fee_payer,
        ACCOUNT_KIND_USER,
        fee_vk.hash,
        account_state_root,
    );
    let (private_value, commitment): (SmallPrivateValue, Field) = native_fee_payment(
        choices,
        sponsor,
        output_root,
        native_inputs,
        dummy_input_seed,
        output_owner_commitments,
        output_dummy_secrets,
        native_change,
        native_relay_output,
    );

    let action =
        contract_fee_sponsorship_action_commitment(pcash_chain_id, commitment, contract_address);
    verify_first_app(fee_vk);
    let entry = verify_event(
        event_statement,
        event_application_vk,
        action,
        recent_pcash_block_hash,
    );
    assert_rule_statement(
        fee_statement,
        sponsor.authorization,
        action,
        recent_pcash_block_hash,
        entry,
    );

    account_action_statement(
        pcash_chain_id,
        recent_pcash_block_hash,
        private_value,
        events_commitment(entry, event_salt),
        contract_address,
    )
}
