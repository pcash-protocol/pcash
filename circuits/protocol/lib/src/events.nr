// Applications attest to a transaction without authorizing its ledger transition.
use crate::generated::pcash_constants::{EVENT_DOMAIN, EVENT_ENTRY_DOMAIN};
use crate::primitives::hash::pcash_hash;
use crate::recursion::{AppVerificationKey, verify_next_app};

pub global EVENT_STATEMENT_LENGTH: u32 = 3;

pub fn events_commitment(entry: Field, salt: Field) -> Field {
    pcash_hash([EVENT_DOMAIN, entry, salt])
}

pub fn event_entry(application_vk_hash: Field, event: Field) -> Field {
    pcash_hash([EVENT_ENTRY_DOMAIN, application_vk_hash, event])
}

pub fn event_statement(
    action_commitment: Field,
    recent_pcash_block_hash: Field,
    event: Field,
) -> [Field; EVENT_STATEMENT_LENGTH] {
    [action_commitment, recent_pcash_block_hash, event]
}

pub fn verify_event(
    statement: [Field; EVENT_STATEMENT_LENGTH],
    vk: AppVerificationKey,
    action_commitment: Field,
    recent_pcash_block_hash: Field,
) -> Field {
    verify_next_app(vk);
    assert(statement[0] == action_commitment, "event must bind the transaction action");
    assert(statement[1] == recent_pcash_block_hash, "event must bind the transaction anchor");
    event_entry(vk.hash, statement[2])
}

mod tests {
    use crate::primitives::hash::pcash_hash;
    use crate::recursion::{AppVerificationKey, MEGA_APP_VK_LENGTH_IN_FIELDS};
    use super::{event_entry, events_commitment, verify_event};

    fn vk() -> AppVerificationKey {
        let key = [7; MEGA_APP_VK_LENGTH_IN_FIELDS];
        AppVerificationKey { key, hash: pcash_hash(key) }
    }

    #[test]
    fn event_binds_application_and_salt() {
        let entry = event_entry(1, 2);
        assert(entry != event_entry(2, 2));
        assert(entry != event_entry(1, 3));
        assert(events_commitment(entry, 3) != events_commitment(entry, 4));
        assert(events_commitment(entry, 3) != events_commitment(event_entry(2, 2), 3));
        assert(verify_event([10, 20, 30], vk(), 10, 20) == event_entry(vk().hash, 30));
        assert(verify_event([10, 20, 0], vk(), 10, 20) == event_entry(vk().hash, 0));
    }

    #[test(should_fail_with = "event must bind the transaction action")]
    fn rejects_another_action() {
        let _ = verify_event([11, 20, 30], vk(), 10, 20);
    }

    #[test(should_fail_with = "event must bind the transaction anchor")]
    fn rejects_another_anchor() {
        let _ = verify_event([10, 21, 30], vk(), 10, 20);
    }

}
