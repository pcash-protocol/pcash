//! Which refusals from the pinned verifier are verdicts.
//!
//! `ChonkVerify` answers `valid: false` both when a proof fails and when bb
//! catches any exception, including `std::bad_alloc`; `ChonkDecompressProof`
//! answers every exception with an error frame. A refusal is a rejection only
//! when bb's own report attributes it to the proof. Everything else, including
//! a refusal with no report at all, is no verdict.
//!
//! The recognized reports are bb's wording, so they are re-checked on every
//! Barretenberg re-pin. The startup negative known answers must produce one of
//! them, and the ignored live tests exercise the others against the binary.
//!
//! `ChonkVerify`, with the worker running under `BB_VERBOSE=1`, is a rejection
//! only when its stderr ends with one of these reports:
//! - `ChonkVerifier: verification failed at <step>`: a failed reduction step
//!   (`chonk/chonk_verifier.cpp`).
//! - `IPA batch verification failed: combined G_0 mismatch`: the final IPA SRS
//!   check (`commitment_schemes/ipa/ipa.hpp`).
//! - `ChonkVerify: proof has wrong size`: the decompressed proof's
//!   public-input count differs from the key's (`bbapi/bbapi_chonk.cpp`).
//! - `ChonkVerifier: Batched translator+joint reduction: true`: a verbose
//!   progress line logged when the translator+joint reduction succeeds. After
//!   it come that reduction's pairing check, which reports a failure as a
//!   failed step, the final IPA SRS check above, and the TripleIPA group
//!   relation (`commitment_schemes/triple_ipa/triple_ipa.hpp`), which fails
//!   without a report. A refusal straight after the line is that relation.
//! - `ChonkVerify: malformed input: <what>`, followed only by the indented
//!   continuation lines of the same report, when the first line of `<what>` is
//!   one of the four exceptions a proof that decompressed can deterministically
//!   raise. All four come from converting the hiding kernel's last 28 public
//!   inputs into seven BN254 points (`ecc/fields/field_conversion.hpp`, via
//!   `HidingKernelIO`), before any CRS access: a low limb of 2^136 or more, a
//!   high limb of 2^118 or more, a coordinate of q or more, or a point not on
//!   the curve.
//!
//! On a worker that has already run a verification to the final IPA check, each
//! of these is the last thing bb logs before it answers. A fresh worker loads
//! the Grumpkin CRS on first use there and logs the load after the progress
//! line; no request reaches it before its known answers, which start with a
//! valid proof (`ensure_ready`). Anything after a report, including an empty or
//! cut-off line, means no verdict: when memory runs out, bb's log formatter
//! (`format` in `common/log.hpp`) swallows the allocation failure and logs
//! whatever it had built, so the report of a caught `std::bad_alloc` can arrive
//! as a fragment, or as only its memory note. A `malformed input` report
//! anywhere with any other `<what>` (`std::bad_alloc`, a CRS read failure,
//! `unknown exception`, any other assertion) is also no verdict. Every other
//! exception on the native verification path is fixed by the compiled key,
//! needs a Fiat-Shamir output to hit a specific value, or comes from the
//! environment, and every other refusal ends with one of the reports above; the
//! ignored malformed-proof fuzz (`fuzz.rs`) tests this against the binary. Zero
//! inversions and other failures inside bb's `noexcept` arithmetic abort the
//! process, which is never a verdict. What remains open is a write to stderr
//! failing outright between a recognized report and a later exception report.
//!
//! `ChonkDecompressProof`: an error frame whose message starts with
//! `proof_compression: `, bb's decompression input validation
//! (`chonk/proof_compression.hpp`).

const DECOMPRESSION_REPORT: &str = "proof_compression: ";
const EXCEPTION_REPORT: &str = "ChonkVerify: malformed input: ";
const PROOF_EXCEPTIONS: [&str; 4] = [
    "Assertion failed: (uint256_t(fr_vec[0]) < (uint256_t(1) << (NUM_LIMB_BITS * 2)))",
    "Assertion failed: (uint256_t(fr_vec[1]) < (uint256_t(1) << (TOTAL_BITS - NUM_LIMB_BITS * 2)))",
    "Assertion failed: (value < fq::modulus)",
    "Deserialized point is not on the curve",
];
const FAILURE_REPORTS: [&str; 4] = [
    "ChonkVerifier: verification failed at ",
    "IPA batch verification failed: combined G_0 mismatch",
    "ChonkVerify: proof has wrong size",
    "ChonkVerifier: Batched translator+joint reduction: true",
];

/// bb ends each log message with ` (mem: <n> MiB)`, on the message's last line.
pub(super) fn without_memory_note(line: &str) -> &str {
    match line.rfind(" (mem: ") {
        Some(start) if line.ends_with(')') => &line[..start],
        _ => line,
    }
}

/// How bb refused a proof.
pub(super) enum Refusal<'a> {
    /// `ChonkDecompressProof` answered an error frame with this message.
    Decompression { message: &'a str },
    /// `ChonkVerify` answered `valid: false` after writing this to stderr.
    Verification { stderr: &'a str },
}

/// Whether bb attributes the refusal to the proof.
pub(super) fn proof_caused(refusal: Refusal<'_>) -> bool {
    match refusal {
        Refusal::Decompression { message } => message.starts_with(DECOMPRESSION_REPORT),
        Refusal::Verification { stderr } => ends_with_proof_caused_report(stderr),
    }
}

fn ends_with_proof_caused_report(stderr: &str) -> bool {
    let lines: Vec<&str> = stderr.lines().collect();
    let proof_exception = |what: &str| PROOF_EXCEPTIONS.contains(&without_memory_note(what));
    if lines
        .iter()
        .filter_map(|line| line.split_once(EXCEPTION_REPORT))
        .any(|(_, what)| !proof_exception(what))
    {
        return false;
    }
    // The last report starts the last line that does not continue the one
    // before it; an empty line continues nothing.
    let Some(last) = lines
        .iter()
        .rposition(|line| !line.starts_with(char::is_whitespace))
    else {
        return false;
    };
    let report = lines[last];
    if let Some(what) = report.strip_prefix(EXCEPTION_REPORT) {
        return proof_exception(what);
    }
    last + 1 == lines.len()
        && FAILURE_REPORTS
            .iter()
            .any(|known| report.starts_with(known))
}
