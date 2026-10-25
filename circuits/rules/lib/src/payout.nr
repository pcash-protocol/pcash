// Recoverable ownership (spec Appendix B): payout note secrets for system
// payouts and deterministic output note secrets. These are wallet conventions,
// not consensus; no kernel calls them.

use pcash_protocol::generated::pcash_constants::{
    IMPLICIT_NOTE_SECRET_SEED_DOMAIN, PAYOUT_NOTE_SECRET_DOMAIN, PAYOUT_SEED_DOMAIN,
    PAYOUT_TX_CONTEXT_DOMAIN, TRANSACT_NOTE_SECRET_DOMAIN,
};
use pcash_protocol::ledger::note::note_nk;
use pcash_protocol::primitives::hash::pcash_hash;

pub global ISSUANCE_ROLE: Field = 3;

pub fn payout_seed(nk_root: Field) -> Field {
    pcash_hash([PAYOUT_SEED_DOMAIN, note_nk(nk_root)])
}

pub fn transaction_context<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    pcash_chain_id: Field,
    nullifiers: [Field; N_IN],
) -> Field {
    let mut operands = [0; N_IN + 5];
    operands[0] = PAYOUT_TX_CONTEXT_DOMAIN;
    operands[1] = pcash_chain_id;
    operands[2] = SHAPE as Field;
    operands[3] = N_IN as Field;
    operands[4] = N_OUT as Field;
    for i in 0..N_IN {
        operands[5 + i] = nullifiers[i];
    }
    pcash_hash(operands)
}

pub fn payout_note_secret(seed: Field, role: Field, context: Field) -> Field {
    pcash_hash([PAYOUT_NOTE_SECRET_DOMAIN, seed, role, context])
}

// noteSecretSeed = poseidon(IMPLICIT_NOTE_SECRET_SEED_DOMAIN, nk).
pub fn note_secret_seed(nk: Field) -> Field {
    pcash_hash([IMPLICIT_NOTE_SECRET_SEED_DOMAIN, nk])
}

// noteSecret_i = poseidon(TRANSACT_NOTE_SECRET_DOMAIN, noteSecretSeed,
//                         SHAPE, N_IN, N_OUT, nullifier_0, ..., nullifier_(N_IN-1), i,
//                         outputEntropy_i).
// The complete ordered published nullifiers make the salt unique per accepted transaction
// and independent of output-slot arrangement; they are fixed before any output
// is constructed, so there is no derivation cycle.
// `outputEntropy_i` is a private witness this derivation does not constrain;
// its caller fixes it. Owner change passes 0, so the owner recomputes the
// secret from its key and the published nullifiers. The wallet chooses the
// entropy of every other output it creates.
pub fn note_secret<let N_IN: u32, let N_OUT: u32, let SHAPE: u32>(
    seed: Field,
    nullifiers: [Field; N_IN],
    i: Field,
    output_entropy: Field,
) -> Field {
    let mut operands = [0; N_IN + 7];
    operands[0] = TRANSACT_NOTE_SECRET_DOMAIN;
    operands[1] = seed;
    operands[2] = SHAPE as Field;
    operands[3] = N_IN as Field;
    operands[4] = N_OUT as Field;
    for j in 0..N_IN {
        operands[5 + j] = nullifiers[j];
    }
    operands[5 + N_IN] = i;
    operands[6 + N_IN] = output_entropy;
    let derived = pcash_hash(operands);
    derived
}

mod tests {
    use super::{note_secret, note_secret_seed, payout_seed, transaction_context};
    use pcash_protocol::generated::pcash_constants::{
        IMPLICIT_NOTE_SECRET_SEED_DOMAIN, PAYOUT_SEED_DOMAIN, PAYOUT_TX_CONTEXT_DOMAIN,
        TRANSACT_NOTE_SECRET_DOMAIN,
    };
    use pcash_protocol::ledger::note::note_nk;
    use pcash_protocol::primitives::hash::pcash_hash;

    #[test]
    fn test_payout_seed_and_transaction_context() {
        let seed = payout_seed(0x1234);
        let context = transaction_context::<4, 5, 0>(1, [11, 12, 13, 14]);
        assert(seed == pcash_hash([PAYOUT_SEED_DOMAIN, note_nk(0x1234)]));
        assert(context == pcash_hash([PAYOUT_TX_CONTEXT_DOMAIN, 1, 0, 4, 5, 11, 12, 13, 14]));
        assert(context != transaction_context::<4, 5, 0>(2, [11, 12, 13, 14]));
        assert(context != transaction_context::<4, 5, 0>(1, [11, 12, 13, 15]));
        assert(context != transaction_context::<4, 5, 0>(1, [12, 11, 13, 14]));
    }

    #[test]
    fn test_note_secret_derivation() {
        let nk = note_nk(0x9999);
        let seed = note_secret_seed(nk);
        assert(seed == pcash_hash([IMPLICIT_NOTE_SECRET_SEED_DOMAIN, nk]));
        let nullifiers = [0x1a, 0x2b, 0x3c, 0x4d];
        let s0 = note_secret::<4, 5, 0>(seed, nullifiers, 0, 0);
        let s1 = note_secret::<4, 5, 0>(seed, nullifiers, 1, 0);
        assert(
            s0
                == pcash_hash([
                    TRANSACT_NOTE_SECRET_DOMAIN,
                    seed,
                    0,
                    4,
                    5,
                    0x1a,
                    0x2b,
                    0x3c,
                    0x4d,
                    0,
                    0,
                ]),
        );
        assert(s0 != s1);
        // Distinct entropy in the same slot yields a distinct secret.
        assert(s0 != note_secret::<4, 5, 0>(seed, nullifiers, 0, 0xf00d));
        // The salt is the published nullifiers: changing one changes the secret.
        assert(s0 != note_secret::<4, 5, 0>(seed, [0x1a, 0x2b, 0x3c, 0x4e], 0, 0));
    }
}
