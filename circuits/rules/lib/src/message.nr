// The signed message of the reference value rules: the PCASH chain ID, the
// rule's own fields, each declared output as (recipient, amount, asset_id), and
// nine fields every value message ends with: the open fee, the issuance route,
// the relay terms, the account creation, the transaction context and the validity window.
//
// The chain ID is the same witness the rule hashes into its action commitment,
// so a signature approves an action on one chain only.
//
// Each message has two types. With no native burn the signer signs the base
// type. With a burn the signer signs its `WithBurn` variant, which inserts the
// network fee and the voluntary burn after the open fee; the two sum to the
// private value's native burn.

use crate::configuration::Configuration;
use crate::issuance_opening::assert_owner_issuance_opening;
use crate::payout::transaction_context;
use crate::value_rule::OutputDeclaration;
use pcash_protocol::ledger::private_value::PrivateValue;
use pcash_protocol::primitives::range::assert_amount;
use signature_common::eip712::{domain_separator, flat_message_signing_hash_either};
use signature_common::secp256k1::{Secp256k1PubKey, Signature};

/// The native burn as a `WithBurn` message shows it.
pub struct NativeBurn {
    pub network_fee_amount: Field,
    pub voluntary_burn_amount: Field,
}

/// Binds the signed split to `native_burn_amount` and returns whether the
/// message is the `WithBurn` variant. A zero burn forces a zero split and
/// the base type; a positive burn takes the variant.
pub fn native_burn_variant(native_burn_amount: Field, native_burn: NativeBurn) -> bool {
    assert_amount(native_burn.network_fee_amount);
    assert_amount(native_burn.voluntary_burn_amount);
    assert(
        native_burn_amount == native_burn.network_fee_amount + native_burn.voluntary_burn_amount,
        "native burn must equal the signed network fee plus voluntary burn",
    );
    native_burn_amount != 0
}

/// The signing hash of a message whose open fee is `fields[open_fee_index]`,
/// under `type_hash` or, with a native burn, under `with_burn_type_hash` with
/// the split after the open fee.
pub fn burn_message_signing_hash<let N: u32>(
    configuration: Configuration,
    type_hash: [u8; 32],
    with_burn_type_hash: [u8; 32],
    fields: [Field; N],
    open_fee_index: u32,
    native_burn_amount: Field,
    native_burn: NativeBurn,
) -> [u8; 32] {
    flat_message_signing_hash_either(
        domain_separator(
            configuration.domain_separator_high,
            configuration.domain_separator_low,
        ),
        type_hash,
        with_burn_type_hash,
        fields,
        open_fee_index + 1,
        [native_burn.network_fee_amount, native_burn.voluntary_burn_amount],
        native_burn_variant(native_burn_amount, native_burn),
    )
}

// The owner's approval of a value message: the issuance route it names opens
// as the owner directed, and the signer signed the message. The signature
// binds the transaction context (chain ID, profile and nullifiers); the
// issuance opening also uses it when the signer designates its own address.
// Callers pass `signer_address = pubkey.ethereum_address()`, which their
// relation also reads; this function does not check it.
pub fn verify_value_message<let P: u32, let D: u32, let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    signature: Signature,
    pubkey: Secp256k1PubKey,
    signer_address: Field,
    configuration: Configuration,
    type_hash: [u8; 32],
    with_burn_type_hash: [u8; 32],
    pcash_chain_id: Field,
    nk_root: Field,
    fields: [Field; P],
    outputs: [OutputDeclaration; D],
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    issuance_recipient: Field,
    issuance_note_secret: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    native_burn: NativeBurn,
) {
    let context =
        transaction_context::<N_IN, N_OUT, SHAPE>(pcash_chain_id, private_value.nullifiers);
    assert_owner_issuance_opening(
        private_value,
        context,
        signer_address,
        nk_root,
        issuance_recipient,
        issuance_note_secret,
    );
    signature.verify(
        burn_message_signing_hash(
            configuration,
            type_hash,
            with_burn_type_hash,
            value_message(
                pcash_chain_id,
                fields,
                outputs,
                private_value,
                issuance_recipient,
                relay_fee_amount,
                relay_fee_owner_commitment,
                context,
            ),
            1 + P + 3 * D,
            private_value.native_burn_amount,
            native_burn,
        ),
        pubkey,
    );
}

fn value_message<let P: u32, let D: u32, let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    fields: [Field; P],
    outputs: [OutputDeclaration; D],
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    issuance_recipient: Field,
    relay_fee_amount: Field,
    relay_fee_owner_commitment: Field,
    context: Field,
) -> [Field; 1 + P + 3 * D + 9] {
    let mut message = [0; 1 + P + 3 * D + 9];
    message[0] = pcash_chain_id;
    for i in 0..P {
        message[1 + i] = fields[i];
    }
    for i in 0..D {
        message[1 + P + 3 * i] = outputs[i].recipient;
        message[2 + P + 3 * i] = outputs[i].amount;
        message[3 + P + 3 * i] = outputs[i].asset_id;
    }
    let terms = [
        private_value.open_fee_amount,
        issuance_recipient,
        private_value.issuance_owner_commitment,
        relay_fee_amount,
        relay_fee_owner_commitment,
        private_value.account_creation_commitment,
        context,
        private_value.not_before_timestamp,
        private_value.valid_until_timestamp,
    ];
    for i in 0..9 {
        message[1 + P + 3 * D + i] = terms[i];
    }
    message
}
