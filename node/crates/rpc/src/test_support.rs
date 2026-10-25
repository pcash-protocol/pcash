//! Fixtures and a `NodeApi` stub for driving a real server in tests.
//!
//! Enabled by the `test-support` feature, which is turned on only through this
//! crate's own dev-dependency and by other crates' dev-dependencies, so no
//! release build can select it.
//!
//! One set of values backs every consumer: the frozen wire golden, the CORS
//! contract test, the client end-to-end tests, and the CLI binary test. Because
//! the stub answers with exactly the fixtures the golden file pins, a test that
//! compares a decoded response against a fixture is transitively checking it
//! against frozen wire bytes.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreadable_literal,
    reason = "fixtures are constructed directly, and each consumer uses a different subset"
)]

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;

use alloy_primitives::{Address, Bytes, B256, I256, U256};

use crate::admin::{AdminApi, AdminApiError};
use crate::catalog::{
    CatalogApiError, CatalogArtifact, CatalogGetRequest, CatalogInfo, CatalogLimits,
    CatalogListRequest, CatalogPage, CatalogRecord, CatalogStatus, MARKETPLACE_NAMESPACE,
};
use crate::dto::{
    AccountChangeContinuationDto, AccountChangeDto, AccountChangePageDto, AccountChangeTargetDto,
    AccountDto, AccountProofDto, AccountProofPresent, AccountProofResultDto, AccountReceiptDto,
    AddPeerResultDto, BlockDto, BlockHashDivergenceDto, BlockHeaderDto, BlockId, BlockPayoutsDto,
    CarrierTypeDto, CheckOutcomeDto, ContractDto, ContractFunctionDto, ContractPageDto,
    ContractPresent, ContractResultDto, CurrentBoundaryEnvelope, DerivationDto,
    FeeEstimateBasisDto, FeeEstimateDto, FeeTiersDto, ForkCapabilityDto, HaltCause,
    HistoryProofDto, InclusionId, IndexStatusDto, IssuanceRoute, L1DeliveryBatchContinuationDto,
    L1DeliveryBatchDto, L1DeliveryBatchPageDto, L1LogProofDto, L1OriginDto, L1OriginProofDto,
    MempoolPageDto, MempoolRejectionDto, MempoolTransactionDto, NodeInfoDto, NullifierLeafDto,
    NullifierProofDto, NullifierProofsDto, OutputContinuationDto, OutputFrontierDto, OutputItemDto,
    OutputLeafPathDto, OutputOriginDto, OutputPageDto, OutputPathDto, OutputPathsDto,
    OutputTargetDto, PeerDirectionDto, PeerInfoDto, PreparedRelayDto, ProverAssetsDto, ReceiptDto,
    ReceiveMaterialDto, RemovePeerResultDto, StallCause, StatusDto, TransactionCheckDto,
    TransactionDto, TransactionKind, TransactionPageDto, TransactionResultDto,
};
use crate::request::{
    AccountHistoryQuery, ContractsQuery, ReceiptQuery, SubmissionQuery, TransactionsQuery,
};
use crate::server::{
    serve, AccountChangesRequest, BlockTag, CheckRawTransactionRequest, IndexReadError,
    L1DeliveryBatchesRequest, MempoolApiError, MempoolFilter, NodeApi, OutputRequest,
    PrepareRelayRequest,
};
use pcash_state::{ItemExclusionReason, StateError, TransactionOutcome};
use serde_json::Value;

/// Serialize a response DTO the way the server does.
pub trait ToWire {
    fn to_value(&self) -> Value;
}

impl<T: serde::Serialize> ToWire for T {
    fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("response DTOs serialize")
    }
}

/// A distinct 32-byte pattern per `n`, so transposed fields are visible.
pub fn raw(n: u8) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = n.wrapping_mul(17).wrapping_add(i as u8);
    }
    out
}

pub fn h(n: u8) -> B256 {
    B256::from(raw(n))
}

pub fn addr(n: u8) -> Address {
    let mut out = [0u8; 20];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = n.wrapping_mul(23).wrapping_add(i as u8);
    }
    Address::from(out)
}

pub fn bytes(n: u8, len: usize) -> Bytes {
    Bytes::from(
        (0..len)
            .map(|i| n.wrapping_add(i as u8))
            .collect::<Vec<u8>>(),
    )
}

pub fn sib40(base: u8) -> [B256; 40] {
    let mut out = [B256::ZERO; 40];
    for (i, s) in out.iter_mut().enumerate() {
        *s = h(base.wrapping_add(i as u8));
    }
    out
}

pub fn sib41(base: u8) -> [B256; 41] {
    std::array::from_fn(|i| h(base.wrapping_add(i as u8)))
}

pub fn sib64(base: u8) -> [B256; 64] {
    std::array::from_fn(|i| h(base.wrapping_add(i as u8)))
}

pub fn sib4(base: u8) -> [B256; 4] {
    let mut out = [B256::ZERO; 4];
    for (i, s) in out.iter_mut().enumerate() {
        *s = h(base.wrapping_add(i as u8));
    }
    out
}

pub fn boundary() -> CurrentBoundaryEnvelope {
    CurrentBoundaryEnvelope {
        state: pcash_state::StateComponents {
            output_root: h(1),
            output_count: 0x11,
            issuance: pcash_state::IssuanceState {
                issued_so_far: U256::from(0x22),
                lag_q: alloy_primitives::I256::ZERO,
            },
            account_state_root: h(3),
            account_count: 0x33,
            nullifier_root: h(4),
            nullifier_count: 0x55,
        },
        header: pcash_state::BlockHeader {
            parent_hash: h(5),
            number: 0x44,
            timestamp: 0x6512_3456,
            transaction_results_root: h(6),
            state_root: h(7),
            l1_origin_root: h(8),
            history_root: h(9),
        },
        block_hash: h(11),
    }
}

pub fn block_id() -> BlockId {
    BlockId {
        block_number: 0x55,
        block_hash: h(12),
    }
}

pub fn output_origin() -> OutputOriginDto {
    OutputOriginDto {
        block_number: 0x55,
        block_hash: h(12),
        block_timestamp: 0x6512_5555,
    }
}

pub fn block() -> BlockDto {
    BlockDto {
        number: 0x66,
        hash: h(13),
        parent_hash: h(14),
        timestamp: 0x6512_9999,
        transaction_results_root: h(15),
        state_root: h(16),
        l1_origin_root: h(17),
        history_root: h(18),
        transaction_result_count: 2,
        transaction_results: vec![
            TransactionResultDto {
                inclusion: InclusionId {
                    l1_block_number: 0x77,
                    l1_block_hash: h(22),
                    l1_transaction_index: 1,
                    l1_transaction_hash: h(26),
                    batch_item_index: 0,
                },
                content_hash: h(24),
                tx_id: h(20),
                outcome: pcash_state::TransactionOutcome::Succeeded,
            },
            TransactionResultDto {
                inclusion: InclusionId {
                    l1_block_number: 0x77,
                    l1_block_hash: h(22),
                    l1_transaction_index: 2,
                    l1_transaction_hash: h(27),
                    batch_item_index: 0,
                },
                content_hash: h(25),
                tx_id: h(21),
                outcome: pcash_state::TransactionOutcome::ProofRejected,
            },
        ],
        transaction_bytes: None,
        l1_origin: L1OriginDto {
            block_number: 0x77,
            block_hash: h(22),
            block_timestamp: 0x6512_9999,
            l1_logs_root: h(23),
            l1_log_count: 2,
        },
    }
}

pub fn status() -> StatusDto {
    StatusDto {
        latest_block: 0x88,
        latest_block_hash: h(23),
        latest_block_timestamp: 0x6512_1111,
        finalized_block: 0x87,
        finalized_block_hash: h(24),
        finalized_block_timestamp: 0x6512_1000,
        latest_l1_block_number: 0x99,
        latest_l1_block_hash: h(25),
        observed_l1_block_number: Some(0x9b),
        derivation: DerivationDto::Following {
            since_unix_ms: 0x18b_0000_0000,
        },
        finalized_l1_block_number: 0x98,
        finalized_l1_block_hash: h(26),
        state_root: h(27),
        l1_origin_root: h(28),
        history_root: h(29),
        output_count: 0x40,
        issued_so_far: U256::from(4_000_000_000_000_000_000u64),
        supply_cap: U256::from(1_000_000_000u64) * U256::from(10u64).pow(U256::from(18)),
        total_succeeded: Some(12),
        total_failed: Some(3),
        total_transactions: Some(15),
        index: IndexStatusDto {
            status: "ready".into(),
            cursor: Some(block_id()),
        },
        prover_assets: Some(ProverAssetsDto {
            asset_set_id: "42".repeat(32),
            base_url: format!("/proving/{}/", "42".repeat(32)),
        }),
        pcash_chain_id: 0xabcd,
        genesis_hash: h(30),
        accepted_transaction_types: pcash_derive::BASE_TRANSACTION_TYPES.to_vec(),
        accepted_batch_versions: vec![1],
        l1_chain_id: 0xaa36a7,
        inbox_address: addr(1),
        genesis_l1_block: 0x1234,
        genesis_l1_block_hash: h(31),
        fork_capability: fork_capability(),
    }
}

pub fn account() -> AccountDto {
    AccountDto {
        address: addr(2),
        index: 0x0a,
        account_revision: 3,
        account_kind: 1,
        nullifier_key_commitment: h(34),
        account_rule_set_commitment: h(35),
        receive_key_hash: h(36),
        material: ReceiveMaterialDto::Available {
            ml_kem768_public_key: bytes(0x40, 1184),
        },
    }
}

pub fn account_proof() -> AccountProofDto {
    AccountProofDto {
        status: AccountProofPresent::Present,
        account: account(),
        account_state_root: h(37),
        account_siblings: sib40(50),
        account_count: 0x3333,
        state_root_header_siblings: sib4(100),
        account_state_root_state_siblings: sib4(110),
        boundary: boundary(),
    }
}

pub fn contract() -> ContractDto {
    ContractDto {
        status: ContractPresent::Contract,
        address: addr(3),
        account_proof: account_proof(),
        functions: vec![
            ContractFunctionDto {
                selector: 0,
                application_vk_hash: h(39),
                configuration_commitment: h(40),
            },
            ContractFunctionDto {
                selector: 1,
                application_vk_hash: h(41),
                configuration_commitment: h(42),
            },
        ],
        transaction: bytes(0x10, 96),
        origin: inclusion(),
    }
}

pub fn inclusion() -> InclusionId {
    InclusionId {
        l1_block_number: 0x4444,
        l1_block_hash: h(43),
        l1_transaction_index: 2,
        l1_transaction_hash: h(44),
        batch_item_index: 5,
    }
}

pub fn fee_estimate() -> FeeEstimateDto {
    let tiers = |scale: u64| FeeTiersDto {
        low: U256::from(0x1000u64 * scale),
        standard: U256::from(0x2000u64 * scale),
        fast: U256::from(0x3000u64 * scale),
    };
    FeeEstimateDto {
        head: block_id(),
        window_blocks: 0x40,
        byte_size: 0x8121,
        tiers: tiers(3),
        basis: FeeEstimateBasisDto {
            included_samples: 7,
            included: Some(tiers(2)),
            pending_samples: 1,
            pending: Some(tiers(1)),
        },
    }
}

pub fn receipt() -> ReceiptDto {
    ReceiptDto {
        inclusion: inclusion(),
        content_hash: h(43),
        tx_id: h(44),
        outcome: pcash_state::TransactionOutcome::Succeeded,
        failure_detail: None,
        l1_sender: addr(5),
        issuance_owner_commitment: Some(h(5)),
        settled_open_fee_amount: U256::ZERO,
        settled_issuance_amount: U256::from(100),
        kind: TransactionKind::PrivateValue,
        funding_mode: None,
        output_leaf_start: Some(0x20),
        outputs_added: 5,
        nullifiers: Some(vec![h(45), h(46), h(47), h(48)]),
        account: Some(AccountReceiptDto {
            address: addr(4),
            account_revision: 9,
        }),
    }
}

pub fn mempool_tx() -> MempoolTransactionDto {
    MempoolTransactionDto {
        content_hash: h(52),
        statement_id: h(53),
        kind: TransactionKind::PrivateValue,
        funding_mode: None,
        stable_id: "0xstable".into(),
        conflict_keys: vec!["key-a".into(), "key-b".into()],
        open_fee_amount: U256::ZERO,
        issuance_owner_commitment: h(5),
        issuance_route: IssuanceRoute::Designated,
        valid_until: Some(0x6512_8888),
        recent_pcash_block_hash: Some(h(57)),
        byte_size: 1234,
        received_at_unix_ms: 1_700_000_000_000,
        conflict_count: 1,
        status: "queued".into(),
        head_checked_block: block_id().block_number,
        head_checked_block_hash: block_id().block_hash,
        public_records: Vec::new(),
        raw_transaction: Some(bytes(0x70, 64)),
    }
}

/// A ready, open-route entry: the shape a relayer's selection policy accepts.
///
/// [`mempool_tx`] is deliberately queued and designated to a third party, because
/// the wire fixtures pin it. A relayer exercising selection needs an entry that
/// survives its own filters, so it gets its own fixture rather than a mutation
/// of the pinned one.
pub fn mempool_tx_ready() -> MempoolTransactionDto {
    MempoolTransactionDto {
        issuance_route: IssuanceRoute::Open,
        issuance_owner_commitment: B256::ZERO,
        open_fee_amount: U256::from(31_000_000_000_000u64),
        status: "ready".into(),
        byte_size: 64,
        ..mempool_tx()
    }
}

pub fn output_page() -> OutputPageDto {
    // A frozen SDK encryption vector pins the opaque output bytes on the wire.
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("../../../../sdk/test/envelope.vector.json")).unwrap();
    let output_data = hex::decode(vector["envelope"].as_str().unwrap()).unwrap();
    OutputPageDto {
        from_output_index: 0x20,
        target: OutputTargetDto {
            block: block_id(),
            output_count: 0x40,
        },
        outputs: vec![OutputItemDto {
            output_index: 0x30,
            output_commitment: h(55),
            material: crate::dto::OutputMaterialDto::Ordinary {
                output_data: output_data.into(),
                transaction_id: h(54),
                transaction_type: 2,
                private_value_shape: None,
                output_slot: 0,
                content_hash: h(56),
                nullifiers: vec![h(57), h(58)],
                arena: Some(h(59).to_vec().into()),
            },
            origin: output_origin(),
        }],
        continuation: Some(OutputContinuationDto {
            from_output_index: 0x20,
            target: block_id(),
            target_output_count: 0x40,
            next_output_index: 0x31,
        }),
        complete: false,
    }
}

pub fn output_frontier() -> OutputFrontierDto {
    OutputFrontierDto {
        block: block_id(),
        output_count: 0x0b,
        output_root: h(60),
        ommers: vec![h(61), h(62), h(63)],
    }
}

pub fn account_change_page() -> AccountChangePageDto {
    AccountChangePageDto {
        from_block: 0x10,
        target: AccountChangeTargetDto {
            block: block_id(),
            account_count: 0x0c,
        },
        changes: vec![
            AccountChangeDto {
                origin: BlockId {
                    block_number: 0x11,
                    block_hash: h(64),
                },
                account_index: 0x0a,
                address: addr(5),
                nullifier_key_commitment: h(65),
                account_rule_set_commitment: h(66),
                account_kind: 0,
                account_revision: 2,
                receive_key_hash: h(67),
                receive_key: Some(bytes(0x70, 1184)),
            },
            AccountChangeDto {
                origin: BlockId {
                    block_number: 0x12,
                    block_hash: h(68),
                },
                account_index: 0x0b,
                address: addr(6),
                nullifier_key_commitment: h(69),
                account_rule_set_commitment: h(70),
                account_kind: 1,
                account_revision: 1,
                receive_key_hash: B256::ZERO,
                receive_key: None,
            },
        ],
        continuation: Some(AccountChangeContinuationDto {
            from_block: 0x10,
            target: block_id(),
            next_block: 0x13,
            next_ordinal: 2,
        }),
        complete: false,
    }
}

pub fn catalog_record() -> CatalogRecord {
    CatalogRecord {
        artifact: CatalogArtifact::new(
            MARKETPLACE_NAMESPACE.to_owned(),
            0xabcd,
            bytes(0x90, 32).to_vec(),
        ),
        created_at: 1_700_000_123,
    }
}

/// The stub chain identity, matching the `status` fixture.
pub const CHAIN_ID: u32 = 0xabcd;

/// Unix seconds assigned to stored catalog records.
pub const CREATED_AT: u64 = 1_700_000_123;

pub fn output_path() -> OutputPathDto {
    OutputPathDto {
        output_index: 0x13,
        root: h(70),
        count: 0x14,
        siblings: sib40(120),
        boundary: boundary(),
    }
}

pub fn output_paths() -> OutputPathsDto {
    OutputPathsDto {
        root: h(71),
        count: 0x15,
        paths: vec![
            OutputLeafPathDto {
                output_index: 1,
                siblings: sib40(130),
            },
            OutputLeafPathDto {
                output_index: 2,
                siblings: sib40(140),
            },
        ],
        boundary: boundary(),
    }
}

pub fn account_proof_present() -> AccountProofResultDto {
    AccountProofResultDto::Present(Box::new(account_proof()))
}

pub fn account_proof_not_found() -> AccountProofResultDto {
    AccountProofResultDto::not_found(addr(7))
}

pub fn contract_result() -> ContractResultDto {
    ContractResultDto::Contract(contract())
}

pub fn contract_not_contract() -> ContractResultDto {
    ContractResultDto::not_contract(account_proof())
}

pub fn contract_not_found() -> ContractResultDto {
    ContractResultDto::not_found(addr(8))
}

pub fn contract_unavailable() -> ContractResultDto {
    ContractResultDto::unavailable(addr(9), "pruned")
}

pub fn block_header() -> BlockHeaderDto {
    BlockHeaderDto {
        recent_pcash_block_hash: h(73),
        boundary: boundary(),
    }
}

pub fn l1_origin_proof() -> L1OriginProofDto {
    L1OriginProofDto {
        recent_pcash_block_hash: h(79),
        l1_origin_root: h(80),
        l1_origin_root_siblings: sib4(190),
        l1_block_number: 0x11_2233,
        l1_block_hash: h(81),
        l1_block_timestamp: 0x6512_9999,
        l1_logs_root: h(82),
        l1_log_count: 3,
        l1_origin_index: 0x18,
        l1_origin_siblings: sib40(200),
        boundary: boundary(),
    }
}

pub fn l1_log_proof() -> L1LogProofDto {
    L1LogProofDto {
        block: l1_origin_proof(),
        log_leaf_index: 1,
        log_siblings: sib64(64),
        transaction_index: 2,
        log_index: 1,
    }
}

pub fn history_proof() -> HistoryProofDto {
    HistoryProofDto {
        recent_pcash_block_hash: h(82),
        history_root: h(83),
        history_root_siblings: sib4(210),
        historical_block_number: 0x19,
        historical_block_hash: h(84),
        history_siblings: sib40(220),
        boundary: boundary(),
    }
}

pub fn nullifier_proofs() -> NullifierProofsDto {
    NullifierProofsDto {
        root: h(85),
        proofs: vec![
            NullifierProofDto {
                nullifier: h(86),
                leaf: NullifierLeafDto {
                    value: h(86),
                    next_value: h(87),
                    next_index: 0x88,
                },
                leaf_index: 0x89,
                siblings: sib41(100),
            },
            NullifierProofDto {
                nullifier: h(90),
                leaf: NullifierLeafDto {
                    value: h(91),
                    next_value: B256::ZERO,
                    next_index: 0,
                },
                leaf_index: 0x92,
                siblings: sib41(150),
            },
        ],
        boundary: boundary(),
    }
}

pub fn mempool_page() -> MempoolPageDto {
    MempoolPageDto {
        items: vec![mempool_tx()],
        next_cursor: Some(h(92)),
        head_checked_block: block_id().block_number,
        head_checked_block_hash: block_id().block_hash,
        peer_count: Some(3),
    }
}

pub fn prepared_relay() -> PreparedRelayDto {
    PreparedRelayDto {
        selected_transactions: vec![bytes(0xa0, 40), bytes(0xa1, 45)],
        selected_content_hashes: vec![h(93), h(94)],
        rejected: vec![MempoolRejectionDto {
            content_hash: h(95),
            reason: "conflicting nullifier".into(),
        }],
        collectible_open_fee: U256::from(42_000_000_000_000u64),
        collectible_qualifying_actions: 1,
        selected_qualifying_actions: 2,
        batch_bytes: 128,
        head_checked_block: block_id().block_number,
        head_checked_block_hash: block_id().block_hash,
    }
}

/// A check that passed.
pub fn transaction_check() -> TransactionCheckDto {
    TransactionCheckDto {
        outcome: CheckOutcomeDto::Executed(TransactionOutcome::Succeeded),
    }
}

/// A check of bytes that admission excludes.
pub fn transaction_check_not_admitted() -> TransactionCheckDto {
    TransactionCheckDto {
        outcome: CheckOutcomeDto::NotAdmitted(ItemExclusionReason::DirectModeOutsideInbox),
    }
}

/// A second stored record with a short payload, so a test can exercise the
/// publish path against a stub that advertises a tiny size ceiling.
pub fn catalog_opaque_record() -> CatalogRecord {
    CatalogRecord {
        artifact: CatalogArtifact::new(
            MARKETPLACE_NAMESPACE.to_owned(),
            CHAIN_ID,
            b"opaque".to_vec(),
        ),
        created_at: CREATED_AT,
    }
}

/// The records the stub behaves as though it already holds.
pub fn stored_catalog_records() -> Vec<CatalogRecord> {
    vec![catalog_record(), catalog_opaque_record()]
}

pub fn catalog_page() -> CatalogPage {
    CatalogPage {
        items: vec![catalog_record()],
        next_cursor: Some(h(96)),
    }
}

pub fn catalog_info(status: CatalogStatus) -> CatalogInfo {
    CatalogInfo {
        status,
        pcash_chain_id: if status == CatalogStatus::Available {
            CHAIN_ID
        } else {
            0
        },
        namespaces: vec![MARKETPLACE_NAMESPACE.to_owned()],
        limits: CatalogLimits::default(),
    }
}

pub fn witness_snapshot() -> crate::dto::WitnessSnapshotDto {
    StubNode::populated()
        .get_witness_snapshot(crate::request::WitnessSnapshotQuery {
            accounts: vec![addr(1)],
            contracts: vec![addr(2)],
            outputs: vec![0],
            nullifiers: vec![B256::ZERO],
            l1_logs: vec![crate::request::WitnessL1LogQuery {
                l1_block_number: 1,
                transaction_index: 0,
                log_index: 0,
            }],
        })
        .unwrap()
}

/// Every fixture, keyed by a stable name.
pub fn fixtures() -> BTreeMap<String, Value> {
    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    let mut add = |name: &str, value: Value| {
        out.insert(name.to_owned(), value);
    };

    add("status", status().to_value());
    add(
        "derivationStalled",
        DerivationDto::Stalled {
            cause: StallCause::L1Rpc,
            l1_block_number: 0x9a,
            since_unix_ms: 0x18b_0000_0001,
        }
        .to_value(),
    );
    add(
        "derivationHalted",
        DerivationDto::Halted {
            cause: HaltCause::L1Input,
            l1_block_number: 0x9a,
            since_unix_ms: 0x18b_0000_0002,
        }
        .to_value(),
    );
    add("payoutPage", payout_page().to_value());
    add("issuanceQuote", issuance_quote(24).to_value());
    add("blockEconomicsPage", block_economics_page().to_value());
    add("outputSystem", system_output().to_value());
    add(
        "witnessSnapshot",
        serde_json::to_value(witness_snapshot()).unwrap(),
    );
    add("block", block().to_value());
    add("blockId", block_id().to_value());
    add("boundary", boundary().to_value());
    add("outputPath", output_path().to_value());
    add("outputPaths", output_paths().to_value());
    add("account", account().to_value());
    add(
        "accountMaterialNotPresent",
        ReceiveMaterialDto::NotPresent.to_value(),
    );
    add(
        "accountMaterialUnavailable",
        ReceiveMaterialDto::Unavailable {
            lifecycle: "rotating".into(),
        }
        .to_value(),
    );
    add("accountProofPresent", account_proof_present().to_value());
    add("accountProofNotFound", account_proof_not_found().to_value());
    add("contractContract", contract_result().to_value());
    add("contractNotContract", contract_not_contract().to_value());
    add("contractNotFound", contract_not_found().to_value());
    add("contractUnavailable", contract_unavailable().to_value());
    add("blockHeader", block_header().to_value());
    add("l1OriginProof", l1_origin_proof().to_value());
    add("l1LogProof", l1_log_proof().to_value());
    add("historyProof", history_proof().to_value());
    add("nullifierProofs", nullifier_proofs().to_value());
    add("receipt", receipt().to_value());
    add("inclusionId", inclusion().to_value());
    add("feeEstimate", fee_estimate().to_value());
    add("mempoolTransaction", mempool_tx().to_value());
    add("mempoolPage", mempool_page().to_value());
    add("preparedRelay", prepared_relay().to_value());
    add("transactionCheck", transaction_check().to_value());
    add(
        "transactionCheckNotAdmitted",
        transaction_check_not_admitted().to_value(),
    );
    add("blockPayouts", block_payouts().to_value());
    add("l1DeliveryBatchPage", l1_delivery_batch_page().to_value());
    add("outputPage", output_page().to_value());
    add("outputFrontier", output_frontier().to_value());
    add("accountChangePage", account_change_page().to_value());
    add("catalogRecord", catalog_record().to_value());
    add("catalogPage", catalog_page().to_value());
    add(
        "catalogInfoAvailable",
        catalog_info(CatalogStatus::Available).to_value(),
    );
    add(
        "catalogInfoDisabled",
        catalog_info(CatalogStatus::Disabled).to_value(),
    );
    add("peer", peer().to_value());
    add(
        "peerUnidentified",
        PeerInfoDto {
            direction: PeerDirectionDto::Inbound,
            compatible: false,
            incompatible_reason: Some("fork prefix mismatch".into()),
            capability: None,
            agent_version: None,
            protocol_version: None,
            rtt_millis: None,
            score: -40,
            banned_seconds: Some(0x258),
            divergence: None,
            ..peer()
        }
        .to_value(),
    );
    add(
        "nodeInfo",
        StubAdmin.node_info().expect("stub node info").to_value(),
    );
    add(
        "addPeerResult",
        AddPeerResultDto {
            peer_id: "12D3KooWPeerA".into(),
        }
        .to_value(),
    );
    add(
        "removePeerResult",
        RemovePeerResultDto {
            removed: true,
            banned: true,
        }
        .to_value(),
    );

    out
}

// ---------------------------------------------------------------------------
// A `NodeApi` stub, so a test can drive the real server without real state.
// ---------------------------------------------------------------------------

/// A node that answers every read from the fixtures above.
///
/// `populated` selects between the two useful shapes: `false` answers every
/// read with its "absent" variant, which is enough to exercise the transport
/// and the error paths; `true` answers with the exact fixture, so a client test
/// can assert it decoded back to the very value the server encoded.
pub struct StubNode {
    pub populated: bool,
    pub catalog_enabled: bool,
    pub state_failure: bool,
    /// Report the mempool page as the last one, by clearing its cursor.
    pub final_mempool_page: bool,
    /// Answer `pcash_getMempool` with a relayable entry instead of a queued one.
    pub ready_mempool: bool,
}

impl StubNode {
    /// Every read reports absence. Catalog and source verification are off.
    pub fn absent() -> Self {
        Self {
            populated: false,
            catalog_enabled: false,
            state_failure: false,
            final_mempool_page: false,
            ready_mempool: false,
        }
    }

    /// Every read answers with its fixture, and both optional services are on.
    pub fn populated() -> Self {
        Self {
            populated: true,
            catalog_enabled: true,
            state_failure: false,
            final_mempool_page: false,
            ready_mempool: false,
        }
    }

    pub fn with_catalog(mut self, enabled: bool) -> Self {
        self.catalog_enabled = enabled;
        self
    }

    pub fn with_state_failure(mut self) -> Self {
        self.state_failure = true;
        self
    }

    /// Answer `pcash_getMempool` with no continuation cursor.
    pub fn with_final_mempool_page(mut self) -> Self {
        self.final_mempool_page = true;
        self
    }

    fn some<T>(&self, value: T) -> Option<T> {
        self.populated.then_some(value)
    }

    fn mempool<T>(&self, value: T) -> Result<T, MempoolApiError> {
        if self.populated {
            Ok(value)
        } else {
            Err(MempoolApiError::Unavailable)
        }
    }

    fn catalog<T>(&self, value: T) -> Result<T, CatalogApiError> {
        if self.catalog_enabled {
            Ok(value)
        } else {
            Err(CatalogApiError::Unavailable)
        }
    }
}

#[async_trait::async_trait]
impl NodeApi for StubNode {
    fn get_payouts(
        &self,
        _query: crate::request::PayoutQuery,
    ) -> Result<crate::dto::PayoutPageDto, IndexReadError> {
        if self.populated {
            Ok(payout_page())
        } else {
            Err(IndexReadError::Unavailable(
                "canonical genesis is not committed".into(),
            ))
        }
    }
    fn get_block_economics(
        &self,
        _query: crate::request::BlockEconomicsQuery,
    ) -> Result<crate::dto::BlockEconomicsPageDto, IndexReadError> {
        if self.populated {
            Ok(block_economics_page())
        } else {
            Err(IndexReadError::Unavailable("catchingUp".into()))
        }
    }

    fn get_issuance_quote(
        &self,
        candidate_timestamp: u64,
    ) -> Result<Option<crate::dto::IssuanceQuoteDto>, crate::IssuanceQuoteError> {
        Ok(self.some(issuance_quote(candidate_timestamp)))
    }

    fn status(&self) -> Result<StatusDto, StateError> {
        Ok(status())
    }

    fn get_witness_snapshot(
        &self,
        query: crate::request::WitnessSnapshotQuery,
    ) -> Result<crate::dto::WitnessSnapshotDto, IndexReadError> {
        if self.state_failure {
            return Err(IndexReadError::Unavailable("state unavailable".into()));
        }
        Ok(crate::dto::WitnessSnapshotDto {
            status: self.status()?,
            block_header: self.get_block_header(BlockTag::Latest).unwrap(),
            block: self.get_block(0, false).unwrap().map(|block| {
                crate::dto::WitnessSnapshotBlockDto {
                    number: block.number,
                    hash: block.hash,
                    l1_origin: block.l1_origin,
                }
            }),
            accounts: query
                .accounts
                .into_iter()
                .map(|a| self.get_account_proof(a).unwrap())
                .collect(),
            contracts: query
                .contracts
                .into_iter()
                .map(|a| self.get_contract(a).unwrap())
                .collect(),
            outputs: if query.outputs.is_empty() {
                None
            } else {
                self.get_output_paths(&query.outputs).unwrap()
            },
            nullifiers: if query.nullifiers.is_empty() {
                None
            } else {
                self.get_nullifier_proofs(&query.nullifiers).unwrap()
            },
            l1_logs: query
                .l1_logs
                .into_iter()
                .map(|q| {
                    self.get_l1_log_proof(
                        B256::ZERO,
                        q.l1_block_number,
                        q.transaction_index,
                        q.log_index,
                    )
                    .unwrap()
                })
                .collect(),
        })
    }

    fn get_output_path(&self, _leaf_index: u64) -> Result<Option<OutputPathDto>, StateError> {
        if self.state_failure {
            return Err(StateError::Backend("injected state read failure".into()));
        }
        Ok(self.some(output_path()))
    }

    fn get_output_paths(
        &self,
        _leaf_indices: &[u64],
    ) -> Result<Option<OutputPathsDto>, StateError> {
        if self.state_failure {
            return Err(StateError::Backend("injected state read failure".into()));
        }
        Ok(self.some(output_paths()))
    }

    fn get_account_proof(&self, address: Address) -> Result<AccountProofResultDto, StateError> {
        Ok(if self.populated {
            account_proof_present()
        } else {
            AccountProofResultDto::not_found(address)
        })
    }

    fn get_account(&self, _addr: Address) -> Result<Option<AccountDto>, StateError> {
        Ok(self.some(account()))
    }

    fn get_contract(&self, address: Address) -> Result<ContractResultDto, StateError> {
        Ok(if self.populated {
            contract_result()
        } else {
            ContractResultDto::not_found(address)
        })
    }

    fn get_block_header(&self, _tag: BlockTag) -> Result<Option<BlockHeaderDto>, StateError> {
        Ok(self.some(block_header()))
    }

    fn get_l1_origin_proof(
        &self,
        _block_hash: B256,
        _l1_block_number: u64,
    ) -> Result<Option<L1OriginProofDto>, StateError> {
        Ok(self.some(l1_origin_proof()))
    }

    fn get_l1_log_proof(
        &self,
        _block_hash: B256,
        _l1_block_number: u64,
        _transaction_index: u64,
        _log_index: u64,
    ) -> Result<Option<L1LogProofDto>, IndexReadError> {
        if self.state_failure {
            return Err(IndexReadError::Unavailable(
                "injected index read failure".into(),
            ));
        }
        Ok(self.some(l1_log_proof()))
    }

    fn get_result_proof(
        &self,
        _hash: B256,
        _number: u64,
        _position: crate::dto::ResultPosition,
    ) -> Result<Option<crate::dto::ResultProofDto>, StateError> {
        Ok(None)
    }

    fn get_history_proof(
        &self,
        _block_hash: B256,
        _historical_block_number: u64,
    ) -> Result<Option<HistoryProofDto>, StateError> {
        Ok(self.some(history_proof()))
    }

    fn get_block(
        &self,
        _number: u64,
        _full_transactions: bool,
    ) -> Result<Option<BlockDto>, StateError> {
        if self.state_failure {
            return Err(StateError::Backend("injected state read failure".into()));
        }
        Ok(self.some(block()))
    }

    fn get_block_by_hash(
        &self,
        _hash: B256,
        _full_transactions: bool,
    ) -> Result<Option<BlockDto>, StateError> {
        Ok(self.some(block()))
    }

    fn get_blocks(
        &self,
        _from: u64,
        _to: u64,
        _full_transactions: bool,
    ) -> Result<Vec<BlockDto>, StateError> {
        Ok(if self.populated {
            vec![block()]
        } else {
            Vec::new()
        })
    }

    fn are_nullifiers_spent(&self, nullifiers: &[B256]) -> Result<Vec<bool>, StateError> {
        // Alternating, so a client cannot pass by returning a constant.
        Ok((0..nullifiers.len()).map(|index| index % 2 == 0).collect())
    }

    fn get_nullifier_proofs(
        &self,
        _nullifiers: &[B256],
    ) -> Result<Option<NullifierProofsDto>, StateError> {
        Ok(self.some(nullifier_proofs()))
    }

    fn get_output_frontier(&self, block: BlockId) -> Result<OutputFrontierDto, IndexReadError> {
        if self.populated {
            Ok(OutputFrontierDto {
                block,
                ..output_frontier()
            })
        } else {
            Err(IndexReadError::Unavailable("test stub".into()))
        }
    }

    fn get_account_changes(
        &self,
        _request: AccountChangesRequest,
    ) -> Result<AccountChangePageDto, IndexReadError> {
        if self.populated {
            Ok(account_change_page())
        } else {
            Err(IndexReadError::Unavailable("test stub".into()))
        }
    }

    // ---- derived-index reads ----
    fn get_outputs(&self, _request: OutputRequest) -> Result<OutputPageDto, IndexReadError> {
        if self.populated {
            Ok(output_page())
        } else {
            Err(IndexReadError::Unavailable("test stub".into()))
        }
    }

    fn get_receipt(&self, _query: ReceiptQuery) -> Result<Vec<ReceiptDto>, IndexReadError> {
        Ok(if self.populated {
            vec![receipt()]
        } else {
            Vec::new()
        })
    }

    fn get_transactions(
        &self,
        _query: TransactionsQuery,
    ) -> Result<TransactionPageDto, IndexReadError> {
        Ok(TransactionPageDto {
            items: Vec::new(),
            next_cursor: None,
            head: block_id(),
        })
    }

    fn get_transaction(&self, _tx_id: B256) -> Result<Option<TransactionDto>, IndexReadError> {
        Ok(None)
    }

    fn get_submission(
        &self,
        _query: SubmissionQuery,
    ) -> Result<TransactionPageDto, IndexReadError> {
        self.get_transactions(TransactionsQuery::default())
    }

    fn get_account_history(
        &self,
        _query: AccountHistoryQuery,
    ) -> Result<TransactionPageDto, IndexReadError> {
        self.get_transactions(TransactionsQuery::default())
    }

    fn get_transaction_by_nullifier(
        &self,
        _nullifier: B256,
    ) -> Result<Option<TransactionDto>, IndexReadError> {
        Ok(None)
    }

    fn get_l1_delivery_batches(
        &self,
        request: L1DeliveryBatchesRequest,
    ) -> Result<L1DeliveryBatchPageDto, IndexReadError> {
        Ok(if self.populated {
            l1_delivery_batch_page()
        } else {
            L1DeliveryBatchPageDto {
                l1_transaction_hash: request.l1_transaction_hash,
                batches: Vec::new(),
                continuation: None,
                complete: true,
            }
        })
    }

    fn get_block_payouts(&self, block: BlockId) -> Result<Option<BlockPayoutsDto>, IndexReadError> {
        Ok(self.some(BlockPayoutsDto {
            block,
            ..block_payouts()
        }))
    }

    fn estimate_fee(&self, byte_size: u64) -> Result<FeeEstimateDto, IndexReadError> {
        Ok(FeeEstimateDto {
            byte_size,
            ..fee_estimate()
        })
    }

    fn get_contracts(&self, _query: ContractsQuery) -> Result<ContractPageDto, IndexReadError> {
        Ok(ContractPageDto {
            items: Vec::new(),
            next_cursor: None,
            head: block_id(),
        })
    }

    // ---- mempool admission and relay preparation ----
    async fn submit_raw_transaction(
        &self,
        _raw: Vec<u8>,
    ) -> Result<MempoolTransactionDto, MempoolApiError> {
        self.mempool(mempool_tx())
    }

    async fn check_raw_transaction(
        &self,
        _request: CheckRawTransactionRequest,
    ) -> Result<TransactionCheckDto, MempoolApiError> {
        self.mempool(transaction_check())
    }

    fn get_mempool(&self, _filter: MempoolFilter) -> Result<MempoolPageDto, MempoolApiError> {
        let mut page = mempool_page();
        if self.ready_mempool {
            page.items = vec![mempool_tx_ready()];
        }
        if self.final_mempool_page {
            page.next_cursor = None;
        }
        self.mempool(page)
    }

    fn get_mempool_transaction(
        &self,
        _content_hash: &B256,
    ) -> Result<Option<MempoolTransactionDto>, MempoolApiError> {
        self.mempool(self.some(mempool_tx()))
    }

    fn prepare_relay(
        &self,
        _request: PrepareRelayRequest,
    ) -> Result<PreparedRelayDto, MempoolApiError> {
        self.mempool(prepared_relay())
    }

    // ---- optional publication catalog ----
    fn catalog_info(&self) -> CatalogInfo {
        catalog_info(if self.catalog_enabled {
            CatalogStatus::Available
        } else {
            CatalogStatus::Disabled
        })
    }

    fn catalog_get(
        &self,
        request: CatalogGetRequest,
    ) -> Result<Option<CatalogRecord>, CatalogApiError> {
        let found = stored_catalog_records()
            .into_iter()
            .find(|record| record.artifact.content_id == request.content_id);
        self.catalog(found)
    }

    fn catalog_list(&self, _request: CatalogListRequest) -> Result<CatalogPage, CatalogApiError> {
        self.catalog(if self.populated {
            catalog_page()
        } else {
            CatalogPage {
                items: Vec::new(),
                next_cursor: None,
            }
        })
    }

    fn catalog_publish(&self, artifact: CatalogArtifact) -> Result<CatalogRecord, CatalogApiError> {
        if !self.catalog_enabled {
            return Err(CatalogApiError::Unavailable);
        }
        // The absent stub advertises a tiny ceiling so the exhaustion path is
        // reachable without publishing anything large.
        if !self.populated && artifact.payload.len() > 8 {
            return Err(CatalogApiError::Exhausted("catalog is full".to_owned()));
        }
        Ok(CatalogRecord {
            artifact,
            created_at: CREATED_AT,
        })
    }
}

/// Bind the stub on an ephemeral port. The handle must outlive the test.
pub async fn serve_stub(node: StubNode) -> (SocketAddr, jsonrpsee::server::ServerHandle) {
    let api: Arc<dyn NodeApi> = Arc::new(node);
    serve("127.0.0.1:0".parse().expect("loopback address"), api)
        .await
        .expect("serve binds")
}

/// This node's advertised fork capability.
pub fn fork_capability() -> ForkCapabilityDto {
    ForkCapabilityDto {
        chain_id: 0xabcd,
        genesis_hash: h(30),
        head_timestamp: 0x6512_1111,
        current_fork_count: 2,
        current_prefix_hash: h(32),
        next_activation_timestamp: 0x6512_2222,
        next_prefix_hash: h(33),
    }
}

/// One connected peer, with every optional field populated so a caller that
/// renders or decodes the shape sees all of it.
pub fn peer() -> PeerInfoDto {
    PeerInfoDto {
        peer_id: "12D3KooWPeerA".into(),
        remote_address: "/ip4/127.0.0.1/tcp/8646".into(),
        direction: PeerDirectionDto::Outbound,
        connected_seconds: 0x2a,
        connections: 1,
        compatible: true,
        incompatible_reason: None,
        capability: Some(fork_capability()),
        agent_version: Some("pcash-node/0.0.0".into()),
        protocol_version: Some("/pcash/mempool/1".into()),
        rtt_millis: Some(7),
        payload_bytes_sent: 0x1234,
        payload_bytes_received: 0x5678,
        tx_received: 9,
        tx_accepted: 8,
        tx_rejected: 1,
        score: 8,
        banned_seconds: None,
        divergence: Some(BlockHashDivergenceDto {
            l1_block_number: 0x0123_4567,
            l1_block_hash: h(34),
            local_block_hash: h(35),
            peer_block_hash: h(36),
        }),
    }
}

/// A stub admin backend. Peer mutation and publication record nothing; these
/// methods exist so the CLI's admin subcommands can be exercised against a real
/// server.
#[derive(Clone, Default)]
pub struct StubAdmin;

#[async_trait::async_trait]
impl AdminApi for StubAdmin {
    async fn add_peer(&self, address: String) -> Result<AddPeerResultDto, AdminApiError> {
        let peer_id = address
            .rsplit_once("/p2p/")
            .map(|(_, peer)| peer.to_owned())
            .ok_or_else(|| {
                AdminApiError::InvalidAddress(format!(
                    "address must end in /p2p/<peer-id>: {address}"
                ))
            })?;
        Ok(AddPeerResultDto { peer_id })
    }

    async fn remove_peer(
        &self,
        _peer_id: String,
        ban: bool,
    ) -> Result<RemovePeerResultDto, AdminApiError> {
        Ok(RemovePeerResultDto {
            removed: true,
            banned: ban,
        })
    }

    fn peers(&self) -> Result<Vec<PeerInfoDto>, AdminApiError> {
        Ok(vec![peer()])
    }

    fn node_info(&self) -> Result<NodeInfoDto, AdminApiError> {
        Ok(NodeInfoDto {
            peer_id: "12D3KooWSelf".into(),
            listen_addresses: vec!["/ip4/127.0.0.1/tcp/8646".into()],
            bootstrap_addresses: vec![],
            network: crate::P2pNetworkDto {
                discovery_mode: "client".into(),
                reachability: "unknown".into(),
                target_peers: 16,
                ..Default::default()
            },
            topic: "pcash/v1/43981/txs".into(),
            peer_count: 1,
        })
    }

    fn publish_source_verification(
        &self,
        _publication: serde_json::Value,
    ) -> Result<serde_json::Value, AdminApiError> {
        Ok(serde_json::json!({
            "version": 1,
            "status": "ready",
            "writable": true,
        }))
    }
}

pub async fn serve_stub_admin() -> (SocketAddr, jsonrpsee::server::ServerHandle) {
    let api: Arc<dyn AdminApi> = Arc::new(StubAdmin);
    crate::serve_admin("127.0.0.1:0".parse().expect("loopback address"), api)
        .await
        .expect("admin serve binds")
}

pub fn payout_output() -> crate::PayoutOutputDto {
    crate::PayoutOutputDto {
        transaction_id: Some(h(41)),
        payout: designated_payout(),
    }
}

pub fn designated_payout() -> crate::PayoutRecordDto {
    crate::PayoutRecordDto {
        source: pcash_state::PayoutSource::DesignatedIssuance {
            l1_transaction_index: 2,
            batch_item_index: 3,
        },
        component: pcash_state::PayoutComponent::Issuance,
        amount: U256::from(100),
        owner_commitment: h(42),
        output_index: 0x31,
        contexts: vec![h(43)],
    }
}

/// A fee-only poster payout.
pub fn poster_payout() -> crate::PayoutRecordDto {
    crate::PayoutRecordDto {
        source: pcash_state::PayoutSource::PosterPayout {
            l1_transaction_indices: vec![2, 4],
        },
        component: pcash_state::PayoutComponent::OpenFee,
        amount: U256::from(7),
        owner_commitment: h(45),
        output_index: 0x33,
        contexts: vec![h(46), h(47)],
    }
}

pub fn poster_issuance_payout() -> crate::PayoutRecordDto {
    crate::PayoutRecordDto {
        component: pcash_state::PayoutComponent::Issuance,
        amount: U256::from(200),
        output_index: 0x34,
        ..poster_payout()
    }
}

/// A first page of one Ethereum transaction's carriers: its Inbox carrier, a
/// carrier event, and a carrier event whose data did not decode, with more to
/// follow.
pub fn l1_delivery_batch_page() -> L1DeliveryBatchPageDto {
    L1DeliveryBatchPageDto {
        l1_transaction_hash: h(44),
        batches: l1_delivery_batches(),
        continuation: Some(L1DeliveryBatchContinuationDto {
            block: block_id(),
            next_batch: 3,
        }),
        complete: false,
    }
}

fn l1_delivery_batches() -> Vec<L1DeliveryBatchDto> {
    let inbox = L1DeliveryBatchDto {
        l1_block_number: 0x4444,
        l1_block_hash: h(43),
        l1_transaction_index: 2,
        l1_transaction_hash: h(44),
        l1_sender: addr(6),
        carrier_type: CarrierTypeDto::Blob,
        log_index: None,
        emitter: None,
        context: None,
        carrier_hash: h(45),
        carrier_length: 0x1f_0000,
        blob_versioned_hashes: vec![h(46)],
        poster_owner_commitment: Some(h(47)),
        poster_context: Some(h(48)),
        exclusion_reason: None,
        items: vec![
            pcash_state::L1DeliveryItem {
                batch_item_index: 0,
                content_hash: h(49),
                byte_offset: 71,
                byte_length: 0x7b9f,
                exclusion_reason: None,
            },
            pcash_state::L1DeliveryItem {
                batch_item_index: 1,
                content_hash: h(50),
                byte_offset: 0x7c0a,
                byte_length: 1,
                exclusion_reason: Some(pcash_state::ItemExclusionReason::DirectModeOutsideInbox),
            },
        ],
    };
    let event = L1DeliveryBatchDto {
        carrier_type: CarrierTypeDto::Event,
        log_index: Some(3),
        emitter: Some(addr(7)),
        context: Some(Bytes::from_static(&[0xc0, 0x17, 0xe0])),
        carrier_hash: h(51),
        carrier_length: 0x7c40,
        blob_versioned_hashes: Vec::new(),
        poster_owner_commitment: Some(h(52)),
        poster_context: Some(h(53)),
        items: vec![pcash_state::L1DeliveryItem {
            batch_item_index: 2,
            content_hash: h(54),
            byte_offset: 71,
            byte_length: 0x7b9f,
            exclusion_reason: None,
        }],
        ..inbox.clone()
    };
    let malformed = L1DeliveryBatchDto {
        log_index: Some(4),
        context: None,
        carrier_hash: h(55),
        carrier_length: 0x41,
        poster_owner_commitment: None,
        poster_context: None,
        exclusion_reason: Some(pcash_state::BatchExclusionReason::InvalidCarrierEncoding),
        items: Vec::new(),
        ..event.clone()
    };
    vec![inbox, event, malformed]
}

pub fn block_payouts() -> BlockPayoutsDto {
    BlockPayoutsDto {
        block: block_id(),
        open_fees_total: U256::from(7),
        issuance_total: U256::from(300),
        payouts: vec![
            designated_payout(),
            poster_payout(),
            poster_issuance_payout(),
        ],
    }
}

pub fn payout_page() -> crate::PayoutPageDto {
    crate::PayoutPageDto {
        at_block_number: block_id().block_number,
        at_block_hash: block_id().block_hash,
        records: vec![
            crate::PayoutScanRecordDto {
                block_number: block_id().block_number,
                block_hash: block_id().block_hash,
                payout: payout_output(),
            },
            crate::PayoutScanRecordDto {
                block_number: block_id().block_number,
                block_hash: block_id().block_hash,
                payout: crate::PayoutOutputDto {
                    transaction_id: None,
                    payout: poster_payout(),
                },
            },
        ],
        next_cursor: Some(crate::PayoutCursorDto {
            anchor: block_id(),
            next_block: block_id().block_number,
            next_payout_index: 2,
        }),
    }
}

pub fn issuance_quote(candidate_timestamp: u64) -> crate::IssuanceQuoteDto {
    crate::IssuanceQuoteDto {
        parent: crate::IssuanceParentDto {
            block_number: block_id().block_number,
            block_hash: block_id().block_hash,
            timestamp: 12,
        },
        candidate_timestamp,
        supply_cap: U256::from(1_000_000_000u64),
        issued_so_far: U256::from(100),
        baseline: U256::from(100),
        internal_offer: U256::from(100),
        block_allowance: U256::from(300),
        max_single_action_reward: U256::from(100),
        multiplier_q: U256::from(1u64) << 128,
        lag_q: I256::try_from(-12i64).unwrap() << 128,
        exhausted: false,
        reward_possible: true,
    }
}

pub fn block_economics_page() -> crate::BlockEconomicsPageDto {
    crate::BlockEconomicsPageDto {
        at_block_number: block_id().block_number,
        at_block_hash: block_id().block_hash,
        records: vec![crate::BlockEconomicsRecordDto {
            first_block: 8,
            last_block: 9,
            first_timestamp: 96,
            last_timestamp: 108,
            blocks: 2,
            qualifying_actions: 3,
            issuance_total: U256::from(300),
            open_fees_total: U256::from(7),
            reward_each: U256::from(100),
            baseline: U256::from(100),
            internal_offer: U256::from(100),
            block_allowance: U256::from(300),
            lag_q: I256::try_from(-24i64).unwrap() << 128,
        }],
        next_block: Some(10),
    }
}

pub fn system_output() -> crate::OutputItemDto {
    crate::OutputItemDto {
        output_index: 0x31,
        output_commitment: h(44),
        origin: output_origin(),
        material: crate::OutputMaterialDto::System {
            payout: payout_output(),
        },
    }
}
