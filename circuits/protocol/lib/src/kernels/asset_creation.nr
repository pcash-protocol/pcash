// The asset-creation kernel: the fixed-supply relation, optional native
// funding and application markers from the creating account, and that account's
// selected rule as the first application circuit and the transaction's event
// application as the second. The rule approves the asset ID the relation derives.

use crate::authorization::authentication::{authenticate, AuthorizedAccount};
use crate::authorization::statement::{
    assert_rule_statement, asset_creation_action_commitment, RULE_STATEMENT_LENGTH,
};
use crate::events::{EVENT_STATEMENT_LENGTH, events_commitment, verify_event};
use crate::kernels::fixed_supply::fixed_supply;
use crate::ledger::opening::open_value_state;
use crate::ledger::private_value::{PrivateValue, PrivateValueChoices, transaction_statement};
use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use crate::primitives::types::InputNoteWitness;
use crate::recursion::{AppVerificationKey, verify_first_app};

pub fn asset_creation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    choices: PrivateValueChoices<N_IN, N_OUT>,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
    metadata_commitment: Field,
    initial_supply: Field,
    asset_secret: Field,
    dummy_input_seed: Field,
    // Rule-defined replay identity per APPLICATION slot; ignored otherwise.
    replay_ids: [Field; N_IN],
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
    account_state_root: Field,
    state_account_siblings: [Field; STATE_TREE_DEPTH],
    account: AuthorizedAccount,
    // A user or a contract account may create an asset.
    account_kind: Field,
    native_inputs: [InputNoteWitness; N_IN],
    rule_statement: [Field; RULE_STATEMENT_LENGTH],
    authorization_vk: AppVerificationKey,
    event_statement: [Field; EVENT_STATEMENT_LENGTH],
    event_application_vk: AppVerificationKey,
    event_salt: Field,
) -> [Field; N_IN + N_OUT + 10] {
    open_value_state(
        recent_pcash_block_hash,
        block_header_state_siblings,
        output_root,
        state_output_siblings,
        account_state_root,
        state_account_siblings,
    );
    let opening = authenticate(
        account,
        account_kind,
        authorization_vk.hash,
        account_state_root,
    );

    let (private_value, commitment, asset_id): (PrivateValue<N_IN, N_OUT, SHAPE>, Field, Field) = fixed_supply(
        choices,
        metadata_commitment,
        initial_supply,
        asset_secret,
        opening,
        output_root,
        dummy_input_seed,
        native_inputs,
        replay_ids,
        output_owner_commitments,
        output_dummy_secrets,
        output_amounts,
    );

    let action = asset_creation_action_commitment(pcash_chain_id, commitment, asset_id);
    verify_first_app(authorization_vk);
    let entry = verify_event(
        event_statement,
        event_application_vk,
        action,
        recent_pcash_block_hash,
    );
    assert_rule_statement(
        rule_statement,
        opening.authorization,
        action,
        recent_pcash_block_hash,
        entry,
    );
    transaction_statement(
        pcash_chain_id,
        recent_pcash_block_hash,
        private_value,
        events_commitment(entry, event_salt),
    )
}
