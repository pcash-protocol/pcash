#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]

use super::cache::*;
use super::kat::*;
use super::process::*;
use super::refusal::*;
use super::*;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const TEST_TIMEOUT: Duration = Duration::from_millis(100);

/// A fake-worker `ChonkVerify` refusal that bb attributes to the proof. A
/// token's text after `|` is what the fake writes to stderr before answering,
/// with each backslash-`n` pair written as a line break.
const REJECTED: &str = "false|ChonkVerifier: verification failed at ECCVM step (mem: 8.48 MiB)";
const OUT_OF_MEMORY: &str = "false|ChonkVerify: malformed input: std::bad_alloc (mem: 8.48 MiB)";
/// The verbose line logged when the translator+joint reduction succeeds.
const REACHED_FINAL_CHECK: &str =
    "ChonkVerifier: Batched translator+joint reduction: true (mem: 8.69 MiB)";

// ------------------------------------------------------------------
// Persistent MessagePack worker and release checks.
// ------------------------------------------------------------------

#[cfg(unix)]
fn fake_worker(extra_responses: &[&str]) -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().unwrap();
    let responses = directory.path().join("responses");
    let captures = directory.path().join("captures");
    let pids = directory.path().join("pids");
    let script = directory.path().join("bb");
    let mut tokens: Vec<String> = HIDING_KERNEL_KATS
        .iter()
        .flat_map(|kat| {
            let inputs = hex::encode(kat.public_inputs);
            [
                format!("decompress:{inputs}"),
                "true".to_owned(),
                format!("decompress:{inputs}"),
                REJECTED.to_owned(),
            ]
        })
        .collect();
    let default_inputs = hex::encode(PRIVATE_VALUE_HIDING_KERNEL_KAT.public_inputs);
    for response in extra_responses {
        if response.starts_with("true")
            || response.starts_with("false")
            || response.starts_with("error:")
            || response.starts_with("deaf_once:")
            || response.starts_with("signal:")
            || response.starts_with("exit:")
            || *response == "truncated"
        {
            let (verdict, inputs) = response
                .split_once('@')
                .unwrap_or((response, default_inputs.as_str()));
            tokens.push(format!("decompress:{inputs}"));
            tokens.push(verdict.to_owned());
        } else if *response == "undecompressable" {
            tokens.push("error:proof_compression: compressed proof too short".to_owned());
        } else if *response == "broken_pipe" {
            // Decompression answers and then stops reading, so the verification
            // request after it cannot be written.
            tokens.push(format!("close_stdin:decompress:{default_inputs}"));
        } else if let Some(raw) = response.strip_prefix("raw:") {
            // One token for one request, with no decompression added.
            tokens.push(raw.to_owned());
        } else if response.starts_with("hang_once:")
            || response.starts_with("exit_once:")
            || response.starts_with("signal_once:")
            || response.starts_with("malformed_once:")
        {
            tokens.push(
                response.strip_suffix("true").unwrap_or(response).to_owned()
                    + &format!("decompress:{default_inputs}"),
            );
            tokens.push("true".to_owned());
        } else {
            tokens.push((*response).to_owned());
        }
    }
    std::fs::write(&responses, tokens.join("\n")).unwrap();

    let source = r#"#!/usr/bin/env python3
import os
import sys
import time

TOKENS = "__TOKENS__"
CAPTURES = "__CAPTURES__"
PIDS = "__PIDS__"

with open(PIDS, "a", encoding="utf8") as handle:
    handle.write(str(os.getpid()) + "\n")
with open(TOKENS, "r", encoding="utf8") as handle:
    tokens = iter(handle.read().splitlines())

def read_exact(count):
    data = b""
    while len(data) < count:
        chunk = sys.stdin.buffer.read(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data

def pack_string(value):
    data = value.encode("utf8")
    if len(data) < 32:
        return bytes([0xa0 | len(data)]) + data
    return b"\xd9" + bytes([len(data)]) + data

def response(name, key, value):
    return b"\x92" + pack_string(name) + b"\x81" + pack_string(key) + value

def pack_bin(value):
    if len(value) < 256:
        return b"\xc4" + bytes([len(value)]) + value
    return b"\xc5" + len(value).to_bytes(2, "big") + value

def pack_array(values):
    prefix = bytes([0x90 | len(values)]) if len(values) < 16 else b"\xdc" + len(values).to_bytes(2, "big")
    return prefix + b"".join(values)

def pack_map(values):
    return bytes([0x80 | len(values)]) + b"".join(pack_string(k) + v for k, v in values)

def decompressed(inputs):
    words = [bytes.fromhex(inputs[i:i + 64]) for i in range(0, len(inputs), 64)]
    proof = pack_map([
        ("hiding_oink_proof", pack_array([pack_bin(word) for word in words])),
        ("merge_proof", pack_array([])),
        ("eccvm_proof", pack_array([])),
        ("ipa_proof", pack_array([])),
        ("joint_proof", pack_array([])),
    ])
    return b"\x92" + pack_string("ChonkDecompressProofResponse") + pack_map([("proof", proof)])

while True:
    prefix = read_exact(4)
    if prefix is None:
        break
    length = int.from_bytes(prefix, "little")
    payload = read_exact(length)
    if payload is None:
        sys.exit(20)
    with open(CAPTURES, "ab") as handle:
        handle.write(prefix)
        handle.write(payload)
    try:
        token = next(tokens)
    except StopIteration:
        sys.exit(21)
    token, _, log = token.partition("|")
    if log:
        sys.stderr.buffer.write(log.replace("\\n", "\n").encode("utf8") + b"\n")
        sys.stderr.buffer.flush()

    stdin_closed = token.startswith("close_stdin:")
    if stdin_closed:
        os.close(0)
        token = token.split(":", 1)[1]
    if token == "hang":
        time.sleep(600)
    if token.startswith("signal:"):
        os.kill(os.getpid(), int(token.split(":", 1)[1]))
    if token == "truncated":
        frame = response("ChonkVerifyResponse", "valid", b"\xc2")
        sys.stdout.buffer.write(len(frame).to_bytes(4, "little") + frame[:-1])
        sys.stdout.buffer.flush()
        os.close(1)
        time.sleep(600)
    if token.startswith("hang_once:"):
        marker = TOKENS + ".hang_once"
        if not os.path.exists(marker):
            open(marker, "wb").close()
            time.sleep(600)
        token = token.split(":", 1)[1]
    if token.startswith("exit_once:"):
        _, code, replacement = token.split(":", 2)
        marker = TOKENS + ".exit_once"
        if not os.path.exists(marker):
            open(marker, "wb").close()
            sys.exit(int(code))
        token = replacement
    if token.startswith("signal_once:"):
        _, signal, replacement = token.split(":", 2)
        marker = TOKENS + ".signal_once"
        if not os.path.exists(marker):
            open(marker, "wb").close()
            os.kill(os.getpid(), int(signal))
        token = replacement
    if token.startswith("malformed_once:"):
        marker = TOKENS + ".malformed_once"
        if not os.path.exists(marker):
            open(marker, "wb").close()
            frame = b"\xc1"
            sys.stdout.buffer.write(len(frame).to_bytes(4, "little") + frame)
            sys.stdout.buffer.flush()
            continue
        token = token.split(":", 1)[1]
    if token.startswith("deaf_once:"):
        marker = TOKENS + ".deaf_once"
        token = token.split(":", 1)[1]
        if not os.path.exists(marker):
            open(marker, "wb").close()
            frame = response("ChonkVerifyResponse", "valid", b"\xc3" if token == "true" else b"\xc2")
            sys.stdout.buffer.write(len(frame).to_bytes(4, "little") + frame)
            sys.stdout.buffer.flush()
            time.sleep(600)
            continue
    if token == "oversize":
        sys.stdout.buffer.write((1048577).to_bytes(4, "little"))
        sys.stdout.buffer.flush()
        time.sleep(10)
        continue
    if token.startswith("exit:"):
        sys.exit(int(token.split(":", 1)[1]))
    if token == "stderr_exit":
        sys.stderr.buffer.write(b"x" * 300000 + b"last-words")
        sys.stderr.buffer.flush()
        sys.exit(7)
    if token.startswith("decompress:"):
        frame = decompressed(token.split(":", 1)[1])
    elif token.startswith("error:"):
        frame = response("ErrorResponse", "message", pack_string(token.split(":", 1)[1]))
    else:
        frame = response("ChonkVerifyResponse", "valid", b"\xc3" if token == "true" else b"\xc2")
    sys.stdout.buffer.write(len(frame).to_bytes(4, "little") + frame)
    sys.stdout.buffer.flush()
    if stdin_closed:
        time.sleep(600)
"#
    .replace("__TOKENS__", &responses.to_string_lossy())
    .replace("__CAPTURES__", &captures.to_string_lossy())
    .replace("__PIDS__", &pids.to_string_lossy());
    std::fs::write(&script, source).unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&script, permissions).unwrap();
    (directory, script, captures, pids)
}

#[cfg(unix)]
fn captured_commands(path: &Path) -> Vec<rmpv::Value> {
    let bytes = std::fs::read(path).unwrap();
    let mut cursor = 0_usize;
    let mut commands = Vec::new();
    while cursor < bytes.len() {
        let length_bytes: [u8; 4] = bytes[cursor..cursor + 4].try_into().unwrap();
        cursor += 4;
        let length = u32::from_le_bytes(length_bytes) as usize;
        commands.push(rmpv::decode::read_value(&mut &bytes[cursor..cursor + length]).unwrap());
        cursor += length;
    }
    commands
}

#[cfg(unix)]
fn map_value<'a>(map: &'a [(rmpv::Value, rmpv::Value)], key: &str) -> &'a rmpv::Value {
    map.iter()
        .find_map(|(name, value)| (name.as_str() == Some(key)).then_some(value))
        .unwrap()
}

#[test]
fn sha256_digest_matches_known_answer() {
    assert_eq!(
        hex::encode(sha256_digest(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn diagnostic_tail_keeps_the_most_recent_bytes() {
    let mut tail = Vec::new();
    retain_tail(&mut tail, &vec![b'x'; MAX_DIAGNOSTIC_BYTES as usize]);
    retain_tail(&mut tail, b"newest");
    assert_eq!(tail.len(), MAX_DIAGNOSTIC_BYTES as usize);
    assert!(tail.ends_with(b"xnewest"));
}

#[test]
fn bundled_known_answers_have_canonical_wire_shapes() {
    for kat in HIDING_KERNEL_KATS {
        assert!(proof_nonempty_and_inputs_canonical(
            kat.proof,
            kat.public_inputs
        ));
        assert!(proof_nonempty_and_inputs_canonical(
            kat.rejected_proof,
            kat.public_inputs
        ));
        assert_eq!(kat.proof.len(), kat.rejected_proof.len());
    }
}

#[cfg(unix)]
#[test]
fn worker_reuses_one_pid_and_encodes_chonk_requests() {
    let inputs = "01".repeat(32);
    let positive = format!("true@{inputs}");
    let negative = format!("{REJECTED}@{inputs}");
    let (_directory, bb, captures, pids) = fake_worker(&[&positive, &negative]);
    let verifier = BbProcessVerifier::new(bb);
    let proof = vec![0_u8; 64];
    let public_inputs = vec![1_u8; 32];
    assert!(verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &public_inputs)
        .unwrap());
    assert!(!verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &public_inputs)
        .unwrap());

    assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 1);
    let commands = captured_commands(&captures);
    let batch = commands.last().unwrap().as_array().unwrap();
    let tagged = batch.first().unwrap().as_array().unwrap();
    assert_eq!(tagged.first().unwrap().as_str(), Some("ChonkVerify"));
    let request = tagged.get(1).unwrap().as_map().unwrap();
    assert_eq!(
        map_value(request, "vk").as_slice(),
        Some(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk)
    );
    let encoded_proof = map_value(request, "proof").as_map().unwrap();
    let hiding = map_value(encoded_proof, "hiding_oink_proof")
        .as_array()
        .unwrap();
    assert_eq!(hiding[0].as_slice(), Some(&[1_u8; 32][..]));
}

#[cfg(unix)]
#[test]
fn distinct_verifiers_own_distinct_workers() {
    let (_directory, bb, _captures, pids) = fake_worker(&["true"]);
    let first = BbProcessVerifier::new(&bb);
    let second = BbProcessVerifier::new(&bb);
    let proof = vec![0_u8; 32];
    assert!(first
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[])
        .unwrap());
    assert!(second
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[])
        .unwrap());
    let mut worker_pids: Vec<_> = std::fs::read_to_string(pids)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    worker_pids.sort();
    worker_pids.dedup();
    assert_eq!(worker_pids.len(), 2);
}

#[test]
fn noncanonical_fields_reject_before_worker_spawn() {
    let verifier = BbProcessVerifier::new("/definitely/not/a/bb/binary");
    for (proof, public_inputs) in [
        (Vec::new(), Vec::new()),
        (vec![0_u8; 32], vec![0_u8; 31]),
        (vec![0_u8; 32], BN254_SCALAR_MODULUS.to_vec()),
    ] {
        assert!(!verifier.verify(b"vk", &proof, &public_inputs).unwrap());
    }
}

#[test]
fn tool_root_without_bb_names_the_missing_binary() {
    let root = tempfile::tempdir().unwrap();
    let error = BbProcessVerifier::from_tool_root(root.path())
        .err()
        .expect("a tool root without bb must not yield a verifier");
    assert_eq!(
        error.to_string(),
        format!(
            "pinned bb binary is missing at {}; run `just tools`",
            root.path().join("bb").join("bb").display()
        )
    );
}

#[cfg(unix)]
#[test]
fn reported_and_undecompressable_proofs_are_final_rejections() {
    let (_directory, bb, captures, pids) = fake_worker(&[REJECTED, "undecompressable", "true"]);
    let verifier = BbProcessVerifier::new(bb);
    assert!(!verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap());
    assert!(!verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap());
    assert!(verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap());
    // Neither rejection costs the worker or any further request: a verdict
    // takes decompression and verification, an undecompressable proof only
    // the former.
    assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 1);
    assert_eq!(
        captured_commands(&captures).len(),
        STARTUP_KNOWN_ANSWER_REQUESTS + 5
    );
}

#[cfg(unix)]
#[test]
fn verification_error_response_is_a_protocol_failure() {
    let (_directory, bb, _captures, pids) = fake_worker(&["error:bad request"]);
    let verifier = BbProcessVerifier::new(bb);
    for _ in 0..2 {
        assert!(matches!(
            verifier.verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[]),
            Err(VerifyError::Protocol { detail, .. }) if detail.contains("bad request")
        ));
    }
    // The worker is stopped rather than reused after the error frame.
    assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 2);
}

#[cfg(unix)]
#[test]
fn startup_known_answers_reject_a_broken_worker() {
    let (directory, bb, _captures, pids) = fake_worker(&[]);
    std::fs::write(
        directory.path().join("responses"),
        format!(
            "decompress:{}\nfalse\n",
            hex::encode(PRIVATE_VALUE_HIDING_KERNEL_KAT.public_inputs)
        ),
    )
    .unwrap();
    let verifier = BbProcessVerifier::new(bb);
    assert!(matches!(
        verifier.assert_known_answers(),
        Err(VerifyError::KnownAnswer { .. })
    ));
    // A worker that answered a known answer wrongly is never reused: the
    // retry runs against a fresh process rather than the discredited one.
    assert!(matches!(
        verifier.assert_known_answers(),
        Err(VerifyError::KnownAnswer { .. })
    ));
    assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 2);
}

#[cfg(unix)]
#[test]
fn startup_known_answers_pass_with_an_unwritable_tmpdir() {
    use std::os::unix::fs::PermissionsExt;

    const CHILD: &str = "PCASH_VERIFY_UNWRITABLE_TMPDIR_CHILD";
    const BB: &str = "PCASH_VERIFY_UNWRITABLE_TMPDIR_BB";
    if std::env::var_os(CHILD).is_some() {
        let tmpdir = PathBuf::from(std::env::var_os("TMPDIR").unwrap());
        assert!(std::fs::File::create(tmpdir.join("must-not-exist")).is_err());
        BbProcessVerifier::new(std::env::var_os(BB).unwrap())
            .assert_known_answers()
            .unwrap();
        return;
    }

    let (directory, bb, _captures, _pids) = fake_worker(&[]);
    let tmpdir = directory.path().join("unwritable");
    std::fs::create_dir(&tmpdir).unwrap();
    std::fs::set_permissions(&tmpdir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::startup_known_answers_pass_with_an_unwritable_tmpdir",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .env(BB, bb)
        .env("TMPDIR", &tmpdir)
        .output()
        .unwrap();
    std::fs::set_permissions(&tmpdir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        output.status.success(),
        "child failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[test]
fn timeout_kills_worker_and_next_call_restarts_with_kats() {
    let (_directory, bb, captures, _pids) = fake_worker(&["hang_once:true"]);
    let verifier = BbProcessVerifier::new(bb);
    verifier.assert_known_answers().unwrap();
    let verifier = verifier.with_timeout(TEST_TIMEOUT);
    assert!(matches!(
        verifier.verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[]),
        Err(VerifyError::Timeout { timeout_ms, .. }) if timeout_ms == TEST_TIMEOUT.as_millis()
    ));
    let captured_before_recovery = captured_commands(&captures).len();
    let verifier = verifier.with_timeout(DEFAULT_COMMAND_TIMEOUT);
    assert!(verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap());
    assert_eq!(
        captured_commands(&captures).len() - captured_before_recovery,
        STARTUP_KNOWN_ANSWER_REQUESTS + 2
    );
}

#[cfg(unix)]
#[test]
fn unresponsive_worker_times_out_and_restarts_with_kats() {
    let (_directory, bb, captures, _pids) = fake_worker(&["deaf_once:true"]);
    let verifier = BbProcessVerifier::new(bb).with_timeout(DEFAULT_COMMAND_TIMEOUT);
    // The worker answers this call and then stops reading stdin forever.
    assert!(verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap());
    let verifier = verifier.with_timeout(TEST_TIMEOUT);
    // Exercise the same deadline whether the host pipe blocks mid-write or
    // buffers the request before the unresponsive worker is killed.
    let large_proof = vec![0_u8; 256 * 1024];
    assert!(matches!(
        verifier.verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &large_proof, &[]),
        Err(VerifyError::Timeout { timeout_ms, .. }) if timeout_ms == TEST_TIMEOUT.as_millis()
    ));
    let captured_before_recovery = captured_commands(&captures).len();
    let verifier = verifier.with_timeout(DEFAULT_COMMAND_TIMEOUT);
    assert!(verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap());
    assert_eq!(
        captured_commands(&captures).len() - captured_before_recovery,
        STARTUP_KNOWN_ANSWER_REQUESTS + 2
    );
}

#[cfg(unix)]
#[test]
fn oversized_request_is_refused_without_disturbing_the_worker() {
    let (_directory, bb, captures, pids) = fake_worker(&["true"]);
    let verifier = BbProcessVerifier::new(bb);
    verifier.assert_known_answers().unwrap();
    assert!(matches!(
        verifier.verify(
            PRIVATE_VALUE_HIDING_KERNEL_KAT.vk,
            &vec![0_u8; 2 * 1024 * 1024],
            &[]
        ),
        Err(VerifyError::Protocol { .. })
    ));
    assert!(verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap());
    // Only the startup known answers and the small verification were ever
    // framed: the refusal happened before the worker was involved.
    assert_eq!(
        captured_commands(&captures).len(),
        STARTUP_KNOWN_ANSWER_REQUESTS + 2
    );
    assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 1);
}

#[cfg(unix)]
#[test]
fn eof_and_invalid_msgpack_restart_cleanly() {
    for token in [
        "exit_once:7:true",
        "signal_once:9:true",
        "malformed_once:true",
    ] {
        let (_directory, bb, _captures, pids) = fake_worker(&[token]);
        let verifier = BbProcessVerifier::new(bb);
        assert!(verifier
            .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
            .is_err());
        assert!(verifier
            .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
            .unwrap());
        assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 2);
    }
}

#[cfg(unix)]
#[test]
fn oversized_response_is_a_protocol_failure() {
    let (_directory, bb, _captures, _pids) = fake_worker(&["oversize"]);
    assert!(matches!(
        BbProcessVerifier::new(bb).verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[]),
        Err(VerifyError::Protocol { .. })
    ));
}

#[cfg(unix)]
#[test]
fn worker_stderr_is_captured_and_capped() {
    let (_directory, bb, _captures, _pids) = fake_worker(&["stderr_exit"]);
    let error = BbProcessVerifier::new(bb)
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap_err();
    let stderr = match error {
        VerifyError::Abnormal { stderr, .. } | VerifyError::Transport { stderr, .. } => stderr,
        other => panic!("unexpected failure: {other}"),
    };
    assert_eq!(stderr.len(), MAX_DIAGNOSTIC_BYTES as usize);
    assert!(stderr.ends_with("last-words"));
}

#[cfg(unix)]
#[test]
fn drop_closes_stdin_and_reaps_the_worker() {
    let (_directory, bb, _captures, pids) = fake_worker(&[]);
    let verifier = BbProcessVerifier::new(bb);
    verifier.assert_known_answers().unwrap();
    let pid = std::fs::read_to_string(pids).unwrap();
    let pid = pid.trim();
    drop(verifier);
    assert!(!Command::new("kill")
        .args(["-0", pid])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
}

#[cfg(unix)]
#[test]
fn dropping_a_worker_without_stopping_it_reaps_the_child() {
    let (_directory, bb, _captures, _pids) = fake_worker(&[]);
    let worker = BbProcessVerifier::new(bb).spawn_worker().unwrap();
    let pid = worker.child.id().to_string();
    // No explicit `stop`: the child must still be closed out and reaped.
    drop(worker);
    assert!(!Command::new("kill")
        .args(["-0", &pid])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
}

#[test]
fn release_assertion_binds_the_bb_binary_and_the_crs_bytes_bb_reads() {
    let directory = tempfile::tempdir().unwrap();
    let bb = directory.path().join("bb");
    std::fs::write(&bb, b"the pinned bb").unwrap();
    let binary = sha256_digest(b"the pinned bb");
    let crs = tempfile::tempdir().unwrap();
    let g1_path = crs.path().join("bn254_g1.dat");
    let mut g1 = BN254_G1_GENERATOR.to_vec();
    g1.extend_from_slice(b"points the verifier never reads");
    std::fs::write(&g1_path, &g1).unwrap();
    let grumpkin = b"pinned grumpkin prefix|unpinned tail";
    let prefix = grumpkin.iter().position(|byte| *byte == b'|').unwrap();
    let pin = sha256_digest(&grumpkin[..prefix]);
    std::fs::write(crs.path().join("grumpkin_g1_v2.flat.dat"), grumpkin).unwrap();
    // No `bn254_g2.dat`: bb compiles the G2 element in.
    let verifier = BbProcessVerifier::new(&bb).with_crs_path(crs.path());
    verifier.assert_release(binary, prefix, pin).unwrap();

    // Another build is refused whatever version it would report.
    let other = directory.path().join("other-bb");
    std::fs::write(&other, b"another bb").unwrap();
    assert!(matches!(
        BbProcessVerifier::new(&other)
            .with_crs_path(crs.path())
            .assert_release(binary, prefix, pin),
        Err(VerifyError::BinaryMismatch { path, expected, actual })
            if path == other
                && expected == hex::encode(binary)
                && actual == hex::encode(sha256_digest(b"another bb"))
    ));
    assert!(matches!(
        verifier.assert_release(binary, prefix, [0_u8; 32]),
        Err(VerifyError::CrsMismatch { .. })
    ));
    assert!(matches!(
        verifier.assert_release(binary, grumpkin.len() + 1, pin),
        Err(VerifyError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof
    ));
    g1[63] = 3;
    std::fs::write(&g1_path, &g1).unwrap();
    assert!(matches!(
        verifier.assert_release(binary, prefix, pin),
        Err(VerifyError::CrsMismatch { path, .. }) if path == g1_path
    ));
}

// ------------------------------------------------------------------
// Which refusals are verdicts.
// ------------------------------------------------------------------

fn verification_refusal(stderr: &str) -> bool {
    proof_caused(Refusal::Verification { stderr })
}

#[test]
fn refusals_bb_attributes_to_the_proof_are_rejections() {
    // Each line is the pinned binary's own output for a proof-caused refusal.
    for stderr in [
        "ChonkVerifier: verification failed at ECCVM step (mem: 33.38 MiB)",
        "ChonkVerifier: verification failed at batched translator+joint pairing check (mem: 8.48 MiB)",
        "IPA batch verification failed: combined G_0 mismatch (mem: 33.38 MiB)",
        "ChonkVerify: proof has wrong size: expected 1220, got 1236 (mem: 8.48 MiB)",
        "vk hash in Oink verifier: 0x19 (mem: 8.48 MiB)\n\
         ChonkVerify: malformed input: Assertion failed: (uint256_t(fr_vec[1]) < (uint256_t(1) \
         << (TOTAL_BITS - NUM_LIMB_BITS * 2)))\n  Left   : 0x01\n  Right  : 0x40\n  \
         Reason : Conversion error (mem: 8.48 MiB)",
        "ChonkVerify: malformed input: Assertion failed: (uint256_t(fr_vec[0]) < (uint256_t(1) \
         << (NUM_LIMB_BITS * 2)))\n  Left   : 0x01\n  Right  : 0x40 (mem: 8.48 MiB)",
        "ChonkVerify: malformed input: Assertion failed: (value < fq::modulus)\n  Left   : 0x01\n  \
         Right  : 0x40\n  Reason : Non-canonical field element (mem: 8.48 MiB)",
        "ChonkVerify: malformed input: Deserialized point is not on the curve (mem: 8.48 MiB)",
        "ChonkVerify: malformed input: Deserialized point is not on the curve",
        // A failed final IPA check is logged after the progress line.
        "ChonkVerifier: Batched translator+joint reduction: true (mem: 8.69 MiB)\n\
         IPA batch verification failed: combined G_0 mismatch (mem: 34.36 MiB)\n",
    ] {
        assert!(verification_refusal(stderr), "{stderr}");
    }
    // Verbose progress reaching the final IPA discharge, whose group relation
    // fails silently, as the last thing logged.
    for stderr in [
        format!("ChonkVerifier: ECCVM reduced to TripleIPA claim: true (mem: 8.48 MiB)\n{REACHED_FINAL_CHECK}"),
        format!("{REACHED_FINAL_CHECK}\n"),
    ] {
        assert!(verification_refusal(&stderr), "{stderr}");
    }
    assert!(proof_caused(Refusal::Decompression {
        message: "proof_compression: Grumpkin point not on curve",
    }));
}

#[test]
fn refusals_without_a_proof_caused_report_are_not_rejections() {
    for stderr in [
        "",
        "ChonkVerify: malformed input: std::bad_alloc (mem: 8.48 MiB)",
        "ChonkVerify: malformed input: unknown exception (mem: 8.48 MiB)",
        "ChonkVerify: malformed input: HTTP request failed for https://crs (mem: 8.48 MiB)",
        // Only the assertions a proof can reach are rejections.
        "ChonkVerify: malformed input: Assertion failed: (srs != nullptr) (mem: 8.48 MiB)",
        "ChonkVerify: malformed input: Assertion failed: (value < fq::modulus_2)\n  Left   : 0x01",
        "ChonkVerify: malformed input: Deserialized point is not on the curve, or more (mem: 8.48 MiB)",
        "ChonkVerify: verification key has wrong size: expected 1, got 2 (mem: 8.48 MiB)",
        "ChonkVerifier: databus consistency verified: 1 (mem: 8.48 MiB)",
        // A report must start its line.
        "prefix ChonkVerifier: verification failed at ECCVM step",
        // A recognized exception must be the last report.
        "ChonkVerify: malformed input: Deserialized point is not on the curve (mem: 8.48 MiB)\n\
         ChonkVerify: ma (mem: 1.62 MiB)",
    ] {
        assert!(!verification_refusal(stderr), "{stderr}");
    }
    // Out of memory, bb's formatter logs whatever part of a report it built,
    // possibly nothing but the memory note, and with `BB_DISABLE_MEM_USAGE`
    // nothing at all. A recognized report followed by any of that, or by any
    // other line, is no verdict.
    for recognized in [
        REACHED_FINAL_CHECK,
        "ChonkVerifier: verification failed at ECCVM step (mem: 8.48 MiB)",
        "IPA batch verification failed: combined G_0 mismatch (mem: 34.36 MiB)",
        "ChonkVerify: proof has wrong size: expected 1220, got 1236 (mem: 8.48 MiB)",
    ] {
        for trailing in [
            "ChonkVerify: malformed input: std::bad_alloc (mem: 9.00 MiB)",
            "ChonkVerify: ma (mem: 1.62 MiB)",
            " (mem: 1.62 MiB)",
            "",
            "using cached grumpkin crs with num points 65536 (mem: 11.25 MiB)",
        ] {
            let stderr = format!("{recognized}\n{trailing}\n");
            assert!(!verification_refusal(&stderr), "{stderr:?}");
        }
    }
    for message in ["std::bad_alloc", "bbapi: unknown exception", ""] {
        assert!(
            !proof_caused(Refusal::Decompression { message }),
            "{message}"
        );
    }
}

#[cfg(unix)]
#[test]
fn worker_refusals_are_rejections_only_with_a_proof_caused_report() {
    let assertion =
        "false|ChonkVerify: malformed input: Assertion failed: (value < fq::modulus)\\n  \
                     Left   : 0x01\\n  Reason : Non-canonical field element (mem: 8.48 MiB)";
    let cases: [(&str, Option<bool>); 10] = [
        (REJECTED, Some(false)),
        (assertion, Some(false)),
        (
            "raw:error:proof_compression: Grumpkin point not on curve",
            Some(false),
        ),
        ("true", Some(true)),
        (&format!("false|{REACHED_FINAL_CHECK}"), Some(false)),
        (OUT_OF_MEMORY, None),
        ("false", None),
        (
            "false|ChonkVerify: malformed input: HTTP request failed (mem: 8.48 MiB)",
            None,
        ),
        (
            "false|ChonkVerify: malformed input: Assertion failed: (srs != nullptr)",
            None,
        ),
        ("raw:error:std::bad_alloc", None),
    ];
    for (token, expected) in cases {
        let (_directory, bb, _captures, pids) = fake_worker(&[token]);
        let verifier = BbProcessVerifier::new(bb);
        let result = verifier.verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[]);
        if let Some(verdict) = expected {
            assert_eq!(result.unwrap(), verdict, "{token}");
        } else {
            assert!(
                matches!(&result, Err(VerifyError::VerifierFault { .. })),
                "{token}: {result:?}"
            );
            assert!(result.unwrap_err().is_transient());
        }
        // A refusal without a verdict retires the worker; a verdict does not.
        assert_eq!(
            lock_unpoisoned(&verifier.worker).worker.is_some(),
            expected.is_some(),
            "{token}"
        );
        assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 1);
    }
}

#[cfg(unix)]
#[test]
fn recognized_rejection_after_more_than_the_diagnostic_cap_does_not_block() {
    let recognized = &REJECTED["false|".len()..];
    let response = format!(
        "false|{}\\n{recognized}",
        "x".repeat(MAX_DIAGNOSTIC_BYTES as usize + 4096)
    );
    let (_directory, bb, _captures, _pids) = fake_worker(&[&response]);
    let verifier = BbProcessVerifier::new(bb).with_timeout(Duration::from_secs(5));
    assert!(!verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap());
}

#[cfg(unix)]
#[test]
fn each_request_reads_only_its_own_stderr() {
    let inputs = hex::encode(PRIVATE_VALUE_HIDING_KERNEL_KAT.public_inputs);
    // A fault line logged while decompressing is not part of the
    // verification that follows, which reports a proof-caused refusal.
    let fault = &OUT_OF_MEMORY["false|".len()..];
    let decompression = format!("raw:decompress:{inputs}|{fault}");
    let (_directory, bb, _captures, _pids) =
        fake_worker(&[&decompression, &format!("raw:{REJECTED}"), "false"]);
    let verifier = BbProcessVerifier::new(bb);
    assert!(!verifier
        .verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[])
        .unwrap());
    // Nor does the previous request's recognized report carry over.
    assert!(matches!(
        verifier.verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &[0_u8; 32], &[]),
        Err(VerifyError::VerifierFault { request: "ChonkVerify", report }) if report.is_empty()
    ));
}

#[cfg(unix)]
#[test]
fn out_of_memory_is_retried_and_never_cached_as_a_rejection() {
    // A whole `std::bad_alloc` report, and the cut-off reports bb's formatter
    // leaves when memory runs out after the final-check progress line.
    let cut_off = format!("false|{REACHED_FINAL_CHECK}\\nChonkVerify: ma (mem: 1.62 MiB)");
    let memory_note_only = format!("false|{REACHED_FINAL_CHECK}\\n (mem: 1.62 MiB)");
    for (token, report) in [
        (OUT_OF_MEMORY, "std::bad_alloc"),
        (cut_off.as_str(), "ChonkVerify: ma"),
        (memory_note_only.as_str(), " (mem: 1.62 MiB)"),
    ] {
        let (_directory, bb, _captures, pids) = fake_worker(&[token]);
        let verifier = BbProcessVerifier::new(bb);
        let proof = [0_u8; 32];
        let mut cache = VerifyCache::new();
        cache.warm(&verifier, PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]);
        // The retry ran on a fresh worker, which proved its known answers first.
        assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 2);
        assert!(
            matches!(
                cache.get(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]),
                Some(CachedVerification::ToolFailure { error }) if error.contains(report)
            ),
            "{token}"
        );
        let under_lock = Counting::new(false);
        assert!(matches!(
            CachedVerifier::new_complete(&cache, &under_lock).verify(
                PRIVATE_VALUE_HIDING_KERNEL_KAT.vk,
                &proof,
                &[]
            ),
            Err(VerifyError::CachedToolFailure { .. })
        ));
        assert_eq!(under_lock.calls.get(), 0);
    }
}

#[cfg(unix)]
#[test]
fn worker_failures_on_the_target_are_never_rejections() {
    let signalled: fn(&VerifyError) -> bool =
        |error| matches!(error, VerifyError::Abnormal { exit, .. } if exit == SIGNAL_EXIT);
    let exited: fn(&VerifyError) -> bool = |error| matches!(error, VerifyError::Abnormal { .. });
    // A broken connection surfaces as an abnormal exit once the worker it
    // belonged to is stopped and reaped.
    let disconnected: fn(&VerifyError) -> bool = |error| {
        matches!(
            error,
            VerifyError::Transport { .. } | VerifyError::Abnormal { .. }
        )
    };
    // How the worker fails the target on every attempt, how many of the
    // target's framed requests it reads first, and the failure that surfaces.
    let cases = [
        ("signal:9", 2, signalled),
        ("exit:7", 2, exited),
        ("truncated", 2, disconnected),
        ("broken_pipe", 1, disconnected),
    ];
    for (token, target_requests, expected) in cases {
        let (_directory, bb, captures, pids) = fake_worker(&[token]);
        let verifier = BbProcessVerifier::new(bb);
        let proof = [0_u8; 32];
        let result = verifier.verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]);
        assert!(
            matches!(&result, Err(error) if expected(error)),
            "{token}: {result:?}"
        );
        let mut cache = VerifyCache::new();
        cache.warm(&verifier, PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]);
        let cached = cache.get(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]);
        assert!(
            matches!(cached, Some(CachedVerification::ToolFailure { .. })),
            "{token}: {cached:?}"
        );
        // Every attempt, the first and each retry, ran on a fresh worker that
        // answered every known answer before the target failed.
        let workers = std::fs::read_to_string(pids).unwrap().lines().count();
        assert_eq!(
            captured_commands(&captures).len(),
            workers * (STARTUP_KNOWN_ANSWER_REQUESTS + target_requests),
            "{token}"
        );
    }
}

/// Verifies as [`BbProcessVerifier::verify`] does, but proves a fresh worker's
/// known answers under the default bound first, so only the target runs under
/// [`TEST_TIMEOUT`].
struct TargetUnderTestTimeout(std::cell::RefCell<BbProcessVerifier>);

impl Verifier for TargetUnderTestTimeout {
    fn verify(&self, vk: &[u8], proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError> {
        let mut verifier = self.0.borrow_mut();
        verifier.command_timeout = DEFAULT_COMMAND_TIMEOUT;
        verifier.assert_known_answers().unwrap();
        verifier.command_timeout = TEST_TIMEOUT;
        verifier.verify(vk, proof, public_inputs)
    }
}

#[cfg(unix)]
#[test]
fn a_target_that_times_out_on_every_attempt_is_never_a_rejection() {
    let (_directory, bb, captures, pids) = fake_worker(&["hang"]);
    let verifier = TargetUnderTestTimeout(std::cell::RefCell::new(BbProcessVerifier::new(bb)));
    let proof = [0_u8; 32];
    assert!(matches!(
        verifier.verify(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]),
        Err(VerifyError::Timeout { timeout_ms, .. }) if timeout_ms == TEST_TIMEOUT.as_millis()
    ));
    let mut cache = VerifyCache::new();
    cache.warm(&verifier, PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]);
    assert!(matches!(
        cache.get(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]),
        Some(CachedVerification::ToolFailure { error }) if error.contains("timed out")
    ));
    // Three attempts, each on a fresh worker that answered every known answer
    // before the target's first request timed out.
    assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 3);
    assert_eq!(
        captured_commands(&captures).len(),
        3 * (STARTUP_KNOWN_ANSWER_REQUESTS + 1)
    );
}

#[cfg(unix)]
#[test]
fn a_retry_that_obtains_a_verdict_resolves_the_request() {
    let inputs = hex::encode(PRIVATE_VALUE_HIDING_KERNEL_KAT.public_inputs);
    // The first worker dies on the target; the fresh worker that replaces it
    // answers.
    let dies_once = format!("raw:signal_once:9:decompress:{inputs}");
    let rejected = format!("raw:{REJECTED}");
    for (answer, verdict) in [("raw:true", true), (rejected.as_str(), false)] {
        let (_directory, bb, _captures, pids) = fake_worker(&[&dies_once, answer]);
        let verifier = BbProcessVerifier::new(bb);
        let proof = [0_u8; 32];
        let mut cache = VerifyCache::new();
        cache.warm(&verifier, PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]);
        assert_eq!(std::fs::read_to_string(pids).unwrap().lines().count(), 2);
        assert_eq!(
            cache.get(PRIVATE_VALUE_HIDING_KERNEL_KAT.vk, &proof, &[]),
            Some(&CachedVerification::Verdict(verdict)),
            "{answer}"
        );
    }
}

#[cfg(unix)]
#[test]
fn startup_negative_known_answer_must_be_a_recognized_rejection() {
    let inputs = hex::encode(PRIVATE_VALUE_HIDING_KERNEL_KAT.public_inputs);
    for (negative, expected_report) in [("false", ""), (OUT_OF_MEMORY, "std::bad_alloc")] {
        let (directory, bb, _captures, _pids) = fake_worker(&[]);
        std::fs::write(
            directory.path().join("responses"),
            format!("decompress:{inputs}\ntrue\ndecompress:{inputs}\n{negative}\n"),
        )
        .unwrap();
        let result = BbProcessVerifier::new(bb).assert_known_answers();
        assert!(
            matches!(
                &result,
                Err(VerifyError::KnownAnswer { case, report })
                    if *case == PRIVATE_VALUE_HIDING_KERNEL_KAT.invalid_not_rejected
                        && report.contains(expected_report)
            ),
            "{negative}: {result:?}"
        );
    }
}

// ------------------------------------------------------------------
// Off-lock memoization.
// ------------------------------------------------------------------

/// Counts verifier invocations and returns a fixed clean verdict.
struct Counting {
    calls: std::cell::Cell<usize>,
    verdict: bool,
}
impl Counting {
    fn new(verdict: bool) -> Self {
        Self {
            calls: std::cell::Cell::new(0),
            verdict,
        }
    }
}
impl Verifier for Counting {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        self.calls.set(self.calls.get() + 1);
        Ok(self.verdict)
    }
}

#[test]
fn verification_key_separates_fields() {
    // Splitting a byte across the vk/proof boundary changes the key: length
    // prefixing prevents `(ab, c)` and `(a, bc)` from aliasing.
    assert_ne!(
        verification_key(b"ab", b"c", b""),
        verification_key(b"a", b"bc", b"")
    );
}

#[test]
fn cache_hit_never_calls_inner() {
    let inner = Counting::new(true);
    let mut cache = VerifyCache::new();
    cache.warm(&inner, b"vk", b"proof", b"pi");
    assert_eq!(inner.calls.get(), 1, "warm verifies once");

    let cached = CachedVerifier::new(&cache, &inner);
    assert!(cached.verify(b"vk", b"proof", b"pi").unwrap());
    assert!(cached.verify(b"vk", b"proof", b"pi").unwrap());
    assert_eq!(
        inner.calls.get(),
        1,
        "hits must not touch the inner verifier"
    );
}

#[test]
fn cache_miss_falls_back_to_inner_verdict() {
    // A reject verdict from the inner verifier survives the miss path.
    let inner = Counting::new(false);
    let cache = VerifyCache::new();
    let cached = CachedVerifier::new(&cache, &inner);
    assert!(!cached.verify(b"vk", b"proof", b"pi").unwrap());
    assert_eq!(
        inner.calls.get(),
        1,
        "a miss delegates to the inner verifier"
    );
}

#[test]
fn warm_dedups_identical_triples() {
    let inner = Counting::new(true);
    let mut cache = VerifyCache::new();
    cache.warm(&inner, b"vk", b"proof", b"pi");
    cache.warm(&inner, b"vk", b"proof", b"pi");
    assert_eq!(
        inner.calls.get(),
        1,
        "a re-warm of the same triple is a no-op"
    );
    assert!(
        cache.get(b"vk", b"proof", b"pi").is_some(),
        "the triple is memoized exactly once"
    );
}

#[test]
fn warm_caches_tool_failure_without_retrying_inner() {
    struct Boom;
    impl Verifier for Boom {
        fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
            Err(VerifyError::Abnormal {
                exit: "signal".into(),
                stdout: String::new(),
                stderr: "boom".into(),
            })
        }
    }
    let mut cache = VerifyCache::new();
    cache.warm(&Boom, b"vk", b"proof", b"pi");
    assert!(matches!(
        cache.get(b"vk", b"proof", b"pi"),
        Some(CachedVerification::ToolFailure { error }) if error.contains("boom")
    ));
    let inner = Counting::new(true);
    let cached = CachedVerifier::new_complete(&cache, &inner);
    assert!(matches!(
        cached.verify(b"vk", b"proof", b"pi"),
        Err(VerifyError::CachedToolFailure { .. })
    ));
    assert_eq!(inner.calls.get(), 0);
}

#[test]
fn transient_failure_classification_covers_environment_faults_only() {
    assert!(VerifyError::Io(std::io::Error::other("enospc")).is_transient());
    assert!(VerifyError::Spawn {
        path: PathBuf::from("bb"),
        source: std::io::Error::other("emfile"),
    }
    .is_transient());
    assert!(VerifyError::Timeout {
        timeout_ms: 1,
        stdout: String::new(),
        stderr: String::new(),
    }
    .is_transient());
    assert!(VerifyError::Transport {
        detail: "broken pipe".to_owned(),
        stderr: String::new(),
    }
    .is_transient());

    // A signal is the OOM killer far more often than it is this proof.
    assert!(VerifyError::Abnormal {
        exit: SIGNAL_EXIT.into(),
        stdout: String::new(),
        stderr: String::new(),
    }
    .is_transient());
    // Deterministic for the pinned verifier: retrying cannot change these.
    assert!(!VerifyError::Abnormal {
        exit: "2".into(),
        stdout: String::new(),
        stderr: String::new(),
    }
    .is_transient());
    assert!(!VerifyError::Protocol {
        detail: "wrong response".to_owned(),
        stderr: String::new(),
    }
    .is_transient());
    // A known answer that returned the wrong verdict means the verifier is
    // broken; no retry fixes that.
    assert!(!VerifyError::KnownAnswer {
        case: "broken",
        report: String::new(),
    }
    .is_transient());
}

/// Fails transiently for the first `fail_first` calls, then succeeds.
struct FlakyTransient {
    remaining_failures: std::cell::Cell<usize>,
    calls: std::cell::Cell<usize>,
}

impl FlakyTransient {
    fn new(fail_first: usize) -> Self {
        Self {
            remaining_failures: std::cell::Cell::new(fail_first),
            calls: std::cell::Cell::new(0),
        }
    }
}

impl Verifier for FlakyTransient {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        self.calls.set(self.calls.get() + 1);
        let remaining = self.remaining_failures.get();
        if remaining > 0 {
            self.remaining_failures.set(remaining - 1);
            return Err(VerifyError::Io(std::io::Error::other(
                "too many open files",
            )));
        }
        Ok(true)
    }
}

#[test]
fn transient_failure_is_retried_off_lock_during_warm() {
    let inner = FlakyTransient::new(1);
    let mut cache = VerifyCache::new();
    cache.warm(&inner, b"vk", b"proof", b"pi");
    assert_eq!(inner.calls.get(), 2, "one blip earns exactly one retry");
    assert!(matches!(
        cache.get(b"vk", b"proof", b"pi"),
        Some(CachedVerification::Verdict(true))
    ));

    // The settled verdict is what derivation reads, and reading it never
    // touches the inner verifier — nothing spawns bb under the state lock.
    let under_lock = Counting::new(false);
    let cached = CachedVerifier::new_complete(&cache, &under_lock);
    assert!(cached.verify(b"vk", b"proof", b"pi").unwrap());
    assert_eq!(under_lock.calls.get(), 0);
}

#[test]
fn persistent_transient_condition_settles_as_a_tool_failure_without_locked_retries() {
    let inner = FlakyTransient::new(usize::MAX);
    let mut cache = VerifyCache::new();
    cache.warm(&inner, b"vk", b"proof", b"pi");
    assert_eq!(inner.calls.get(), 2, "bounded at one retry, never a loop");
    assert!(matches!(
        cache.get(b"vk", b"proof", b"pi"),
        Some(CachedVerification::ToolFailure { error }) if error.contains("too many open files")
    ));

    // A condition that outlived the off-lock retry still halts derivation
    // rather than being accepted — and still without spawning under the lock.
    let under_lock = Counting::new(true);
    let cached = CachedVerifier::new_complete(&cache, &under_lock);
    assert!(matches!(
        cached.verify(b"vk", b"proof", b"pi"),
        Err(VerifyError::CachedToolFailure { .. })
    ));
    assert_eq!(under_lock.calls.get(), 0);
}

#[test]
fn deterministic_failure_is_not_retried() {
    struct AlwaysAbnormal(std::cell::Cell<usize>);
    impl Verifier for AlwaysAbnormal {
        fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
            self.0.set(self.0.get() + 1);
            Err(VerifyError::Abnormal {
                exit: "2".into(),
                stdout: String::new(),
                stderr: "deterministic".into(),
            })
        }
    }
    let inner = AlwaysAbnormal(std::cell::Cell::new(0));
    let mut cache = VerifyCache::new();
    cache.warm(&inner, b"vk", b"proof", b"pi");
    assert_eq!(inner.0.get(), 1, "same bytes, same answer: no retry");
}

#[test]
fn complete_cache_miss_fails_without_calling_inner() {
    let cache = VerifyCache::new();
    let inner = Counting::new(true);
    let cached = CachedVerifier::new_complete(&cache, &inner);
    assert!(matches!(
        cached.verify(b"vk", b"proof", b"pi"),
        Err(VerifyError::CompleteCacheMiss { .. })
    ));
    assert_eq!(inner.calls.get(), 0);
}

// ------------------------------------------------------------------
// Live tests: explicitly ignored because they require the external pinned
// bb and CRS. The fixtures themselves are committed and checked above.
// ------------------------------------------------------------------

struct LiveEnv {
    verifier: BbProcessVerifier,
    vk: Vec<u8>,
    proof: Vec<u8>,
    public_inputs: Vec<u8>,
}

fn live_env() -> LiveEnv {
    let verifier = BbProcessVerifier::from_env().unwrap();

    LiveEnv {
        verifier,
        vk: PRIVATE_VALUE_HIDING_KERNEL_KAT.vk.to_vec(),
        proof: PRIVATE_VALUE_HIDING_KERNEL_KAT.proof.to_vec(),
        public_inputs: PRIVATE_VALUE_HIDING_KERNEL_KAT.public_inputs.to_vec(),
    }
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn startup_known_answers_pass() {
    live_env().verifier.assert_known_answers().unwrap();
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn accepts_valid() {
    let env = live_env();
    let ok = env
        .verifier
        .verify(&env.vk, &env.proof, &env.public_inputs)
        .expect("verifier tool error");
    assert!(ok, "pinned bb rejected the real Aster kernel proof");
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn rejects_corrupt() {
    let env = live_env();
    let mut proof = env.proof.clone();
    // Flip a byte well inside the proof body.
    let idx = proof.len() / 2;
    proof[idx] ^= 0xff;
    let res = env
        .verifier
        .verify(&env.vk, &proof, &env.public_inputs)
        .expect("corrupt proof must be a clean reject, not a tool error");
    assert!(!res, "corrupt proof must verify to false");
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn rejects_wrong_public_inputs() {
    let env = live_env();
    let mut pi = env.public_inputs.clone();
    assert!(!pi.is_empty(), "fixture has no public inputs to perturb");
    // Perturb the low byte of the first public-input field.
    pi[31] ^= 0x01;
    let res = env
        .verifier
        .verify(&env.vk, &env.proof, &pi)
        .expect("wrong public inputs must be a clean reject, not a tool error");
    assert!(!res, "mismatched public inputs must verify to false");
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn rejects_canonical_all_zero_proofs() {
    let verifier = live_env().verifier;
    for kat in HIDING_KERNEL_KATS {
        let proof = vec![0u8; kat.proof.len()];
        let res = verifier
            .verify(kat.vk, &proof, kat.public_inputs)
            .expect("canonical malformed proof must be a clean rejection");
        assert!(!res, "canonical all-zero proof must verify to false");
    }
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn known_invalid_proofs_are_recognized_rejections() {
    let verifier = live_env().verifier;
    for kat in HIDING_KERNEL_KATS {
        let res = verifier
            .verify(kat.vk, kat.rejected_proof, kat.public_inputs)
            .expect("known-invalid proof must be a recognized rejection");
        assert!(!res, "known-invalid proof must verify to false");
    }
}

/// bb's answer to one live verification, with its report.
fn live_answer(env: &LiveEnv, proof: &[u8]) -> Answer {
    let mut slot = lock_unpoisoned(&env.verifier.worker);
    env.verifier.ensure_ready(&mut slot).unwrap();
    env.verifier
        .call_worker(&mut slot, &env.vk, proof, &env.public_inputs)
        .unwrap()
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn rejects_a_proof_that_fails_a_limb_conversion_assertion() {
    let env = live_env();
    let mut proof = env.proof.clone();
    // Byte 40 lies in a hiding-kernel public input that bb converts from
    // limbs; an out-of-range limb fails a `BB_ASSERT`, which `ChonkVerify`
    // catches and reports as malformed input.
    proof[40] ^= 0xff;
    let answer = live_answer(&env, &proof);
    assert!(
        answer
            .report
            .contains("ChonkVerify: malformed input: Assertion failed"),
        "{}",
        answer.report
    );
    assert_eq!(answer.verdict, Some(false));
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn rejects_kernel_public_inputs_that_are_not_curve_points() {
    let env = live_env();
    // The posted proof opens with the hiding kernel's point limbs: words 0..4
    // are the first pairing point's x_lo, x_hi, y_lo, y_hi, big-endian.
    let set_word = |proof: &mut [u8], index: usize, value: [u8; 32]| {
        proof[index * 32..(index + 1) * 32].copy_from_slice(&value);
    };
    let mut two_pow_136 = [0_u8; 32];
    two_pow_136[14] = 1;
    let mut two_pow_136_minus_one = [0_u8; 32];
    two_pow_136_minus_one[15..].fill(0xff);
    let mut two_pow_118_minus_one = [0_u8; 32];
    two_pow_118_minus_one[17] = 0x3f;
    two_pow_118_minus_one[18..].fill(0xff);

    let mut low_limb = env.proof.clone();
    set_word(&mut low_limb, 0, two_pow_136);
    // Both limbs in range, but together 2^254 - 1, which exceeds q.
    let mut coordinate = env.proof.clone();
    set_word(&mut coordinate, 0, two_pow_136_minus_one);
    set_word(&mut coordinate, 1, two_pow_118_minus_one);
    let mut off_curve = env.proof.clone();
    off_curve[3 * 32 - 1] ^= 1;
    for (proof, report) in [
        (low_limb, "Assertion failed: (uint256_t(fr_vec[0])"),
        (coordinate, "Assertion failed: (value < fq::modulus)"),
        (off_curve, "Deserialized point is not on the curve"),
    ] {
        let answer = live_answer(&env, &proof);
        assert!(answer.report.contains(report), "{}", answer.report);
        assert_eq!(answer.verdict, Some(false), "{}", answer.report);
    }
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn rejects_a_proof_whose_final_ipa_relation_fails_without_a_report() {
    let env = live_env();
    let mut proof = env.proof.clone();
    // Word 372 of a posted proof is the IPA's final scalar a_0. Changing it
    // leaves every challenge and G_0 intact, so only the IPA group relation
    // fails, and bb reports nothing for that. Its verbose progress line before
    // the final discharge is the evidence that the refusal is the proof's.
    proof[372 * 32 + 31] ^= 1;
    let answer = live_answer(&env, &proof);
    assert!(
        answer.report.lines().last().is_some_and(|line| {
            line.starts_with("ChonkVerifier: Batched translator+joint reduction: true")
        }),
        "{}",
        answer.report
    );
    assert_eq!(answer.verdict, Some(false));
}

#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn rejects_a_proof_whose_final_ipa_srs_check_fails() {
    let env = live_env();
    let mut proof = env.proof.clone();
    // Word 338 is the first TripleIPA cross sum, a scalar, so the changed
    // proof still decompresses. It changes every IPA challenge, which the
    // prover's G_0 no longer matches.
    proof[338 * 32 + 31] ^= 1;
    let answer = live_answer(&env, &proof);
    assert!(
        answer.report.lines().last().is_some_and(|line| {
            line.starts_with("IPA batch verification failed: combined G_0 mismatch")
        }),
        "{}",
        answer.report
    );
    assert_eq!(answer.verdict, Some(false));
}

/// Verbose logging never reaches the response channel (every response here
/// decodes), and the cross-request diagnostic tail remains bounded.
#[test]
#[ignore = "needs pinned bb + authenticated CRS"]
fn worker_stderr_is_drained_after_every_request() {
    let env = live_env();
    let mut corrupt = env.proof.clone();
    corrupt[372 * 32 + 31] ^= 1;
    for (proof, expected) in [(&env.proof, true), (&corrupt, false), (&env.proof, true)] {
        assert_eq!(
            env.verifier
                .verify(&env.vk, proof, &env.public_inputs)
                .unwrap(),
            expected
        );
        let slot = lock_unpoisoned(&env.verifier.worker);
        let worker = slot.worker.as_ref().unwrap();
        let diagnostics = lock_unpoisoned(&worker.diagnostics);
        assert!(!diagnostics.is_empty());
        assert!(diagnostics.len() <= MAX_DIAGNOSTIC_BYTES as usize);
    }
}
