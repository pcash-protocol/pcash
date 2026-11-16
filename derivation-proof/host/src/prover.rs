//! Advances the contract's anchor. The full state at the anchor is held in
//! memory and in a file per anchor block. Once the next interval's last
//! Ethereum block is finalized, the interval is derived from that state as
//! range proofs, aggregated, and submitted with `proveBlock`.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use alloy_primitives::{Address, Bytes, B256, U256};
use derivation_proof_core::{checkpoint_root, config_hash, Source};
use eyre::{bail, ensure, eyre, Result};
use tokio::runtime::Runtime;

use crate::blocks;
use crate::node;
use crate::prove::{prove_ranges, Halt, Native, Programs};
use crate::contract::Ethereum;

/// Where Ethereum blocks and their blobs come from, and an optional node to
/// compare derived block hashes with.
pub struct Endpoints {
    pub l1_rpc: String,
    pub beacon_api: String,
    pub node_rpc: Option<String>,
}

/// The programs and how ranges are split.
pub struct Prover {
    pub programs: Programs,
    pub range_blocks: usize,
}

/// A disagreement between this derivation and the contract or the node, which
/// retrying cannot resolve.
#[derive(Debug)]
pub struct Disagreement(pub String);

impl fmt::Display for Disagreement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Disagreement {}

/// The encoded full state after a PCASH block, and its checkpoint root.
pub struct AnchorState {
    pub number: u64,
    pub root: B256,
    snapshot: Vec<u8>,
}

impl AnchorState {
    fn of(native: &Native) -> Result<Self> {
        let checkpoint = native.checkpoint();
        Ok(Self {
            number: native.number().ok_or_else(|| eyre!("no block derived"))?,
            root: checkpoint_root(checkpoint.block_hash, checkpoint.aux),
            snapshot: native.snapshot()?,
        })
    }

    fn native(&self, source: &Source) -> Result<Native> {
        Native::from_snapshot(source, &self.snapshot)
    }
}

/// One network's saved states, one file per PCASH block, and a directory per
/// interval after one, with the interval's Ethereum blocks, its proofs and the
/// Ethereum head its aggregation proof links to. It is named by the network's
/// configuration hash, so another network's states are never read.
pub struct StateDir(PathBuf);

impl StateDir {
    pub fn new(root: &Path, source: &Source) -> Self {
        Self(root.join(config_hash(source).to_string()))
    }

    fn path(&self, number: u64) -> PathBuf {
        self.0.join(format!("{number}.state"))
    }

    fn numbers(&self) -> Result<Vec<u64>> {
        let mut numbers = Vec::new();
        if self.0.exists() {
            for entry in std::fs::read_dir(&self.0)? {
                let name = entry?.file_name();
                if let Some(number) = name.to_str().and_then(|name| name.strip_suffix(".state")) {
                    numbers.push(number.parse()?);
                }
            }
        }
        numbers.sort_unstable();
        Ok(numbers)
    }

    /// The directory of the interval from `anchor` to `target`.
    fn interval(&self, anchor: u64, target: u64) -> PathBuf {
        self.0.join(format!("{anchor}-{target}"))
    }

    fn save(&self, state: &AnchorState) -> Result<()> {
        std::fs::create_dir_all(&self.0)?;
        let partial = self.0.join(format!("{}.partial", state.number));
        std::fs::write(&partial, &state.snapshot)?;
        std::fs::rename(&partial, self.path(state.number))?;
        Ok(())
    }

    /// Delete the states and intervals before the latest state at or below
    /// `floor`.
    fn prune(&self, floor: u64) -> Result<()> {
        let Some(keep) = self.numbers()?.into_iter().rfind(|&number| number <= floor) else {
            return Ok(());
        };
        for entry in std::fs::read_dir(&self.0)? {
            let entry = entry?;
            let name = entry.file_name();
            let start = name
                .to_str()
                .and_then(|name| name.strip_suffix(".state").or_else(|| name.split_once('-').map(|(anchor, _)| anchor)))
                .and_then(|start| start.parse::<u64>().ok());
            if start.is_some_and(|start| start < keep) {
                if entry.file_type()?.is_dir() {
                    std::fs::remove_dir_all(entry.path())?;
                } else {
                    std::fs::remove_file(entry.path())?;
                }
            }
        }
        Ok(())
    }

    /// The saved state at `number`.
    pub fn load(&self, source: &Source, number: u64) -> Result<AnchorState> {
        let snapshot = std::fs::read(self.path(number))
            .map_err(|error| eyre!("no saved state at PCASH block {number} in {}: {error}", self.0.display()))?;
        AnchorState::of(&Native::from_snapshot(source, &snapshot)?)
    }

    /// The latest saved state at or below `number`.
    fn latest_at_or_below(&self, source: &Source, number: u64) -> Result<Option<AnchorState>> {
        let Some(saved) = self.numbers()?.into_iter().rfind(|&saved| saved <= number) else {
            return Ok(None);
        };
        let snapshot = std::fs::read(self.path(saved))?;
        let native = Native::from_snapshot(source, &snapshot)?;
        Ok(Some(AnchorState::of(&native)?))
    }
}

/// Derive PCASH blocks `from..=to` onto `native`, fetching in chunks.
fn derive(runtime: &Runtime, endpoints: &Endpoints, source: &Source, native: &mut Native, from: u64, to: u64) -> Result<()> {
    let genesis = source.genesis_l1_block;
    let started = Instant::now();
    let mut next = from;
    while next <= to {
        let end = to.min(next + 255);
        let raw = runtime.block_on(blocks::load(
            &endpoints.l1_rpc,
            &endpoints.beacon_api,
            source.inbox_address,
            genesis + next,
            genesis + end,
            None,
        ))?;
        native.derive(&raw)?;
        if to > from + 255 {
            println!("derived PCASH block {end} of {to} ({:?})", started.elapsed());
        }
        next = end + 1;
    }
    Ok(())
}

/// Require the node, when there is one, to hold the same block.
fn check_node(runtime: &Runtime, endpoints: &Endpoints, native: &Native, number: u64) -> Result<()> {
    let Some(node_rpc) = &endpoints.node_rpc else { return Ok(()) };
    let hash = native.checkpoint().block_hash;
    let node_hash = runtime.block_on(node::block_hash(node_rpc, number))?;
    if node_hash != hash {
        bail!(Disagreement(format!("PCASH block {number}: derived {hash}, node {node_hash}")));
    }
    Ok(())
}

/// Derive the network through PCASH block `number` and save that state: where
/// a contract deployed at `number` starts. Derivation resumes from the latest
/// saved state below `number`, or starts at the network's anchor, and saves
/// as it goes.
pub fn bootstrap(runtime: &Runtime, endpoints: &Endpoints, source: &Source, dir: &StateDir, number: u64) -> Result<AnchorState> {
    let (mut native, mut next) = match dir.latest_at_or_below(source, number)? {
        Some(state) => (state.native(source)?, state.number + 1),
        None => (Native::new(source)?, 0),
    };
    while next <= number {
        let end = number.min(next + 2_559);
        derive(runtime, endpoints, source, &mut native, next, end)?;
        dir.save(&AnchorState::of(&native)?)?;
        dir.prune(end)?;
        next = end + 1;
    }
    check_node(runtime, endpoints, &native, number)?;
    AnchorState::of(&native)
}

/// What one step did.
enum Progress {
    /// The contract's anchor reached the run's last checkpoint.
    Done,
    /// The next interval's blocks are not final yet.
    Waiting,
    /// The next interval was proven, or quoted.
    Proved,
}

/// Advance the contract's anchor until it is `intervals` intervals past where
/// it was when the run started, or indefinitely. The limit is on the
/// contract's anchor, however it got there, so a `proveBlock` whose receipt went
/// unread is never followed by proofs past the limit. With `quote`, run the
/// next interval's programs, price its proofs on the prover network, and stop
/// without requesting proofs or sending transactions.
#[allow(clippy::too_many_arguments, reason = "the prover's whole configuration")]
pub fn run(
    runtime: &Runtime,
    endpoints: &Endpoints,
    source: &Source,
    prover: &Prover,
    ethereum: &Ethereum,
    contract: Address,
    dir: &StateDir,
    poll: Duration,
    intervals: Option<u64>,
    quote: bool,
) -> Result<()> {
    let interval = runtime.block_on(ethereum.interval(contract))?;
    let (_, start) = runtime.block_on(ethereum.anchor(contract))?;
    let last = intervals.map(|intervals| start + intervals * interval);
    let mut held: Option<AnchorState> = None;
    loop {
        match step(runtime, endpoints, source, prover, ethereum, contract, dir, interval, last, quote, &mut held) {
            Ok(Progress::Done) => return Ok(()),
            Ok(Progress::Proved) if quote => return Ok(()),
            Ok(Progress::Proved) => {}
            Ok(Progress::Waiting) => std::thread::sleep(poll),
            Err(error) if error.downcast_ref::<Disagreement>().is_some() || error.downcast_ref::<Halt>().is_some() => {
                return Err(error)
            }
            Err(error) => {
                println!("retrying in {poll:?}: {error:#}");
                std::thread::sleep(poll);
            }
        }
    }
}

/// Bring the held state to the contract's anchor, then prove the next interval
/// if its blocks are final and the anchor is short of `last`.
#[allow(clippy::too_many_arguments, reason = "the prover's whole configuration")]
fn step(
    runtime: &Runtime,
    endpoints: &Endpoints,
    source: &Source,
    prover: &Prover,
    ethereum: &Ethereum,
    contract: Address,
    dir: &StateDir,
    interval: u64,
    last: Option<u64>,
    quote: bool,
    held: &mut Option<AnchorState>,
) -> Result<Progress> {
    let (anchor_root, anchor) = runtime.block_on(ethereum.anchor(contract))?;
    // A reorganization can remove proofs submitted after the anchor as of
    // Ethereum's finalized block, at or above which states are kept.
    let state = match held.take() {
        Some(state) if state.number <= anchor => state,
        _ => dir.latest_at_or_below(source, anchor)?.ok_or_else(|| {
            eyre!("no saved state at or below PCASH block {anchor} in {}", dir.0.display())
        })?,
    };
    // Another prover may have advanced the anchor: follow it without proofs.
    let state = if state.number < anchor {
        let mut native = state.native(source)?;
        derive(runtime, endpoints, source, &mut native, state.number + 1, anchor)?;
        let state = AnchorState::of(&native)?;
        save(runtime, ethereum, contract, dir, &state)?;
        state
    } else {
        state
    };
    if state.root != anchor_root {
        bail!(Disagreement(format!(
            "the contract's root at PCASH block {anchor} is {anchor_root}, derived {}",
            state.root
        )));
    }

    if last.is_some_and(|last| anchor >= last) {
        *held = Some(state);
        return Ok(Progress::Done);
    }

    let genesis = source.genesis_l1_block;
    let target = anchor + interval;
    if runtime.block_on(ethereum.finalized_block())?.0 < genesis + target {
        *held = Some(state);
        return Ok(Progress::Waiting);
    }
    let started = Instant::now();
    let mut native = state.native(source)?;
    let interval_dir = dir.interval(anchor, target);
    std::fs::create_dir_all(&interval_dir)?;
    // The interval's blocks are kept, because beacon nodes drop blobs after
    // about 18 days.
    let raw = runtime.block_on(blocks::load(
        &endpoints.l1_rpc,
        &endpoints.beacon_api,
        source.inbox_address,
        genesis + anchor + 1,
        genesis + target,
        Some(&interval_dir.join("blocks")),
    ))?;
    // Each proof is saved as it is made and reused on a rerun, so a failure
    // after a proof is paid for never pays for it again. A quote saves none.
    let proofs = (!quote).then(|| interval_dir.join(if prover.programs.real() { "real" } else { "mock" }));
    if let Some(proofs) = &proofs {
        std::fs::create_dir_all(proofs)?;
    }
    // A quote prices this attempt's proofs, not those of an attempt that failed.
    prover.programs.take_requests();
    let ranges = prove_ranges(&prover.programs, &mut native, source, &raw, prover.range_blocks, proofs.as_deref())?;
    check_node(runtime, endpoints, &native, target)?;
    let next = AnchorState::of(&native)?;

    // The aggregation proof links the interval to an Ethereum head, a
    // finalized block, whose hash the contract reads from EIP-2935's history.
    // The head is saved with the interval before the aggregation proof is
    // requested, so a rerun requests the same proof.
    let head_file = interval_dir.join("head");
    let head = if quote {
        runtime.block_on(ethereum.finalized_block())?
    } else {
        runtime.block_on(interval_head(ethereum, &head_file))?
    };
    let headers = runtime.block_on(blocks::headers(&endpoints.l1_rpc, genesis + target + 1, head.0))?;
    let (outputs, proof) = prover.programs.prove_aggregation(ranges, headers, ethereum.from, proofs.as_deref())?;
    ensure!(
        outputs.l2PreRoot == state.root
            && outputs.claimRoot == next.root
            && outputs.claimBlockNum == U256::from(target)
            && outputs.l1Head == head.1
            && outputs.proverAddress == ethereum.from,
        "aggregation outputs do not match native derivation: {outputs:?}"
    );
    let requests = prover.programs.take_requests();
    if quote {
        let quote = prover.programs.quote(&requests)?;
        println!("{} proofs for PCASH blocks {}..={target}: {quote}", requests.len(), anchor + 1);
        *held = Some(state);
        return Ok(Progress::Proved);
    }
    // Past the history's reach, the next attempt takes a new head and proves
    // only the aggregation again.
    if !runtime.block_on(in_history(ethereum, head.0, 0))? {
        std::fs::remove_file(&head_file)?;
        bail!("Ethereum block {}'s hash has left EIP-2935's history", head.0);
    }
    // SP1's verifier takes the proof's bytes; `ExecutedVerifier`, standing in
    // for it, takes the proof's public values.
    let onchain = if prover.programs.real() {
        Bytes::from(proof.bytes())
    } else {
        Bytes::from(proof.public_values.to_vec())
    };
    runtime.block_on(ethereum.prove_block(contract, target, next.root, head.0, onchain))?;
    println!(
        "proved PCASH block {target}: root {}, Ethereum head {}, {:?}",
        next.root,
        head.0,
        started.elapsed()
    );
    // A state not saved is derived again after a restart.
    if let Err(error) = save(runtime, ethereum, contract, dir, &next) {
        println!("saving the state at PCASH block {target}: {error:#}");
    }
    *held = Some(next);
    Ok(Progress::Proved)
}

/// Save `state`, and delete the states and intervals a rollback can no longer
/// return to: those before the contract's anchor as of Ethereum's finalized
/// block.
fn save(runtime: &Runtime, ethereum: &Ethereum, contract: Address, dir: &StateDir, state: &AnchorState) -> Result<()> {
    dir.save(state)?;
    match runtime.block_on(ethereum.finalized_anchor(contract))? {
        Some(floor) => dir.prune(floor),
        None => Ok(()),
    }
}

/// The blocks EIP-2935's history contract holds hashes of: the last 8191.
const HISTORY_WINDOW: u64 = 8191;
/// The history blocks a head must have left, about an hour, for proofs to be
/// made for it.
const HEAD_MARGIN: u64 = 300;

/// Whether the history contract will still hold Ethereum block `number`'s
/// hash `margin` blocks after the next one.
async fn in_history(ethereum: &Ethereum, number: u64, margin: u64) -> Result<bool> {
    Ok(ethereum.latest_block().await? + margin < number + HISTORY_WINDOW)
}

/// The interval's Ethereum head: the one saved in `file` while the history
/// contract holds its hash for long enough, or else Ethereum's finalized
/// block, saved.
async fn interval_head(ethereum: &Ethereum, file: &Path) -> Result<(u64, B256)> {
    if file.exists() {
        let saved = std::fs::read_to_string(file)?;
        let (number, hash) = saved
            .trim()
            .split_once(' ')
            .ok_or_else(|| eyre!("{}: no head", file.display()))?;
        let head = (number.parse()?, hash.parse()?);
        if in_history(ethereum, head.0, HEAD_MARGIN).await? {
            return Ok(head);
        }
    }
    let finalized = ethereum.finalized_block().await?;
    ensure!(
        in_history(ethereum, finalized.0, HEAD_MARGIN).await?,
        "finalized block {} is too old for EIP-2935's history",
        finalized.0
    );
    std::fs::write(file, format!("{} {}", finalized.0, finalized.1))?;
    Ok(finalized)
}
