// The issuance recipient a reference rule signs, opened against the issuance
// owner commitment the private value carries. A zero commitment leaves the
// issuance open to the poster, so the signed recipient is zero; otherwise it
// names one recipient address and note secret.

use crate::payout::{ISSUANCE_ROLE, payout_note_secret, payout_seed};
use pcash_protocol::ledger::note::owner_commitment;
use pcash_protocol::ledger::private_value::PrivateValue;
use pcash_protocol::primitives::range::assert_address;

pub fn assert_issuance_opening<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    issuance_recipient: Field,
    issuance_note_secret: Field,
) {
    assert_address(issuance_recipient);
    if private_value.issuance_owner_commitment == 0 {
        assert(issuance_recipient == 0, "open issuance recipient must be zero");
    } else {
        assert(
            private_value.issuance_owner_commitment
                == owner_commitment(issuance_recipient, issuance_note_secret),
            "issuance owner commitment must open to the named recipient",
        );
    }
}

/// The issuance opening of an owner-only rule. When the signer designates its
/// own address, the secret must be the one its payout seed derives for this
/// transaction, so a restore from the seed recovers the payout.
pub fn assert_owner_issuance_opening<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    private_value: PrivateValue<N_IN, N_OUT, SHAPE>,
    transaction_context: Field,
    signer_address: Field,
    nk_root: Field,
    issuance_recipient: Field,
    issuance_note_secret: Field,
) {
    assert_issuance_opening(private_value, issuance_recipient, issuance_note_secret);
    if issuance_recipient == signer_address {
        assert(
            issuance_note_secret
                == payout_note_secret(payout_seed(nk_root), ISSUANCE_ROLE, transaction_context),
            "self issuance secret must derive from the payout seed",
        );
    }
}

mod tests {
    use crate::payout::{ISSUANCE_ROLE, payout_note_secret, payout_seed};
    use crate::test_support::{TEST_NK_ROOT, TEST_SIGNER, TestPrivateValue};
    use super::{assert_issuance_opening, assert_owner_issuance_opening};
    use pcash_protocol::ledger::note::owner_commitment;

    global CONTEXT: Field = 0x7777;

    fn quoted_issuance() -> TestPrivateValue {
        TestPrivateValue {
            open_fee_amount: 7,
            issuance_owner_commitment: owner_commitment(0xabc, 0x123),
            not_before_timestamp: 0,
            valid_until_timestamp: 100,
            carrier_context_hash: 0,
            asset_burn_amount: 0,
            delivery_commitment: 0,
            input_slot_classes: [0; 4],
            input_commitments: [0; 4],
            nullifiers: [11, 12, 13, 14],
            output_slot_classes: [0; 5],
            output_body_commitments: [1; 5],
        }
    }

    fn self_issuance(secret: Field) -> TestPrivateValue {
        let mut private_value = quoted_issuance();
        private_value.issuance_owner_commitment = owner_commitment(TEST_SIGNER, secret);
        private_value
    }

    #[test]
    fn test_accepts_the_quoted_issuance_opening() {
        assert_issuance_opening(quoted_issuance(), 0xabc, 0x123);
    }

    // A zero secret opens like any other: its privacy is the quoting wallet's
    // concern, and the recipient can spend the payout.
    #[test]
    fn test_accepts_a_named_recipient_under_a_zero_secret() {
        let mut private_value = quoted_issuance();
        private_value.issuance_owner_commitment = owner_commitment(0xabc, 0);
        assert_issuance_opening(private_value, 0xabc, 0);
    }

    #[test(should_fail_with = "issuance owner commitment must open to the named recipient")]
    fn test_rejects_same_recipient_with_changed_secret() {
        assert_issuance_opening(quoted_issuance(), 0xabc, 0x124);
    }

    #[test(should_fail_with = "issuance owner commitment must open to the named recipient")]
    fn test_rejects_another_issuance_recipient() {
        assert_issuance_opening(quoted_issuance(), 0xabd, 0x123);
    }

    #[test(should_fail_with = "open issuance recipient must be zero")]
    fn test_open_issuance_rejects_a_named_recipient() {
        let mut private_value = quoted_issuance();
        private_value.issuance_owner_commitment = 0;
        assert_issuance_opening(private_value, 0xabc, 0);
    }

    // The open route opens nothing, so its secret witness is unread.
    #[test]
    fn test_open_issuance_ignores_the_secret_witness() {
        let mut private_value = quoted_issuance();
        private_value.issuance_owner_commitment = 0;
        assert_issuance_opening(private_value, 0, 0x123);
    }

    #[test]
    fn test_accepts_a_designated_route_to_address_zero() {
        let mut private_value = quoted_issuance();
        private_value.issuance_owner_commitment = owner_commitment(0, 0x123);
        assert_issuance_opening(private_value, 0, 0x123);
    }

    #[test]
    fn test_self_issuance_accepts_the_seed_derived_secret() {
        let secret = payout_note_secret(payout_seed(TEST_NK_ROOT), ISSUANCE_ROLE, CONTEXT);
        assert_owner_issuance_opening(
            self_issuance(secret),
            CONTEXT,
            TEST_SIGNER,
            TEST_NK_ROOT,
            TEST_SIGNER,
            secret,
        );
    }

    // A self-designated issuance under a secret the seed does not derive would
    // be recoverable only by the software that built the transaction.
    #[test(should_fail_with = "self issuance secret must derive from the payout seed")]
    fn test_self_issuance_rejects_a_free_secret() {
        assert_owner_issuance_opening(
            self_issuance(0xbad5ec),
            CONTEXT,
            TEST_SIGNER,
            TEST_NK_ROOT,
            TEST_SIGNER,
            0xbad5ec,
        );
    }

    #[test(should_fail_with = "self issuance secret must derive from the payout seed")]
    fn test_self_issuance_rejects_another_transaction_context() {
        let secret = payout_note_secret(payout_seed(TEST_NK_ROOT), ISSUANCE_ROLE, CONTEXT);
        assert_owner_issuance_opening(
            self_issuance(secret),
            CONTEXT + 1,
            TEST_SIGNER,
            TEST_NK_ROOT,
            TEST_SIGNER,
            secret,
        );
    }

    // A relayer's quoted secret is its own; only the signer's own address is forced.
    #[test]
    fn test_issuance_to_another_recipient_keeps_its_quoted_secret() {
        assert_owner_issuance_opening(
            quoted_issuance(),
            CONTEXT,
            TEST_SIGNER,
            TEST_NK_ROOT,
            0xabc,
            0x123,
        );
    }
}
