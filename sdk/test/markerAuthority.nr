// Test-only installed authority for a note-free, one-shot action. The existing
// claim fixture requires a positive payout, and multisig only opens S actions.
// A contract function takes its address as a witness; the kernel compares the
// returned authorization commitment with the account it authenticated.
use pcash_protocol::authorization::statement::{
    authorization_commitment, rule_statement, RULE_STATEMENT_LENGTH, transfer_action_commitment,
};
use pcash_protocol::generated::private_value_profiles::{
    L_INPUTS, MAX_INPUTS, MAX_OUTPUTS, S_INPUTS, S_SHAPE_ID,
};
use pcash_protocol::ledger::note::application_nullifier;
use pcash_protocol::ledger::private_value::{SLOT_CLASS_APPLICATION, SLOT_CLASS_DUMMY};
use pcash_protocol::primitives::hash::pcash_hash;
use reference_rule_common::composite::{composite_private_value_commitment, CompositePrivateValue};

fn main(
    pcash_chain_id: Field,
    recent_pcash_block_hash: Field,
    event_entry: Field,
    address: Field,
    shape: u32,
    private_value: CompositePrivateValue,
    secret: Field,
    selected_entry_commitment: Field,
) -> return_data [Field; RULE_STATEMENT_LENGTH] {
    let replay_id = pcash_hash([2, secret]);
    let marker = application_nullifier(address, selected_entry_commitment, replay_id);
    let inputs = if shape == S_SHAPE_ID {
        S_INPUTS
    } else {
        L_INPUTS
    };
    let mut markers: Field = 0;
    for i in 0..MAX_INPUTS {
        if i < inputs {
            if private_value.input_slot_classes[i] == SLOT_CLASS_APPLICATION {
                assert(
                    private_value.nullifiers[i] == marker,
                    "application marker must be the marker authority's replay marker",
                );
                markers += 1;
            } else {
                assert(
                    private_value.input_slot_classes[i] == SLOT_CLASS_DUMMY,
                    "marker authority input must be dummy or application",
                );
            }
        }
    }
    assert(markers == 1, "marker authority must carry one replay marker");
    for i in 0..MAX_OUTPUTS {
        assert(
            private_value.output_slot_classes[i] == SLOT_CLASS_DUMMY,
            "marker authority output must be dummy",
        );
    }
    // With no value input, the kernel's conservation forces a zero open fee
    // and burn.
    assert(
        private_value.issuance_owner_commitment == 0,
        "marker authority must not designate an issuance owner",
    );
    rule_statement(
        authorization_commitment(address, pcash_hash([1, secret])),
        transfer_action_commitment(
            pcash_chain_id,
            composite_private_value_commitment(shape, private_value),
        ),
        recent_pcash_block_hash,
        event_entry,
    )
}
