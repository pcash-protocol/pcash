//! DTOs for the node-owned source-verification registry.
//!
//! This surface reports correspondence evidence. `verified` means every
//! function in the complete current [`ContractDto`] has a validated published
//! implementation. It is not a safety judgment. The published ABI is named the
//! Noir proving ABI because PCASH has no Ethereum-style public calldata ABI.

use std::collections::BTreeMap;

use alloy_primitives::{Address, B256};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use pcash_rpc::ContractDto;

/// The manifest schema the operator's offline rebuild produced.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceVerificationStatus {
    Disabled,
    Ready,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum VerificationAuthority {
    #[default]
    #[serde(rename = "node_operator")]
    NodeOperator,
    #[serde(rename = "public_submission")]
    PublicSubmission,
}

/// How the correspondence was established.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum VerificationMethod {
    #[default]
    #[serde(rename = "node_registry")]
    NodeRegistry,
    #[serde(rename = "submitted_bundle")]
    SubmittedBundle,
}

/// Whether the permissionless source and configuration-opening channels accept
/// publications. Independent of the operator publish path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubmissionStatus {
    #[serde(rename = "disabled")]
    Disabled,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "unavailable")]
    Unavailable,
}

/// A published implementation is verified by construction: an entry only appears
/// once its rebuild matched.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Verified {
    #[serde(rename = "verified")]
    Verified,
}

/// The configuration-commitment scheme these openings are checked against.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConfigurationScheme {
    #[serde(rename = "poseidon-explicit-domain-positional-v1")]
    PoseidonExplicitDomainPositional,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceVerificationInfo {
    pub status: SourceVerificationStatus,
    /// Whether this node accepts validated source publications.
    pub writable: bool,
    pub verification_authority: VerificationAuthority,
    pub verification_method: VerificationMethod,
    #[serde(with = "alloy_serde::quantity")]
    pub manifest_schema_version: u32,
    pub service_name: Option<String>,
    #[serde(with = "alloy_serde::quantity")]
    pub implementation_count: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub configuration_opening_count: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub invalid_configuration_opening_count: u64,
    /// Chain identity of the registry's node, so a browser can pin this
    /// endpoint to the RPC endpoint it already trusts before showing badges.
    #[serde(with = "alloy_serde::quantity")]
    pub pcash_chain_id: u32,
    pub genesis_hash: Option<B256>,
    pub source_submission_status: SubmissionStatus,
    pub configuration_opening_submission_status: SubmissionStatus,
    #[serde(with = "alloy_serde::quantity")]
    pub submitted_implementation_count: u64,
    pub error: Option<String>,
}

impl SourceVerificationInfo {
    pub fn disabled() -> Self {
        Self::new(SourceVerificationStatus::Disabled)
    }

    /// A report with the fixed provenance fields filled in and every count zero.
    pub fn new(status: SourceVerificationStatus) -> Self {
        Self {
            status,
            writable: status == SourceVerificationStatus::Ready,
            verification_authority: VerificationAuthority::NodeOperator,
            verification_method: VerificationMethod::NodeRegistry,
            manifest_schema_version: MANIFEST_SCHEMA_VERSION,
            service_name: None,
            implementation_count: 0,
            configuration_opening_count: 0,
            invalid_configuration_opening_count: 0,
            pcash_chain_id: 0,
            genesis_hash: None,
            source_submission_status: SubmissionStatus::Disabled,
            configuration_opening_submission_status: SubmissionStatus::Disabled,
            submitted_implementation_count: 0,
            error: None,
        }
    }
}

/// Errors local to the permissionless submission channel. Mapped onto
/// JSON-RPC codes -32040..-32043 by the pscan server module.
#[derive(Clone, Debug, thiserror::Error)]
pub enum SubmissionApiError {
    #[error("invalid source submission: {0}")]
    Invalid(String),
    #[error("source submission rejected: {0}")]
    Limited(String),
    #[error("source submission unavailable: {0}")]
    Unavailable(String),
    #[error("source submissions are disabled on this listener")]
    Disabled,
}

/// Error codes reserved for the pscan submission channel. The read surface
/// keeps the shared source-verification error mapping.
pub const SUBMISSION_INVALID_CODE: i32 = -32040;
pub const SUBMISSION_LIMITED_CODE: i32 = -32041;
pub const SUBMISSION_UNAVAILABLE_CODE: i32 = -32042;
pub const SUBMISSION_DISABLED_CODE: i32 = -32043;

impl SubmissionApiError {
    /// Stable `(code, kind)` pair for wire encoding; `kind` gives clients a
    /// matchable discriminator that survives message wording changes.
    pub fn code_and_kind(&self) -> (i32, &'static str) {
        match self {
            Self::Invalid(_) => (SUBMISSION_INVALID_CODE, "invalid"),
            Self::Limited(_) => (SUBMISSION_LIMITED_CODE, "limited"),
            Self::Unavailable(_) => (SUBMISSION_UNAVAILABLE_CODE, "unavailable"),
            Self::Disabled => (SUBMISSION_DISABLED_CODE, "disabled"),
        }
    }
}

/// One anonymous submission: a closed set of target contracts plus the same
/// self-contained publication an operator would send. Every submitted
/// implementation must be committed to by at least one listed contract's live
/// immutable function set, every configuration opening must bind to one of the
/// listed addresses under that address's own function set, and every new
/// implementation is rebuilt by the node reproducer before anything persists.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SubmittedSourceEnvelope {
    /// 20-byte contract addresses the submission claims correspondence for.
    #[serde(deserialize_with = "non_empty_address_list")]
    pub contract_addresses: Vec<Address>,
    pub publication: SourceVerificationPublication,
}

fn non_empty_address_list<'de, D>(deserializer: D) -> Result<Vec<Address>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let list = <Vec<Address> as serde::Deserialize>::deserialize(deserializer)?;
    if list.is_empty() {
        return Err(serde::de::Error::custom(
            "contractAddresses must name at least one contract",
        ));
    }
    Ok(list)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedImplementation {
    pub application_vk_hash: B256,
    pub verification_authority: VerificationAuthority,
    pub verification_method: VerificationMethod,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitContractSourceResult {
    pub content_id: B256,
    /// True when this exact publication was accepted earlier; nothing was
    /// revalidated or restored.
    pub deduplicated: bool,
    /// Implementations this node rebuilt through its reproducer as part of
    /// accepting the publication (zero for deduplicated resubmissions and
    /// opening-only contributions).
    #[serde(with = "alloy_serde::quantity")]
    pub reproduced_implementations: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub configuration_opening_count: u64,
    pub implementations: Vec<SubmittedImplementation>,
}

/// One function's positional configuration opening. This is instance data for
/// a contract whose source correspondence is already in the registry; it is
/// not source material and does not establish or change source provenance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContractConfigurationOpeningInput {
    #[serde(with = "alloy_serde::quantity")]
    pub selector: u8,
    pub application_vk_hash: B256,
    pub configuration_commitment: B256,
    pub domain: B256,
    pub values: Vec<B256>,
}

/// A closed-set publication for one live contract. The opening list must
/// cover that contract's complete immutable function set exactly once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContractConfigurationOpeningSubmission {
    pub contract_address: Address,
    #[serde(deserialize_with = "non_empty_opening_list")]
    pub openings: Vec<ContractConfigurationOpeningInput>,
}

fn non_empty_opening_list<'de, D>(
    deserializer: D,
) -> Result<Vec<ContractConfigurationOpeningInput>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let list =
        <Vec<ContractConfigurationOpeningInput> as serde::Deserialize>::deserialize(deserializer)?;
    if list.is_empty() {
        return Err(serde::de::Error::custom(
            "openings must name at least one contract function",
        ));
    }
    Ok(list)
}

/// Acceptance of configuration data only. `deduplicated` means the registry
/// already held these exact openings; it makes no statement about who
/// published the source or whether anyone audited the contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitContractConfigurationOpeningsResult {
    pub contract_address: Address,
    pub content_id: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub configuration_opening_count: u64,
    pub deduplicated: bool,
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum SourceVerificationApiError {
    #[error("source verification is disabled")]
    Disabled,
    #[error("source verification unavailable: {0}")]
    Unavailable(String),
    #[error("invalid source-verification publication: {0}")]
    Invalid(String),
    #[error("source-verification publication conflicts with stored material: {0}")]
    Conflict(String),
    #[error("source-verification storage failure: {0}")]
    Storage(String),
}

/// A self-contained import of an offline-rebuilt source bundle. Attachment
/// keys are the exact portable paths named by `manifest`; values are standard
/// padded base64 bytes. The node independently rebuilds every new
/// implementation and persists the publication only after the artifact, ABI,
/// verification key, and application VK hash reproduce.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceVerificationPublication {
    pub manifest: Value,
    pub attachments: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NargoToolchain {
    pub version: String,
    pub noirc_commit: String,
    pub archive_sha256: B256,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarretenbergToolchain {
    pub version: String,
    pub verifier_target: String,
    pub archive_sha256: B256,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrsDigests {
    pub bn254_g1_sha256: B256,
    pub bn254_g2_sha256: B256,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceToolchain {
    pub release_manifest_sha256: B256,
    pub producer_platform: String,
    pub nargo: NargoToolchain,
    pub barretenberg: BarretenbergToolchain,
    pub crs: CrsDigests,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFileMetadata {
    pub path: String,
    #[serde(with = "alloy_serde::quantity")]
    pub length: u64,
    pub sha256: B256,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationSourceSummary {
    pub verification_status: Verified,
    pub verification_authority: VerificationAuthority,
    pub verification_method: VerificationMethod,
    pub application_vk_hash: B256,
    pub implementation_label: String,
    pub package_root: String,
    pub package_name: String,
    pub source_bundle_digest: B256,
    pub compiler_artifact_sha256: B256,
    pub decoded_acir_sha256: B256,
    pub noir_proving_abi_sha256: B256,
    pub verification_key_sha256: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub verification_key_field_count: u64,
    pub toolchain: SourceToolchain,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationSource {
    #[serde(rename = "implementation")]
    pub summary: ImplementationSourceSummary,
    pub source_files: Vec<SourceFileMetadata>,
    pub noir_proving_abi: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationSourceFile {
    pub application_vk_hash: B256,
    pub path: String,
    pub sha256: B256,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationValue {
    #[serde(with = "alloy_serde::quantity")]
    pub position: u64,
    pub value: B256,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub value_type: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigurationOpeningStatus {
    Verified,
    Invalid,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationOpening {
    #[serde(with = "alloy_serde::quantity")]
    pub selector: u8,
    pub status: ConfigurationOpeningStatus,
    pub scheme: ConfigurationScheme,
    pub domain: Option<B256>,
    pub values: Vec<ConfigurationValue>,
    pub expected_configuration_commitment: B256,
    pub computed_configuration_commitment: Option<B256>,
    pub error: Option<String>,
}

/// Human-facing metadata supplied with the exact source bundle. These labels
/// explain one contract shape; they are publisher assertions, not protocol
/// state or part of the source-correspondence verdict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractPresentationConfigurationField {
    #[serde(with = "alloy_serde::quantity")]
    pub position: u64,
    pub name: String,
    pub label: String,
    pub description: String,
    pub display_format: String,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub overview_order: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractPresentationProofItem {
    pub abi_parameter: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractPresentationProofGroup {
    pub title: String,
    pub description: String,
    pub items: Vec<ContractPresentationProofItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractPresentationFunction {
    #[serde(with = "alloy_serde::quantity")]
    pub selector: u8,
    pub application_vk_hash: B256,
    pub name: String,
    pub summary: String,
    pub configuration_fields: Vec<ContractPresentationConfigurationField>,
    pub proof_groups: Vec<ContractPresentationProofGroup>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractPresentationProfile {
    #[serde(with = "alloy_serde::quantity")]
    pub schema_version: u32,
    pub publisher_label: String,
    pub contract_name: String,
    pub contract_description: String,
    pub functions: Vec<ContractPresentationFunction>,
}

/// Registry provenance is deliberately outside the publisher-authored
/// profile, so `publisherLabel` cannot be mistaken for a verification
/// authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractPresentationView {
    pub verification_authority: VerificationAuthority,
    pub verification_method: VerificationMethod,
    pub profile: ContractPresentationProfile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContractSourceStatus {
    Verified,
    NotVerified,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractSourceView {
    pub address: Address,
    #[serde(rename = "verificationStatus")]
    pub status: ContractSourceStatus,
    pub contract: ContractDto,
    pub implementations: Vec<ImplementationSourceSummary>,
    pub configuration_openings: Vec<ConfigurationOpening>,
    /// Present exactly when the live ordered selector/VK shape has a stored
    /// presentation profile. A verified contract always has one.
    pub presentation: Option<ContractPresentationView>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationBundle {
    pub source: ImplementationSource,
    pub files: Vec<ImplementationSourceFile>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractSourceBundle {
    #[serde(rename = "contract")]
    pub view: ContractSourceView,
    pub implementations: Vec<ImplementationBundle>,
}
