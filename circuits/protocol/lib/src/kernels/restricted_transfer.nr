// The restricted-transfer kernel: the transfer kernel's relation for an asset
// with a transfer rule, plus the rule's proof. It derives the asset ID from
// the definition's core and transfer rule, requires the restricted class, at
// least one real asset input and unconditional account membership, and folds
// the rule's application for this profile beside the owner's rule and the
// event application. Folding order: owner's rule, policy, event application.

use crate::authorization::authentication::AuthorizedAccount;
use crate::authorization::statement::{assert_rule_statement, RULE_STATEMENT_LENGTH};
use crate::events::{EVENT_STATEMENT_LENGTH, events_commitment, verify_event};
use crate::kernels::transfer::{one_account_action, OneAccountAction};
use crate::ledger::asset::{policy_context, restricted_asset_id, RestrictedAssetOpening};
use crate::ledger::private_value::{PrivateValueChoices, transaction_statement};
use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use crate::primitives::types::InputNoteWitness;
use crate::recursion::{AppVerificationKey, verify_first_app, verify_next_app};

pub fn restricted_transfer<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    choices: PrivateValueChoices<N_IN, N_OUT>,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
    asset: RestrictedAssetOpening,
    dummy_input_seed: Field,
    // Rule-defined replay identity per APPLICATION slot; ignored otherwise.
    replay_ids: [Field; N_IN],
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
    account_state_root: Field,
    state_account_siblings: [Field; STATE_TREE_DEPTH],
    account: AuthorizedAccount,
    account_kind: Field,
    owner_inputs: [InputNoteWitness; N_IN],
    rule_statement: [Field; RULE_STATEMENT_LENGTH],
    authorization_vk: AppVerificationKey,
    policy_statement: [Field; RULE_STATEMENT_LENGTH],
    policy_vk: AppVerificationKey,
    event_statement: [Field; EVENT_STATEMENT_LENGTH],
    event_application_vk: AppVerificationKey,
    event_salt: Field,
) -> [Field; N_IN + N_OUT + 11] {
    let asset_id = restricted_asset_id::<SHAPE>(asset, policy_vk.hash);
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
        false,
    );
    // Every opened amount is positive, so a zero total means no asset input.
    assert(action.asset_amount != 0, "restricted transfer must spend an asset input");

    verify_first_app(authorization_vk);
    verify_next_app(policy_vk);
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
    assert_rule_statement(
        policy_statement,
        policy_context(
            asset_id,
            asset.configuration_commitment,
            action.owner_address,
            choices.valid_until_timestamp,
        ),
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
