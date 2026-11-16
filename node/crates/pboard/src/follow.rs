//! Advances the board index along the node's output feed.
//!
//! The indexer reads the node only through [`NodeApi`], the surface the
//! `pcash_*` RPC serves, so it sees exactly what an external indexer would:
//! the ready derived-index cursor, output pages pinned to it, and canonical
//! blocks by hash. It lags the node and never blocks derivation.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::B256;
use pcash_derive::public_records::read_public_records;
use pcash_rpc::dto::{BlockId, OutputMaterialDto, OutputPageDto};
use pcash_rpc::{NodeApi, OutputLimits, OutputRequest};
use tokio::sync::watch;

use crate::post::{decode_post, BoardNetwork};
use crate::store::{BoardStore, Cursor, IndexedPost, StoreError};

/// One page's budget: the node's largest.
const PAGE_LIMITS: OutputLimits = OutputLimits {
    max_outputs: 10_000,
    max_bytes: 4 * 1024 * 1024,
};
/// Bounds the wait between syncs when no index change arrives.
const IDLE_SYNC: Duration = Duration::from_secs(30);
const RETRY_DELAY: Duration = Duration::from_secs(1);
const RETRY_MAX_DELAY: Duration = Duration::from_mins(1);

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("node read failed: {0}")]
    Node(String),
    #[error("node serves chain {chain_id} with genesis {genesis_hash}, not the board's chain")]
    WrongNetwork { chain_id: u32, genesis_hash: B256 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncOutcome {
    /// The node's derived index is not ready; nothing was read.
    NotReady,
    /// The board reached the node's ready cursor.
    Synced(Cursor),
    /// The board's cursor left the canonical chain and the index rewound to
    /// a canonical checkpoint, or to the first output without one.
    Rewound(Option<Cursor>),
    /// The board's cursor left the canonical chain while pages were read;
    /// nothing was written.
    Raced,
}

/// What the indexer reads from a node. Every [`NodeApi`] provides it.
pub trait BoardSource: Send + Sync {
    /// The node's chain, and its derived-index cursor when the index is ready.
    fn ready_cursor(&self) -> Result<(BoardNetwork, Option<BlockId>), String>;
    fn get_outputs(&self, request: OutputRequest) -> Result<OutputPageDto, String>;
    fn is_canonical(&self, block_hash: B256) -> Result<bool, String>;
}

impl<T: NodeApi + ?Sized> BoardSource for T {
    fn ready_cursor(&self) -> Result<(BoardNetwork, Option<BlockId>), String> {
        let status = self.status().map_err(|error| error.to_string())?;
        let network = BoardNetwork {
            chain_id: status.pcash_chain_id,
            genesis_hash: status.genesis_hash,
        };
        Ok((
            network,
            (status.index.status == "ready")
                .then_some(status.index.cursor)
                .flatten(),
        ))
    }

    fn get_outputs(&self, request: OutputRequest) -> Result<OutputPageDto, String> {
        NodeApi::get_outputs(self, request).map_err(|error| error.to_string())
    }

    fn is_canonical(&self, block_hash: B256) -> Result<bool, String> {
        self.get_block_by_hash(block_hash, false)
            .map(|block| block.is_some())
            .map_err(|error| error.to_string())
    }
}

fn canonical(api: &dyn BoardSource, cursor: &Cursor) -> Result<bool, SyncError> {
    api.is_canonical(cursor.block_hash).map_err(SyncError::Node)
}

/// One step toward the node's ready cursor. A rewind is its own step; the
/// caller syncs again.
pub fn sync(api: &dyn BoardSource, store: &BoardStore) -> Result<SyncOutcome, SyncError> {
    let (served, target) = api.ready_cursor().map_err(SyncError::Node)?;
    let network = store.network();
    if served != network {
        return Err(SyncError::WrongNetwork {
            chain_id: served.chain_id,
            genesis_hash: served.genesis_hash,
        });
    }
    let Some(target) = target else {
        return Ok(SyncOutcome::NotReady);
    };
    let cursor = store.cursor()?;
    if let Some(cursor) = &cursor {
        if !canonical(api, cursor)? {
            let mut kept = None;
            for checkpoint in store.checkpoints()? {
                if canonical(api, &checkpoint)? {
                    kept = Some(checkpoint);
                    break;
                }
            }
            store.rewind(kept)?;
            return Ok(SyncOutcome::Rewound(kept));
        }
        if cursor.block_hash == target.block_hash {
            return Ok(SyncOutcome::Synced(*cursor));
        }
    }

    let from = cursor.map_or(0, |cursor| cursor.next_output_index);
    let mut posts = Vec::new();
    let mut continuation = None;
    let next_output_index = loop {
        let page = api
            .get_outputs(OutputRequest {
                from_output_index: from,
                target,
                continuation,
                limits: PAGE_LIMITS,
            })
            .map_err(SyncError::Node)?;
        // A page starts at its transaction's first output, which may precede `from`.
        for output in page
            .outputs
            .iter()
            .filter(|output| output.output_index >= from)
        {
            let OutputMaterialDto::Ordinary {
                transaction_id,
                transaction_type,
                content_hash,
                arena: Some(arena),
                ..
            } = &output.material
            else {
                continue;
            };
            if *transaction_type != pcash_derive::KIND_PRIVATE_VALUE {
                continue;
            }
            let Some(post) =
                read_public_records(arena).and_then(|records| decode_post(network, &records))
            else {
                continue;
            };
            posts.push(IndexedPost {
                post,
                output_index: output.output_index,
                block_number: output.origin.block_number,
                block_hash: output.origin.block_hash,
                timestamp: output.origin.block_timestamp,
                transaction_id: *transaction_id,
                content_hash: *content_hash,
            });
        }
        match page.continuation {
            Some(next) if !page.complete => continuation = Some(next),
            _ => break page.target.output_count,
        }
    };
    // The pages are pinned to `target`; the posts already indexed join them
    // only while the old cursor's block is still canonical.
    if let Some(cursor) = &cursor {
        if !canonical(api, cursor)? {
            return Ok(SyncOutcome::Raced);
        }
    }
    let cursor = Cursor {
        block_number: target.block_number,
        block_hash: target.block_hash,
        next_output_index,
    };
    store.apply(&posts, cursor)?;
    Ok(SyncOutcome::Synced(cursor))
}

/// Keep the board at the node's ready cursor, syncing whenever `changes`
/// reports the node's index moved. Failures are logged and retried.
pub async fn follow<T: Send + Sync + 'static>(
    api: Arc<dyn BoardSource>,
    store: Arc<BoardStore>,
    mut changes: watch::Receiver<T>,
) -> Infallible {
    let mut delay = RETRY_DELAY;
    loop {
        let step = {
            let api = Arc::clone(&api);
            let store = Arc::clone(&store);
            tokio::task::spawn_blocking(move || sync(api.as_ref(), &store)).await
        };
        match step {
            Ok(Ok(SyncOutcome::Rewound(cursor))) => {
                tracing::info!(
                    block = cursor.map(|cursor| cursor.block_number),
                    "board index rewound after a reorg"
                );
                continue;
            }
            Ok(Ok(SyncOutcome::Raced)) => continue,
            Ok(Ok(SyncOutcome::Synced(_) | SyncOutcome::NotReady)) => delay = RETRY_DELAY,
            Ok(Err(error)) => {
                tracing::warn!(%error, retry_seconds = delay.as_secs(), "board index sync failed");
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(RETRY_MAX_DELAY);
                continue;
            }
            Err(error) => {
                tracing::warn!(%error, "board index sync task failed");
                tokio::time::sleep(delay).await;
                continue;
            }
        }
        // A change during the sync is still unseen, so it starts the next one at once.
        if let Ok(Err(_closed)) = tokio::time::timeout(IDLE_SYNC, changes.changed()).await {
            tokio::time::sleep(IDLE_SYNC).await;
        }
    }
}
