// The mint kernel: the only relation that creates asset value. It opens the
// asset's definition, derives the asset ID with the VK hash of the mint rule it
// folds, and requires the class the definition's transfer rule implies. One
// authenticated account, a user or a contract, approves the mint and pays for
// it from its own native notes. The mint rule decides what may be minted: the
// kernel requires at least one mint marker, so no mint lands twice, and bounds
// neither the amount nor the outputs. Folding order: the account's rule, the
// mint rule, the event application.

use crate::authorization::authentication::{AccountOpening, authenticate, AuthorizedAccount};
use crate::authorization::statement::{
    assert_rule_statement, mint_action_commitment, RULE_STATEMENT_LENGTH,
};
use crate::events::{EVENT_STATEMENT_LENGTH, events_commitment, verify_event};
use crate::ledger::asset::{
    assert_asset_class, asset_core_commitment, asset_id, mint_context, mint_marker,
    mint_rule_commitment, profile_vk_hashes,
};
use crate::ledger::note::dummy_nullifier;
use crate::ledger::opening::{application_marker, open_native_notes, open_value_state};
use crate::ledger::private_value::{
    PrivateValue, PrivateValueChoices, SLOT_CLASS_APPLICATION, SLOT_CLASS_DUMMY, SLOT_CLASS_MINT,
    SLOT_CLASS_NATIVE, transaction_statement,
};
use crate::ledger::section::{assert_native_conservation, build_private_value, output_bodies};
use crate::primitives::params::{BLOCK_HEADER_TREE_DEPTH, STATE_TREE_DEPTH};
use crate::primitives::types::InputNoteWitness;
use crate::recursion::{AppVerificationKey, verify_first_app, verify_next_app};

// The opening of an asset definition. The mint rule's VK hash for this profile
// is the folded mint rule's; the definition supplies the other profile's.
pub struct AssetDefinition {
    pub instance_salt: Field,
    pub metadata_commitment: Field,
    pub mint_rule_other_profile_vk_hash: Field,
    pub mint_rule_configuration_commitment: Field,
    pub transfer_rule_commitment: Field,
}

// The ID of the asset a definition describes, with `mint_rule_vk_hash` as this
// profile's mint rule. Folding another application derives another asset.
pub fn minted_asset_id<let SHAPE: u32>(
    definition: AssetDefinition,
    mint_rule_vk_hash: Field,
) -> Field {
    let (s_vk_hash, l_vk_hash) = profile_vk_hashes::<SHAPE>(
        mint_rule_vk_hash,
        definition.mint_rule_other_profile_vk_hash,
    );
    let id = asset_id(
        asset_core_commitment(
            definition.instance_salt,
            definition.metadata_commitment,
            mint_rule_commitment(
                s_vk_hash,
                l_vk_hash,
                definition.mint_rule_configuration_commitment,
            ),
        ),
        definition.transfer_rule_commitment,
    );
    assert_asset_class(id, definition.transfer_rule_commitment != 0);
    id
}

/// Returns the private value of a mint of `asset_id` and its commitment. Inputs
/// are DUMMY padding, the account's NATIVE notes, mint markers, and the
/// account's APPLICATION markers. No ASSET input: this mints the asset.
pub fn mint_relation<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    choices: PrivateValueChoices<N_IN, N_OUT>,
    asset_id: Field,
    account: AccountOpening,
    output_root: Field,
    dummy_input_seed: Field,
    native_inputs: [InputNoteWitness; N_IN],
    replay_ids: [Field; N_IN],
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
) -> (PrivateValue<N_IN, N_OUT, SHAPE>, Field) {
    assert(choices.asset_burn_amount == 0, "asset burn amount must be zero");
    let mut inputs = open_native_notes(
        choices.input_slot_classes,
        account,
        output_root,
        native_inputs,
    );
    let mut has_mint_marker = false;
    for i in 0..N_IN {
        let class = choices.input_slot_classes[i];
        if class == SLOT_CLASS_DUMMY {
            inputs.nullifiers[i] = dummy_nullifier(dummy_input_seed, i as Field);
        } else if class == SLOT_CLASS_MINT {
            inputs.nullifiers[i] = mint_marker(asset_id, replay_ids[i]);
            has_mint_marker = true;
        } else if class == SLOT_CLASS_APPLICATION {
            inputs.nullifiers[i] = application_marker(account, replay_ids[i]);
        } else {
            assert(
                class == SLOT_CLASS_NATIVE,
                "mint input class must be dummy, native, mint, or application",
            );
        }
    }
    // A mint with no marker could land twice.
    assert(has_mint_marker, "a mint carries at least one mint marker");
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
    build_private_value(choices, inputs.input_commitments, inputs.nullifiers, bodies)
}

pub fn mint<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    choices: PrivateValueChoices<N_IN, N_OUT>,
    output_owner_commitments: [Field; N_OUT],
    output_dummy_secrets: [Field; N_OUT],
    output_amounts: [Field; N_OUT],
    definition: AssetDefinition,
    dummy_input_seed: Field,
    // Replay identity per mint marker and per APPLICATION slot; ignored
    // otherwise.
    replay_ids: [Field; N_IN],
    block_header_state_siblings: [Field; BLOCK_HEADER_TREE_DEPTH],
    output_root: Field,
    state_output_siblings: [Field; STATE_TREE_DEPTH],
    account_state_root: Field,
    state_account_siblings: [Field; STATE_TREE_DEPTH],
    account: AuthorizedAccount,
    // A user or a contract account may mint.
    account_kind: Field,
    native_inputs: [InputNoteWitness; N_IN],
    rule_statement: [Field; RULE_STATEMENT_LENGTH],
    authorization_vk: AppVerificationKey,
    mint_statement: [Field; RULE_STATEMENT_LENGTH],
    mint_rule_vk: AppVerificationKey,
    event_statement: [Field; EVENT_STATEMENT_LENGTH],
    event_application_vk: AppVerificationKey,
    event_salt: Field,
) -> [Field; N_IN + N_OUT + 11] {
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
    let asset_id = minted_asset_id::<SHAPE>(definition, mint_rule_vk.hash);

    let (private_value, commitment): (PrivateValue<N_IN, N_OUT, SHAPE>, Field) = mint_relation(
        choices,
        asset_id,
        opening,
        output_root,
        dummy_input_seed,
        native_inputs,
        replay_ids,
        output_owner_commitments,
        output_dummy_secrets,
        output_amounts,
    );

    let action = mint_action_commitment(pcash_chain_id, commitment, asset_id);
    verify_first_app(authorization_vk);
    verify_next_app(mint_rule_vk);
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
    assert_rule_statement(
        mint_statement,
        mint_context(
            asset_id,
            definition.mint_rule_configuration_commitment,
            opening.address,
            choices.valid_until_timestamp,
        ),
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

mod tests {
    use crate::authorization::authentication::AccountOpening;
    use crate::authorization::statement::{assert_rule_statement, mint_action_commitment};
    use crate::ledger::asset::{
        asset_core_commitment, asset_id, mint_context, mint_marker, mint_rule_commitment,
        transfer_rule_commitment,
    };
    use crate::ledger::note::{
        application_nullifier, full_output_commitment, note_body_commitment, nullifier,
    };
    use crate::ledger::opening::application_marker;
    use crate::ledger::private_value::{
        PrivateValue, PrivateValueChoices, SLOT_CLASS_APPLICATION, SLOT_CLASS_ASSET,
        SLOT_CLASS_DUMMY, SLOT_CLASS_MINT, SLOT_CLASS_NATIVE,
    };
    use crate::primitives::params::MERKLE_DEPTH;
    use crate::primitives::types::{InputNoteWitness, Note};
    use crate::state::merkle::binary_root_from_index;
    use super::{AssetDefinition, mint_relation, minted_asset_id};

    global TEST_METADATA: Field = 0xa0a0;
    global TEST_SEED: Field = 0xaaa;
    global TEST_OWNER: Field = 0x111;
    global TEST_ASSET: Field = 0x7a55e7;
    global TEST_REPLAY_ID: Field = 0xdead;
    global S_RULE: Field = 0x5;
    global L_RULE: Field = 0x6;
    global RULE_CONFIGURATION: Field = 0x7;
    global MAX_AMOUNT: Field = 0xffffffffffffffffffffffffffffffff;
    global ACCOUNT: AccountOpening =
        AccountOpening { address: 0x0e1, nk: 0x0e2, entry: 0x0e4, authorization: 0x0e5 };

    // The first salt whose asset ID lands in the restricted class, or in the
    // nonzero unrestricted class.
    fn find_salt(mint_rule: Field, transfer_rule: Field, restricted: bool) -> Field {
        let mut found: Field = 0;
        let mut done = false;
        for salt in 0..64 {
            if !done {
                let id = asset_id(
                    asset_core_commitment(salt as Field, TEST_METADATA, mint_rule),
                    transfer_rule,
                );
                let bits: [bool; 254] = id.to_le_bits();
                let in_class = if restricted {
                    bits[252] & !bits[253]
                } else {
                    !bits[252] & !bits[253] & (id != 0)
                };
                if in_class {
                    found = salt as Field;
                    done = true;
                }
            }
        }
        assert(done);
        found
    }

    fn in_restricted_class(id: Field) -> bool {
        let bits: [bool; 254] = id.to_le_bits();
        bits[252] & !bits[253]
    }

    // A definition whose mint rule is (S_RULE, L_RULE, RULE_CONFIGURATION),
    // opened for the profile whose other VK hash is `other`.
    fn definition(transfer_rule: Field, other: Field) -> AssetDefinition {
        let mint_rule = mint_rule_commitment(S_RULE, L_RULE, RULE_CONFIGURATION);
        AssetDefinition {
            instance_salt: find_salt(mint_rule, transfer_rule, transfer_rule != 0),
            metadata_commitment: TEST_METADATA,
            mint_rule_other_profile_vk_hash: other,
            mint_rule_configuration_commitment: RULE_CONFIGURATION,
            transfer_rule_commitment: transfer_rule,
        }
    }

    fn expected_id(transfer_rule: Field) -> Field {
        let mint_rule = mint_rule_commitment(S_RULE, L_RULE, RULE_CONFIGURATION);
        asset_id(
            asset_core_commitment(
                find_salt(mint_rule, transfer_rule, transfer_rule != 0),
                TEST_METADATA,
                mint_rule,
            ),
            transfer_rule,
        )
    }

    // Each profile's kernel takes its own VK hash from the mint rule it folds
    // and the other profile's from the definition.
    #[test]
    fn test_minted_asset_id_takes_each_profiles_vk_hash_from_the_folded_rule() {
        assert(minted_asset_id::<0>(definition(0, L_RULE), S_RULE) == expected_id(0));
        assert(minted_asset_id::<1>(definition(0, S_RULE), L_RULE) == expected_id(0));
    }

    // Folding another application as the mint rule derives another asset,
    // which almost surely leaves the definition's class.
    #[test]
    fn test_another_folded_mint_rule_derives_another_asset() {
        let mint_rule = mint_rule_commitment(0x9, L_RULE, RULE_CONFIGURATION);
        let other = asset_id(
            asset_core_commitment(
                definition(0, L_RULE).instance_salt,
                TEST_METADATA,
                mint_rule,
            ),
            0,
        );
        assert(other != expected_id(0));
    }

    #[test]
    fn test_restricted_definition_lands_in_the_restricted_class() {
        let rule = transfer_rule_commitment(11, 12, 13);
        let id = minted_asset_id::<0>(definition(rule, L_RULE), S_RULE);
        assert(id == expected_id(rule));
        assert(in_restricted_class(id));
    }

    // A definition whose salt leaves its ID in the wrong class cannot be minted.
    #[test(should_fail)]
    fn test_mint_rejects_a_restricted_definition_in_the_unrestricted_class() {
        let rule = transfer_rule_commitment(11, 12, 13);
        let mut d = definition(rule, L_RULE);
        d.instance_salt = find_salt(
            mint_rule_commitment(S_RULE, L_RULE, RULE_CONFIGURATION),
            rule,
            false,
        );
        let _ = minted_asset_id::<0>(d, S_RULE);
    }

    #[test(should_fail)]
    fn test_mint_rejects_an_unrestricted_definition_in_the_restricted_class() {
        let mut d = definition(0, L_RULE);
        d.instance_salt = find_salt(
            mint_rule_commitment(S_RULE, L_RULE, RULE_CONFIGURATION),
            0,
            true,
        );
        let _ = minted_asset_id::<0>(d, S_RULE);
    }

    struct Fixture<let N_IN: u32, let N_OUT: u32> {
        choices: PrivateValueChoices<N_IN, N_OUT>,
        owners: [Field; N_OUT],
        secrets: [Field; N_OUT],
        amounts: [Field; N_OUT],
        native_inputs: [InputNoteWitness; N_IN],
        replay_ids: [Field; N_IN],
        output_root: Field,
    }

    // Slot zero carries a mint marker and the other inputs are padding. An
    // output with a nonzero amount is an asset note; the rest are padding.
    fn fixture<let N_IN: u32, let N_OUT: u32>(amounts: [Field; N_OUT]) -> Fixture<N_IN, N_OUT> {
        let mut input_slot_classes = [SLOT_CLASS_DUMMY; N_IN];
        input_slot_classes[0] = SLOT_CLASS_MINT;
        let mut replay_ids = [0; N_IN];
        replay_ids[0] = TEST_REPLAY_ID;
        let mut output_slot_classes = [SLOT_CLASS_DUMMY; N_OUT];
        let mut owners = [0; N_OUT];
        let mut secrets = [0; N_OUT];
        for i in 0..N_OUT {
            if amounts[i] != 0 {
                output_slot_classes[i] = SLOT_CLASS_ASSET;
                owners[i] = TEST_OWNER + i as Field;
            } else {
                secrets[i] = (i + 1) as Field;
            }
        }
        Fixture {
            choices: PrivateValueChoices {
                open_fee_amount: 0,
                native_burn_amount: 0,
                issuance_owner_commitment: 0,
                not_before_timestamp: 0,
                valid_until_timestamp: 1,
                carrier_context_hash: 0,
                asset_burn_amount: 0,
                delivery_commitment: 0,
                account_creation_commitment: 0,
                input_slot_classes,
                output_slot_classes,
            },
            owners,
            secrets,
            amounts,
            native_inputs: [
                InputNoteWitness {
                    output_index: 0,
                    note_secret: 0,
                    amount: 0,
                    siblings: [0; MERKLE_DEPTH],
                }; N_IN
            ],
            replay_ids,
            output_root: 0,
        }
    }

    fn one_output() -> Fixture<4, 5> {
        fixture([1_000_000, 0, 0, 0, 0])
    }

    fn build<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
        f: Fixture<N_IN, N_OUT>,
    ) -> (PrivateValue<N_IN, N_OUT, SHAPE>, Field) {
        mint_relation(
            f.choices,
            TEST_ASSET,
            ACCOUNT,
            f.output_root,
            TEST_SEED,
            f.native_inputs,
            f.replay_ids,
            f.owners,
            f.secrets,
            f.amounts,
        )
    }

    fn run<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
        f: Fixture<N_IN, N_OUT>,
    ) -> PrivateValue<N_IN, N_OUT, SHAPE> {
        let (private_value, _) = build(f);
        private_value
    }

    #[test]
    fn test_mint_keys_its_marker_by_replay_id_and_mints_the_asset() {
        let value: PrivateValue<4, 5, 0> = run(one_output());
        assert(value.nullifiers[0] == mint_marker(TEST_ASSET, TEST_REPLAY_ID));
        assert(
            value.output_body_commitments[0]
                == note_body_commitment(TEST_OWNER, TEST_ASSET, 1_000_000),
        );
    }

    // The mint rule bounds what is minted; the kernel does not.
    #[test]
    fn test_mint_has_no_supply_bound() {
        let _: PrivateValue<32, 32, 1> = run(fixture([MAX_AMOUNT; 32]));
    }

    #[test]
    fn test_mint_accepts_several_markers() {
        let mut f = one_output();
        f.choices.input_slot_classes[2] = SLOT_CLASS_MINT;
        f.replay_ids[2] = 2;
        let value: PrivateValue<4, 5, 0> = run(f);
        assert(value.nullifiers[0] == mint_marker(TEST_ASSET, TEST_REPLAY_ID));
        assert(value.nullifiers[2] == mint_marker(TEST_ASSET, 2));
    }

    // The same replay ID derives the same marker whatever else the mint holds,
    // so a retried or re-proved mint is rejected by the spent set.
    #[test]
    fn test_mint_marker_is_independent_of_the_outputs() {
        let first: PrivateValue<4, 5, 0> = run(fixture([5, 0, 0, 0, 0]));
        let second: PrivateValue<4, 5, 0> = run(fixture([6, 1, 0, 0, 0]));
        assert(first.nullifiers[0] == second.nullifiers[0]);
    }

    #[test(should_fail_with = "a mint carries at least one mint marker")]
    fn test_mint_rejects_no_marker() {
        let mut f = one_output();
        f.choices.input_slot_classes[0] = SLOT_CLASS_DUMMY;
        let _: PrivateValue<4, 5, 0> = run(f);
    }

    #[test(should_fail_with = "mint input class must be dummy, native, mint, or application")]
    fn test_mint_rejects_an_asset_input() {
        let mut f = one_output();
        f.choices.input_slot_classes[1] = SLOT_CLASS_ASSET;
        let _: PrivateValue<4, 5, 0> = run(f);
    }

    #[test(should_fail_with = "asset burn amount must be zero")]
    fn test_mint_rejects_an_asset_burn() {
        let mut f = one_output();
        f.choices.asset_burn_amount = 1;
        let _: PrivateValue<4, 5, 0> = run(f);
    }

    #[test(should_fail_with = "real output amount must be nonzero")]
    fn test_mint_rejects_a_zero_amount_asset_output() {
        let mut f = one_output();
        f.choices.output_slot_classes[1] = SLOT_CLASS_ASSET;
        f.owners[1] = TEST_OWNER;
        let _: PrivateValue<4, 5, 0> = run(f);
    }

    #[test(should_fail)]
    fn test_mint_rejects_an_asset_output_above_the_note_amount_range() {
        let _: PrivateValue<4, 5, 0> = run(fixture([MAX_AMOUNT + 1, 0, 0, 0, 0]));
    }

    fn with_application_marker(replay_id: Field) -> Fixture<4, 5> {
        let mut f = one_output();
        f.choices.input_slot_classes[1] = SLOT_CLASS_APPLICATION;
        f.replay_ids[1] = replay_id;
        f
    }

    #[test]
    fn test_mint_derives_the_application_marker_of_the_authorizing_account() {
        let value: PrivateValue<4, 5, 0> = run(with_application_marker(0x7e));
        assert(value.nullifiers[1] == application_marker(ACCOUNT, 0x7e));
        assert(value.nullifiers[1] == application_nullifier(ACCOUNT.address, ACCOUNT.entry, 0x7e));
    }

    // A rule approved the private value with its markers; one built from
    // another replay ID is another private value.
    #[test(should_fail_with = "rule statement must match the kernel's statement")]
    fn test_mint_rejects_an_application_marker_the_rule_did_not_approve() {
        let (_, approved): (PrivateValue<4, 5, 0>, Field) = build(with_application_marker(0x7e));
        let (_, built): (PrivateValue<4, 5, 0>, Field) = build(with_application_marker(0x7f));
        assert_rule_statement(
            [1, mint_action_commitment(7, approved, TEST_ASSET), 2, 0],
            1,
            mint_action_commitment(7, built, TEST_ASSET),
            2,
            0,
        );
    }

    // A mint rule approved a mint by one account; the kernel's context names
    // the account it authenticated.
    #[test(should_fail_with = "rule statement must match the kernel's statement")]
    fn test_mint_rejects_a_mint_rule_statement_for_another_account() {
        let (_, commitment): (PrivateValue<4, 5, 0>, Field) = build(one_output());
        let action = mint_action_commitment(7, commitment, TEST_ASSET);
        assert_rule_statement(
            [mint_context(TEST_ASSET, RULE_CONFIGURATION, 0x0f1, 1), action, 2, 0],
            mint_context(TEST_ASSET, RULE_CONFIGURATION, ACCOUNT.address, 1),
            action,
            2,
            0,
        );
    }

    global FUNDING_NOTE: Note =
        Note { owner: ACCOUNT.address, note_secret: 0x5ec, asset_id: 0, amount: 7 };

    // The one-output fixture funded by the authorizing account's native note
    // of 7 in input slot 1, paying a native output of the given amount in slot 1.
    fn funded(native_output_amount: Field) -> Fixture<4, 5> {
        let mut f = one_output();
        let leaf = full_output_commitment(FUNDING_NOTE, 0);
        f.output_root = binary_root_from_index(leaf, 0, [0; MERKLE_DEPTH]);
        f.choices.input_slot_classes[1] = SLOT_CLASS_NATIVE;
        f.native_inputs[1] = InputNoteWitness {
            output_index: 0,
            note_secret: FUNDING_NOTE.note_secret,
            amount: FUNDING_NOTE.amount,
            siblings: [0; MERKLE_DEPTH],
        };
        f.choices.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        f.owners[1] = TEST_OWNER;
        f.amounts[1] = native_output_amount;
        f
    }

    #[test]
    fn test_mint_spends_the_authorizing_accounts_native_notes() {
        let value: PrivateValue<4, 5, 0> = run(funded(7));
        let leaf = full_output_commitment(FUNDING_NOTE, 0);
        assert(value.input_commitments[1] == leaf);
        assert(value.nullifiers[1] == nullifier(leaf, ACCOUNT.nk, 0x5ec));
    }

    #[test]
    fn test_mint_burns_from_the_authorizing_accounts_native_notes() {
        let mut f = funded(4);
        f.choices.native_burn_amount = 3;
        let value: PrivateValue<4, 5, 0> = run(f);
        assert(value.native_burn_amount == 3);
    }

    // With no fee, no native output and no burn, a mint needs no native input.
    #[test]
    fn test_mint_without_a_native_input_pays_no_fee() {
        let value: PrivateValue<4, 5, 0> = run(one_output());
        assert(value.open_fee_amount == 0);
    }

    #[test(should_fail_with = "native inputs must equal native outputs plus the open fee and the native burn")]
    fn test_mint_rejects_an_unfunded_fee() {
        let mut f = one_output();
        f.choices.open_fee_amount = 1;
        let _: PrivateValue<4, 5, 0> = run(f);
    }

    #[test(should_fail_with = "native inputs must equal native outputs plus the open fee and the native burn")]
    fn test_mint_rejects_a_burn_above_its_native_inputs() {
        let mut f = funded(4);
        f.choices.native_burn_amount = 4;
        let _: PrivateValue<4, 5, 0> = run(f);
    }

    #[test(should_fail_with = "native inputs must equal native outputs plus the open fee and the native burn")]
    fn test_mint_rejects_an_unfunded_native_output() {
        let mut f = one_output();
        f.choices.output_slot_classes[1] = SLOT_CLASS_NATIVE;
        f.owners[1] = TEST_OWNER;
        f.amounts[1] = 7;
        let _: PrivateValue<4, 5, 0> = run(f);
    }
}
