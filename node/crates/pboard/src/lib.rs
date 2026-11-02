//! The PCASH message board index and its `pboard_*` JSON-RPC namespace.
//!
//! Board posts are public records in private-value arenas. The indexer reads
//! them from the node's output feed into its own store, which a node serves
//! next to `pcash_*` when the board index is turned on. The index is not
//! consensus state: it is rebuildable from the feed and may lag the node.

pub mod api;
pub mod follow;
pub mod post;
pub mod store;

#[cfg(test)]
mod tests;

pub use follow::{follow, sync, BoardSource, SyncError, SyncOutcome};
pub use post::{BoardNetwork, Post};
pub use store::{BoardStore, StoreError};

/// The sibling data file the board index uses.
pub fn board_path_for(state_path: &std::path::Path) -> std::path::PathBuf {
    state_path.with_extension("pboard.redb")
}
