//! Node-local storage for the optional generic publication catalog.

#![allow(
    clippy::expect_used,
    reason = "catalog tables are validated during construction"
)]
//!
//! This database is not consensus state, derived state, or P2P state. It is not
//! rolled back on reorgs, not replaced during state resync, and not required by any
//! PCASH operation. The node stores opaque payload bytes keyed by an immutable
//! content ID; it never parses a payload.
//!
//! The store is append-only: no update, no delete, no expiry. A record's
//! presence therefore says nothing about whether the thing it describes is still
//! live — that is the application's job to determine from its own data. A full
//! store rejects new records until an operator raises the limit or removes the
//! database, which is safe because the catalog is expendable.
//!
//! Every operation here is synchronous redb work that may scan the whole store,
//! so callers run it on a blocking worker. Nothing in this module touches
//! [`crate::NodeInner`] or its consensus lock.

use std::collections::BTreeSet;
use std::fmt;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use alloy_primitives::B256;
use redb::{Database, Durability, ReadableDatabase, ReadableTable, TableDefinition};

pub use pcash_rpc::catalog::{
    catalog_content_id, namespace_is_valid, CatalogApiError, CatalogArtifact, CatalogGetRequest,
    CatalogInfo, CatalogLimits, CatalogListRequest, CatalogPage, CatalogRecord, CatalogStatus,
    DEFAULT_CATALOG_NAMESPACES,
};

const T_META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
const T_RECORDS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("records");

const META_KEY: &str = "catalog";
/// `u32_be(pcashChainId) || genesisHash[32]`.
const META_LEN: usize = 4 + 32;

/// Derive `state.catalog.redb` from `state.redb`, preserving distinct prefixes
/// when one directory holds more than one state database.
pub fn catalog_path_for(state_path: &Path) -> PathBuf {
    state_path.with_extension("catalog.redb")
}

fn storage(error: impl fmt::Display) -> CatalogApiError {
    CatalogApiError::Storage(error.to_string())
}

fn validate_catalog_schema(db: &Database) -> Result<(), CatalogApiError> {
    crate::redb_schema::require_tables(db, &["meta", "records"])
        .map_err(|_| storage("incompatible catalog table schema"))?;
    let read = db.begin_read().map_err(storage)?;
    let meta = read.open_table(T_META).map_err(storage)?;
    let keys = meta
        .iter()
        .map_err(storage)?
        .map(|row| row.map(|(key, _)| key.value().to_owned()).map_err(storage))
        .collect::<Result<Vec<_>, _>>()?;
    crate::redb_schema::require_meta_keys(keys, &[&[META_KEY.as_bytes()]])
        .map_err(|_| storage("incompatible catalog metadata schema"))?;
    Ok(())
}

fn invalid(message: impl Into<String>) -> CatalogApiError {
    CatalogApiError::Invalid(message.into())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Record key: `u16_be(namespaceLen) || namespace || contentId`.
///
/// The length prefix is what keeps one namespace's key range from absorbing
/// another whose name it prefixes (`a` vs `a.b`), so a single-namespace range
/// scan is exact.
fn account_key(namespace: &str, content_id: &B256) -> Vec<u8> {
    let mut key = namespace_prefix(namespace);
    key.extend_from_slice(content_id.as_slice());
    key
}

fn namespace_prefix(namespace: &str) -> Vec<u8> {
    let bytes = namespace.as_bytes();
    let mut key = Vec::with_capacity(2 + bytes.len() + 32);
    key.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    key.extend_from_slice(bytes);
    key
}

/// Record value: `u64_be(createdAt) || payload`. Payload bytes are stored
/// exactly as published, with no JSON transcoding.
fn encode_value(created_at: u64, payload: &[u8]) -> Vec<u8> {
    let mut value = Vec::with_capacity(8 + payload.len());
    value.extend_from_slice(&created_at.to_be_bytes());
    value.extend_from_slice(payload);
    value
}

fn decode_value(value: &[u8]) -> Result<(u64, &[u8]), CatalogApiError> {
    let (created, payload) = value
        .split_at_checked(8)
        .ok_or_else(|| storage("catalog record value is truncated"))?;
    let created_at = u64::from_be_bytes(
        created
            .try_into()
            .expect("split_at_checked(8) yields 8 bytes"),
    );
    Ok((created_at, payload))
}

fn content_id_from_key(key: &[u8]) -> Result<B256, CatalogApiError> {
    key.get(key.len().saturating_sub(32)..)
        .and_then(|tail| B256::try_from(tail).ok())
        .ok_or_else(|| storage("catalog record key is truncated"))
}

/// The configured allowlist: normalized, sorted, and non-empty.
///
/// An explicit list *replaces* the defaults, so an operator who wants them
/// lists them. Duplicates and an explicitly empty list are rejected rather
/// than silently collapsed.
pub fn resolve_namespaces(configured: &[String]) -> Result<Vec<String>, String> {
    if configured.is_empty() {
        let mut defaults = DEFAULT_CATALOG_NAMESPACES.map(str::to_owned).to_vec();
        defaults.sort();
        return Ok(defaults);
    }
    let mut seen = BTreeSet::new();
    for namespace in configured {
        if !namespace_is_valid(namespace) {
            return Err(format!(
                "catalog namespace {namespace:?} must match [a-z0-9][a-z0-9._-]{{0,63}}"
            ));
        }
        if !seen.insert(namespace.clone()) {
            return Err(format!("catalog namespace {namespace:?} is listed twice"));
        }
    }
    Ok(seen.into_iter().collect())
}

/// How much of the store is occupied, in records and in raw payload bytes.
///
/// Held in memory rather than in a table row. redb takes an exclusive lock on
/// the file, so this process is the only writer and the count cannot drift
/// behind our back; a stale count would not survive a restart either, because
/// [`scan_usage`] recomputes it on every open. Persisting it would add a schema
/// persisted row and a second invariant to keep in sync with no benefit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CatalogUsage {
    records: usize,
    payload_bytes: usize,
}

/// Count the whole store once. Called only from [`CatalogStore::open`]; every
/// later change is applied incrementally.
fn scan_usage(db: &Database) -> Result<CatalogUsage, CatalogApiError> {
    let read = db.begin_read().map_err(storage)?;
    let table = match read.open_table(T_RECORDS) {
        Ok(table) => table,
        Err(redb::TableError::TableDoesNotExist(_)) => {
            return Err(storage("catalog records table is missing"));
        }
        Err(error) => return Err(storage(error)),
    };

    let mut usage = CatalogUsage::default();
    for row in table.iter().map_err(storage)? {
        let (_, value) = row.map_err(storage)?;
        let (_, payload) = decode_value(value.value())?;
        usage.records += 1;
        usage.payload_bytes = usage
            .payload_bytes
            .checked_add(payload.len())
            .ok_or_else(|| storage("catalog byte count overflow"))?;
    }
    Ok(usage)
}

/// The persistent record store over a dedicated sibling redb file.
pub struct CatalogStore {
    db: Database,
    pcash_chain_id: u32,
    namespaces: Vec<String>,
    limits: CatalogLimits,
    /// Guards the publish path. redb already serializes writers; taking this
    /// before `begin_write` and holding it past `commit` extends that same
    /// serialization to the counter, so no publish can read an occupancy that
    /// another publish has already committed but not yet accounted for.
    usage: Mutex<CatalogUsage>,
}

impl CatalogStore {
    /// Open (or create) the catalog and bind it to this node's identity.
    ///
    /// The stored metadata pins the full PCASH chain identity — chain id *and*
    /// genesis hash — even though records only carry the chain id. That is an
    /// operator-facing guard: a node re-anchored under the same chain id will
    /// refuse that database rather than silently serve records from a chain
    /// that no longer exists. A mismatched or malformed database is an error and
    /// is left untouched, never deleted or rewritten.
    pub fn open(
        path: impl AsRef<Path>,
        pcash_chain_id: u32,
        genesis_hash: B256,
        namespaces: Vec<String>,
        limits: CatalogLimits,
    ) -> Result<Self, CatalogApiError> {
        let path = path.as_ref();
        let existed = path.exists();
        let db = Database::create(path).map_err(storage)?;
        Self::open_database(
            db,
            existed,
            pcash_chain_id,
            genesis_hash,
            namespaces,
            limits,
        )
    }

    pub fn open_in_memory(
        pcash_chain_id: u32,
        genesis_hash: B256,
        namespaces: Vec<String>,
        limits: CatalogLimits,
    ) -> Result<Self, CatalogApiError> {
        let db = Database::builder()
            .create_with_backend(redb::backends::InMemoryBackend::new())
            .map_err(storage)?;
        Self::open_database(db, false, pcash_chain_id, genesis_hash, namespaces, limits)
    }

    fn open_database(
        db: Database,
        existed: bool,
        pcash_chain_id: u32,
        genesis_hash: B256,
        namespaces: Vec<String>,
        limits: CatalogLimits,
    ) -> Result<Self, CatalogApiError> {
        let existing = if existed {
            validate_catalog_schema(&db)?;
            let read = db.begin_read().map_err(storage)?;
            let table = read.open_table(T_META).map_err(storage)?;
            Some(
                table
                    .get(META_KEY)
                    .map_err(storage)?
                    .ok_or_else(|| storage("catalog metadata row is missing"))?
                    .value()
                    .to_vec(),
            )
        } else {
            None
        };

        if let Some(bytes) = existing {
            if bytes.len() != META_LEN {
                return Err(storage("catalog metadata row is malformed"));
            }
            let chain_id = u32::from_be_bytes(bytes[0..4].try_into().expect("4 bytes"));
            let genesis = B256::from_slice(&bytes[4..36]);
            if chain_id != pcash_chain_id || genesis != genesis_hash {
                return Err(storage(format!(
                    "catalog belongs to PCASH chain {chain_id}/0x{} but this node is {pcash_chain_id}/0x{}",
                    hex::encode(genesis),
                    hex::encode(genesis_hash),
                )));
            }
        } else {
            let mut value = Vec::with_capacity(META_LEN);
            value.extend_from_slice(&pcash_chain_id.to_be_bytes());
            value.extend_from_slice(genesis_hash.as_slice());

            let mut write = db.begin_write().map_err(storage)?;
            write
                .set_durability(Durability::Immediate)
                .map_err(storage)?;
            {
                let mut meta = write.open_table(T_META).map_err(storage)?;
                meta.insert(META_KEY, value.as_slice()).map_err(storage)?;
                write.open_table(T_RECORDS).map_err(storage)?;
            }
            write.commit().map_err(storage)?;
        }

        let usage = scan_usage(&db)?;

        Ok(Self {
            db,
            pcash_chain_id,
            namespaces,
            limits,
            usage: Mutex::new(usage),
        })
    }

    fn allows(&self, namespace: &str) -> bool {
        self.namespaces.iter().any(|allowed| allowed == namespace)
    }

    /// Validate the namespace of an incoming request: syntax first, then policy.
    fn check_namespace(&self, namespace: &str) -> Result<(), CatalogApiError> {
        if !namespace_is_valid(namespace) {
            return Err(invalid("namespace must match [a-z0-9][a-z0-9._-]{0,63}"));
        }
        if !self.allows(namespace) {
            return Err(invalid(format!(
                "namespace {namespace:?} is not configured on this node"
            )));
        }
        Ok(())
    }

    fn record_from_row(
        &self,
        namespace: &str,
        key: &[u8],
        value: &[u8],
    ) -> Result<CatalogRecord, CatalogApiError> {
        let (created_at, payload) = decode_value(value)?;
        Ok(CatalogRecord {
            artifact: CatalogArtifact {
                namespace: namespace.to_owned(),
                pcash_chain_id: self.pcash_chain_id,
                content_id: content_id_from_key(key)?,
                payload: payload.to_vec().into(),
            },
            created_at,
        })
    }

    /// The creation time of an already-stored record with this exact key, or `None`.
    fn stored_created_at(&self, key: &[u8]) -> Result<Option<u64>, CatalogApiError> {
        let read = self.db.begin_read().map_err(storage)?;
        let table = match read.open_table(T_RECORDS) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(error) => return Err(storage(error)),
        };
        match table.get(key).map_err(storage)? {
            Some(value) => Ok(Some(decode_value(value.value())?.0)),
            None => Ok(None),
        }
    }

    /// One record by content ID, or `None` when the namespace holds no such
    /// record.
    pub fn get(
        &self,
        request: &CatalogGetRequest,
    ) -> Result<Option<CatalogRecord>, CatalogApiError> {
        self.check_namespace(&request.namespace)?;
        let key = account_key(&request.namespace, &request.content_id);

        let read = self.db.begin_read().map_err(storage)?;
        let table = match read.open_table(T_RECORDS) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(error) => return Err(storage(error)),
        };
        match table.get(key.as_slice()).map_err(storage)? {
            Some(value) => Ok(Some(self.record_from_row(
                &request.namespace,
                key.as_slice(),
                value.value(),
            )?)),
            None => Ok(None),
        }
    }

    /// One page of records for a namespace, ordered by content ID.
    pub fn list(&self, request: &CatalogListRequest) -> Result<CatalogPage, CatalogApiError> {
        self.check_namespace(&request.namespace)?;
        if request.limit == 0 {
            return Err(invalid("limit must be at least 1"));
        }
        let limit = request.limit.min(self.limits.max_page_items);

        let prefix = namespace_prefix(&request.namespace);
        let mut low = prefix.clone();
        low.extend_from_slice(request.cursor.unwrap_or(B256::ZERO).as_slice());
        let mut high = prefix;
        high.extend_from_slice(&[0xffu8; 32]);
        // The cursor is an exclusive lower bound and need not exist, so a caller
        // may resume from any content ID.
        let start = match request.cursor {
            Some(_) => Bound::Excluded(low.as_slice()),
            None => Bound::Included(low.as_slice()),
        };

        let read = self.db.begin_read().map_err(storage)?;
        let table = match read.open_table(T_RECORDS) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => {
                return Ok(CatalogPage {
                    items: Vec::new(),
                    next_cursor: None,
                })
            }
            Err(error) => return Err(storage(error)),
        };

        let mut items: Vec<CatalogRecord> = Vec::new();
        let mut page_bytes = 0usize;
        let mut more = false;
        for row in table
            .range::<&[u8]>((start, Bound::Included(high.as_slice())))
            .map_err(storage)?
        {
            let (key, value) = row.map_err(storage)?;
            let (_, payload) = decode_value(value.value())?;
            // Stop *before* exceeding either bound. The per-record ceiling is
            // below the page ceiling, so the first record always fits.
            if items.len() >= limit
                || (!items.is_empty()
                    && page_bytes.saturating_add(payload.len())
                        > self.limits.max_page_payload_bytes)
            {
                more = true;
                break;
            }
            page_bytes = page_bytes.saturating_add(payload.len());
            items.push(self.record_from_row(&request.namespace, key.value(), value.value())?);
        }

        let next_cursor = if more {
            items.last().map(|item| item.artifact.content_id)
        } else {
            None
        };
        Ok(CatalogPage { items, next_cursor })
    }

    /// Store one artifact, or return the existing record unchanged.
    pub fn publish(&self, artifact: &CatalogArtifact) -> Result<CatalogRecord, CatalogApiError> {
        self.publish_at(artifact, now_unix())
    }

    pub(crate) fn publish_at(
        &self,
        artifact: &CatalogArtifact,
        now: u64,
    ) -> Result<CatalogRecord, CatalogApiError> {
        // Cheap framing first, so a malformed request never reaches storage.
        self.check_namespace(&artifact.namespace)?;
        if artifact.pcash_chain_id != self.pcash_chain_id {
            return Err(invalid("record is bound to a different PCASH chain id"));
        }
        if artifact.payload.len() > self.limits.max_payload_bytes {
            return Err(invalid(format!(
                "payload exceeds {} bytes",
                self.limits.max_payload_bytes
            )));
        }
        let expected = catalog_content_id(
            &artifact.namespace,
            artifact.pcash_chain_id,
            &artifact.payload,
        );
        if expected != artifact.content_id {
            return Err(invalid("contentId does not match the artifact"));
        }

        let key = account_key(&artifact.namespace, &artifact.content_id);

        // Republishing identical content is a no-op, so it never needs a write
        // transaction. `createdAt` keeps its original value, which is what makes
        // it mean "when this first appeared" rather than "last touched".
        if let Some(created_at) = self.stored_created_at(&key)? {
            return Ok(CatalogRecord {
                artifact: artifact.clone(),
                created_at,
            });
        }

        // Taken before the write transaction and held past the commit, so the
        // occupancy read below cannot miss a record another publish has already
        // stored. See [`CatalogStore::usage`].
        let mut usage = self.usage.lock().expect("catalog usage mutex is poisoned");

        let mut write = self.db.begin_write().map_err(storage)?;
        write
            .set_durability(Durability::Immediate)
            .map_err(storage)?;

        // Re-check inside the transaction: two concurrent publishes of the same
        // content must still produce one record with one creation time.
        let raced = {
            let table = write.open_table(T_RECORDS).map_err(storage)?;
            let found = match table.get(key.as_slice()).map_err(storage)? {
                Some(value) => Some(decode_value(value.value())?.0),
                None => None,
            };
            found
        };
        if let Some(created_at) = raced {
            write.abort().map_err(storage)?;
            return Ok(CatalogRecord {
                artifact: artifact.clone(),
                created_at,
            });
        }

        // Occupancy is read from the running counters rather than by scanning the
        // records table. Publishing is unauthenticated, so a per-request scan
        // would let a filling attacker impose the whole store's size on every
        // one of the requests that fills it, all of it serialized behind redb's
        // single write lock.
        if usage.records >= self.limits.max_records {
            return Err(CatalogApiError::Exhausted(format!(
                "catalog holds {} records",
                self.limits.max_records
            )));
        }
        let projected = usage
            .payload_bytes
            .checked_add(artifact.payload.len())
            .ok_or_else(|| storage("catalog byte count overflow"))?;
        if projected > self.limits.max_aggregate_payload_bytes {
            return Err(CatalogApiError::Exhausted(format!(
                "catalog payloads would exceed {} bytes",
                self.limits.max_aggregate_payload_bytes
            )));
        }

        let created_at = now;
        {
            let mut table = write.open_table(T_RECORDS).map_err(storage)?;
            table
                .insert(
                    key.as_slice(),
                    encode_value(created_at, &artifact.payload).as_slice(),
                )
                .map_err(storage)?;
        }
        write.commit().map_err(storage)?;

        // Only after the commit: a failed commit stores nothing, so it must not
        // consume occupancy either.
        usage.records += 1;
        usage.payload_bytes = projected;

        Ok(CatalogRecord {
            artifact: artifact.clone(),
            created_at,
        })
    }
}

/// The optional service the RPC layer talks to.
///
/// Holds the configured policy and this node's chain id regardless of whether
/// storage came up, so `pcash_catalogInfo` can always answer without touching
/// consensus state.
pub struct CatalogService {
    store: Option<CatalogStore>,
    /// Cleared by the first storage failure so `pcash_catalogInfo` stops
    /// advertising a store that is not actually serving.
    healthy: AtomicBool,
    enabled: bool,
    pcash_chain_id: u32,
    namespaces: Vec<String>,
    limits: CatalogLimits,
}

impl CatalogService {
    /// The service an operator gets without `--enable-catalog`: no database is
    /// opened or created, but the policy that *would* apply is still reported.
    pub fn disabled(pcash_chain_id: u32, namespaces: Vec<String>) -> Self {
        Self {
            store: None,
            healthy: AtomicBool::new(false),
            enabled: false,
            pcash_chain_id,
            namespaces,
            limits: CatalogLimits::default(),
        }
    }

    /// Open the catalog. A failure here is contained: the node starts normally
    /// and the service reports `unavailable`.
    pub fn open(
        path: impl AsRef<Path>,
        pcash_chain_id: u32,
        genesis_hash: B256,
        namespaces: Vec<String>,
    ) -> Self {
        let limits = CatalogLimits::default();
        let path = path.as_ref();
        match CatalogStore::open(
            path,
            pcash_chain_id,
            genesis_hash,
            namespaces.clone(),
            limits,
        ) {
            Ok(store) => {
                tracing::info!(
                    path = %path.display(),
                    namespaces = ?namespaces,
                    "publication catalog enabled"
                );
                Self {
                    store: Some(store),
                    healthy: AtomicBool::new(true),
                    enabled: true,
                    pcash_chain_id,
                    namespaces,
                    limits,
                }
            }
            Err(error) => {
                // The operator diagnostic belongs in the log; the RPC surface
                // reports only `unavailable`, with no path or internal detail.
                tracing::error!(
                    path = %path.display(),
                    %error,
                    "publication catalog could not be opened; continuing with it unavailable"
                );
                Self {
                    store: None,
                    healthy: AtomicBool::new(false),
                    enabled: true,
                    pcash_chain_id,
                    namespaces,
                    limits,
                }
            }
        }
    }

    pub fn open_in_memory(
        pcash_chain_id: u32,
        genesis_hash: B256,
        namespaces: Vec<String>,
    ) -> Self {
        let limits = CatalogLimits::default();
        match CatalogStore::open_in_memory(pcash_chain_id, genesis_hash, namespaces.clone(), limits)
        {
            Ok(store) => {
                tracing::info!(namespaces = ?namespaces, "in-memory publication catalog enabled");
                Self {
                    store: Some(store),
                    healthy: AtomicBool::new(true),
                    enabled: true,
                    pcash_chain_id,
                    namespaces,
                    limits,
                }
            }
            Err(error) => {
                tracing::error!(%error, "in-memory publication catalog unavailable");
                Self {
                    store: None,
                    healthy: AtomicBool::new(false),
                    enabled: true,
                    pcash_chain_id,
                    namespaces,
                    limits,
                }
            }
        }
    }

    pub fn status(&self) -> CatalogStatus {
        if !self.enabled {
            CatalogStatus::Disabled
        } else if self.store.is_some() && self.healthy.load(Ordering::Relaxed) {
            CatalogStatus::Available
        } else {
            CatalogStatus::Unavailable
        }
    }

    pub fn info(&self) -> CatalogInfo {
        CatalogInfo {
            status: self.status(),
            pcash_chain_id: self.pcash_chain_id,
            namespaces: self.namespaces.clone(),
            limits: self.limits,
        }
    }

    fn store(&self) -> Result<&CatalogStore, CatalogApiError> {
        match (&self.store, self.healthy.load(Ordering::Relaxed)) {
            (Some(store), true) => Ok(store),
            _ => Err(CatalogApiError::Unavailable),
        }
    }

    /// Storage failures take the catalog out of service without affecting any
    /// other RPC; everything else leaves health alone.
    fn record_outcome<T>(&self, result: Result<T, CatalogApiError>) -> Result<T, CatalogApiError> {
        if let Err(CatalogApiError::Storage(message)) = &result {
            if self.healthy.swap(false, Ordering::Relaxed) {
                tracing::error!(%message, "publication catalog storage failed; marking it unavailable");
            }
        }
        result
    }

    pub fn get(
        &self,
        request: &CatalogGetRequest,
    ) -> Result<Option<CatalogRecord>, CatalogApiError> {
        self.record_outcome(self.store()?.get(request))
    }

    pub fn list(&self, request: &CatalogListRequest) -> Result<CatalogPage, CatalogApiError> {
        self.record_outcome(self.store()?.list(request))
    }

    pub fn publish(&self, artifact: &CatalogArtifact) -> Result<CatalogRecord, CatalogApiError> {
        self.record_outcome(self.store()?.publish(artifact))
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;
    use pcash_rpc::catalog::{MARKETPLACE_NAMESPACE, TOKENS_DROP_NAMESPACE};

    const CHAIN: u32 = 1;
    const GENESIS: B256 = B256::repeat_byte(0x5a);

    #[test]
    fn in_memory_catalog_uses_the_persistent_schema() {
        let store = CatalogStore::open_in_memory(
            CHAIN,
            GENESIS,
            vec![MARKETPLACE_NAMESPACE.to_owned()],
            CatalogLimits::default(),
        )
        .unwrap();
        validate_catalog_schema(&store.db).unwrap();
    }

    fn store_with(dir: &Path, limits: CatalogLimits, namespaces: Vec<String>) -> CatalogStore {
        CatalogStore::open(
            dir.join("state.catalog.redb"),
            CHAIN,
            GENESIS,
            namespaces,
            limits,
        )
        .unwrap()
    }

    fn store(dir: &Path) -> CatalogStore {
        store_with(
            dir,
            CatalogLimits::default(),
            vec![MARKETPLACE_NAMESPACE.to_owned()],
        )
    }

    fn artifact(namespace: &str, payload: &[u8]) -> CatalogArtifact {
        CatalogArtifact::new(namespace.to_owned(), CHAIN, payload.to_vec())
    }

    fn offer(payload: &[u8]) -> CatalogArtifact {
        artifact(MARKETPLACE_NAMESPACE, payload)
    }

    fn list_all(store: &CatalogStore) -> Vec<CatalogRecord> {
        let mut cursor = None;
        let mut all = Vec::new();
        loop {
            let page = store
                .list(&CatalogListRequest {
                    namespace: MARKETPLACE_NAMESPACE.to_owned(),
                    cursor,
                    limit: 50,
                })
                .unwrap();
            all.extend(page.items);
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => return all,
            }
        }
    }

    #[test]
    fn derives_a_distinct_sibling_path() {
        assert_eq!(
            catalog_path_for(Path::new("/tmp/demo/state.redb")),
            Path::new("/tmp/demo/state.catalog.redb")
        );
        assert_eq!(
            catalog_path_for(Path::new("/tmp/demo/secondary.redb")),
            Path::new("/tmp/demo/secondary.catalog.redb")
        );
    }

    #[test]
    fn resolves_the_marketplace_and_token_drop_namespaces_by_default() {
        assert_eq!(
            resolve_namespaces(&[]).unwrap(),
            vec![
                MARKETPLACE_NAMESPACE.to_owned(),
                TOKENS_DROP_NAMESPACE.to_owned()
            ]
        );
    }

    #[test]
    fn an_explicit_namespace_list_replaces_the_default() {
        assert_eq!(
            resolve_namespaces(&["other.things.v1".to_owned()]).unwrap(),
            vec!["other.things.v1".to_owned()]
        );
        assert_eq!(
            resolve_namespaces(&[
                "other.things.v1".to_owned(),
                MARKETPLACE_NAMESPACE.to_owned()
            ])
            .unwrap(),
            // Normalized to sorted order, so the reported policy is stable
            // regardless of flag order.
            vec![
                "other.things.v1".to_owned(),
                MARKETPLACE_NAMESPACE.to_owned()
            ]
        );
    }

    #[test]
    fn rejects_duplicate_and_malformed_namespaces() {
        assert!(resolve_namespaces(&["a".to_owned(), "a".to_owned()]).is_err());
        assert!(resolve_namespaces(&["Bad".to_owned()]).is_err());
        assert!(resolve_namespaces(&[".bad".to_owned()]).is_err());
        assert!(resolve_namespaces(&["a".repeat(65)]).is_err());
    }

    #[test]
    fn round_trips_exact_opaque_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        // Not JSON, not UTF-8: the node never parses a payload.
        let payload = [0x00, 0xff, 0x80, 0x01, 0xfe];
        let stored = store.publish_at(&offer(&payload), 100).unwrap();
        assert_eq!(stored.artifact.payload[..], payload[..]);
        assert_eq!(stored.created_at, 100);

        let listed = list_all(&store);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].artifact.payload[..], payload[..]);
        assert_eq!(listed[0].artifact.namespace, MARKETPLACE_NAMESPACE);
        assert_eq!(listed[0].artifact.pcash_chain_id, CHAIN);
        assert_eq!(listed[0].created_at, 100);
    }

    #[test]
    fn nothing_expires() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        store.publish_at(&offer(b"ancient"), 1).unwrap();

        // Far in the future by any clock. An append-only store keeps it, because
        // a record's presence says nothing about whether its subject is live.
        assert_eq!(list_all(&store).len(), 1);
        assert_eq!(list_all(&store)[0].created_at, 1);
    }

    #[test]
    fn persists_records_and_creation_times_across_restart() {
        let temp = tempfile::tempdir().unwrap();
        {
            let store = store(temp.path());
            store.publish_at(&offer(b"first"), 500).unwrap();
            store.publish_at(&offer(b"second"), 600).unwrap();
        }
        let reopened = store(temp.path());
        let listed = list_all(&reopened);
        assert_eq!(listed.len(), 2);
        let mut created: Vec<u64> = listed.iter().map(|item| item.created_at).collect();
        created.sort_unstable();
        assert_eq!(created, vec![500, 600]);
    }

    #[test]
    fn republishing_is_a_no_op_that_never_refreshes_created_at() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let first = store.publish_at(&offer(b"same"), 100).unwrap();
        assert_eq!(first.created_at, 100);

        // Much later, same bytes. createdAt must still mean "first appeared",
        // or anyone could refresh it and the ordering would be meaningless.
        let again = store.publish_at(&offer(b"same"), 9_000).unwrap();
        assert_eq!(again.created_at, 100);
        assert_eq!(again.artifact.content_id, first.artifact.content_id);

        let listed = list_all(&store);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].created_at, 100);
    }

    #[test]
    fn different_payload_bytes_create_a_different_record() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let a = store.publish_at(&offer(br#"{"a":1}"#), 1).unwrap();
        let b = store.publish_at(&offer(br#"{"a":2}"#), 2).unwrap();
        assert_ne!(a.artifact.content_id, b.artifact.content_id);
        assert_eq!(list_all(&store).len(), 2);
    }

    #[test]
    fn gets_one_record_by_content_id() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let stored = store.publish_at(&offer(b"wanted"), 42).unwrap();
        store.publish_at(&offer(b"other"), 43).unwrap();

        let found = store
            .get(&CatalogGetRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                content_id: stored.artifact.content_id,
            })
            .unwrap()
            .expect("record is present");
        assert_eq!(found.artifact.payload[..], b"wanted"[..]);
        assert_eq!(found.created_at, 42);

        // Absent is None, not an error.
        assert!(store
            .get(&CatalogGetRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                content_id: B256::repeat_byte(0x11),
            })
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_get_does_not_cross_namespaces() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with(
            temp.path(),
            CatalogLimits::default(),
            vec!["a".to_owned(), "a.b".to_owned()],
        );
        let stored = store.publish_at(&artifact("a", b"payload"), 1).unwrap();

        assert!(store
            .get(&CatalogGetRequest {
                namespace: "a.b".to_owned(),
                content_id: stored.artifact.content_id,
            })
            .unwrap()
            .is_none());
    }

    #[test]
    fn rejects_a_mismatched_content_id() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let mut tampered = offer(b"payload");
        tampered.content_id[0] ^= 0x01;
        assert!(matches!(
            store.publish_at(&tampered, 1),
            Err(CatalogApiError::Invalid(_))
        ));
        assert!(list_all(&store).is_empty());
    }

    #[test]
    fn rejects_a_wrong_chain_id() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());

        let mut wrong_chain = offer(b"payload");
        wrong_chain.pcash_chain_id = CHAIN + 1;
        assert!(matches!(
            store.publish_at(&wrong_chain, 1),
            Err(CatalogApiError::Invalid(_))
        ));

        assert!(list_all(&store).is_empty());
    }

    #[test]
    fn rejects_unconfigured_and_malformed_namespaces_on_every_path() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());

        assert!(matches!(
            store.publish_at(&artifact("other.things.v1", b"payload"), 1),
            Err(CatalogApiError::Invalid(_))
        ));
        assert!(matches!(
            store.publish_at(&artifact("Bad", b"payload"), 1),
            Err(CatalogApiError::Invalid(_))
        ));
        assert!(matches!(
            store.list(&CatalogListRequest {
                namespace: "other.things.v1".to_owned(),
                cursor: None,
                limit: 10,
            }),
            Err(CatalogApiError::Invalid(_))
        ));
        assert!(matches!(
            store.get(&CatalogGetRequest {
                namespace: "other.things.v1".to_owned(),
                content_id: B256::ZERO,
            }),
            Err(CatalogApiError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_an_oversized_payload() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let limits = CatalogLimits::default();
        let oversized = vec![0x41u8; limits.max_payload_bytes + 1];
        assert!(matches!(
            store.publish_at(&offer(&oversized), 1),
            Err(CatalogApiError::Invalid(_))
        ));
        let exact = vec![0x41u8; limits.max_payload_bytes];
        store.publish_at(&offer(&exact), 1).unwrap();
    }

    #[test]
    fn caps_records_and_stays_full_because_nothing_expires() {
        let temp = tempfile::tempdir().unwrap();
        let limits = CatalogLimits {
            max_records: 3,
            ..CatalogLimits::default()
        };
        let store = store_with(temp.path(), limits, vec![MARKETPLACE_NAMESPACE.to_owned()]);
        for index in 0..3 {
            store
                .publish_at(&offer(format!("offer-{index}").as_bytes()), 1)
                .unwrap();
        }
        assert!(matches!(
            store.publish_at(&offer(b"overflow"), 1),
            Err(CatalogApiError::Exhausted(_))
        ));
        // Still full much later: a full store needs operator action, not time.
        assert!(matches!(
            store.publish_at(&offer(b"overflow"), 9_999_999),
            Err(CatalogApiError::Exhausted(_))
        ));
        // Republishing something already stored still works at the cap.
        let renewed = store.publish_at(&offer(b"offer-0"), 500).unwrap();
        assert_eq!(renewed.created_at, 1);
        assert_eq!(list_all(&store).len(), 3);
    }

    #[test]
    fn caps_aggregate_payload_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let limits = CatalogLimits {
            max_aggregate_payload_bytes: 32,
            ..CatalogLimits::default()
        };
        let store = store_with(temp.path(), limits, vec![MARKETPLACE_NAMESPACE.to_owned()]);
        store.publish_at(&offer(&[b'a'; 20]), 1).unwrap();
        assert!(matches!(
            store.publish_at(&offer(&[b'b'; 20]), 1),
            Err(CatalogApiError::Exhausted(_))
        ));
        store.publish_at(&offer(&[b'b'; 12]), 1).unwrap();
        assert_eq!(list_all(&store).len(), 2);
    }

    #[test]
    fn reopening_recounts_occupancy_so_limits_survive_restart() {
        // Occupancy is tracked in memory, so a reopened store must recount it
        // from the records themselves rather than start from empty.
        let temp = tempfile::tempdir().unwrap();
        let limits = CatalogLimits {
            max_records: 2,
            max_aggregate_payload_bytes: 32,
            ..CatalogLimits::default()
        };
        let namespaces = vec![MARKETPLACE_NAMESPACE.to_owned()];

        let store = store_with(temp.path(), limits, namespaces.clone());
        store.publish_at(&offer(&[b'a'; 10]), 1).unwrap();
        drop(store);

        let store = store_with(temp.path(), limits, namespaces.clone());
        // One record and 10 bytes are already spoken for after the reopen.
        assert!(matches!(
            store.publish_at(&offer(&[b'b'; 30]), 2),
            Err(CatalogApiError::Exhausted(_))
        ));
        store.publish_at(&offer(&[b'b'; 10]), 2).unwrap();
        assert!(matches!(
            store.publish_at(&offer(&[b'c'; 1]), 3),
            Err(CatalogApiError::Exhausted(_))
        ));
        assert_eq!(list_all(&store).len(), 2);
        drop(store);

        // And the recount is exact, not merely nonzero: reopening again and
        // republishing stored bytes must not consume occupancy a third time.
        let store = store_with(temp.path(), limits, namespaces);
        assert_eq!(
            *store.usage.lock().unwrap(),
            CatalogUsage {
                records: 2,
                payload_bytes: 20,
            }
        );
        store.publish_at(&offer(&[b'a'; 10]), 9).unwrap();
        assert_eq!(
            *store.usage.lock().unwrap(),
            CatalogUsage {
                records: 2,
                payload_bytes: 20,
            }
        );
    }

    #[test]
    fn a_rejected_publish_leaves_storage_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let limits = CatalogLimits {
            max_records: 1,
            ..CatalogLimits::default()
        };
        let store = store_with(temp.path(), limits, vec![MARKETPLACE_NAMESPACE.to_owned()]);
        store.publish_at(&offer(b"kept"), 1).unwrap();
        assert!(store.publish_at(&offer(b"rejected"), 1).is_err());

        let listed = list_all(&store);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].artifact.payload[..], b"kept"[..]);
    }

    #[test]
    fn orders_by_content_id_and_paginates_with_an_exclusive_cursor() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        for index in 0..10u8 {
            store
                .publish_at(&offer(format!("offer-{index}").as_bytes()), 1)
                .unwrap();
        }

        let expected: Vec<B256> = {
            let mut ids: Vec<B256> = (0..10u8)
                .map(|index| {
                    catalog_content_id(
                        MARKETPLACE_NAMESPACE,
                        CHAIN,
                        format!("offer-{index}").as_bytes(),
                    )
                })
                .collect();
            ids.sort_unstable();
            ids
        };

        let mut seen = Vec::new();
        let mut cursor = None;
        let mut pages = 0;
        loop {
            let page = store
                .list(&CatalogListRequest {
                    namespace: MARKETPLACE_NAMESPACE.to_owned(),
                    cursor,
                    limit: 3,
                })
                .unwrap();
            pages += 1;
            assert!(page.items.len() <= 3);
            seen.extend(page.items.iter().map(|item| item.artifact.content_id));
            match page.next_cursor {
                Some(next) => {
                    // The cursor is exclusive: it is the last item just returned.
                    assert_eq!(Some(next), seen.last().copied());
                    cursor = Some(next);
                }
                None => break,
            }
            assert!(pages < 20, "pagination did not terminate");
        }
        assert_eq!(seen, expected);
    }

    #[test]
    fn a_cursor_that_does_not_exist_still_advances() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        store.publish_at(&offer(b"a"), 1).unwrap();
        store.publish_at(&offer(b"b"), 1).unwrap();

        let page = store
            .list(&CatalogListRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                cursor: Some(B256::ZERO),
                limit: 50,
            })
            .unwrap();
        assert_eq!(page.items.len(), 2);

        let past_end = store
            .list(&CatalogListRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                cursor: Some(B256::repeat_byte(0xff)),
                limit: 50,
            })
            .unwrap();
        assert!(past_end.items.is_empty());
        assert_eq!(past_end.next_cursor, None);
    }

    #[test]
    fn bounds_a_page_by_payload_bytes_but_always_returns_one_record() {
        let temp = tempfile::tempdir().unwrap();
        let limits = CatalogLimits {
            max_page_payload_bytes: 100,
            ..CatalogLimits::default()
        };
        let store = store_with(temp.path(), limits, vec![MARKETPLACE_NAMESPACE.to_owned()]);
        for index in 0..4u8 {
            let mut payload = vec![b'a' + index; 80];
            payload[0] = index;
            store.publish_at(&offer(&payload), 1).unwrap();
        }

        let mut cursor = None;
        let mut total = 0;
        for _ in 0..10 {
            let page = store
                .list(&CatalogListRequest {
                    namespace: MARKETPLACE_NAMESPACE.to_owned(),
                    cursor,
                    limit: 50,
                })
                .unwrap();
            // 80-byte payloads against a 100-byte budget: one per page, and a
            // single record is never dropped for exceeding the budget.
            assert_eq!(page.items.len(), 1);
            total += page.items.len();
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(total, 4);
    }

    #[test]
    fn clamps_the_requested_page_size_to_the_advertised_maximum() {
        let temp = tempfile::tempdir().unwrap();
        let limits = CatalogLimits {
            max_page_items: 2,
            ..CatalogLimits::default()
        };
        let store = store_with(temp.path(), limits, vec![MARKETPLACE_NAMESPACE.to_owned()]);
        for index in 0..5u8 {
            store
                .publish_at(&offer(format!("offer-{index}").as_bytes()), 1)
                .unwrap();
        }
        let page = store
            .list(&CatalogListRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                cursor: None,
                limit: 1000,
            })
            .unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(page.next_cursor.is_some());
    }

    #[test]
    fn namespaces_do_not_leak_into_each_others_pages() {
        let temp = tempfile::tempdir().unwrap();
        // "a" is a byte-prefix of "a.b"; the key length prefix must separate them.
        let store = store_with(
            temp.path(),
            CatalogLimits::default(),
            vec!["a".to_owned(), "a.b".to_owned()],
        );
        store.publish_at(&artifact("a", b"short"), 1).unwrap();
        store.publish_at(&artifact("a.b", b"long"), 1).unwrap();

        for (namespace, expected) in [("a", &b"short"[..]), ("a.b", &b"long"[..])] {
            let page = store
                .list(&CatalogListRequest {
                    namespace: namespace.to_owned(),
                    cursor: None,
                    limit: 50,
                })
                .unwrap();
            assert_eq!(page.items.len(), 1, "namespace {namespace} leaked");
            assert_eq!(&page.items[0].artifact.payload[..], expected);
            assert_eq!(page.items[0].artifact.namespace, namespace);
        }
    }

    #[test]
    fn reopening_requires_the_full_network_identity() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.catalog.redb");
        {
            let store = CatalogStore::open(
                &path,
                CHAIN,
                GENESIS,
                vec![MARKETPLACE_NAMESPACE.to_owned()],
                CatalogLimits::default(),
            )
            .unwrap();
            store.publish_at(&offer(b"kept"), 1).unwrap();
        }

        // Records carry only the chain id, but the database is pinned to the
        // full identity: a node re-anchored under the same chain id must not
        // silently serve records from the chain it replaced.
        for (chain, genesis) in [(CHAIN + 1, GENESIS), (CHAIN, B256::repeat_byte(0x11))] {
            let error = CatalogStore::open(
                &path,
                chain,
                genesis,
                vec![MARKETPLACE_NAMESPACE.to_owned()],
                CatalogLimits::default(),
            )
            .err()
            .expect("mismatched identity must not open");
            assert!(matches!(error, CatalogApiError::Storage(_)));
        }

        // The mismatch must not have deleted or rewritten operator data.
        let reopened = CatalogStore::open(
            &path,
            CHAIN,
            GENESIS,
            vec![MARKETPLACE_NAMESPACE.to_owned()],
            CatalogLimits::default(),
        )
        .unwrap();
        let listed = list_all(&reopened);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].artifact.payload[..], b"kept"[..]);
    }

    #[test]
    fn opening_requires_the_exact_table_and_metadata_schema() {
        let temp = tempfile::tempdir().unwrap();

        let extra_meta_path = temp.path().join("extra-meta.redb");
        CatalogStore::open(
            &extra_meta_path,
            CHAIN,
            GENESIS,
            vec![MARKETPLACE_NAMESPACE.to_owned()],
            CatalogLimits::default(),
        )
        .unwrap();
        {
            let db = Database::open(&extra_meta_path).unwrap();
            let write = db.begin_write().unwrap();
            {
                let mut meta = write.open_table(T_META).unwrap();
                meta.insert("unexpected", &[0u8][..]).unwrap();
            }
            write.commit().unwrap();
        }
        assert!(matches!(
            CatalogStore::open(
                &extra_meta_path,
                CHAIN,
                GENESIS,
                vec![MARKETPLACE_NAMESPACE.to_owned()],
                CatalogLimits::default(),
            ),
            Err(CatalogApiError::Storage(_))
        ));

        let extra_table_path = temp.path().join("extra-table.redb");
        CatalogStore::open(
            &extra_table_path,
            CHAIN,
            GENESIS,
            vec![MARKETPLACE_NAMESPACE.to_owned()],
            CatalogLimits::default(),
        )
        .unwrap();
        {
            const UNEXPECTED: TableDefinition<&str, &str> = TableDefinition::new("unexpected");
            let db = Database::open(&extra_table_path).unwrap();
            let write = db.begin_write().unwrap();
            write.open_table(UNEXPECTED).unwrap();
            write.commit().unwrap();
        }
        assert!(matches!(
            CatalogStore::open(
                &extra_table_path,
                CHAIN,
                GENESIS,
                vec![MARKETPLACE_NAMESPACE.to_owned()],
                CatalogLimits::default(),
            ),
            Err(CatalogApiError::Storage(_))
        ));
    }

    #[test]
    fn a_malformed_database_is_an_error_not_a_panic() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.catalog.redb");
        std::fs::write(&path, b"this is not a redb database").unwrap();
        assert!(matches!(
            CatalogStore::open(
                &path,
                CHAIN,
                GENESIS,
                vec![MARKETPLACE_NAMESPACE.to_owned()],
                CatalogLimits::default(),
            ),
            Err(CatalogApiError::Storage(_))
        ));
        // Left exactly as the operator had it.
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"this is not a redb database"
        );
    }

    #[test]
    fn a_disabled_service_reports_policy_without_opening_storage() {
        let temp = tempfile::tempdir().unwrap();
        let path = catalog_path_for(&temp.path().join("state.redb"));
        let service = CatalogService::disabled(CHAIN, vec![MARKETPLACE_NAMESPACE.to_owned()]);

        assert_eq!(service.status(), CatalogStatus::Disabled);
        let info = service.info();
        assert_eq!(info.status, CatalogStatus::Disabled);
        assert_eq!(info.pcash_chain_id, CHAIN);
        assert_eq!(info.namespaces, vec![MARKETPLACE_NAMESPACE.to_owned()]);

        assert!(matches!(
            service.list(&CatalogListRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                cursor: None,
                limit: 10,
            }),
            Err(CatalogApiError::Unavailable)
        ));
        assert!(matches!(
            service.publish(&offer(b"payload")),
            Err(CatalogApiError::Unavailable)
        ));
        assert!(matches!(
            service.get(&CatalogGetRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                content_id: B256::ZERO,
            }),
            Err(CatalogApiError::Unavailable)
        ));
        assert!(
            !path.exists(),
            "a disabled catalog must not create its file"
        );
    }

    #[test]
    fn a_failed_open_is_contained_as_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.catalog.redb");
        std::fs::write(&path, b"not a redb database").unwrap();

        let service = CatalogService::open(
            &path,
            CHAIN,
            GENESIS,
            vec![MARKETPLACE_NAMESPACE.to_owned()],
        );
        assert_eq!(service.status(), CatalogStatus::Unavailable);

        let info = service.info();
        assert_eq!(info.status, CatalogStatus::Unavailable);
        // Identity and policy are still answerable with no storage at all.
        assert_eq!(info.pcash_chain_id, CHAIN);
        assert_eq!(info.namespaces, vec![MARKETPLACE_NAMESPACE.to_owned()]);
        assert!(matches!(
            service.list(&CatalogListRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                cursor: None,
                limit: 10,
            }),
            Err(CatalogApiError::Unavailable)
        ));
    }

    #[test]
    fn an_enabled_service_serves_and_reports_available() {
        let temp = tempfile::tempdir().unwrap();
        let service = CatalogService::open(
            temp.path().join("state.catalog.redb"),
            CHAIN,
            GENESIS,
            vec![MARKETPLACE_NAMESPACE.to_owned()],
        );
        assert_eq!(service.status(), CatalogStatus::Available);
        assert_eq!(service.info().status, CatalogStatus::Available);

        let stored = service.publish(&offer(b"payload")).unwrap();
        let page = service
            .list(&CatalogListRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                cursor: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(
            page.items[0].artifact.content_id,
            stored.artifact.content_id
        );

        let fetched = service
            .get(&CatalogGetRequest {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                content_id: stored.artifact.content_id,
            })
            .unwrap()
            .expect("record is present");
        assert_eq!(fetched.artifact.payload[..], b"payload"[..]);
    }
}
