// Shared S/L relation for a CONTRACT asset action sponsored by a USER account.
//
// The primary account moves the asset and owns every APPLICATION marker. A
// distinct fee-payer account contributes native PCASH for the open fee and
// optional private relay output, and receives at most one change note. Nothing
// else about the fee payer is at stake: their exposure is bounded by their own
// native contribution, and what the open fee and relay note leave returns to
// their address. The authorizing rule binds the relay note's amount and
// owner and which change opening it accepts — the reference rule requires the
// owner's derived change secret — because only that rule knows what the fee
// payer approved and which secrets they hold.
//
// The two authorizing accounts have fixed roles: the primary CONTRACT controls
// the asset action; the sponsoring USER funds the open fee or private relay
// output. This is not general multi-owner settlement. Private slot classes
// assign those roles without a per-slot owner field or a public sponsorship-mode
// indicator.
//
// This is a separate CHONK protocol kernel because it consumes two installed
// authorization applications rather than the transfer kernel's one.

use crate::authorization::account::{ACCOUNT_KIND_CONTRACT, ACCOUNT_KIND_USER};
use crate::authorization::authentication::{authenticate, AuthorizedAccount};
use crate::authorization::statement::{
    assert_rule_statement, contract_fee_sponsorship_action_commitment, RULE_STATEMENT_LENGTH,
    sponsored_transfer_action_commitment,
};
use crate::events::{EVENT_STATEMENT_LENGTH, events_commitment, verify_event};
use crate::ledger::fee_payment::{
    assert_native_fee_conservation, native_change_outputs, NativeChange, NativeRelayOutput,
};
use crate::ledger::opening::{open_transfer_inputs, open_value_state};
use crate::ledger::private_value::{
    PrivateValue, PrivateValueChoices, SLOT_CLASS_ASSET, transaction_statement,
};
use crate::ledger::section::{assert_asset_conservation, build_private_value, output_bodies};
use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use crate::primitives::types::InputNoteWitness;
use crate::recursion::{AppVerificationKey, verify_first_app, verify_next_app};

pub fn sponsored_transfer<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    choices: PrivateValueChoices<N_IN, N_OUT>,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    asset_output_amounts: [Field; N_OUT],
    // The fee payer's change note, if any. Its secret is theirs to choose: the
    // change returns to a real party, not to a contract that later provers must
    // be able to reconstruct.
    native_change: NativeChange,
    native_relay_output: NativeRelayOutput,
    asset_id: Field,
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

    // Targeted sponsorship only: a User Account pays the fee for a Contract
    // Account's action. User-to-user sponsorship is excluded from this relation.
    // Both kinds open under one canonical snapshot, which contains one account
    // per address. Their distinct kinds therefore also make their identities distinct.
    let primary_account = authenticate(
        primary,
        ACCOUNT_KIND_CONTRACT,
        primary_vk.hash,
        account_state_root,
    );
    let fee_account = authenticate(
        fee_payer,
        ACCOUNT_KIND_USER,
        fee_vk.hash,
        account_state_root,
    );

    let inputs = open_transfer_inputs(
        choices.input_slot_classes,
        primary_account,
        fee_account,
        output_root,
        asset_id,
        dummy_input_seed,
        owner_inputs,
        replay_ids,
    );
    assert(inputs.asset_amount != 0, "sponsored transfer must spend an asset input");
    assert(inputs.native_amount != 0, "sponsored transfer must spend a native input");

    // --- outputs ---------------------------------------------------------------
    // Native outputs are payer change and, optionally, one private relay note.
    // Asset outputs carry the witnessed asset amounts.
    let (owners, native_amounts) = native_change_outputs(
        choices.output_slot_classes,
        output_owner_commitments,
        fee_account.address,
        native_change,
        native_relay_output,
    );
    let mut output_amounts = native_amounts;
    for i in 0..N_OUT {
        if choices.output_slot_classes[i] == SLOT_CLASS_ASSET {
            output_amounts[i] = asset_output_amounts[i];
        }
    }
    let bodies = output_bodies(
        choices.output_slot_classes,
        asset_id,
        owners,
        output_dummy_secrets,
        output_amounts,
    );

    // --- conservation ----------------------------------------------------------
    assert_asset_conservation(
        inputs.asset_amount,
        choices.output_slot_classes,
        output_amounts,
        choices.asset_burn_amount,
    );
    assert_native_fee_conservation(
        inputs.native_amount,
        choices.open_fee_amount,
        native_change.amount,
        native_relay_output.amount,
    );

    // --- the two authorizations -------------------------------------------------
    let (private_value, commitment): (PrivateValue<N_IN, N_OUT, SHAPE>, Field) =
        build_private_value(choices, inputs.input_commitments, inputs.nullifiers, bodies);
    // The two roles approve the same private value under different domains,
    // so neither approval reads as the other, nor as a one-account transfer.
    // The sponsor's action names the authenticated contract it pays for.
    let action = sponsored_transfer_action_commitment(pcash_chain_id, commitment);
    verify_first_app(primary_vk);
    verify_next_app(fee_vk);
    let entry = verify_event(
        event_statement,
        event_application_vk,
        action,
        recent_pcash_block_hash,
    );
    assert_rule_statement(
        primary_statement,
        primary_account.authorization,
        action,
        recent_pcash_block_hash,
        entry,
    );
    assert_rule_statement(
        fee_statement,
        fee_account.authorization,
        contract_fee_sponsorship_action_commitment(pcash_chain_id, commitment, primary.address),
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
