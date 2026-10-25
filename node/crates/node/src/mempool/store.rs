use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use alloy_primitives::{keccak256, Address, B256, U256, U512};
use pcash_derive::public_records::{read_public_records, PublicRecord};
use pcash_derive::{
    admit, contract_funding_mode, AccountCreationAuthorization, AdmissionError,
    AdmittedTransaction, ContractFunding, ContractFundingMode, ParseError, PrivateValueSection,
    ProtocolRules, KIND_CONTRACT_ACCOUNT_CREATION, KIND_PRIVATE_VALUE, KIND_USER_ACCOUNT_CREATION,
    KIND_USER_ACCOUNT_UPDATE, MAX_VALID_TX_BYTES,
};
use pcash_l1::CarrierKind;
use pcash_rpc::dto::{
    ContractFundingMode as DtoContractFundingMode, TransactionKind as DtoTransactionKind,
};
use pcash_rpc::{
    BlockId, MempoolApiError, MempoolFilter, MempoolSort, MempoolStatusFilter,
    MempoolTransactionDto,
};
use pcash_state::codec::{codec_enum, codec_struct, Reader, Writer};
use pcash_state::{Codec, DecodeError, DerivationSource};
use redb::{Database, Durability, ReadableDatabase, ReadableTable, TableDefinition};

use super::{
    DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_UNPAID_ENTRIES, MAX_PAGE_SIZE,
    UNPAID_TTL_MS,
};

pub(super) const META_GENESIS_HASH: &[u8] = b"genesis_hash";
pub(super) const META_CHAIN_ID: &[u8] = b"chain_id";
pub(super) const T_META: TableDefinition<&[u8], &[u8]> = TableDefinition::new("meta");
pub(super) const T_ENTRIES: TableDefinition<&[u8], &[u8]> = TableDefinition::new("entries");

pub(super) fn validate_mempool_schema(db: &Database) -> Result<(), MempoolApiError> {
    crate::redb_schema::require_tables(db, &["entries", "meta"])
        .map_err(|_| MempoolApiError::Storage("incompatible mempool table schema".to_owned()))?;
    let read = db.begin_read().map_err(storage_error)?;
    let meta = read.open_table(T_META).map_err(storage_error)?;
    let keys = meta
        .iter()
        .map_err(storage_error)?
        .map(|row| {
            row.map(|(key, _)| key.value().to_vec())
                .map_err(storage_error)
        })
        .collect::<Result<Vec<_>, _>>()?;
    crate::redb_schema::require_meta_keys(keys, &[&[META_CHAIN_ID, META_GENESIS_HASH]])
        .map_err(|_| MempoolApiError::Storage("incompatible mempool metadata schema".to_owned()))?;
    Ok(())
}
#[derive(Clone, Copy, Debug)]
pub struct MempoolLimits {
    pub max_entries: usize,
    pub max_bytes: usize,
    pub max_unpaid_entries: usize,
    pub accept_unpaid_registration: bool,
}

impl Default for MempoolLimits {
    fn default() -> Self {
        Self {
            max_entries: DEFAULT_MAX_ENTRIES,
            max_bytes: DEFAULT_MAX_BYTES,
            max_unpaid_entries: DEFAULT_MAX_UNPAID_ENTRIES,
            accept_unpaid_registration: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MempoolStatus {
    Ready,
    IncludedUnfinalized,
    Suspended,
}

codec_enum!(MempoolStatus: u8 {
    Ready,
    IncludedUnfinalized,
    Suspended
});

impl MempoolStatus {
    pub(super) fn as_str(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::IncludedUnfinalized => "included_unfinalized",
            Self::Suspended => "suspended",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TransactionKind {
    PrivateValue,
    UserAccountCreation,
    UserAccountUpdate,
    ContractAccountCreation,
}

codec_enum!(TransactionKind: u8 {
    PrivateValue,
    UserAccountCreation,
    UserAccountUpdate,
    ContractAccountCreation
});

impl TransactionKind {
    /// The RPC spelling. `pcash-rpc` owns the wire names, so the mempool's
    /// internal kind and the `pcash_getMempool` filter cannot drift apart.
    pub(super) fn to_dto(self) -> DtoTransactionKind {
        match self {
            Self::PrivateValue => DtoTransactionKind::PrivateValue,
            Self::UserAccountCreation => DtoTransactionKind::UserAccountCreation,
            Self::UserAccountUpdate => DtoTransactionKind::UserAccountUpdate,
            Self::ContractAccountCreation => DtoTransactionKind::ContractAccount,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum ConflictKey {
    Nullifier(B256),
    Account(Address),
    Contract(Address),
}

impl Codec for ConflictKey {
    fn write(&self, w: &mut Writer) {
        match self {
            Self::Nullifier(nullifier) => {
                w.u8(0);
                nullifier.write(w);
            }
            Self::Account(address) => {
                w.u8(1);
                address.write(w);
            }
            Self::Contract(address) => {
                w.u8(2);
                address.write(w);
            }
        }
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        match r.take_u8()? {
            0 => Ok(Self::Nullifier(B256::read(r)?)),
            1 => Ok(Self::Account(Address::read(r)?)),
            2 => Ok(Self::Contract(Address::read(r)?)),
            _ => Err(DecodeError::Invalid("ConflictKey")),
        }
    }
}

/// The resource an entry is identified by is one of the keys it conflicts on.
pub(super) type StableId = ConflictKey;

impl ConflictKey {
    pub(super) fn display(&self) -> String {
        match self {
            Self::Nullifier(id) => format!("nullifier:0x{}", hex::encode(id)),
            Self::Account(address) => format!("account:{address}"),
            Self::Contract(address) => format!("contract:{address}"),
        }
    }
}

/// The admitted transaction behind a pool entry: decoded and with its static
/// work, at admission or load. Each validation context applies its own fork
/// gate.
#[derive(Clone, Debug, Default)]
pub(super) struct CachedEntry(Option<Arc<AdmittedTransaction>>);

impl CachedEntry {
    /// Also computes the hashes every later validation of the entry reads,
    /// which it would otherwise compute under the derivation lock: a
    /// section's delivery commitment or a creation's receive key hash.
    pub(super) fn new(transaction: AdmittedTransaction) -> Self {
        let section = match &transaction {
            AdmittedTransaction::PrivateValue(section) => Some(section),
            AdmittedTransaction::UserAccountUpdate(update) => Some(&update.section),
            AdmittedTransaction::ContractAccountCreation(creation, _) => creation.section(),
            AdmittedTransaction::UserAccountCreation(creation) => {
                creation.receive_key_hash();
                None
            }
        };
        if let Some(section) = section {
            section.delivery_commitment();
        }
        Self(Some(Arc::new(transaction)))
    }

    pub(super) fn get(&self) -> &AdmittedTransaction {
        self.0
            .as_deref()
            .expect("mempool entries are admitted at admission or load")
    }
}

// Only persisted fields determine whether a lifecycle row changed.
impl PartialEq for CachedEntry {
    fn eq(&self, _other: &Self) -> bool {
        true
    }
}
impl Eq for CachedEntry {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct StoredEntry {
    pub(super) content_hash: B256,
    pub(super) metadata: EntryMetadata,
    pub(super) raw: Vec<u8>,
    pub(super) prepared: CachedEntry,
    pub(super) status: MempoolStatus,
    pub(super) included_block: Option<BlockId>,
    pub(super) superseded_block: Option<BlockId>,
    /// First canonical block at which ordinary state revalidation made this
    /// entry ineligible. Once that block finalizes, retaining the bytes can no
    /// longer help a reorg and would let far-future deadlines pin pool space.
    pub(super) invalidated_block: Option<BlockId>,
    pub(super) validated_block: BlockId,
    pub(super) received_at_unix_ms: u64,
}

/// Every field but `prepared`, which is rebuilt from `raw` on load.
impl Codec for StoredEntry {
    fn write(&self, w: &mut Writer) {
        self.content_hash.write(w);
        self.metadata.write(w);
        self.raw.write(w);
        self.status.write(w);
        self.included_block.write(w);
        self.superseded_block.write(w);
        self.invalidated_block.write(w);
        self.validated_block.write(w);
        self.received_at_unix_ms.write(w);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(Self {
            content_hash: Codec::read(r)?,
            metadata: Codec::read(r)?,
            raw: Codec::read(r)?,
            prepared: CachedEntry::default(),
            status: Codec::read(r)?,
            included_block: Codec::read(r)?,
            superseded_block: Codec::read(r)?,
            invalidated_block: Codec::read(r)?,
            validated_block: Codec::read(r)?,
            received_at_unix_ms: Codec::read(r)?,
        })
    }
}

/// Type `0x00` carries issuance even with zero open fee. Other zero-fee
/// entries consume the bounded unpaid pool regardless of private outputs.
pub(super) fn is_unpaid(kind: u8, open_fee_amount: U256) -> bool {
    open_fee_amount.is_zero() && !pcash_derive::earns_issuance(kind)
}

/// Proof-free registrations need operator opt-in: user-account creation and
/// unfunded contract creation, told apart from a sponsored creation by the
/// funding byte rather than by its fee.
pub(super) fn requires_unpaid_registration_opt_in(raw: &[u8]) -> bool {
    raw.first() == Some(&KIND_USER_ACCOUNT_CREATION)
        || contract_funding_mode(raw) == Some(ContractFundingMode::Unfunded)
}

/// The refusal of a proof-free registration while the operator has not
/// opted in.
pub(super) fn unpaid_registration_disabled() -> MempoolApiError {
    MempoolApiError::Policy(
        "proof-free account registration is disabled; submit directly to L1".to_owned(),
    )
}

/// Refuse a section that requires a carrier context. It succeeds only through
/// the carrier it names, which posts it itself, so a relayer would publish a
/// transaction certain to fail. This is node policy, not validity.
pub(super) fn refuse_carrier_bound(
    section: Option<&PrivateValueSection>,
) -> Result<(), MempoolApiError> {
    if section.is_some_and(|section| !section.carrier_context_hash().is_zero()) {
        return Err(MempoolApiError::Policy(
            "a transaction that requires a carrier context is posted by that carrier, not relayed"
                .to_owned(),
        ));
    }
    Ok(())
}

impl StoredEntry {
    pub(super) fn unpaid(&self) -> bool {
        is_unpaid(self.raw[0], self.metadata.open_fee_amount)
    }

    pub(super) fn to_dto(&self, include_raw: bool, conflict_count: u64) -> MempoolTransactionDto {
        MempoolTransactionDto {
            content_hash: self.content_hash,
            statement_id: self.metadata.statement_id,
            kind: self.metadata.kind.to_dto(),
            funding_mode: DtoContractFundingMode::of(&self.raw),
            stable_id: self.metadata.stable_id.display(),
            conflict_keys: self
                .metadata
                .conflict_keys
                .iter()
                .map(ConflictKey::display)
                .collect(),
            open_fee_amount: self.metadata.open_fee_amount,
            issuance_owner_commitment: self.metadata.issuance_owner_commitment,
            issuance_route: crate::node::issuance_route(
                self.raw[0],
                self.metadata
                    .has_publication_section
                    .then_some(self.metadata.issuance_owner_commitment),
            ),
            valid_until: self.metadata.valid_until_timestamp,
            recent_pcash_block_hash: self.metadata.recent_pcash_block_hash,
            byte_size: self.raw.len() as u64,
            received_at_unix_ms: self.received_at_unix_ms,
            conflict_count,
            status: self.status.as_str().to_owned(),
            head_checked_block: self.validated_block.block_number,
            head_checked_block_hash: self.validated_block.block_hash,
            public_records: self
                .metadata
                .public_records
                .iter()
                .cloned()
                .map(Into::into)
                .collect(),
            raw_transaction: include_raw.then(|| self.raw.clone().into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EntryMetadata {
    pub(super) statement_id: B256,
    pub(super) kind: TransactionKind,
    pub(super) stable_id: StableId,
    pub(super) conflict_keys: Vec<ConflictKey>,
    pub(super) open_fee_amount: U256,
    pub(super) issuance_owner_commitment: B256,
    /// Whether the entry carries a private-value section with public
    /// publication fields. Entries without one need sponsorship.
    pub(super) has_publication_section: bool,
    pub(super) valid_until_timestamp: Option<u64>,
    /// The recent PCASH block a private-value section proves against.
    pub(super) recent_pcash_block_hash: Option<B256>,
    /// The section arena's public records, which the arena filter matches.
    pub(super) public_records: Vec<PublicRecord>,
}

codec_struct!(EntryMetadata {
    statement_id,
    kind,
    stable_id,
    conflict_keys,
    open_fee_amount,
    issuance_owner_commitment,
    has_publication_section,
    valid_until_timestamp,
    recent_pcash_block_hash,
    public_records
});

#[cfg(test)]
pub(super) fn descriptor(
    raw: &[u8],
    source: &DerivationSource,
) -> Result<EntryMetadata, MempoolApiError> {
    let transaction = AdmittedTransaction::decode(raw, source.pcash_chain_id)
        .map_err(|error| decode_error(&error))?;
    descriptor_admitted(raw, &transaction, source)
}

pub(super) fn descriptor_admitted(
    raw: &[u8],
    transaction: &AdmittedTransaction,
    source: &DerivationSource,
) -> Result<EntryMetadata, MempoolApiError> {
    match transaction {
        AdmittedTransaction::PrivateValue(pe) => {
            let section = section_descriptor(pe)?;
            Ok(EntryMetadata {
                statement_id: proof_statement_id(KIND_PRIVATE_VALUE, pe),
                kind: TransactionKind::PrivateValue,
                stable_id: StableId::Nullifier(
                    pe.public_input(pe.shape().profile().nullifiers_offset),
                ),
                conflict_keys: section.conflict_keys,
                open_fee_amount: section.open_fee_amount,
                issuance_owner_commitment: section.issuance_owner_commitment,
                has_publication_section: true,
                valid_until_timestamp: Some(section.valid_until_timestamp),
                recent_pcash_block_hash: Some(section.recent_pcash_block_hash),
                public_records: section.public_records,
            })
        }
        AdmittedTransaction::UserAccountCreation(re) => {
            // Relayed creations are signed, so the account is the signer.
            let address = re.signer(source).ok_or_else(|| {
                MempoolApiError::Invalid("account creation signature does not recover".to_owned())
            })?;
            Ok(EntryMetadata {
                statement_id: keccak256(raw),
                kind: TransactionKind::UserAccountCreation,
                stable_id: StableId::Account(address),
                conflict_keys: vec![ConflictKey::Account(address)],
                open_fee_amount: U256::ZERO,
                issuance_owner_commitment: B256::ZERO,
                has_publication_section: false,
                valid_until_timestamp: Some(re.valid_until_timestamp),
                recent_pcash_block_hash: None,
                public_records: Vec::new(),
            })
        }
        AdmittedTransaction::UserAccountUpdate(re) => {
            let section = section_descriptor(&re.section)?;
            let mut conflict_keys = vec![ConflictKey::Account(re.address)];
            conflict_keys.extend(section.conflict_keys);
            Ok(EntryMetadata {
                statement_id: proof_statement_id_with(
                    KIND_USER_ACCOUNT_UPDATE,
                    &re.section,
                    re.account_update_commitment.as_slice(),
                ),
                kind: TransactionKind::UserAccountUpdate,
                stable_id: StableId::Account(re.address),
                conflict_keys,
                open_fee_amount: section.open_fee_amount,
                issuance_owner_commitment: section.issuance_owner_commitment,
                has_publication_section: true,
                valid_until_timestamp: Some(section.valid_until_timestamp),
                recent_pcash_block_hash: Some(section.recent_pcash_block_hash),
                public_records: section.public_records,
            })
        }
        // Both funding modes conflict on the derived address; a sponsored
        // creation also on its payment nullifiers.
        AdmittedTransaction::ContractAccountCreation(ce, check) => {
            let address = check
                .address()
                .ok_or_else(|| MempoolApiError::Invalid("invalid contract body".to_owned()))?;
            match &ce.funding {
                ContractFunding::Unfunded {
                    valid_until_timestamp,
                    ..
                } => Ok(EntryMetadata {
                    statement_id: keccak256(raw),
                    kind: TransactionKind::ContractAccountCreation,
                    stable_id: StableId::Contract(address),
                    conflict_keys: vec![ConflictKey::Contract(address)],
                    open_fee_amount: U256::ZERO,
                    issuance_owner_commitment: B256::ZERO,
                    has_publication_section: false,
                    valid_until_timestamp: Some(*valid_until_timestamp),
                    recent_pcash_block_hash: None,
                    public_records: Vec::new(),
                }),
                ContractFunding::Sponsored(fee) => {
                    let section = section_descriptor(fee)?;
                    let mut conflict_keys = vec![ConflictKey::Contract(address)];
                    conflict_keys.extend(section.conflict_keys);
                    Ok(EntryMetadata {
                        statement_id: proof_statement_id_with(
                            KIND_CONTRACT_ACCOUNT_CREATION,
                            fee,
                            address.as_slice(),
                        ),
                        kind: TransactionKind::ContractAccountCreation,
                        stable_id: StableId::Contract(address),
                        conflict_keys,
                        open_fee_amount: section.open_fee_amount,
                        issuance_owner_commitment: section.issuance_owner_commitment,
                        has_publication_section: true,
                        valid_until_timestamp: Some(section.valid_until_timestamp),
                        recent_pcash_block_hash: Some(section.recent_pcash_block_hash),
                        public_records: section.public_records,
                    })
                }
            }
        }
    }
}

fn too_large(raw: &[u8]) -> MempoolApiError {
    MempoolApiError::Invalid(format!(
        "transaction is {} bytes; maximum is {MAX_VALID_TX_BYTES}",
        raw.len()
    ))
}

/// A decoding failure: an envelope naming another chain is a state error,
/// as it is during derivation; any other failure means the bytes are
/// invalid.
pub(super) fn decode_error(error: &ParseError) -> MempoolApiError {
    match error {
        ParseError::WrongChainId(_) => MempoolApiError::State("WrongChainId".to_owned()),
        error => MempoolApiError::Invalid(error.to_string()),
    }
}

/// Admit relayed bytes at the current derived head's `timestamp` with the
/// consensus admission function, as items of the Inbox carrier a relayer
/// posts, then apply the relay policy.
pub(super) fn admit_at_timestamp(
    raw: &[u8],
    rules: &ProtocolRules,
    source: &DerivationSource,
    timestamp: u64,
) -> Result<AdmittedTransaction, MempoolApiError> {
    if raw.len() > MAX_VALID_TX_BYTES {
        return Err(too_large(raw));
    }
    let transaction = admit(
        raw,
        rules,
        source.pcash_chain_id,
        timestamp,
        CarrierKind::Inbox,
    )
    .map_err(|error| match error {
        AdmissionError::TooLarge(_) => too_large(raw),
        AdmissionError::Decode(error) => decode_error(&error),
        AdmissionError::InactiveType(kind) => MempoolApiError::State(format!(
            "transaction type 0x{kind:02x} is not accepted at the current derived head"
        )),
        error @ AdmissionError::DirectModeOutsideInbox => {
            MempoolApiError::Invalid(error.to_string())
        }
    })?;
    if matches!(&transaction, AdmittedTransaction::UserAccountCreation(re) if matches!(re.authorization, AccountCreationAuthorization::DirectL1))
    {
        return Err(MempoolApiError::Invalid("direct account creation requires an owner-sent L1 transaction and cannot enter the relayer mempool".to_owned()));
    }
    refuse_carrier_bound(transaction.section())?;
    Ok(transaction)
}

#[cfg(test)]
pub(super) fn descriptor_at_timestamp(
    raw: &[u8],
    rules: &ProtocolRules,
    source: &DerivationSource,
    timestamp: u64,
) -> Result<(EntryMetadata, AdmittedTransaction), MempoolApiError> {
    let transaction = admit_at_timestamp(raw, rules, source, timestamp)?;
    Ok((descriptor_admitted(raw, &transaction, source)?, transaction))
}

pub(super) fn admission_fee(transaction: &AdmittedTransaction) -> Result<U256, MempoolApiError> {
    transaction.section().map_or(Ok(U256::ZERO), |section| {
        Ok(section_descriptor(section)?.open_fee_amount)
    })
}

/// The payout-relevant view of one private-value section, in the launch
/// layout.
struct SectionMetadata {
    conflict_keys: Vec<ConflictKey>,
    open_fee_amount: U256,
    issuance_owner_commitment: B256,
    valid_until_timestamp: u64,
    recent_pcash_block_hash: B256,
    public_records: Vec<PublicRecord>,
}

fn section_descriptor(pe: &PrivateValueSection) -> Result<SectionMetadata, MempoolApiError> {
    let profile = pe.shape().profile();
    let valid = pcash_state::word_to_u256(pe.public_input(profile.valid_until_offset));
    if valid > U256::from(u64::MAX) {
        return Err(MempoolApiError::Invalid(
            "validUntilTimestamp exceeds uint64".to_owned(),
        ));
    }
    Ok(SectionMetadata {
        conflict_keys: (profile.nullifiers_offset..profile.outputs_offset)
            .map(|offset| ConflictKey::Nullifier(pe.public_input(offset)))
            .collect(),
        open_fee_amount: pcash_state::word_to_u256(pe.public_input(profile.open_fee_amount_offset)),
        issuance_owner_commitment: pe.public_input(profile.issuance_owner_offset),
        valid_until_timestamp: valid.to::<u64>(),
        recent_pcash_block_hash: pe.public_input(profile.recent_block_hash_offset),
        public_records: read_public_records(pe.arena()).unwrap_or_default(),
    })
}

pub(super) fn proof_statement_id(kind: u8, section: &PrivateValueSection) -> B256 {
    proof_statement_id_with(kind, section, &[])
}

/// A statement id over the section's public inputs plus the carrying
/// transaction's appended verifier word, so a re-proof of the same statement
/// deduplicates while a different subject does not. The public inputs carry
/// the delivery commitment, which binds the output data and arena; a pool
/// entry's commitment was computed by [`CachedEntry::new`].
fn proof_statement_id_with(kind: u8, section: &PrivateValueSection, appended: &[u8]) -> B256 {
    let public_inputs = section.public_inputs();
    let mut bytes = Vec::with_capacity(28 + appended.len() + public_inputs.len() * 32);
    bytes.extend_from_slice(b"pcash.mempool.statement");
    bytes.push(kind);
    bytes.push(section.shape() as u8);
    bytes.extend_from_slice(&(public_inputs.len() as u16).to_be_bytes());
    for input in &public_inputs {
        bytes.extend_from_slice(input.as_slice());
    }
    bytes.extend_from_slice(appended);
    keccak256(bytes)
}

pub(super) fn storage_error(error: impl std::fmt::Display) -> MempoolApiError {
    MempoolApiError::Storage(error.to_string())
}

pub(super) struct MempoolStore {
    pub(super) db: Database,
    pub(super) entries: BTreeMap<B256, StoredEntry>,
    pub(super) total_bytes: usize,
    pub(super) limits: MempoolLimits,
    #[cfg(test)]
    pub(super) fail_next_lifecycle_write: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum InsertResult {
    Duplicate,
    Inserted { capacity_evictions: usize },
}

impl MempoolStore {
    pub(super) fn open(
        path: impl AsRef<Path>,
        chain_id: u32,
        genesis_hash: B256,
        limits: MempoolLimits,
    ) -> Result<Self, MempoolApiError> {
        validate_limits(limits)?;
        let path = path.as_ref();
        let existed = path.exists();
        let db = Database::create(path).map_err(storage_error)?;
        Self::open_database(db, existed, chain_id, genesis_hash, limits)
    }

    pub(super) fn open_in_memory(
        chain_id: u32,
        genesis_hash: B256,
        limits: MempoolLimits,
    ) -> Result<Self, MempoolApiError> {
        validate_limits(limits)?;
        let db = Database::builder()
            .create_with_backend(redb::backends::InMemoryBackend::new())
            .map_err(storage_error)?;
        Self::open_database(db, false, chain_id, genesis_hash, limits)
    }

    fn open_database(
        db: Database,
        existed: bool,
        chain_id: u32,
        genesis_hash: B256,
        limits: MempoolLimits,
    ) -> Result<Self, MempoolApiError> {
        if existed {
            validate_mempool_schema(&db)?;
            let read = db.begin_read().map_err(storage_error)?;
            let meta = read.open_table(T_META).map_err(storage_error)?;
            let stored_chain_id = meta
                .get(META_CHAIN_ID)
                .map_err(storage_error)?
                .ok_or_else(|| MempoolApiError::Storage("missing mempool chain id".to_owned()))?;
            let stored_genesis = meta
                .get(META_GENESIS_HASH)
                .map_err(storage_error)?
                .ok_or_else(|| {
                    MempoolApiError::Storage("missing mempool genesis hash".to_owned())
                })?;
            if stored_chain_id.value() != chain_id.to_be_bytes() {
                return Err(MempoolApiError::Storage(
                    "mempool chain id mismatch".to_owned(),
                ));
            }
            if stored_genesis.value() != genesis_hash.as_slice() {
                return Err(MempoolApiError::Storage(
                    "mempool genesis hash mismatch".to_owned(),
                ));
            }
        } else {
            let mut w = db.begin_write().map_err(storage_error)?;
            w.set_durability(Durability::Immediate)
                .map_err(storage_error)?;
            {
                let mut meta = w.open_table(T_META).map_err(storage_error)?;
                meta.insert(META_CHAIN_ID, chain_id.to_be_bytes().as_slice())
                    .map_err(storage_error)?;
                meta.insert(META_GENESIS_HASH, genesis_hash.as_slice())
                    .map_err(storage_error)?;
            }
            w.open_table(T_ENTRIES).map_err(storage_error)?;
            w.commit().map_err(storage_error)?;
        }

        let mut entries = BTreeMap::new();
        let mut total_bytes = 0usize;
        // The pool only caches unconfirmed transactions, which clients and
        // peers resend. A row this build cannot read, such as one written in an
        // older row format, is dropped rather than refusing to start.
        let mut unreadable = Vec::new();
        {
            let r = db.begin_read().map_err(storage_error)?;
            let table = r.open_table(T_ENTRIES).map_err(storage_error)?;
            for row in table.iter().map_err(storage_error)? {
                let (key, value) = row.map_err(storage_error)?;
                let content_hash = B256::try_from(key.value()).map_err(|_| {
                    MempoolApiError::Storage("invalid transaction key length".to_owned())
                })?;
                let decoded = StoredEntry::decode(value.value())
                    .map_err(|error| error.to_string())
                    .and_then(|entry| {
                        AdmittedTransaction::decode(&entry.raw, chain_id)
                            .map(|transaction| (entry, transaction))
                            .map_err(|error| format!("stored transaction: {error}"))
                    });
                let (mut entry, transaction) = match decoded {
                    Ok(decoded) => decoded,
                    Err(error) => {
                        tracing::warn!(%content_hash, %error, "dropping an unreadable mempool row");
                        unreadable.push(content_hash);
                        continue;
                    }
                };
                entry.prepared = CachedEntry::new(transaction);
                total_bytes = total_bytes.checked_add(entry.raw.len()).ok_or_else(|| {
                    MempoolApiError::Storage("stored byte count overflow".to_owned())
                })?;
                entries.insert(content_hash, entry);
            }
        }
        let mut store = Self {
            db,
            entries,
            total_bytes,
            limits,
            #[cfg(test)]
            fail_next_lifecycle_write: false,
        };
        let mut unpaid = store
            .entries
            .values()
            .filter(|e| e.unpaid())
            .collect::<Vec<_>>();
        unpaid.sort_by_key(|e| (e.received_at_unix_ms, e.content_hash));
        let allowed_count = unpaid
            .iter()
            .filter(|e| {
                limits.accept_unpaid_registration || !requires_unpaid_registration_opt_in(&e.raw)
            })
            .count();
        let excess = allowed_count.saturating_sub(limits.max_unpaid_entries);
        let mut kept_allowed = 0usize;
        let mut removals = unpaid
            .iter()
            .filter(|e| {
                if !limits.accept_unpaid_registration && requires_unpaid_registration_opt_in(&e.raw)
                {
                    return true;
                }
                kept_allowed += 1;
                kept_allowed <= excess || unpaid_expired(e, now_unix_ms())
            })
            .map(|e| e.content_hash)
            .collect::<Vec<_>>();
        removals.extend(unreadable);
        if !removals.is_empty() {
            store.apply_changes(Vec::new(), removals)?;
        }
        Ok(store)
    }

    pub(super) fn insert(&mut self, entry: StoredEntry) -> Result<InsertResult, MempoolApiError> {
        if self.entries.contains_key(&entry.content_hash) {
            return Ok(InsertResult::Duplicate);
        }
        self.purge_expired_unpaid(now_unix_ms())?;
        let removals = self.capacity_removals(&entry.raw, entry.metadata.open_fee_amount)?;
        let capacity_evictions = removals.len();
        self.apply_changes(vec![entry], removals)?;
        Ok(InsertResult::Inserted { capacity_evictions })
    }

    /// Only client/peer candidates consume capacity; failed candidates never
    /// evict. A paying candidate displaces the oldest unpaid entries first,
    /// then paying entries of strictly lower explicit fee density, lowest
    /// first. The pool does not price issuance, so a zero-fee type `0x00`
    /// entry ranks at density zero.
    pub(super) fn capacity_removals(
        &self,
        raw: &[u8],
        open_fee_amount: U256,
    ) -> Result<Vec<B256>, MempoolApiError> {
        let bytes = raw.len();
        let unpaid = is_unpaid(raw[0], open_fee_amount);
        if requires_unpaid_registration_opt_in(raw) && !self.limits.accept_unpaid_registration {
            return Err(unpaid_registration_disabled());
        }
        if !unpaid
            && self.entries.len() < self.limits.max_entries
            && self.total_bytes.saturating_add(bytes) <= self.limits.max_bytes
        {
            return Ok(Vec::new());
        }
        let mut candidates = self
            .entries
            .values()
            .filter(|entry| entry.unpaid())
            .collect::<Vec<_>>();
        if unpaid && candidates.len() >= self.limits.max_unpaid_entries {
            return Err(MempoolApiError::Full);
        }
        let mut count = self.entries.len() + 1;
        let mut total = self.total_bytes.saturating_add(bytes);
        let mut removals = Vec::new();
        if !unpaid {
            candidates.sort_by_key(|entry| (entry.received_at_unix_ms, entry.content_hash));
            let mut paying = self
                .entries
                .values()
                .filter(|entry| {
                    !entry.unpaid()
                        && fee_density_cmp(
                            entry.metadata.open_fee_amount,
                            entry.raw.len(),
                            open_fee_amount,
                            bytes,
                        )
                        .is_lt()
                })
                .collect::<Vec<_>>();
            paying.sort_by(|left, right| {
                fee_density_cmp(
                    left.metadata.open_fee_amount,
                    left.raw.len(),
                    right.metadata.open_fee_amount,
                    right.raw.len(),
                )
                .then_with(|| left.content_hash.cmp(&right.content_hash))
            });
            for entry in candidates.into_iter().chain(paying) {
                if count <= self.limits.max_entries && total <= self.limits.max_bytes {
                    break;
                }
                count -= 1;
                total -= entry.raw.len();
                removals.push(entry.content_hash);
            }
        }
        if count > self.limits.max_entries || total > self.limits.max_bytes {
            return Err(MempoolApiError::Full);
        }
        Ok(removals)
    }

    pub(super) fn purge_expired_unpaid(&mut self, now_unix_ms: u64) -> Result<(), MempoolApiError> {
        let removals = self
            .entries
            .values()
            .filter(|entry| unpaid_expired(entry, now_unix_ms))
            .map(|entry| entry.content_hash)
            .collect::<Vec<_>>();
        if removals.is_empty() {
            return Ok(());
        }
        self.apply_changes(Vec::new(), removals)
    }

    /// Persist a lifecycle transition as one durable transaction, then publish
    /// the same transition to the in-memory index.
    pub(super) fn apply_changes(
        &mut self,
        replacements: Vec<StoredEntry>,
        removals: Vec<B256>,
    ) -> Result<(), MempoolApiError> {
        if replacements.is_empty() && removals.is_empty() {
            return Ok(());
        }
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_lifecycle_write) {
            return Err(MempoolApiError::Storage(
                "injected lifecycle persistence failure".to_owned(),
            ));
        }
        let encoded = replacements
            .iter()
            .map(|entry| (entry.content_hash, entry.encode()))
            .collect::<Vec<_>>();
        let mut w = self.db.begin_write().map_err(storage_error)?;
        w.set_durability(Durability::Immediate)
            .map_err(storage_error)?;
        {
            let mut table = w.open_table(T_ENTRIES).map_err(storage_error)?;
            for content_hash in &removals {
                table
                    .remove(content_hash.as_slice())
                    .map_err(storage_error)?;
            }
            for (content_hash, value) in &encoded {
                table
                    .insert(content_hash.as_slice(), value.as_slice())
                    .map_err(storage_error)?;
            }
        }
        w.commit().map_err(storage_error)?;

        for content_hash in removals {
            if let Some(entry) = self.entries.remove(&content_hash) {
                self.total_bytes -= entry.raw.len();
            }
        }
        for entry in replacements {
            let bytes = entry.raw.len();
            if let Some(previous) = self.entries.insert(entry.content_hash, entry) {
                self.total_bytes -= previous.raw.len();
            }
            self.total_bytes += bytes;
        }
        Ok(())
    }

    pub(super) fn get(&self, content_hash: &B256) -> Option<&StoredEntry> {
        self.entries.get(content_hash)
    }

    pub(super) fn occupancy(&self) -> pcash_metrics::MempoolOccupancy {
        let mut ready = 0u64;
        let mut included_unfinalized = 0u64;
        let mut suspended = 0u64;
        let mut unpaid_entries = 0u64;
        for entry in self.entries.values() {
            match entry.status {
                MempoolStatus::Ready => ready += 1,
                MempoolStatus::IncludedUnfinalized => included_unfinalized += 1,
                MempoolStatus::Suspended => suspended += 1,
            }
            if entry.unpaid() {
                unpaid_entries += 1;
            }
        }
        pcash_metrics::MempoolOccupancy {
            ready,
            included_unfinalized,
            suspended,
            bytes: self.total_bytes as u64,
            unpaid_entries,
            max_entries: self.limits.max_entries as u64,
            max_bytes: self.limits.max_bytes as u64,
            max_unpaid_entries: self.limits.max_unpaid_entries as u64,
        }
    }

    pub(super) fn conflict_count(&self, entry: &StoredEntry) -> u64 {
        self.entries
            .values()
            .filter(|other| {
                other.content_hash != entry.content_hash
                    && other
                        .metadata
                        .conflict_keys
                        .iter()
                        .any(|key| entry.metadata.conflict_keys.contains(key))
            })
            .count() as u64
    }

    pub(super) fn page(
        &self,
        filter: &MempoolFilter,
    ) -> Result<(Vec<&StoredEntry>, Option<B256>), MempoolApiError> {
        let limit = filter.limit.clamp(1, MAX_PAGE_SIZE);
        let mut matches = self
            .entries
            .values()
            .filter(|entry| {
                let status_matches = match filter.status {
                    // Included entries remain durable here only for reorg
                    // recovery. The ordinary mempool page is the pending queue.
                    None => entry.status != MempoolStatus::IncludedUnfinalized,
                    Some(status) => matches!(
                        (status, &entry.status),
                        (MempoolStatusFilter::Ready, MempoolStatus::Ready)
                            | (MempoolStatusFilter::Suspended, MempoolStatus::Suspended)
                    ),
                };
                let relayer_matches = filter
                    .controlled_issuance_owner_commitments
                    .as_ref()
                    .is_none_or(|commitments| {
                        entry.metadata.has_publication_section
                            && (entry.metadata.issuance_owner_commitment == B256::ZERO
                                || commitments.contains(&entry.metadata.issuance_owner_commitment))
                    });
                filter
                    .arena
                    .as_ref()
                    .is_none_or(|arena| arena.matches(&entry.metadata.public_records))
                    && filter
                        .kind
                        .is_none_or(|kind| entry.metadata.kind.to_dto() == kind)
                    && entry.metadata.open_fee_amount >= filter.min_open_fee
                    && status_matches
                    && relayer_matches
            })
            .collect::<Vec<_>>();
        matches.sort_by(|left, right| {
            let order = match filter.sort {
                MempoolSort::ReceivedAt => right.received_at_unix_ms.cmp(&left.received_at_unix_ms),
                MempoolSort::FeeDensity => fee_density_cmp(
                    right.metadata.open_fee_amount,
                    right.raw.len(),
                    left.metadata.open_fee_amount,
                    left.raw.len(),
                ),
            };
            order.then_with(|| left.content_hash.cmp(&right.content_hash))
        });
        let start = match filter.cursor {
            Some(cursor) => matches
                .iter()
                .position(|entry| entry.content_hash == cursor)
                .map(|position| position + 1)
                .ok_or_else(|| {
                    MempoolApiError::Invalid("mempool cursor is no longer present".into())
                })?,
            None => 0,
        };
        let end = start.saturating_add(limit).min(matches.len());
        let out = matches[start..end].to_vec();
        let next_cursor = (end < matches.len()).then(|| {
            out.last()
                .expect("non-empty bounded mempool page")
                .content_hash
        });
        Ok((out, next_cursor))
    }
}

/// Order two entries by fee per byte without division.
fn fee_density_cmp(
    left_fee: U256,
    left_bytes: usize,
    right_fee: U256,
    right_bytes: usize,
) -> std::cmp::Ordering {
    let left_cross = U512::from(left_fee) * U512::from(right_bytes as u64);
    let right_cross = U512::from(right_fee) * U512::from(left_bytes as u64);
    left_cross.cmp(&right_cross)
}

fn validate_limits(limits: MempoolLimits) -> Result<(), MempoolApiError> {
    if limits.max_entries == 0
        || limits.max_bytes == 0
        || limits.max_unpaid_entries == 0
        || limits.max_unpaid_entries > limits.max_entries
    {
        return Err(MempoolApiError::Storage(
            "mempool limits must be positive and unpaid entries must not exceed total entries"
                .to_owned(),
        ));
    }
    Ok(())
}

pub(super) fn unpaid_expired(entry: &StoredEntry, now_unix_ms: u64) -> bool {
    entry.unpaid() && entry.received_at_unix_ms.saturating_add(UNPAID_TTL_MS) < now_unix_ms
}

pub(crate) fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
