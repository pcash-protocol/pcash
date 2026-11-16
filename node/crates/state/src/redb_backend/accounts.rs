//! Account rows loaded for the block's account mutations.
use super::read::read_account;
use super::{backend, RedbState, T_ADDRESSES};
use crate::{BlockUpdate, StateError};
use redb::ReadableDatabase;
impl RedbState {
    pub(super) fn evict_account_working_set(&mut self) {
        self.inner.accounts.clear();
    }
    pub(super) fn hydrate_account_update(
        &mut self,
        update: &BlockUpdate,
    ) -> Result<(), StateError> {
        self.evict_account_working_set();
        if update.account_ops.is_empty() {
            return Ok(());
        }
        let read = self.db.begin_read().map_err(backend)?;
        let table = read.open_table(T_ADDRESSES).map_err(backend)?;
        for operation in &update.account_ops {
            if let Some(account) = read_account(&table, operation.address)? {
                self.inner.accounts.insert(operation.address, account);
            }
        }
        Ok(())
    }
}
