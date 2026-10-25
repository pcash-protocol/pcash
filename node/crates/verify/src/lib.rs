//! pcash-verify — hiding-kernel proof verification.
//!
//! Consensus rule: a hiding-kernel proof verifies **exactly when** the
//! release-pinned Barretenberg build accepts it against the pinned verification
//! key and the ordered public inputs. Verification failure is defined broadly —
//! it includes malformed encoding, wrong proof length, any public input `>= p`,
//! and verifier rejection. All of those are a clean `Ok(false)`, not an error,
//! except a request larger than the worker's 1 MiB frame, which is refused with
//! `Err(Protocol)`. Transaction decoding fixes the proof at `WIRE_PROOF_BYTES`,
//! so consensus input never reaches that limit.
//! bb refuses a proof the same way whether the proof failed or bb itself did
//! (for example by running out of memory), so a refusal is a rejection only
//! when bb's own report attributes it to the proof. A worker verifies nothing
//! until it has passed a positive and a negative known answer for every
//! hiding-kernel verification key.
//!
//! An [`Err`] means there is no verdict: the pinned verifier could not start,
//! failed a known answer, timed out, exited, returned an error frame, or
//! refused without a proof-caused report; the request exceeded the worker's
//! frame; or a cache declared complete for a block missed, which is a node
//! defect. It must not be converted into proof rejection.
//!
//! Everything routes through the [`Verifier`] trait. The [`BbProcessVerifier`]
//! backend supervises a persistent pinned `bb msgpack run` worker; callers and
//! consensus semantics are independent of that packaging choice.

mod cache;
mod kat;
mod process;
mod refusal;

pub use cache::{CachedVerifier, VerifyCache};
pub use kat::STARTUP_KNOWN_ANSWER_REQUESTS;
pub use process::BbProcessVerifier;

use std::path::PathBuf;

/// `VerifyError::Abnormal::exit` when the child died by signal rather than
/// returning a status. Written by `stop_failed_worker`, read by `is_transient`.
pub(crate) const SIGNAL_EXIT: &str = "signal";

/// Errors that mean we could **not** obtain a consensus verdict.
///
/// A proof that the pinned verifier cleanly *rejects* is `Ok(false)`, never one
/// of these. They are tool and environment failures, a request over the
/// worker's frame (`Protocol`), and a miss in a cache declared complete
/// (`CompleteCacheMiss`), which is a node defect.
#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    /// No pinned tool root is configured.
    #[error("PCASH_TOOL_ROOT is not set; run `just tools` and set it to the installed tool root")]
    ToolRootUnset,

    /// The pinned tool root has no `bb` binary.
    #[error("pinned bb binary is missing at {path}; run `just tools`")]
    MissingBinary { path: PathBuf },

    /// The verifier binary could not be spawned (missing, not executable, …).
    #[error("failed to spawn verifier binary {path}: {source}")]
    Spawn {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// Local verifier I/O failed.
    #[error("verifier i/o error: {0}")]
    Io(#[from] std::io::Error),

    /// Communication with a live worker failed without a usable exit status.
    #[error("verifier transport failed: {detail}; stderr={stderr:?}")]
    Transport { detail: String, stderr: String },

    /// The worker returned an invalid or unexpected protocol message.
    #[error("verifier protocol failed: {detail}; stderr={stderr:?}")]
    Protocol { detail: String, stderr: String },

    /// The persistent worker exited unexpectedly. We refuse to guess a
    /// consensus answer from its status.
    #[error("verifier terminated abnormally (exit={exit}); stdout={stdout:?}; stderr={stderr:?}")]
    Abnormal {
        exit: String,
        stdout: String,
        stderr: String,
    },

    /// The verifier did not finish within the configured wall-clock bound. The
    /// child is killed and reaped before this error is returned.
    #[error("verifier timed out after {timeout_ms} ms; stdout={stdout:?}; stderr={stderr:?}")]
    Timeout {
        timeout_ms: u128,
        stdout: String,
        stderr: String,
    },

    /// The pinned verifier failed its committed positive or negative startup
    /// KAT. `report` is what bb said while answering it.
    #[error("verifier known-answer check failed: {case}; report={report:?}")]
    KnownAnswer { case: &'static str, report: String },

    /// The pinned verifier refused a proof without reporting a proof-caused
    /// failure, for example because it ran out of memory. That is no verdict.
    #[error("verifier refused {request} without a proof-caused report; report={report:?}")]
    VerifierFault {
        request: &'static str,
        report: String,
    },

    /// An off-lock prewarm recorded a tool failure for this exact verification.
    #[error("cached verifier tool failure: {error}")]
    CachedToolFailure { error: String },

    /// A verifier request was absent from a cache declared complete for a block.
    #[error("complete verifier cache miss for key {key}")]
    CompleteCacheMiss { key: String },

    /// The installed verifier is not the binary this node is pinned to.
    #[error("bb at {path} is not the pinned Barretenberg binary: expected SHA-256 {expected}, got {actual}; run `just tools`")]
    BinaryMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },

    /// A verifier CRS file has different bytes.
    #[error("CRS mismatch at {path}: expected {expected}, got {actual}")]
    CrsMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },
}

impl VerifyError {
    /// Whether prewarming should retry this failure once before caching it.
    /// A non-retryable failure is still inconclusive, not proof rejection;
    /// configuration and verifier-health failures can also be non-retryable.
    pub fn is_transient(&self) -> bool {
        match self {
            VerifyError::Spawn { .. }
            | VerifyError::Io(_)
            | VerifyError::Transport { .. }
            | VerifyError::Timeout { .. }
            | VerifyError::VerifierFault { .. } => true,
            // A signal alone does not identify a proof-induced crash.
            VerifyError::Abnormal { exit, .. } => exit == SIGNAL_EXIT,
            _ => false,
        }
    }
}

/// A hiding-kernel proof verifier.
///
/// `public_inputs` is the Barretenberg wire encoding: the concatenation of the
/// circuit's public-input field elements, each a 32-byte big-endian integer, in
/// the protocol-defined order for the transaction type. An empty
/// slice is a valid (zero public input) encoding.
///
/// Returns `Ok(true)` if the pinned verifier accepts, `Ok(false)` on any clean
/// rejection (including malformed/short encodings), and `Err` when there is no
/// verdict (see [`VerifyError`]).
pub trait Verifier {
    fn verify(&self, vk: &[u8], proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError>;
}

#[cfg(test)]
mod fuzz;
#[cfg(test)]
mod tests;
