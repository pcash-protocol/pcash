//! Node startup, resume, and derived-index catch-up.

use std::convert::Infallible;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alloy_primitives::B256;
use eyre::WrapErr;
use pcash_derive::ProtocolRules;
use pcash_l1::{L1Client, NormalizedLog, NormalizedLogBlock};
use pcash_metrics::Metrics;
use pcash_state::{StateDb, StateError};

use crate::config::{compiled_rules, NetworkConfig};
use crate::follow::{publish_index_progress, CATCHUP_DURABLE_INTERVAL};
use crate::index::{self, DerivedIndexStore};
use crate::node::NodeInner;

static REPLACEMENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Path of the derived-index file: the state file with its extension replaced by
/// `index.redb` (e.g. `state.redb` → `state.index.redb`). Deriving it from the full
/// state path — not a fixed sibling name — keeps two state files in one directory
/// from colliding on a single shared index file.
fn index_path_for(db_path: &Path) -> PathBuf {
    db_path.with_extension("index.redb")
}

fn sibling_replacement_path(path: &Path, label: &str) -> eyre::Result<PathBuf> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| eyre::eyre!("database path has no UTF-8 file name"))?;
    let sequence = REPLACEMENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(path.with_file_name(format!(
        ".{name}.{label}.{}.{}",
        std::process::id(),
        sequence
    )))
}

fn sync_file_and_parent(path: &Path) -> eyre::Result<()> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .wrap_err_with(|| format!("fsync {}", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| eyre::eyre!("database path has no parent directory"))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .wrap_err_with(|| format!("fsync parent directory {}", parent.display()))
}

/// Deletes a replacement derived-index scratch file when the replacement
/// returns, on success and on every error path. A file renamed into its
/// canonical place is already gone from the scratch path, so the guard
/// silently finds nothing.
/// Bind it before the database it backs so the database closes first.
struct ScratchFile(PathBuf);

impl Drop for ScratchFile {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    %error,
                    path = %self.0.display(),
                    "index replacement scratch file was not removed"
                );
            }
        }
    }
}

/// Open a rebuildable derived index, replacing a missing/corrupt file with a
/// freshly initialized sibling. Canonical state readiness never depends on an
/// index file being usable.
fn open_or_replace_index(path: &Path) -> eyre::Result<DerivedIndexStore> {
    match DerivedIndexStore::open(path) {
        Ok(index) => Ok(index),
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "derived index will be rebuilt");
            replace_index(path)
        }
    }
}

/// Atomically replace the index file at `path` with an empty index.
fn replace_index(path: &Path) -> eyre::Result<DerivedIndexStore> {
    let replacement_path = sibling_replacement_path(path, "index-rebuild")?;
    let _replacement_file = ScratchFile(replacement_path.clone());
    let replacement = DerivedIndexStore::create(&replacement_path)
        .map_err(|error| eyre::eyre!("create replacement derived index: {error}"))?;
    sync_file_and_parent(&replacement_path)?;
    std::fs::rename(&replacement_path, path).wrap_err_with(|| {
        format!(
            "atomically install replacement derived index {}",
            path.display()
        )
    })?;
    sync_file_and_parent(path)?;
    Ok(replacement)
}

fn create_state(
    path: &Path,
    cfg: &NetworkConfig,
    prefix: B256,
) -> eyre::Result<pcash_state::RedbState> {
    let source = cfg.derivation_source();
    Ok(pcash_state::RedbState::create(path, source, prefix)?)
}

fn base_prefix_hash(rules: &ProtocolRules) -> alloy_primitives::B256 {
    rules.base_fork_schedule_prefix_hash()
}

/// Accept an existing database's adopted fork marker, read with the source
/// stored beside it, for the configured `source` and this binary's schedule.
fn validate_adopted_marker(
    (stored_source, marker): (
        pcash_state::DerivationSource,
        pcash_state::AdoptedForkCompatibility,
    ),
    source: pcash_state::DerivationSource,
    rules: &ProtocolRules,
) -> eyre::Result<pcash_state::AdoptedForkCompatibility> {
    let count = usize::try_from(marker.adopted_fork_count)
        .map_err(|_| eyre::eyre!("adopted fork count is not representable"))?;
    if stored_source.pcash_chain_id != source.pcash_chain_id || count > rules.fork_schedule.len() {
        eyre::bail!("adopted fork marker does not match this derivation source/schedule");
    }
    let expected_hash = if count == 0 {
        rules.base_fork_schedule_prefix_hash()
    } else {
        rules.activated_fork_schedule_prefix_hash_at(
            rules.fork_schedule[count - 1].activation_timestamp,
        )
    };
    if marker.adopted_prefix_hash != expected_hash {
        eyre::bail!("adopted fork marker prefix does not match this binary");
    }
    Ok(marker)
}

/// Build a fresh shared node at paths that do not already exist under the
/// compiled rules, and wrap it behind the shared lock used by follow and RPC.
pub fn build_node(db_path: &Path, cfg: &NetworkConfig) -> eyre::Result<Arc<Mutex<NodeInner>>> {
    let rules = compiled_rules();
    build_node_with_rules_inner(db_path, cfg, rules)
}

/// Build a fresh node whose canonical state and derived index use redb's
/// process-local memory backend. This path deliberately has no resume or
/// replacement behavior: dropping the process drops the complete database.
pub fn build_in_memory_node(cfg: &NetworkConfig) -> eyre::Result<StartPlan> {
    let rules = compiled_rules();
    let source = cfg.derivation_source();
    let state = pcash_state::RedbState::create_in_memory(source, base_prefix_hash(&rules))?;
    let index = DerivedIndexStore::create_in_memory()
        .map_err(|error| eyre::eyre!("open in-memory derived index: {error}"))?;
    Ok(StartPlan {
        inner: Arc::new(Mutex::new(NodeInner::new(state, index, rules))),
        follower_start: cfg.genesis_l1_block,
        anchor: None,
        replacement: None,
    })
}

/// [`build_node`] under explicit rules. Tests use this to compile a fork
/// schedule the release binary does not have.
#[cfg(feature = "test-support")]
pub fn build_node_with_rules(
    db_path: &Path,
    cfg: &NetworkConfig,
    rules: ProtocolRules,
) -> eyre::Result<Arc<Mutex<NodeInner>>> {
    build_node_with_rules_inner(db_path, cfg, rules)
}

pub(crate) fn build_node_with_rules_inner(
    db_path: &Path,
    cfg: &NetworkConfig,
    rules: ProtocolRules,
) -> eyre::Result<Arc<Mutex<NodeInner>>> {
    let state = create_state(db_path, cfg, base_prefix_hash(&rules))?;
    let index = open_or_replace_index(&index_path_for(db_path))?;
    Ok(Arc::new(Mutex::new(NodeInner::new(state, index, rules))))
}

fn classify_derived_index(inner: &mut NodeInner) {
    let Some(tip) = inner.state.canonical_tip() else {
        inner.set_index_lifecycle(match inner.index.cursor() {
            Ok(cursor) => index::DerivedIndexLifecycle::CatchingUp { cursor },
            Err(_) => index::DerivedIndexLifecycle::Unavailable,
        });
        return;
    };
    let target = index::IndexBlockId {
        number: tip.header.number,
        hash: tip.hash,
    };
    let mut cursor = match inner.index.cursor() {
        Ok(cursor) => cursor,
        Err(error) => {
            tracing::warn!(%error, "derived index cursor is unreadable; rebuild required");
            inner.set_index_lifecycle(index::DerivedIndexLifecycle::Unavailable);
            return;
        }
    };
    if cursor.is_some_and(|cursor| cursor.pcash_number > target.number) {
        if let Err(error) = inner.index.rewind_to(target) {
            tracing::warn!(%error, "derived index cannot rewind to canonical state; rebuild required");
            inner.set_index_lifecycle(index::DerivedIndexLifecycle::Unavailable);
            return;
        }
        cursor = inner.index.cursor().ok().flatten();
    }
    let lifecycle = match cursor {
        Some(cursor)
            if cursor.pcash_number == target.number && cursor.pcash_hash == target.hash =>
        {
            index::DerivedIndexLifecycle::Ready(cursor)
        }
        Some(cursor) if cursor.pcash_number < target.number => {
            match inner.state.canonical_stored_block(cursor.pcash_number) {
                Ok(Some(block)) if block.hash == cursor.pcash_hash => {
                    index::DerivedIndexLifecycle::CatchingUp {
                        cursor: Some(cursor),
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "canonical state read failed while classifying derived index");
                    index::DerivedIndexLifecycle::Unavailable
                }
                Ok(_) => index::DerivedIndexLifecycle::Unavailable,
            }
        }
        None => index::DerivedIndexLifecycle::CatchingUp { cursor: None },
        Some(_) => index::DerivedIndexLifecycle::Unavailable,
    };
    inner.set_index_lifecycle(lifecycle);
}

fn seed_open_node(
    state: pcash_state::RedbState,
    index: DerivedIndexStore,
    rules: ProtocolRules,
    finalized_l1: u64,
) -> eyre::Result<NodeInner> {
    let mut inner = NodeInner::new(state, index, rules);
    inner.l1_finalized = finalized_l1;
    if let Some(tip) = inner.state.canonical_tip() {
        let first_unfinalized_parent = finalized_l1
            .saturating_sub(inner.source.genesis_l1_block)
            .min(tip.header.number);
        for number in first_unfinalized_parent..=tip.header.number {
            let block = inner
                .state
                .canonical_stored_block(number)?
                .ok_or_else(|| eyre::eyre!("canonical state is missing block {number}"))?;
            inner
                .block_hashes
                .insert(block.l1_origin.block_number, block.l1_origin.block_hash);
        }
        inner.head = Some(tip.l1_origin.block_number);
    }
    classify_derived_index(&mut inner);
    Ok(inner)
}

/// Bring the derived index to the canonical tip from stored canonical data:
/// each block's boundary, the effects of its admitted transactions, and its L1
/// origin's logs. An index on the canonical chain continues from its cursor.
/// An index without a cursor or an unusable one is replaced by an empty index
/// and built from block zero. An apply failure stops catch-up and leaves the
/// index unavailable.
///
/// The node lock is held for one block at a time and the future yields
/// between blocks, so dropping it stops the work at a block boundary.
pub async fn catch_up_derived_index(
    db_path: &Path,
    inner: &Arc<Mutex<NodeInner>>,
) -> eyre::Result<()> {
    catch_up(Some(db_path), inner).await
}

/// [`catch_up_derived_index`] for a node whose index lives beside `db_path`, or
/// in memory when there is no path.
async fn catch_up(db_path: Option<&Path>, inner: &Arc<Mutex<NodeInner>>) -> eyre::Result<()> {
    {
        let mut guard = inner.lock().unwrap();
        if guard.state.canonical_tip_summary().is_none() {
            return Ok(());
        }
        match guard.index_lifecycle() {
            index::DerivedIndexLifecycle::Ready(_) => return Ok(()),
            index::DerivedIndexLifecycle::CatchingUp { cursor: Some(_) } => {}
            index::DerivedIndexLifecycle::CatchingUp { cursor: None }
            | index::DerivedIndexLifecycle::Unavailable => {
                install_empty_index(db_path, &mut guard)?;
            }
        }
    }
    apply_stored_blocks(inner).await
}

fn install_empty_index(db_path: Option<&Path>, node: &mut NodeInner) -> eyre::Result<()> {
    let replacement = match db_path {
        Some(db_path) => replace_index(&index_path_for(db_path))?,
        None => DerivedIndexStore::create_in_memory()
            .map_err(|error| eyre::eyre!("create replacement derived index: {error}"))?,
    };
    *node.index_reader.write().unwrap() = replacement.clone();
    node.index = replacement;
    node.set_index_lifecycle(index::DerivedIndexLifecycle::CatchingUp { cursor: None });
    Ok(())
}

/// Apply stored blocks after the lifecycle's cursor until the index reaches the
/// canonical tip. The lifecycle and the tip are read again before each block,
/// so a rollback between two blocks redirects the work or ends it.
async fn apply_stored_blocks(inner: &Arc<Mutex<NodeInner>>) -> eyre::Result<()> {
    loop {
        {
            let mut guard = inner.lock().unwrap();
            let cursor = match guard.index_lifecycle() {
                index::DerivedIndexLifecycle::Ready(_) => return Ok(()),
                index::DerivedIndexLifecycle::CatchingUp { cursor } => cursor,
                index::DerivedIndexLifecycle::Unavailable => {
                    eyre::bail!("derived index became unavailable during catch-up")
                }
            };
            let tip = guard
                .state
                .canonical_tip_summary()
                .expect("catch-up starts after canonical block zero");
            let next = cursor.map_or(0, |cursor| cursor.pcash_number + 1);
            if next > tip.number {
                return match cursor {
                    Some(cursor) if cursor.pcash_hash == tip.hash => {
                        guard.set_index_lifecycle(index::DerivedIndexLifecycle::Ready(cursor));
                        Ok(())
                    }
                    _ => {
                        guard.set_index_lifecycle(index::DerivedIndexLifecycle::Unavailable);
                        Err(eyre::eyre!(
                            "derived index cursor does not match the canonical tip"
                        ))
                    }
                };
            }
            match catch_up_block(&guard, next, next == tip.number) {
                Ok(applied) => {
                    guard.set_index_lifecycle(index::DerivedIndexLifecycle::CatchingUp {
                        cursor: Some(applied),
                    });
                }
                Err(error) => {
                    guard.set_index_lifecycle(index::DerivedIndexLifecycle::Unavailable);
                    return Err(error);
                }
            }
        }
        tokio::task::yield_now().await;
    }
}

const INDEX_RETRY_DELAY: Duration = Duration::from_secs(1);
const INDEX_RETRY_MAX_DELAY: Duration = Duration::from_mins(1);

/// Keep the derived index following the canonical tip for the life of the
/// node. Whenever the index is not ready, because a head write failed, a
/// rollback left it behind, or startup catch-up failed, recover it from stored
/// canonical data, retrying with backoff until an attempt completes. `db_path`
/// is `None` for an in-memory node.
///
/// Start it once canonical block zero exists and poll it on the follow loop's
/// task. Block zero's index write is the one head write made while the index
/// is not ready, and no head write may overlap an index replacement.
pub async fn maintain_derived_index(
    db_path: Option<&Path>,
    inner: &Arc<Mutex<NodeInner>>,
    metrics: &Arc<dyn Metrics>,
) -> Infallible {
    let mut lifecycle = inner.lock().unwrap().watch_index_lifecycle();
    loop {
        lifecycle
            .wait_for(|lifecycle| !matches!(lifecycle, index::DerivedIndexLifecycle::Ready(_)))
            .await
            .map(drop)
            .expect("the node owns its index lifecycle");
        let mut delay = INDEX_RETRY_DELAY;
        loop {
            let attempt = recover_derived_index(db_path, inner).await;
            let ready = {
                let guard = inner.lock().unwrap();
                publish_index_progress(&guard, metrics);
                matches!(
                    guard.index_lifecycle(),
                    index::DerivedIndexLifecycle::Ready(_)
                )
            };
            if let Err(error) = attempt {
                metrics.record_index_write_failure();
                tracing::warn!(
                    %error,
                    retry_seconds = delay.as_secs(),
                    "derived index recovery failed; retrying"
                );
            }
            if ready {
                break;
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(INDEX_RETRY_MAX_DELAY);
        }
        tracing::info!("derived index caught up to the canonical tip");
    }
}

/// One recovery attempt for an index that is not ready: reopen its file if a
/// write failed, classify it against canonical state as opening the node does,
/// catch it up, and refresh its verification view.
async fn recover_derived_index(
    db_path: Option<&Path>,
    inner: &Arc<Mutex<NodeInner>>,
) -> eyre::Result<()> {
    {
        let mut guard = inner.lock().unwrap();
        match guard.index_lifecycle() {
            // A rollback made it ready. It belongs to the head path again,
            // which writes outside this lock.
            index::DerivedIndexLifecycle::Ready(_) => {}
            index::DerivedIndexLifecycle::CatchingUp { .. } => classify_derived_index(&mut guard),
            index::DerivedIndexLifecycle::Unavailable => {
                if let Some(db_path) = db_path {
                    let path = index_path_for(db_path);
                    reopen_index(&mut guard, || DerivedIndexStore::open(&path))?;
                }
                classify_derived_index(&mut guard);
            }
        }
    }
    catch_up(db_path, inner).await?;
    refresh_recovered_index(inner)
}

/// Close the index's database handle and install the one `open` returns.
///
/// After one storage error redb refuses every later write on a handle, while
/// its cached pages, the cursor among them, still read. An index whose write
/// failed is therefore reopened before it is classified. The file admits one
/// handle, so the old one closes first: a read still in flight on it fails,
/// and until `open` returns a handle, in this attempt or a later one, the node
/// holds an empty in-memory index.
fn reopen_index(
    node: &mut NodeInner,
    open: impl FnOnce() -> Result<DerivedIndexStore, StateError>,
) -> eyre::Result<()> {
    let closed = DerivedIndexStore::create_in_memory()
        .map_err(|error| eyre::eyre!("close derived index: {error}"))?;
    *node.index_reader.write().unwrap() = closed.clone();
    node.index = closed;
    // Opening can repair the file; RPC reads are not held up behind it.
    let index = open().map_err(|error| eyre::eyre!("reopen derived index: {error}"))?;
    *node.index_reader.write().unwrap() = index.clone();
    node.index = index;
    Ok(())
}

/// Reopen `node`'s index over `backend`, so a test can make its storage fail.
#[cfg(feature = "test-support")]
pub fn reopen_index_with_backend(
    node: &mut NodeInner,
    backend: impl redb::StorageBackend,
) -> eyre::Result<()> {
    reopen_index(node, || DerivedIndexStore::open_with_backend(backend))
}

/// Rebuild the verification view of an index that recovery just made ready: a
/// registry change made while it was not ready was not indexed. A failed write
/// leaves the index unavailable, so the next attempt redoes the refresh.
fn refresh_recovered_index(inner: &Arc<Mutex<NodeInner>>) -> eyre::Result<()> {
    let mut guard = inner.lock().unwrap();
    if !matches!(
        guard.index_lifecycle(),
        index::DerivedIndexLifecycle::Ready(_)
    ) {
        return Ok(());
    }
    if let Err(error) = guard.recompute_contract_verification() {
        guard.set_index_lifecycle(index::DerivedIndexLifecycle::Unavailable);
        eyre::bail!("refresh contract verification rows: {error}");
    }
    Ok(())
}

/// Apply stored block `number` to the derived index. Only every
/// [`CATCHUP_DURABLE_INTERVAL`]th block and the last one commit durably.
fn catch_up_block(
    node: &NodeInner,
    number: u64,
    last: bool,
) -> eyre::Result<index::DerivedIndexCursor> {
    let missing =
        |record: &str| eyre::eyre!("canonical state is missing the {record} of block {number}");
    let boundary = node
        .state
        .committed_boundary(number)?
        .ok_or_else(|| missing("boundary"))?;
    let transactions = node
        .state
        .transaction_effects(number)?
        .ok_or_else(|| missing("transaction effects"))?;
    let l1_logs = node
        .state
        .l1_log_leaves(number)?
        .ok_or_else(|| missing("L1 logs"))?;
    let l1_logs = NormalizedLogBlock::from_logs(
        l1_logs
            .into_iter()
            .map(|log| NormalizedLog {
                transaction_index: log.transaction_index,
                log_index: log.log_index,
                leaf: log.leaf,
            })
            .collect(),
    );
    NodeInner::apply_index_block(
        &node.index,
        &node.source,
        node.contract_verification.as_deref(),
        &boundary,
        &transactions.iter().collect::<Vec<_>>(),
        &l1_logs,
        last || number.is_multiple_of(CATCHUP_DURABLE_INTERVAL),
    )
    .map_err(|error| eyre::eyre!("apply stored PCASH block {number} to the derived index: {error}"))
}

/// How the follow loop should be started after [`resume_or_build_node`].
pub struct StartPlan {
    /// The shared node, either resumed at the finalized checkpoint or cold-fresh.
    pub inner: Arc<Mutex<NodeInner>>,
    /// The first L1 height the follower should fetch: `F + 1` on resume, the
    /// genesis height on a cold start.
    pub follower_start: u64,
    /// Parent-hash continuity anchor for `follower_start` on resume (`F`'s hash),
    /// so the first block after resume is still reorg-checked. `None` on cold
    /// start (the first block is unanchored by construction).
    pub anchor: Option<B256>,
    replacement: Option<StartupReplacement>,
}

struct StartupReplacement {
    canonical_state_path: PathBuf,
    staged_state_path: PathBuf,
    canonical_index_path: PathBuf,
    staged_index_path: PathBuf,
    target_l1_number: u64,
    target_l1_hash: B256,
    preserved_adopted_fork_count: u32,
}

impl StartPlan {
    /// A forced replacement must reach this immutable L1 identity before any
    /// service can observe it. Ordinary cold starts and resumes return `None`.
    pub fn replacement_target(&self) -> Option<(u64, B256)> {
        self.replacement
            .as_ref()
            .map(|replacement| (replacement.target_l1_number, replacement.target_l1_hash))
    }

    /// Atomically install a fully derived forced replacement. Canonical state
    /// is promoted first; the index follows as rebuildable data. A crash between
    /// the two leaves a valid state database and an index that startup rejects
    /// and reconstructs.
    pub fn promote_replacement(&mut self) -> eyre::Result<()> {
        let Some(replacement) = self.replacement.as_ref() else {
            return Ok(());
        };
        {
            let guard = self.inner.lock().unwrap();
            if guard.head != Some(replacement.target_l1_number)
                || guard.block_hashes.get(&replacement.target_l1_number)
                    != Some(&replacement.target_l1_hash)
            {
                eyre::bail!(
                    "forced replacement did not reach captured L1 target {} ({})",
                    replacement.target_l1_number,
                    replacement.target_l1_hash
                );
            }
            if guard.state.adopted_fork_compatibility().adopted_fork_count
                < replacement.preserved_adopted_fork_count
            {
                eyre::bail!("forced replacement rolled back adopted fork compatibility");
            }
        }

        sync_file_and_parent(&replacement.staged_state_path)?;
        sync_file_and_parent(&replacement.staged_index_path)?;
        std::fs::rename(
            &replacement.staged_state_path,
            &replacement.canonical_state_path,
        )
        .wrap_err_with(|| {
            format!(
                "atomically install replacement state {}",
                replacement.canonical_state_path.display()
            )
        })?;
        sync_file_and_parent(&replacement.canonical_state_path)?;
        std::fs::rename(
            &replacement.staged_index_path,
            &replacement.canonical_index_path,
        )
        .wrap_err_with(|| {
            format!(
                "atomically install replacement derived index {}",
                replacement.canonical_index_path.display()
            )
        })?;
        sync_file_and_parent(&replacement.canonical_index_path)?;
        self.replacement = None;
        Ok(())
    }
}

/// Open the node, attempting a restart resume from the persisted checkpoint.
///
/// A resume is taken only when ALL of the following hold:
/// 1. a checkpoint exists in the state DB (`peek_checkpoint`);
/// 2. the state database's stored derivation source matches this configuration;
/// 3. its internal activated fork-schedule prefix matches this binary at the
///    checkpointed PCASH timestamp;
/// 4. the L1 block at the checkpointed finalized height `F` (fetched from the
///    configured Ethereum JSON-RPC endpoint) still has exactly the stored hash.
///
/// On success the state is restored to `F`, index rows above `F` are removed, the
/// head/finality/trail are seeded at `F`, and the follower resumes at `F + 1`.
/// A brand-new/uncheckpointed database
/// cold-starts normally.
/// A malformed, mismatched, unreachable, or unrestorable existing checkpoint is
/// an error: startup fails closed and leaves both files untouched.
pub async fn resume_or_build_node(
    db_path: &Path,
    cfg: &NetworkConfig,
    l1: &L1Client,
) -> eyre::Result<StartPlan> {
    resume_or_build_node_with_force_resync(db_path, cfg, l1, false).await
}

/// [`resume_or_build_node`] under explicit rules, so a test can resume under a
/// fork schedule the release binary does not compile.
#[cfg(feature = "test-support")]
pub async fn resume_or_build_node_with_rules(
    db_path: &Path,
    cfg: &NetworkConfig,
    l1: &L1Client,
    rules: ProtocolRules,
) -> eyre::Result<StartPlan> {
    resume_or_build(db_path, cfg, l1, false, rules).await
}

/// [`resume_or_build_node`] with an explicit isolated replacement fallback.
///
/// `force_resync` authorizes rebuilding derived state and its index only when an
/// existing checkpoint cannot be validated or restored. It is intended for a
/// deliberate operator `--force-resync`; normal startup must pass `false` so a
/// transient RPC failure or finalized-history mismatch cannot destroy the last
/// known-good restart anchor.
pub async fn resume_or_build_node_with_force_resync(
    db_path: &Path,
    cfg: &NetworkConfig,
    l1: &L1Client,
    force_resync: bool,
) -> eyre::Result<StartPlan> {
    let rules = compiled_rules();
    resume_or_build(db_path, cfg, l1, force_resync, rules).await
}

/// Shared body of the resume paths. `rules` are the compiled rules the resumed
/// node will run under; every fork-schedule decision below reads them, so the
/// checkpoint guard and the running node can never disagree.
async fn resume_or_build(
    db_path: &Path,
    cfg: &NetworkConfig,
    l1: &L1Client,
    force_resync: bool,
    rules: ProtocolRules,
) -> eyre::Result<StartPlan> {
    match try_resume(db_path, cfg, l1, &rules).await {
        Ok(Some(plan)) => return Ok(plan),
        Ok(None) => {}
        Err(error) if force_resync => {
            tracing::warn!(
                error = %error,
                "resume validation failed; building an isolated --force-resync replacement"
            );
            return build_forced_replacement(db_path, cfg, l1, rules).await;
        }
        Err(error) => {
            return Err(error).wrap_err(
                "refusing automatic cold resync; fix the checkpoint/L1 configuration or rerun with --force-resync",
            );
        }
    }

    // No canonical state exists, so this is an ordinary first start.
    let inner = build_node_with_rules_inner(db_path, cfg, rules)?;
    Ok(StartPlan {
        inner,
        follower_start: cfg.genesis_l1_block,
        anchor: None,
        replacement: None,
    })
}

async fn build_forced_replacement(
    db_path: &Path,
    cfg: &NetworkConfig,
    l1: &L1Client,
    rules: ProtocolRules,
) -> eyre::Result<StartPlan> {
    let source = cfg.derivation_source();
    let adopted = pcash_state::RedbState::peek_adopted(db_path)
        .map_err(|error| eyre::eyre!("reading adopted fork marker failed: {error}"))?
        .ok_or_else(|| {
            eyre::eyre!("cannot force-resync without the existing monotonic adopted fork marker")
        })?;
    let adopted = validate_adopted_marker(adopted, source, &rules)?;
    let target_l1_number = l1
        .latest_block_number()
        .await
        .wrap_err("capture force-resync L1 target height")?;
    if target_l1_number < cfg.genesis_l1_block {
        eyre::bail!(
            "force-resync target {} precedes configured genesis L1 block {}",
            target_l1_number,
            cfg.genesis_l1_block
        );
    }
    let target_l1_hash = l1
        .block_hash_by_number(target_l1_number)
        .await
        .wrap_err("capture force-resync L1 target hash")?;

    let staged_state_path = sibling_replacement_path(db_path, "state-resync")?;
    let canonical_index_path = index_path_for(db_path);
    let staged_index_path = index_path_for(&staged_state_path);
    let mut state = create_state(
        &staged_state_path,
        cfg,
        rules.base_fork_schedule_prefix_hash(),
    )?;
    state
        .advance_adopted_fork(adopted.adopted_fork_count, adopted.adopted_prefix_hash)
        .map_err(|error| eyre::eyre!("preserve adopted fork marker in replacement: {error}"))?;
    let index = DerivedIndexStore::create(&staged_index_path)
        .map_err(|error| eyre::eyre!("create replacement derived index: {error}"))?;
    let inner = Arc::new(Mutex::new(NodeInner::new(state, index, rules)));
    Ok(StartPlan {
        inner,
        follower_start: cfg.genesis_l1_block,
        anchor: None,
        replacement: Some(StartupReplacement {
            canonical_state_path: db_path.to_path_buf(),
            staged_state_path,
            canonical_index_path,
            staged_index_path,
            target_l1_number,
            target_l1_hash,
            preserved_adopted_fork_count: adopted.adopted_fork_count,
        }),
    })
}

/// Attempt a resume. `Ok(None)` means no checkpoint exists and a normal cold
/// start is appropriate. Every validation/read/restore failure is returned so
/// the caller fails closed unless the operator explicitly authorized resync.
async fn try_resume(
    db_path: &Path,
    cfg: &NetworkConfig,
    l1: &L1Client,
    rules: &ProtocolRules,
) -> eyre::Result<Option<StartPlan>> {
    let ck = match pcash_state::RedbState::peek_checkpoint(db_path) {
        Ok(Some(ck)) => ck,
        Ok(None) => {
            if !db_path.exists() {
                return Ok(None);
            }
            let source = cfg.derivation_source();
            let adopted = pcash_state::RedbState::peek_adopted(db_path)
                .map_err(|error| eyre::eyre!("reading adopted fork marker failed: {error}"))?
                .ok_or_else(|| eyre::eyre!("state database is missing its adopted fork marker"))?;
            let adopted = validate_adopted_marker(adopted, source, rules)?;
            let state = pcash_state::RedbState::open(db_path, source, adopted)
                .map_err(|error| eyre::eyre!("open uncheckpointed redb state: {error}"))?;
            let index = open_or_replace_index(&index_path_for(db_path))?;
            let inner = seed_open_node(state, index, rules.clone(), 0)?;
            let (follower_start, anchor) = match inner.head {
                Some(head) => (
                    head.checked_add(1)
                        .ok_or_else(|| eyre::eyre!("resumed L1 head overflow"))?,
                    inner.block_hashes.get(&head).copied(),
                ),
                None => (cfg.genesis_l1_block, None),
            };
            tracing::info!(
                head = ?inner.head,
                "opened existing canonical state before its first finalized checkpoint"
            );
            return Ok(Some(StartPlan {
                inner: Arc::new(Mutex::new(inner)),
                follower_start,
                anchor,
                replacement: None,
            }));
        }
        Err(e) => {
            return Err(eyre::eyre!("reading resume checkpoint failed: {e}"));
        }
    };

    let source = cfg.derivation_source();
    let expected_fork_schedule_prefix =
        rules.activated_fork_schedule_prefix_hash_at(ck.pcash_block_timestamp);
    if ck.fork_schedule_prefix_hash != expected_fork_schedule_prefix {
        eyre::bail!("resume checkpoint activated fork-schedule prefix does not match this binary");
    }
    let adopted = pcash_state::RedbState::peek_adopted(db_path)
        .map_err(|error| eyre::eyre!("reading adopted fork marker failed: {error}"))?
        .ok_or_else(|| eyre::eyre!("state database is missing its adopted fork marker"))?;
    let adopted = validate_adopted_marker(adopted, source, rules)?;

    // Cross-check the checkpointed finalized block against the live L1 chain. Only
    // the hash is needed, so this is a header-only fetch, not the full block body.
    let expected = B256::from(ck.finalized_l1_hash);
    let actual = l1
        .block_hash_by_number(ck.finalized_l1_block)
        .await
        .wrap_err_with(|| {
            format!(
                "fetching L1 block {} for resume checkpoint",
                ck.finalized_l1_block
            )
        })?;
    if actual != expected {
        eyre::bail!(
            "resume checkpoint L1 hash mismatch at finalized block {} (stored {}, L1 {})",
            ck.finalized_l1_block,
            expected,
            actual
        );
    }

    let inner = resume_node(db_path, &ck, source, adopted, rules.clone())
        .wrap_err("resume failed after checkpoint validation")?;
    tracing::info!(
        finalized = ck.finalized_l1_block,
        "resumed from persisted checkpoint (no cold resync)"
    );
    Ok(Some(StartPlan {
        inner,
        follower_start: ck.finalized_l1_block + 1,
        anchor: Some(expected),
        replacement: None,
    }))
}

/// Restore state to `F` and seed the head/finality/trail so derivation continues
/// at `F + 1`. The rebuildable index is classified independently: ahead rows are
/// rewound when possible, a behind index catches up from its cursor, and a
/// divergent/corrupt index is replaced rather than blocking canonical state
/// startup.
fn resume_node(
    db_path: &Path,
    ck: &pcash_state::PersistedCheckpoint,
    source: pcash_state::DerivationSource,
    adopted: pcash_state::AdoptedForkCompatibility,
    rules: ProtocolRules,
) -> eyre::Result<Arc<Mutex<NodeInner>>> {
    let state = pcash_state::RedbState::resume(db_path, source, adopted)
        .map_err(|e| eyre::eyre!("resume redb state: {e}"))?;
    let index = open_or_replace_index(&index_path_for(db_path))?;
    let inner = seed_open_node(state, index, rules, ck.finalized_l1_block)?;
    // Canonical header, tip, and timestamp were restored with state.
    let tip = inner
        .state
        .canonical_tip()
        .ok_or_else(|| eyre::eyre!("state checkpoint is missing its canonical PCASH block"))?;
    if tip.header.number != ck.pcash_block_number
        || tip.hash != ck.pcash_block_hash
        || tip.header.timestamp != ck.pcash_block_timestamp
    {
        eyre::bail!("state checkpoint PCASH tip does not match persisted checkpoint identity");
    }
    Ok(Arc::new(Mutex::new(inner)))
}
