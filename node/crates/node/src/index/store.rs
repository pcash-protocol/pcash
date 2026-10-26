use std::{collections::HashMap, path::Path, sync::Arc};

use alloy_primitives::{Address, B256};
use pcash_derive::{ReceiveKeyUpdate, Transaction, UserAccountUpdate};
use pcash_l1::NormalizedLogBlock;
use pcash_state::{AccountResult, Codec, ReceiveKeyOperation, StateError, TransactionEffects};
use redb::{Database, Durability, ReadableDatabase, ReadableTable, Table, TableError};

use crate::node::{DerivationSummary, ReceiptRecord};

use super::keys::{
    account_key, be, block_of, block_ordinal_key, content_receipt_key, contract_creation_key,
    kind_block_ordinal_key, l1_log_block_key, l1_log_key, l1_log_node_key, lifecycle_receipt_key,
    output_key, pcash_block_key, receipt_key, receive_material_key, validate_index_schema,
    BlockEconomicsRow, DerivationSummaryRow, ReceiptRow, INDEX_SCHEMA, M_CHAIN_ID, M_CURSOR,
    M_GENESIS_HASH, M_SCHEMA, M_TOTAL_FAILED, M_TOTAL_SUCCEEDED, T_BLOCKS, T_BLOCK_ECONOMICS,
    T_CONTRACT_BY_CREATION, T_CONTRACT_MATERIAL, T_CONTRACT_SOURCE_INFO, T_INDEXED_BLOCKS,
    T_INDEX_UNDO, T_L1_LOGS, T_L1_LOG_BLOCKS, T_L1_LOG_NODES, T_META, T_OUTPUTS, T_RECEIPTS,
    T_RECEIPT_BY_ACCOUNT, T_RECEIPT_BY_BLOCK_ORDINAL, T_RECEIPT_BY_CONTENT,
    T_RECEIPT_BY_KIND_BLOCK_ORDINAL, T_RECEIPT_BY_LIFECYCLE_ADDRESS, T_RECEIPT_BY_NULLIFIER,
    T_RECEIPT_BY_TXID, T_RECEIVE_MATERIAL, T_SUCCEEDED_RECEIPT_BY_CONTENT,
    T_VERIFIED_CONTRACT_BY_CREATION,
};
use super::types::{
    ContractFunctionMaterial, ContractMaterialUpdate, ContractSourceInfo,
    ContractVerificationLookup, DerivedIndexCursor, IndexBlockId, IndexUndoRow, IndexedBlockRow,
    IndexedL1Log, IndexedL1LogBlock, IndexedL1LogProof, IndexedOutputItem, IndexedOutputMaterial,
    ReceiveMaterialUpdate,
};

/// Write one contract's verification rows, keeping the creation entry present
/// only while the contract is verified.
fn write_contract_verification(
    source_info: &mut Table<'_, &'static [u8], &'static [u8]>,
    verified_by_creation: &mut Table<'_, &'static [u8], &'static [u8]>,
    material: &ContractMaterialUpdate,
    info: Option<ContractSourceInfo>,
) -> Result<(), StateError> {
    let creation_key = contract_creation_key(
        material.pcash_block_number,
        material.pcash_transaction_index,
    );
    let Some(info) = info else {
        source_info
            .remove(material.address.as_slice())
            .map_err(be)?;
        verified_by_creation
            .remove(creation_key.as_slice())
            .map_err(be)?;
        return Ok(());
    };
    source_info
        .insert(material.address.as_slice(), info.encode().as_slice())
        .map_err(be)?;
    if info.verified {
        verified_by_creation
            .insert(creation_key.as_slice(), material.address.as_slice())
            .map_err(be)?;
    } else {
        verified_by_creation
            .remove(creation_key.as_slice())
            .map_err(be)?;
    }
    Ok(())
}

/// The key a successful user-account write installed with `REPLACE` or at
/// creation.
fn replaced_receive_key(transaction: &Transaction) -> &[u8] {
    let key = match transaction {
        Transaction::UserAccountCreation(creation) => creation.receive_key(),
        Transaction::PrivateValue(section) => match section.account_creation() {
            Some(pcash_derive::AccountCreationAttachment::User(creation)) => creation.receive_key(),
            _ => None,
        },
        Transaction::UserAccountUpdate(UserAccountUpdate {
            receive_key_update: ReceiveKeyUpdate::Replace(key),
            ..
        }) => Some(&**key),
        _ => None,
    };
    let Some(key) = key else {
        unreachable!("a replaced receive key comes from a user-account write")
    };
    key.as_slice()
}

/// Rebuildable query index over a dedicated `redb` file.
#[derive(Clone)]
pub struct IndexStore<D> {
    pub(super) db: D,
}

pub type DerivedIndexStore = IndexStore<Arc<Database>>;
pub type DerivedIndexRead = IndexStore<Arc<redb::ReadTransaction>>;

pub trait IndexReadSource {
    fn read_transaction(&self) -> Result<Arc<redb::ReadTransaction>, StateError>;
}

impl IndexReadSource for Arc<Database> {
    fn read_transaction(&self) -> Result<Arc<redb::ReadTransaction>, StateError> {
        self.begin_read().map(Arc::new).map_err(be)
    }
}

impl IndexReadSource for Arc<redb::ReadTransaction> {
    fn read_transaction(&self) -> Result<Arc<redb::ReadTransaction>, StateError> {
        Ok(self.clone())
    }
}

impl DerivedIndexStore {
    /// Pin one committed index view for every query in an RPC response.
    pub fn read_snapshot(&self) -> Result<DerivedIndexRead, StateError> {
        Ok(IndexStore {
            db: self.db.read_transaction()?,
        })
    }

    /// Create a new derived index. Existing files are never truncated in place.
    pub fn create(path: impl AsRef<Path>) -> Result<Self, StateError> {
        let path = path.as_ref();
        if path.exists() {
            return Err(StateError::Backend(
                "refusing to create derived index over an existing database".into(),
            ));
        }
        let db = Database::create(path).map_err(be)?;
        Self::create_with_database(db)
    }

    /// Create a fresh derived index over redb's process-local memory backend.
    pub fn create_in_memory() -> Result<Self, StateError> {
        let db = Database::builder()
            .create_with_backend(redb::backends::InMemoryBackend::new())
            .map_err(be)?;
        Self::create_with_database(db)
    }

    fn create_with_database(db: Database) -> Result<Self, StateError> {
        {
            let mut w = db.begin_write().map_err(be)?;
            w.set_durability(Durability::Immediate).map_err(be)?;
            {
                let mut meta = w.open_table(T_META).map_err(be)?;
                meta.insert(M_SCHEMA, INDEX_SCHEMA).map_err(be)?;
                meta.insert(M_TOTAL_SUCCEEDED, 0u64.to_be_bytes().as_slice())
                    .map_err(be)?;
                meta.insert(M_TOTAL_FAILED, 0u64.to_be_bytes().as_slice())
                    .map_err(be)?;
            }
            w.open_table(T_RECEIPTS).map_err(be)?;
            w.open_table(T_BLOCKS).map_err(be)?;
            w.open_table(T_BLOCK_ECONOMICS).map_err(be)?;
            w.open_table(T_L1_LOG_BLOCKS).map_err(be)?;
            w.open_table(T_L1_LOG_NODES).map_err(be)?;
            w.open_table(T_L1_LOGS).map_err(be)?;
            w.open_table(T_INDEXED_BLOCKS).map_err(be)?;
            w.open_table(T_OUTPUTS).map_err(be)?;
            w.open_table(T_INDEX_UNDO).map_err(be)?;
            w.open_table(T_RECEIVE_MATERIAL).map_err(be)?;
            w.open_table(T_CONTRACT_MATERIAL).map_err(be)?;
            w.open_table(T_CONTRACT_BY_CREATION).map_err(be)?;
            w.open_table(T_CONTRACT_SOURCE_INFO).map_err(be)?;
            w.open_table(T_VERIFIED_CONTRACT_BY_CREATION).map_err(be)?;
            w.open_table(T_RECEIPT_BY_TXID).map_err(be)?;
            w.open_table(T_RECEIPT_BY_NULLIFIER).map_err(be)?;
            w.open_table(T_RECEIPT_BY_ACCOUNT).map_err(be)?;
            w.open_table(T_RECEIPT_BY_CONTENT).map_err(be)?;
            w.open_table(T_SUCCEEDED_RECEIPT_BY_CONTENT).map_err(be)?;
            w.open_table(T_RECEIPT_BY_BLOCK_ORDINAL).map_err(be)?;
            w.open_table(T_RECEIPT_BY_KIND_BLOCK_ORDINAL).map_err(be)?;
            w.open_table(T_RECEIPT_BY_LIFECYCLE_ADDRESS).map_err(be)?;
            w.commit().map_err(be)?;
        }
        Ok(Self { db: Arc::new(db) })
    }

    /// Open an existing derived index without mutating it.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StateError> {
        Self::open_database(Database::open(path).map_err(be)?)
    }

    /// [`Self::open`] over `backend`, so a test can make the index's storage
    /// fail.
    #[cfg(feature = "test-support")]
    pub(crate) fn open_with_backend(
        backend: impl redb::StorageBackend,
    ) -> Result<Self, StateError> {
        Self::open_database(
            Database::builder()
                .create_with_backend(backend)
                .map_err(be)?,
        )
    }

    fn open_database(db: Database) -> Result<Self, StateError> {
        validate_index_schema(&db)?;
        let read = db.begin_read().map_err(be)?;
        let meta = read.open_table(T_META).map_err(be)?;
        let schema = meta
            .get(M_SCHEMA)
            .map_err(be)?
            .ok_or_else(|| StateError::Backend("derived index has no schema marker".into()))?;
        if schema.value() != INDEX_SCHEMA {
            return Err(StateError::Backend(
                "derived index schema marker does not match this node".into(),
            ));
        }
        read.open_table(T_RECEIPTS).map_err(be)?;
        read.open_table(T_BLOCKS).map_err(be)?;
        read.open_table(T_BLOCK_ECONOMICS).map_err(be)?;
        read.open_table(T_L1_LOG_BLOCKS).map_err(be)?;
        read.open_table(T_L1_LOG_NODES).map_err(be)?;
        read.open_table(T_L1_LOGS).map_err(be)?;
        read.open_table(T_INDEXED_BLOCKS).map_err(be)?;
        read.open_table(T_OUTPUTS).map_err(be)?;
        read.open_table(T_INDEX_UNDO).map_err(be)?;
        read.open_table(T_RECEIVE_MATERIAL).map_err(be)?;
        read.open_table(T_CONTRACT_MATERIAL).map_err(be)?;
        read.open_table(T_CONTRACT_BY_CREATION).map_err(be)?;
        read.open_table(T_CONTRACT_SOURCE_INFO).map_err(be)?;
        read.open_table(T_VERIFIED_CONTRACT_BY_CREATION)
            .map_err(be)?;
        read.open_table(T_RECEIPT_BY_TXID).map_err(be)?;
        read.open_table(T_RECEIPT_BY_NULLIFIER).map_err(be)?;
        read.open_table(T_RECEIPT_BY_ACCOUNT).map_err(be)?;
        read.open_table(T_RECEIPT_BY_CONTENT).map_err(be)?;
        read.open_table(T_RECEIPT_BY_BLOCK_ORDINAL).map_err(be)?;
        read.open_table(T_RECEIPT_BY_KIND_BLOCK_ORDINAL)
            .map_err(be)?;
        read.open_table(T_RECEIPT_BY_LIFECYCLE_ADDRESS)
            .map_err(be)?;
        drop(meta);
        drop(read);
        Ok(Self { db: Arc::new(db) })
    }

    /// Bind a new store to one public chain identity before any cursor can be
    /// installed. Reopening with a different identity fails closed.
    pub fn bind_identity(&self, chain_id: u32, genesis_hash: B256) -> Result<(), StateError> {
        let mut write = self.db.begin_write().map_err(be)?;
        write.set_durability(Durability::Immediate).map_err(be)?;
        {
            let mut meta = write.open_table(T_META).map_err(be)?;
            let stored_chain = meta
                .get(M_CHAIN_ID)
                .map_err(be)?
                .map(|stored| stored.value().to_vec());
            if let Some(stored) = stored_chain {
                if stored.as_slice() != chain_id.to_be_bytes() {
                    return Err(StateError::Backend(
                        "derived index chain id does not match canonical state".into(),
                    ));
                }
            } else {
                meta.insert(M_CHAIN_ID, chain_id.to_be_bytes().as_slice())
                    .map_err(be)?;
            }
            let stored_genesis = meta
                .get(M_GENESIS_HASH)
                .map_err(be)?
                .map(|stored| stored.value().to_vec());
            if let Some(stored) = stored_genesis {
                if stored.as_slice() != genesis_hash.as_slice() {
                    return Err(StateError::Backend(
                        "derived index genesis hash does not match canonical state".into(),
                    ));
                }
            } else {
                meta.insert(M_GENESIS_HASH, genesis_hash.as_slice())
                    .map_err(be)?;
            }
        }
        write.commit().map_err(be)
    }

    /// Atomically apply one committed block's complete projection and advance
    /// the single canonical cursor. `transactions` and `receipt_rows` are
    /// aligned with the block's transaction results.
    pub(crate) fn apply_block(
        &self,
        boundary: &pcash_state::CommittedBoundary,
        transactions: &[&TransactionEffects],
        l1_logs: &NormalizedLogBlock,
        receipt_rows: &[ReceiptRecord],
        verification: Option<&dyn ContractVerificationLookup>,
        durable: bool,
    ) -> Result<DerivedIndexCursor, StateError> {
        let (chain_id, genesis_hash) = self.identity()?;
        let origin = &boundary.l1_origin;
        let header = &boundary.block.header;
        let block_hash = boundary.block.hash;
        let mut receive_material = Vec::<(Address, u32, ReceiveMaterialUpdate)>::new();
        let mut contract_material = Vec::new();
        let mut latest_receive_material = HashMap::<Address, ReceiveMaterialUpdate>::new();
        let mut output_rows = Vec::new();
        for ((effects, transaction), receipt) in transactions
            .iter()
            .zip(&boundary.block.transaction_bytes)
            .zip(receipt_rows)
        {
            let TransactionEffects::Accepted(effects) = effects else {
                continue;
            };
            let decoded = Transaction::decode(transaction, chain_id).map_err(|error| {
                StateError::Backend(format!("admitted transaction is malformed: {error}"))
            })?;
            if let (Some(leaf_start), Some(section)) =
                (effects.output_leaf_start, decoded.section())
            {
                let private_value_shape = match &decoded {
                    Transaction::PrivateValue(section) => Some(section.shape() as u8),
                    _ => None,
                };
                for (slot, (commitment, output_data)) in effects
                    .output_commitments
                    .iter()
                    .zip(section.output_data())
                    .enumerate()
                {
                    output_rows.push(IndexedOutputItem {
                        output_index: leaf_start + slot as u64,
                        output_commitment: *commitment,
                        material: IndexedOutputMaterial::Ordinary {
                            output_data: output_data.clone(),
                            transaction_id: receipt.tx_id,
                            transaction_kind: effects.kind,
                            private_value_shape,
                            output_slot: slot as u16,
                            content_hash: receipt.content_hash,
                            nullifiers: if slot == 0 {
                                effects.nullifiers.clone()
                            } else {
                                Vec::new()
                            },
                            arena: if slot == 0 {
                                section.arena().to_vec()
                            } else {
                                Vec::new()
                            },
                        },
                        pcash_block_number: header.number,
                        pcash_block_hash: block_hash,
                    });
                }
            }
            if let Some(account) = &effects.account {
                let (address, revision, update) = match account {
                    AccountResult::User {
                        address,
                        revision,
                        receive_key,
                        ..
                    } => {
                        let update = match receive_key {
                            ReceiveKeyOperation::Keep => {
                                match latest_receive_material.get(address).cloned() {
                                    Some(previous) => previous,
                                    None => self
                                        .receive_material(*address, revision - 1)?
                                        .unwrap_or(ReceiveMaterialUpdate { key: None }),
                                }
                            }
                            ReceiveKeyOperation::Clear => ReceiveMaterialUpdate { key: None },
                            ReceiveKeyOperation::Replace => ReceiveMaterialUpdate {
                                key: Some(replaced_receive_key(&decoded).to_vec()),
                            },
                        };
                        latest_receive_material.insert(*address, update.clone());
                        (*address, *revision, update)
                    }
                    AccountResult::Contract {
                        address,
                        nullifier_key_commitment,
                        function_set_commitment,
                    } => {
                        let contract = decoded
                            .contract_body()
                            .expect("a contract result comes from a contract creation");
                        contract_material.push(ContractMaterialUpdate {
                            address: *address,
                            pcash_block_number: header.number,
                            pcash_block_hash: block_hash,
                            pcash_transaction_index: receipt.pcash_transaction_index,
                            transaction_id: receipt.tx_id,
                            timestamp: origin.block_timestamp,
                            nullifier_key_commitment: *nullifier_key_commitment,
                            account_rule_set_commitment: *function_set_commitment,
                            functions: contract
                                .functions
                                .iter()
                                .map(|function| ContractFunctionMaterial {
                                    selector: function.selector,
                                    application_vk_hash: function.application_vk_hash,
                                    configuration_commitment: function.configuration_commitment,
                                })
                                .collect(),
                            l1_block_number: origin.block_number,
                            l1_block_hash: origin.block_hash,
                            l1_transaction_index: receipt.l1_transaction_index,
                            l1_transaction_hash: receipt.l1_transaction_hash,
                            batch_item_index: receipt.batch_item_index,
                        });
                        (
                            *address,
                            account.revision(),
                            ReceiveMaterialUpdate {
                                key: contract.receive_key.as_deref().map(|key| key.to_vec()),
                            },
                        )
                    }
                };
                receive_material.push((address, revision, update));
            }
        }
        let block_row = IndexedBlockRow {
            hash: block_hash,
            output_count: boundary.state.state_components().output_count,
            l1_block_number: origin.block_number,
        };
        let l1_log_block = IndexedL1LogBlock {
            block_hash: origin.block_hash,
            block_timestamp: origin.block_timestamp,
            logs_root: origin.l1_logs_root,
            log_count: origin.l1_log_count,
        };
        let summary = DerivationSummaryRow::from_boundary(boundary);
        let previous = self.cursor()?;
        match (header.number, previous) {
            (0, None) if block_hash == genesis_hash => {}
            (0, _) => {
                return Err(StateError::Backend(
                    "derived index block zero is not the bound genesis".into(),
                ));
            }
            (number, Some(cursor))
                if cursor.chain_id == chain_id
                    && cursor.genesis_hash == genesis_hash
                    && cursor.pcash_number.checked_add(1) == Some(number)
                    && cursor.pcash_hash == header.parent_hash => {}
            _ => {
                return Err(StateError::Backend(
                    "derived index cursor does not equal the block parent".into(),
                ));
            }
        }

        let cursor = DerivedIndexCursor {
            chain_id,
            genesis_hash,
            pcash_number: header.number,
            pcash_hash: block_hash,
        };
        let (previous_succeeded, previous_failed, _) = self.transaction_totals()?;
        let total_succeeded = previous_succeeded
            .checked_add(summary.accepted_count)
            .ok_or_else(|| {
                StateError::Backend("derived successful transaction total overflow".into())
            })?;
        let total_failed = previous_failed
            .checked_add(summary.skipped_count)
            .ok_or_else(|| {
                StateError::Backend("derived failed transaction total overflow".into())
            })?;
        let mut write = self.db.begin_write().map_err(be)?;
        write
            .set_durability(if durable {
                Durability::Immediate
            } else {
                Durability::None
            })
            .map_err(be)?;
        {
            let mut blocks = write.open_table(T_BLOCKS).map_err(be)?;
            let key = origin.block_number.to_be_bytes();
            blocks
                .insert(key.as_slice(), summary.encode().as_slice())
                .map_err(be)?;
        }
        {
            let mut economics = write.open_table(T_BLOCK_ECONOMICS).map_err(be)?;
            let key = header.number.to_be_bytes();
            let value = BlockEconomicsRow::from_boundary(boundary).encode();
            economics
                .insert(key.as_slice(), value.as_slice())
                .map_err(be)?;
        }
        {
            let mut blocks = write.open_table(T_L1_LOG_BLOCKS).map_err(be)?;
            let key = l1_log_block_key(origin.block_number);
            blocks
                .insert(key.as_slice(), l1_log_block.encode().as_slice())
                .map_err(be)?;
        }
        {
            let mut logs = write.open_table(T_L1_LOGS).map_err(be)?;
            for (leaf_index, log) in l1_logs.logs.iter().enumerate() {
                let key = l1_log_key(origin.block_number, log.transaction_index, log.log_index);
                let value = IndexedL1Log {
                    leaf_index: leaf_index as u64,
                }
                .encode();
                logs.insert(key.as_slice(), value.as_slice()).map_err(be)?;
            }
        }
        {
            let mut nodes = write.open_table(T_L1_LOG_NODES).map_err(be)?;
            for (height, index, value) in l1_logs.tree_nodes() {
                let key = l1_log_node_key(origin.block_number, height, index);
                nodes.insert(key.as_slice(), value.as_slice()).map_err(be)?;
            }
        }
        {
            let mut receipts = write.open_table(T_RECEIPTS).map_err(be)?;
            let mut by_txid = write.open_table(T_RECEIPT_BY_TXID).map_err(be)?;
            let mut by_nullifier = write.open_table(T_RECEIPT_BY_NULLIFIER).map_err(be)?;
            let mut by_account = write.open_table(T_RECEIPT_BY_ACCOUNT).map_err(be)?;
            let mut by_content = write.open_table(T_RECEIPT_BY_CONTENT).map_err(be)?;
            let mut succeeded_by_content = write
                .open_table(T_SUCCEEDED_RECEIPT_BY_CONTENT)
                .map_err(be)?;
            let mut by_block_ordinal = write.open_table(T_RECEIPT_BY_BLOCK_ORDINAL).map_err(be)?;
            let mut by_kind_block_ordinal = write
                .open_table(T_RECEIPT_BY_KIND_BLOCK_ORDINAL)
                .map_err(be)?;
            let mut by_lifecycle = write
                .open_table(T_RECEIPT_BY_LIFECYCLE_ADDRESS)
                .map_err(be)?;
            for receipt in receipt_rows {
                let key = receipt_key(
                    receipt.l1_block_number,
                    receipt.l1_transaction_index,
                    receipt.batch_item_index,
                );
                let row = ReceiptRow {
                    pcash_transaction_index: receipt.pcash_transaction_index,
                    hash: receipt.l1_block_hash,
                    l1_transaction_hash: receipt.l1_transaction_hash,
                    content_hash: receipt.content_hash,
                    tx_id: receipt.tx_id,
                    outcome: receipt.outcome,
                    failure_detail: receipt.failure_detail.clone(),
                    l1_sender: receipt.l1_sender,
                    issuance_owner_commitment: receipt.issuance_owner_commitment,
                    settled_open_fee_amount: receipt.settled_open_fee_amount,
                    settled_issuance_amount: receipt.settled_issuance_amount,
                    has_open_fee: receipt.has_open_fee,
                    byte_size: receipt.byte_size,
                    kind: receipt.kind,
                    account_creation: receipt.account_creation,
                    lifecycle_address: receipt.lifecycle_address,
                    output_leaf_start: receipt.output_leaf_start,
                    outputs_added: receipt.outputs_added,
                    nullifiers: receipt.nullifiers.clone(),
                    account: receipt.account.clone(),
                };
                receipts
                    .insert(key.as_slice(), row.encode().as_slice())
                    .map_err(be)?;
                by_txid
                    .insert(receipt.tx_id.as_slice(), key.as_slice())
                    .map_err(be)?;
                by_content
                    .insert(
                        content_receipt_key(receipt.content_hash, &key).as_slice(),
                        b"".as_slice(),
                    )
                    .map_err(be)?;
                // Identical direct creations from different L1 senders can each
                // succeed; the pointer keeps the earliest canonical success.
                if receipt.accepted()
                    && succeeded_by_content
                        .get(receipt.content_hash.as_slice())
                        .map_err(be)?
                        .is_none()
                {
                    succeeded_by_content
                        .insert(receipt.content_hash.as_slice(), key.as_slice())
                        .map_err(be)?;
                }
                by_block_ordinal
                    .insert(
                        block_ordinal_key(header.number, receipt.pcash_transaction_index)
                            .as_slice(),
                        key.as_slice(),
                    )
                    .map_err(be)?;
                by_kind_block_ordinal
                    .insert(
                        kind_block_ordinal_key(
                            receipt.kind,
                            header.number,
                            receipt.pcash_transaction_index,
                        )
                        .as_slice(),
                        key.as_slice(),
                    )
                    .map_err(be)?;
                if let Some(address) = receipt.lifecycle_address {
                    by_lifecycle
                        .insert(
                            lifecycle_receipt_key(address, &key).as_slice(),
                            b"".as_slice(),
                        )
                        .map_err(be)?;
                }
                if let Some(nullifiers) = &receipt.nullifiers {
                    for nullifier in nullifiers {
                        by_nullifier
                            .insert(nullifier.as_slice(), key.as_slice())
                            .map_err(be)?;
                    }
                }
                if let Some(account) = &receipt.account {
                    by_account
                        .insert(
                            account_key(&account.address, account.account_revision).as_slice(),
                            key.as_slice(),
                        )
                        .map_err(be)?;
                }
            }
        }
        {
            let mut blocks = write.open_table(T_INDEXED_BLOCKS).map_err(be)?;
            blocks
                .insert(
                    pcash_block_key(header.number).as_slice(),
                    block_row.encode().as_slice(),
                )
                .map_err(be)?;
        }
        {
            let mut outputs = write.open_table(T_OUTPUTS).map_err(be)?;
            for output in &output_rows {
                outputs
                    .insert(
                        output_key(output.output_index).as_slice(),
                        output.encode().as_slice(),
                    )
                    .map_err(be)?;
            }
            for payout in &boundary.history.payouts {
                let transaction_id = payout.transaction_id(origin.block_hash);
                let row = IndexedOutputItem {
                    output_index: payout.output_index,
                    output_commitment: pcash_state::fr_to_bytes(payout.output_commitment()),
                    material: IndexedOutputMaterial::System {
                        transaction_id,
                        payout: payout.clone(),
                    },
                    pcash_block_number: header.number,
                    pcash_block_hash: block_hash,
                };
                outputs
                    .insert(
                        output_key(payout.output_index).as_slice(),
                        row.encode().as_slice(),
                    )
                    .map_err(be)?;
            }
        }
        let mut undo = IndexUndoRow::default();
        {
            let mut receive = write.open_table(T_RECEIVE_MATERIAL).map_err(be)?;
            for (address, revision, update) in &receive_material {
                let key = receive_material_key(address, *revision);
                receive
                    .insert(key.as_slice(), update.encode().as_slice())
                    .map_err(be)?;
                undo.receive_keys.push(key);
            }
        }
        {
            let mut contracts = write.open_table(T_CONTRACT_MATERIAL).map_err(be)?;
            let mut by_creation = write.open_table(T_CONTRACT_BY_CREATION).map_err(be)?;
            let mut source_info = write.open_table(T_CONTRACT_SOURCE_INFO).map_err(be)?;
            let mut verified_by_creation = write
                .open_table(T_VERIFIED_CONTRACT_BY_CREATION)
                .map_err(be)?;
            for update in &contract_material {
                contracts
                    .insert(update.address.as_slice(), update.encode().as_slice())
                    .map_err(be)?;
                let creation_key = contract_creation_key(
                    update.pcash_block_number,
                    update.pcash_transaction_index,
                );
                by_creation
                    .insert(creation_key.as_slice(), update.address.as_slice())
                    .map_err(be)?;
                write_contract_verification(
                    &mut source_info,
                    &mut verified_by_creation,
                    update,
                    verification
                        .and_then(|lookup| lookup.lookup(update.address, &update.functions)),
                )?;
                undo.contract_addresses.push(update.address);
            }
        }
        {
            let mut journals = write.open_table(T_INDEX_UNDO).map_err(be)?;
            journals
                .insert(
                    pcash_block_key(header.number).as_slice(),
                    undo.encode().as_slice(),
                )
                .map_err(be)?;
        }
        {
            let mut meta = write.open_table(T_META).map_err(be)?;
            meta.insert(M_CURSOR, cursor.encode().as_slice())
                .map_err(be)?;
            meta.insert(M_TOTAL_SUCCEEDED, total_succeeded.to_be_bytes().as_slice())
                .map_err(be)?;
            meta.insert(M_TOTAL_FAILED, total_failed.to_be_bytes().as_slice())
                .map_err(be)?;
        }
        write.commit().map_err(be)?;
        Ok(cursor)
    }

    /// Rewind every projection table and the canonical cursor to an exact PCASH
    /// block identity. A same-height replacement cannot be mistaken for the
    /// target because the retained block row must match the requested hash.
    pub fn rewind_to(&self, target: IndexBlockId) -> Result<(), StateError> {
        let current = self
            .cursor()?
            .ok_or_else(|| StateError::Backend("derived index has no cursor".into()))?;
        if target.number > current.pcash_number {
            return Err(StateError::Backend(
                "cannot rewind derived index beyond its cursor".into(),
            ));
        }
        let (previous_succeeded, previous_failed, _) = self.transaction_totals()?;
        let mut w = self.db.begin_write().map_err(be)?;
        w.set_durability(Durability::Immediate).map_err(be)?;
        let (retained_output_count, l1_cutoff) = {
            let blocks = w.open_table(T_INDEXED_BLOCKS).map_err(be)?;
            let key = pcash_block_key(target.number);
            let retained = blocks.get(key.as_slice()).map_err(be)?.ok_or_else(|| {
                StateError::Backend("rewind target is absent from the index".into())
            })?;
            let retained = IndexedBlockRow::decode(retained.value()).map_err(be)?;
            if retained.hash != target.hash {
                return Err(StateError::Backend(
                    "rewind target hash is not canonical in the index".into(),
                ));
            }
            (retained.output_count, retained.l1_block_number)
        };
        let stale_summaries: Vec<(u64, DerivationSummaryRow)> = {
            let blocks = w.open_table(T_BLOCKS).map_err(be)?;
            let first = (l1_cutoff + 1).to_be_bytes();
            blocks
                .range(first.as_slice()..)
                .map_err(be)?
                .map(|row| -> Result<(u64, DerivationSummaryRow), StateError> {
                    let (key, value) = row.map_err(be)?;
                    Ok((
                        block_of(key.value()),
                        DerivationSummaryRow::decode(value.value()).map_err(be)?,
                    ))
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        let stale_blocks: Vec<(u64, IndexedBlockRow)> = {
            let blocks = w.open_table(T_INDEXED_BLOCKS).map_err(be)?;
            let first = pcash_block_key(target.number + 1);
            blocks
                .range(first.as_slice()..)
                .map_err(be)?
                .map(|row| -> Result<(u64, IndexedBlockRow), StateError> {
                    let (key, value) = row.map_err(be)?;
                    Ok((
                        block_of(key.value()),
                        IndexedBlockRow::decode(value.value()).map_err(be)?,
                    ))
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        {
            let mut economics = w.open_table(T_BLOCK_ECONOMICS).map_err(be)?;
            let first = (target.number + 1).to_be_bytes();
            let stale = economics
                .range(first.as_slice()..)
                .map_err(be)?
                .map(|row| row.map(|(key, _)| key.value().to_vec()).map_err(be))
                .collect::<Result<Vec<_>, _>>()?;
            for key in stale {
                economics.remove(key.as_slice()).map_err(be)?;
            }
        }
        {
            let mut outputs = w.open_table(T_OUTPUTS).map_err(be)?;
            let first = output_key(retained_output_count);
            let last = output_key(u64::MAX);
            let stale = outputs
                .range(first.as_slice()..=last.as_slice())
                .map_err(be)?
                .map(|row| row.map(|(key, _)| key.value().to_vec()).map_err(be))
                .collect::<Result<Vec<_>, _>>()?;
            for key in stale {
                outputs.remove(key.as_slice()).map_err(be)?;
            }
        }
        {
            let mut blocks = w.open_table(T_BLOCKS).map_err(be)?;
            for (number, _) in &stale_summaries {
                blocks.remove(number.to_be_bytes().as_slice()).map_err(be)?;
            }
        }
        {
            let mut blocks = w.open_table(T_L1_LOG_BLOCKS).map_err(be)?;
            for (number, _) in &stale_summaries {
                blocks
                    .remove(l1_log_block_key(*number).as_slice())
                    .map_err(be)?;
            }
        }
        {
            let mut logs = w.open_table(T_L1_LOGS).map_err(be)?;
            for (number, _) in &stale_summaries {
                let first = l1_log_key(*number, 0, 0);
                let last = l1_log_key(*number, u64::MAX, u64::MAX);
                let keys = logs
                    .range(first.as_slice()..=last.as_slice())
                    .map_err(be)?
                    .map(|row| row.map(|(key, _)| key.value().to_vec()).map_err(be))
                    .collect::<Result<Vec<_>, _>>()?;
                for key in keys {
                    logs.remove(key.as_slice()).map_err(be)?;
                }
            }
        }
        {
            let mut nodes = w.open_table(T_L1_LOG_NODES).map_err(be)?;
            for (number, _) in &stale_summaries {
                let first = l1_log_node_key(*number, 0, 0);
                let last = l1_log_node_key(*number, u8::MAX, u64::MAX);
                let keys = nodes
                    .range(first.as_slice()..=last.as_slice())
                    .map_err(be)?
                    .map(|row| row.map(|(key, _)| key.value().to_vec()).map_err(be))
                    .collect::<Result<Vec<_>, _>>()?;
                for key in keys {
                    nodes.remove(key.as_slice()).map_err(be)?;
                }
            }
        }
        // Receipts also carry secondary index entries keyed by identifiers that
        // are not block-ordered, so each orphaned receipt's row must be read to
        // reconstruct and delete its index entries alongside the primary row.
        {
            let mut receipts = w.open_table(T_RECEIPTS).map_err(be)?;
            let stale: Vec<([u8; 24], ReceiptRow)> = {
                let first = receipt_key(l1_cutoff + 1, 0, 0);
                receipts
                    .range(first.as_slice()..)
                    .map_err(be)?
                    .map(|row| -> Result<([u8; 24], ReceiptRow), StateError> {
                        let (key, value) = row.map_err(be)?;
                        let pk: [u8; 24] = key
                            .value()
                            .try_into()
                            .map_err(|_| StateError::Backend("receipt key wrong length".into()))?;
                        Ok((pk, ReceiptRow::decode(value.value()).map_err(be)?))
                    })
                    .collect::<Result<Vec<_>, _>>()?
            };
            let mut by_txid = w.open_table(T_RECEIPT_BY_TXID).map_err(be)?;
            let mut by_nullifier = w.open_table(T_RECEIPT_BY_NULLIFIER).map_err(be)?;
            let mut by_account = w.open_table(T_RECEIPT_BY_ACCOUNT).map_err(be)?;
            let mut by_content = w.open_table(T_RECEIPT_BY_CONTENT).map_err(be)?;
            let mut succeeded_by_content =
                w.open_table(T_SUCCEEDED_RECEIPT_BY_CONTENT).map_err(be)?;
            let mut by_block_ordinal = w.open_table(T_RECEIPT_BY_BLOCK_ORDINAL).map_err(be)?;
            let mut by_kind_block_ordinal =
                w.open_table(T_RECEIPT_BY_KIND_BLOCK_ORDINAL).map_err(be)?;
            let mut by_lifecycle = w.open_table(T_RECEIPT_BY_LIFECYCLE_ADDRESS).map_err(be)?;
            let stale_number_by_l1: HashMap<u64, u64> = stale_blocks
                .iter()
                .map(|(number, block)| (block.l1_block_number, *number))
                .collect();
            for (pk, rr) in &stale {
                by_txid.remove(rr.tx_id.as_slice()).map_err(be)?;
                if let Some(nullifiers) = &rr.nullifiers {
                    for nullifier in nullifiers {
                        by_nullifier.remove(nullifier.as_slice()).map_err(be)?;
                    }
                }
                if let Some(account) = &rr.account {
                    by_account
                        .remove(account_key(&account.address, account.account_revision).as_slice())
                        .map_err(be)?;
                }
                if let Some(&number) = stale_number_by_l1.get(&block_of(pk)) {
                    by_content
                        .remove(content_receipt_key(rr.content_hash, pk).as_slice())
                        .map_err(be)?;
                    if rr.outcome.is_succeeded()
                        && succeeded_by_content
                            .get(rr.content_hash.as_slice())
                            .map_err(be)?
                            .is_some_and(|primary| primary.value() == pk.as_slice())
                    {
                        succeeded_by_content
                            .remove(rr.content_hash.as_slice())
                            .map_err(be)?;
                    }
                    by_block_ordinal
                        .remove(block_ordinal_key(number, rr.pcash_transaction_index).as_slice())
                        .map_err(be)?;
                    by_kind_block_ordinal
                        .remove(
                            kind_block_ordinal_key(rr.kind, number, rr.pcash_transaction_index)
                                .as_slice(),
                        )
                        .map_err(be)?;
                    if let Some(address) = rr.lifecycle_address {
                        by_lifecycle
                            .remove(lifecycle_receipt_key(address, pk).as_slice())
                            .map_err(be)?;
                    }
                }
                receipts.remove(pk.as_slice()).map_err(be)?;
            }
        }
        {
            let mut blocks = w.open_table(T_INDEXED_BLOCKS).map_err(be)?;
            let mut journals = w.open_table(T_INDEX_UNDO).map_err(be)?;
            let mut receive = w.open_table(T_RECEIVE_MATERIAL).map_err(be)?;
            let mut contracts = w.open_table(T_CONTRACT_MATERIAL).map_err(be)?;
            let mut contracts_by_creation = w.open_table(T_CONTRACT_BY_CREATION).map_err(be)?;
            let mut source_info = w.open_table(T_CONTRACT_SOURCE_INFO).map_err(be)?;
            let mut verified_by_creation =
                w.open_table(T_VERIFIED_CONTRACT_BY_CREATION).map_err(be)?;
            for (number, _) in stale_blocks.iter().rev() {
                let key = pcash_block_key(*number);
                let journal_bytes = journals
                    .get(key.as_slice())
                    .map_err(be)?
                    .ok_or_else(|| StateError::Backend("derived index undo row is missing".into()))?
                    .value()
                    .to_vec();
                let journal = IndexUndoRow::decode(&journal_bytes).map_err(be)?;
                for material_key in journal.receive_keys {
                    receive.remove(material_key.as_slice()).map_err(be)?;
                }
                for address in journal.contract_addresses {
                    let material = {
                        let stored =
                            contracts
                                .get(address.as_slice())
                                .map_err(be)?
                                .ok_or_else(|| {
                                    StateError::Backend(
                                        "derived contract material is missing during rewind".into(),
                                    )
                                })?;
                        ContractMaterialUpdate::decode(stored.value()).map_err(be)?
                    };
                    let creation_key = contract_creation_key(
                        material.pcash_block_number,
                        material.pcash_transaction_index,
                    );
                    contracts_by_creation
                        .remove(creation_key.as_slice())
                        .map_err(be)?;
                    verified_by_creation
                        .remove(creation_key.as_slice())
                        .map_err(be)?;
                    contracts.remove(address.as_slice()).map_err(be)?;
                    source_info.remove(address.as_slice()).map_err(be)?;
                }
                blocks.remove(key.as_slice()).map_err(be)?;
                journals.remove(key.as_slice()).map_err(be)?;
            }
        }
        {
            let mut meta = w.open_table(T_META).map_err(be)?;
            let cursor = DerivedIndexCursor {
                chain_id: current.chain_id,
                genesis_hash: current.genesis_hash,
                pcash_number: target.number,
                pcash_hash: target.hash,
            };
            meta.insert(M_CURSOR, cursor.encode().as_slice())
                .map_err(be)?;
            let underflow = || StateError::Backend("derived totals underflow during rewind".into());
            let mut total_succeeded = previous_succeeded;
            let mut total_failed = previous_failed;
            for (_, summary) in &stale_summaries {
                total_succeeded = total_succeeded
                    .checked_sub(summary.accepted_count)
                    .ok_or_else(underflow)?;
                total_failed = total_failed
                    .checked_sub(summary.skipped_count)
                    .ok_or_else(underflow)?;
            }
            meta.insert(M_TOTAL_SUCCEEDED, total_succeeded.to_be_bytes().as_slice())
                .map_err(be)?;
            meta.insert(M_TOTAL_FAILED, total_failed.to_be_bytes().as_slice())
                .map_err(be)?;
        }
        w.commit().map_err(be)?;
        Ok(())
    }

    /// Rebuild both verification tables from every stored contract material row.
    pub fn recompute_contract_verification(
        &self,
        verification: &dyn ContractVerificationLookup,
    ) -> Result<(), StateError> {
        let mut write = self.db.begin_write().map_err(be)?;
        write.set_durability(Durability::Immediate).map_err(be)?;
        {
            let mut source_info = write.open_table(T_CONTRACT_SOURCE_INFO).map_err(be)?;
            let mut verified_by_creation = write
                .open_table(T_VERIFIED_CONTRACT_BY_CREATION)
                .map_err(be)?;
            source_info.retain(|_, _| false).map_err(be)?;
            verified_by_creation.retain(|_, _| false).map_err(be)?;
            let contracts = write.open_table(T_CONTRACT_MATERIAL).map_err(be)?;
            for row in contracts.iter().map_err(be)? {
                let (_, stored) = row.map_err(be)?;
                let material = ContractMaterialUpdate::decode(stored.value()).map_err(be)?;
                let info = verification.lookup(material.address, &material.functions);
                write_contract_verification(
                    &mut source_info,
                    &mut verified_by_creation,
                    &material,
                    info,
                )?;
            }
        }
        write.commit().map_err(be)?;
        Ok(())
    }

    /// Refresh one contract's verification rows from the current registry snapshot.
    pub fn update_contract_verification(
        &self,
        address: Address,
        verification: &dyn ContractVerificationLookup,
    ) -> Result<(), StateError> {
        let mut write = self.db.begin_write().map_err(be)?;
        write.set_durability(Durability::Immediate).map_err(be)?;
        {
            let contracts = write.open_table(T_CONTRACT_MATERIAL).map_err(be)?;
            let material = contracts
                .get(address.as_slice())
                .map_err(be)?
                .map(|stored| ContractMaterialUpdate::decode(stored.value()).map_err(be))
                .transpose()?;
            drop(contracts);
            let Some(material) = material else {
                return Ok(());
            };
            let info = verification.lookup(address, &material.functions);
            let mut source_info = write.open_table(T_CONTRACT_SOURCE_INFO).map_err(be)?;
            let mut verified_by_creation = write
                .open_table(T_VERIFIED_CONTRACT_BY_CREATION)
                .map_err(be)?;
            write_contract_verification(
                &mut source_info,
                &mut verified_by_creation,
                &material,
                info,
            )?;
        }
        write.commit().map_err(be)?;
        Ok(())
    }
}

impl<D: IndexReadSource> IndexStore<D> {
    pub fn cursor(&self) -> Result<Option<DerivedIndexCursor>, StateError> {
        let read = self.db.read_transaction()?;
        let meta = read.open_table(T_META).map_err(be)?;
        let Some(value) = meta.get(M_CURSOR).map_err(be)? else {
            return Ok(None);
        };
        DerivedIndexCursor::decode(value.value())
            .map(Some)
            .map_err(be)
    }

    /// Up to `max_rows` consecutive block economics rows starting at PCASH
    /// block `from`, in block order. Rows stop at the indexed head.
    pub fn block_economics_from(
        &self,
        from: u64,
        max_rows: usize,
    ) -> Result<Vec<(u64, BlockEconomicsRow)>, StateError> {
        let read = self.db.read_transaction()?;
        let table = match read.open_table(T_BLOCK_ECONOMICS) {
            Ok(table) => table,
            Err(TableError::TableDoesNotExist(_)) => return Ok(Vec::new()),
            Err(error) => return Err(be(error)),
        };
        let first = from.to_be_bytes();
        table
            .range(first.as_slice()..)
            .map_err(be)?
            .take(max_rows)
            .map(|row| -> Result<(u64, BlockEconomicsRow), StateError> {
                let (key, value) = row.map_err(be)?;
                Ok((
                    block_of(key.value()),
                    BlockEconomicsRow::decode(value.value()).map_err(be)?,
                ))
            })
            .collect()
    }

    pub fn transaction_totals(&self) -> Result<(u64, u64, u64), StateError> {
        let read = self.db.read_transaction()?;
        let meta = read.open_table(T_META).map_err(be)?;
        let read_counter = |key: &str| -> Result<u64, StateError> {
            let value = meta
                .get(key)
                .map_err(be)?
                .ok_or_else(|| StateError::Backend(format!("derived index has no {key} row")))?;
            let bytes: [u8; 8] = value
                .value()
                .try_into()
                .map_err(|_| StateError::Backend(format!("derived {key} is malformed")))?;
            Ok(u64::from_be_bytes(bytes))
        };
        let succeeded = read_counter(M_TOTAL_SUCCEEDED)?;
        let failed = read_counter(M_TOTAL_FAILED)?;
        let total = succeeded
            .checked_add(failed)
            .ok_or_else(|| StateError::Backend("derived transaction total overflow".into()))?;
        Ok((succeeded, failed, total))
    }

    pub(super) fn identity(&self) -> Result<(u32, B256), StateError> {
        let read = self.db.read_transaction()?;
        let meta = read.open_table(T_META).map_err(be)?;
        let chain = meta
            .get(M_CHAIN_ID)
            .map_err(be)?
            .ok_or_else(|| StateError::Backend("derived index identity is not bound".into()))?;
        let genesis = meta
            .get(M_GENESIS_HASH)
            .map_err(be)?
            .ok_or_else(|| StateError::Backend("derived index identity is not bound".into()))?;
        let chain_id = u32::from_be_bytes(
            chain
                .value()
                .try_into()
                .map_err(|_| StateError::Backend("derived index chain id is malformed".into()))?,
        );
        let genesis_bytes: [u8; 32] = genesis
            .value()
            .try_into()
            .map_err(|_| StateError::Backend("derived index genesis hash is malformed".into()))?;
        let genesis_hash = B256::from(genesis_bytes);
        Ok((chain_id, genesis_hash))
    }

    pub fn l1_log_proof(
        &self,
        block_number: u64,
        transaction_index: u64,
        log_index: u64,
    ) -> Result<Option<IndexedL1LogProof>, StateError> {
        let read = self.db.read_transaction()?;
        let blocks = read.open_table(T_L1_LOG_BLOCKS).map_err(be)?;
        let block_key = l1_log_block_key(block_number);
        let block_value = blocks
            .get(block_key.as_slice())
            .map_err(be)?
            .ok_or_else(|| {
                StateError::Backend("normalized L1 log block metadata is missing".into())
            })?;
        let block = IndexedL1LogBlock::decode(block_value.value()).map_err(be)?;

        let logs = read.open_table(T_L1_LOGS).map_err(be)?;
        let log_key = l1_log_key(block_number, transaction_index, log_index);
        let Some(log_value) = logs.get(log_key.as_slice()).map_err(be)? else {
            return Ok(None);
        };
        let log = IndexedL1Log::decode(log_value.value()).map_err(be)?;

        let nodes = read.open_table(T_L1_LOG_NODES).map_err(be)?;
        let empty = pcash_l1::normalized_log_empty_nodes();
        let mut siblings = Vec::with_capacity(pcash_l1::NORMALIZED_LOG_TREE_DEPTH);
        for (height, empty_sibling) in empty
            .iter()
            .copied()
            .enumerate()
            .take(pcash_l1::NORMALIZED_LOG_TREE_DEPTH)
        {
            let sibling_index = (log.leaf_index >> height) ^ 1;
            let key = l1_log_node_key(block_number, height as u8, sibling_index);
            let stored = nodes.get(key.as_slice()).map_err(be)?;
            let sibling_start = sibling_index.checked_shl(height as u32).ok_or_else(|| {
                StateError::Backend("normalized L1 log node index overflow".into())
            })?;
            let sibling_has_logs = sibling_start < block.log_count;
            let value = match stored {
                Some(value) if sibling_has_logs => {
                    let bytes: [u8; 32] = value.value().try_into().map_err(|_| {
                        StateError::Backend("normalized L1 log node is malformed".into())
                    })?;
                    B256::from(bytes)
                }
                Some(_) => {
                    return Err(StateError::Backend(
                        "normalized L1 log tree contains an unexpected node".into(),
                    ));
                }
                None if sibling_has_logs => {
                    return Err(StateError::Backend(
                        "normalized L1 log tree is missing a required node".into(),
                    ));
                }
                None => empty_sibling,
            };
            siblings.push(value);
        }

        Ok(Some(IndexedL1LogProof {
            block_number,
            block_hash: block.block_hash,
            block_timestamp: block.block_timestamp,
            logs_root: block.logs_root,
            log_count: block.log_count,
            leaf_index: log.leaf_index,
            transaction_index,
            log_index,
            siblings,
        }))
    }

    pub(super) fn indexed_block(&self, number: u64) -> Result<Option<IndexedBlockRow>, StateError> {
        let read = self.db.read_transaction()?;
        let table = match read.open_table(T_INDEXED_BLOCKS) {
            Ok(table) => table,
            Err(TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(error) => return Err(be(error)),
        };
        let key = pcash_block_key(number);
        let Some(value) = table.get(key.as_slice()).map_err(be)? else {
            return Ok(None);
        };
        IndexedBlockRow::decode(value.value()).map(Some).map_err(be)
    }

    /// The derived-block summary at an exact L1 block number, or `None` if that
    /// block has not been derived. A new index with no block table also yields
    /// `None`.
    pub fn get_block(&self, l1_number: u64) -> Result<Option<DerivationSummary>, StateError> {
        let r = self.db.read_transaction()?;
        let t = match r.open_table(T_BLOCKS) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(e) => return Err(be(e)),
        };
        let key = l1_number.to_be_bytes();
        let Some(value) = t.get(key.as_slice()).map_err(be)? else {
            return Ok(None);
        };
        let row = DerivationSummaryRow::decode(value.value()).map_err(be)?;
        Ok(Some(DerivationSummary {
            pcash_number: row.pcash_number,
            l1_number,
            l1_hash: B256::from(row.l1_hash),
            timestamp: row.timestamp,
            state_root: row.state_root,
            block_hash: row.block_hash,
            accepted_count: row.accepted_count,
            skipped_count: row.skipped_count,
            payout_notes: row.payout_notes,
        }))
    }
}
