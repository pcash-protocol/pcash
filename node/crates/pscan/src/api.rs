//! The `pscan_*` JSON-RPC namespace: contract source verification reads plus
//! two permissionless ingestion channels on one dedicated HTTP listener,
//! source packages and instance configuration openings. Operator publication
//! is an `admin_*` method on the operator-only listener, not part of this
//! namespace.
//!
//! Deliberate differences from the public `pcash_*` server, all driven by what
//! this namespace carries:
//!
//! * **Permissive CORS**, like the public server, because the browser Explorer
//!   reads verification state cross-origin. The permissionless write is meant
//!   for operator-side tooling and loopback deployments: like every other
//!   unauthenticated surface in this node, bind-address configuration remains
//!   its access control, and the concurrency cap below bounds what any caller
//!   can enqueue.
//! * **A request ceiling sized for source bundles**
//!   ([`PSCAN_MAX_REQUEST_BODY_BYTES`]): one request may embed a complete
//!   source bundle whose attachment bytes travel base64-encoded.
//! * **Batches are limited to one request**: anonymous validation work runs on
//!   the blocking pool, and fan-out amplification has no legitimate use here.
//! * **HTTP only**, like the admin listener: nothing here benefits from
//!   WebSocket transport.
//!
//! The node's coupling to this crate is exactly [`ContractIndexReader`]: the
//! server asks it for the canonical account behind an address; everything else
//! — persistence, reproduction, provenance — lives in this crate.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;

use alloy_primitives::{Address, B256};
use jsonrpsee::server::middleware::rpc::RpcServiceBuilder;
use jsonrpsee::server::{BatchRequestConfig, RpcModule, Server, ServerConfig};
use jsonrpsee::types::{ErrorObject, ErrorObjectOwned, Params};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use tower::ServiceBuilder;
use tower_http::cors::CorsLayer;

use pcash_metrics::{noop, Metrics};
use pcash_rpc::server::{register_read, BlockingReads};
use pcash_rpc::ContractDto;

use crate::dto::{
    ContractConfigurationOpeningSubmission, ContractSourceBundle, ContractSourceView,
    ImplementationSource, ImplementationSourceFile, SourceVerificationApiError,
    SourceVerificationInfo, SourceVerificationPublication, SubmissionApiError,
    SubmitContractConfigurationOpeningsResult, SubmitContractSourceResult, SubmittedImplementation,
    SubmittedSourceEnvelope, VerificationAuthority, VerificationMethod,
};
use crate::registry::{
    decode_base64, decode_fixed_hex, load_publication_for, PublicationOrigin, PublishOutcome,
    SourceVerificationService, StoredSubmissionRecord,
};

/// Wire headroom for this listener. A submission envelope carries the same
/// self-contained publication an operator sends, so it takes the same ceiling.
pub const PSCAN_MAX_REQUEST_BODY_BYTES: u32 = pcash_rpc::SOURCE_PUBLICATION_MAX_BODY_BYTES;

/// Anonymous submissions run validation and possibly full reproduction on the
/// blocking pool; this bounds how many run concurrently before callers are
/// told the channel is saturated rather than queued without bound.
pub const SUBMISSION_CONCURRENCY: usize = 2;

/// Upper bound on how many distinct contracts one anonymous submission may
/// target, keeping per-submission index reads bounded.
pub const MAX_SUBMISSION_TARGETS: usize = 8;

/// The entire coupling surface between this crate and a node's chain index. A
/// future standalone service implements it over `pcash_getContract` HTTP calls
/// without moving anything else.
pub trait ContractIndexReader: Send + Sync {
    /// The canonical account behind `address`, or `None` when no such contract
    /// exists at the served height. Errors mean the index could not answer.
    fn contract_for_source(&self, address: Address) -> Result<Option<ContractDto>, String>;

    /// Called after the registry accepted a source submission (`None`) or a
    /// contract's configuration openings (`Some(address)`).
    fn contract_verification_changed(&self, address: Option<Address>) -> Result<(), String>;
}

pub trait PscanApi: Send + Sync + 'static {
    fn info(&self) -> SourceVerificationInfo;
    fn get_contract_source(
        &self,
        address: Address,
    ) -> Result<Option<ContractSourceView>, SourceVerificationApiError>;
    fn get_implementation_source(
        &self,
        application_vk_hash: &B256,
    ) -> Result<Option<ImplementationSource>, SourceVerificationApiError>;
    fn get_implementation_source_file(
        &self,
        application_vk_hash: &B256,
        path: &str,
    ) -> Result<Option<ImplementationSourceFile>, SourceVerificationApiError>;
    fn get_contract_source_bundle(
        &self,
        address: Address,
    ) -> Result<Option<ContractSourceBundle>, SourceVerificationApiError>;
    /// Permit guard for the bounded submission pipeline.
    fn submission_permits(&self) -> Arc<Semaphore>;
    fn submit_blocking(
        &self,
        envelope: SubmittedSourceEnvelope,
    ) -> Result<SubmitContractSourceResult, SubmissionApiError>;
    fn submit_configuration_openings_blocking(
        &self,
        submission: ContractConfigurationOpeningSubmission,
    ) -> Result<SubmitContractConfigurationOpeningsResult, SubmissionApiError>;
}

/// Registry-backed implementation shared by the node wiring and tests.
pub struct PscanService<R: ContractIndexReader + 'static> {
    registry: Arc<SourceVerificationService>,
    reader: R,
    permits: Arc<Semaphore>,
}

impl<R: ContractIndexReader + 'static> PscanService<R> {
    pub fn new(registry: Arc<SourceVerificationService>, reader: R) -> Self {
        Self {
            registry,
            reader,
            permits: Arc::new(Semaphore::new(SUBMISSION_CONCURRENCY)),
        }
    }
}

impl<R: ContractIndexReader + 'static> PscanApi for PscanService<R> {
    fn info(&self) -> SourceVerificationInfo {
        self.registry.info()
    }

    fn get_contract_source(
        &self,
        address: Address,
    ) -> Result<Option<ContractSourceView>, SourceVerificationApiError> {
        match self.reader.contract_for_source(address) {
            Ok(Some(contract)) => Ok(Some(self.registry.contract_source(contract)?)),
            Ok(None) => Ok(None),
            Err(error) => Err(SourceVerificationApiError::Unavailable(error)),
        }
    }

    fn get_implementation_source(
        &self,
        application_vk_hash: &B256,
    ) -> Result<Option<ImplementationSource>, SourceVerificationApiError> {
        self.registry.implementation_source(application_vk_hash)
    }

    fn get_implementation_source_file(
        &self,
        application_vk_hash: &B256,
        path: &str,
    ) -> Result<Option<ImplementationSourceFile>, SourceVerificationApiError> {
        self.registry
            .implementation_source_file(application_vk_hash, path)
    }

    fn get_contract_source_bundle(
        &self,
        address: Address,
    ) -> Result<Option<ContractSourceBundle>, SourceVerificationApiError> {
        match self.reader.contract_for_source(address) {
            Ok(Some(contract)) => Ok(Some(self.registry.contract_bundle(contract)?)),
            Ok(None) => Ok(None),
            Err(error) => Err(SourceVerificationApiError::Unavailable(error)),
        }
    }

    fn submission_permits(&self) -> Arc<Semaphore> {
        Arc::clone(&self.permits)
    }

    fn submit_blocking(
        &self,
        envelope: SubmittedSourceEnvelope,
    ) -> Result<SubmitContractSourceResult, SubmissionApiError> {
        if !self.registry.source_submissions_enabled() {
            return Err(SubmissionApiError::Disabled);
        }
        if envelope.contract_addresses.len() > MAX_SUBMISSION_TARGETS {
            return Err(SubmissionApiError::Limited(format!(
                "a submission may target at most {MAX_SUBMISSION_TARGETS} contracts"
            )));
        }
        let mut targets: Vec<(Address, ContractDto)> =
            Vec::with_capacity(envelope.contract_addresses.len());
        for address in &envelope.contract_addresses {
            let contract = match self.reader.contract_for_source(*address) {
                Ok(Some(contract)) => contract,
                Ok(None) => {
                    return Err(SubmissionApiError::Invalid(format!(
                        "no canonical contract account at {address}"
                    )));
                }
                Err(error) => return Err(SubmissionApiError::Unavailable(error)),
            };
            targets.push((*address, contract));
        }
        // Every submitted implementation and opening must contribute to one of
        // these live immutable function sets; anything else would let valid-
        // but-unrelated circuits consume the public budget.
        let mut function_keys: HashSet<B256> = HashSet::new();
        let mut bindings: HashMap<Address, (HashSet<B256>, HashSet<u8>)> = HashMap::new();
        for (address, contract) in &targets {
            let mut vks = HashSet::new();
            let mut selectors = HashSet::new();
            for function in &contract.functions {
                vks.insert(function.application_vk_hash);
                selectors.insert(function.selector);
                function_keys.insert(function.application_vk_hash);
            }
            bindings.insert(*address, (vks, selectors));
        }
        let imported =
            load_publication_for(&envelope.publication).map_err(SubmissionApiError::Invalid)?;
        if !targets
            .iter()
            .any(|(_, contract)| imported.presentation_matches_contract(contract))
        {
            return Err(SubmissionApiError::Invalid(
                "contract presentation does not match any targeted contract's exact ordered selector/VK shape"
                    .to_owned(),
            ));
        }
        if imported.implementations.is_empty() && imported.openings.is_empty() {
            return Err(SubmissionApiError::Invalid(
                "publication contains no implementations or configuration openings".to_owned(),
            ));
        }
        for key in imported.implementations.keys() {
            if !function_keys.contains(key) {
                return Err(SubmissionApiError::Invalid(format!(
                    "implementation {key} is not committed to by any targeted contract"
                )));
            }
        }
        for key in imported.openings.keys() {
            match bindings.get(&key.address) {
                Some((vks, selectors))
                    if vks.contains(&key.application_vk_hash)
                        && selectors.contains(&key.selector) => {}
                _ => {
                    return Err(SubmissionApiError::Invalid(format!(
                        "configuration opening for {} selector {} does not bind to any targeted contract",
                        key.address, key.selector
                    )));
                }
            }
        }

        let submitted_hashes = submitted_application_vk_hashes(&envelope);
        let content_id =
            publication_content_id(&envelope.publication).map_err(SubmissionApiError::Invalid)?;
        if let Some(record) = self
            .registry
            .submission_receipt(&content_id)
            .map_err(submission_error_from_source)?
        {
            return Ok(receipt_to_result(&content_id, &record, true));
        }

        // Provenance is resolved up front from the live registry so the
        // persisted receipt reports the ORIGINAL channel for any vk that
        // already existed; new vks are stamped as public submissions.
        let receipt = StoredSubmissionRecord {
            accepted_at_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as u64)
                .unwrap_or_default(),
            // A receipt is returned only for a later deduplicated request,
            // which performs no reproduction.
            reproduced_implementations: 0,
            configuration_opening_count: imported.opening_count,
            implementations: submitted_hashes
                .iter()
                .map(|vk_hash| {
                    let origin = self.registry.implementation_origin(vk_hash);
                    SubmittedImplementation {
                        application_vk_hash: *vk_hash,
                        verification_authority: origin
                            .map_or(VerificationAuthority::PublicSubmission, |(authority, _)| {
                                authority
                            }),
                        verification_method: origin
                            .map_or(VerificationMethod::SubmittedBundle, |(_, method)| method),
                    }
                })
                .collect(),
        };
        let PublishOutcome {
            new_implementations,
            merged,
        } = self
            .registry
            .publish_inner(
                envelope.publication,
                PublicationOrigin::Public,
                Some((content_id, receipt)),
            )
            .map_err(submission_error_from_source)?;

        // A public submission merges implementations and openings exactly as an
        // operator publication does, so it can change a contract's status too.
        // The registry commit already happened; a stale verification index is
        // repairable and must not turn an accepted submission into an error.
        if let Err(error) = self.reader.contract_verification_changed(None) {
            tracing::warn!(%error, "contract verification index refresh failed after submission");
        }

        // Provenance comes from the merged rows, so a vk that already existed
        // reports its original channel rather than the resubmitter's.
        let mut implementations = Vec::new();
        for vk_hash in &submitted_hashes {
            match merged.implementations.get(vk_hash) {
                Some(implementation) => implementations.push(SubmittedImplementation {
                    application_vk_hash: *vk_hash,
                    verification_authority: implementation.summary.verification_authority,
                    verification_method: implementation.summary.verification_method,
                }),
                None => {
                    return Err(SubmissionApiError::Unavailable(
                        "accepted implementation vanished during merge".to_owned(),
                    ));
                }
            }
        }
        Ok(SubmitContractSourceResult {
            content_id,
            deduplicated: false,
            reproduced_implementations: new_implementations,
            configuration_opening_count: imported.opening_count,
            implementations,
        })
    }

    fn submit_configuration_openings_blocking(
        &self,
        submission: ContractConfigurationOpeningSubmission,
    ) -> Result<SubmitContractConfigurationOpeningsResult, SubmissionApiError> {
        if !self.registry.configuration_opening_submissions_enabled() {
            return Err(SubmissionApiError::Disabled);
        }
        let contract = match self.reader.contract_for_source(submission.contract_address) {
            Ok(Some(contract)) if contract.address == submission.contract_address => contract,
            Ok(Some(_)) => {
                return Err(SubmissionApiError::Invalid(
                    "contract index answered for a different address".to_owned(),
                ));
            }
            Ok(None) => {
                return Err(SubmissionApiError::Invalid(format!(
                    "no canonical contract account at {}",
                    submission.contract_address
                )));
            }
            Err(error) => return Err(SubmissionApiError::Unavailable(error)),
        };
        let content_id = configuration_opening_submission_content_id(&submission)
            .map_err(SubmissionApiError::Invalid)?;
        let deduplicated = self
            .registry
            .submit_contract_configuration_openings(&contract, &submission.openings)
            .map_err(submission_error_from_source)?;
        if let Err(error) = self
            .reader
            .contract_verification_changed(Some(contract.address))
        {
            tracing::warn!(
                %error,
                address = %contract.address,
                "contract verification index refresh failed after configuration openings"
            );
        }
        Ok(SubmitContractConfigurationOpeningsResult {
            contract_address: submission.contract_address,
            content_id,
            configuration_opening_count: submission.openings.len() as u64,
            deduplicated,
        })
    }
}

fn submitted_application_vk_hashes(envelope: &SubmittedSourceEnvelope) -> Vec<B256> {
    envelope
        .publication
        .manifest
        .as_object()
        .and_then(|manifest| manifest.get("implementations"))
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|implementation| parse_b256(implementation.get("applicationVkHash")?.as_str()?))
        .collect()
}

fn parse_b256(raw: &str) -> Option<B256> {
    decode_fixed_hex::<32>(raw, "hash").ok().map(B256::new)
}

fn parse_address(raw: &str) -> Option<Address> {
    decode_fixed_hex::<20>(raw, "address")
        .ok()
        .map(Address::new)
}

/// Content id over the canonical manifest JSON plus each attachment's path and
/// content digest, iterated in sorted path order (`BTreeMap`). Any byte change
/// to the manifest or any attachment changes the id.
pub fn publication_content_id(publication: &SourceVerificationPublication) -> Result<B256, String> {
    let manifest_json = serde_json::to_vec(&publication.manifest)
        .map_err(|error| format!("manifest serialization failed: {error}"))?;
    let mut hash = Sha256::new();
    hash.update(manifest_json);
    for (path, encoded) in &publication.attachments {
        hash.update(path.as_bytes());
        let bytes = decode_base64(encoded)?;
        hash.update(<[u8; 32]>::from(Sha256::digest(bytes)));
    }
    Ok(B256::from(<[u8; 32]>::from(hash.finalize())))
}

/// Stable identity for an exact configuration-opening request. The domain tag
/// keeps these ids distinct from full source-publication ids.
pub fn configuration_opening_submission_content_id(
    submission: &ContractConfigurationOpeningSubmission,
) -> Result<B256, String> {
    let encoded = serde_json::to_vec(submission)
        .map_err(|error| format!("configuration-opening serialization failed: {error}"))?;
    let mut hash = Sha256::new();
    hash.update(b"pcash-pscan-contract-configuration-openings\0");
    hash.update(encoded);
    Ok(B256::from(<[u8; 32]>::from(hash.finalize())))
}

fn receipt_to_result(
    content_id: &B256,
    record: &StoredSubmissionRecord,
    deduplicated: bool,
) -> SubmitContractSourceResult {
    SubmitContractSourceResult {
        content_id: *content_id,
        deduplicated,
        reproduced_implementations: record.reproduced_implementations,
        configuration_opening_count: record.configuration_opening_count,
        implementations: record.implementations.clone(),
    }
}

fn submission_error_from_source(error: SourceVerificationApiError) -> SubmissionApiError {
    match error {
        SourceVerificationApiError::Disabled => SubmissionApiError::Disabled,
        SourceVerificationApiError::Unavailable(message) => {
            SubmissionApiError::Unavailable(message)
        }
        SourceVerificationApiError::Invalid(message) => SubmissionApiError::Invalid(message),
        SourceVerificationApiError::Conflict(message) => SubmissionApiError::Limited(format!(
            "conflicts with newer registry material: {message}"
        )),
        SourceVerificationApiError::Storage(message) => SubmissionApiError::Unavailable(message),
    }
}

fn source_error(error: SourceVerificationApiError) -> ErrorObjectOwned {
    let code = match &error {
        SourceVerificationApiError::Disabled => pcash_rpc::SOURCE_DISABLED_CODE,
        SourceVerificationApiError::Unavailable(_) => pcash_rpc::SOURCE_UNAVAILABLE_CODE,
        SourceVerificationApiError::Invalid(_) => pcash_rpc::SOURCE_INVALID_CODE,
        SourceVerificationApiError::Conflict(_) => pcash_rpc::SOURCE_CONFLICT_CODE,
        SourceVerificationApiError::Storage(_) => pcash_rpc::SOURCE_STORAGE_CODE,
    };
    ErrorObject::owned(code, error.to_string(), None::<()>)
}

fn submission_error(error: SubmissionApiError) -> ErrorObjectOwned {
    let (code, kind) = error.code_and_kind();
    ErrorObject::owned(code, error.to_string(), Some(kind))
}

fn configuration_opening_submission_error(error: SubmissionApiError) -> ErrorObjectOwned {
    let (code, kind) = error.code_and_kind();
    let message = match error {
        SubmissionApiError::Invalid(detail) => {
            format!("invalid configuration-opening submission: {detail}")
        }
        SubmissionApiError::Limited(detail) => {
            format!("configuration-opening submission rejected: {detail}")
        }
        SubmissionApiError::Unavailable(detail) => {
            format!("configuration-opening submission unavailable: {detail}")
        }
        SubmissionApiError::Disabled => {
            "configuration-opening submissions are disabled on this listener".to_owned()
        }
    };
    ErrorObject::owned(code, message, Some(kind))
}

fn invalid_params(message: impl Into<String>) -> ErrorObjectOwned {
    ErrorObject::owned(-32602, message.into(), None::<()>)
}

fn one_string_param(params: Params<'_>) -> Result<String, ErrorObjectOwned> {
    params
        .one::<String>()
        .map_err(|error| invalid_params(error.to_string()))
}

fn two_string_param(params: Params<'_>) -> Result<(String, String), ErrorObjectOwned> {
    params
        .parse()
        .map_err(|error| invalid_params(error.to_string()))
}

fn encode<T: serde::Serialize>(value: &T) -> Result<serde_json::Value, ErrorObjectOwned> {
    serde_json::to_value(value).map_err(|error| {
        ErrorObject::owned(
            -32700,
            format!("response serialization failed: {error}"),
            None::<()>,
        )
    })
}

fn decode_address(raw: &str) -> Result<Address, ErrorObjectOwned> {
    parse_address(raw).ok_or_else(|| invalid_params("address must be 20 bytes of hex"))
}

fn decode_b256(raw: &str) -> Result<B256, ErrorObjectOwned> {
    parse_b256(raw).ok_or_else(|| invalid_params("hash must be 32 bytes of hex"))
}

/// Registers the seven `pscan_*` methods on a module keyed by [`PscanApi`].
#[allow(
    clippy::expect_used,
    reason = "the static Pscan method names are registered exactly once"
)]
pub fn build_pscan_module(api: Arc<dyn PscanApi>) -> RpcModule<Arc<dyn PscanApi>> {
    let mut module = RpcModule::new(Arc::clone(&api));
    let reads = BlockingReads::default();

    register_read(
        &reads,
        &mut module,
        "pscan_sourceVerificationInfo",
        |_params, api, ()| encode(&api.info()),
    )
    .expect("register pscan_sourceVerificationInfo");

    register_read(
        &reads,
        &mut module,
        "pscan_getContractSource",
        |params, api, ()| {
            let address = decode_address(&one_string_param(params)?)?;
            encode(&api.get_contract_source(address).map_err(source_error)?)
        },
    )
    .expect("register pscan_getContractSource");

    register_read(
        &reads,
        &mut module,
        "pscan_getImplementationSource",
        |params, api, ()| {
            let vk_hash = decode_b256(&one_string_param(params)?)?;
            encode(
                &api.get_implementation_source(&vk_hash)
                    .map_err(source_error)?,
            )
        },
    )
    .expect("register pscan_getImplementationSource");

    register_read(
        &reads,
        &mut module,
        "pscan_getImplementationSourceFile",
        |params, api, ()| {
            let (hash_raw, path) = two_string_param(params)?;
            let vk_hash = decode_b256(&hash_raw)?;
            encode(
                &api.get_implementation_source_file(&vk_hash, &path)
                    .map_err(source_error)?,
            )
        },
    )
    .expect("register pscan_getImplementationSourceFile");

    register_read(
        &reads,
        &mut module,
        "pscan_getContractSourceBundle",
        |params, api, ()| {
            let address = decode_address(&one_string_param(params)?)?;
            encode(
                &api.get_contract_source_bundle(address)
                    .map_err(source_error)?,
            )
        },
    )
    .expect("register pscan_getContractSourceBundle");

    module
        .register_async_method("pscan_submitContractSource", |params, api, _| async move {
            let envelope = params
                .one::<SubmittedSourceEnvelope>()
                .map_err(|error| invalid_params(error.to_string()))?;
            let permit = api
                .submission_permits()
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| {
                    submission_error(SubmissionApiError::Limited(
                        "submission pipeline is shutting down".to_owned(),
                    ))
                })?;
            let result = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                api.submit_blocking(envelope)
            })
            .await
            .map_err(|error| {
                submission_error(SubmissionApiError::Unavailable(format!(
                    "submission worker failed: {error}"
                )))
            })?;
            encode(&result.map_err(submission_error)?)
        })
        .expect("register pscan_submitContractSource");

    module
        .register_async_method(
            "pscan_submitContractConfigurationOpenings",
            |params, api, _| async move {
                let submission = params
                    .one::<ContractConfigurationOpeningSubmission>()
                    .map_err(|error| invalid_params(error.to_string()))?;
                let permit = api
                    .submission_permits()
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| {
                        configuration_opening_submission_error(SubmissionApiError::Limited(
                            "submission pipeline is shutting down".to_owned(),
                        ))
                    })?;
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    api.submit_configuration_openings_blocking(submission)
                })
                .await
                .map_err(|error| {
                    configuration_opening_submission_error(SubmissionApiError::Unavailable(
                        format!("submission worker failed: {error}"),
                    ))
                })?;
                encode(&result.map_err(configuration_opening_submission_error)?)
            },
        )
        .expect("register pscan_submitContractConfigurationOpenings");

    module
}

/// Bind the source-verification listener.
///
/// The two deliberate differences from the public `pcash_*` server are
/// documented in the module header: permissive CORS for the browser Explorer,
/// and a request ceiling sized for embedded bundles rather than ordinary
/// reads. HTTP-only like the admin listener: nothing here benefits from
/// WebSocket transport.
pub async fn serve_pscan(
    addr: SocketAddr,
    api: Arc<dyn PscanApi>,
) -> std::io::Result<(SocketAddr, jsonrpsee::server::ServerHandle)> {
    serve_pscan_with_metrics(addr, api, noop()).await
}

/// [`serve_pscan`] with an injected recorder, so pscan calls appear in the
/// same `rpc_*` metrics as the other listeners rather than being invisible.
pub async fn serve_pscan_with_metrics(
    addr: SocketAddr,
    api: Arc<dyn PscanApi>,
    metrics: Arc<dyn Metrics>,
) -> std::io::Result<(SocketAddr, jsonrpsee::server::ServerHandle)> {
    let module = build_pscan_module(api);
    let registered_methods = Arc::new(module.method_names().collect::<HashSet<_>>());
    let cors = CorsLayer::permissive();
    let http_middleware = ServiceBuilder::new().layer(cors);
    let rpc_middleware =
        RpcServiceBuilder::new().layer_fn(move |service| pcash_rpc::RpcMetricsService {
            service,
            metrics: Arc::clone(&metrics),
            registered_methods: Arc::clone(&registered_methods),
        });
    let config = ServerConfig::builder()
        .max_request_body_size(PSCAN_MAX_REQUEST_BODY_BYTES)
        .max_response_body_size(PSCAN_MAX_REQUEST_BODY_BYTES)
        .set_batch_request_config(BatchRequestConfig::Limit(1))
        .http_only()
        .build();
    let server = Server::builder()
        .set_config(config)
        .set_http_middleware(http_middleware)
        .set_rpc_middleware(rpc_middleware)
        .build(addr)
        .await?;
    let local = server.local_addr()?;
    let handle = server.start(module);
    Ok((local, handle))
}

#[cfg(feature = "client")]
#[jsonrpsee::proc_macros::rpc(client, namespace = "pscan")]
pub trait PscanClient {
    #[method(name = "sourceVerificationInfo")]
    async fn source_verification_info(&self) -> jsonrpsee::core::RpcResult<SourceVerificationInfo>;

    #[method(name = "getContractSource")]
    async fn get_contract_source(
        &self,
        address: Address,
    ) -> jsonrpsee::core::RpcResult<Option<ContractSourceView>>;

    #[method(name = "getImplementationSource")]
    async fn get_implementation_source(
        &self,
        application_vk_hash: B256,
    ) -> jsonrpsee::core::RpcResult<Option<ImplementationSource>>;

    #[method(name = "getImplementationSourceFile")]
    async fn get_implementation_source_file(
        &self,
        application_vk_hash: B256,
        path: String,
    ) -> jsonrpsee::core::RpcResult<Option<ImplementationSourceFile>>;

    #[method(name = "getContractSourceBundle")]
    async fn get_contract_source_bundle(
        &self,
        address: Address,
    ) -> jsonrpsee::core::RpcResult<Option<ContractSourceBundle>>;

    #[method(name = "submitContractSource")]
    async fn submit_contract_source(
        &self,
        envelope: SubmittedSourceEnvelope,
    ) -> jsonrpsee::core::RpcResult<SubmitContractSourceResult>;

    #[method(name = "submitContractConfigurationOpenings")]
    async fn submit_contract_configuration_openings(
        &self,
        submission: ContractConfigurationOpeningSubmission,
    ) -> jsonrpsee::core::RpcResult<SubmitContractConfigurationOpeningsResult>;
}

#[cfg(test)]
#[allow(
    clippy::expect_used,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::{
        parse_address, parse_b256, serve_pscan_with_metrics, ContractIndexReader, PscanApi,
        PscanService,
    };
    use crate::registry::SourceVerificationService;
    use alloy_primitives::{Address, B256};
    use jsonrpsee::core::client::ClientT;
    use jsonrpsee::http_client::HttpClientBuilder;
    use jsonrpsee::rpc_params;
    use pcash_metrics::{Metrics, PrometheusMetrics};
    use pcash_rpc::ContractDto;
    use std::sync::Arc;

    struct EmptyIndex;

    impl ContractIndexReader for EmptyIndex {
        fn contract_for_source(&self, _address: Address) -> Result<Option<ContractDto>, String> {
            Ok(None)
        }

        fn contract_verification_changed(&self, _address: Option<Address>) -> Result<(), String> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn pscan_metrics_use_only_this_listeners_registered_methods() {
        let registry = Arc::new(SourceVerificationService::open_in_memory(
            7,
            B256::ZERO,
            None,
        ));
        let api: Arc<dyn PscanApi> = Arc::new(PscanService::new(registry, EmptyIndex));
        let metrics = Arc::new(PrometheusMetrics::new());
        let (addr, _handle) = serve_pscan_with_metrics(
            "127.0.0.1:0".parse().expect("loopback address"),
            api,
            Arc::clone(&metrics) as Arc<dyn Metrics>,
        )
        .await
        .expect("pscan serve binds");
        let client = HttpClientBuilder::default()
            .build(format!("http://{addr}"))
            .expect("HTTP client");
        let _: serde_json::Value = client
            .request("pscan_sourceVerificationInfo", rpc_params![])
            .await
            .expect("registered pscan method");
        assert!(client
            .request::<serde_json::Value, _>("admin_nodeInfo", rpc_params![])
            .await
            .is_err());

        let text = metrics.encode().expect("encode metrics");
        assert!(
            text.contains(
                r#"pcash_node_rpc_requests_total{method="pscan_sourceVerificationInfo"} 1"#
            ),
            "{text}"
        );
        assert!(
            text.contains(r#"pcash_node_rpc_requests_total{method="unknown"} 1"#),
            "{text}"
        );
        assert!(!text.contains(r#"method="admin_nodeInfo""#), "{text}");
    }

    #[test]
    fn fixed_hex_params_reject_wrong_lengths_and_non_ascii_without_panicking() {
        assert!(parse_b256(&format!("0x{}", "ab".repeat(32))).is_some());
        assert!(parse_b256(&"ab".repeat(31)).is_none());
        assert!(parse_address(&"ab".repeat(20)).is_some());
        assert!(parse_address(&"ab".repeat(19)).is_none());
        // Exactly the expected byte length, with byte offset 2 inside a
        // two-byte character: slicing hex pairs by byte offset would panic.
        let hash = format!("a\u{e9}{}", "a".repeat(61));
        let address = format!("a\u{e9}{}", "a".repeat(37));
        assert_eq!((hash.len(), address.len()), (64, 40));
        for prefix in ["", "0x"] {
            assert!(parse_b256(&format!("{prefix}{hash}")).is_none());
            assert!(parse_address(&format!("{prefix}{address}")).is_none());
        }
        // Oversized valid hex is refused on its length alone.
        let oversized = "ab".repeat(1 << 20);
        assert!(parse_b256(&oversized).is_none());
        assert!(parse_address(&format!("0x{oversized}")).is_none());
    }
}
