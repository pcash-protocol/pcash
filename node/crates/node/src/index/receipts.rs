use alloy_primitives::{Address, B256};
use redb::{ReadableTable, TableDefinition, TableError};

use crate::node::ReceiptRecord;
use pcash_state::{Codec, StateError};

use super::keys::{
    account_key, be, block_of, block_ordinal_key, kind_block_ordinal_key, receipt_from_row,
    ReceiptRow, T_RECEIPTS, T_RECEIPT_BY_ACCOUNT, T_RECEIPT_BY_BLOCK_ORDINAL, T_RECEIPT_BY_CONTENT,
    T_RECEIPT_BY_KIND_BLOCK_ORDINAL, T_RECEIPT_BY_LIFECYCLE_ADDRESS, T_RECEIPT_BY_NULLIFIER,
    T_RECEIPT_BY_TXID, T_SUCCEEDED_RECEIPT_BY_CONTENT,
};
use super::store::{IndexReadSource, IndexStore};

impl<D: IndexReadSource> IndexStore<D> {
    pub fn receipts_by_block_ordinal(
        &self,
        block: Option<u64>,
        kind: Option<u8>,
        before: Option<(u64, u64)>,
        limit: usize,
    ) -> Result<Vec<(u64, u64, ReceiptRecord)>, StateError> {
        let read = self.db.read_transaction()?;
        let mut rows = Vec::with_capacity(limit);
        if let Some(kind) = kind {
            let table = read
                .open_table(T_RECEIPT_BY_KIND_BLOCK_ORDINAL)
                .map_err(be)?;
            let low = kind_block_ordinal_key(kind, block.unwrap_or(0), 0);
            let high = before.map_or_else(
                || kind_block_ordinal_key(kind, block.unwrap_or(u64::MAX), u64::MAX),
                |(number, ordinal)| kind_block_ordinal_key(kind, number, ordinal),
            );
            for row in table
                .range(low.as_slice()..high.as_slice())
                .map_err(be)?
                .rev()
            {
                let (key, primary) = row.map_err(be)?;
                let key = key.value();
                let number = u64::from_be_bytes(key[1..9].try_into().map_err(be)?);
                if block.is_some_and(|expected| number != expected) {
                    continue;
                }
                let ordinal = u64::from_be_bytes(key[9..17].try_into().map_err(be)?);
                if let Some(receipt) = Self::receipt_at(&read, primary.value())? {
                    rows.push((number, ordinal, receipt));
                    if rows.len() == limit {
                        break;
                    }
                }
            }
        } else {
            let table = read.open_table(T_RECEIPT_BY_BLOCK_ORDINAL).map_err(be)?;
            let low = block_ordinal_key(block.unwrap_or(0), 0);
            let high = before.map_or_else(
                || block_ordinal_key(block.unwrap_or(u64::MAX), u64::MAX),
                |(number, ordinal)| block_ordinal_key(number, ordinal),
            );
            for row in table
                .range(low.as_slice()..high.as_slice())
                .map_err(be)?
                .rev()
            {
                let (key, primary) = row.map_err(be)?;
                let key = key.value();
                let number = u64::from_be_bytes(key[..8].try_into().map_err(be)?);
                if block.is_some_and(|expected| number != expected) {
                    continue;
                }
                let ordinal = u64::from_be_bytes(key[8..16].try_into().map_err(be)?);
                if let Some(receipt) = Self::receipt_at(&read, primary.value())? {
                    rows.push((number, ordinal, receipt));
                    if rows.len() == limit {
                        break;
                    }
                }
            }
        }
        Ok(rows)
    }

    /// Newest accepted receipts with a positive open-route fee in the inclusive
    /// block window.
    /// Ineligible receipts do not consume the sample budget.
    pub fn open_fee_receipts(
        &self,
        first_block: u64,
        last_block: u64,
        limit: usize,
    ) -> Result<Vec<ReceiptRecord>, StateError> {
        let read = self.db.read_transaction()?;
        let table = read.open_table(T_RECEIPT_BY_BLOCK_ORDINAL).map_err(be)?;
        let low = block_ordinal_key(first_block, 0);
        let high = block_ordinal_key(last_block, u64::MAX);
        let mut receipts = Vec::with_capacity(limit);
        for row in table
            .range(low.as_slice()..=high.as_slice())
            .map_err(be)?
            .rev()
        {
            if receipts.len() == limit {
                break;
            }
            let (_, primary) = row.map_err(be)?;
            if let Some(receipt) = Self::receipt_at(&read, primary.value())? {
                if receipt.accepted() && receipt.has_open_fee {
                    receipts.push(receipt);
                }
            }
        }
        Ok(receipts)
    }

    pub fn succeeded_receipt_by_content(
        &self,
        content_hash: B256,
    ) -> Result<Option<ReceiptRecord>, StateError> {
        let read = self.db.read_transaction()?;
        let index = read
            .open_table(T_SUCCEEDED_RECEIPT_BY_CONTENT)
            .map_err(be)?;
        let Some(primary) = index.get(content_hash.as_slice()).map_err(be)? else {
            return Ok(None);
        };
        Self::receipt_at(&read, primary.value())
    }

    fn receipts_by_prefixed_primary(
        &self,
        table: TableDefinition<&[u8], &[u8]>,
        prefix: &[u8],
        before: Option<[u8; 24]>,
        limit: usize,
    ) -> Result<Vec<ReceiptRecord>, StateError> {
        let read = self.db.read_transaction()?;
        let index = read.open_table(table).map_err(be)?;
        let mut low = prefix.to_vec();
        low.extend_from_slice(&[0u8; 24]);
        let mut high = prefix.to_vec();
        high.extend_from_slice(before.as_ref().unwrap_or(&[0xffu8; 24]));
        let mut rows = Vec::with_capacity(limit);
        for row in index
            .range(low.as_slice()..high.as_slice())
            .map_err(be)?
            .rev()
        {
            let (key, _) = row.map_err(be)?;
            let primary = &key.value()[prefix.len()..];
            if let Some(receipt) = Self::receipt_at(&read, primary)? {
                rows.push(receipt);
                if rows.len() == limit {
                    break;
                }
            }
        }
        Ok(rows)
    }

    pub fn receipts_by_content(
        &self,
        content_hash: B256,
        before: Option<[u8; 24]>,
        limit: usize,
    ) -> Result<Vec<ReceiptRecord>, StateError> {
        self.receipts_by_prefixed_primary(
            T_RECEIPT_BY_CONTENT,
            content_hash.as_slice(),
            before,
            limit,
        )
    }

    pub fn receipts_for_settlement(
        &self,
        content_hash: B256,
        limit: usize,
    ) -> Result<Vec<ReceiptRecord>, StateError> {
        let success = self.succeeded_receipt_by_content(content_hash)?;
        let mut rows = self.receipts_by_content(content_hash, None, limit)?;
        if let Some(success) = success {
            if !rows.iter().any(|receipt| receipt.tx_id == success.tx_id) {
                if rows.len() == limit {
                    rows.pop();
                }
                rows.push(success);
            }
        }
        Ok(rows)
    }

    pub fn receipts_by_lifecycle_address(
        &self,
        address: Address,
        before: Option<[u8; 24]>,
        limit: usize,
    ) -> Result<Vec<ReceiptRecord>, StateError> {
        self.receipts_by_prefixed_primary(
            T_RECEIPT_BY_LIFECYCLE_ADDRESS,
            address.as_slice(),
            before,
            limit,
        )
    }

    /// Load every receipt with block number `<= block`, in cursor order
    /// (== derivation order). A missing table (fresh file) yields empties.
    pub fn load_receipts_up_to(&self, block: u64) -> Result<Vec<ReceiptRecord>, StateError> {
        let r = self.db.read_transaction()?;
        let mut receipts = Vec::new();
        if let Ok(t) = r.open_table(T_RECEIPTS) {
            for row in t.iter().map_err(be)? {
                let (k, v) = row.map_err(be)?;
                let key = k.value();
                if block_of(key) > block {
                    continue;
                }
                let rr = ReceiptRow::decode(v.value()).map_err(be)?;
                receipts.push(receipt_from_row(key, rr));
            }
        }
        Ok(receipts)
    }

    /// Resolve a 24-byte primary receipt key against [`T_RECEIPTS`] within an
    /// open read transaction. A dangling index entry (no primary row) yields
    /// `None` rather than an error.
    pub(super) fn receipt_at(
        r: &redb::ReadTransaction,
        primary_key: &[u8],
    ) -> Result<Option<ReceiptRecord>, StateError> {
        let t = match r.open_table(T_RECEIPTS) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(e) => return Err(be(e)),
        };
        let Some(v) = t.get(primary_key).map_err(be)? else {
            return Ok(None);
        };
        let rr = ReceiptRow::decode(v.value()).map_err(be)?;
        Ok(Some(receipt_from_row(primary_key, rr)))
    }

    /// The unique receipt named by this inclusion's transaction ID.
    pub fn receipt_by_txid(&self, tx_id: &B256) -> Result<Option<ReceiptRecord>, StateError> {
        self.receipt_by_secondary(T_RECEIPT_BY_TXID, tx_id.as_slice())
    }

    pub fn receipt_by_block_ordinal(
        &self,
        block_number: u64,
        pcash_transaction_index: u64,
    ) -> Result<Option<ReceiptRecord>, StateError> {
        self.receipt_by_secondary(
            T_RECEIPT_BY_BLOCK_ORDINAL,
            &block_ordinal_key(block_number, pcash_transaction_index),
        )
    }

    /// The accepted private-value receipt that consumed `nullifier`.
    pub fn receipt_by_nullifier(
        &self,
        nullifier: &B256,
    ) -> Result<Option<ReceiptRecord>, StateError> {
        self.receipt_by_secondary(T_RECEIPT_BY_NULLIFIER, nullifier.as_slice())
    }

    /// The accepted account-write receipt for an `(address, revision)` pair.
    pub fn receipt_by_account(
        &self,
        address: &Address,
        account_revision: u32,
    ) -> Result<Option<ReceiptRecord>, StateError> {
        self.receipt_by_secondary(
            T_RECEIPT_BY_ACCOUNT,
            &account_key(address, account_revision),
        )
    }

    /// Shared single-valued secondary lookup: `secondary_key -> primary_key ->
    /// receipt`. A missing table or dangling pointer yields `None`.
    pub(super) fn receipt_by_secondary(
        &self,
        table: TableDefinition<&[u8], &[u8]>,
        secondary_key: &[u8],
    ) -> Result<Option<ReceiptRecord>, StateError> {
        let r = self.db.read_transaction()?;
        let idx = match r.open_table(table) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(e) => return Err(be(e)),
        };
        let Some(primary_key) = idx.get(secondary_key).map_err(be)? else {
            return Ok(None);
        };
        Self::receipt_at(&r, primary_key.value())
    }
}
