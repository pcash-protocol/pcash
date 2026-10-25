//! Node-owned persistent source-verification registry.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "verification cache entries are validated before use"
)]
//!
//! The service performs no compilation. A public RPC imports a self-contained
//! offline-rebuilt bundle, validates every implementation and configuration
//! opening, and stores the publication under the node data directory. Reads join
//! that persistent material to the current canonical `ContractDto`.

use parking_lot::Mutex;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use alloy_primitives::B256;
#[cfg(test)]
use alloy_primitives::U256;

use crate::dto::MANIFEST_SCHEMA_VERSION;
use crate::dto::{
    BarretenbergToolchain, ConfigurationOpening, ConfigurationOpeningStatus, ConfigurationScheme,
    ConfigurationValue, ContractConfigurationOpeningInput, ContractPresentationConfigurationField,
    ContractPresentationFunction, ContractPresentationProfile, ContractPresentationProofGroup,
    ContractPresentationProofItem, ContractPresentationView, ContractSourceBundle,
    ContractSourceStatus, ContractSourceView, CrsDigests, ImplementationBundle,
    ImplementationSource, ImplementationSourceFile, ImplementationSourceSummary, NargoToolchain,
    SourceFileMetadata, SourceToolchain, SourceVerificationApiError, SourceVerificationInfo,
    SourceVerificationPublication, SourceVerificationStatus, SubmissionStatus,
    SubmittedImplementation, VerificationAuthority, VerificationMethod, Verified,
};
use crate::reference_rules::reference_configuration_domain;
use alloy_primitives::Address;
use pcash_crypto::{poseidon, Fr};
use pcash_rpc::redb_schema::{require_meta_keys, require_tables};
use pcash_rpc::{ContractDto, ContractFunctionDto};
use pcash_state::{fr_from_canonical_bytes, fr_to_bytes};
use redb::{Database, Durability, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MANIFEST_BUNDLE_FORMAT: &str = "pcash-contract-source-bundle-v1";
const PROOF_PROFILE_ID: &str = "pcash-chonk-application-v1";
/// `[authorizationCommitment, actionCommitment, recentPcashBlockHash]`.
const PROOF_PROFILE_RETURN_FIELDS: u64 = 4;
const VERIFICATION_KEY_FIELD_COUNT: usize = 151;
/// ABI schema version the pinned Noir compiler emits.
const NOIR_ABI_VERSION: u64 = 1;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
/// Total decoded attachment bytes one publication may carry, whatever channel
/// sent it. Charged twice: once over the distinct attachments carried, and
/// again over every manifest reference to them, so a manifest that names one
/// attachment from many source paths materializes no more than this.
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = 8 * 1024 * 1024;
/// Compact serialized size of a publication, including attachment names,
/// JSON syntax, base64 padding, and the manifest. Listener limits leave room
/// above this ceiling for the JSON-RPC envelope and alternate serialization.
const MAX_PUBLICATION_WIRE_BYTES: u64 = 14 * 1024 * 1024;
const T_META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
const T_IMPLEMENTATIONS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("implementations");
const T_CONFIGURATION_BINDINGS: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("configuration_bindings");
const T_OPENINGS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("openings");
const T_PRESENTATIONS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("presentations");
/// Accepted permissionless publications keyed by content id, so an identical
/// resubmission is answered from storage without revalidation or rebuilding.
const T_SUBMISSIONS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("submissions");

/// Public-channel ceilings. Independent of the operator publish path and
/// deliberately stricter than what an offline operator may ship.
pub const SUBMISSION_MAX_IMPLEMENTATIONS: u64 = 1024;
pub const SUBMISSION_MAX_AGGREGATE_BYTES: u64 = 64 * 1024 * 1024;

/// Persisted acceptance receipt for one permissionless submission.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredSubmissionRecord {
    pub accepted_at_unix_ms: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub reproduced_implementations: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub configuration_opening_count: u64,
    pub implementations: Vec<SubmittedImplementation>,
}
/// What one accepted publication did to the registry.
pub(crate) struct PublishOutcome {
    pub new_implementations: u64,
    pub merged: ManifestSnapshot,
}

/// Which ingestion channel produced a write. Determines provenance stamps,
/// reproduction strictness, and whether the public ceiling accounts the rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicationOrigin {
    Operator,
    Public,
}

impl PublicationOrigin {
    fn stamps(self) -> (VerificationAuthority, VerificationMethod) {
        match self {
            Self::Operator => (
                VerificationAuthority::NodeOperator,
                VerificationMethod::NodeRegistry,
            ),
            Self::Public => (
                VerificationAuthority::PublicSubmission,
                VerificationMethod::SubmittedBundle,
            ),
        }
    }
}
/// `u32_be(pcashChainId) || genesisHash[32]`.
const META_LEN: usize = 4 + 32;
const META_KEY: &str = "source_registry";
const OPENING_KEY_LEN: usize = 20 + 1 + 32 + 32;
const CONFIGURATION_BINDING_KEY_LEN: usize = 1 + 32;

/// Operator manifest schema. Unknown fields are tolerated as forward-compatible
/// operator metadata but have no verification meaning in schema version 1.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    bundle_format: String,
    #[serde(default)]
    service_name: Option<String>,
    proof_profile: ProofProfileManifest,
    presentation: ContractPresentationProfileManifest,
    implementations: Vec<ImplementationManifest>,
    configuration_bindings: Vec<ConfigurationBindingManifest>,
    configuration_openings: Vec<ConfigurationOpeningManifest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProofProfileManifest {
    id: String,
    return_fields: u64,
    return_visibility: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImplementationManifest {
    application_vk_hash: String,
    implementation_label: String,
    package_root: String,
    package_name: String,
    source_bundle_digest: String,
    source_files: Vec<SourceFileManifest>,
    compiler_artifact: CompilerArtifactManifest,
    noir_proving_abi: AttachmentManifest,
    verification_key: VerificationKeyManifest,
    toolchain: ToolchainManifest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationBindingManifest {
    application_vk_hash: String,
    configuration_profile: ConfigurationProfileManifest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceFileManifest {
    path: String,
    attachment: String,
    length: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentManifest {
    attachment: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompilerArtifactManifest {
    attachment: String,
    sha256: String,
    decoded_acir_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerificationKeyManifest {
    attachment: String,
    sha256: String,
    field_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolchainManifest {
    release_manifest_sha256: String,
    producer_platform: String,
    nargo: NargoManifest,
    barretenberg: BarretenbergManifest,
    crs: CrsManifest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NargoManifest {
    version: String,
    noirc_commit: String,
    archive_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BarretenbergManifest {
    version: String,
    verifier_target: String,
    archive_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CrsManifest {
    bn254_g1_sha256: String,
    bn254_g2_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationProfileManifest {
    id: String,
    implementation_label: String,
    selector: u8,
    scheme: String,
    domain: String,
    fields: Vec<ConfigurationFieldManifest>,
}

#[derive(Clone, Debug, Deserialize)]
struct ConfigurationFieldManifest {
    name: String,
    #[serde(rename = "type")]
    value_type: String,
    #[serde(default)]
    bits: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationOpeningManifest {
    address: String,
    selector: u8,
    application_vk_hash: String,
    configuration_commitment: String,
    domain: String,
    values: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContractPresentationProfileManifest {
    schema_version: u32,
    publisher_label: String,
    contract_name: String,
    contract_description: String,
    functions: Vec<ContractPresentationFunctionManifest>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContractPresentationFunctionManifest {
    selector: u8,
    application_vk_hash: String,
    name: String,
    summary: String,
    configuration_fields: Vec<ContractPresentationConfigurationFieldManifest>,
    proof_groups: Vec<ContractPresentationProofGroupManifest>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContractPresentationConfigurationFieldManifest {
    position: u64,
    name: String,
    label: String,
    description: String,
    display_format: String,
    overview_order: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContractPresentationProofGroupManifest {
    title: String,
    description: String,
    items: Vec<ContractPresentationProofItemManifest>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContractPresentationProofItemManifest {
    abi_parameter: String,
    description: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct StoredContractPresentation {
    verification_authority: VerificationAuthority,
    verification_method: VerificationMethod,
    profile: ContractPresentationProfile,
}

impl StoredContractPresentation {
    fn view(&self) -> ContractPresentationView {
        ContractPresentationView {
            verification_authority: self.verification_authority,
            verification_method: self.verification_method,
            profile: self.profile.clone(),
        }
    }
}

fn presentation_shape_key(functions: &[ContractPresentationFunction]) -> B256 {
    let mut hash = Sha256::new();
    hash.update(b"pcash.contract-presentation-shape\0");
    hash.update((functions.len() as u64).to_be_bytes());
    for function in functions {
        hash.update([function.selector]);
        hash.update(function.application_vk_hash.as_slice());
    }
    B256::from(<[u8; 32]>::from(hash.finalize()))
}

fn contract_presentation_shape_key(functions: &[ContractFunctionDto]) -> B256 {
    let mut hash = Sha256::new();
    hash.update(b"pcash.contract-presentation-shape\0");
    hash.update((functions.len() as u64).to_be_bytes());
    for function in functions {
        hash.update([function.selector]);
        hash.update(function.application_vk_hash.as_slice());
    }
    B256::from(<[u8; 32]>::from(hash.finalize()))
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
struct StoredConfigurationProfile {
    selector: u8,
    domain: B256,
    fields: Vec<StoredConfigurationField>,
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
struct StoredConfigurationField {
    name: String,
    value_type: String,
    bits: Option<u16>,
}

#[derive(Clone, Deserialize, Serialize)]
struct StoredSourceFile {
    metadata: SourceFileMetadata,
    content: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct StoredImplementation {
    pub(crate) summary: ImplementationSourceSummary,
    files: Vec<StoredSourceFile>,
    noir_proving_abi: Value,
}

#[derive(Clone, Deserialize, Serialize)]
struct StoredConfigurationBinding {
    verification_authority: VerificationAuthority,
    verification_method: VerificationMethod,
    profile: StoredConfigurationProfile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ConfigurationBindingKey {
    selector: u8,
    application_vk_hash: B256,
}

impl ConfigurationBindingKey {
    fn for_function(function: &ContractFunctionDto) -> Self {
        Self {
            selector: function.selector,
            application_vk_hash: function.application_vk_hash,
        }
    }

    fn encode(self) -> [u8; CONFIGURATION_BINDING_KEY_LEN] {
        let mut encoded = [0u8; CONFIGURATION_BINDING_KEY_LEN];
        encoded[0] = self.selector;
        encoded[1..].copy_from_slice(self.application_vk_hash.as_slice());
        encoded
    }

    fn decode(encoded: &[u8]) -> Result<Self, SourceVerificationApiError> {
        if encoded.len() != CONFIGURATION_BINDING_KEY_LEN {
            return Err(storage(
                "source-registry configuration-binding key is malformed",
            ));
        }
        Ok(Self {
            selector: encoded[0],
            application_vk_hash: B256::from_slice(&encoded[1..]),
        })
    }
}

impl StoredImplementation {
    fn source(&self) -> ImplementationSource {
        ImplementationSource {
            summary: self.summary.clone(),
            source_files: self
                .files
                .iter()
                .map(|file| file.metadata.clone())
                .collect(),
            noir_proving_abi: self.noir_proving_abi.clone(),
        }
    }

    fn source_file(&self, path: &str) -> Option<ImplementationSourceFile> {
        self.files
            .iter()
            .find(|file| file.metadata.path == path)
            .map(|file| ImplementationSourceFile {
                application_vk_hash: self.summary.application_vk_hash,
                path: file.metadata.path.clone(),
                sha256: file.metadata.sha256,
                content: file.content.clone(),
            })
    }

    fn bundle(&self) -> ImplementationBundle {
        ImplementationBundle {
            source: self.source(),
            files: self
                .files
                .iter()
                .map(|file| ImplementationSourceFile {
                    application_vk_hash: self.summary.application_vk_hash,
                    path: file.metadata.path.clone(),
                    sha256: file.metadata.sha256,
                    content: file.content.clone(),
                })
                .collect(),
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) enum StoredConfigurationOpening {
    Valid {
        verification_authority: VerificationAuthority,
        application_vk_hash: B256,
        configuration_commitment: B256,
        domain: B256,
        values: Vec<B256>,
        computed: B256,
    },
    Invalid {
        error: String,
    },
}

impl StoredConfigurationOpening {
    fn same_material(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::Valid {
                    application_vk_hash: left_vk,
                    configuration_commitment: left_commitment,
                    domain: left_domain,
                    values: left_values,
                    computed: left_computed,
                    ..
                },
                Self::Valid {
                    application_vk_hash: right_vk,
                    configuration_commitment: right_commitment,
                    domain: right_domain,
                    values: right_values,
                    computed: right_computed,
                    ..
                },
            ) => {
                left_vk == right_vk
                    && left_commitment == right_commitment
                    && left_domain == right_domain
                    && left_values == right_values
                    && left_computed == right_computed
            }
            (Self::Invalid { error: left }, Self::Invalid { error: right }) => left == right,
            _ => false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct OpeningKey {
    pub(crate) address: Address,
    pub(crate) selector: u8,
    pub(crate) application_vk_hash: B256,
    configuration_commitment: B256,
}

impl OpeningKey {
    fn for_function(address: Address, function: &ContractFunctionDto) -> Self {
        Self {
            address,
            selector: function.selector,
            application_vk_hash: function.application_vk_hash,
            configuration_commitment: function.configuration_commitment,
        }
    }

    fn encode(self) -> [u8; OPENING_KEY_LEN] {
        let mut encoded = [0u8; OPENING_KEY_LEN];
        encoded[..20].copy_from_slice(self.address.as_slice());
        encoded[20] = self.selector;
        encoded[21..53].copy_from_slice(self.application_vk_hash.as_slice());
        encoded[53..85].copy_from_slice(self.configuration_commitment.as_slice());
        encoded
    }

    fn decode(encoded: &[u8]) -> Result<Self, SourceVerificationApiError> {
        if encoded.len() != OPENING_KEY_LEN {
            return Err(storage("source-registry opening key is malformed"));
        }
        Ok(Self {
            address: Address::from_slice(&encoded[..20]),
            selector: encoded[20],
            application_vk_hash: B256::from_slice(&encoded[21..53]),
            configuration_commitment: B256::from_slice(&encoded[53..85]),
        })
    }
}

#[derive(Clone)]
pub(crate) struct ManifestSnapshot {
    pub(crate) service_name: Option<String>,
    pub(crate) implementations: HashMap<B256, Arc<StoredImplementation>>,
    configuration_bindings: HashMap<ConfigurationBindingKey, StoredConfigurationBinding>,
    pub(crate) openings: HashMap<OpeningKey, StoredConfigurationOpening>,
    presentations: HashMap<B256, StoredContractPresentation>,
    pub(crate) opening_count: u64,
    pub(crate) invalid_opening_count: u64,
    /// Rows attributable to the permissionless submission channel, with their
    /// persisted byte cost — the budget the public ceiling is enforced against.
    pub(crate) submitted_implementations: u64,
    pub(crate) submitted_bytes: u64,
}

impl ManifestSnapshot {
    pub(crate) fn presentation_matches_contract(&self, contract: &ContractDto) -> bool {
        self.presentations
            .contains_key(&contract_presentation_shape_key(&contract.functions))
            && contract.functions.iter().all(|function| {
                self.configuration_bindings
                    .contains_key(&ConfigurationBindingKey::for_function(function))
            })
    }
}

enum RegistrySnapshot {
    Unloaded,
    Ready(Arc<ManifestSnapshot>),
    Unavailable(String),
}

enum SourceBackend {
    Disabled,
    Registry(Database),
    Unavailable,
}

/// Persistent source registry. `disabled` exists only for transport fixtures;
/// a running node always opens the registry database.
pub struct SourceVerificationService {
    backend: SourceBackend,
    state: Mutex<RegistrySnapshot>,
    reproducer: Option<PathBuf>,
    write_error: Mutex<Option<String>>,
    reproducer_error: Mutex<Option<String>>,
    reproduce_publications: bool,
    source_submissions_enabled: bool,
    configuration_opening_submissions_enabled: bool,
    pcash_chain_id: u32,
    genesis_hash: B256,
}

impl SourceVerificationService {
    pub fn disabled() -> Self {
        Self {
            backend: SourceBackend::Disabled,
            state: Mutex::new(RegistrySnapshot::Unloaded),
            reproducer: None,
            write_error: Mutex::new(None),
            reproducer_error: Mutex::new(None),
            reproduce_publications: false,
            source_submissions_enabled: false,
            configuration_opening_submissions_enabled: false,
            pcash_chain_id: 0,
            genesis_hash: B256::ZERO,
        }
    }

    pub fn open(
        path: impl AsRef<Path>,
        pcash_chain_id: u32,
        genesis_hash: B256,
        reproducer: Option<PathBuf>,
    ) -> Self {
        let path = path.as_ref();
        let opened = open_registry(path, pcash_chain_id, genesis_hash)
            .and_then(|db| load_registry(&db).map(|snapshot| (db, snapshot)));
        Self::from_opened_registry(
            opened,
            pcash_chain_id,
            genesis_hash,
            reproducer,
            &path.display().to_string(),
        )
    }

    pub fn open_in_memory(
        pcash_chain_id: u32,
        genesis_hash: B256,
        reproducer: Option<PathBuf>,
    ) -> Self {
        let opened = Database::builder()
            .create_with_backend(redb::backends::InMemoryBackend::new())
            .map_err(storage)
            .and_then(|db| initialize_registry(db, false, pcash_chain_id, genesis_hash))
            .and_then(|db| load_registry(&db).map(|snapshot| (db, snapshot)));
        Self::from_opened_registry(opened, pcash_chain_id, genesis_hash, reproducer, "memory")
    }

    fn from_opened_registry(
        opened: Result<(Database, ManifestSnapshot), SourceVerificationApiError>,
        pcash_chain_id: u32,
        genesis_hash: B256,
        reproducer: Option<PathBuf>,
        location: &str,
    ) -> Self {
        match opened {
            Ok((db, snapshot)) => {
                let reproducer_error = match reproducer.as_deref() {
                    Some(path) => check_reproducer(path).err(),
                    None => Some("source reproducer is not configured".to_owned()),
                };
                if let Some(error) = &reproducer_error {
                    tracing::warn!(%location, %error, "source reproduction is unavailable");
                } else {
                    tracing::info!(%location, "source registry ready");
                }
                Self {
                    backend: SourceBackend::Registry(db),
                    state: Mutex::new(RegistrySnapshot::Ready(Arc::new(snapshot))),
                    reproducer,
                    write_error: Mutex::new(None),
                    reproducer_error: Mutex::new(reproducer_error),
                    reproduce_publications: true,
                    source_submissions_enabled: false,
                    configuration_opening_submissions_enabled: false,
                    pcash_chain_id,
                    genesis_hash,
                }
            }
            Err(error) => {
                let message = error.to_string();
                tracing::error!(%location, %message, "source registry unavailable");
                Self {
                    backend: SourceBackend::Unavailable,
                    state: Mutex::new(RegistrySnapshot::Unavailable(message.clone())),
                    reproducer,
                    write_error: Mutex::new(Some(message)),
                    reproducer_error: Mutex::new(None),
                    reproduce_publications: true,
                    source_submissions_enabled: false,
                    configuration_opening_submissions_enabled: false,
                    pcash_chain_id,
                    genesis_hash,
                }
            }
        }
    }

    /// Opts the node into the permissionless `pscan_submitContractSource`
    /// channel on this registry. Off by default; the pscan listener reports
    /// `sourceSubmissionStatus: "disabled"` until this is called.
    pub fn enable_source_submissions(mut self) -> Self {
        self.source_submissions_enabled = true;
        self
    }

    pub fn enable_configuration_opening_submissions(mut self) -> Self {
        self.configuration_opening_submissions_enabled = true;
        self
    }

    pub(crate) fn source_submissions_enabled(&self) -> bool {
        self.source_submissions_enabled
    }

    pub(crate) fn configuration_opening_submissions_enabled(&self) -> bool {
        self.configuration_opening_submissions_enabled
    }

    /// Provenance currently stored for an implementation, if any. The
    /// submission channel uses it so resubmitting a known vk reports the
    /// original channel rather than the resubmitter's.
    pub(crate) fn implementation_origin(
        &self,
        application_vk_hash: &B256,
    ) -> Option<(VerificationAuthority, VerificationMethod)> {
        let snapshot = self.snapshot().ok()?;
        let implementation = snapshot.implementations.get(application_vk_hash)?;
        Some((
            implementation.summary.verification_authority,
            implementation.summary.verification_method,
        ))
    }

    /// Stored acceptance receipt for a content id, if this registry already
    /// accepted that exact publication.
    pub(crate) fn submission_receipt(
        &self,
        content_id: &B256,
    ) -> Result<Option<StoredSubmissionRecord>, SourceVerificationApiError> {
        let db = match &self.backend {
            SourceBackend::Registry(db) => db,
            _ => return Ok(None),
        };
        let read = db.begin_read().map_err(storage)?;
        let table = read.open_table(T_SUBMISSIONS).map_err(storage)?;
        match table.get(content_id.as_slice()).map_err(storage)? {
            Some(row) => Ok(Some(serde_json::from_slice(row.value()).map_err(
                |error| storage(format!("decode submission receipt: {error}")),
            )?)),
            None => Ok(None),
        }
    }

    #[cfg(test)]
    fn open_without_reproduction(
        path: impl AsRef<Path>,
        pcash_chain_id: u32,
        genesis_hash: B256,
    ) -> Self {
        let mut service = Self::open(path, pcash_chain_id, genesis_hash, None);
        service.reproduce_publications = false;
        *service.write_error.lock() = None;
        *service.reproducer_error.lock() = None;
        service
    }

    pub fn info(&self) -> SourceVerificationInfo {
        if matches!(self.backend, SourceBackend::Disabled) {
            return SourceVerificationInfo::disabled();
        }
        match self.snapshot() {
            Ok(snapshot) => {
                let write_error = self.write_error.lock().clone();
                let reproducer_error = self.reproducer_error.lock().clone();
                let source_error = write_error.clone().or(reproducer_error);
                let source_submission_status =
                    match (self.source_submissions_enabled, &source_error) {
                        (false, _) => SubmissionStatus::Disabled,
                        (true, None) => SubmissionStatus::Ready,
                        (true, Some(_)) => SubmissionStatus::Unavailable,
                    };
                let configuration_opening_submission_status =
                    match (self.configuration_opening_submissions_enabled, &write_error) {
                        (false, _) => SubmissionStatus::Disabled,
                        (true, None) => SubmissionStatus::Ready,
                        (true, Some(_)) => SubmissionStatus::Unavailable,
                    };
                SourceVerificationInfo {
                    writable: write_error.is_none() && source_error.is_none(),
                    error: source_error,
                    service_name: snapshot.service_name.clone(),
                    implementation_count: snapshot.implementations.len() as u64,
                    configuration_opening_count: snapshot.opening_count,
                    invalid_configuration_opening_count: snapshot.invalid_opening_count,
                    pcash_chain_id: self.pcash_chain_id,
                    genesis_hash: Some(self.genesis_hash),
                    source_submission_status,
                    configuration_opening_submission_status,
                    submitted_implementation_count: snapshot.submitted_implementations,
                    ..SourceVerificationInfo::new(SourceVerificationStatus::Ready)
                }
            }
            Err(error) => SourceVerificationInfo {
                error: Some(error.to_string()),
                ..SourceVerificationInfo::new(SourceVerificationStatus::Unavailable)
            },
        }
    }

    pub fn implementation_source(
        &self,
        application_vk_hash: &B256,
    ) -> Result<Option<ImplementationSource>, SourceVerificationApiError> {
        let snapshot = self.snapshot()?;
        Ok(snapshot
            .implementations
            .get(application_vk_hash)
            .map(|implementation| implementation.source()))
    }

    pub fn implementation_source_file(
        &self,
        application_vk_hash: &B256,
        path: &str,
    ) -> Result<Option<ImplementationSourceFile>, SourceVerificationApiError> {
        let snapshot = self.snapshot()?;
        Ok(snapshot
            .implementations
            .get(application_vk_hash)
            .and_then(|implementation| implementation.source_file(path)))
    }

    pub fn contract_source(
        &self,
        contract: ContractDto,
    ) -> Result<ContractSourceView, SourceVerificationApiError> {
        let snapshot = self.snapshot()?;
        Ok(build_contract_view(&snapshot, contract))
    }

    /// Directory-sized correspondence status without constructing a current
    /// account proof or copying implementation metadata into every row.
    pub fn contract_summary(
        &self,
        address: Address,
        functions: &[ContractFunctionDto],
    ) -> Result<(ContractSourceStatus, u64), SourceVerificationApiError> {
        let snapshot = self.snapshot()?;
        let status = contract_status(&snapshot, functions);
        let opening_count = if status == ContractSourceStatus::Verified {
            functions
                .iter()
                .filter(|function| {
                    matches!(
                        snapshot
                            .openings
                            .get(&OpeningKey::for_function(address, function)),
                        Some(StoredConfigurationOpening::Valid { .. })
                    )
                })
                .count() as u64
        } else {
            0
        };
        Ok((status, opening_count))
    }

    pub fn contract_bundle(
        &self,
        contract: ContractDto,
    ) -> Result<ContractSourceBundle, SourceVerificationApiError> {
        let snapshot = self.snapshot()?;
        let view = build_contract_view(&snapshot, contract);
        let mut seen = HashSet::new();
        let implementations = if view.status == ContractSourceStatus::Verified {
            view.contract
                .functions
                .iter()
                .filter_map(|function| {
                    seen.insert(function.application_vk_hash)
                        .then(|| snapshot.implementations.get(&function.application_vk_hash))
                        .flatten()
                        .map(|implementation| implementation.bundle())
                })
                .collect()
        } else {
            Vec::new()
        };
        Ok(ContractSourceBundle {
            view,
            implementations,
        })
    }

    /// Operator ingest: validate, rebuild anything new through the configured
    /// reproducer, and persist. Provenance is stamped `node_operator`.
    pub fn publish(
        &self,
        publication: SourceVerificationPublication,
    ) -> Result<SourceVerificationInfo, SourceVerificationApiError> {
        self.publish_inner(publication, PublicationOrigin::Operator, None)?;
        Ok(self.info())
    }

    /// Persist one complete set of instance configuration openings after
    /// checking it against both the live contract and the configuration
    /// profiles already established by verified source. This path never
    /// imports source, bindings, presentation copy, or provenance.
    pub(crate) fn submit_contract_configuration_openings(
        &self,
        contract: &ContractDto,
        inputs: &[ContractConfigurationOpeningInput],
    ) -> Result<bool, SourceVerificationApiError> {
        let db = match &self.backend {
            SourceBackend::Registry(db) => db,
            SourceBackend::Disabled => return Err(SourceVerificationApiError::Disabled),
            SourceBackend::Unavailable => {
                return Err(SourceVerificationApiError::Unavailable(
                    self.write_error
                        .lock()
                        .clone()
                        .unwrap_or_else(|| "source registry is unavailable".to_owned()),
                ));
            }
        };
        if let Some(error) = self.write_error.lock().clone() {
            return Err(SourceVerificationApiError::Unavailable(error));
        }

        let mut state = self.state.lock();
        let RegistrySnapshot::Ready(current) = &*state else {
            return Err(SourceVerificationApiError::Unavailable(
                "source registry snapshot is unavailable".to_owned(),
            ));
        };
        if contract_status(current, &contract.functions) != ContractSourceStatus::Verified {
            return Err(SourceVerificationApiError::Invalid(
                "contract source is not verified for the live immutable function set".to_owned(),
            ));
        }
        if inputs.len() != contract.functions.len() {
            return Err(SourceVerificationApiError::Invalid(format!(
                "opening submission must cover all {} live contract functions exactly once",
                contract.functions.len()
            )));
        }

        let expected_selectors = contract
            .functions
            .iter()
            .map(|function| function.selector)
            .collect::<HashSet<_>>();
        if expected_selectors.len() != contract.functions.len() {
            return Err(SourceVerificationApiError::Invalid(
                "live contract has duplicate function selectors".to_owned(),
            ));
        }

        let mut imported = empty_snapshot();
        imported.opening_count = inputs.len() as u64;
        for input in inputs {
            let function = contract
                .functions
                .iter()
                .find(|function| function.selector == input.selector)
                .ok_or_else(|| {
                    SourceVerificationApiError::Invalid(format!(
                        "selector {} is not in the live contract",
                        input.selector
                    ))
                })?;
            if input.application_vk_hash != function.application_vk_hash {
                return Err(SourceVerificationApiError::Invalid(format!(
                    "selector {} applicationVkHash does not match the live contract",
                    input.selector
                )));
            }
            if input.configuration_commitment != function.configuration_commitment {
                return Err(SourceVerificationApiError::Invalid(format!(
                    "selector {} configurationCommitment does not match the live contract",
                    input.selector
                )));
            }
            require_canonical_field(&input.application_vk_hash, "applicationVkHash")?;
            require_canonical_field(&input.configuration_commitment, "configurationCommitment")?;
            let domain = require_canonical_field(&input.domain, "configuration domain")?;
            let values = input
                .values
                .iter()
                .enumerate()
                .map(|(position, value)| {
                    require_canonical_field(value, &format!("configuration value {position}"))
                })
                .collect::<Result<Vec<_>, _>>()?;

            let binding_key = ConfigurationBindingKey::for_function(function);
            let binding = current
                .configuration_bindings
                .get(&binding_key)
                .ok_or_else(|| {
                    SourceVerificationApiError::Invalid(format!(
                        "selector {} has no verified configuration binding",
                        input.selector
                    ))
                })?;
            if input.domain != fr_to_bytes(reference_configuration_domain())
                || binding.profile.domain != input.domain
                || binding.profile.fields.len() != input.values.len()
                || !binding
                    .profile
                    .fields
                    .iter()
                    .zip(&input.values)
                    .all(|(field, value)| {
                        field
                            .bits
                            .is_none_or(|bits| fits_unsigned_bits(value, bits))
                    })
            {
                return Err(SourceVerificationApiError::Invalid(format!(
                    "selector {} opening does not match its verified configuration profile",
                    input.selector
                )));
            }

            let mut commitment_inputs = Vec::with_capacity(values.len() + 1);
            commitment_inputs.push(domain);
            commitment_inputs.extend(values);
            let computed = fr_to_bytes(poseidon(&commitment_inputs));
            if computed != input.configuration_commitment {
                return Err(SourceVerificationApiError::Invalid(format!(
                    "selector {} opening values do not match its live configuration commitment",
                    input.selector
                )));
            }

            let key = OpeningKey::for_function(contract.address, function);
            let opening = StoredConfigurationOpening::Valid {
                verification_authority: VerificationAuthority::PublicSubmission,
                application_vk_hash: input.application_vk_hash,
                configuration_commitment: input.configuration_commitment,
                domain: input.domain,
                values: input.values.clone(),
                computed,
            };
            if imported.openings.insert(key, opening).is_some() {
                return Err(SourceVerificationApiError::Invalid(format!(
                    "selector {} appears more than once",
                    input.selector
                )));
            }
        }
        if imported.openings.len() != expected_selectors.len() {
            return Err(SourceVerificationApiError::Invalid(
                "opening submission does not cover the live function set".to_owned(),
            ));
        }

        let mut has_new_opening = false;
        for (key, opening) in &imported.openings {
            match current.openings.get(key) {
                Some(stored) if stored.same_material(opening) => {}
                Some(_) => {
                    return Err(SourceVerificationApiError::Conflict(format!(
                        "contract 0x{} selector {} already has different opening values",
                        hex::encode(key.address),
                        key.selector,
                    )));
                }
                None => has_new_opening = true,
            }
        }
        if !has_new_opening {
            return Ok(true);
        }

        enforce_submission_budget(current, &imported)?;
        let merged = merge_snapshots(
            (**current).clone(),
            imported.clone(),
            PublicationOrigin::Public,
        )?;
        if let Err(error) = store_delta(db, &imported, None) {
            self.mark_write_unavailable(error.to_string());
            return Err(error);
        }
        *state = RegistrySnapshot::Ready(Arc::new(merged));
        Ok(false)
    }

    pub(crate) fn publish_inner(
        &self,
        publication: SourceVerificationPublication,
        origin: PublicationOrigin,
        receipt: Option<(B256, StoredSubmissionRecord)>,
    ) -> Result<PublishOutcome, SourceVerificationApiError> {
        let db = match &self.backend {
            SourceBackend::Registry(db) => db,
            SourceBackend::Disabled => return Err(SourceVerificationApiError::Disabled),
            SourceBackend::Unavailable => {
                return Err(SourceVerificationApiError::Unavailable(
                    self.write_error
                        .lock()
                        .clone()
                        .unwrap_or_else(|| "source registry is unavailable".to_owned()),
                ));
            }
        };
        // The operator channel stays read-only without a healthy reproducer;
        // the public channel enforces its reproducer requirement lazily below,
        // because opening-only contributions never invoke it.
        if origin == PublicationOrigin::Operator {
            if let Some(error) = self
                .write_error
                .lock()
                .clone()
                .or_else(|| self.reproducer_error.lock().clone())
            {
                return Err(SourceVerificationApiError::Unavailable(error));
            }
        }
        let mut imported =
            load_publication(&publication).map_err(SourceVerificationApiError::Invalid)?;
        if imported.invalid_opening_count != 0 {
            return Err(SourceVerificationApiError::Invalid(
                "publication contains an invalid configuration opening".to_owned(),
            ));
        }
        stamp_origin(&mut imported, origin);

        let new_implementations = {
            let state = self.state.lock();
            let RegistrySnapshot::Ready(current) = &*state else {
                return Err(SourceVerificationApiError::Unavailable(
                    "source registry snapshot is unavailable".to_owned(),
                ));
            };
            merge_snapshots((**current).clone(), imported.clone(), origin)?;
            if origin == PublicationOrigin::Public
                && enforce_submission_budget(current, &imported)? == (0, 0)
            {
                return Err(SourceVerificationApiError::Invalid(
                    "publication adds no new registry material".to_owned(),
                ));
            }
            imported
                .implementations
                .keys()
                .filter(|key| !current.implementations.contains_key(*key))
                .count() as u64
        };
        if new_implementations > 0
            && (origin == PublicationOrigin::Public || self.reproduce_publications)
        {
            let reproducer = self.reproducer.as_deref().ok_or_else(|| {
                SourceVerificationApiError::Unavailable(
                    "source reproducer is not configured".to_owned(),
                )
            })?;
            match reproduce_publication(&publication, reproducer) {
                Ok(()) => {}
                Err(ReproductionError::Rejected(error)) => {
                    return Err(SourceVerificationApiError::Invalid(error));
                }
                Err(ReproductionError::Unavailable(error)) => {
                    self.mark_reproducer_unavailable(error.clone());
                    return Err(SourceVerificationApiError::Unavailable(error));
                }
            }
        }

        // Recheck after reproduction: another publisher may have completed
        // while the compiler was running. Only the ceilings apply here; that
        // publisher may already have stored some or all of this material.
        let mut state = self.state.lock();
        let RegistrySnapshot::Ready(current) = &*state else {
            return Err(SourceVerificationApiError::Unavailable(
                "source registry snapshot is unavailable".to_owned(),
            ));
        };
        let merged = merge_snapshots((**current).clone(), imported.clone(), origin)?;
        if origin == PublicationOrigin::Public {
            enforce_submission_budget(current, &imported)?;
        }
        if let Err(error) = store_delta(db, &imported, receipt.as_ref()) {
            self.mark_write_unavailable(error.to_string());
            return Err(error);
        }
        *state = RegistrySnapshot::Ready(Arc::new(merged.clone()));
        drop(state);
        Ok(PublishOutcome {
            new_implementations,
            merged,
        })
    }

    fn mark_write_unavailable(&self, error: String) {
        let mut stored = self.write_error.lock();
        if stored.is_none() {
            tracing::error!(%error, "source registry became read-only");
            *stored = Some(error);
        }
    }

    fn mark_reproducer_unavailable(&self, error: String) {
        let mut stored = self.reproducer_error.lock();
        if stored.is_none() {
            tracing::error!(%error, "source reproduction became unavailable");
            *stored = Some(error);
        }
    }

    fn snapshot(&self) -> Result<Arc<ManifestSnapshot>, SourceVerificationApiError> {
        match &self.backend {
            SourceBackend::Disabled => Err(SourceVerificationApiError::Disabled),
            SourceBackend::Registry(_) | SourceBackend::Unavailable => match &*self.state.lock() {
                RegistrySnapshot::Ready(snapshot) => Ok(snapshot.clone()),
                RegistrySnapshot::Unavailable(error) => {
                    Err(SourceVerificationApiError::Unavailable(error.clone()))
                }
                RegistrySnapshot::Unloaded => Err(SourceVerificationApiError::Unavailable(
                    "source registry snapshot is not loaded".to_owned(),
                )),
            },
        }
    }
}

fn build_contract_view(snapshot: &ManifestSnapshot, contract: ContractDto) -> ContractSourceView {
    let status = contract_status(snapshot, &contract.functions);
    let (implementations, configuration_openings, presentation) =
        if status == ContractSourceStatus::Verified {
            let mut seen = HashSet::new();
            let implementations = contract
                .functions
                .iter()
                .filter_map(|function| {
                    seen.insert(function.application_vk_hash)
                        .then(|| snapshot.implementations.get(&function.application_vk_hash))
                        .flatten()
                        .map(|implementation| implementation.summary.clone())
                })
                .collect::<Vec<_>>();
            let configuration_openings = contract
                .functions
                .iter()
                .filter_map(|function| {
                    snapshot
                        .openings
                        .get(&OpeningKey::for_function(contract.address, function))
                        .map(|opening| {
                            opening_to_dto(
                                opening,
                                function,
                                snapshot
                                    .configuration_bindings
                                    .get(&ConfigurationBindingKey::for_function(function)),
                            )
                        })
                })
                .collect();
            let presentation = snapshot
                .presentations
                .get(&contract_presentation_shape_key(&contract.functions))
                .map(StoredContractPresentation::view);
            debug_assert!(
                presentation.is_some(),
                "verified contract has a presentation"
            );
            (implementations, configuration_openings, presentation)
        } else {
            (Vec::new(), Vec::new(), None)
        };
    ContractSourceView {
        address: contract.address,
        status,
        contract,
        implementations,
        configuration_openings,
        presentation,
    }
}

fn contract_status(
    snapshot: &ManifestSnapshot,
    functions: &[ContractFunctionDto],
) -> ContractSourceStatus {
    if !functions.is_empty()
        && functions.iter().all(|function| {
            snapshot
                .implementations
                .contains_key(&function.application_vk_hash)
        })
        && functions.iter().all(|function| {
            snapshot
                .configuration_bindings
                .contains_key(&ConfigurationBindingKey::for_function(function))
        })
        && snapshot
            .presentations
            .contains_key(&contract_presentation_shape_key(functions))
    {
        ContractSourceStatus::Verified
    } else {
        ContractSourceStatus::NotVerified
    }
}

fn opening_to_dto(
    opening: &StoredConfigurationOpening,
    function: &ContractFunctionDto,
    binding: Option<&StoredConfigurationBinding>,
) -> ConfigurationOpening {
    match opening {
        StoredConfigurationOpening::Valid {
            domain,
            values,
            computed,
            ..
        } => {
            let profile = binding.map(|binding| &binding.profile);
            ConfigurationOpening {
                selector: function.selector,
                status: ConfigurationOpeningStatus::Verified,
                scheme: ConfigurationScheme::PoseidonExplicitDomainPositional,
                domain: Some(*domain),
                values: values
                    .iter()
                    .enumerate()
                    .map(|(position, value)| ConfigurationValue {
                        position: position as u64,
                        value: *value,
                        name: profile.map(|profile| profile.fields[position].name.clone()),
                        value_type: profile
                            .map(|profile| profile.fields[position].value_type.clone()),
                    })
                    .collect(),
                expected_configuration_commitment: function.configuration_commitment,
                computed_configuration_commitment: Some(*computed),
                error: None,
            }
        }
        StoredConfigurationOpening::Invalid { error } => invalid_opening(
            function.selector,
            function.configuration_commitment,
            error.clone(),
        ),
    }
}

fn invalid_opening(selector: u8, expected: B256, error: String) -> ConfigurationOpening {
    ConfigurationOpening {
        selector,
        status: ConfigurationOpeningStatus::Invalid,
        scheme: ConfigurationScheme::PoseidonExplicitDomainPositional,
        domain: None,
        values: Vec::new(),
        expected_configuration_commitment: expected,
        computed_configuration_commitment: None,
        error: Some(error),
    }
}

pub fn source_registry_path_for(state_path: &Path) -> PathBuf {
    state_path.with_extension("source.redb")
}

fn storage(error: impl fmt::Display) -> SourceVerificationApiError {
    SourceVerificationApiError::Storage(error.to_string())
}

fn empty_snapshot() -> ManifestSnapshot {
    ManifestSnapshot {
        service_name: None,
        implementations: HashMap::new(),
        configuration_bindings: HashMap::new(),
        openings: HashMap::new(),
        presentations: HashMap::new(),
        opening_count: 0,
        invalid_opening_count: 0,
        submitted_implementations: 0,
        submitted_bytes: 0,
    }
}

fn open_registry(
    path: &Path,
    pcash_chain_id: u32,
    genesis_hash: B256,
) -> Result<Database, SourceVerificationApiError> {
    let existed = path.exists();
    let db = Database::create(path).map_err(storage)?;
    initialize_registry(db, existed, pcash_chain_id, genesis_hash)
}

fn initialize_registry(
    db: Database,
    existed: bool,
    pcash_chain_id: u32,
    genesis_hash: B256,
) -> Result<Database, SourceVerificationApiError> {
    if existed {
        require_tables(
            &db,
            &[
                "implementations",
                "configuration_bindings",
                "meta",
                "openings",
                "presentations",
                "submissions",
            ],
        )
        .map_err(|_| storage("incompatible source-registry table schema"))?;
        let read = db.begin_read().map_err(storage)?;
        let meta = read.open_table(T_META).map_err(storage)?;
        let keys = meta
            .iter()
            .map_err(storage)?
            .map(|row| row.map(|(key, _)| key.value().to_owned()).map_err(storage))
            .collect::<Result<Vec<_>, _>>()?;
        require_meta_keys(keys, &[&[META_KEY.as_bytes()]])
            .map_err(|_| storage("incompatible source-registry metadata schema"))?;
        let value = meta
            .get(META_KEY)
            .map_err(storage)?
            .ok_or_else(|| storage("source-registry metadata row is missing"))?;
        let bytes = value.value();
        if bytes.len() != META_LEN {
            return Err(storage("source-registry metadata row is malformed"));
        }
        let stored_chain_id = u32::from_be_bytes(bytes[0..4].try_into().expect("4 bytes"));
        let stored_genesis = B256::from_slice(&bytes[4..36]);
        if stored_chain_id != pcash_chain_id || stored_genesis != genesis_hash {
            return Err(storage(format!(
                "source registry belongs to PCASH chain {stored_chain_id}/0x{} but this node is {pcash_chain_id}/0x{}",
                hex::encode(stored_genesis),
                hex::encode(genesis_hash)
            )));
        }
    } else {
        let mut metadata = Vec::with_capacity(META_LEN);
        metadata.extend_from_slice(&pcash_chain_id.to_be_bytes());
        metadata.extend_from_slice(genesis_hash.as_slice());
        let mut write = db.begin_write().map_err(storage)?;
        write
            .set_durability(Durability::Immediate)
            .map_err(storage)?;
        {
            let mut meta = write.open_table(T_META).map_err(storage)?;
            meta.insert(META_KEY, metadata.as_slice())
                .map_err(storage)?;
            write.open_table(T_IMPLEMENTATIONS).map_err(storage)?;
            write
                .open_table(T_CONFIGURATION_BINDINGS)
                .map_err(storage)?;
            write.open_table(T_OPENINGS).map_err(storage)?;
            write.open_table(T_PRESENTATIONS).map_err(storage)?;
            write.open_table(T_SUBMISSIONS).map_err(storage)?;
        }
        write.commit().map_err(storage)?;
    }
    Ok(db)
}

/// Rows stamped `PublicSubmission` are charged to the public budget at their
/// stored length: store_delta writes exactly the encoding merge_snapshots
/// charged when the row was inserted.
fn load_registry(db: &Database) -> Result<ManifestSnapshot, SourceVerificationApiError> {
    let read = db.begin_read().map_err(storage)?;
    let mut snapshot = empty_snapshot();
    let implementations = read.open_table(T_IMPLEMENTATIONS).map_err(storage)?;
    for row in implementations.iter().map_err(storage)? {
        let (key, value) = row.map_err(storage)?;
        if key.value().len() != 32 {
            return Err(storage("source-registry application VK key is malformed"));
        }
        let implementation: StoredImplementation = serde_json::from_slice(value.value())
            .map_err(|error| storage(format!("decode stored implementation: {error}")))?;
        let application_vk_hash = B256::from_slice(key.value());
        if implementation.summary.application_vk_hash != application_vk_hash {
            return Err(storage(
                "stored implementation does not match its application VK key",
            ));
        }
        validate_stored_implementation(&implementation)
            .map_err(|error| storage(format!("validate stored implementation: {error}")))?;
        if implementation.summary.verification_authority == VerificationAuthority::PublicSubmission
        {
            snapshot.submitted_implementations += 1;
            snapshot.submitted_bytes += value.value().len() as u64;
        }
        snapshot
            .implementations
            .insert(application_vk_hash, Arc::new(implementation));
    }
    let configuration_bindings = read.open_table(T_CONFIGURATION_BINDINGS).map_err(storage)?;
    for row in configuration_bindings.iter().map_err(storage)? {
        let (key, value) = row.map_err(storage)?;
        let key = ConfigurationBindingKey::decode(key.value())?;
        let binding: StoredConfigurationBinding = serde_json::from_slice(value.value())
            .map_err(|error| storage(format!("decode stored configuration binding: {error}")))?;
        validate_stored_configuration_binding(key, &binding)
            .map_err(|error| storage(format!("validate stored configuration binding: {error}")))?;
        if !snapshot
            .implementations
            .contains_key(&key.application_vk_hash)
        {
            return Err(storage(
                "stored configuration binding names an absent implementation",
            ));
        }
        if binding.verification_authority == VerificationAuthority::PublicSubmission {
            snapshot.submitted_bytes += value.value().len() as u64;
        }
        snapshot.configuration_bindings.insert(key, binding);
    }
    let openings = read.open_table(T_OPENINGS).map_err(storage)?;
    for row in openings.iter().map_err(storage)? {
        let (key, value) = row.map_err(storage)?;
        let key = OpeningKey::decode(key.value())?;
        let opening: StoredConfigurationOpening = serde_json::from_slice(value.value())
            .map_err(|error| storage(format!("decode stored configuration opening: {error}")))?;
        validate_opening_key(key, &opening)?;
        if matches!(
            opening,
            StoredConfigurationOpening::Valid {
                verification_authority: VerificationAuthority::PublicSubmission,
                ..
            }
        ) {
            snapshot.submitted_bytes += value.value().len() as u64;
        }
        snapshot.openings.insert(key, opening);
    }
    snapshot.opening_count = snapshot.openings.len() as u64;
    let presentations = read.open_table(T_PRESENTATIONS).map_err(storage)?;
    for row in presentations.iter().map_err(storage)? {
        let (key, value) = row.map_err(storage)?;
        if key.value().len() != 32 {
            return Err(storage("source-registry presentation key is malformed"));
        }
        let presentation: StoredContractPresentation = serde_json::from_slice(value.value())
            .map_err(|error| storage(format!("decode stored contract presentation: {error}")))?;
        let shape_key = B256::from_slice(key.value());
        if presentation_shape_key(&presentation.profile.functions) != shape_key {
            return Err(storage(
                "stored contract presentation does not match its function-shape key",
            ));
        }
        if presentation.verification_authority == VerificationAuthority::PublicSubmission {
            snapshot.submitted_bytes += value.value().len() as u64;
        }
        snapshot.presentations.insert(shape_key, presentation);
    }
    Ok(snapshot)
}

fn validate_stored_implementation(implementation: &StoredImplementation) -> Result<(), String> {
    let summary = &implementation.summary;
    validate_display_string(&summary.implementation_label, "implementationLabel")?;
    validate_logical_path(&summary.package_root)?;
    validate_nargo_package_name(&summary.package_name)?;
    if summary.verification_key_field_count != VERIFICATION_KEY_FIELD_COUNT as u64 {
        return Err(format!(
            "verification key fieldCount must be {VERIFICATION_KEY_FIELD_COUNT}"
        ));
    }
    if implementation.files.is_empty() {
        return Err("implementation source files must not be empty".to_owned());
    }
    let mut prior_path: Option<&str> = None;
    for file in &implementation.files {
        validate_logical_path(&file.metadata.path)?;
        if prior_path.is_some_and(|prior| prior.as_bytes() >= file.metadata.path.as_bytes()) {
            return Err("stored source paths must be unique and sorted".to_owned());
        }
        prior_path = Some(&file.metadata.path);
        if file.metadata.length != file.content.len() as u64 {
            return Err(format!(
                "source file {} length mismatch",
                file.metadata.path
            ));
        }
        verify_sha256(
            file.content.as_bytes(),
            file.metadata.sha256,
            &format!("source file {}", file.metadata.path),
        )?;
    }
    if source_bundle_digest(&implementation.files) != summary.source_bundle_digest {
        return Err("sourceBundleDigest does not match stored source files".to_owned());
    }
    validate_noir_proving_abi(&implementation.noir_proving_abi)?;
    let abi = canonical_json(&implementation.noir_proving_abi);
    verify_sha256(
        abi.as_bytes(),
        summary.noir_proving_abi_sha256,
        "Noir proving ABI",
    )?;
    validate_display_string(&summary.toolchain.producer_platform, "producerPlatform")?;
    if !matches!(
        summary.toolchain.producer_platform.as_str(),
        "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64"
    ) {
        return Err("stored producerPlatform is unsupported".to_owned());
    }
    validate_display_string(&summary.toolchain.nargo.version, "Nargo version")?;
    validate_display_string(&summary.toolchain.nargo.noirc_commit, "noircCommit")?;
    validate_display_string(
        &summary.toolchain.barretenberg.version,
        "Barretenberg version",
    )?;
    if summary.toolchain.barretenberg.verifier_target != "chonk" {
        return Err("stored Barretenberg verifierTarget must be chonk".to_owned());
    }
    Ok(())
}

fn validate_stored_configuration_binding(
    key: ConfigurationBindingKey,
    binding: &StoredConfigurationBinding,
) -> Result<(), String> {
    let profile = &binding.profile;
    if profile.selector != key.selector {
        return Err(
            "stored configuration profile selector does not match its binding key".to_owned(),
        );
    }
    if profile.domain != fr_to_bytes(reference_configuration_domain()) {
        return Err(
            "stored configuration profile domain must be REFERENCE_CONFIGURATION_DOMAIN".to_owned(),
        );
    }
    for (position, field) in profile.fields.iter().enumerate() {
        validate_display_string(
            &field.name,
            &format!("configurationProfile field {position} name"),
        )?;
        validate_display_string(
            &field.value_type,
            &format!("configurationProfile field {position} type"),
        )?;
        match (field.value_type.as_str(), field.bits) {
            ("field", None) => {}
            (value_type, Some(bits))
                if value_type == format!("uint{bits}") && (1..=254).contains(&bits) => {}
            _ => {
                return Err(format!(
                    "stored configurationProfile field {position} type and width disagree"
                ));
            }
        }
    }
    Ok(())
}

fn store_delta(
    db: &Database,
    delta: &ManifestSnapshot,
    receipt: Option<&(B256, StoredSubmissionRecord)>,
) -> Result<(), SourceVerificationApiError> {
    let mut write = db.begin_write().map_err(storage)?;
    write
        .set_durability(Durability::Immediate)
        .map_err(storage)?;
    {
        let mut implementations = write.open_table(T_IMPLEMENTATIONS).map_err(storage)?;
        for (application_vk_hash, implementation) in &delta.implementations {
            if implementations
                .get(application_vk_hash.as_slice())
                .map_err(storage)?
                .is_none()
            {
                let encoded = serde_json::to_vec(implementation.as_ref())
                    .map_err(|error| storage(format!("encode implementation: {error}")))?;
                implementations
                    .insert(application_vk_hash.as_slice(), encoded.as_slice())
                    .map_err(storage)?;
            }
        }
        let mut configuration_bindings = write
            .open_table(T_CONFIGURATION_BINDINGS)
            .map_err(storage)?;
        for (key, binding) in &delta.configuration_bindings {
            let key = key.encode();
            if configuration_bindings
                .get(key.as_slice())
                .map_err(storage)?
                .is_none()
            {
                let encoded = serde_json::to_vec(binding)
                    .map_err(|error| storage(format!("encode configuration binding: {error}")))?;
                configuration_bindings
                    .insert(key.as_slice(), encoded.as_slice())
                    .map_err(storage)?;
            }
        }
        let mut openings = write.open_table(T_OPENINGS).map_err(storage)?;
        for (key, opening) in &delta.openings {
            let key = key.encode();
            if openings.get(key.as_slice()).map_err(storage)?.is_none() {
                let encoded = serde_json::to_vec(opening)
                    .map_err(|error| storage(format!("encode configuration opening: {error}")))?;
                openings
                    .insert(key.as_slice(), encoded.as_slice())
                    .map_err(storage)?;
            }
        }
        let mut presentations = write.open_table(T_PRESENTATIONS).map_err(storage)?;
        for (shape_key, presentation) in &delta.presentations {
            if presentations
                .get(shape_key.as_slice())
                .map_err(storage)?
                .is_none()
            {
                let encoded = serde_json::to_vec(presentation)
                    .map_err(|error| storage(format!("encode contract presentation: {error}")))?;
                presentations
                    .insert(shape_key.as_slice(), encoded.as_slice())
                    .map_err(storage)?;
            }
        }
        if let Some((content_id, record)) = receipt {
            let mut submissions = write.open_table(T_SUBMISSIONS).map_err(storage)?;
            let encoded = serde_json::to_vec(record)
                .map_err(|error| storage(format!("encode submission receipt: {error}")))?;
            submissions
                .insert(content_id.as_slice(), encoded.as_slice())
                .map_err(storage)?;
        }
    }
    write.commit().map_err(storage)
}

fn validate_opening_key(
    key: OpeningKey,
    opening: &StoredConfigurationOpening,
) -> Result<(), SourceVerificationApiError> {
    match opening {
        StoredConfigurationOpening::Valid {
            application_vk_hash,
            configuration_commitment,
            ..
        } if *application_vk_hash == key.application_vk_hash
            && *configuration_commitment == key.configuration_commitment =>
        {
            Ok(())
        }
        StoredConfigurationOpening::Valid { .. } => Err(storage(
            "stored configuration opening does not match its full-identity key",
        )),
        StoredConfigurationOpening::Invalid { .. } => Err(storage(
            "invalid configuration opening was persisted in the source registry",
        )),
    }
}

fn implementation_correspondence_digest(implementation: &StoredImplementation) -> B256 {
    // Provenance labels are deliberately excluded: the same source material
    // may arrive through either channel, and only the bytes define identity.
    let mut summary = implementation.summary.clone();
    summary.verification_authority = VerificationAuthority::default();
    summary.verification_method = VerificationMethod::default();
    let encoded = serde_json::to_vec(&(
        &summary,
        &implementation.files,
        &implementation.noir_proving_abi,
    ))
    .expect("stored implementation correspondence contains serializable validated values");
    B256::from(<[u8; 32]>::from(Sha256::digest(encoded)))
}

fn merge_snapshots(
    mut current: ManifestSnapshot,
    incoming: ManifestSnapshot,
    origin: PublicationOrigin,
) -> Result<ManifestSnapshot, SourceVerificationApiError> {
    for (key, implementation) in incoming.implementations {
        if let Some(stored) = current.implementations.get(&key) {
            if implementation_correspondence_digest(stored)
                != implementation_correspondence_digest(&implementation)
            {
                return Err(SourceVerificationApiError::Conflict(format!(
                    "applicationVkHash 0x{} has different source material",
                    hex::encode(key)
                )));
            }
        } else {
            if origin == PublicationOrigin::Public {
                current.submitted_implementations += 1;
                let encoded = serde_json::to_vec(implementation.as_ref())
                    .map_err(|error| storage(format!("encode implementation: {error}")))?;
                current.submitted_bytes += encoded.len() as u64;
            }
            current.implementations.insert(key, implementation);
        }
    }
    for (key, binding) in incoming.configuration_bindings {
        if let Some(stored) = current.configuration_bindings.get(&key) {
            if stored.profile != binding.profile {
                return Err(SourceVerificationApiError::Conflict(format!(
                    "selector {} and applicationVkHash 0x{} have different configuration profiles",
                    key.selector,
                    hex::encode(key.application_vk_hash),
                )));
            }
        } else {
            if origin == PublicationOrigin::Public {
                let encoded = serde_json::to_vec(&binding)
                    .map_err(|error| storage(format!("encode configuration binding: {error}")))?;
                current.submitted_bytes += encoded.len() as u64;
            }
            current.configuration_bindings.insert(key, binding);
        }
    }
    for (key, opening) in incoming.openings {
        if let Some(stored) = current.openings.get(&key) {
            if !stored.same_material(&opening) {
                return Err(SourceVerificationApiError::Conflict(format!(
                    "contract 0x{} selector {} has different values for implementation 0x{} and configuration commitment 0x{}",
                    hex::encode(key.address),
                    key.selector,
                    hex::encode(key.application_vk_hash),
                    hex::encode(key.configuration_commitment),
                )));
            }
        } else {
            if origin == PublicationOrigin::Public {
                let encoded = serde_json::to_vec(&opening)
                    .map_err(|error| storage(format!("encode configuration opening: {error}")))?;
                current.submitted_bytes += encoded.len() as u64;
            }
            current.openings.insert(key, opening);
        }
    }
    for (shape_key, presentation) in incoming.presentations {
        if let Some(stored) = current.presentations.get(&shape_key) {
            if stored.profile != presentation.profile {
                return Err(SourceVerificationApiError::Conflict(format!(
                    "contract function shape 0x{} has different presentation metadata",
                    hex::encode(shape_key)
                )));
            }
        } else {
            if origin == PublicationOrigin::Public {
                let encoded = serde_json::to_vec(&presentation)
                    .map_err(|error| storage(format!("encode contract presentation: {error}")))?;
                current.submitted_bytes += encoded.len() as u64;
            }
            current.presentations.insert(shape_key, presentation);
        }
    }
    current.opening_count = current.openings.len() as u64;
    current.invalid_opening_count = current
        .openings
        .values()
        .filter(|opening| matches!(opening, StoredConfigurationOpening::Invalid { .. }))
        .count() as u64;
    Ok(current)
}

/// Implementation, configuration-binding, opening, and presentation rows keep
/// the authority of the channel that inserted them, and load_registry charges
/// rows stamped `PublicSubmission` to the public budget. All but openings also
/// keep the method; implementation summaries and presentation views serve both
/// stamps verbatim.
fn stamp_origin(snapshot: &mut ManifestSnapshot, origin: PublicationOrigin) {
    let (authority, method) = origin.stamps();
    for implementation in snapshot.implementations.values_mut() {
        let implementation = Arc::make_mut(implementation);
        implementation.summary.verification_authority = authority;
        implementation.summary.verification_method = method;
    }
    for binding in snapshot.configuration_bindings.values_mut() {
        binding.verification_authority = authority;
        binding.verification_method = method;
    }
    for presentation in snapshot.presentations.values_mut() {
        presentation.verification_authority = authority;
        presentation.verification_method = method;
    }
    for opening in snapshot.openings.values_mut() {
        if let StoredConfigurationOpening::Valid {
            verification_authority,
            ..
        } = opening
        {
            *verification_authority = authority;
        }
    }
}

/// The public ceiling charges distinct registry contributions, not envelope
/// bytes: re-submitting known implementations under new metadata costs
/// nothing. Rejects a publication that would push the channel past either
/// bound; otherwise returns its new implementation count and new byte count.
fn enforce_submission_budget(
    current: &ManifestSnapshot,
    imported: &ManifestSnapshot,
) -> Result<(u64, u64), SourceVerificationApiError> {
    let mut new_implementations = 0u64;
    let mut new_bytes = 0u64;
    for (key, implementation) in &imported.implementations {
        if current.implementations.contains_key(key) {
            continue;
        }
        new_implementations += 1;
        let encoded = serde_json::to_vec(implementation.as_ref())
            .map_err(|error| storage(format!("encode implementation: {error}")))?;
        new_bytes += encoded.len() as u64;
    }
    for (key, opening) in &imported.openings {
        if current.openings.contains_key(key) {
            continue;
        }
        let encoded = serde_json::to_vec(opening)
            .map_err(|error| storage(format!("encode configuration opening: {error}")))?;
        new_bytes += encoded.len() as u64;
    }
    for (key, binding) in &imported.configuration_bindings {
        if current.configuration_bindings.contains_key(key) {
            continue;
        }
        let encoded = serde_json::to_vec(binding)
            .map_err(|error| storage(format!("encode configuration binding: {error}")))?;
        new_bytes += encoded.len() as u64;
    }
    for (key, presentation) in &imported.presentations {
        if current.presentations.contains_key(key) {
            continue;
        }
        let encoded = serde_json::to_vec(presentation)
            .map_err(|error| storage(format!("encode contract presentation: {error}")))?;
        new_bytes += encoded.len() as u64;
    }
    if current.submitted_implementations + new_implementations > SUBMISSION_MAX_IMPLEMENTATIONS {
        return Err(SourceVerificationApiError::Invalid(
            "public submission budget for implementations is exhausted".to_owned(),
        ));
    }
    if current.submitted_bytes + new_bytes > SUBMISSION_MAX_AGGREGATE_BYTES {
        return Err(SourceVerificationApiError::Invalid(
            "public submission byte budget is exhausted".to_owned(),
        ));
    }
    Ok((new_implementations, new_bytes))
}

pub(crate) fn load_publication_for(
    publication: &SourceVerificationPublication,
) -> Result<ManifestSnapshot, String> {
    load_publication(publication)
}

fn load_publication(
    publication: &SourceVerificationPublication,
) -> Result<ManifestSnapshot, String> {
    // Measured before anything is parsed or decoded, so one number bounds the
    // manifest, the attachment names, and the base64 payload together.
    let wire_bytes = serde_json::to_vec(publication)
        .map_err(|error| format!("encode source-verification publication: {error}"))?
        .len() as u64;
    if wire_bytes > MAX_PUBLICATION_WIRE_BYTES {
        return Err(format!(
            "publication exceeds {MAX_PUBLICATION_WIRE_BYTES} bytes serialized"
        ));
    }
    let manifest_bytes = serde_json::to_vec(&publication.manifest)
        .map_err(|error| format!("encode source-verification manifest: {error}"))?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(format!("manifest exceeds {MAX_MANIFEST_BYTES} bytes"));
    }
    let manifest: Manifest = serde_json::from_value(publication.manifest.clone())
        .map_err(|error| format!("parse source-verification manifest: {error}"))?;
    let referenced = manifest
        .implementations
        .iter()
        .flat_map(|implementation| {
            implementation
                .source_files
                .iter()
                .map(|file| file.attachment.as_str())
                .chain(std::iter::once(
                    implementation.compiler_artifact.attachment.as_str(),
                ))
                .chain(std::iter::once(
                    implementation.noir_proving_abi.attachment.as_str(),
                ))
                .chain(std::iter::once(
                    implementation.verification_key.attachment.as_str(),
                ))
        })
        .collect::<HashSet<_>>();
    if referenced.len() != publication.attachments.len()
        || publication
            .attachments
            .keys()
            .any(|path| !referenced.contains(path.as_str()))
    {
        return Err("attachments must contain exactly the files referenced by manifest".to_owned());
    }
    // Decoded once each, so the publication holds one buffer per attachment
    // however many implementations share it. The sum is over the distinct
    // attachments carried.
    let mut decoded = HashMap::with_capacity(publication.attachments.len());
    let mut total_attachment_bytes = 0u64;
    for (path, encoded) in &publication.attachments {
        let bytes = decode_base64(encoded)?;
        total_attachment_bytes = total_attachment_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| {
                format!("attachments exceed {MAX_TOTAL_ATTACHMENT_BYTES} decoded bytes")
            })?;
        if total_attachment_bytes > MAX_TOTAL_ATTACHMENT_BYTES {
            return Err(format!(
                "attachments exceed {MAX_TOTAL_ATTACHMENT_BYTES} decoded bytes"
            ));
        }
        decoded.insert(path.as_str(), bytes);
    }
    // Every copy an implementation keeps is served from here, so charging each
    // reference bounds the bytes one publication materializes by the same
    // budget, whatever number of logical source paths name one attachment.
    let remaining = Cell::new(MAX_TOTAL_ATTACHMENT_BYTES);
    load_manifest_with(manifest, &|relative| {
        validate_logical_path(relative)?;
        let bytes = decoded
            .get(relative)
            .ok_or_else(|| format!("missing attachment {relative}"))?;
        let left = remaining
            .get()
            .checked_sub(bytes.len() as u64)
            .ok_or_else(|| {
                format!("attachment references exceed {MAX_TOTAL_ATTACHMENT_BYTES} decoded bytes")
            })?;
        remaining.set(left);
        Ok(bytes.clone())
    })
}

enum ReproductionError {
    Rejected(String),
    Unavailable(String),
}

fn check_reproducer(reproducer: &Path) -> Result<(), String> {
    if !reproducer.is_absolute() {
        return Err("source reproducer path must be absolute".to_owned());
    }
    if !reproducer.is_file() {
        tracing::warn!(path = %reproducer.display(), "source reproducer is missing");
        return Err("source reproducer is missing".to_owned());
    }
    let output = Command::new("node")
        .arg(reproducer)
        .arg("check")
        .output()
        .map_err(|error| {
            tracing::warn!(path = %reproducer.display(), %error, "source reproducer check could not run");
            "source reproducer check could not run".to_owned()
        })?;
    if output.status.success() {
        Ok(())
    } else {
        tracing::warn!(path = %reproducer.display(), status = ?output.status.code(), "source reproducer check failed");
        Err("source reproducer check failed".to_owned())
    }
}

fn reproduce_publication(
    publication: &SourceVerificationPublication,
    reproducer: &Path,
) -> Result<(), ReproductionError> {
    let materialized = tempfile::tempdir().map_err(|error| {
        ReproductionError::Unavailable(format!("create source-reproduction directory: {error}"))
    })?;
    let bundle_root = materialized.path().join("bundle");
    let scratch_root = materialized.path().join("tmp");
    std::fs::create_dir_all(&bundle_root).map_err(|error| {
        ReproductionError::Unavailable(format!("create materialized source bundle: {error}"))
    })?;
    std::fs::create_dir_all(&scratch_root).map_err(|error| {
        ReproductionError::Unavailable(format!("create source-reproduction scratch root: {error}"))
    })?;
    for (relative, encoded) in &publication.attachments {
        validate_logical_path(relative).map_err(ReproductionError::Rejected)?;
        let bytes = decode_base64(encoded).map_err(ReproductionError::Rejected)?;
        let destination = bundle_root.join(relative);
        let parent = destination.parent().ok_or_else(|| {
            ReproductionError::Rejected(format!("attachment {relative} has no parent"))
        })?;
        std::fs::create_dir_all(parent).map_err(|error| {
            ReproductionError::Unavailable(format!(
                "create attachment directory for {relative}: {error}"
            ))
        })?;
        std::fs::write(&destination, bytes).map_err(|error| {
            ReproductionError::Unavailable(format!("materialize attachment {relative}: {error}"))
        })?;
    }
    let manifest_path = bundle_root.join("pcash-contract-source.json");
    let manifest = serde_json::to_vec(&publication.manifest)
        .map_err(|error| ReproductionError::Rejected(error.to_string()))?;
    std::fs::write(&manifest_path, manifest).map_err(|error| {
        ReproductionError::Unavailable(format!("materialize source-reproduction manifest: {error}"))
    })?;
    let output = Command::new("node")
        .arg(reproducer)
        .arg("reproduce-contract")
        .arg("--bundle")
        .arg(&manifest_path)
        // The reproducer intentionally retains its scratch directory. Keep it
        // below this TempDir so the publication owns its entire lifetime.
        .env("TMPDIR", &scratch_root)
        .output()
        .map_err(|error| {
            tracing::warn!(path = %reproducer.display(), %error, "source reproduction could not run");
            ReproductionError::Unavailable("source reproduction could not run".to_owned())
        })?;
    if output.status.success() {
        return Ok(());
    }
    tracing::warn!(path = %reproducer.display(), status = ?output.status.code(), "source reproduction failed");
    let rejected = "source reproduction failed".to_owned();
    if let Err(unavailable) = check_reproducer(reproducer) {
        Err(ReproductionError::Unavailable(format!(
            "{rejected}; {unavailable}"
        )))
    } else {
        Err(ReproductionError::Rejected(rejected))
    }
}

fn load_manifest_with(
    manifest: Manifest,
    read: &dyn Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<ManifestSnapshot, String> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "unsupported source-verification manifest schema {}",
            manifest.schema_version
        ));
    }
    if manifest.bundle_format != MANIFEST_BUNDLE_FORMAT {
        return Err(format!(
            "source-verification bundleFormat must be {MANIFEST_BUNDLE_FORMAT}"
        ));
    }
    if manifest.proof_profile.id != PROOF_PROFILE_ID
        || manifest.proof_profile.return_fields != PROOF_PROFILE_RETURN_FIELDS
        || manifest.proof_profile.return_visibility != "databus"
    {
        return Err(format!(
            "source-verification proofProfile must be {PROOF_PROFILE_ID} with a four-Field databus return"
        ));
    }
    let mut implementations = HashMap::new();
    for raw in manifest.implementations {
        let implementation = load_implementation(read, raw)?;
        let key = implementation.summary.application_vk_hash;
        if implementations
            .insert(key, Arc::new(implementation))
            .is_some()
        {
            return Err(format!(
                "duplicate applicationVkHash 0x{}",
                hex::encode(key)
            ));
        }
    }
    let mut configuration_bindings = HashMap::new();
    let mut binding_order = Vec::with_capacity(manifest.configuration_bindings.len());
    for raw in manifest.configuration_bindings {
        let application_vk_hash = parse_field(
            &raw.application_vk_hash,
            "configuration binding applicationVkHash",
        )?;
        let implementation = implementations.get(&application_vk_hash).ok_or_else(|| {
            "configuration binding names an implementation absent from the bundle".to_owned()
        })?;
        let profile = load_configuration_profile(
            &raw.configuration_profile,
            &implementation.summary.implementation_label,
        )?;
        let key = ConfigurationBindingKey {
            selector: profile.selector,
            application_vk_hash,
        };
        binding_order.push(key);
        if configuration_bindings
            .insert(
                key,
                StoredConfigurationBinding {
                    verification_authority: VerificationAuthority::NodeOperator,
                    verification_method: VerificationMethod::NodeRegistry,
                    profile,
                },
            )
            .is_some()
        {
            return Err(format!(
                "duplicate configuration binding for selector {} and applicationVkHash 0x{}",
                key.selector,
                hex::encode(key.application_vk_hash),
            ));
        }
    }
    if implementations.keys().any(|application_vk_hash| {
        !configuration_bindings
            .keys()
            .any(|binding| binding.application_vk_hash == *application_vk_hash)
    }) {
        return Err(
            "every source implementation must be used by a configuration binding".to_owned(),
        );
    }
    let presentation = load_contract_presentation(
        manifest.presentation,
        &binding_order,
        &implementations,
        &configuration_bindings,
    )?;
    let presentations = HashMap::from([(
        presentation_shape_key(&presentation.profile.functions),
        presentation,
    )]);

    let mut openings = HashMap::new();
    let mut invalid_opening_count = 0u64;
    let opening_count = manifest.configuration_openings.len() as u64;
    for raw in manifest.configuration_openings {
        let key = if let (Ok(address), Ok(application_vk_hash), Ok(configuration_commitment)) = (
            parse_address(&raw.address),
            parse_field(&raw.application_vk_hash, "opening applicationVkHash"),
            parse_field(
                &raw.configuration_commitment,
                "opening configurationCommitment",
            ),
        ) {
            OpeningKey {
                address,
                selector: raw.selector,
                application_vk_hash,
                configuration_commitment,
            }
        } else {
            invalid_opening_count += 1;
            continue;
        };
        let mut opening = parse_opening(raw);
        if let StoredConfigurationOpening::Valid { domain, values, .. } = &opening {
            let binding_key = ConfigurationBindingKey {
                selector: key.selector,
                application_vk_hash: key.application_vk_hash,
            };
            let binding_matches = configuration_bindings
                .get(&binding_key)
                .is_some_and(|binding| {
                    binding.profile.domain == *domain
                        && binding.profile.fields.len() == values.len()
                        && binding
                            .profile
                            .fields
                            .iter()
                            .zip(values)
                            .all(|(field, value)| {
                                field
                                    .bits
                                    .is_none_or(|bits| fits_unsigned_bits(value, bits))
                            })
                });
            if !binding_matches {
                opening = StoredConfigurationOpening::Invalid {
                    error: "opening does not match a selector/VK configuration binding".to_owned(),
                };
            }
        }
        if matches!(opening, StoredConfigurationOpening::Invalid { .. }) {
            invalid_opening_count += 1;
        }
        if openings.insert(key, opening).is_some() {
            openings.insert(
                key,
                StoredConfigurationOpening::Invalid {
                    error: "duplicate opening for the same full function identity".to_owned(),
                },
            );
            invalid_opening_count += 1;
        }
    }
    Ok(ManifestSnapshot {
        service_name: manifest.service_name,
        implementations,
        configuration_bindings,
        openings,
        presentations,
        opening_count,
        invalid_opening_count,
        submitted_implementations: 0,
        submitted_bytes: 0,
    })
}

fn load_contract_presentation(
    raw: ContractPresentationProfileManifest,
    binding_order: &[ConfigurationBindingKey],
    implementations: &HashMap<B256, Arc<StoredImplementation>>,
    configuration_bindings: &HashMap<ConfigurationBindingKey, StoredConfigurationBinding>,
) -> Result<StoredContractPresentation, String> {
    if raw.schema_version != 1 {
        return Err("contract presentation schemaVersion must be 1".to_owned());
    }
    validate_presentation_text(&raw.publisher_label, "presentation publisherLabel", 160)?;
    validate_presentation_text(&raw.contract_name, "presentation contractName", 160)?;
    validate_presentation_text(
        &raw.contract_description,
        "presentation contractDescription",
        2_000,
    )?;
    if raw.functions.len() != binding_order.len() || raw.functions.is_empty() {
        return Err(
            "presentation functions must exactly match the ordered configuration bindings"
                .to_owned(),
        );
    }

    let mut functions = Vec::with_capacity(raw.functions.len());
    let mut prior_selector = None;
    let mut overview_orders = Vec::new();
    let mut function_names = HashSet::new();
    for (index, (function, expected_binding)) in
        raw.functions.into_iter().zip(binding_order).enumerate()
    {
        let application_vk_hash = parse_presentation_field(
            &function.application_vk_hash,
            &format!("presentation function {index} applicationVkHash"),
        )?;
        if function.selector != expected_binding.selector
            || application_vk_hash != expected_binding.application_vk_hash
        {
            return Err(format!(
                "presentation function {index} does not match the ordered configuration binding selector and VK hash"
            ));
        }
        if prior_selector.is_some_and(|prior| prior >= function.selector) {
            return Err("presentation function selectors must be strictly increasing".to_owned());
        }
        prior_selector = Some(function.selector);
        validate_noir_identifier(
            &function.name,
            &format!("presentation function {index} name"),
        )?;
        if !function_names.insert(function.name.clone()) {
            return Err(format!(
                "presentation function name {} is duplicated",
                function.name
            ));
        }
        validate_presentation_text(
            &function.summary,
            &format!("presentation function {index} summary"),
            500,
        )?;

        let implementation = implementations.get(&application_vk_hash).ok_or_else(|| {
            format!("presentation function {index} has no matching implementation")
        })?;
        let configuration_profile = &configuration_bindings
            .get(expected_binding)
            .expect("ordered configuration binding was collected from this map")
            .profile;
        if function.configuration_fields.len() != configuration_profile.fields.len() {
            return Err(format!(
                "presentation function {index} configurationFields must cover the configuration profile"
            ));
        }
        let mut configuration_fields = Vec::with_capacity(function.configuration_fields.len());
        for (position, (field, expected)) in function
            .configuration_fields
            .into_iter()
            .zip(&configuration_profile.fields)
            .enumerate()
        {
            if field.position != position as u64 || field.name != expected.name {
                return Err(format!(
                    "presentation function {index} configuration field {position} does not match the positional configuration profile"
                ));
            }
            validate_noir_identifier(
                &field.name,
                &format!("presentation function {index} configuration field {position} name"),
            )?;
            validate_presentation_text(
                &field.label,
                &format!("presentation function {index} configuration field {position} label"),
                160,
            )?;
            validate_presentation_text(
                &field.description,
                &format!(
                    "presentation function {index} configuration field {position} description"
                ),
                1_000,
            )?;
            if !matches!(
                field.display_format.as_str(),
                "field"
                    | "uint"
                    | "hex"
                    | "ethereum-address"
                    | "pcash-amount"
                    | "eth-amount"
                    | "unix-timestamp"
                    | "chain-id"
            ) {
                return Err(format!(
                    "presentation function {index} configuration field {position} has an unsupported displayFormat"
                ));
            }
            let overview_order = match field.overview_order {
                Value::Null => None,
                Value::Number(value) => Some(
                    value
                        .as_u64()
                        .filter(|value| *value <= 9_007_199_254_740_991)
                        .ok_or_else(|| {
                            format!(
                                "presentation function {index} configuration field {position} overviewOrder must be a nonnegative safe integer or null"
                            )
                        })?,
                ),
                _ => {
                    return Err(format!(
                        "presentation function {index} configuration field {position} overviewOrder must be a nonnegative safe integer or null"
                    ));
                }
            };
            if let Some(order) = overview_order {
                overview_orders.push(order);
            }
            configuration_fields.push(ContractPresentationConfigurationField {
                position: field.position,
                name: field.name,
                label: field.label,
                description: field.description,
                display_format: field.display_format,
                overview_order,
            });
        }

        if function.proof_groups.is_empty() {
            return Err(format!(
                "presentation function {index} proofGroups must not be empty"
            ));
        }
        let parameters = implementation
            .noir_proving_abi
            .get("parameters")
            .and_then(Value::as_array)
            .expect("stored implementation ABI was validated");
        let mut expected_abi_parameters = HashSet::new();
        for (position, parameter) in parameters.iter().enumerate() {
            let name = parameter
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Noir proving ABI parameter {position} has no name"))?;
            validate_noir_identifier(name, "Noir proving ABI parameter")?;
            if !expected_abi_parameters.insert(name.to_owned()) {
                return Err(format!("Noir proving ABI has duplicate parameter {name}"));
            }
        }
        let mut described_abi_parameters = HashSet::new();
        let mut group_titles = HashSet::new();
        let mut proof_groups = Vec::with_capacity(function.proof_groups.len());
        for (group_index, group) in function.proof_groups.into_iter().enumerate() {
            validate_presentation_text(
                &group.title,
                &format!("presentation function {index} proof group {group_index} title"),
                160,
            )?;
            if !group_titles.insert(group.title.clone()) {
                return Err(format!(
                    "presentation function {index} proof group titles must be unique"
                ));
            }
            validate_presentation_text(
                &group.description,
                &format!("presentation function {index} proof group {group_index} description"),
                1_000,
            )?;
            if group.items.is_empty() {
                return Err(format!(
                    "presentation function {index} proof group {group_index} items must not be empty"
                ));
            }
            let mut items = Vec::with_capacity(group.items.len());
            for (item_index, item) in group.items.into_iter().enumerate() {
                validate_noir_identifier(
                    &item.abi_parameter,
                    &format!(
                        "presentation function {index} proof group {group_index} item {item_index} abiParameter"
                    ),
                )?;
                validate_presentation_text(
                    &item.description,
                    &format!(
                        "presentation function {index} proof group {group_index} item {item_index} description"
                    ),
                    1_000,
                )?;
                if !described_abi_parameters.insert(item.abi_parameter.clone()) {
                    return Err(format!(
                        "presentation function {index} proof ABI parameters must be unique"
                    ));
                }
                items.push(ContractPresentationProofItem {
                    abi_parameter: item.abi_parameter,
                    description: item.description,
                });
            }
            proof_groups.push(ContractPresentationProofGroup {
                title: group.title,
                description: group.description,
                items,
            });
        }
        if described_abi_parameters != expected_abi_parameters {
            return Err(format!(
                "presentation function {index} proof items must cover every ABI parameter exactly once"
            ));
        }

        functions.push(ContractPresentationFunction {
            selector: function.selector,
            application_vk_hash,
            name: function.name,
            summary: function.summary,
            configuration_fields,
            proof_groups,
        });
    }
    overview_orders.sort_unstable();
    if overview_orders
        .iter()
        .enumerate()
        .any(|(expected, actual)| *actual != expected as u64)
    {
        return Err(
            "presentation overviewOrder values must be globally unique and dense from zero"
                .to_owned(),
        );
    }

    Ok(StoredContractPresentation {
        verification_authority: VerificationAuthority::NodeOperator,
        verification_method: VerificationMethod::NodeRegistry,
        profile: ContractPresentationProfile {
            schema_version: raw.schema_version,
            publisher_label: raw.publisher_label,
            contract_name: raw.contract_name,
            contract_description: raw.contract_description,
            functions,
        },
    })
}

fn validate_presentation_text(value: &str, label: &str, max: usize) -> Result<(), String> {
    if value.is_empty()
        || value.encode_utf16().count() > max
        || value.trim() != value
        || value.chars().any(|character| {
            (character <= '\u{1f}' && !matches!(character, '\t' | '\n' | '\r'))
                || character == '\u{7f}'
        })
    {
        return Err(format!(
            "{label} must be trimmed, nonempty, at most {max} bytes, and contain no C0 controls"
        ));
    }
    Ok(())
}

fn validate_noir_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(format!("{label} must be a Noir identifier"));
    }
    Ok(())
}

fn parse_presentation_field(value: &str, label: &str) -> Result<B256, String> {
    if value.len() != 66
        || !value.starts_with("0x")
        || !value[2..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{label} must be a canonical lowercase 0x-prefixed BN254 field"
        ));
    }
    parse_field(value, label)
}

fn load_implementation(
    read: &dyn Fn(&str) -> Result<Vec<u8>, String>,
    raw: ImplementationManifest,
) -> Result<StoredImplementation, String> {
    let claimed_hash = parse_field(&raw.application_vk_hash, "applicationVkHash")?;
    validate_display_string(&raw.implementation_label, "implementationLabel")?;
    validate_logical_path(&raw.package_root)?;
    validate_nargo_package_name(&raw.package_name)?;
    if raw.source_files.is_empty() {
        return Err("implementation sourceFiles must not be empty".to_owned());
    }

    let mut source_files = Vec::with_capacity(raw.source_files.len());
    let mut seen_paths = HashSet::new();
    for file in raw.source_files {
        validate_logical_path(&file.path)?;
        if !seen_paths.insert(file.path.clone()) {
            return Err(format!("duplicate source path {}", file.path));
        }
        let expected_sha256 = parse_digest(&file.sha256, "source file sha256")?;
        let bytes = read(&file.attachment)?;
        if bytes.len() as u64 != file.length {
            return Err(format!("source file {} length mismatch", file.path));
        }
        verify_sha256(
            &bytes,
            expected_sha256,
            &format!("source file {}", file.path),
        )?;
        let content = String::from_utf8(bytes)
            .map_err(|_| format!("source file {} is not UTF-8", file.path))?;
        source_files.push(StoredSourceFile {
            metadata: SourceFileMetadata {
                path: file.path,
                length: content.len() as u64,
                sha256: expected_sha256,
            },
            content,
        });
    }
    source_files.sort_by(|a, b| a.metadata.path.as_bytes().cmp(b.metadata.path.as_bytes()));
    let expected_bundle_digest = parse_digest(&raw.source_bundle_digest, "sourceBundleDigest")?;
    let actual_bundle_digest = source_bundle_digest(&source_files);
    if actual_bundle_digest != expected_bundle_digest {
        return Err("sourceBundleDigest does not match source files".to_owned());
    }

    let artifact_expected =
        parse_digest(&raw.compiler_artifact.sha256, "compiler artifact sha256")?;
    let artifact_bytes = read(&raw.compiler_artifact.attachment)?;
    let artifact: Value = serde_json::from_slice(&artifact_bytes)
        .map_err(|error| format!("compiler artifact is not JSON: {error}"))?;
    require_canonical_json(&artifact_bytes, &artifact, "compiler artifact")?;
    let artifact_object = artifact
        .as_object()
        .ok_or_else(|| "compiler artifact must be a JSON object".to_owned())?;
    if artifact_object.len() != 3
        || !artifact_object.contains_key("noir_version")
        || !artifact_object.contains_key("abi")
        || !artifact_object.contains_key("bytecode")
    {
        return Err(
            "compiler artifact must contain exactly noir_version, abi, and bytecode".to_owned(),
        );
    }
    let expected_noir_version = format!(
        "{}+{}",
        raw.toolchain.nargo.version, raw.toolchain.nargo.noirc_commit
    );
    if artifact.get("noir_version").and_then(Value::as_str) != Some(expected_noir_version.as_str())
    {
        return Err("compiler artifact noir_version does not match the toolchain".to_owned());
    }
    verify_sha256(&artifact_bytes, artifact_expected, "compiler artifact")?;
    let decoded_acir_sha256 = parse_digest(
        &raw.compiler_artifact.decoded_acir_sha256,
        "decoded ACIR sha256",
    )?;
    let encoded = artifact
        .get("bytecode")
        .and_then(Value::as_str)
        .ok_or_else(|| "compiler artifact has no string bytecode".to_owned())?;
    let decoded = decode_base64(encoded)?;
    verify_sha256(&decoded, decoded_acir_sha256, "decoded ACIR")?;

    let abi_expected = parse_digest(&raw.noir_proving_abi.sha256, "Noir proving ABI sha256")?;
    let abi_bytes = read(&raw.noir_proving_abi.attachment)?;
    let abi: Value = serde_json::from_slice(&abi_bytes)
        .map_err(|error| format!("Noir proving ABI is not JSON: {error}"))?;
    require_canonical_json(&abi_bytes, &abi, "Noir proving ABI")?;
    verify_sha256(&abi_bytes, abi_expected, "Noir proving ABI")?;
    validate_noir_proving_abi(&abi)?;
    if artifact.get("abi") != Some(&abi) {
        return Err("Noir proving ABI does not equal compiler artifact abi".to_owned());
    }

    let vk_expected = parse_digest(&raw.verification_key.sha256, "verification key sha256")?;
    if raw.verification_key.field_count != VERIFICATION_KEY_FIELD_COUNT as u64 {
        return Err(format!(
            "verification key fieldCount must be {VERIFICATION_KEY_FIELD_COUNT}"
        ));
    }
    let vk_bytes = read(&raw.verification_key.attachment)?;
    verify_sha256(&vk_bytes, vk_expected, "verification key")?;
    let expected_vk_bytes = VERIFICATION_KEY_FIELD_COUNT * 32;
    if vk_bytes.len() != expected_vk_bytes {
        return Err(format!(
            "verification key must contain {VERIFICATION_KEY_FIELD_COUNT} 32-byte fields"
        ));
    }
    let mut hash_inputs = Vec::with_capacity(VERIFICATION_KEY_FIELD_COUNT);
    for (index, bytes) in vk_bytes.chunks_exact(32).enumerate() {
        let word: [u8; 32] = bytes.try_into().expect("chunks_exact has width 32");
        let field = fr_from_canonical_bytes(B256::from(word))
            .ok_or_else(|| format!("verification key field {index} is not canonical"))?;
        hash_inputs.push(field);
    }
    let computed_hash = fr_to_bytes(poseidon(&hash_inputs));
    if computed_hash != claimed_hash {
        return Err("verification key does not match applicationVkHash".to_owned());
    }

    validate_display_string(&raw.toolchain.producer_platform, "producerPlatform")?;
    if !matches!(
        raw.toolchain.producer_platform.as_str(),
        "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64"
    ) {
        return Err(
            "producerPlatform must be darwin-arm64, darwin-x64, linux-arm64, or linux-x64"
                .to_owned(),
        );
    }
    validate_display_string(&raw.toolchain.nargo.version, "Nargo version")?;
    validate_display_string(&raw.toolchain.nargo.noirc_commit, "noircCommit")?;
    validate_display_string(&raw.toolchain.barretenberg.version, "Barretenberg version")?;
    validate_display_string(
        &raw.toolchain.barretenberg.verifier_target,
        "Barretenberg verifierTarget",
    )?;
    if raw.toolchain.barretenberg.verifier_target != "chonk" {
        return Err("Barretenberg verifierTarget must be chonk".to_owned());
    }
    let toolchain = SourceToolchain {
        release_manifest_sha256: parse_digest(
            &raw.toolchain.release_manifest_sha256,
            "releaseManifestSha256",
        )?,
        producer_platform: raw.toolchain.producer_platform,
        nargo: NargoToolchain {
            version: raw.toolchain.nargo.version,
            noirc_commit: raw.toolchain.nargo.noirc_commit,
            archive_sha256: parse_digest(
                &raw.toolchain.nargo.archive_sha256,
                "Nargo archiveSha256",
            )?,
        },
        barretenberg: BarretenbergToolchain {
            version: raw.toolchain.barretenberg.version,
            verifier_target: raw.toolchain.barretenberg.verifier_target,
            archive_sha256: parse_digest(
                &raw.toolchain.barretenberg.archive_sha256,
                "Barretenberg archiveSha256",
            )?,
        },
        crs: CrsDigests {
            bn254_g1_sha256: parse_digest(&raw.toolchain.crs.bn254_g1_sha256, "BN254 G1 sha256")?,
            bn254_g2_sha256: parse_digest(&raw.toolchain.crs.bn254_g2_sha256, "BN254 G2 sha256")?,
        },
    };

    Ok(StoredImplementation {
        summary: ImplementationSourceSummary {
            verification_status: Verified::Verified,
            verification_authority: VerificationAuthority::NodeOperator,
            verification_method: VerificationMethod::NodeRegistry,
            application_vk_hash: claimed_hash,
            implementation_label: raw.implementation_label,
            package_root: raw.package_root,
            package_name: raw.package_name,
            source_bundle_digest: expected_bundle_digest,
            compiler_artifact_sha256: artifact_expected,
            decoded_acir_sha256,
            noir_proving_abi_sha256: abi_expected,
            verification_key_sha256: vk_expected,
            verification_key_field_count: VERIFICATION_KEY_FIELD_COUNT as u64,
            toolchain,
        },
        files: source_files,
        noir_proving_abi: abi,
    })
}

fn load_configuration_profile(
    raw: &ConfigurationProfileManifest,
    implementation_label: &str,
) -> Result<StoredConfigurationProfile, String> {
    validate_display_string(&raw.id, "configurationProfile.id")?;
    validate_display_string(
        &raw.implementation_label,
        "configurationProfile.implementationLabel",
    )?;
    if raw.implementation_label != implementation_label {
        return Err(
            "configurationProfile implementationLabel does not match implementationLabel"
                .to_owned(),
        );
    }
    if raw.scheme != "poseidon-explicit-domain-positional-v1" {
        return Err(
            "configurationProfile scheme must be poseidon-explicit-domain-positional-v1".to_owned(),
        );
    }
    let domain = parse_field(&raw.domain, "configurationProfile domain")?;
    if domain != fr_to_bytes(reference_configuration_domain()) {
        return Err(
            "configurationProfile domain must be the REFERENCE_CONFIGURATION_DOMAIN".to_owned(),
        );
    }
    let mut fields = Vec::with_capacity(raw.fields.len());
    for (position, field) in raw.fields.iter().enumerate() {
        validate_display_string(
            &field.name,
            &format!("configurationProfile field {position} name"),
        )?;
        validate_display_string(
            &field.value_type,
            &format!("configurationProfile field {position} type"),
        )?;
        let bits = match field.value_type.as_str() {
            "field" => {
                if field.bits.is_some() {
                    return Err(format!(
                        "configurationProfile field {position} type field must not declare bits"
                    ));
                }
                None
            }
            value_type => {
                let width = value_type
                    .strip_prefix("uint")
                    .and_then(|value| value.parse::<u16>().ok())
                    .filter(|width| (1..=254).contains(width))
                    .ok_or_else(|| {
                        format!(
                            "configurationProfile field {position} type must be field or uint1..uint254"
                        )
                    })?;
                if let Some(bits) = field.bits {
                    if bits != width {
                        return Err(format!(
                            "configurationProfile field {position} bits do not match its uint type"
                        ));
                    }
                }
                Some(width)
            }
        };
        fields.push(StoredConfigurationField {
            name: field.name.clone(),
            value_type: field.value_type.clone(),
            bits,
        });
    }
    Ok(StoredConfigurationProfile {
        selector: raw.selector,
        domain,
        fields,
    })
}

fn fits_unsigned_bits(value: &B256, bits: u16) -> bool {
    let value = value.as_slice();
    let excess = 256usize - usize::from(bits);
    let full_bytes = excess / 8;
    if value[..full_bytes].iter().any(|byte| *byte != 0) {
        return false;
    }
    let remaining = excess % 8;
    remaining == 0 || value[full_bytes] >> (8 - remaining) == 0
}

fn parse_opening(raw: ConfigurationOpeningManifest) -> StoredConfigurationOpening {
    let result = (|| {
        let application_vk_hash =
            parse_field(&raw.application_vk_hash, "opening applicationVkHash")?;
        let configuration_commitment = parse_field(
            &raw.configuration_commitment,
            "opening configurationCommitment",
        )?;
        let domain = parse_field_element(&raw.domain, "configuration domain")?;
        let values = raw
            .values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                parse_field_element(value, &format!("configuration value {index}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut inputs = Vec::with_capacity(values.len() + 1);
        inputs.push(domain);
        inputs.extend(values.iter().copied());
        let computed = fr_to_bytes(poseidon(&inputs));
        if computed != configuration_commitment {
            return Err(
                "opening values do not match its declared configurationCommitment".to_owned(),
            );
        }
        Ok(StoredConfigurationOpening::Valid {
            verification_authority: VerificationAuthority::NodeOperator,
            application_vk_hash,
            configuration_commitment,
            domain: fr_to_bytes(domain),
            values: values.into_iter().map(fr_to_bytes).collect(),
            computed,
        })
    })();
    result.unwrap_or_else(|error| StoredConfigurationOpening::Invalid { error })
}

fn validate_noir_proving_abi(abi: &Value) -> Result<(), String> {
    let parameters = abi
        .get("parameters")
        .and_then(Value::as_array)
        .ok_or_else(|| "Noir proving ABI has no parameters array".to_owned())?;
    for (position, parameter) in parameters.iter().enumerate() {
        if parameter.get("visibility").and_then(Value::as_str) != Some("private") {
            return Err(format!(
                "Noir proving ABI parameter {position} must be private"
            ));
        }
    }
    let return_type = abi
        .get("return_type")
        .and_then(Value::as_object)
        .ok_or_else(|| "Noir proving ABI must return a four-Field databus statement".to_owned())?;
    let abi_type = return_type
        .get("abi_type")
        .and_then(Value::as_object)
        .ok_or_else(|| "Noir proving ABI return_type has no abi_type".to_owned())?;
    if return_type.get("visibility").and_then(Value::as_str) != Some("databus")
        || abi_type.get("kind").and_then(Value::as_str) != Some("array")
        || abi_type.get("length").and_then(Value::as_u64) != Some(PROOF_PROFILE_RETURN_FIELDS)
        || abi_type
            .get("type")
            .and_then(|value| value.get("kind"))
            .and_then(Value::as_str)
            != Some("field")
    {
        return Err("Noir proving ABI must return a four-Field databus statement".to_owned());
    }
    let object = abi
        .as_object()
        .ok_or_else(|| "Noir proving ABI must be a JSON object".to_owned())?;
    if object.len() != 4
        || object.get("abi_version").and_then(Value::as_u64) != Some(NOIR_ABI_VERSION)
        || !object.contains_key("parameters")
        || !object.contains_key("return_type")
        || !object.get("error_types").is_some_and(Value::is_object)
    {
        return Err(format!(
            "Noir proving ABI must contain exactly abi_version {NOIR_ABI_VERSION}, parameters, return_type, and error_types"
        ));
    }
    Ok(())
}

fn require_canonical_json(bytes: &[u8], value: &Value, label: &str) -> Result<(), String> {
    let canonical = canonical_json(value);
    if bytes != canonical.as_bytes() {
        return Err(format!(
            "{label} must be exact canonical JSON without whitespace or noncanonical key ordering"
        ));
    }
    Ok(())
}

/// Match the parsed-JSON subset used by `sdk/src/sourceVerification.ts::canonicalJson`.
/// Object keys use JavaScript's UTF-16 lexical order and JSON primitives use
/// their compact JSON spellings. Noir artifacts only contain finite JSON
/// numbers, so `serde_json::Number` preserves their accepted spelling domain.
fn canonical_json(value: &Value) -> String {
    fn write(value: &Value, output: &mut String) {
        match value {
            Value::Null => output.push_str("null"),
            Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Value::Number(value) => output.push_str(&value.to_string()),
            Value::String(value) => output.push_str(
                &serde_json::to_string(value).expect("serializing a JSON string cannot fail"),
            ),
            Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write(value, output);
                }
                output.push(']');
            }
            Value::Object(values) => {
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
                output.push('{');
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(
                        &serde_json::to_string(key)
                            .expect("serializing a JSON object key cannot fail"),
                    );
                    output.push(':');
                    write(&values[key], output);
                }
                output.push('}');
            }
        }
    }

    let mut output = String::new();
    write(value, &mut output);
    output
}

fn validate_logical_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 1024 || !path.is_ascii() || path.contains('\\') {
        return Err(format!("invalid portable relative path {path:?}"));
    }
    let parsed = Path::new(path);
    if parsed.is_absolute()
        || parsed
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path.split('/').any(|segment| {
            segment.is_empty()
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-/".contains(&byte))
        })
    {
        return Err(format!("invalid portable relative path {path:?}"));
    }
    Ok(())
}

fn validate_display_string(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(format!("{label} must be 1..=256 printable bytes"));
    }
    Ok(())
}

fn validate_nargo_package_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.as_bytes()[0].is_ascii_alphabetic()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("packageName must be a Nargo package identifier".to_owned());
    }
    Ok(())
}

fn parse_address(value: &str) -> Result<Address, String> {
    let bytes = decode_fixed_hex::<20>(value, "address")?;
    Ok(Address::from(bytes))
}

fn parse_field(value: &str, label: &str) -> Result<B256, String> {
    parse_field_element(value, label).map(fr_to_bytes)
}

fn parse_field_element(value: &str, label: &str) -> Result<Fr, String> {
    let bytes = decode_fixed_hex::<32>(value, label)?;
    fr_from_canonical_bytes(B256::from(bytes))
        .ok_or_else(|| format!("{label} is not a canonical BN254 field"))
}

fn require_canonical_field(value: &B256, label: &str) -> Result<Fr, SourceVerificationApiError> {
    fr_from_canonical_bytes(*value).ok_or_else(|| {
        SourceVerificationApiError::Invalid(format!("{label} is not a canonical BN254 field"))
    })
}

fn parse_digest(value: &str, label: &str) -> Result<B256, String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{label} must be exactly 64 lowercase unprefixed hex characters"
        ));
    }
    Ok(B256::from(decode_fixed_hex::<32>(value, label)?))
}

pub(crate) fn decode_fixed_hex<const N: usize>(
    value: &str,
    label: &str,
) -> Result<[u8; N], String> {
    let body = value.strip_prefix("0x").unwrap_or(value);
    // Refuse a wrong size before decoding: callers pass client strings that may
    // be as large as the listener's request ceiling.
    if body.len() != N * 2 {
        return Err(format!("{label} must be exactly {N} bytes"));
    }
    let mut decoded = [0u8; N];
    hex::decode_to_slice(body, &mut decoded)
        .map_err(|error| format!("bad {label} hex: {error}"))?;
    Ok(decoded)
}

fn verify_sha256(bytes: &[u8], expected: B256, label: &str) -> Result<(), String> {
    let actual = B256::from(<[u8; 32]>::from(Sha256::digest(bytes)));
    if actual != expected {
        return Err(format!("{label} sha256 mismatch"));
    }
    Ok(())
}

/// `SHA256("pcash.source-bundle\\0" || JCS(path-sorted [{path,length,sha256}]))`.
///
/// Paths are portable ASCII, lengths are unsigned integers, and digests are
/// lowercase unprefixed hex, so this explicit encoder is the RFC 8785 encoding
/// of the deliberately narrow index schema.
fn source_bundle_digest(files: &[StoredSourceFile]) -> B256 {
    let mut index = String::from("[");
    for (position, file) in files.iter().enumerate() {
        if position != 0 {
            index.push(',');
        }
        index.push_str("{\"length\":");
        index.push_str(&file.metadata.length.to_string());
        index.push_str(",\"path\":");
        index.push_str(&serde_json::to_string(&file.metadata.path).expect("source path is JSON"));
        index.push_str(",\"sha256\":\"");
        index.push_str(&hex::encode(file.metadata.sha256));
        index.push_str("\"}");
    }
    index.push(']');
    let mut hash = Sha256::new();
    hash.update(b"pcash.source-bundle\0");
    hash.update(index.as_bytes());
    B256::from(<[u8; 32]>::from(hash.finalize()))
}

pub(crate) fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    if !input.len().is_multiple_of(4) {
        return Err("value is not padded base64".to_owned());
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (chunk_index, chunk) in bytes.chunks_exact(4).enumerate() {
        let last = chunk_index + 1 == bytes.len() / 4;
        let padding = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
        if padding > 2 || (padding > 0 && !last) {
            return Err("value has invalid base64 padding".to_owned());
        }
        let a = sextet(chunk[0]).ok_or_else(|| "value is not base64".to_owned())?;
        let b = sextet(chunk[1]).ok_or_else(|| "value is not base64".to_owned())?;
        let c = if chunk[2] == b'=' {
            0
        } else {
            sextet(chunk[2]).ok_or_else(|| "value is not base64".to_owned())?
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            sextet(chunk[3]).ok_or_else(|| "value is not base64".to_owned())?
        };
        out.push((a << 2) | (b >> 4));
        if padding < 2 {
            out.push((b << 4) | (c >> 2));
        }
        if padding == 0 {
            out.push((c << 6) | d);
        }
    }
    Ok(out)
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
    use alloy_primitives::Address;
    use pcash_crypto::Fr;
    use pcash_rpc::{
        AccountDto, AccountProofDto, ContractFunctionDto, CurrentBoundaryEnvelope, InclusionId,
        ReceiveMaterialDto,
    };
    use pcash_rpc::{AccountProofPresent, ContractPresent};
    use pcash_state::{BlockHeader, IssuanceState, StateComponents};
    use serde_json::json;

    #[test]
    fn in_memory_registry_uses_the_persistent_schema() {
        let service = SourceVerificationService::open_in_memory(1, B256::repeat_byte(2), None);
        let SourceBackend::Registry(db) = &service.backend else {
            panic!("in-memory source registry did not open");
        };
        require_tables(
            db,
            &[
                "implementations",
                "configuration_bindings",
                "meta",
                "openings",
                "presentations",
                "submissions",
            ],
        )
        .unwrap();
    }

    struct Fixture {
        manifest: PathBuf,
        application_vk_hash: B256,
        configuration_commitment: B256,
    }

    fn hex32(value: impl AsRef<[u8]>) -> String {
        format!("0x{}", hex::encode(value))
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        hex::encode(<[u8; 32]>::from(Sha256::digest(bytes)))
    }

    fn read_manifest(fixture: &Fixture) -> Value {
        serde_json::from_slice(&std::fs::read(&fixture.manifest).unwrap()).unwrap()
    }

    fn write_manifest(fixture: &Fixture, manifest: &Value) {
        std::fs::write(&fixture.manifest, serde_json::to_vec(manifest).unwrap()).unwrap();
    }

    fn base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let a = chunk[0];
            let b = chunk.get(1).copied().unwrap_or(0);
            let c = chunk.get(2).copied().unwrap_or(0);
            output.push(ALPHABET[(a >> 2) as usize] as char);
            output.push(ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
            output.push(if chunk.len() > 1 {
                ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char
            } else {
                '='
            });
            output.push(if chunk.len() > 2 {
                ALPHABET[(c & 63) as usize] as char
            } else {
                '='
            });
        }
        output
    }

    fn publication(fixture: &Fixture) -> SourceVerificationPublication {
        fn attachments(value: &Value, paths: &mut HashSet<String>) {
            match value {
                Value::Object(values) => {
                    if let Some(path) = values.get("attachment").and_then(Value::as_str) {
                        paths.insert(path.to_owned());
                    }
                    for value in values.values() {
                        attachments(value, paths);
                    }
                }
                Value::Array(values) => {
                    for value in values {
                        attachments(value, paths);
                    }
                }
                _ => {}
            }
        }

        let manifest = read_manifest(fixture);
        let mut paths = HashSet::new();
        attachments(&manifest, &mut paths);
        let root = fixture.manifest.parent().unwrap();
        SourceVerificationPublication {
            manifest,
            attachments: paths
                .into_iter()
                .map(|path| {
                    let content = std::fs::read(root.join(&path)).unwrap();
                    (path, base64(&content))
                })
                .collect(),
        }
    }

    /// A registry-backed service with reproduction switched off.
    fn registry(root: &Path) -> SourceVerificationService {
        SourceVerificationService::open_without_reproduction(
            root.join("state.source.redb"),
            7,
            B256::from([9u8; 32]),
        )
    }

    /// A registry holding the fixture's publication.
    fn published(root: &Path, fixture: &Fixture) -> SourceVerificationService {
        let service = registry(root);
        service.publish(publication(fixture)).unwrap();
        service
    }

    /// Why the fixture's publication fails to load.
    fn load_error(fixture: &Fixture) -> String {
        match load_publication(&publication(fixture)) {
            Ok(_) => panic!("fixture publication loaded"),
            Err(error) => error,
        }
    }

    fn write_fixture(root: &Path, invalid_opening: bool) -> Fixture {
        std::fs::create_dir_all(root.join("attachments")).unwrap();
        let source = b"fn main(recent_pcash_block_hash: Field, witness: Field) -> return_data [Field; 3] { [witness, witness, recent_pcash_block_hash] }\n";
        std::fs::write(root.join("attachments/main.nr"), source).unwrap();

        let abi = json!({
            "parameters": [
                {"name":"recent_pcash_block_hash", "type":{"kind":"field"}, "visibility":"private"},
                {"name":"witness", "type":{"kind":"field"}, "visibility":"private"}
            ],
            "return_type": {
                "abi_type":{"kind":"array", "length":4, "type":{"kind":"field"}},
                "visibility":"databus"
            },
            "error_types": {},
            "abi_version": 1
        });
        let abi_bytes = serde_json::to_vec(&abi).unwrap();
        std::fs::write(root.join("attachments/abi.json"), &abi_bytes).unwrap();
        let artifact = serde_json::to_vec(&json!({
            "noir_version":"1.0.0-rc.3+test",
            "abi":abi,
            "bytecode":"Zg=="
        }))
        .unwrap();
        std::fs::write(root.join("attachments/artifact.json"), &artifact).unwrap();

        let mut vk = Vec::with_capacity(VERIFICATION_KEY_FIELD_COUNT * 32);
        let mut hash_inputs = Vec::new();
        for value in 1..=VERIFICATION_KEY_FIELD_COUNT {
            let field = Fr::from(value as u64);
            vk.extend_from_slice(fr_to_bytes(field).as_slice());
            hash_inputs.push(field);
        }
        std::fs::write(root.join("attachments/vk"), &vk).unwrap();
        let application_vk_hash = fr_to_bytes(poseidon(&hash_inputs));

        let source_bundle_digest = {
            let index = format!(
                "[{{\"length\":{},\"path\":\"src/main.nr\",\"sha256\":\"{}\"}}]",
                source.len(),
                hex::encode(<[u8; 32]>::from(Sha256::digest(source)))
            );
            let mut hash = Sha256::new();
            hash.update(b"pcash.source-bundle\0");
            hash.update(index.as_bytes());
            <[u8; 32]>::from(hash.finalize())
        };
        let domain = fr_to_bytes(reference_configuration_domain());
        let values = [fr_to_bytes(Fr::from(8u64)), fr_to_bytes(Fr::from(9u64))];
        let configuration_commitment = fr_to_bytes(poseidon(&[
            reference_configuration_domain(),
            Fr::from(8u64),
            Fr::from(9u64),
        ]));
        let manifest = json!({
            "schemaVersion": 1,
            "bundleFormat": "pcash-contract-source-bundle-v1",
            "serviceName": "fixture operator",
            "proofProfile": {
                "id": "pcash-chonk-application-v1",
                "returnFields":4,
                "returnVisibility":"databus"
            },
            "presentation": {
                "schemaVersion":1,
                "publisherLabel":"Fixture publisher",
                "contractName":"Fixture contract",
                "contractDescription":"Fixture contract presentation.",
                "functions":[{
                    "selector":0,
                    "applicationVkHash":hex32(application_vk_hash),
                    "name":"fixture",
                    "summary":"Checks the fixture witness.",
                    "configurationFields":[
                        {"position":0,"name":"first","label":"First","description":"The first fixture value.","displayFormat":"field","overviewOrder":0},
                        {"position":1,"name":"second","label":"Second","description":"The second fixture value.","displayFormat":"uint","overviewOrder":null}
                    ],
                    "proofGroups":[{
                        "title":"Fixture proof",
                        "description":"Values proved by this fixture.",
                        "items":[
                            {"abiParameter":"recent_pcash_block_hash","description":"The recent PCASH block the proof reads."},
                            {"abiParameter":"witness","description":"The fixture witness."}
                        ]
                    }]
                }]
            },
            "implementations": [{
                "applicationVkHash": hex32(application_vk_hash),
                "implementationLabel": "fixture",
                "packageRoot": "fixture",
                "packageName": "fixture_rule",
                "sourceBundleDigest": hex::encode(source_bundle_digest),
                "sourceFiles": [{
                    "path":"src/main.nr",
                    "attachment":"attachments/main.nr",
                    "length":source.len(),
                    "sha256":sha256_hex(source)
                }],
                "compilerArtifact": {
                    "attachment":"attachments/artifact.json",
                    "sha256":sha256_hex(&artifact),
                    "decodedAcirSha256":sha256_hex(b"f")
                },
                "noirProvingAbi": {
                    "attachment":"attachments/abi.json",
                    "sha256":sha256_hex(&abi_bytes)
                },
                "verificationKey": {
                    "attachment":"attachments/vk",
                    "sha256":sha256_hex(&vk),
                    "fieldCount":VERIFICATION_KEY_FIELD_COUNT
                },
                "toolchain": {
                    "releaseManifestSha256":hex::encode([1;32]),
                    "producerPlatform":"darwin-arm64",
                    "nargo":{"version":"1.0.0-rc.3", "noircCommit":"test", "archiveSha256":hex::encode([2;32])},
                    "barretenberg":{"version":"0.0.0-test", "verifierTarget":"chonk", "archiveSha256":hex::encode([3;32])},
                    "crs":{"bn254G1Sha256":hex::encode([4;32]), "bn254G2Sha256":hex::encode([5;32])}
                }
            }],
            "configurationBindings": [{
                "applicationVkHash": hex32(application_vk_hash),
                "configurationProfile": {
                    "id":"fixture-v1",
                    "implementationLabel":"fixture",
                    "selector":0,
                    "scheme":"poseidon-explicit-domain-positional-v1",
                    "domain":hex32(domain),
                    "fields":[
                        {"name":"first", "type":"field"},
                        {"name":"second", "type":"field"}
                    ]
                }
            }],
            "configurationOpenings": [{
                "address":"0x0000000000000000000000000000000000000001",
                "selector":0,
                "applicationVkHash":hex32(application_vk_hash),
                "configurationCommitment":hex32(configuration_commitment),
                "domain": if invalid_opening { Value::String("not-hex".to_owned()) } else { Value::String(hex32(domain)) },
                "values":[hex32(values[0]), hex32(values[1])]
            }]
        });
        let manifest_path = root.join("source-verification.json");
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        Fixture {
            manifest: manifest_path,
            application_vk_hash,
            configuration_commitment,
        }
    }

    fn contract(fixture: &Fixture, include_missing: bool) -> ContractDto {
        let address = Address::from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let mut functions = vec![ContractFunctionDto {
            selector: 0,
            application_vk_hash: fixture.application_vk_hash,
            configuration_commitment: fixture.configuration_commitment,
        }];
        if include_missing {
            functions.push(ContractFunctionDto {
                selector: 1,
                application_vk_hash: fr_to_bytes(Fr::from(999u64)),
                configuration_commitment: fr_to_bytes(Fr::from(11u64)),
            });
        }
        ContractDto {
            status: ContractPresent::Contract,
            address,
            account_proof: AccountProofDto {
                status: AccountProofPresent::Present,
                account: AccountDto {
                    address,
                    index: 0,
                    account_revision: 1,
                    account_kind: 1,
                    nullifier_key_commitment: fr_to_bytes(Fr::from(1u64)),
                    account_rule_set_commitment: fr_to_bytes(Fr::from(2u64)),
                    receive_key_hash: B256::ZERO,
                    material: ReceiveMaterialDto::NotPresent,
                },
                account_state_root: fr_to_bytes(Fr::from(3u64)),
                account_siblings: [B256::ZERO; 40],
                account_count: 1,
                state_root_header_siblings: [B256::ZERO; 4],
                account_state_root_state_siblings: [B256::ZERO; 4],
                boundary: CurrentBoundaryEnvelope {
                    state: StateComponents {
                        output_root: B256::ZERO,
                        output_count: 0,
                        issuance: IssuanceState {
                            issued_so_far: U256::ZERO,
                            lag_q: alloy_primitives::I256::ZERO,
                        },
                        account_state_root: fr_to_bytes(Fr::from(3u64)),
                        account_count: 1,
                        nullifier_root: B256::ZERO,
                        nullifier_count: 0,
                    },
                    header: BlockHeader {
                        parent_hash: B256::ZERO,
                        number: 4,
                        timestamp: 5,
                        transaction_results_root: B256::ZERO,
                        state_root: B256::ZERO,
                        l1_origin_root: fr_to_bytes(Fr::from(13u64)),
                        history_root: fr_to_bytes(Fr::from(14u64)),
                    },
                    block_hash: B256::repeat_byte(4),
                },
            },
            functions,
            transaction: vec![1, 2, 3].into(),
            origin: InclusionId {
                l1_block_number: 6,
                l1_block_hash: B256::repeat_byte(6),
                l1_transaction_index: 7,
                l1_transaction_hash: B256::repeat_byte(7),
                batch_item_index: 8,
            },
        }
    }

    #[test]
    fn base64_decoder_accepts_padded_artifact_encoding() {
        assert_eq!(
            decode_base64("H4sIAAAAAAAA").unwrap(),
            b"\x1f\x8b\x08\0\0\0\0\0\0"
        );
        assert_eq!(decode_base64("Zg==").unwrap(), b"f");
        assert_eq!(decode_base64("Zm8=").unwrap(), b"fo");
    }

    #[test]
    fn explicit_domain_configuration_opening_is_positional() {
        let domain = fr_to_bytes(reference_configuration_domain());
        let first = fr_to_bytes(Fr::from(8u64));
        let second = fr_to_bytes(Fr::from(9u64));
        let configuration_commitment = fr_to_bytes(poseidon(&[
            reference_configuration_domain(),
            Fr::from(8u64),
            Fr::from(9u64),
        ]));
        let opening = parse_opening(ConfigurationOpeningManifest {
            address: "0x0000000000000000000000000000000000000001".to_owned(),
            selector: 0,
            application_vk_hash: hex32(fr_to_bytes(Fr::from(6u64))),
            configuration_commitment: hex32(configuration_commitment),
            domain: format!("0x{}", hex::encode(domain)),
            values: vec![
                format!("0x{}", hex::encode(first)),
                format!("0x{}", hex::encode(second)),
            ],
        });
        match opening {
            StoredConfigurationOpening::Valid { computed, .. } => {
                assert_eq!(
                    computed,
                    fr_to_bytes(poseidon(&[
                        reference_configuration_domain(),
                        Fr::from(8u64),
                        Fr::from(9u64),
                    ]))
                );
            }
            StoredConfigurationOpening::Invalid { error } => panic!("{error}"),
        }
    }

    #[test]
    fn invalid_opening_is_data_not_a_manifest_failure() {
        let opening = parse_opening(ConfigurationOpeningManifest {
            address: "0x0000000000000000000000000000000000000001".to_owned(),
            selector: 0,
            application_vk_hash: hex32(fr_to_bytes(Fr::from(6u64))),
            configuration_commitment: hex32(fr_to_bytes(Fr::from(7u64))),
            domain: "not-hex".to_owned(),
            values: vec![],
        });
        assert!(matches!(
            opening,
            StoredConfigurationOpening::Invalid { .. }
        ));
    }

    #[test]
    fn noir_proving_abi_requires_private_inputs_and_a_four_field_databus_return() {
        let field = |name: &str, visibility: &str| json!({"name":name, "type":{"kind":"field"}, "visibility":visibility});
        let statement = || {
            json!({
                "abi_type":{"kind":"array", "length":4, "type":{"kind":"field"}},
                "visibility":"databus"
            })
        };
        let valid = json!({
            "parameters":[
                {"name":"fee_paid", "type":{"kind":"boolean"}, "visibility":"private"},
                field("recent_pcash_block_hash", "private"),
                field("witness", "private")
            ],
            "return_type":statement(),
            "error_types":{},
            "abi_version":1
        });
        validate_noir_proving_abi(&valid).unwrap();

        let no_inputs = json!({
            "parameters":[],
            "return_type":statement(),
            "error_types":{},
            "abi_version":1
        });
        validate_noir_proving_abi(&no_inputs).unwrap();

        let leading_public = json!({
            "parameters":[
                field("witness", "public"),
                field("a", "private")
            ],
            "return_type":statement(),
            "error_types":{},
            "abi_version":1
        });
        assert!(validate_noir_proving_abi(&leading_public)
            .unwrap_err()
            .contains("parameter 0 must be private"));

        let later_public = json!({
            "parameters":[
                field("a", "private"),
                field("extra", "public")
            ],
            "return_type":statement(),
            "error_types":{},
            "abi_version":1
        });
        assert!(validate_noir_proving_abi(&later_public)
            .unwrap_err()
            .contains("parameter 1 must be private"));

        let mut five_field_return = valid.clone();
        five_field_return["return_type"]["abi_type"]["length"] = json!(5);
        assert!(validate_noir_proving_abi(&five_field_return)
            .unwrap_err()
            .contains("four-Field databus"));

        let mut public_return = valid.clone();
        public_return["return_type"]["visibility"] = json!("public");
        assert!(validate_noir_proving_abi(&public_return)
            .unwrap_err()
            .contains("four-Field databus"));

        let mut other_version = valid.clone();
        other_version["abi_version"] = json!(2);
        assert!(validate_noir_proving_abi(&other_version)
            .unwrap_err()
            .contains("abi_version 1"));

        let mut absent_errors = valid.clone();
        absent_errors.as_object_mut().unwrap().remove("error_types");
        assert!(validate_noir_proving_abi(&absent_errors)
            .unwrap_err()
            .contains("error_types"));

        let mut absent_return = valid;
        absent_return.as_object_mut().unwrap().remove("return_type");
        assert!(validate_noir_proving_abi(&absent_return)
            .unwrap_err()
            .contains("four-Field databus"));
    }

    #[test]
    fn canonical_json_sorts_keys_and_rejects_pretty_attachments() {
        assert_eq!(
            canonical_json(&json!({"z":1,"a":{"d":4,"c":3}})),
            r#"{"a":{"c":3,"d":4},"z":1}"#
        );

        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let abi_path = directory.path().join("attachments/abi.json");
        let abi: Value = serde_json::from_slice(&std::fs::read(&abi_path).unwrap()).unwrap();
        let pretty = serde_json::to_vec_pretty(&abi).unwrap();
        std::fs::write(&abi_path, &pretty).unwrap();
        let mut manifest = read_manifest(&fixture);
        manifest["implementations"][0]["noirProvingAbi"]["sha256"] =
            Value::String(sha256_hex(&pretty));
        write_manifest(&fixture, &manifest);

        let error = load_error(&fixture);
        assert!(error.contains("Noir proving ABI must be exact canonical JSON"));
    }

    #[test]
    fn compiler_artifact_rejects_noncanonical_key_order() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let abi = std::fs::read_to_string(directory.path().join("attachments/abi.json")).unwrap();
        let noncanonical = format!(r#"{{"bytecode":"Zg==","abi":{abi}}}"#).into_bytes();
        std::fs::write(
            directory.path().join("attachments/artifact.json"),
            &noncanonical,
        )
        .unwrap();
        let mut manifest = read_manifest(&fixture);
        manifest["implementations"][0]["compilerArtifact"]["sha256"] =
            Value::String(sha256_hex(&noncanonical));
        write_manifest(&fixture, &manifest);

        let error = load_error(&fixture);
        assert!(error.contains("compiler artifact must be exact canonical JSON"));

        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let artifact_path = directory.path().join("attachments/artifact.json");
        let mut artifact: Value =
            serde_json::from_slice(&std::fs::read(&artifact_path).unwrap()).unwrap();
        artifact.as_object_mut().unwrap().remove("noir_version");
        let canonical = canonical_json(&artifact).into_bytes();
        std::fs::write(&artifact_path, &canonical).unwrap();
        let mut manifest = read_manifest(&fixture);
        manifest["implementations"][0]["compilerArtifact"]["sha256"] =
            Value::String(sha256_hex(&canonical));
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("exactly noir_version"));
    }

    #[test]
    fn manifest_requires_the_v1_bundle_and_proof_profile() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut manifest = read_manifest(&fixture);
        manifest.as_object_mut().unwrap().remove("bundleFormat");
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("bundleFormat"));

        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut manifest = read_manifest(&fixture);
        manifest["proofProfile"]["returnFields"] = json!(5);
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("proofProfile"));

        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut manifest = read_manifest(&fixture);
        manifest["implementations"][0]["packageName"] = json!("../escape");
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("Nargo package identifier"));
    }

    #[test]
    fn presentation_proof_items_cover_every_abi_parameter() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut manifest = read_manifest(&fixture);
        manifest["presentation"]["functions"][0]["proofGroups"][0]["items"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("must cover every ABI parameter exactly once"));
    }

    #[test]
    fn required_toolchain_identity_is_exposed_with_the_manifest_schema() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let service = published(directory.path(), &fixture);
        let source = serde_json::to_value(
            service
                .implementation_source(&fixture.application_vk_hash)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let toolchain = &source["implementation"]["toolchain"];
        assert_eq!(toolchain["producerPlatform"], "darwin-arm64");
        assert_eq!(toolchain["releaseManifestSha256"], hex32([1; 32]));
        assert_eq!(toolchain["nargo"]["archiveSha256"], hex32([2; 32]));
        assert_eq!(toolchain["barretenberg"]["archiveSha256"], hex32([3; 32]));
        assert_eq!(toolchain["crs"]["bn254G1Sha256"], hex32([4; 32]));
        assert_eq!(toolchain["crs"]["bn254G2Sha256"], hex32([5; 32]));
        assert!(toolchain["nargo"].get("sha256").is_none());

        let mut manifest = read_manifest(&fixture);
        manifest["implementations"][0]["toolchain"]
            .as_object_mut()
            .unwrap()
            .remove("releaseManifestSha256");
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("releaseManifestSha256"));

        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut manifest = read_manifest(&fixture);
        manifest["implementations"][0]["toolchain"]["producerPlatform"] = json!("windows-x64");
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("producerPlatform must be"));

        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut manifest = read_manifest(&fixture);
        manifest["implementations"][0]["toolchain"]["releaseManifestSha256"] =
            json!(format!("0x{}", hex::encode([1; 32])));
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("lowercase unprefixed"));
    }

    #[test]
    fn configuration_openings_require_the_exact_selector_vk_profile() {
        fn assert_rejected(mutate: impl FnOnce(&mut Value)) {
            let directory = tempfile::tempdir().unwrap();
            let fixture = write_fixture(directory.path(), false);
            let mut manifest = read_manifest(&fixture);
            mutate(&mut manifest);
            write_manifest(&fixture, &manifest);
            let service = registry(directory.path());
            let error = service.publish(publication(&fixture)).unwrap_err();
            assert!(error
                .to_string()
                .contains("publication contains an invalid configuration opening"));
            assert_eq!(service.info().implementation_count, 0);
        }

        assert_rejected(|manifest| {
            manifest["configurationOpenings"][0]["applicationVkHash"] =
                Value::String(hex32(fr_to_bytes(Fr::from(44u64))));
        });
        assert_rejected(|manifest| {
            manifest["configurationOpenings"][0]["configurationCommitment"] =
                Value::String(hex32(fr_to_bytes(Fr::from(44u64))));
        });
        assert_rejected(|manifest| {
            manifest["configurationBindings"][0]["configurationProfile"]["fields"]
                .as_array_mut()
                .unwrap()
                .pop();
            manifest["presentation"]["functions"][0]["configurationFields"]
                .as_array_mut()
                .unwrap()
                .pop();
        });
        assert_rejected(|manifest| {
            manifest["configurationBindings"][0]["configurationProfile"]["fields"][0]["type"] =
                json!("uint3");
            manifest["configurationBindings"][0]["configurationProfile"]["fields"][0]["bits"] =
                json!(3);
        });

        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut manifest = read_manifest(&fixture);
        manifest["configurationBindings"][0]["configurationProfile"]["implementationLabel"] =
            json!("different label");
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("does not match implementationLabel"));

        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut manifest = read_manifest(&fixture);
        manifest["configurationBindings"][0]["configurationProfile"]["domain"] =
            Value::String(hex32(fr_to_bytes(Fr::from(44u64))));
        write_manifest(&fixture, &manifest);
        let error = load_error(&fixture);
        assert!(error.contains("REFERENCE_CONFIGURATION_DOMAIN"));
    }

    #[test]
    fn distinct_selector_bindings_for_one_vk_coexist() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let service = SourceVerificationService::open_without_reproduction(
            directory.path().join("state.source.redb"),
            7,
            B256::from([9u8; 32]),
        );
        let mut first = publication(&fixture);
        first.manifest["configurationBindings"][0]["configurationProfile"]["selector"] = json!(1);
        first.manifest["presentation"]["functions"][0]["selector"] = json!(1);
        first.manifest["configurationOpenings"] = json!([]);
        service.publish(first).unwrap();

        service.publish(publication(&fixture)).unwrap();
        let snapshot = service.snapshot().unwrap();
        assert!(snapshot
            .configuration_bindings
            .contains_key(&ConfigurationBindingKey {
                selector: 0,
                application_vk_hash: fixture.application_vk_hash,
            }));
        assert!(snapshot
            .configuration_bindings
            .contains_key(&ConfigurationBindingKey {
                selector: 1,
                application_vk_hash: fixture.application_vk_hash,
            }));
        drop(snapshot);
        let view = service.contract_source(contract(&fixture, false)).unwrap();
        assert_eq!(view.status, ContractSourceStatus::Verified);
        assert_eq!(view.configuration_openings.len(), 1);
        assert_eq!(
            view.configuration_openings[0].status,
            ConfigurationOpeningStatus::Verified
        );
        assert!(view.configuration_openings[0]
            .values
            .iter()
            .all(|value| value.name.is_some() && value.value_type.is_some()));
    }

    #[test]
    fn repeated_vk_shape_uses_one_source_and_distinct_selector_configuration_bindings() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let mut manifest = read_manifest(&fixture);
        let mut second_binding = manifest["configurationBindings"][0].clone();
        second_binding["configurationProfile"]["id"] = json!("fixture-second-v1");
        second_binding["configurationProfile"]["selector"] = json!(1);
        second_binding["configurationProfile"]["fields"][0]["name"] = json!("third");
        second_binding["configurationProfile"]["fields"][1]["name"] = json!("fourth");
        manifest["configurationBindings"]
            .as_array_mut()
            .unwrap()
            .push(second_binding);

        let mut second_function = manifest["presentation"]["functions"][0].clone();
        second_function["selector"] = json!(1);
        second_function["name"] = json!("fixture_second");
        second_function["summary"] = json!("Checks the second fixture configuration.");
        second_function["configurationFields"][0]["name"] = json!("third");
        second_function["configurationFields"][0]["label"] = json!("Third");
        second_function["configurationFields"][0]["overviewOrder"] = Value::Null;
        second_function["configurationFields"][1]["name"] = json!("fourth");
        second_function["configurationFields"][1]["label"] = json!("Fourth");
        manifest["presentation"]["functions"]
            .as_array_mut()
            .unwrap()
            .push(second_function);

        let second_values = [Fr::from(10u64), Fr::from(11u64)];
        let second_commitment = fr_to_bytes(poseidon(&[
            reference_configuration_domain(),
            second_values[0],
            second_values[1],
        ]));
        let mut second_opening = manifest["configurationOpenings"][0].clone();
        second_opening["selector"] = json!(1);
        second_opening["configurationCommitment"] = json!(hex32(second_commitment));
        second_opening["values"] = json!([
            hex32(fr_to_bytes(second_values[0])),
            hex32(fr_to_bytes(second_values[1]))
        ]);
        manifest["configurationOpenings"]
            .as_array_mut()
            .unwrap()
            .push(second_opening);
        write_manifest(&fixture, &manifest);

        let registry = directory.path().join("state.source.redb");
        {
            let service = SourceVerificationService::open_without_reproduction(
                &registry,
                7,
                B256::from([9u8; 32]),
            );
            service.publish(publication(&fixture)).unwrap();
            let mut repeated = contract(&fixture, false);
            repeated.functions.push(ContractFunctionDto {
                selector: 1,
                application_vk_hash: fixture.application_vk_hash,
                configuration_commitment: second_commitment,
            });
            let view = service.contract_source(repeated.clone()).unwrap();
            assert_eq!(view.status, ContractSourceStatus::Verified);
            assert_eq!(view.implementations.len(), 1);
            assert_eq!(view.configuration_openings.len(), 2);
            assert_eq!(
                view.configuration_openings[1].values[0].name.as_deref(),
                Some("third")
            );
            let bundle = service.contract_bundle(repeated).unwrap();
            assert_eq!(bundle.implementations.len(), 1);
            assert_eq!(bundle.view.presentation.unwrap().profile.functions.len(), 2);
        }

        let reopened = SourceVerificationService::open_without_reproduction(
            &registry,
            7,
            B256::from([9u8; 32]),
        );
        let mut repeated = contract(&fixture, false);
        repeated.functions.push(ContractFunctionDto {
            selector: 1,
            application_vk_hash: fixture.application_vk_hash,
            configuration_commitment: second_commitment,
        });
        let view = reopened.contract_source(repeated).unwrap();
        assert_eq!(view.status, ContractSourceStatus::Verified);
        assert_eq!(view.implementations.len(), 1);
        assert_eq!(view.configuration_openings.len(), 2);
    }

    #[test]
    fn valid_manifest_verifies_artifacts_whole_contract_and_opening() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let service = published(directory.path(), &fixture);
        let info = service.info();
        assert_eq!(info.status, SourceVerificationStatus::Ready);
        assert_eq!(info.implementation_count, 1);
        assert_eq!(info.invalid_configuration_opening_count, 0);

        let implementation = service
            .implementation_source(&fixture.application_vk_hash)
            .unwrap()
            .unwrap();
        assert_eq!(implementation.source_files[0].path, "src/main.nr");
        assert_eq!(
            implementation.summary.verification_key_field_count,
            VERIFICATION_KEY_FIELD_COUNT as u64
        );
        let file = service
            .implementation_source_file(&fixture.application_vk_hash, "src/main.nr")
            .unwrap()
            .unwrap();
        assert!(file.content.starts_with("fn main"));

        let view = service.contract_source(contract(&fixture, false)).unwrap();
        assert_eq!(view.status, ContractSourceStatus::Verified);
        assert_eq!(view.implementations.len(), 1);
        assert_eq!(view.configuration_openings.len(), 1);
        let presentation = view.presentation.as_ref().unwrap();
        assert_eq!(presentation.profile.contract_name, "Fixture contract");
        assert_eq!(
            presentation.verification_authority,
            VerificationAuthority::NodeOperator
        );
        assert_eq!(
            view.configuration_openings[0].status,
            ConfigurationOpeningStatus::Verified
        );
        assert_eq!(
            view.configuration_openings[0].values[0].name.as_deref(),
            Some("first")
        );

        let incomplete = service.contract_source(contract(&fixture, true)).unwrap();
        assert_eq!(incomplete.status, ContractSourceStatus::NotVerified);
        assert_eq!(incomplete.contract.functions.len(), 2);
        assert!(incomplete.implementations.is_empty());
        assert!(incomplete.configuration_openings.is_empty());
        assert!(incomplete.presentation.is_none());
        let incomplete_bundle = service.contract_bundle(contract(&fixture, true)).unwrap();
        assert!(incomplete_bundle.implementations.is_empty());
        let mut empty_contract = contract(&fixture, false);
        empty_contract.functions.clear();
        let empty = service.contract_source(empty_contract).unwrap();
        assert_eq!(empty.status, ContractSourceStatus::NotVerified);
        assert!(empty.implementations.is_empty());
        assert!(empty.presentation.is_none());
        let bundle = service.contract_bundle(contract(&fixture, false)).unwrap();
        assert_eq!(bundle.implementations.len(), 1);
        assert_eq!(bundle.implementations[0].files.len(), 1);
    }

    #[test]
    fn publication_with_an_invalid_opening_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), true);
        let service = registry(directory.path());
        let error = service.publish(publication(&fixture)).unwrap_err();
        assert!(error
            .to_string()
            .contains("publication contains an invalid configuration opening"));
        assert_eq!(service.info().implementation_count, 0);
    }

    #[test]
    fn absent_opening_leaves_source_verified() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(&fixture.manifest).unwrap()).unwrap();
        manifest["configurationOpenings"] = json!([]);
        std::fs::write(&fixture.manifest, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let service = published(directory.path(), &fixture);
        let view = service.contract_source(contract(&fixture, false)).unwrap();
        assert_eq!(view.status, ContractSourceStatus::Verified);
        assert!(view.configuration_openings.is_empty());
    }

    #[test]
    fn presentation_requires_the_exact_live_ordered_selector_vk_shape() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let service = published(directory.path(), &fixture);
        let mut changed_selector = contract(&fixture, false);
        changed_selector.functions[0].selector = 1;
        let view = service.contract_source(changed_selector).unwrap();
        assert_eq!(view.status, ContractSourceStatus::NotVerified);
        assert!(view.presentation.is_none());
    }

    #[test]
    fn malformed_overview_order_types_are_rejected_without_panicking() {
        for malformed in [json!(true), json!("0"), json!([])] {
            let directory = tempfile::tempdir().unwrap();
            let fixture = write_fixture(directory.path(), false);
            let mut manifest = read_manifest(&fixture);
            manifest["presentation"]["functions"][0]["configurationFields"][0]["overviewOrder"] =
                malformed;
            write_manifest(&fixture, &manifest);
            assert!(load_error(&fixture)
                .contains("overviewOrder must be a nonnegative safe integer or null"));
        }
    }

    // ---- permissionless submission channel regressions ----

    use crate::api::{publication_content_id, PscanApi, PscanService};
    use crate::dto::{
        ContractConfigurationOpeningSubmission, SubmissionApiError, SubmitContractSourceResult,
        SubmittedSourceEnvelope,
    };

    struct ReaderStub {
        contract: Option<ContractDto>,
    }

    impl crate::api::ContractIndexReader for ReaderStub {
        fn contract_for_source(&self, _address: Address) -> Result<Option<ContractDto>, String> {
            Ok(self.contract.clone())
        }

        fn contract_verification_changed(&self, _address: Option<Address>) -> Result<(), String> {
            Ok(())
        }
    }

    /// Reader double that records every verification notification it receives.
    struct RecordingReader {
        contract: Option<ContractDto>,
        calls: Arc<Mutex<Vec<Option<Address>>>>,
    }

    impl RecordingReader {
        fn new(contract: Option<ContractDto>) -> (Self, Arc<Mutex<Vec<Option<Address>>>>) {
            let calls = Arc::new(Mutex::new(Vec::new()));
            (
                Self {
                    contract,
                    calls: Arc::clone(&calls),
                },
                calls,
            )
        }
    }

    impl crate::api::ContractIndexReader for RecordingReader {
        fn contract_for_source(&self, _address: Address) -> Result<Option<ContractDto>, String> {
            Ok(self.contract.clone())
        }

        fn contract_verification_changed(&self, address: Option<Address>) -> Result<(), String> {
            self.calls.lock().push(address);
            Ok(())
        }
    }

    fn envelope_for(fixture: &Fixture, contract: &ContractDto) -> SubmittedSourceEnvelope {
        SubmittedSourceEnvelope {
            contract_addresses: vec![contract.address],
            publication: publication(fixture),
        }
    }

    fn configuration_opening_for(fixture: &Fixture) -> ContractConfigurationOpeningInput {
        ContractConfigurationOpeningInput {
            selector: 0,
            application_vk_hash: fixture.application_vk_hash,
            configuration_commitment: fixture.configuration_commitment,
            domain: fr_to_bytes(reference_configuration_domain()),
            values: vec![fr_to_bytes(Fr::from(8u64)), fr_to_bytes(Fr::from(9u64))],
        }
    }

    fn configuration_submission_for(
        fixture: &Fixture,
        contract: &ContractDto,
    ) -> ContractConfigurationOpeningSubmission {
        ContractConfigurationOpeningSubmission {
            contract_address: contract.address,
            openings: vec![configuration_opening_for(fixture)],
        }
    }

    fn reproducer_script(root: &Path, exit_code: i32) -> PathBuf {
        let path = root.join("reproducer.mjs");
        std::fs::write(&path, format!("process.exit({exit_code});\n")).unwrap();
        path
    }

    fn submit_service(
        registry: &Path,
        reproducer: Option<PathBuf>,
        contract: Option<ContractDto>,
    ) -> (
        Arc<SourceVerificationService>,
        impl Fn(SubmittedSourceEnvelope) -> Result<SubmitContractSourceResult, SubmissionApiError>,
    ) {
        let mut service =
            SourceVerificationService::open(registry, 7, B256::from([9u8; 32]), reproducer);
        service = service.enable_source_submissions();
        let service = Arc::new(service);
        let api = Arc::new(PscanService::new(
            Arc::clone(&service),
            ReaderStub { contract },
        ));
        (service, move |envelope| api.submit_blocking(envelope))
    }

    #[test]
    fn submissions_report_disabled_until_the_channel_flag_is_set() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let service = SourceVerificationService::open(&registry, 7, B256::from([9u8; 32]), None);
        assert!(!service.source_submissions_enabled());
        assert!(!service.configuration_opening_submissions_enabled());
        assert_eq!(
            service.info().source_submission_status,
            SubmissionStatus::Disabled
        );
        assert_eq!(
            service.info().configuration_opening_submission_status,
            SubmissionStatus::Disabled
        );
        let contract_stub = contract(&fixture, false);
        let reader = ReaderStub {
            contract: Some(contract_stub.clone()),
        };
        let api = PscanService::new(Arc::new(service), reader);
        let error = api
            .submit_blocking(envelope_for(&fixture, &contract_stub))
            .unwrap_err();
        assert!(matches!(error, SubmissionApiError::Disabled));
    }

    #[test]
    fn publication_content_id_rejects_malformed_attachment_base64() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let mut malformed = publication(&fixture);
        *malformed.attachments.values_mut().next().unwrap() = "not-base64".to_owned();
        assert!(publication_content_id(&malformed).is_err());
    }

    #[test]
    fn submissions_bind_every_contribution_to_the_live_function_set() {
        let directory = tempfile::tempdir().unwrap();
        let bundle_root = directory.path().join("bundle");
        let fixture = write_fixture(bundle_root.as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let contract_stub = contract(&fixture, false);
        // No reproducer configured: if binding ran after reproduction this
        // would answer Unavailable instead of Invalid, proving the ordering.
        let (service, submit) = submit_service(&registry, None, Some(contract_stub.clone()));

        // An unrelated target address fails binding even though its function
        // set would otherwise match.
        let mut wrong_address = contract_stub.clone();
        wrong_address.address = Address::repeat_byte(0x22);
        let error = submit(envelope_for(&fixture, &wrong_address)).unwrap_err();
        assert!(matches!(error, SubmissionApiError::Invalid(_)), "{error:?}");

        // Known implementations are insufficient: the presentation must bind
        // the target's exact ordered selector/VK shape before reproduction.
        let mut wrong_shape = contract_stub.clone();
        wrong_shape.functions[0].selector = 1;
        let (shape_service, submit_shape) = submit_service(
            directory.path().join("shape.source.redb").as_path(),
            None,
            Some(wrong_shape.clone()),
        );
        let error = submit_shape(envelope_for(&fixture, &wrong_shape)).unwrap_err();
        assert!(error.to_string().contains("presentation"), "{error:?}");

        // A canonical account is required at all.
        let (service2, submit2) = submit_service(&registry, None, None);
        let error = submit2(envelope_for(&fixture, &contract_stub)).unwrap_err();
        assert!(matches!(error, SubmissionApiError::Invalid(_)), "{error:?}");
        drop(service2);
        drop(submit_shape);
        drop(shape_service);
        drop(service);
        let _ = fixture;
        let _ = bundle_root;
    }

    #[test]
    fn opening_only_contributions_skip_reproduction_and_stamp_public_origin() {
        let directory = tempfile::tempdir().unwrap();
        let bundle_root = directory.path().join("bundle");
        let fixture = write_fixture(bundle_root.as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let contract_stub = contract(&fixture, false);

        // First, an operator publishes ONLY the implementation, leaving the
        // contract's configuration openings unpublished.
        {
            let mut publication = publication(&fixture);
            if let Some(manifest) = publication.manifest.as_object_mut() {
                manifest["configurationOpenings"] = serde_json::json!([]);
            }
            let mut operator =
                SourceVerificationService::open(&registry, 7, B256::from([9u8; 32]), None);
            operator.reproduce_publications = false;
            *operator.write_error.lock() = None;
            *operator.reproducer_error.lock() = None;
            operator.publish(publication).unwrap();
        }

        // Then an anonymous caller submits ONLY those openings: no new
        // implementation means no reproduction work, but the rows are still
        // charged to the public byte budget and stamped as submissions.
        // Enabling submissions requires a healthy reproducer even when this
        // particular contribution needs none, so the channel never advertises
        // readiness it cannot back with a rebuild.
        let passing = reproducer_script(directory.path(), 0);
        let api = PscanService::new(
            {
                let mut svc = SourceVerificationService::open(
                    &registry,
                    7,
                    B256::from([9u8; 32]),
                    Some(passing),
                );
                svc = svc.enable_source_submissions();
                Arc::new(svc)
            },
            ReaderStub {
                contract: Some(contract_stub.clone()),
            },
        );
        let result = api
            .submit_blocking(envelope_for(&fixture, &contract_stub))
            .unwrap();
        assert_eq!(result.reproduced_implementations, 0);
        assert!(!result.deduplicated);
        assert_eq!(api.info().source_submission_status, SubmissionStatus::Ready);
        assert_eq!(
            api.info().configuration_opening_submission_status,
            SubmissionStatus::Disabled
        );
        assert_eq!(api.info().submitted_implementation_count, 0);
    }

    #[test]
    fn direct_configuration_openings_are_bound_atomic_and_idempotent_across_restart() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let contract_stub = contract(&fixture, false);
        let request = configuration_submission_for(&fixture, &contract_stub);

        // Source correspondence is established first, without instance data.
        {
            let mut source = publication(&fixture);
            source.manifest["configurationOpenings"] = json!([]);
            let operator = SourceVerificationService::open_without_reproduction(
                &registry,
                7,
                B256::from([9u8; 32]),
            );
            operator.publish(source).unwrap();
            assert_eq!(
                operator
                    .contract_source(contract_stub.clone())
                    .unwrap()
                    .status,
                ContractSourceStatus::Verified
            );
            assert_eq!(operator.info().configuration_opening_count, 0);
        }

        let service = Arc::new(
            SourceVerificationService::open(&registry, 7, B256::from([9u8; 32]), None)
                .enable_configuration_opening_submissions(),
        );
        let api = PscanService::new(
            Arc::clone(&service),
            ReaderStub {
                contract: Some(contract_stub.clone()),
            },
        );
        assert_eq!(
            service.info().source_submission_status,
            SubmissionStatus::Disabled
        );
        assert_eq!(
            service.info().configuration_opening_submission_status,
            SubmissionStatus::Ready
        );
        assert!(matches!(
            api.submit_blocking(envelope_for(&fixture, &contract_stub)),
            Err(SubmissionApiError::Disabled)
        ));
        let first = api
            .submit_configuration_openings_blocking(request.clone())
            .unwrap();
        assert!(!first.deduplicated);
        assert_eq!(first.contract_address, contract_stub.address);
        assert_eq!(first.configuration_opening_count, 1);
        assert_eq!(service.info().configuration_opening_count, 1);
        let charged_bytes = service.snapshot().unwrap().submitted_bytes;
        assert_eq!(
            charged_bytes,
            serde_json::to_vec(
                service
                    .snapshot()
                    .unwrap()
                    .openings
                    .values()
                    .next()
                    .unwrap()
            )
            .unwrap()
            .len() as u64
        );
        let view = service.contract_source(contract_stub.clone()).unwrap();
        assert_eq!(view.configuration_openings.len(), 1);
        assert_eq!(
            view.configuration_openings[0].status,
            ConfigurationOpeningStatus::Verified
        );

        let second = api
            .submit_configuration_openings_blocking(request.clone())
            .unwrap();
        assert!(second.deduplicated);
        assert_eq!(second.content_id, first.content_id);
        drop(api);
        drop(service);

        let reopened = Arc::new(
            SourceVerificationService::open(&registry, 7, B256::from([9u8; 32]), None)
                .enable_configuration_opening_submissions(),
        );
        let reopened_api = PscanService::new(
            Arc::clone(&reopened),
            ReaderStub {
                contract: Some(contract_stub),
            },
        );
        let after_restart = reopened_api
            .submit_configuration_openings_blocking(request)
            .unwrap();
        assert!(after_restart.deduplicated);
        assert_eq!(after_restart.content_id, first.content_id);
        assert_eq!(reopened.info().configuration_opening_count, 1);
        assert_eq!(reopened.snapshot().unwrap().submitted_bytes, charged_bytes);
    }

    #[test]
    fn public_budget_is_rechecked_after_parallel_reproduction() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(&directory.path().join("bundle"), false);
        let registry = directory.path().join("state.source.redb");
        let markers = directory.path().join("reproducing");
        std::fs::create_dir(&markers).unwrap();
        let release = directory.path().join("release");
        let reproducer = directory.path().join("reproducer.mjs");
        let script = format!(
            "import fs from 'node:fs';\nif (process.argv[2] === 'check') process.exit(0);\nfs.writeFileSync({} + '/' + process.pid, '');\nwhile (!fs.existsSync({})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n",
            serde_json::to_string(markers.to_str().unwrap()).unwrap(),
            serde_json::to_string(release.to_str().unwrap()).unwrap(),
        );
        std::fs::write(&reproducer, script).unwrap();
        let service = Arc::new(SourceVerificationService::open(
            &registry,
            7,
            B256::from([9u8; 32]),
            Some(reproducer),
        ));
        let first = publication(&fixture);
        let mut second = first.clone();
        second.manifest["configurationOpenings"][0]["address"] =
            json!("0x0000000000000000000000000000000000000002");
        let mut imported = load_publication(&first).unwrap();
        stamp_origin(&mut imported, PublicationOrigin::Public);
        let single_charge = merge_snapshots(empty_snapshot(), imported, PublicationOrigin::Public)
            .unwrap()
            .submitted_bytes;
        {
            let mut state = service.state.lock();
            let RegistrySnapshot::Ready(snapshot) = &mut *state else {
                panic!("registry did not open");
            };
            Arc::make_mut(snapshot).submitted_bytes =
                SUBMISSION_MAX_AGGREGATE_BYTES - single_charge;
        }
        let threads = [first, second].map(|publication| {
            let service = Arc::clone(&service);
            std::thread::spawn(move || {
                service.publish_inner(publication, PublicationOrigin::Public, None)
            })
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::fs::read_dir(&markers).unwrap().count() < 2
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let both_reproducing = std::fs::read_dir(&markers).unwrap().count() == 2;
        std::fs::write(&release, "").unwrap();
        let outcomes = threads.map(|thread| thread.join().unwrap());
        assert!(
            both_reproducing,
            "both submissions must pass the first budget check"
        );
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, Err(SourceVerificationApiError::Invalid(_))))
                .count(),
            1
        );
    }

    #[test]
    fn direct_configuration_openings_reject_partial_unrelated_and_malformed_sets_without_writes() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let contract_stub = contract(&fixture, false);
        {
            let mut source = publication(&fixture);
            source.manifest["configurationOpenings"] = json!([]);
            SourceVerificationService::open_without_reproduction(
                &registry,
                7,
                B256::from([9u8; 32]),
            )
            .publish(source)
            .unwrap();
        }
        let passing = reproducer_script(directory.path(), 0);
        let service = Arc::new(
            SourceVerificationService::open(
                &registry,
                7,
                B256::from([9u8; 32]),
                Some(passing.clone()),
            )
            .enable_configuration_opening_submissions(),
        );
        let api = PscanService::new(
            Arc::clone(&service),
            ReaderStub {
                contract: Some(contract_stub.clone()),
            },
        );
        let assert_invalid = |submission| {
            let error = api
                .submit_configuration_openings_blocking(submission)
                .unwrap_err();
            assert!(matches!(error, SubmissionApiError::Invalid(_)), "{error:?}");
            assert_eq!(service.info().configuration_opening_count, 0);
        };

        let mut partial = configuration_submission_for(&fixture, &contract_stub);
        partial.openings.clear();
        assert_invalid(partial);

        let mut duplicate = configuration_submission_for(&fixture, &contract_stub);
        duplicate.openings.push(duplicate.openings[0].clone());
        assert_invalid(duplicate);

        let mut unrelated = configuration_submission_for(&fixture, &contract_stub);
        unrelated.openings[0].selector = 7;
        assert_invalid(unrelated);

        let mut wrong_vk = configuration_submission_for(&fixture, &contract_stub);
        wrong_vk.openings[0].application_vk_hash = fr_to_bytes(Fr::from(123u64));
        assert_invalid(wrong_vk);

        let mut stale_commitment = configuration_submission_for(&fixture, &contract_stub);
        stale_commitment.openings[0].configuration_commitment = fr_to_bytes(Fr::from(123u64));
        assert_invalid(stale_commitment);

        let mut wrong_deployed_commitment = configuration_submission_for(&fixture, &contract_stub);
        wrong_deployed_commitment.openings[0].values[0] = fr_to_bytes(Fr::from(10u64));
        wrong_deployed_commitment.openings[0].configuration_commitment = fr_to_bytes(poseidon(&[
            reference_configuration_domain(),
            Fr::from(10u64),
            Fr::from(9u64),
        ]));
        assert_invalid(wrong_deployed_commitment);

        let mut wrong_domain = configuration_submission_for(&fixture, &contract_stub);
        wrong_domain.openings[0].domain = fr_to_bytes(Fr::from(123u64));
        assert_invalid(wrong_domain);

        let mut wrong_values = configuration_submission_for(&fixture, &contract_stub);
        wrong_values.openings[0].values[0] = fr_to_bytes(Fr::from(123u64));
        assert_invalid(wrong_values);

        let mut noncanonical = configuration_submission_for(&fixture, &contract_stub);
        noncanonical.openings[0].values[0] = B256::repeat_byte(0xff);
        assert_invalid(noncanonical);

        let mut wrong_address = configuration_submission_for(&fixture, &contract_stub);
        wrong_address.contract_address = Address::repeat_byte(0x22);
        assert_invalid(wrong_address);

        let unverified = Arc::new(
            SourceVerificationService::open(
                directory.path().join("unverified.source.redb"),
                7,
                B256::from([9u8; 32]),
                Some(passing),
            )
            .enable_configuration_opening_submissions(),
        );
        let unverified_api = PscanService::new(
            unverified,
            ReaderStub {
                contract: Some(contract_stub.clone()),
            },
        );
        let error = unverified_api
            .submit_configuration_openings_blocking(configuration_submission_for(
                &fixture,
                &contract_stub,
            ))
            .unwrap_err();
        assert!(matches!(error, SubmissionApiError::Invalid(_)), "{error:?}");
    }

    #[test]
    fn public_submission_notifies_the_index_reader_only_when_the_registry_accepted_it() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let contract_stub = contract(&fixture, false);
        let passing = reproducer_script(directory.path(), 0);
        let service = Arc::new(
            SourceVerificationService::open(&registry, 7, B256::from([9u8; 32]), Some(passing))
                .enable_source_submissions(),
        );
        let (reader, calls) = RecordingReader::new(Some(contract_stub.clone()));
        let api = PscanService::new(Arc::clone(&service), reader);

        api.submit_blocking(envelope_for(&fixture, &contract_stub))
            .unwrap();
        assert_eq!(*calls.lock(), vec![None]);

        // A second registry whose reproducer rejects the bundle: the submission
        // is turned away by the registry itself, and nothing reaches the index.
        std::fs::write(
            directory.path().join("reproducer.mjs"),
            b"process.exit(process.argv[2] === 'check' ? 0 : 1);\n",
        )
        .unwrap();
        let rejecting = Arc::new(
            SourceVerificationService::open(
                directory.path().join("rejecting.source.redb"),
                7,
                B256::from([9u8; 32]),
                Some(directory.path().join("reproducer.mjs")),
            )
            .enable_source_submissions(),
        );
        let (rejecting_reader, rejected_calls) = RecordingReader::new(Some(contract_stub.clone()));
        let rejecting_api = PscanService::new(Arc::clone(&rejecting), rejecting_reader);
        let error = rejecting_api
            .submit_blocking(envelope_for(&fixture, &contract_stub))
            .unwrap_err();
        assert!(matches!(error, SubmissionApiError::Invalid(_)), "{error:?}");
        assert_eq!(rejecting.info().implementation_count, 0);
        assert!(rejected_calls.lock().is_empty());
    }

    #[test]
    fn configuration_openings_notify_the_index_reader_only_when_the_registry_accepted_them() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let contract_stub = contract(&fixture, false);
        {
            let mut source = publication(&fixture);
            source.manifest["configurationOpenings"] = json!([]);
            SourceVerificationService::open_without_reproduction(
                &registry,
                7,
                B256::from([9u8; 32]),
            )
            .publish(source)
            .unwrap();
        }
        let passing = reproducer_script(directory.path(), 0);
        let service = Arc::new(
            SourceVerificationService::open(&registry, 7, B256::from([9u8; 32]), Some(passing))
                .enable_configuration_opening_submissions(),
        );
        let (reader, calls) = RecordingReader::new(Some(contract_stub.clone()));
        let api = PscanService::new(Arc::clone(&service), reader);

        api.submit_configuration_openings_blocking(configuration_submission_for(
            &fixture,
            &contract_stub,
        ))
        .unwrap();
        assert_eq!(*calls.lock(), vec![Some(contract_stub.address)]);

        let mut unrelated = configuration_submission_for(&fixture, &contract_stub);
        unrelated.openings[0].selector = 7;
        let error = api
            .submit_configuration_openings_blocking(unrelated)
            .unwrap_err();
        assert!(matches!(error, SubmissionApiError::Invalid(_)), "{error:?}");
        assert_eq!(*calls.lock(), vec![Some(contract_stub.address)]);
    }

    #[test]
    fn configuration_opening_wire_type_denies_unknown_fields_and_empty_sets() {
        let field = hex32(fr_to_bytes(Fr::from(1u64)));
        let base = json!({
            "contractAddress": "0x0000000000000000000000000000000000000001",
            "openings": [{
                "selector": "0x0",
                "applicationVkHash": field,
                "configurationCommitment": field,
                "domain": field,
                "values": [field]
            }]
        });
        let mut unknown_envelope = base.clone();
        unknown_envelope["publication"] = json!({});
        assert!(
            serde_json::from_value::<ContractConfigurationOpeningSubmission>(unknown_envelope)
                .is_err()
        );

        let mut unknown_opening = base.clone();
        unknown_opening["openings"][0]["sourceBundle"] = json!("no");
        assert!(
            serde_json::from_value::<ContractConfigurationOpeningSubmission>(unknown_opening)
                .is_err()
        );

        let mut empty = base;
        empty["openings"] = json!([]);
        assert!(serde_json::from_value::<ContractConfigurationOpeningSubmission>(empty).is_err());
    }

    #[test]
    fn fake_source_substitution_needs_the_reproducer_to_accept_it() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let contract_stub = contract(&fixture, false);
        let failing = reproducer_script(directory.path(), 0);
        std::fs::write(
            directory.path().join("reproducer.mjs"),
            b"process.exit(process.argv[2] === 'check' ? 0 : 1);\n",
        )
        .unwrap();

        let (service, submit) =
            submit_service(&registry, Some(failing), Some(contract(&fixture, false)));
        let error = submit(envelope_for(&fixture, &contract_stub)).unwrap_err();
        assert!(matches!(error, SubmissionApiError::Invalid(_)), "{error:?}");
        // Nothing leaked into the registry or the receipt table.
        assert_eq!(service.info().implementation_count, 0);
        assert_eq!(service.info().submitted_implementation_count, 0);
    }

    #[test]
    fn accepted_public_submissions_carry_public_provenance_and_deduplicate_across_restart() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let contract_stub = contract(&fixture, false);
        let passing = reproducer_script(directory.path(), 0);

        let (service, submit);
        {
            let (svc, sub) = submit_service(
                &registry,
                Some(passing.clone()),
                Some(contract(&fixture, false)),
            );
            service = svc;
            submit = sub;
        }
        let _ = (&service, &submit);
        let first = submit(envelope_for(&fixture, &contract_stub)).unwrap();
        assert!(!first.deduplicated);
        assert_eq!(first.reproduced_implementations, 1);
        assert_eq!(first.implementations.len(), 1);
        assert_eq!(
            first.implementations[0].verification_authority,
            VerificationAuthority::PublicSubmission
        );
        assert_eq!(
            first.implementations[0].verification_method,
            VerificationMethod::SubmittedBundle
        );
        assert_eq!(service.info().submitted_implementation_count, 1);
        let view = service.contract_source(contract(&fixture, false)).unwrap();
        assert_eq!(
            view.presentation.unwrap().verification_authority,
            VerificationAuthority::PublicSubmission
        );

        // Identical resubmission answers from the receipt table.
        let second = submit(envelope_for(&fixture, &contract_stub)).unwrap();
        assert!(second.deduplicated);
        assert_eq!(second.reproduced_implementations, 0);
        let charged_bytes = service.snapshot().unwrap().submitted_bytes;

        // Release every handle (registry + api clones) before reopening.
        drop(submit);
        drop(service);

        // Restart: receipts and provenance survive, so dedup still holds.
        let reopened =
            SourceVerificationService::open(&registry, 7, B256::from([9u8; 32]), Some(passing))
                .enable_source_submissions();
        let reopened = Arc::new(reopened);
        let api = Arc::new(PscanService::new(
            Arc::clone(&reopened),
            ReaderStub {
                contract: Some(contract(&fixture, false)),
            },
        ));
        assert_eq!(reopened.info().submitted_implementation_count, 1);
        assert_eq!(reopened.snapshot().unwrap().submitted_bytes, charged_bytes);
        let again = api
            .submit_blocking(envelope_for(&fixture, &contract_stub))
            .unwrap();
        assert!(again.deduplicated);
        assert_eq!(again.reproduced_implementations, 0);
        assert_eq!(
            again.implementations[0].verification_authority,
            VerificationAuthority::PublicSubmission
        );
    }

    #[test]
    fn the_public_ceiling_charges_only_distinct_registry_contributions() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let imported = load_publication(&publication(&fixture)).unwrap();

        // A channel at the implementation ceiling rejects one more distinct
        // implementation even though bytes are free.
        let mut current = empty_snapshot();
        current.submitted_implementations = SUBMISSION_MAX_IMPLEMENTATIONS;
        current.submitted_bytes = 0;
        let error = enforce_submission_budget(&current, &imported).unwrap_err();
        assert!(error.to_string().contains("implementations"));

        // A channel at the byte ceiling rejects new bytes too.
        let mut current = empty_snapshot();
        current.submitted_implementations = 0;
        current.submitted_bytes = SUBMISSION_MAX_AGGREGATE_BYTES;
        let error = enforce_submission_budget(&current, &imported).unwrap_err();
        assert!(error.to_string().contains("byte budget"));

        // Identical material already registered contributes nothing and fits
        // even when both ceilings are exactly reached.
        let mut full = empty_snapshot();
        full.implementations = imported.implementations.clone();
        full.configuration_bindings = imported.configuration_bindings.clone();
        full.openings = imported.openings.clone();
        full.presentations = imported.presentations.clone();
        full.submitted_implementations = SUBMISSION_MAX_IMPLEMENTATIONS;
        full.submitted_bytes = SUBMISSION_MAX_AGGREGATE_BYTES;
        assert_eq!(enforce_submission_budget(&full, &imported).unwrap(), (0, 0));
    }

    #[test]
    fn published_material_is_idempotent_and_survives_restart() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let registry = directory.path().join("state.source.redb");
        let request = publication(&fixture);
        {
            let service = SourceVerificationService::open_without_reproduction(
                &registry,
                7,
                B256::from([9u8; 32]),
            );
            let info = service.publish(request.clone()).unwrap();
            assert_eq!(info.status, SourceVerificationStatus::Ready);
            assert_eq!(info.implementation_count, 1);
            assert_eq!(info.configuration_opening_count, 1);
            let again = service.publish(request).unwrap();
            assert_eq!(again.implementation_count, 1);
            assert_eq!(again.configuration_opening_count, 1);
            let mut semantic_duplicate = publication(&fixture);
            semantic_duplicate.manifest["serviceName"] = json!("ignored publisher metadata");
            let again = service.publish(semantic_duplicate).unwrap();
            assert_eq!(again.implementation_count, 1);
            assert_eq!(again.configuration_opening_count, 1);
        }
        let db = Database::create(&registry).unwrap();
        let read = db.begin_read().unwrap();
        assert_eq!(
            read.open_table(T_IMPLEMENTATIONS)
                .unwrap()
                .iter()
                .unwrap()
                .count(),
            1
        );
        assert_eq!(
            read.open_table(T_OPENINGS).unwrap().iter().unwrap().count(),
            1
        );
        assert_eq!(
            read.open_table(T_PRESENTATIONS)
                .unwrap()
                .iter()
                .unwrap()
                .count(),
            1
        );
        drop(read);
        drop(db);
        let reopened = SourceVerificationService::open_without_reproduction(
            &registry,
            7,
            B256::from([9u8; 32]),
        );
        assert_eq!(reopened.info().implementation_count, 1);
        assert_eq!(reopened.info().configuration_opening_count, 1);
        assert!(reopened
            .implementation_source(&fixture.application_vk_hash)
            .unwrap()
            .is_some());
        assert!(reopened
            .contract_source(contract(&fixture, false))
            .unwrap()
            .presentation
            .is_some());
    }

    #[test]
    fn stale_full_identity_opening_does_not_block_or_replace_canonical_opening() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let registry = directory.path().join("state.source.redb");
        let service = SourceVerificationService::open_without_reproduction(
            &registry,
            7,
            B256::from([9u8; 32]),
        );
        let correct = publication(&fixture);
        let mut stale = correct.clone();
        let stale_values = [Fr::from(10u64), Fr::from(11u64)];
        let stale_commitment = fr_to_bytes(poseidon(&[
            reference_configuration_domain(),
            stale_values[0],
            stale_values[1],
        ]));
        stale.manifest["configurationOpenings"][0]["values"] = json!([
            hex32(fr_to_bytes(stale_values[0])),
            hex32(fr_to_bytes(stale_values[1])),
        ]);
        stale.manifest["configurationOpenings"][0]["configurationCommitment"] =
            json!(hex32(stale_commitment));

        service.publish(stale.clone()).unwrap();
        service.publish(correct).unwrap();
        service.publish(stale).unwrap();
        assert_eq!(service.info().configuration_opening_count, 2);

        let canonical = service.contract_source(contract(&fixture, false)).unwrap();
        assert_eq!(canonical.configuration_openings.len(), 1);
        assert_eq!(
            canonical.configuration_openings[0].values[0].value,
            B256::from(fr_to_bytes(Fr::from(8u64)))
        );

        let mut prior_identity = contract(&fixture, false);
        prior_identity.functions[0].configuration_commitment = stale_commitment;
        let stale_view = service.contract_source(prior_identity).unwrap();
        assert_eq!(stale_view.configuration_openings.len(), 1);
        assert_eq!(
            stale_view.configuration_openings[0].values[0].value,
            B256::from(fr_to_bytes(Fr::from(10u64)))
        );
    }

    #[test]
    fn registry_open_and_reproducer_failures_are_isolated_and_reported() {
        let directory = tempfile::tempdir().unwrap();
        let registry = directory.path().join("state.source.redb");
        let read_only = SourceVerificationService::open(
            &registry,
            7,
            B256::from([9u8; 32]),
            Some(directory.path().join("missing-reproducer.mts")),
        );
        let info = read_only.info();
        assert_eq!(info.status, SourceVerificationStatus::Ready);
        assert!(!info.writable);
        let error = info.error.unwrap();
        assert!(error.contains("reproducer is missing"));
        assert!(!error.contains(directory.path().to_str().unwrap()));

        let corrupt = directory.path().join("corrupt.source.redb");
        std::fs::write(&corrupt, b"not a redb database").unwrap();
        let unavailable = SourceVerificationService::open(&corrupt, 7, B256::from([9u8; 32]), None);
        let info = unavailable.info();
        assert_eq!(info.status, SourceVerificationStatus::Unavailable);
        assert!(!info.writable);
        assert!(unavailable.implementation_source(&B256::ZERO).is_err());
    }

    #[test]
    fn conflicting_publication_is_rejected_without_changing_registry() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let service = SourceVerificationService::open_without_reproduction(
            directory.path().join("state.source.redb"),
            7,
            B256::from([9u8; 32]),
        );
        service.publish(publication(&fixture)).unwrap();
        let mut conflicting = publication(&fixture);
        conflicting.manifest["implementations"][0]["implementationLabel"] =
            json!("different label");
        conflicting.manifest["configurationBindings"][0]["configurationProfile"]
            ["implementationLabel"] = json!("different label");
        assert!(matches!(
            service.publish(conflicting),
            Err(SourceVerificationApiError::Conflict(_))
        ));
        assert_eq!(service.info().implementation_count, 1);
    }

    #[test]
    fn publication_over_the_attachment_budget_is_rejected_before_reproduction() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        // Passes the reproducer health check and fails every reproduction, so a
        // reproduction error here would prove the budget ran too late.
        let reproducer = directory.path().join("reproducer.mjs");
        std::fs::write(
            &reproducer,
            b"process.exit(process.argv[2] === 'check' ? 0 : 1);\n",
        )
        .unwrap();
        let service = SourceVerificationService::open(
            directory.path().join("state.source.redb"),
            7,
            B256::from([9u8; 32]),
            Some(reproducer),
        );

        let mut oversized = publication(&fixture);
        *oversized.attachments.values_mut().next().unwrap() =
            base64(&vec![0u8; MAX_TOTAL_ATTACHMENT_BYTES as usize + 1]);
        let error = service.publish(oversized).unwrap_err();
        let SourceVerificationApiError::Invalid(message) = &error else {
            panic!("attachments over the budget must be invalid: {error:?}");
        };
        assert_eq!(
            *message,
            format!("attachments exceed {MAX_TOTAL_ATTACHMENT_BYTES} decoded bytes")
        );
        // The operator channel is otherwise healthy, so an empty registry shows
        // the rejection landed before any persistence.
        assert!(service.info().writable);
        assert_eq!(service.info().implementation_count, 0);
        assert_eq!(service.info().configuration_opening_count, 0);
    }

    /// One 1 MiB attachment named by `references` distinct logical source
    /// paths, so the publication carries about 1 MiB of distinct attachment
    /// bytes and materializes `references` MiB.
    fn publication_aliasing_one_attachment(
        fixture: &Fixture,
        references: usize,
    ) -> SourceVerificationPublication {
        const ATTACHMENT_BYTES: usize = 1024 * 1024;
        let source = vec![b'a'; ATTACHMENT_BYTES];
        let digest = sha256_hex(&source);
        let mut paths = (0..references)
            .map(|index| format!("src/main{index}.nr"))
            .collect::<Vec<_>>();
        paths.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        let mut index = String::from("[");
        for (position, path) in paths.iter().enumerate() {
            if position != 0 {
                index.push(',');
            }
            index.push_str(&format!(
                "{{\"length\":{ATTACHMENT_BYTES},\"path\":\"{path}\",\"sha256\":\"{digest}\"}}"
            ));
        }
        index.push(']');
        let mut hash = Sha256::new();
        hash.update(b"pcash.source-bundle\0");
        hash.update(index.as_bytes());
        let bundle_digest = hex::encode(<[u8; 32]>::from(hash.finalize()));

        let mut publication = publication(fixture);
        publication.manifest["implementations"][0]["sourceFiles"] = Value::Array(
            paths
                .iter()
                .map(|path| {
                    json!({
                        "path": path,
                        "attachment": "attachments/main.nr",
                        "length": ATTACHMENT_BYTES,
                        "sha256": digest,
                    })
                })
                .collect(),
        );
        publication.manifest["implementations"][0]["sourceBundleDigest"] = json!(bundle_digest);
        *publication
            .attachments
            .get_mut("attachments/main.nr")
            .unwrap() = base64(&source);
        publication
    }

    #[test]
    fn aliased_attachment_references_are_charged_with_multiplicity() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        // Nine references materialize 9 MiB from a publication whose distinct
        // attachment bytes are barely over 1 MiB.
        let Err(error) = load_publication(&publication_aliasing_one_attachment(&fixture, 9)) else {
            panic!("nine references to a 1 MiB attachment exceed the budget");
        };
        assert_eq!(
            error,
            format!("attachment references exceed {MAX_TOTAL_ATTACHMENT_BYTES} decoded bytes")
        );
        // Seven references plus the compiler artifact, the proving ABI, and the
        // verification key stay under it.
        let snapshot = load_publication(&publication_aliasing_one_attachment(&fixture, 7)).unwrap();
        let implementation = snapshot
            .implementations
            .values()
            .next()
            .expect("the aliasing publication carries one implementation");
        assert_eq!(implementation.files.len(), 7);
    }

    #[test]
    fn publication_over_the_wire_budget_is_rejected_before_decoding() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let mut oversized = publication(&fixture);
        // Neither base64 nor a multiple of four long, so a decode before the
        // wire check would report that instead.
        *oversized
            .attachments
            .get_mut("attachments/main.nr")
            .unwrap() = "?".repeat(MAX_PUBLICATION_WIRE_BYTES as usize + 1);
        let Err(error) = load_publication(&oversized) else {
            panic!("a publication over the wire budget is rejected");
        };
        assert_eq!(
            error,
            format!("publication exceeds {MAX_PUBLICATION_WIRE_BYTES} bytes serialized")
        );
    }

    #[test]
    fn operator_presentation_with_different_profile_is_rejected_and_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let service = SourceVerificationService::open_without_reproduction(
            &registry,
            7,
            B256::from([9u8; 32]),
        );
        service.publish(publication(&fixture)).unwrap();
        let mut corrected = publication(&fixture);
        corrected.manifest["presentation"]["contractDescription"] =
            json!("The corrected operator description.");
        assert!(matches!(
            service.publish(corrected),
            Err(SourceVerificationApiError::Conflict(_))
        ));
        let view = service.contract_source(contract(&fixture, false)).unwrap();
        assert_eq!(view.status, ContractSourceStatus::Verified);
        assert_eq!(
            view.presentation.unwrap().profile.contract_description,
            "Fixture contract presentation."
        );
    }

    #[test]
    fn operator_republish_with_identical_presentation_profile_changes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let passing = reproducer_script(directory.path(), 0);
        {
            let service =
                SourceVerificationService::open(&registry, 7, B256::from([9u8; 32]), Some(passing));
            let public = publication(&fixture);
            service
                .publish_inner(public, PublicationOrigin::Public, None)
                .unwrap();
            assert_eq!(
                service
                    .contract_source(contract(&fixture, false))
                    .unwrap()
                    .presentation
                    .unwrap()
                    .verification_authority,
                VerificationAuthority::PublicSubmission
            );
            assert!(matches!(
                service.publish_inner(publication(&fixture), PublicationOrigin::Public, None),
                Err(SourceVerificationApiError::Invalid(message))
                    if message == "publication adds no new registry material"
            ));

            let operator = publication(&fixture);
            service.publish(operator).unwrap();
        }
        let reopened = SourceVerificationService::open_without_reproduction(
            &registry,
            7,
            B256::from([9u8; 32]),
        );
        let presentation = reopened
            .contract_source(contract(&fixture, false))
            .unwrap()
            .presentation
            .unwrap();
        assert_eq!(
            presentation.verification_authority,
            VerificationAuthority::PublicSubmission
        );
        assert_eq!(
            presentation.profile.contract_description,
            "Fixture contract presentation."
        );
    }

    #[test]
    fn public_presentation_cannot_replace_operator_copy() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path().join("bundle").as_path(), false);
        let registry = directory.path().join("state.source.redb");
        let service = SourceVerificationService::open_without_reproduction(
            &registry,
            7,
            B256::from([9u8; 32]),
        );
        service.publish(publication(&fixture)).unwrap();
        let mut public = publication(&fixture);
        public.manifest["presentation"]["contractDescription"] =
            json!("The conflicting public description.");
        assert!(matches!(
            service.publish_inner(public, PublicationOrigin::Public, None),
            Err(SourceVerificationApiError::Conflict(_))
        ));
        let presentation = service
            .contract_source(contract(&fixture, false))
            .unwrap()
            .presentation
            .unwrap();
        assert_eq!(
            presentation.verification_authority,
            VerificationAuthority::NodeOperator
        );
        assert_eq!(
            presentation.profile.contract_description,
            "Fixture contract presentation."
        );
    }

    #[test]
    fn implementation_integrity_failure_rejects_the_publication() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        std::fs::write(
            directory.path().join("attachments/vk"),
            vec![0u8; VERIFICATION_KEY_FIELD_COUNT * 32],
        )
        .unwrap();
        assert!(load_error(&fixture).contains("verification key sha256 mismatch"));
    }

    #[test]
    fn disabled_service_reports_disabled() {
        let service = SourceVerificationService::disabled();
        assert_eq!(service.info().status, SourceVerificationStatus::Disabled);
        assert!(matches!(
            service.implementation_source(&B256::ZERO),
            Err(SourceVerificationApiError::Disabled)
        ));
    }

    #[test]
    fn reproduction_errors_never_name_operator_paths() {
        // Any remote RPC caller can read publication errors, so the error text
        // must carry the failure reason but never the operator's absolute
        // filesystem paths.
        let directory = tempfile::tempdir().unwrap();
        let fixture = write_fixture(directory.path(), false);
        let reproducer = directory.path().join("leaky-reproducer.mjs");
        std::fs::write(
            &reproducer,
            "if (process.argv[2] === 'check') process.exit(0); console.error(process.argv.join(' ')); process.exit(1);",
        )
        .unwrap();
        let error = match reproduce_publication(&publication(&fixture), &reproducer) {
            Err(ReproductionError::Rejected(error)) => error,
            _ => panic!("failing reproducer must reject the publication"),
        };
        assert_eq!(error, "source reproduction failed");
        assert!(!error.contains(directory.path().to_str().unwrap()));
    }
}
