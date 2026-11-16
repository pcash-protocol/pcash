//! Malformed-proof fuzzing of the live verifier.
//!
//! Every mutation starts from a hiding-kernel known-answer proof and runs
//! through [`BbProcessVerifier::answer`], the path [`Verifier::verify`] takes, so
//! it is classified exactly as derivation classifies it. The test fails on any
//! result other than a rejection, and on any verification slower than ten
//! times the known answer's own. A proof that makes bb crash, hang or refuse
//! without a recognized report would halt every node at its block, so each
//! such path needs a deterministic node-side rejection or an upstream fix.
//!
//! ```bash
//! PCASH_TOOL_ROOT="$PWD/.pcash-tools" cargo test -p pcash-verify fuzz -- --ignored --nocapture
//! ```
//!
//! prints the run summary. `PCASH_VERIFY_FUZZ_FLIPS` sets the random byte
//! flips per known answer (default 256), `PCASH_VERIFY_FUZZ_SEED` their seed,
//! and `PCASH_VERIFY_FUZZ_LOG` a file that receives one line per verification
//! attempt.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stderr,
    reason = "a test harness fails by panicking and prints its run summary"
)]

use super::kat::{KnownAnswer, HIDING_KERNEL_KATS};
use super::process::*;
use super::refusal::without_memory_note;
use super::*;

use barretenberg_rs::generated_types::ChonkDecompressProof;
use barretenberg_rs::{Command as BbCommand, Response as BbResponse};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::Write as _;
use std::time::{Duration, Instant};

type Word = [u8; 32];

const ZERO: Word = [0; 32];
/// A posted proof opens with the hiding kernel's last 28 public inputs: seven
/// BN254 points (`HidingKernelIO`), each as limbs `x_lo, x_hi, y_lo, y_hi`.
/// bb converts them with `field_conversion.hpp`, whose four exceptions are the
/// point-decoding reports `refusal` recognizes.
const ACCUMULATOR_POINTS: usize = 7;
const ACCUMULATOR_WORDS: usize = 4 * ACCUMULATOR_POINTS;
const LOW_LIMB_BITS: usize = 136;
const HIGH_LIMB_BITS: usize = 118;
/// The smallest x off each curve: `x^3 + 3` is not a square mod q, and
/// `x^3 - 17` is not a square mod r.
const BN254_OFF_CURVE_X: u8 = 4;
const GRUMPKIN_OFF_CURVE_X: u8 = 3;
/// Compressed points carry the sign of y in the top bit.
const SIGN_BIT: u8 = 0x80;
const SLOW_FACTOR: u32 = 10;
const KNOWN_ANSWER_RUNS: usize = 5;
const SLOWEST_SHOWN: usize = 10;
const REPORT_TAIL_BYTES: usize = 2048;

/// q, the BN254 base field modulus.
fn bn254_base_modulus() -> Word {
    hex::decode("30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47")
        .unwrap()
        .try_into()
        .unwrap()
}

fn small(value: u8) -> Word {
    let mut word = ZERO;
    word[31] = value;
    word
}

fn power_of_two(bits: usize) -> Word {
    let mut word = ZERO;
    word[31 - bits / 8] = 1 << (bits % 8);
    word
}

/// `a - b` modulo 2^256.
fn sub(a: &Word, b: &Word) -> Word {
    let mut out = ZERO;
    let mut borrow = 0;
    for i in (0..32).rev() {
        let mut digit = i16::from(a[i]) - i16::from(b[i]) - borrow;
        borrow = i16::from(digit < 0);
        digit += 256 * borrow;
        out[i] = digit as u8;
    }
    out
}

fn minus_one(word: &Word) -> Word {
    sub(word, &small(1))
}

fn plus_one(word: &Word) -> Word {
    sub(word, &[0xff; 32])
}

/// A coordinate's limbs: its low 136 bits and the rest.
fn limbs(coordinate: &Word) -> (Word, Word) {
    let mut low = ZERO;
    let mut high = ZERO;
    low[15..].copy_from_slice(&coordinate[15..]);
    high[17..].copy_from_slice(&coordinate[..15]);
    (low, high)
}

fn coordinate(low: &Word, high: &Word) -> Word {
    let mut out = ZERO;
    out[15..].copy_from_slice(&low[15..]);
    out[..15].copy_from_slice(&high[17..]);
    out
}

/// `-P` for an accumulator point's limbs; the point at infinity is all zero.
fn negated_limbs(point: [Word; 4]) -> [Word; 4] {
    if point == [ZERO; 4] {
        return point;
    }
    let y = coordinate(&point[2], &point[3]);
    let (low, high) = limbs(&sub(&bn254_base_modulus(), &y));
    [point[0], point[1], low, high]
}

/// `-P` for a compressed point; the point at infinity is zero.
fn negated(point: Word) -> Word {
    let mut out = point;
    if point != ZERO {
        out[0] ^= SIGN_BIT;
    }
    out
}

fn with_sign_of(x: Word, point: &Word) -> Word {
    let mut out = x;
    out[0] |= point[0] & SIGN_BIT;
    out
}

fn word(bytes: &[u8], index: usize) -> Word {
    bytes[32 * index..32 * (index + 1)].try_into().unwrap()
}

fn with_words(bytes: &[u8], writes: &[(usize, Word)]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    for (index, value) in writes {
        out[32 * index..32 * (index + 1)].copy_from_slice(value);
    }
    out
}

/// How bb's decompression reads a word of a posted proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Element {
    Bn254Scalar,
    Bn254Point,
    GrumpkinScalar,
    GrumpkinPoint,
}

impl Element {
    fn name(self) -> &'static str {
        match self {
            Element::Bn254Scalar => "BN254 scalar",
            Element::Bn254Point => "BN254 point",
            Element::GrumpkinScalar => "Grumpkin scalar",
            Element::GrumpkinPoint => "Grumpkin point",
        }
    }

    /// The modulus of the field the word's value lies in: the scalar, or the
    /// point's x-coordinate.
    fn modulus(self) -> Word {
        match self {
            Element::Bn254Scalar | Element::GrumpkinPoint => BN254_SCALAR_MODULUS,
            Element::Bn254Point | Element::GrumpkinScalar => bn254_base_modulus(),
        }
    }
}

/// bb's decompression alone: `None` when it decompresses, else its message.
fn decompression_error(
    verifier: &BbProcessVerifier,
    proof: &[u8],
    public_inputs: &[u8],
) -> Option<String> {
    let mut slot = lock_unpoisoned(&verifier.worker);
    verifier.ensure_ready(&mut slot).unwrap();
    let request =
        BbCommand::ChonkDecompressProof(ChonkDecompressProof::new([public_inputs, proof].concat()));
    match verifier.exchange_worker(&mut slot, request).unwrap().0 {
        BbResponse::ChonkDecompressProofResponse(_) => None,
        BbResponse::ErrorResponse(error) => Some(error.message),
        response => panic!("unexpected decompression response: {response:?}"),
    }
}

/// Each word's element type, read from the pinned bb: q is out of range for
/// every element type, and decompression names the type of the word it stops
/// at.
fn layout(verifier: &BbProcessVerifier, kat: &KnownAnswer) -> Vec<Element> {
    let layout: Vec<Element> = (0..kat.proof.len() / 32)
        .map(|index| {
            let proof = with_words(kat.proof, &[(index, bn254_base_modulus())]);
            let message = decompression_error(verifier, &proof, kat.public_inputs);
            match message
                .as_deref()
                .and_then(|message| message.strip_prefix("proof_compression: "))
            {
                Some("BN254 scalar out of range") => Element::Bn254Scalar,
                Some("BN254 x-coordinate out of range") => Element::Bn254Point,
                Some("Grumpkin scalar out of range") => Element::GrumpkinScalar,
                Some("Grumpkin x-coordinate out of range") => Element::GrumpkinPoint,
                _ => panic!("{}: word {index} set to q gave {message:?}", kat.name),
            }
        })
        .collect();
    assert!(
        layout[..ACCUMULATOR_WORDS]
            .iter()
            .all(|element| *element == Element::Bn254Scalar),
        "{}: the accumulator limbs are not public inputs",
        kat.name
    );
    layout
}

struct Mutation {
    family: String,
    site: String,
    proof: Vec<(usize, Word)>,
    public_inputs: Vec<(usize, Word)>,
}

/// splitmix64: a seeded, dependency-free generator for the random flips.
struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

fn mutations(
    kat: &KnownAnswer,
    layout: &[Element],
    flips: u64,
    random: &mut Random,
) -> Vec<Mutation> {
    let mut list = Vec::new();
    let mut proof = |family: String, site: String, writes: Vec<(usize, Word)>| {
        list.push(Mutation {
            family,
            site,
            proof: writes,
            public_inputs: Vec::new(),
        });
    };
    let original = |index| word(kat.proof, index);
    let q = bn254_base_modulus();

    // The accumulator's seven points, as limbs.
    let point = |p: usize| [0, 1, 2, 3].map(|k| original(4 * p + k));
    let set_point = |p: usize, limbs: [Word; 4]| -> Vec<(usize, Word)> {
        (0..4).map(|k| (4 * p + k, limbs[k])).collect()
    };
    for p in 0..ACCUMULATOR_POINTS {
        let next = (p + 1) % ACCUMULATOR_POINTS;
        let site = || format!("point {p}");
        let family = |name: &str| format!("accumulator point: {name}");
        proof(family("infinity"), site(), set_point(p, [ZERO; 4]));
        proof(
            family("negated"),
            site(),
            set_point(p, negated_limbs(point(p))),
        );
        proof(
            family("equal to the next"),
            site(),
            set_point(p, point(next)),
        );
        proof(
            family("opposite of the next"),
            site(),
            set_point(p, negated_limbs(point(next))),
        );
        for (axis, low_word) in [("x", 4 * p), ("y", 4 * p + 2)] {
            let mut flipped = original(low_word);
            flipped[31] ^= 1;
            proof(
                family("off the curve"),
                format!("point {p} {axis}"),
                vec![(low_word, flipped)],
            );
            for (name, value) in [
                ("coordinate q", q),
                ("coordinate 2^254 - 1", minus_one(&power_of_two(254))),
            ] {
                let (low, high) = limbs(&value);
                proof(
                    family(name),
                    format!("point {p} {axis}"),
                    vec![(low_word, low), (low_word + 1, high)],
                );
            }
        }
    }
    for index in 0..ACCUMULATOR_WORDS {
        let bits = if index % 2 == 0 {
            LOW_LIMB_BITS
        } else {
            HIGH_LIMB_BITS
        };
        let bound = power_of_two(bits);
        for (name, value) in [
            ("bound - 1", minus_one(&bound)),
            ("bound", bound),
            ("bound + 1", plus_one(&bound)),
        ] {
            proof(
                format!("accumulator limb: 2^{bits} {name}"),
                format!("word {index}"),
                vec![(index, value)],
            );
        }
    }

    // Compressed commitments and scalars, all words after the accumulator.
    let of = |element: Element| -> Vec<usize> {
        (ACCUMULATOR_WORDS..layout.len())
            .filter(|&index| layout[index] == element)
            .collect()
    };
    for (element, off_curve_x) in [
        (Element::Bn254Point, BN254_OFF_CURVE_X),
        (Element::GrumpkinPoint, GRUMPKIN_OFF_CURVE_X),
    ] {
        let indices = of(element);
        let modulus = element.modulus();
        for (n, &index) in indices.iter().enumerate() {
            let next = original(indices[(n + 1) % indices.len()]);
            let here = original(index);
            for (name, value) in [
                ("infinity", ZERO),
                ("negated", negated(here)),
                ("equal to the next", next),
                ("opposite of the next", negated(next)),
                ("off the curve", with_sign_of(small(off_curve_x), &here)),
                ("x = p", with_sign_of(modulus, &here)),
                ("x = p - 1", with_sign_of(minus_one(&modulus), &here)),
                ("x = 2^255 - 1", minus_one(&power_of_two(255))),
                ("x = 0 with the sign bit", power_of_two(255)),
            ] {
                proof(
                    format!("{}: {name}", element.name()),
                    format!("word {index}"),
                    vec![(index, value)],
                );
            }
        }
    }
    for element in [Element::Bn254Scalar, Element::GrumpkinScalar] {
        let modulus = element.modulus();
        // The accumulator limbs are BN254 scalars to the decompressor too.
        let indices = (0..layout.len()).filter(|&index| layout[index] == element);
        for index in indices {
            for (name, value) in [
                ("0", ZERO),
                ("1", small(1)),
                ("p - 1", minus_one(&modulus)),
                ("p", modulus),
            ] {
                proof(
                    format!("{}: {name}", element.name()),
                    format!("word {index}"),
                    vec![(index, value)],
                );
            }
        }
    }

    // Byte flips anywhere in the body, then every byte of the last scalar.
    for _ in 0..flips {
        let position = (random.next() % kat.proof.len() as u64) as usize;
        let mask = (random.next() % 255 + 1) as u8;
        let mut flipped = original(position / 32);
        flipped[position % 32] ^= mask;
        proof(
            "random byte flip".to_owned(),
            format!("byte {position} ^ {mask:#04x}"),
            vec![(position / 32, flipped)],
        );
    }
    let last_scalar = (0..layout.len())
        .rev()
        .find(|&index| {
            matches!(
                layout[index],
                Element::Bn254Scalar | Element::GrumpkinScalar
            )
        })
        .unwrap();
    for byte in 0..32 {
        let mut flipped = original(last_scalar);
        flipped[byte] ^= 1;
        proof(
            "last scalar: low bit of each byte".to_owned(),
            format!("word {last_scalar} byte {byte}"),
            vec![(last_scalar, flipped)],
        );
    }

    for index in 0..kat.public_inputs.len() / 32 {
        let mut flipped = word(kat.public_inputs, index);
        flipped[31] ^= 1;
        for (name, value) in [
            ("low bit flipped", flipped),
            ("r - 1", minus_one(&BN254_SCALAR_MODULUS)),
            ("r", BN254_SCALAR_MODULUS),
        ] {
            list.push(Mutation {
                family: format!("public input: {name}"),
                site: format!("word {index}"),
                proof: Vec::new(),
                public_inputs: vec![(index, value)],
            });
        }
    }

    // A mutation that leaves the proof as it was tests nothing.
    list.retain(|mutation| {
        mutation
            .proof
            .iter()
            .any(|(index, value)| *value != original(*index))
            || mutation
                .public_inputs
                .iter()
                .any(|(index, value)| *value != word(kat.public_inputs, *index))
    });
    list
}

const REJECTED: &str = "rejected";
const ACCEPTED: &str = "accepted";

struct Outcome {
    /// [`REJECTED`], [`ACCEPTED`], or how verification failed to decide.
    class: &'static str,
    /// For a rejection, what settled it; otherwise everything reported.
    report: String,
    elapsed: Duration,
}

/// What settled a rejection: the node's pre-check, bb's decompression message,
/// or the last report `ChonkVerify` logged.
fn rejected_by(request: &str, report: &str) -> String {
    let line = match request {
        PRE_CHECK => return PRE_CHECK.to_owned(),
        "ChonkDecompressProof" => report.lines().next(),
        _ => report
            .lines()
            .rev()
            .find(|line| !line.starts_with(char::is_whitespace)),
    };
    without_memory_note(line.unwrap_or_default()).to_owned()
}

fn run(verifier: &BbProcessVerifier, vk: &[u8], proof: &[u8], public_inputs: &[u8]) -> Outcome {
    // A worker replaced after the previous mutation proves its known answers
    // here, outside the timing.
    verifier
        .assert_known_answers()
        .expect("a fresh worker failed its known answers");
    let started = Instant::now();
    let result = verifier.answer(vk, proof, public_inputs);
    let elapsed = started.elapsed();
    let (class, report) = match result {
        Ok(Answer {
            verdict: Some(false),
            request,
            report,
        }) => (REJECTED, rejected_by(request, &report)),
        Ok(Answer {
            verdict: Some(true),
            ..
        }) => (ACCEPTED, String::new()),
        Ok(Answer { report, .. }) => ("no verdict", report),
        Err(error @ VerifyError::Timeout { .. }) => ("timeout", error.to_string()),
        Err(error @ VerifyError::Abnormal { .. }) => ("crash", error.to_string()),
        Err(error) => ("error", error.to_string()),
    };
    Outcome {
        class,
        report,
        elapsed,
    }
}

/// A mutation's result: its first attempt that did not reject, or its first
/// attempt. A timing retry that crashes, accepts or gives no verdict therefore
/// decides the result instead of disappearing behind an earlier rejection.
fn mutation_result(attempts: &[Outcome]) -> &Outcome {
    attempts
        .iter()
        .find(|outcome| outcome.class != REJECTED)
        .unwrap_or(&attempts[0])
}

#[test]
fn a_timing_retry_that_does_not_reject_decides_the_result() {
    let outcome = |class, millis| Outcome {
        class,
        report: String::new(),
        elapsed: Duration::from_millis(millis),
    };
    for retry in ["crash", ACCEPTED, "no verdict", "timeout"] {
        let attempts = [outcome(REJECTED, 250), outcome(retry, 5)];
        assert_eq!(mutation_result(&attempts).class, retry);
    }
    let attempts = [outcome(REJECTED, 250), outcome(REJECTED, 20)];
    assert_eq!(mutation_result(&attempts).class, REJECTED);
}

fn known_answer_time(verifier: &BbProcessVerifier, kat: &KnownAnswer) -> Duration {
    let mut times: Vec<Duration> = (0..KNOWN_ANSWER_RUNS)
        .map(|_| {
            let outcome = run(verifier, kat.vk, kat.proof, kat.public_inputs);
            assert_eq!(outcome.class, ACCEPTED, "{}: {}", kat.name, outcome.report);
            outcome.elapsed
        })
        .collect();
    times.sort();
    times[KNOWN_ANSWER_RUNS / 2]
}

fn setting(name: &str, default: u64) -> u64 {
    std::env::var(name).map_or(default, |value| {
        value
            .parse()
            .unwrap_or_else(|_| panic!("{name} must be a whole number"))
    })
}

/// The end of a long report, where bb says what failed.
fn tail(report: &str) -> &str {
    let mut start = report.len().saturating_sub(REPORT_TAIL_BYTES);
    while !report.is_char_boundary(start) {
        start += 1;
    }
    &report[start..]
}

fn milliseconds(duration: Duration) -> String {
    format!("{:.1} ms", duration.as_secs_f64() * 1000.0)
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn malformed_proofs_are_rejections() {
    let verifier = BbProcessVerifier::from_env().expect("pinned bb (set PCASH_TOOL_ROOT)");
    let flips = setting("PCASH_VERIFY_FUZZ_FLIPS", 256);
    let seed = setting("PCASH_VERIFY_FUZZ_SEED", 565);
    let mut log = std::env::var_os("PCASH_VERIFY_FUZZ_LOG")
        .map(|path| std::fs::File::create(path).expect("PCASH_VERIFY_FUZZ_LOG is not writable"));

    let mut known_answers = String::new();
    let mut families: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut classes: BTreeMap<String, usize> = BTreeMap::new();
    let mut slowest: Vec<(Duration, String)> = Vec::new();
    let mut flagged = Vec::new();
    let started = Instant::now();
    for (number, kat) in HIDING_KERNEL_KATS.iter().enumerate() {
        verifier.assert_known_answers().unwrap();
        let layout = layout(&verifier, kat);
        let own_time = known_answer_time(&verifier, kat);
        let limit = own_time * SLOW_FACTOR;
        let mut random = Random(seed ^ number as u64);
        let mutations = mutations(kat, &layout, flips, &mut random);
        writeln!(
            known_answers,
            "| `{}` | {} | {} | {} |",
            kat.name,
            mutations.len(),
            milliseconds(own_time),
            milliseconds(limit)
        )
        .unwrap();
        for mutation in mutations {
            let proof = with_words(kat.proof, &mutation.proof);
            let public_inputs = with_words(kat.public_inputs, &mutation.public_inputs);
            let mut attempts = vec![run(&verifier, kat.vk, &proof, &public_inputs)];
            let mut slow = attempts[0].elapsed > limit;
            if slow {
                // A busy machine slows every verification. Time the mutation
                // again beside its known answer, and flag it only if it is
                // still slow against that. The retry is kept as an attempt in
                // its own right, so a retry that does not reject is flagged.
                attempts.push(run(&verifier, kat.vk, &proof, &public_inputs));
                let control = run(&verifier, kat.vk, kat.proof, kat.public_inputs);
                assert_eq!(control.class, ACCEPTED, "{}: {}", kat.name, control.report);
                slow = attempts[1].elapsed > control.elapsed * SLOW_FACTOR;
            }
            let name = format!("`{}` {} at {}", kat.name, mutation.family, mutation.site);
            if let Some(log) = log.as_mut() {
                for (attempt, outcome) in attempts.iter().enumerate() {
                    writeln!(
                        log,
                        "{}\t{}\t{}\t{}\t{}\t{}\t{}",
                        kat.name,
                        mutation.family,
                        mutation.site,
                        attempt,
                        outcome.class,
                        outcome.elapsed.as_micros(),
                        outcome.report.replace(['\n', '\t'], " ")
                    )
                    .unwrap();
                }
            }
            let outcome = mutation_result(&attempts);
            let rejected = outcome.class == REJECTED;
            let elapsed = attempts
                .iter()
                .map(|outcome| outcome.elapsed)
                .min()
                .unwrap();
            let family = families.entry(mutation.family).or_default();
            family.0 += 1;
            if !rejected || slow {
                family.1 += 1;
                let history = attempts
                    .iter()
                    .map(|outcome| {
                        format!("{} in {}", outcome.class, milliseconds(outcome.elapsed))
                    })
                    .collect::<Vec<_>>()
                    .join(", then ");
                flagged.push(format!("{name}: {history}\n{}", tail(&outcome.report)));
            }
            let class = if rejected {
                format!("rejected: {}", outcome.report)
            } else {
                outcome.class.to_owned()
            };
            *classes.entry(class).or_default() += 1;
            slowest.push((elapsed, format!("{name}: {}", outcome.class)));
            slowest.sort_by(|a, b| b.0.cmp(&a.0));
            slowest.truncate(SLOWEST_SHOWN);
        }
    }

    let mut summary = format!(
        "Malformed-proof fuzz: {flips} random flips per known answer, seed {seed}, \
         {:.0} s.\n\n| known answer | mutations | own time | slow limit |\n|---|---|---|---|\n\
         {known_answers}\n| mutation | count | flagged |\n|---|---|---|\n",
        started.elapsed().as_secs_f64()
    );
    for (family, (count, flags)) in &families {
        writeln!(summary, "| {family} | {count} | {flags} |").unwrap();
    }
    summary.push_str("\n| result | count |\n|---|---|\n");
    for (class, count) in &classes {
        writeln!(summary, "| {class} | {count} |").unwrap();
    }
    summary.push_str("\n| slowest | time |\n|---|---|\n");
    for (elapsed, name) in &slowest {
        writeln!(summary, "| {name} | {} |", milliseconds(*elapsed)).unwrap();
    }
    eprintln!("{summary}");
    assert!(
        flagged.is_empty(),
        "{} flagged mutations:\n{}",
        flagged.len(),
        flagged.join("\n\n")
    );
}
