use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::{Verifier, VerifyError};

// Length prefixes preserve tuple boundaries: different splits of the same
// concatenated bytes must not reuse a verification result.
pub(crate) fn verification_key(vk: &[u8], proof: &[u8], public_inputs: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update((vk.len() as u64).to_le_bytes());
    h.update(vk);
    h.update((proof.len() as u64).to_le_bytes());
    h.update(proof);
    h.update((public_inputs.len() as u64).to_le_bytes());
    h.update(public_inputs);
    h.finalize().into()
}

/// Tool failures remain inconclusive; they must not become rejected-proof verdicts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CachedVerification {
    Verdict(bool),
    ToolFailure { error: String },
}

/// Valid only for the verifier configuration that populated it; cache keys do
/// not include verifier implementation or release identity.
#[derive(Default, Clone, Debug)]
pub struct VerifyCache {
    pub(super) outcomes: HashMap<[u8; 32], CachedVerification>,
}

impl VerifyCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// A memoized outcome for a `(vk, proof, public_inputs)` triple, if present.
    #[cfg(test)]
    pub(crate) fn get(
        &self,
        vk: &[u8],
        proof: &[u8],
        public_inputs: &[u8],
    ) -> Option<&CachedVerification> {
        self.outcomes
            .get(&verification_key(vk, proof, public_inputs))
    }

    /// Run the bounded retry here, before derivation takes the mutex, rather
    /// than retrying a tool failure when derivation consumes the cache.
    pub fn warm<V: Verifier>(&mut self, inner: &V, vk: &[u8], proof: &[u8], public_inputs: &[u8]) {
        let key = verification_key(vk, proof, public_inputs);
        if self.outcomes.contains_key(&key) {
            return;
        }
        let mut result = inner.verify(vk, proof, public_inputs);
        if matches!(&result, Err(error) if error.is_transient()) {
            result = inner.verify(vk, proof, public_inputs);
        }
        let outcome = match result {
            Ok(verdict) => CachedVerification::Verdict(verdict),
            Err(error) => CachedVerification::ToolFailure {
                error: error.to_string(),
            },
        };
        self.outcomes.insert(key, outcome);
    }
}

#[derive(Clone, Copy)]
pub(super) enum CacheMissPolicy {
    Fallback,
    FailClosed,
}

/// Use [`CachedVerifier::new_complete`] on the derivation-locked path: a cache
/// miss must remain an error, not invoke the backend as [`CachedVerifier::new`]
/// would. Cached tool failures likewise remain errors, not proof rejection.
pub struct CachedVerifier<'a, V: Verifier> {
    pub(super) cache: &'a VerifyCache,
    pub(super) inner: &'a V,
    pub(super) miss_policy: CacheMissPolicy,
}

impl<'a, V: Verifier> CachedVerifier<'a, V> {
    pub fn new(cache: &'a VerifyCache, inner: &'a V) -> Self {
        Self {
            cache,
            inner,
            miss_policy: CacheMissPolicy::Fallback,
        }
    }

    pub fn new_complete(cache: &'a VerifyCache, inner: &'a V) -> Self {
        Self {
            cache,
            inner,
            miss_policy: CacheMissPolicy::FailClosed,
        }
    }
}

impl<V: Verifier> Verifier for CachedVerifier<'_, V> {
    fn verify(&self, vk: &[u8], proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError> {
        let key = verification_key(vk, proof, public_inputs);
        match self.cache.outcomes.get(&key) {
            Some(CachedVerification::Verdict(verdict)) => Ok(*verdict),
            Some(CachedVerification::ToolFailure { error }) => {
                Err(VerifyError::CachedToolFailure {
                    error: error.clone(),
                })
            }
            None if matches!(self.miss_policy, CacheMissPolicy::FailClosed) => {
                Err(VerifyError::CompleteCacheMiss {
                    key: hex::encode(key),
                })
            }
            None => self.inner.verify(vk, proof, public_inputs),
        }
    }
}
