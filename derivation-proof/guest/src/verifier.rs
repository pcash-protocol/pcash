//! The node's `Verifier` on bb 6.0.0, linked into the program.
//!
//! bb is built with C++ exceptions, and the driver runs bb's own
//! `ChonkDecompressProof` and `ChonkVerify` requests with verbose logging
//! captured per request. The answer is classified by the node's refusal rules,
//! as the node's worker backend does (pcash-verify `process::call_worker`): a
//! refusal is a rejection only when bb's report attributes it to the proof.

use core::ffi::{c_char, c_void};

use pcash_verify::refusal::{proof_caused, Refusal};
use pcash_verify::{Verifier, VerifyError};

#[repr(C)]
struct BbAnswer {
    request: i32,
    valid: i32,
    report: *mut c_char,
    report_len: usize,
}

/// `ChonkDecompressProof` answered an error; the report is its message.
const DECOMPRESSION_ERROR: i32 = 0;
/// `ChonkVerify` answered; the report is bb's log for the request.
const VERIFY_RESPONSE: i32 = 1;

extern "C" {
    fn __libc_init_array();
    fn setenv(name: *const c_char, value: *const c_char, overwrite: i32) -> i32;
    fn free(p: *mut c_void);
    fn pcash_crs_init(g: *const u8, ng: usize, g1: *const u8, ng1: usize, g2: *const u8);
    fn pcash_bb_chonk(vk: *const u8, vk_len: usize, p: *const u8, len: usize, answer: *mut BbAnswer);
}

/// Word-aligned, so the reference string is copied in words.
#[repr(C, align(64))]
struct Aligned<Bytes: ?Sized>(Bytes);
static GRUMPKIN: &Aligned<[u8]> = &Aligned(*include_bytes!(concat!(env!("CHONK_CRS"), "/grumpkin.bin")));
static BN254_G1: &Aligned<[u8]> = &Aligned(*include_bytes!(concat!(env!("CHONK_CRS"), "/bn254_g1.bin")));
static BN254_G2: &Aligned<[u8]> = &Aligned(*include_bytes!(concat!(env!("CHONK_CRS"), "/bn254_g2.bin")));

/// Points are 64 bytes uncompressed.
const POINT_BYTES: usize = 64;

pub struct Chonk(());

impl Chonk {
    /// Set bb's log level as the node starts its worker, run the C++ static
    /// constructors, register the unwind tables and load the reference string.
    /// Call once.
    pub fn new() -> Self {
        unsafe {
            setenv(c"BB_VERBOSE".as_ptr(), c"1".as_ptr(), 1);
            __libc_init_array();
            crate::eh::register_frames();
            pcash_crs_init(
                GRUMPKIN.0.as_ptr(),
                GRUMPKIN.0.len() / POINT_BYTES,
                BN254_G1.0.as_ptr(),
                BN254_G1.0.len() / POINT_BYTES,
                BN254_G2.0.as_ptr(),
            );
        }
        Self(())
    }
}

impl Verifier for Chonk {
    fn verify(&self, vk: &[u8], proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError> {
        let input = [public_inputs, proof].concat();
        let mut answer = BbAnswer {
            request: -1,
            valid: 0,
            report: core::ptr::null_mut(),
            report_len: 0,
        };
        println!("cycle-tracker-report-start: bb");
        let report = unsafe {
            pcash_bb_chonk(vk.as_ptr(), vk.len(), input.as_ptr(), input.len(), &mut answer);
            let bytes = core::slice::from_raw_parts(answer.report as *const u8, answer.report_len);
            let report = String::from_utf8_lossy(bytes).into_owned();
            free(answer.report.cast());
            report
        };
        println!("cycle-tracker-report-end: bb");
        let (request, verdict) = match answer.request {
            DECOMPRESSION_ERROR => (
                "ChonkDecompressProof",
                proof_caused(Refusal::Decompression { message: &report }).then_some(false),
            ),
            VERIFY_RESPONSE if answer.valid != 0 => ("ChonkVerify", Some(true)),
            VERIFY_RESPONSE => (
                "ChonkVerify",
                proof_caused(Refusal::Verification { stderr: &report }).then_some(false),
            ),
            _ => ("ChonkVerify", None),
        };
        verdict.ok_or(VerifyError::VerifierFault { request, report })
    }
}
