//! Nullifier rows loaded for the block's insertions.
use super::{backend, to32, RedbReadSnapshot, RedbState, NULLIFIER_TREE_ID, T_NULLIFIERS, T_TREES};
use crate::{BlockUpdate, StateError, B256, NULLIFIER_TREE_DEPTH};
use redb::ReadableDatabase;
use std::ops::Bound::{Excluded, Included, Unbounded};
use std::ops::RangeBounds;

type Rows = redb::ReadOnlyTable<&'static [u8], &'static [u8]>;

/// Whether `nullifier` is spent.
pub(super) fn nullifier_spent(rows: &Rows, nullifier: B256) -> Result<bool, StateError> {
    Ok(rows.get(nullifier.as_slice()).map_err(backend)?.is_some())
}

fn first_in<'a>(
    rows: &Rows,
    range: impl RangeBounds<&'a [u8]>,
    last: bool,
) -> Result<Option<(B256, u64)>, StateError> {
    let mut range = rows.range(range).map_err(backend)?;
    let row = if last {
        range.next_back()
    } else {
        range.next()
    };
    row.map(|row| {
        let (value, index) = row.map_err(backend)?;
        let index = index
            .value()
            .try_into()
            .map(u64::from_be_bytes)
            .map_err(|_| backend("nullifier index row is malformed"))?;
        Ok((B256::from(to32(value.value())?), index))
    })
    .transpose()
}

/// The largest spent value at or below `value`, with its leaf index.
pub(super) fn nullifier_at_or_below(
    rows: &Rows,
    value: B256,
) -> Result<Option<(B256, u64)>, StateError> {
    first_in(rows, (Unbounded, Included(value.as_slice())), true)
}

/// The smallest spent value above `value`, with its leaf index.
pub(super) fn nullifier_above(rows: &Rows, value: B256) -> Result<Option<(B256, u64)>, StateError> {
    first_in(rows, (Excluded(value.as_slice()), Unbounded), false)
}

impl RedbState {
    pub(super) fn evict_nullifier_working_set(&mut self) {
        self.inner.nullifier_tree.evict();
    }
    /// One point read; derivation asks once per transaction input.
    pub(super) fn nullifier_is_spent(&self, nullifier: B256) -> Result<bool, StateError> {
        let read = self.db.begin_read().map_err(backend)?;
        let rows = read.open_table(T_NULLIFIERS).map_err(backend)?;
        nullifier_spent(&rows, nullifier)
    }
    /// Loads each new nullifier's stored neighbours and the siblings of every
    /// leaf the insertions can rewrite: the new leaves and the predecessors.
    /// No stored predecessor means the sentinel.
    pub(super) fn hydrate_nullifier_update(
        &mut self,
        update: &BlockUpdate,
    ) -> Result<(), StateError> {
        self.evict_nullifier_working_set();
        if update.nullifiers.is_empty() {
            return Ok(());
        }
        let read = self.db.begin_read().map_err(backend)?;
        let rows = read.open_table(T_NULLIFIERS).map_err(backend)?;
        let trees = read.open_table(T_TREES).map_err(backend)?;
        let tree = &mut self.inner.nullifier_tree;
        let first = tree.count() + 1;
        let mut leaves = (first..first + update.nullifiers.len() as u64).collect::<Vec<_>>();
        for &nullifier in &update.nullifiers {
            let below = nullifier_at_or_below(&rows, nullifier)?;
            leaves.push(below.map_or(0, |(_, index)| index));
            for (value, index) in below.into_iter().chain(nullifier_above(&rows, nullifier)?) {
                tree.load_index(value, index);
            }
        }
        for leaf in leaves {
            for height in 0..NULLIFIER_TREE_DEPTH as u8 {
                let index = (leaf >> height) ^ 1;
                let node = RedbReadSnapshot::read_tree_node(
                    &trees,
                    NULLIFIER_TREE_ID,
                    height as usize,
                    index,
                )?;
                tree.load_node(height, index, node);
            }
        }
        Ok(())
    }
}
