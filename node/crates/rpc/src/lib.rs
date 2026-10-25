//! PCASH reference JSON-RPC surface: the public `pcash_*` namespace, the
//! operator-only `admin_*` namespace, their wire types, and a typed client for
//! them.

#[cfg(feature = "client")]
pub mod client;

pub mod admin;
pub mod catalog;
pub mod dto;
pub mod handlers;
pub mod redb_schema;
pub mod request;
pub mod server;
pub mod wire;

#[cfg(feature = "test-support")]
pub mod test_support;

pub use admin::{
    build_admin_module, serve_admin, serve_admin_with_metrics, AdminApi, AdminApiError,
    SOURCE_CONFLICT_CODE, SOURCE_DISABLED_CODE, SOURCE_INVALID_CODE,
    SOURCE_PUBLICATION_MAX_BODY_BYTES, SOURCE_STORAGE_CODE, SOURCE_UNAVAILABLE_CODE,
};
pub use catalog::{
    catalog_content_id, catalog_content_id_preimage, namespace_is_valid, CatalogApiError,
    CatalogArtifact, CatalogGetRequest, CatalogInfo, CatalogLimits, CatalogListRequest,
    CatalogPage, CatalogRecord, CatalogStatus, DEFAULT_CATALOG_NAMESPACES, MARKETPLACE_NAMESPACE,
    TOKENS_DROP_NAMESPACE,
};
#[cfg(feature = "client")]
pub use client::{
    AdminClient, AdminRpcClient, PcashApiClient, PcashClient, PcashClientBuilder, PcashClientError,
    Quantity,
};
pub use dto::{
    AccountChangeContinuationDto, AccountChangeDto, AccountChangePageDto, AccountChangeTargetDto,
    AccountDto, AccountProofDto, AccountProofPresent, AccountProofResultDto, AccountReceiptDto,
    AccountUpdateCurrentAccountStateDto, AccountUpdateOpeningDto, AddPeerResultDto, BlockDto,
    BlockEconomicsPageDto, BlockEconomicsRecordDto, BlockHashDivergenceDto, BlockHeaderDto,
    BlockId, BlockPayoutsDto, CarrierTypeDto, CheckOutcomeDto, ContractDto, ContractFunctionDto,
    ContractFundingMode, ContractPageDto, ContractPresent, ContractResultDto, ContractSummaryDto,
    ContractUnavailable, ContractVerificationStatusDto, CurrentBoundaryEnvelope, DerivationDto,
    ExplorerCursorDto, FeeEstimateBasisDto, FeeEstimateDto, FeeTiersDto, ForkCapabilityDto,
    HaltCause, HistoryProofDto, InclusionId, IndexStatusDto, IssuanceParentDto, IssuanceQuoteDto,
    IssuanceRoute, L1DeliveryBatchContinuationDto, L1DeliveryBatchDto, L1DeliveryBatchPageDto,
    L1LogProofDto, L1OriginDto, L1OriginProofDto, MempoolPageDto, MempoolRejectionDto, MempoolSort,
    MempoolStatusFilter, MempoolTransactionDto, NodeInfoDto, NullifierLeafDto, NullifierProofDto,
    NullifierProofsDto, OutputContinuationDto, OutputFrontierDto, OutputItemDto, OutputLeafPathDto,
    OutputMaterialDto, OutputOriginDto, OutputPageDto, OutputPathDto, OutputPathsDto,
    OutputTargetDto, P2pNetworkDto, PayoutCursorDto, PayoutOutputDto, PayoutPageDto,
    PayoutRecordDto, PayoutResultLeafDto, PayoutScanRecordDto, PeerDirectionDto, PeerInfoDto,
    PreparedRelayDto, ProverAssetsDto, PublicRecordDto, ReceiptDto, ReceiveMaterialDto,
    RemovePeerResultDto, ResultLeafDto, ResultPosition, ResultProofDto, ResultStatementDto,
    StallCause, StatusDto, TransactionCheckDto, TransactionDto, TransactionKind,
    TransactionPageDto, TransactionResultDto, TransactionSummaryDto, WitnessSnapshotBlockDto,
    WitnessSnapshotDto,
};
pub use handlers::{
    are_nullifiers_spent, block_dto, get_account, get_account_proof, get_block_header,
    get_block_header_by_hash, get_history_proof, get_issuance_quote, get_l1_origin_proof,
    get_nullifier_proofs, get_output_path, get_output_paths, get_payouts, parse_block_hash, status,
    StatusMeta,
};
pub use jsonrpsee::Methods as RpcMethods;
pub use redb_schema::{require_meta_keys, require_tables};
pub use request::{
    AccountChangeLimitsQuery, AccountChangesQuery, AccountHistoryQuery, ArenaDataMatch,
    ArenaRecordQuery, BlockEconomicsQuery, BlockRangeQuery, CarrierContextQuery, CatalogGetQuery,
    CatalogListQuery, CheckRawTransactionQuery, ContractsQuery, FeeBearingKind, FeeEstimateQuery,
    IssuanceQuoteQuery, L1DeliveryBatchLimitsQuery, L1DeliveryBatchesQuery, MempoolQuery,
    OutputLimitsQuery, OutputQuery, PayoutQuery, PrepareRelayQuery, ReceiptAccountQuery,
    ReceiptInclusionKey, ReceiptInclusionQuery, ReceiptNullifierQuery, ReceiptQuery,
    SubmissionQuery, TransactionsQuery, WitnessL1LogQuery, WitnessSnapshotQuery,
};
pub use server::RpcMetricsService;
pub use server::{
    build_module, serve, serve_with_metrics, AccountChangeLimits, AccountChangesRequest,
    ArenaFilter, BlockTag, CarrierContextRequest, CheckRawTransactionRequest, IndexReadError,
    IssuanceQuoteError, L1DeliveryBatchLimits, L1DeliveryBatchesRequest, MempoolApiError,
    MempoolFilter, NodeApi, OutputLimits, OutputRequest, PrepareRelayRequest,
    MAX_CHECK_CONTEXT_BYTES, MAX_MEMPOOL_TX_BYTES, MAX_PREPARED_BATCH_BYTES,
    MAX_PREPARE_REQUEST_IDS,
};
