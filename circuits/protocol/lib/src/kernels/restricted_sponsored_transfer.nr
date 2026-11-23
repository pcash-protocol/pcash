// The restricted sponsored-transfer kernel: the sponsored-transfer kernel's
// relation for an asset with a transfer rule, plus the rule's proof. The asset
// inputs' owner is the primary contract, never the fee payer, so the policy
// statement names the contract. Folding order: primary contract's rule, fee
// payer's rule, policy, event application.

use crate::authorization::authentication::AuthorizedAccount;
use crate::authorization::statement::{assert_rule_statement, RULE_STATEMENT_LENGTH};
use crate::events::{EVENT_STATEMENT_LENGTH, events_commitment, verify_event};
use crate::kernels::sponsored_transfer::{sponsored_action, SponsoredAction};
use crate::ledger::asset::{policy_context, restricted_asset_id, RestrictedAssetOpening};
use crate::ledger::fee_payment::{NativeChange, NativeRelayOutput};
use crate::ledger::private_value::{PrivateValueChoices, transaction_statement};
use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use crate::primitives::types::InputNoteWitness;
use crate::recursion::{AppVerificationKey, verify_first_app, verify_next_app};

pub fn restricted_sponsored_transfer<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    choices: PrivateValueChoices<N_IN, N_OUT>,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    asset_output_amounts: [Field; N_OUT],
    native_change: NativeChange,
    native_relay_output: NativeRelayOutput,
    asset: RestrictedAssetOpening,
    dummy_input_seed: Field,
    replay_ids: [Field; N_IN],
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
    account_state_root: Field,
    state_account_siblings: [Field; STATE_TREE_DEPTH],
    primary: AuthorizedAccount,
    fee_payer: AuthorizedAccount,
    owner_inputs: [InputNoteWitness; N_IN],
    primary_statement: [Field; RULE_STATEMENT_LENGTH],
    primary_vk: AppVerificationKey,
    fee_statement: [Field; RULE_STATEMENT_LENGTH],
    fee_vk: AppVerificationKey,
    policy_statement: [Field; RULE_STATEMENT_LENGTH],
    policy_vk: AppVerificationKey,
    event_statement: [Field; EVENT_STATEMENT_LENGTH],
    event_application_vk: AppVerificationKey,
    event_salt: Field,
) -> [Field; N_IN + N_OUT + 11] {
    let asset_id = restricted_asset_id::<SHAPE>(asset, policy_vk.hash);
    let action: SponsoredAction<N_IN, N_OUT, SHAPE> = sponsored_action(
        pcash_chain_id,
        recent_pcash_block_hash,
        choices,
        output_owner_commitments,
        output_dummy_secrets,
        asset_output_amounts,
        native_change,
        native_relay_output,
        asset_id,
        dummy_input_seed,
        replay_ids,
        block_header_state_siblings,
        output_root,
        state_output_siblings,
        account_state_root,
        state_account_siblings,
        primary,
        fee_payer,
        owner_inputs,
        primary_vk.hash,
        fee_vk.hash,
    );
    verify_first_app(primary_vk);
    verify_next_app(fee_vk);
    verify_next_app(policy_vk);
    let entry = verify_event(
        event_statement,
        event_application_vk,
        action.action,
        recent_pcash_block_hash,
    );
    assert_rule_statement(
        primary_statement,
        action.primary_authorization,
        action.action,
        recent_pcash_block_hash,
        entry,
    );
    assert_rule_statement(
        fee_statement,
        action.fee_authorization,
        action.fee_action,
        recent_pcash_block_hash,
        entry,
    );
    assert_rule_statement(
        policy_statement,
        policy_context(
            asset_id,
            asset.configuration_commitment,
            action.primary_address,
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
