use barretenberg_rs::generated_types::{ChonkDecompressProof, ChonkVerify};
use barretenberg_rs::{Command as BbCommand, Response as BbResponse};
use std::io::{pipe, PipeReader, PipeWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use rustix::event::{poll, PollFd, PollFlags, Timespec};
use rustix::io::Errno;
use sha2::{Digest, Sha256};
use wait_timeout::ChildExt;

use crate::kat::{KnownAnswer, HIDING_KERNEL_KATS};
use crate::refusal::{proof_caused, Refusal};
use crate::{Verifier, VerifyError, SIGNAL_EXIT};

pub(super) const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const MAX_DIAGNOSTIC_BYTES: u64 = 256 * 1024;
/// Framing bound for one request. A hiding-kernel proof and its public inputs are
/// already capped by the transaction size limit, and the verification key is
/// compiled in, so this leaves an order of magnitude of headroom while keeping
/// the write path from ever being asked to push an unbounded payload.
pub(super) const MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub(super) const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub(super) const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);
pub(super) const BN254_SCALAR_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];
/// The BN254 G1 generator `(1, 2)` as the first point of `bn254_g1.dat`:
/// big-endian `x ‖ y`. It is the only G1 point the verifier reads.
pub(super) const BN254_G1_GENERATOR: [u8; 64] = {
    let mut point = [0_u8; 64];
    point[31] = 1;
    point[63] = 2;
    point
};

pub(super) fn sha256_digest(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().into()
}

/// The first `length` bytes of a CRS file; a shorter file is an error.
pub(super) fn read_prefix(path: &Path, length: usize) -> Result<Vec<u8>, VerifyError> {
    let mut prefix = vec![0_u8; length];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut prefix))
        .map_err(|error| {
            VerifyError::Io(std::io::Error::new(
                error.kind(),
                format!("{}: {error}", path.display()),
            ))
        })?;
    Ok(prefix)
}

pub(super) fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

pub(super) fn canonical_field_elements(bytes: &[u8]) -> bool {
    bytes.len().is_multiple_of(32)
        && bytes
            .chunks_exact(32)
            .all(|word| word < BN254_SCALAR_MODULUS.as_slice())
}

pub(super) fn proof_nonempty_and_inputs_canonical(proof: &[u8], public_inputs: &[u8]) -> bool {
    !proof.is_empty() && canonical_field_elements(public_inputs)
}

#[derive(Debug)]
pub(super) enum FrameReadError {
    Io(String),
    Oversized(u32),
}

#[derive(Debug)]
pub(super) enum WorkerFailure {
    Timeout,
    Transport(String),
    Protocol(String),
}

pub(super) struct StoppedWorker {
    pub(super) status: Option<ExitStatus>,
    pub(super) stderr: String,
}

pub(super) fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub(super) fn read_frames(
    mut stdout: impl Read,
    sender: mpsc::SyncSender<Result<Vec<u8>, FrameReadError>>,
) {
    loop {
        let mut length_bytes = [0_u8; 4];
        if let Err(error) = stdout.read_exact(&mut length_bytes) {
            let _ = sender.send(Err(FrameReadError::Io(error.to_string())));
            return;
        }
        let length = u32::from_le_bytes(length_bytes);
        let Ok(length_usize) = usize::try_from(length) else {
            let _ = sender.send(Err(FrameReadError::Oversized(length)));
            return;
        };
        if length_usize > MAX_RESPONSE_BYTES {
            let _ = sender.send(Err(FrameReadError::Oversized(length)));
            return;
        }
        let mut frame = vec![0_u8; length_usize];
        if let Err(error) = stdout.read_exact(&mut frame) {
            let _ = sender.send(Err(FrameReadError::Io(error.to_string())));
            return;
        }
        if sender.send(Ok(frame)).is_err() {
            return;
        }
    }
}

/// Append to a tail that keeps only the most recent [`MAX_DIAGNOSTIC_BYTES`]:
/// `bb` logs throughout a long-lived worker's life, so the output adjacent to
/// a failure is what diagnoses it.
pub(super) fn retain_tail(tail: &mut Vec<u8>, bytes: &[u8]) {
    tail.extend_from_slice(bytes);
    let excess = tail.len().saturating_sub(MAX_DIAGNOSTIC_BYTES as usize);
    tail.drain(..excess);
}

enum StderrCommand {
    TakeRequest(mpsc::SyncSender<Vec<u8>>),
}

fn poll_stderr(fds: &mut [PollFd<'_>], timeout: Option<&Timespec>) -> std::io::Result<usize> {
    loop {
        match poll(fds, timeout) {
            Ok(ready) => return Ok(ready),
            Err(Errno::INTR) => {}
            Err(error) => return Err(error.into()),
        }
    }
}

/// Drain stderr while the worker runs. A separate control pipe provides a
/// request boundary: the caller writes to it only after receiving bb's
/// response frame, and bb writes a request's diagnostics before that frame.
/// The reader drains stderr to an empty poll before returning and resetting
/// the request tail, so scheduler order cannot move bytes between requests.
fn read_stderr(
    mut stderr: PipeReader,
    mut control: PipeReader,
    commands: mpsc::Receiver<StderrCommand>,
    diagnostics: &Mutex<Vec<u8>>,
) -> std::io::Result<()> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let (stderr_events, control_events) = {
            let mut fds = [
                PollFd::new(&stderr, PollFlags::IN),
                PollFd::new(&control, PollFlags::IN),
            ];
            poll_stderr(&mut fds, None)?;
            (fds[0].revents(), fds[1].revents())
        };

        let stderr_closed =
            if stderr_events.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
                read_stderr_once(&mut stderr, &mut buffer, &mut request, diagnostics)?
            } else {
                false
            };

        if control_events.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
            let mut wake = [0_u8; 1];
            if control.read(&mut wake)? == 0 {
                drain_ready_stderr(&mut stderr, &mut buffer, &mut request, diagnostics)?;
                return Ok(());
            }
            drain_ready_stderr(&mut stderr, &mut buffer, &mut request, diagnostics)?;
            let Ok(StderrCommand::TakeRequest(sender)) = commands.recv() else {
                return Ok(());
            };
            if sender.send(std::mem::take(&mut request)).is_err() {
                return Ok(());
            }
        }

        if stderr_closed {
            return Ok(());
        }
    }
}

fn read_stderr_once(
    stderr: &mut PipeReader,
    buffer: &mut [u8],
    request: &mut Vec<u8>,
    diagnostics: &Mutex<Vec<u8>>,
) -> std::io::Result<bool> {
    let read = stderr.read(buffer)?;
    if read == 0 {
        return Ok(true);
    }
    retain_tail(request, &buffer[..read]);
    retain_tail(&mut lock_unpoisoned(diagnostics), &buffer[..read]);
    Ok(false)
}

/// Drain bytes that were already writable before a response boundary. The
/// zero-timeout poll is the synchronization point; no next request is sent
/// until this function has returned its predecessor's tail.
fn drain_ready_stderr(
    stderr: &mut PipeReader,
    buffer: &mut [u8],
    request: &mut Vec<u8>,
    diagnostics: &Mutex<Vec<u8>>,
) -> std::io::Result<()> {
    const ZERO: Timespec = Timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    loop {
        let events = {
            let mut fds = [PollFd::new(&*stderr, PollFlags::IN)];
            if poll_stderr(&mut fds, Some(&ZERO))? == 0 {
                return Ok(());
            }
            fds[0].revents()
        };
        if !events.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
            return Ok(());
        }
        if read_stderr_once(stderr, buffer, request, diagnostics)? {
            return Ok(());
        }
    }
}

/// Serialize framed requests onto the child's stdin from a dedicated thread, so
/// a child that stops reading wedges this thread instead of the caller and
/// [`Worker::call`] keeps its deadline. Killing the child fails the blocked
/// write, which is how this thread is unblocked during teardown.
pub(super) fn write_frames(
    mut stdin: ChildStdin,
    requests: mpsc::Receiver<Vec<u8>>,
    acknowledgements: mpsc::SyncSender<Result<(), String>>,
) {
    for payload in requests {
        let Ok(length) = u32::try_from(payload.len()) else {
            let _ =
                acknowledgements.send(Err("verifier request exceeds u32 framing limit".to_owned()));
            return;
        };
        let result = stdin
            .write_all(&length.to_le_bytes())
            .and_then(|()| stdin.write_all(&payload))
            .and_then(|()| stdin.flush())
            .map_err(|error| error.to_string());
        let failed = result.is_err();
        if acknowledgements.send(result).is_err() || failed {
            return;
        }
    }
}

/// Time left before `deadline`, saturating at zero.
pub(super) fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

pub(super) struct Worker {
    pub(super) child: Child,
    pub(super) requests: Option<mpsc::SyncSender<Vec<u8>>>,
    pub(super) acknowledgements: Option<mpsc::Receiver<Result<(), String>>>,
    pub(super) responses: Option<mpsc::Receiver<Result<Vec<u8>, FrameReadError>>>,
    pub(super) stdin_writer: Option<thread::JoinHandle<()>>,
    pub(super) stdout_reader: Option<thread::JoinHandle<()>>,
    stderr_commands: Option<mpsc::SyncSender<StderrCommand>>,
    stderr_control: Option<PipeWriter>,
    stderr_reader: Option<thread::JoinHandle<std::io::Result<()>>>,
    /// The most recent stderr across this worker's requests.
    pub(super) diagnostics: Arc<Mutex<Vec<u8>>>,
}

impl Worker {
    /// Exchange one framed request for its response and the stderr bb wrote
    /// while answering it, under a single wall-clock deadline that spans both
    /// the write and the read. The child never blocks this thread directly, so
    /// an unresponsive worker always surfaces as [`WorkerFailure::Timeout`] and
    /// reaches the kill/reap path.
    pub(super) fn call(
        &mut self,
        payload: Vec<u8>,
        timeout: Duration,
    ) -> Result<(BbResponse, String), WorkerFailure> {
        let deadline = Instant::now() + timeout;
        let requests = self.requests.as_ref().ok_or_else(|| {
            WorkerFailure::Transport("verifier worker stdin is closed".to_owned())
        })?;
        requests
            .send(payload)
            .map_err(|_| WorkerFailure::Transport("verifier request writer stopped".to_owned()))?;
        let acknowledgements = self.acknowledgements.as_ref().ok_or_else(|| {
            WorkerFailure::Transport("verifier request writer stopped".to_owned())
        })?;
        match acknowledgements.recv_timeout(remaining(deadline)) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(WorkerFailure::Transport(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => return Err(WorkerFailure::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(WorkerFailure::Transport(
                    "verifier request writer stopped".to_owned(),
                ))
            }
        }

        let responses = self.responses.as_ref().ok_or_else(|| {
            WorkerFailure::Transport("verifier response channel is closed".to_owned())
        })?;
        let frame = match responses.recv_timeout(remaining(deadline)) {
            Ok(Ok(frame)) => frame,
            Ok(Err(FrameReadError::Io(error))) => return Err(WorkerFailure::Transport(error)),
            Ok(Err(FrameReadError::Oversized(length))) => {
                return Err(WorkerFailure::Protocol(format!(
                    "response frame is {length} bytes; maximum is {MAX_RESPONSE_BYTES}"
                )))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => return Err(WorkerFailure::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(WorkerFailure::Transport(
                    "verifier response reader stopped".to_owned(),
                ))
            }
        };
        let stderr = self.take_stderr(deadline)?;
        let response = rmp_serde::from_slice(&frame)
            .map_err(|error| WorkerFailure::Protocol(format!("invalid response: {error}")))?;
        // Unaltered: whether a refusal is a rejection depends on exactly how
        // the request's stderr ends.
        Ok((response, String::from_utf8_lossy(&stderr).into_owned()))
    }

    /// Return the bounded stderr tail for exactly the request whose response
    /// was just received. A refusal is judged by how this tail ends and by
    /// every `malformed input` report in it, so a cut, which drops the oldest
    /// bytes, could also drop a report that vetoes a rejection. With the pinned
    /// bb a request logs about 1 KiB, far below the cap.
    fn take_stderr(&mut self, deadline: Instant) -> Result<Vec<u8>, WorkerFailure> {
        let commands = self
            .stderr_commands
            .as_ref()
            .ok_or_else(|| WorkerFailure::Transport("verifier stderr reader stopped".to_owned()))?;
        let (sender, receiver) = mpsc::sync_channel(0);
        commands
            .send(StderrCommand::TakeRequest(sender))
            .map_err(|_| WorkerFailure::Transport("verifier stderr reader stopped".to_owned()))?;
        self.stderr_control
            .as_mut()
            .ok_or_else(|| WorkerFailure::Transport("verifier stderr reader stopped".to_owned()))?
            .write_all(&[0])
            .map_err(|error| {
                WorkerFailure::Transport(format!("verifier stderr unreadable: {error}"))
            })?;
        match receiver.recv_timeout(remaining(deadline)) {
            Ok(stderr) => Ok(stderr),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(WorkerFailure::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(WorkerFailure::Transport(
                "verifier stderr reader stopped".to_owned(),
            )),
        }
    }

    /// Close the child out within `grace` and report how it ended. Idempotent:
    /// [`Drop`] calls it again for a worker released without an explicit stop,
    /// and a reaped child's status is already cached.
    pub(super) fn stop(&mut self, grace: Duration) -> StoppedWorker {
        // Dropping the request sender ends the writer thread, which closes
        // stdin and lets a healthy child exit on its own. A writer wedged
        // inside a blocking write is freed instead by the kill below.
        self.requests.take();
        let status = if let Ok(Some(status)) = self.child.wait_timeout(grace) {
            Some(status)
        } else {
            let _ = self.child.kill();
            self.child.wait().ok()
        };
        // Unblock a reader that encountered unsolicited frames and filled the
        // one-response channel before joining its thread.
        self.responses.take();
        self.acknowledgements.take();
        if let Some(writer) = self.stdin_writer.take() {
            let _ = writer.join();
        }
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
        self.stderr_commands.take();
        self.stderr_control.take();
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
        StoppedWorker {
            status,
            stderr: text(&lock_unpoisoned(&self.diagnostics)),
        }
    }
}

impl Drop for Worker {
    /// `Child` neither closes stdin nor reaps on its own, so a worker released
    /// without [`Worker::stop`] would leave `bb` running against a pipe nobody
    /// reads. Teardown belongs to the type, not to each call site.
    fn drop(&mut self) {
        drop(self.stop(SHUTDOWN_GRACE));
    }
}

/// [`Answer::request`] for a proof the node rejects before bb sees it.
pub(super) const PRE_CHECK: &str = "pre-check";

/// bb's answer to one proof.
pub(super) struct Answer {
    /// `Some` when bb accepted the proof or attributed its refusal to the
    /// proof; `None` when it refused without a proof-caused report.
    pub(super) verdict: Option<bool>,
    /// The request that settled the answer, or [`PRE_CHECK`].
    pub(super) request: &'static str,
    /// What bb said: a decompression error frame's message, or the stderr
    /// `ChonkVerify` wrote.
    pub(super) report: String,
}

#[derive(Default)]
pub(super) struct WorkerSlot {
    pub(super) worker: Option<Worker>,
    pub(super) ready: bool,
}

/// Verifier backend backed by one supervised, persistent `bb msgpack run`
/// process. Each instance owns one worker and permits one in-flight request;
/// separate node verifier instances retain derivation/mempool concurrency.
pub struct BbProcessVerifier {
    pub(super) bb_path: PathBuf,
    pub(super) crs_path: Option<PathBuf>,
    pub(super) command_timeout: Duration,
    pub(super) worker: Mutex<WorkerSlot>,
}

impl BbProcessVerifier {
    /// Construct against an explicit pinned `bb` binary path.
    pub fn new(bb_path: impl Into<PathBuf>) -> Self {
        Self {
            bb_path: bb_path.into(),
            crs_path: None,
            command_timeout: DEFAULT_COMMAND_TIMEOUT,
            worker: Mutex::new(WorkerSlot::default()),
        }
    }

    /// Construct from the pinned tool root `PCASH_TOOL_ROOT`.
    pub fn from_env() -> Result<Self, VerifyError> {
        Self::from_tool_root(std::env::var_os("PCASH_TOOL_ROOT").ok_or(VerifyError::ToolRootUnset)?)
    }

    /// Construct from `root/bb/bb` and `root/crs`. There is no other
    /// location: the node never asks an unpinned binary for a verdict.
    pub(super) fn from_tool_root(root: impl Into<PathBuf>) -> Result<Self, VerifyError> {
        let root = root.into();
        let path = root.join("bb").join("bb");
        if !path.is_file() {
            return Err(VerifyError::MissingBinary { path });
        }
        Ok(Self::new(path).with_crs_path(root.join("crs")))
    }

    /// Force verifier CRS reads through one authenticated directory.
    pub fn with_crs_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.crs_path = Some(path.into());
        self
    }

    /// Bound every framed verification request.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.command_timeout = timeout;
        self
    }

    pub fn bb_path(&self) -> &Path {
        &self.bb_path
    }

    pub fn crs_path(&self) -> Option<&Path> {
        self.crs_path.as_deref()
    }

    pub fn command_timeout(&self) -> Duration {
        self.command_timeout
    }

    /// Refuse startup unless `bb` and the CRS bytes the verifier reads match
    /// this binary's compiled requirements: `bb` is byte for byte the pinned
    /// release's binary, `bn254_g1.dat` starts with the BN254 generator, and a
    /// pinned prefix of `grumpkin_g1_v2.flat.dat` covers the points the CHONK
    /// verifier reads. The BN254 G2 element is compiled into bb.
    ///
    /// bb is identified by its bytes, not by the version it reports: the tool
    /// root reaches a release image through build caches, and a different
    /// build that reports the pinned version would decide consensus.
    pub fn assert_release(
        &self,
        expected_bb_sha256: [u8; 32],
        grumpkin_g1_prefix_bytes: usize,
        expected_grumpkin_g1_prefix_sha256: [u8; 32],
    ) -> Result<(), VerifyError> {
        let bb = std::fs::read(&self.bb_path).map_err(|error| {
            VerifyError::Io(std::io::Error::new(
                error.kind(),
                format!("{}: {error}", self.bb_path.display()),
            ))
        })?;
        let actual = sha256_digest(&bb);
        if actual != expected_bb_sha256 {
            return Err(VerifyError::BinaryMismatch {
                path: self.bb_path.clone(),
                expected: hex::encode(expected_bb_sha256),
                actual: hex::encode(actual),
            });
        }

        let crs_dir = self.crs_path.as_ref().ok_or_else(|| {
            VerifyError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no CRS path configured",
            ))
        })?;
        let g1_path = crs_dir.join("bn254_g1.dat");
        let g1 = read_prefix(&g1_path, BN254_G1_GENERATOR.len())?;
        if g1 != BN254_G1_GENERATOR {
            return Err(VerifyError::CrsMismatch {
                path: g1_path,
                expected: hex::encode(BN254_G1_GENERATOR),
                actual: hex::encode(g1),
            });
        }
        let grumpkin_path = crs_dir.join("grumpkin_g1_v2.flat.dat");
        let actual = sha256_digest(&read_prefix(&grumpkin_path, grumpkin_g1_prefix_bytes)?);
        if actual != expected_grumpkin_g1_prefix_sha256 {
            return Err(VerifyError::CrsMismatch {
                path: grumpkin_path,
                expected: hex::encode(expected_grumpkin_g1_prefix_sha256),
                actual: hex::encode(actual),
            });
        }
        Ok(())
    }

    pub(super) fn spawn_worker(&self) -> Result<Worker, VerifyError> {
        let (stderr, child_stderr) = pipe()?;
        let (stderr_control_reader, stderr_control) = pipe()?;
        let mut command = Command::new(&self.bb_path);
        if let Some(path) = &self.crs_path {
            command.arg("--crs_path").arg(path);
        }
        command
            .arg("msgpack")
            .arg("run")
            // Verbose logging makes bb report reaching its final check, which
            // is the only evidence for a refusal it otherwise leaves silent
            // (see `refusal`). `msgpack run` sends all logging to stderr.
            .env("BB_VERBOSE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(child_stderr);
        let mut child = command.spawn().map_err(|source| VerifyError::Spawn {
            path: self.bb_path.clone(),
            source,
        })?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(VerifyError::Io(std::io::Error::other(
                "piped verifier stdin unavailable",
            )));
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(VerifyError::Io(std::io::Error::other(
                "piped verifier stdout unavailable",
            )));
        };
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let stderr_diagnostics = Arc::clone(&diagnostics);
        let (stderr_commands, stderr_command_receiver) = mpsc::sync_channel(1);
        let stderr_reader = match thread::Builder::new()
            .name("pcash-bb-stderr".to_owned())
            .spawn(move || {
                read_stderr(
                    stderr,
                    stderr_control_reader,
                    stderr_command_receiver,
                    &stderr_diagnostics,
                )
            }) {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(VerifyError::Io(error));
            }
        };
        let (sender, responses) = mpsc::sync_channel(1);
        let stdout_reader = match thread::Builder::new()
            .name("pcash-bb-stdout".to_owned())
            .spawn(move || read_frames(stdout, sender))
        {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                drop(stderr_control);
                drop(stderr_commands);
                let _ = stderr_reader.join();
                return Err(VerifyError::Io(error));
            }
        };
        let (requests, request_receiver) = mpsc::sync_channel(1);
        let (acknowledgement_sender, acknowledgements) = mpsc::sync_channel(1);
        let stdin_writer = match thread::Builder::new()
            .name("pcash-bb-stdin".to_owned())
            .spawn(move || write_frames(stdin, request_receiver, acknowledgement_sender))
        {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                drop(responses);
                let _ = stdout_reader.join();
                drop(stderr_control);
                drop(stderr_commands);
                let _ = stderr_reader.join();
                return Err(VerifyError::Io(error));
            }
        };
        Ok(Worker {
            child,
            requests: Some(requests),
            acknowledgements: Some(acknowledgements),
            responses: Some(responses),
            stdin_writer: Some(stdin_writer),
            stdout_reader: Some(stdout_reader),
            stderr_commands: Some(stderr_commands),
            stderr_control: Some(stderr_control),
            stderr_reader: Some(stderr_reader),
            diagnostics,
        })
    }

    /// Drop a worker we no longer trust and force the next call to respawn and
    /// re-establish every startup known answer.
    pub(super) fn quarantine_worker(&self, slot: &mut WorkerSlot) {
        slot.ready = false;
        if let Some(mut worker) = slot.worker.take() {
            worker.stop(Duration::ZERO);
        }
    }

    pub(super) fn stop_failed_worker(
        &self,
        slot: &mut WorkerSlot,
        failure: WorkerFailure,
    ) -> VerifyError {
        slot.ready = false;
        let stopped = slot
            .worker
            .take()
            .map(|mut worker| worker.stop(Duration::ZERO));
        let stderr = stopped
            .as_ref()
            .map_or_else(String::new, |worker| worker.stderr.clone());
        match failure {
            WorkerFailure::Timeout => VerifyError::Timeout {
                timeout_ms: self.command_timeout.as_millis(),
                stdout: String::new(),
                stderr,
            },
            WorkerFailure::Protocol(detail) => VerifyError::Protocol { detail, stderr },
            WorkerFailure::Transport(detail) => {
                if let Some(status) = stopped.and_then(|worker| worker.status) {
                    VerifyError::Abnormal {
                        exit: status
                            .code()
                            .map_or_else(|| SIGNAL_EXIT.to_owned(), |code| code.to_string()),
                        stdout: String::new(),
                        stderr,
                    }
                } else {
                    VerifyError::Transport { detail, stderr }
                }
            }
        }
    }

    /// Decompress and verify one proof. Decompression reads only the proof
    /// bytes. A refusal from either request is a verdict only when bb
    /// attributes it to the proof (see `refusal`).
    pub(super) fn call_worker(
        &self,
        slot: &mut WorkerSlot,
        vk: &[u8],
        proof: &[u8],
        public_inputs: &[u8],
    ) -> Result<Answer, VerifyError> {
        let decompression = BbCommand::ChonkDecompressProof(ChonkDecompressProof::new(
            [public_inputs, proof].concat(),
        ));
        let (decompressed, stderr) = self.exchange_worker(slot, decompression)?;
        let proof = match decompressed {
            BbResponse::ChonkDecompressProofResponse(response) => response.proof,
            BbResponse::ErrorResponse(error) => {
                let caused = proof_caused(Refusal::Decompression {
                    message: &error.message,
                });
                return Ok(Answer {
                    verdict: caused.then_some(false),
                    request: "ChonkDecompressProof",
                    report: format!("{}\n{stderr}", error.message).trim().to_owned(),
                });
            }
            response => {
                return Err(self.stop_failed_worker(
                    slot,
                    WorkerFailure::Protocol(format!("unexpected response: {response:?}")),
                ))
            }
        };
        let (response, stderr) = self.exchange_worker(
            slot,
            BbCommand::ChonkVerify(ChonkVerify::new(proof, vk.to_vec())),
        )?;
        // `ChonkVerify` answers every failure inside verification with
        // `valid: false`, so an error frame means bb could not handle a request
        // built from its own decompressed proof and a compiled key.
        let valid = match response {
            BbResponse::ChonkVerifyResponse(response) => response.valid,
            response => {
                return Err(self.stop_failed_worker(
                    slot,
                    WorkerFailure::Protocol(format!("unexpected response: {response:?}")),
                ))
            }
        };
        let verdict = if valid {
            Some(true)
        } else {
            proof_caused(Refusal::Verification { stderr: &stderr }).then_some(false)
        };
        Ok(Answer {
            verdict,
            request: "ChonkVerify",
            report: stderr.trim().to_owned(),
        })
    }

    pub(super) fn exchange_worker(
        &self,
        slot: &mut WorkerSlot,
        request: BbCommand,
    ) -> Result<(BbResponse, String), VerifyError> {
        // Encoding and the size bound are decided before anything reaches the
        // child, so failing either leaves the running worker untouched.
        let payload =
            rmp_serde::to_vec_named(&vec![request]).map_err(|error| VerifyError::Protocol {
                detail: error.to_string(),
                stderr: String::new(),
            })?;
        if payload.len() > MAX_REQUEST_BYTES {
            return Err(VerifyError::Protocol {
                detail: format!(
                    "request frame is {} bytes; maximum is {MAX_REQUEST_BYTES}",
                    payload.len()
                ),
                stderr: String::new(),
            });
        }
        let result = match slot.worker.as_mut() {
            Some(worker) => worker.call(payload, self.command_timeout),
            None => {
                return Err(VerifyError::Transport {
                    detail: "verifier worker is not running".to_owned(),
                    stderr: String::new(),
                })
            }
        };
        result.map_err(|failure| self.stop_failed_worker(slot, failure))
    }

    /// A worker that fails a known answer is unhealthy whether it failed by
    /// dropping the connection or by returning the wrong verdict, so every
    /// failure quarantines it rather than only the transport ones.
    pub(super) fn assert_known_answer_locked(
        &self,
        slot: &mut WorkerSlot,
        kat: KnownAnswer,
    ) -> Result<(), VerifyError> {
        let result = self.check_known_answer_locked(slot, kat);
        if result.is_err() {
            self.quarantine_worker(slot);
        }
        result
    }

    /// The negative answer must be a recognized rejection, not merely a
    /// refusal, so a worker whose failure reports cannot be read never starts.
    pub(super) fn check_known_answer_locked(
        &self,
        slot: &mut WorkerSlot,
        kat: KnownAnswer,
    ) -> Result<(), VerifyError> {
        let valid = self.call_worker(slot, kat.vk, kat.proof, kat.public_inputs)?;
        if valid.verdict != Some(true) {
            return Err(VerifyError::KnownAnswer {
                case: kat.valid_not_accepted,
                report: valid.report,
            });
        }
        let invalid = self.call_worker(slot, kat.vk, kat.rejected_proof, kat.public_inputs)?;
        if invalid.verdict != Some(false) {
            return Err(VerifyError::KnownAnswer {
                case: kat.invalid_not_rejected,
                report: invalid.report,
            });
        }
        Ok(())
    }

    pub(super) fn assert_all_known_answers_locked(
        &self,
        slot: &mut WorkerSlot,
    ) -> Result<(), VerifyError> {
        for kat in HIDING_KERNEL_KATS {
            self.assert_known_answer_locked(slot, kat)?;
        }
        Ok(())
    }

    /// Spawn a worker if none is running, and have a new one pass every known
    /// answer before it answers anything else. Each kernel's valid proof runs
    /// first, so bb has loaded the Grumpkin CRS before any other request: a
    /// fresh worker logs that load after the progress line `refusal` reads as
    /// the last report before the silent final IPA check.
    pub(super) fn ensure_ready(&self, slot: &mut WorkerSlot) -> Result<(), VerifyError> {
        if slot.worker.is_none() {
            slot.worker = Some(self.spawn_worker()?);
            slot.ready = false;
        }
        if !slot.ready {
            self.assert_all_known_answers_locked(slot)?;
            slot.ready = true;
        }
        Ok(())
    }

    /// Start the worker if necessary and establish both positive and negative
    /// known answers for every hiding-kernel verification key.
    pub fn assert_known_answers(&self) -> Result<(), VerifyError> {
        let mut slot = lock_unpoisoned(&self.worker);
        self.ensure_ready(&mut slot)
    }

    /// [`Verifier::verify`], keeping what bb said.
    pub(super) fn answer(
        &self,
        vk: &[u8],
        proof: &[u8],
        public_inputs: &[u8],
    ) -> Result<Answer, VerifyError> {
        // An empty proof, or public inputs that are not canonical field
        // elements, have a deterministic consensus verdict and are rejected
        // before starting a worker. Honk structure and curve-point validity
        // remain bb's responsibility.
        if !proof_nonempty_and_inputs_canonical(proof, public_inputs) {
            return Ok(Answer {
                verdict: Some(false),
                request: PRE_CHECK,
                report: String::new(),
            });
        }

        let mut slot = lock_unpoisoned(&self.worker);
        self.ensure_ready(&mut slot)?;
        let answer = self.call_worker(&mut slot, vk, proof, public_inputs)?;
        if answer.verdict.is_none() {
            // bb may have failed in a way that outlives the request, such as
            // its stderr no longer being writable; a fresh worker re-proves
            // its known answers before answering again.
            self.quarantine_worker(&mut slot);
        }
        Ok(answer)
    }
}

impl Verifier for BbProcessVerifier {
    fn verify(&self, vk: &[u8], proof: &[u8], public_inputs: &[u8]) -> Result<bool, VerifyError> {
        let answer = self.answer(vk, proof, public_inputs)?;
        answer.verdict.ok_or(VerifyError::VerifierFault {
            request: answer.request,
            report: answer.report,
        })
    }
}

impl Drop for BbProcessVerifier {
    fn drop(&mut self) {
        let slot = match self.worker.get_mut() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        // Dropping the worker closes its stdin, waits out the shutdown grace,
        // and reaps the child.
        slot.worker.take();
        slot.ready = false;
    }
}
