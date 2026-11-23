// The transfer kernel: one account's private-value action. The selected rule is
// the first application circuit and the transaction's event application is the
// second; the rule's private statement is linked through the databus.
// Historical account membership is required unless every input is DUMMY.
// All-dummy actions open a supplied rule set, not installed account authority.
// It moves only assets without a transfer rule; the restricted-transfer kernel
// moves the others with the same relation.

use crate::authorization::authentication::{AuthorizedAccount, open_account};
use crate::authorization::statement::{
    assert_rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use crate::events::{EVENT_STATEMENT_LENGTH, events_commitment, verify_event};
use crate::ledger::asset::assert_unrestricted_asset_id;
use crate::ledger::opening::{open_transfer_inputs, open_value_state};
use crate::ledger::private_value::{
    PrivateValue, PrivateValueChoices, SLOT_CLASS_DUMMY, transaction_statement,
};
use crate::ledger::section::{
    assert_asset_conservation, assert_native_conservation, build_private_value, output_bodies,
};
use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use crate::primitives::types::InputNoteWitness;
use crate::recursion::{AppVerificationKey, verify_first_app};

// A one-account action: its private value, its transfer action, the owner's
// authorization commitment and address, and the total of its asset inputs.
pub struct OneAccountAction<let N_IN: u32, let N_OUT: u32, let SHAPE: u32> {
    pub private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    pub action: Field,
    pub authorization: Field,
    pub owner_address: Field,
    pub asset_amount: Field,
}

// The relation both one-account kernels share. `exempt_all_dummy` waives
// account membership for an action whose every input is DUMMY.
pub fn one_account_action<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    choices: PrivateValueChoices<N_IN, N_OUT>,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
    asset_id: Field,
    dummy_input_seed: Field,
    replay_ids: [Field; N_IN],
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
    account_state_root: Field,
    state_account_siblings: [Field; STATE_TREE_DEPTH],
    account: AuthorizedAccount,
    account_kind: Field,
    owner_inputs: [InputNoteWitness; N_IN],
    authorization_vk_hash: Field,
    exempt_all_dummy: bool,
) -> OneAccountAction<N_IN, N_OUT, SHAPE> {
    open_value_state(
        recent_pcash_block_hash,
        block_header_state_siblings,
        output_root,
        state_output_siblings,
        account_state_root,
        state_account_siblings,
    );

    let (account_root, opening) = open_account(account, account_kind, authorization_vk_hash);
    let mut all_inputs_dummy = exempt_all_dummy;
    for i in 0..N_IN {
        all_inputs_dummy &= choices.input_slot_classes[i] == SLOT_CLASS_DUMMY;
    }
    assert(
        all_inputs_dummy | (account_root == account_state_root),
        "account must be in the account state tree",
    );

    // APPLICATION slots require installed account membership above, even when
    // no note is spent. Positive real outputs still require conserved inputs.
    let inputs = open_transfer_inputs(
        choices.input_slot_classes,
        opening,
        opening,
        output_root,
        asset_id,
        dummy_input_seed,
        owner_inputs,
        replay_ids,
    );
    let bodies = output_bodies(
        choices.output_slot_classes,
        asset_id,
        output_owner_commitments,
        output_dummy_secrets,
        output_amounts,
    );
    assert_native_conservation(
        inputs.native_amount,
        choices.output_slot_classes,
        output_amounts,
        choices.open_fee_amount,
        choices.native_burn_amount,
    );
    assert_asset_conservation(
        inputs.asset_amount,
        choices.output_slot_classes,
        output_amounts,
        choices.asset_burn_amount,
    );

    let (private_value, commitment): (PrivateValue<N_IN, N_OUT, SHAPE>, Field) =
        build_private_value(choices, inputs.input_commitments, inputs.nullifiers, bodies);
    OneAccountAction {
        private_value,
        action: transfer_action_commitment(pcash_chain_id, commitment),
        authorization: opening.authorization,
        owner_address: opening.address,
        asset_amount: inputs.asset_amount,
    }
}

pub fn transfer<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    choices: PrivateValueChoices<N_IN, N_OUT>,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
    asset_id: Field,
    dummy_input_seed: Field,
    // Rule-defined replay identity per APPLICATION slot; ignored otherwise.
    replay_ids: [Field; N_IN],
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
    account_state_root: Field,
    state_account_siblings: [Field; STATE_TREE_DEPTH],
    account: AuthorizedAccount,
    // Bound by account membership unless every input is DUMMY.
    account_kind: Field,
    owner_inputs: [InputNoteWitness; N_IN],
    rule_statement: [Field; RULE_STATEMENT_LENGTH],
    authorization_vk: AppVerificationKey,
    event_statement: [Field; EVENT_STATEMENT_LENGTH],
    event_application_vk: AppVerificationKey,
    event_salt: Field,
) -> [Field; N_IN + N_OUT + 11] {
    // An action with no asset slot leaves the witness unused; zero passes.
    assert_unrestricted_asset_id(asset_id);
    let action: OneAccountAction<N_IN, N_OUT, SHAPE> = one_account_action(
        pcash_chain_id,
        recent_pcash_block_hash,
        choices,
        output_owner_commitments,
        output_dummy_secrets,
        output_amounts,
        asset_id,
        dummy_input_seed,
        replay_ids,
        block_header_state_siblings,
        output_root,
        state_output_siblings,
        account_state_root,
        state_account_siblings,
        account,
        account_kind,
        owner_inputs,
        authorization_vk.hash,
        true,
    );
    verify_first_app(authorization_vk);
    let entry = verify_event(
        event_statement,
        event_application_vk,
        action.action,
        recent_pcash_block_hash,
    );
    assert_rule_statement(
        rule_statement,
        action.authorization,
        action.action,
        recent_pcash_block_hash,
        entry,
    );

    transaction_statement(
        pcash_chain_id,
        recent_pcash_block_hash,
        action.private_value,
        events_commitment(entry, event_salt),
    )
}
