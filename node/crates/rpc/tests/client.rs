#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreadable_literal,
    reason = "tests use direct assertions for fixture setup"
)]
//! End-to-end tests for the typed `pcash_*` client.
//!
//! Every test drives the real `serve()` server over a real socket, backed by a
//! stub that answers with the same fixtures `wire_golden.json` pins. Asserting
//! that a decoded response equals the fixture therefore checks the whole path:
//! the client's parameter encoding, the server's decoding, the server's response
//! encoding, and the client's decoding — against bytes that are frozen
//! independently.

use std::net::SocketAddr;
use std::sync::Arc;

use alloy_primitives::{Bytes, B256, U256};
use jsonrpsee::core::client::ClientT;
use jsonrpsee::server::ServerHandle;
use pcash_rpc::test_support::*;
use pcash_rpc::{
    AccountChangeLimitsQuery, AccountChangesQuery, AdminClient, AdminRpcClient, BlockRangeQuery,
    BlockTag, CarrierContextQuery, CatalogGetQuery, CatalogListQuery, CatalogStatus,
    CheckRawTransactionQuery, ContractsQuery, FeeBearingKind, FeeEstimateQuery,
    L1DeliveryBatchLimitsQuery, L1DeliveryBatchesQuery, MempoolQuery, OutputQuery, PcashApiClient,
    PcashClient, PcashClientError, PrepareRelayQuery, ReceiptQuery, TransactionKind,
    TransactionsQuery, MARKETPLACE_NAMESPACE,
};

/// A populated node plus a client pointed at it. The handle must stay alive.
async fn connected() -> (PcashClient, ServerHandle) {
    let (addr, handle) = serve_stub(StubNode::populated()).await;
    (client_for(addr), handle)
}

fn client_for(addr: SocketAddr) -> PcashClient {
    PcashClient::new(&format!("http://{addr}")).expect("client builds")
}

/// A canonical nonzero BN254 element, which the nullifier decoders require.
fn canonical() -> B256 {
    let mut bytes = [0u8; 32];
    bytes[31] = 7;
    B256::from(bytes)
}

#[tokio::test]
async fn every_read_decodes_back_to_the_value_the_node_encoded() {
    let (client, _handle) = connected().await;
    assert_eq!(
        client
            .get_payouts(pcash_rpc::PayoutQuery::default())
            .await
            .unwrap()
            .to_value(),
        payout_page().to_value()
    );
    assert_eq!(
        client
            .get_block_economics(pcash_rpc::BlockEconomicsQuery::default())
            .await
            .unwrap()
            .to_value(),
        block_economics_page().to_value()
    );
    assert_eq!(
        client
            .get_block_payouts(block_id())
            .await
            .unwrap()
            .unwrap()
            .to_value(),
        block_payouts().to_value()
    );
    assert_eq!(
        client
            .get_l1_delivery_batches(pcash_rpc::L1DeliveryBatchesQuery {
                l1_transaction_hash: B256::repeat_byte(0x2c),
                continuation: None,
                limits: None,
            })
            .await
            .unwrap()
            .to_value(),
        l1_delivery_batch_page().to_value()
    );
    assert_eq!(
        client
            .get_issuance_quote(pcash_rpc::IssuanceQuoteQuery {
                candidate_timestamp: 24
            })
            .await
            .unwrap()
            .unwrap()
            .to_value(),
        issuance_quote(24).to_value()
    );

    assert_eq!(
        client.status().await.unwrap().to_value(),
        status().to_value()
    );

    assert_eq!(
        client
            .estimate_fee(FeeEstimateQuery {
                kind: None,
                byte_size: Some(fee_estimate().byte_size),
            })
            .await
            .unwrap()
            .to_value(),
        fee_estimate().to_value()
    );
    assert_eq!(
        client.get_output_path(3).await.unwrap().unwrap().to_value(),
        output_path().to_value()
    );
    assert_eq!(
        client
            .get_output_paths([1, 2])
            .await
            .unwrap()
            .unwrap()
            .to_value(),
        output_paths().to_value()
    );

    assert_eq!(
        client.get_account_proof(addr(2)).await.unwrap().to_value(),
        account_proof_present().to_value()
    );
    assert_eq!(
        client
            .get_account(addr(2))
            .await
            .unwrap()
            .unwrap()
            .to_value(),
        account().to_value()
    );
    assert_eq!(
        client.get_contract(addr(3)).await.unwrap().to_value(),
        contract_result().to_value()
    );
    for tag in [
        BlockTag::Latest,
        BlockTag::Number(3),
        BlockTag::Hash(canonical()),
    ] {
        assert_eq!(
            client.get_block_header(tag).await.unwrap().to_value(),
            block_header().to_value()
        );
    }
    assert_eq!(
        client
            .get_l1_origin_proof(canonical(), 0x11_2233)
            .await
            .unwrap()
            .to_value(),
        l1_origin_proof().to_value()
    );
    assert_eq!(
        client
            .get_history_proof(canonical(), 0x19)
            .await
            .unwrap()
            .to_value(),
        history_proof().to_value()
    );
    assert_eq!(
        client
            .get_block_by_number(0x66, false)
            .await
            .unwrap()
            .unwrap()
            .to_value(),
        block().to_value()
    );
    assert_eq!(
        client
            .get_block_by_hash(canonical(), false)
            .await
            .unwrap()
            .unwrap()
            .to_value(),
        block().to_value()
    );
    assert!(client
        .get_transactions(TransactionsQuery::default())
        .await
        .unwrap()
        .items
        .is_empty());
    assert!(client.get_transaction(canonical()).await.unwrap().is_none());
    assert!(client
        .get_contracts(ContractsQuery::default())
        .await
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        client
            .get_nullifier_proofs(vec![canonical()])
            .await
            .unwrap()
            .to_value(),
        nullifier_proofs().to_value()
    );
    assert_eq!(
        client
            .get_outputs(output_commitment_query())
            .await
            .unwrap()
            .to_value(),
        output_page().to_value()
    );
    assert_eq!(
        client
            .get_output_frontier(block_id())
            .await
            .unwrap()
            .to_value(),
        output_frontier().to_value()
    );
    assert_eq!(
        client
            .get_account_changes(account_changes_query(None))
            .await
            .unwrap()
            .to_value(),
        account_change_page().to_value()
    );
    assert_eq!(
        client
            .get_mempool(MempoolQuery::default())
            .await
            .unwrap()
            .to_value(),
        mempool_page().to_value()
    );
    assert_eq!(
        client
            .get_mempool_transaction(canonical())
            .await
            .unwrap()
            .unwrap()
            .to_value(),
        mempool_tx().to_value()
    );
}

#[tokio::test]
async fn list_and_range_reads_decode() {
    let (client, _handle) = connected().await;

    assert_eq!(
        client
            .get_blocks(BlockRangeQuery {
                from_block: Some(0),
                to_block: Some(0x66),
                full_transactions: false,
            })
            .await
            .unwrap()
            .to_value(),
        vec![block()].to_value()
    );
    // An empty range object is a legal request; it means "genesis to tip".
    assert_eq!(
        client
            .get_blocks(BlockRangeQuery::default())
            .await
            .unwrap()
            .len(),
        1
    );

    // Alternating, so a client that returned a constant would fail here.
    assert_eq!(
        client
            .are_nullifiers_spent(vec![canonical(), canonical(), canonical()])
            .await
            .unwrap(),
        vec![true, false, true]
    );
}

#[tokio::test]
async fn every_receipt_query_form_reaches_its_own_lookup() {
    let (client, _handle) = connected().await;
    let expected = vec![receipt()].to_value();

    for query in [
        ReceiptQuery::tx_id(canonical()),
        ReceiptQuery::content_hash(canonical()),
        ReceiptQuery::nullifier(canonical()),
        ReceiptQuery::inclusion(canonical(), 2, 5),
        ReceiptQuery::account(addr(4), 9),
    ] {
        assert_eq!(
            client.get_receipt(query).await.unwrap().to_value(),
            expected,
            "receipt query {query:?} did not reach a lookup"
        );
    }
}

#[tokio::test]
async fn submission_and_relay_round_trip() {
    let (client, _handle) = connected().await;

    assert_eq!(
        client
            .submit_raw_transaction(Bytes::from(vec![1, 2, 3]))
            .await
            .unwrap()
            .to_value(),
        mempool_tx().to_value()
    );
    assert_eq!(
        client
            .prepare_relay(PrepareRelayQuery {
                content_hashes: vec![canonical()],
                controlled_issuance_owner_commitments: vec![canonical()],
                controlled_issuance_content_hashes: vec![canonical()],
                max_batch_bytes: 1024,
            })
            .await
            .unwrap()
            .to_value(),
        prepared_relay().to_value()
    );
}

#[tokio::test]
async fn catalog_reads_and_publish_round_trip() {
    let (client, _handle) = connected().await;

    let info = client.catalog_info().await.unwrap();
    assert_eq!(info.status, CatalogStatus::Available);
    assert_eq!(info.pcash_chain_id, CHAIN_ID);

    assert_eq!(
        client
            .catalog_list(CatalogListQuery {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                cursor: None,
                limit: None,
            })
            .await
            .unwrap()
            .to_value(),
        catalog_page().to_value()
    );

    let known = catalog_record();
    assert_eq!(
        client
            .catalog_get(CatalogGetQuery {
                namespace: MARKETPLACE_NAMESPACE.to_owned(),
                content_id: known.artifact.content_id,
            })
            .await
            .unwrap()
            .unwrap()
            .to_value(),
        known.to_value()
    );
    // A content id the node does not hold is an absence, not an error.
    assert!(client
        .catalog_get(CatalogGetQuery {
            namespace: MARKETPLACE_NAMESPACE.to_owned(),
            content_id: B256::repeat_byte(0x11),
        })
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn publish_derives_the_content_id_from_the_node_chain_id() {
    let (client, _handle) = connected().await;

    let payload = b"published by the client".to_vec();
    let stored = client
        .publish_catalog_artifact(MARKETPLACE_NAMESPACE, payload.clone())
        .await
        .unwrap();

    // The node re-derives the content id and rejects a mismatch, so a stored
    // account proves the client committed to the same preimage the node did.
    assert_eq!(stored.artifact.namespace, MARKETPLACE_NAMESPACE);
    assert_eq!(stored.artifact.pcash_chain_id, CHAIN_ID);
    assert_eq!(&stored.artifact.payload[..], &payload[..]);
    assert_eq!(
        stored.artifact.content_id,
        pcash_rpc::catalog_content_id(MARKETPLACE_NAMESPACE, CHAIN_ID, &payload)
    );
}

#[tokio::test]
async fn publish_refuses_locally_when_the_node_cannot_accept_it() {
    let (addr, _handle) = serve_stub(StubNode::populated().with_catalog(false)).await;
    let client = client_for(addr);

    // A malformed namespace never leaves the process.
    let error = client
        .publish_catalog_artifact("Not A Namespace", b"x".to_vec())
        .await
        .unwrap_err();
    assert!(matches!(error, PcashClientError::Request(_)), "{error}");

    // A disabled catalog is reported as a request problem, not a transport one.
    let error = client
        .publish_catalog_artifact(MARKETPLACE_NAMESPACE, b"x".to_vec())
        .await
        .unwrap_err();
    assert!(matches!(error, PcashClientError::Request(_)), "{error}");
    assert!(error.to_string().contains("disabled"), "{error}");
}

#[tokio::test]
async fn absence_and_storage_failure_stay_distinct() {
    let (absent, _absent_handle) = serve_stub(StubNode::absent()).await;
    let client = client_for(absent);

    // A semantic absence decodes to `None`, not an error.

    assert!(client.get_output_path(0).await.unwrap().is_none());
    assert!(client.get_output_paths([0]).await.unwrap().is_none());
    // A legal uint40 index past the current tree is absence, not an invalid request.
    assert!(client
        .get_output_path((1u64 << 40) - 1)
        .await
        .unwrap()
        .is_none());
    assert!(client
        .get_block_by_number(1, false)
        .await
        .unwrap()
        .is_none());
    assert!(client.get_account(addr(2)).await.unwrap().is_none());

    let (failing, _failing_handle) = serve_stub(StubNode::absent().with_state_failure()).await;
    let client = client_for(failing);
    let error = client.get_output_path(0).await.unwrap_err();
    assert_eq!(error_code(&error), Some(-32003));
    assert_eq!(error_data_kind(&error).as_deref(), Some("storage"));

    let error = client.get_output_paths([0]).await.unwrap_err();
    assert_eq!(error_code(&error), Some(-32003));
    assert_eq!(error_data_kind(&error).as_deref(), Some("storage"));

    let error = client.get_block_by_number(1, false).await.unwrap_err();
    assert_eq!(error_code(&error), Some(-32003));
    assert_eq!(error_data_kind(&error).as_deref(), Some("storage"));

    let error = client
        .get_l1_log_proof(canonical(), 1, 0, 0)
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), Some(-32002));
    assert_eq!(error_data_kind(&error).as_deref(), Some("unavailable"));
}

#[tokio::test]
async fn typed_errors_carry_the_allocated_code_and_kind() {
    let (endpoint, _handle) = serve_stub(StubNode::absent()).await;
    let client = client_for(endpoint);

    // -32020 catalog unavailable, with its structured kind.
    let error = client
        .catalog_list(CatalogListQuery {
            namespace: MARKETPLACE_NAMESPACE.to_owned(),
            cursor: None,
            limit: None,
        })
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), Some(-32020));
    assert_eq!(error_data_kind(&error).as_deref(), Some("unavailable"));

    // -32010 mempool unavailable.
    let error = client
        .get_mempool(MempoolQuery::default())
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), Some(-32010));

    // -32002 index unavailable, from the output-commitment feed.
    let error = client
        .get_outputs(output_commitment_query())
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), Some(-32002));
}

#[tokio::test]
async fn domain_validation_rejects_what_serde_cannot() {
    let (client, _handle) = connected().await;

    // Well-formed 32 bytes, but the zero element is not a legal nullifier.
    let error = client
        .get_nullifier_proofs(vec![B256::ZERO])
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));

    // Output indices are uint40. The populated stub proves the last legal
    // value reaches the handler while 2^40 is rejected during decoding.
    let error = client.get_output_path(1u64 << 40).await.unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));
    let error = client.get_output_paths([1u64 << 40]).await.unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));
    assert!(client
        .get_output_path((1u64 << 40) - 1)
        .await
        .unwrap()
        .is_some());

    // Per-call caps still apply.
    let error = client.get_output_paths(0..65).await.unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));

    let error = client
        .get_nullifier_proofs(vec![canonical(); 257])
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));
}

#[tokio::test]
async fn fee_estimates_resolve_kind_defaults_and_explicit_size_at_the_rpc_boundary() {
    let (client, _handle) = connected().await;
    let explicit = client
        .estimate_fee(FeeEstimateQuery {
            kind: None,
            byte_size: Some(1_000),
        })
        .await
        .unwrap();
    for (kind, size) in [
        (
            FeeBearingKind::PrivateValue,
            pcash_derive::PRIVATE_VALUE_MAX_TX_BYTES,
        ),
        (
            FeeBearingKind::ContractAccount,
            pcash_derive::CONTRACT_MAX_TX_BYTES,
        ),
        (
            FeeBearingKind::UserAccountUpdate,
            pcash_derive::USER_ACCOUNT_UPDATE_MAX_TX_BYTES,
        ),
    ] {
        let default = client
            .estimate_fee(FeeEstimateQuery {
                kind: Some(kind),
                byte_size: None,
            })
            .await
            .unwrap();
        assert_eq!(default.byte_size, size as u64);
        let sized = client
            .estimate_fee(FeeEstimateQuery {
                kind: None,
                byte_size: Some(size as u64),
            })
            .await
            .unwrap();
        assert_eq!(default, sized);
        let overridden = client
            .estimate_fee(FeeEstimateQuery {
                kind: Some(kind),
                byte_size: Some(1_000),
            })
            .await
            .unwrap();
        assert_eq!(explicit, overridden);
    }
}

#[tokio::test]
async fn fee_estimates_reject_missing_sizes_invalid_sizes_and_non_fee_bearing_kinds() {
    let (client, _handle) = connected().await;
    for query in [
        serde_json::json!({}),
        serde_json::json!({ "byteSize": "0x0" }),
        serde_json::json!({ "kind": "privateValue", "byteSize": "0x0" }),
        serde_json::json!({ "byteSize": "0xffffffffffffffff" }),
        serde_json::json!({ "kind": "userAccountCreation" }),
        serde_json::json!({ "kind": "userAccountCreation", "byteSize": "0x100" }),
        serde_json::json!({ "kind": "unknown" }),
        serde_json::json!({ "kind": "notAKind" }),
    ] {
        let result: Result<serde_json::Value, _> = client
            .inner()
            .request("pcash_estimateFee", jsonrpsee::rpc_params![query.clone()])
            .await;
        assert_eq!(error_code(&result.unwrap_err()), Some(-32602), "{query}");
    }
}

#[tokio::test]
async fn output_commitment_limits_are_bounded_by_the_protocol() {
    let (client, _handle) = connected().await;

    let mut query = output_commitment_query();
    query.limits = Some(pcash_rpc::OutputLimitsQuery {
        max_outputs: Some(0),
        ..Default::default()
    });
    let error = client.get_outputs(query).await.unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));

    let mut query = output_commitment_query();
    query.limits = Some(pcash_rpc::OutputLimitsQuery {
        max_outputs: Some(u32::MAX),
        ..Default::default()
    });
    let error = client.get_outputs(query).await.unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));
}

#[tokio::test]
async fn account_change_limits_are_bounded_by_the_protocol() {
    let (client, _handle) = connected().await;

    for limits in [
        AccountChangeLimitsQuery {
            max_changes: Some(0),
            ..Default::default()
        },
        AccountChangeLimitsQuery {
            max_changes: Some(10_001),
            ..Default::default()
        },
        AccountChangeLimitsQuery {
            max_bytes: Some(0),
            ..Default::default()
        },
        AccountChangeLimitsQuery {
            max_bytes: Some(4 * 1024 * 1024 + 1),
            ..Default::default()
        },
    ] {
        let error = client
            .get_account_changes(account_changes_query(Some(limits)))
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), Some(-32602), "{limits:?}");
    }
    assert!(client
        .get_account_changes(account_changes_query(Some(AccountChangeLimitsQuery {
            max_changes: Some(10_000),
            max_bytes: Some(4 * 1024 * 1024),
        })))
        .await
        .is_ok());
}

#[tokio::test]
async fn delivery_batch_requests_are_closed_and_bounded() {
    use serde_json::json;
    let (client, _handle) = connected().await;
    let query = |limits| L1DeliveryBatchesQuery {
        l1_transaction_hash: B256::repeat_byte(0x2c),
        continuation: None,
        limits,
    };
    for limits in [
        L1DeliveryBatchLimitsQuery {
            max_batches: Some(0),
            ..Default::default()
        },
        L1DeliveryBatchLimitsQuery {
            max_batches: Some(10_001),
            ..Default::default()
        },
        L1DeliveryBatchLimitsQuery {
            max_bytes: Some(0),
            ..Default::default()
        },
        L1DeliveryBatchLimitsQuery {
            max_bytes: Some(4 * 1024 * 1024 + 1),
            ..Default::default()
        },
    ] {
        let error = client
            .get_l1_delivery_batches(query(Some(limits)))
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), Some(-32602), "{limits:?}");
    }
    assert!(client
        .get_l1_delivery_batches(query(Some(L1DeliveryBatchLimitsQuery {
            max_batches: Some(10_000),
            max_bytes: Some(4 * 1024 * 1024),
        })))
        .await
        .is_ok());

    let hash = format!("0x{}", "2c".repeat(32));
    for malformed in [
        json!(hash),
        json!({}),
        json!({ "l1TransactionHash": hash, "extra": true }),
        json!({ "l1TransactionHash": hash, "limits": { "maxItems": "0x1" } }),
        json!({ "l1TransactionHash": hash, "continuation": { "nextBatch": "0x1" } }),
    ] {
        assert_eq!(
            raw_error_code(
                &client,
                "pcash_getL1DeliveryBatches",
                vec![malformed.clone()]
            )
            .await,
            Some(-32602),
            "{malformed}"
        );
    }
}

#[tokio::test]
async fn the_mempool_kind_filter_is_typed() {
    let (client, _handle) = connected().await;

    // A named kind is accepted...
    assert!(client
        .get_mempool(MempoolQuery {
            kind: Some(TransactionKind::PrivateValue),
            min_open_fee: Some(U256::from(1u64)),
            ..MempoolQuery::default()
        })
        .await
        .is_ok());

    // ...an unrecognized one cannot even be constructed, so the only way to
    // send it is by hand. The server rejects that at the decoder.
    let raw: Result<serde_json::Value, _> = client
        .inner()
        .request(
            "pcash_getMempool",
            jsonrpsee::rpc_params![serde_json::json!({ "kind": "notAKind" })],
        )
        .await;
    assert_eq!(error_code(&raw.unwrap_err()), Some(-32602));

    // `unknown` is a real kind, but only ever on a receipt: the mempool admits
    // nothing it cannot classify. Filtering by it is refused rather than
    // answered with an empty page that looks like "there are none of those".
    let error = client
        .get_mempool(MempoolQuery {
            kind: Some(TransactionKind::Unknown),
            ..MempoolQuery::default()
        })
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));
}

#[tokio::test]
async fn the_mempool_relayer_filter_is_bounded() {
    let (client, _handle) = connected().await;
    let query = |entries: usize| MempoolQuery {
        controlled_issuance_owner_commitments: Some(vec![B256::repeat_byte(7); entries]),
        ..MempoolQuery::default()
    };
    assert!(client
        .get_mempool(query(pcash_rpc::MAX_PREPARE_REQUEST_IDS))
        .await
        .is_ok());
    let error = client
        .get_mempool(query(pcash_rpc::MAX_PREPARE_REQUEST_IDS + 1))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));
}

#[tokio::test]
async fn exact_issuance_control_list_is_bounded() {
    let (client, _handle) = connected().await;
    let query = |count| PrepareRelayQuery {
        content_hashes: vec![canonical()],
        controlled_issuance_owner_commitments: vec![],
        controlled_issuance_content_hashes: vec![canonical(); count],
        max_batch_bytes: 1024,
    };
    assert!(client
        .prepare_relay(query(pcash_rpc::MAX_PREPARE_REQUEST_IDS))
        .await
        .is_ok());
    let error = client
        .prepare_relay(query(pcash_rpc::MAX_PREPARE_REQUEST_IDS + 1))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), Some(-32602));
}

#[tokio::test]
async fn mempool_paging_stops_when_the_cursor_stops_advancing() {
    let (client, _handle) = connected().await;

    // The stub hands back the same non-null cursor on every page, which is what
    // a node does when its local view has not moved. Following it blindly would
    // never return, so `mempool_pages` must stop once the cursor repeats.
    let page = client.get_mempool(MempoolQuery::default()).await.unwrap();
    assert!(
        page.next_cursor.is_some(),
        "the fixture must advertise a cursor for this to test anything"
    );

    let all = client
        .mempool_pages(MempoolQuery::default(), 32)
        .await
        .unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].to_value(), mempool_tx().to_value());
}

#[tokio::test]
async fn mempool_paging_stops_on_an_exhausted_cursor() {
    // A node that reports no further accounts ends the scan on the first page.
    let (endpoint, _handle) = serve_stub(StubNode::populated().with_final_mempool_page()).await;
    let client = client_for(endpoint);

    let all = client
        .mempool_pages(MempoolQuery::default(), 32)
        .await
        .unwrap();
    assert_eq!(all.len(), 1);
}

#[tokio::test]
async fn mempool_paging_stops_at_the_caller_s_page_bound() {
    // The stub repeats one cursor forever, so only `max_pages` ends the scan.
    // A node that alternates between two cursors would defeat the
    // did-not-advance check the same way, which is why the bound exists.
    let (client, _handle) = connected().await;

    let none = client
        .mempool_pages(MempoolQuery::default(), 0)
        .await
        .unwrap();
    assert!(none.is_empty(), "a zero page budget reads nothing");
}

#[tokio::test]
async fn public_and_admin_namespaces_stay_on_their_own_listeners() {
    let public_module = pcash_rpc::server::build_module(Arc::new(StubNode::populated()));
    assert!(public_module
        .method_names()
        .all(|name| name.starts_with("pcash_")));
    let admin_module = pcash_rpc::admin::build_admin_module(Arc::new(StubAdmin));
    assert!(admin_module
        .method_names()
        .all(|name| name.starts_with("admin_")));

    let (public_addr, _public_handle) = serve_stub(StubNode::populated()).await;
    let (admin_addr, _admin_handle) = serve_stub_admin().await;
    let public = client_for(public_addr);
    let admin = AdminClient::new(&format!("http://{admin_addr}")).unwrap();
    assert!(public.status().await.is_ok());
    assert!(admin.node_info().await.is_ok());

    let wrong_public: Result<serde_json::Value, _> = public
        .inner()
        .request("admin_nodeInfo", jsonrpsee::rpc_params![])
        .await;
    assert_eq!(error_code(&wrong_public.unwrap_err()), Some(-32601));
    let wrong_admin: Result<serde_json::Value, _> = admin
        .request("pcash_status", jsonrpsee::rpc_params![])
        .await;
    assert_eq!(error_code(&wrong_admin.unwrap_err()), Some(-32601));
}

fn error_code(error: &jsonrpsee::core::ClientError) -> Option<i32> {
    match error {
        jsonrpsee::core::ClientError::Call(object) => Some(object.code()),
        _ => None,
    }
}

fn error_data_kind(error: &jsonrpsee::core::ClientError) -> Option<String> {
    match error {
        jsonrpsee::core::ClientError::Call(object) => object
            .data()
            .and_then(|data| serde_json::from_str::<serde_json::Value>(data.get()).ok())
            .and_then(|value| value.get("kind")?.as_str().map(str::to_owned)),
        _ => None,
    }
}

/// An account-change request over the fixture boundary.
fn account_changes_query(limits: Option<AccountChangeLimitsQuery>) -> AccountChangesQuery {
    AccountChangesQuery {
        from_block: 0x10,
        target: block_id(),
        continuation: None,
        limits,
    }
}

/// A output-commitment request over the fixture boundary.
fn output_commitment_query() -> OutputQuery {
    OutputQuery {
        from_output_index: 0x20,
        target: block_id(),
        continuation: None,
        limits: None,
    }
}

#[tokio::test]
async fn witness_snapshot_preserves_wire_and_missing_results() {
    let (client, _handle) = connected().await;
    let query = pcash_rpc::WitnessSnapshotQuery {
        accounts: vec![addr(1)],
        contracts: vec![addr(2)],
        outputs: vec![0],
        nullifiers: vec![canonical()],
        l1_logs: vec![pcash_rpc::WitnessL1LogQuery {
            l1_block_number: 1,
            transaction_index: 0,
            log_index: 0,
        }],
    };
    assert_eq!(
        serde_json::to_value(client.get_witness_snapshot(query.clone()).await.unwrap()).unwrap(),
        serde_json::to_value(witness_snapshot()).unwrap()
    );
    let (addr, _handle) = serve_stub(StubNode::absent()).await;
    let missing = client_for(addr).get_witness_snapshot(query).await.unwrap();
    assert!(missing.block_header.is_none());
    assert!(missing.outputs.is_none());
    assert!(missing.l1_logs[0].is_none());
}

#[tokio::test]
async fn witness_snapshot_bounds_work_before_reading_state() {
    let (client, _handle) = connected().await;
    for query in [
        pcash_rpc::WitnessSnapshotQuery {
            accounts: vec![addr(1); 65],
            ..Default::default()
        },
        pcash_rpc::WitnessSnapshotQuery {
            accounts: vec![addr(1); 32],
            contracts: vec![addr(1); 33],
            ..Default::default()
        },
        pcash_rpc::WitnessSnapshotQuery {
            outputs: vec![0; 65],
            ..Default::default()
        },
        pcash_rpc::WitnessSnapshotQuery {
            outputs: vec![1 << 40],
            ..Default::default()
        },
        pcash_rpc::WitnessSnapshotQuery {
            nullifiers: vec![canonical(); 257],
            ..Default::default()
        },
        pcash_rpc::WitnessSnapshotQuery {
            nullifiers: vec![B256::ZERO],
            ..Default::default()
        },
    ] {
        let error = client.get_witness_snapshot(query).await.unwrap_err();
        assert_eq!(error_code(&error), Some(-32602));
    }
}

/// Send one positional-parameter call by hand and return the error code.
async fn raw_error_code(
    client: &PcashClient,
    method: &str,
    params: Vec<serde_json::Value>,
) -> Option<i32> {
    let mut builder = jsonrpsee::core::params::ArrayParams::new();
    for param in params {
        builder.insert(param).unwrap();
    }
    let result: Result<serde_json::Value, _> = client.inner().request(method, builder).await;
    match result {
        Ok(value) => panic!("{method} accepted the request: {value}"),
        Err(error) => error_code(&error),
    }
}

#[tokio::test]
async fn explorer_page_limits_are_bounded_on_every_paged_method() {
    use serde_json::json;
    let (client, _handle) = connected().await;
    let hash = format!("0x{}", "11".repeat(32));
    let address = format!("0x{}", "22".repeat(20));
    let queries = |limit: &str| {
        [
            ("pcash_getTransactions", json!({ "limit": limit })),
            (
                "pcash_getSubmission",
                json!({ "contentHash": hash, "limit": limit }),
            ),
            (
                "pcash_getAccountHistory",
                json!({ "address": address, "limit": limit }),
            ),
            ("pcash_getContracts", json!({ "limit": limit })),
        ]
    };
    // MAX_EXPLORER_PAGE_ITEMS is 100; the limit travels as a hex quantity.
    for limit in ["0x0", "0x65", "0xffffffffffffffff"] {
        for (method, query) in queries(limit) {
            assert_eq!(
                raw_error_code(&client, method, vec![query]).await,
                Some(-32602),
                "{method} limit {limit}"
            );
        }
    }
    // The largest legal page is served by each of them.
    for (method, query) in queries("0x64") {
        let served: Result<serde_json::Value, _> = client
            .inner()
            .request(method, jsonrpsee::rpc_params![query])
            .await;
        served.unwrap_or_else(|error| panic!("{method} refused the maximum page: {error}"));
    }
}

#[tokio::test]
async fn raw_submissions_are_bounded_and_strictly_hex() {
    use serde_json::json;
    let (client, _handle) = connected().await;
    let max = pcash_rpc::MAX_MEMPOOL_TX_BYTES;

    // One byte over the ceiling, with and without the prefix. The length check
    // runs before decoding, so the body need not even be hex.
    let over = "00".repeat(max + 1);
    for submission in [
        format!("0x{over}"),
        over,
        "zz".repeat(max + 1),
        // Far larger than any transaction, yet well inside the 16 MiB request
        // body limit, so this is the decoder's refusal and not the transport's.
        format!("0x{}", "00".repeat(4 * 1024 * 1024)),
    ] {
        let error = client
            .inner()
            .request::<serde_json::Value, _>(
                "pcash_submitRawTransaction",
                jsonrpsee::rpc_params![submission],
            )
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), Some(-32602), "{error}");
        let jsonrpsee::core::ClientError::Call(object) = &error else {
            unreachable!()
        };
        assert!(object.message().contains("exceeds"), "{}", object.message());
    }

    // Exactly at the ceiling passes the bound and reaches the node.
    let at_limit: Result<serde_json::Value, _> = client
        .inner()
        .request(
            "pcash_submitRawTransaction",
            jsonrpsee::rpc_params![format!("0x{}", "00".repeat(max))],
        )
        .await;
    assert_ne!(
        at_limit.as_ref().err().and_then(error_code),
        Some(-32602),
        "{at_limit:?}"
    );

    for malformed in [
        json!("0xabc"),
        json!("abc"),
        json!("0xzz"),
        json!("0x0g"),
        json!("0x 00"),
        json!("0x0x00"),
        json!(1234),
        json!(null),
        json!(["0x00"]),
    ] {
        assert_eq!(
            raw_error_code(
                &client,
                "pcash_submitRawTransaction",
                vec![malformed.clone()]
            )
            .await,
            Some(-32602),
            "{malformed}"
        );
    }
}

#[tokio::test]
async fn transaction_checks_round_trip_with_every_carrier_form() {
    let (client, _handle) = connected().await;
    for carrier in [
        CarrierContextQuery::Inbox { address: addr(5) },
        CarrierContextQuery::Event {
            address: addr(6),
            context: format!("0x{}", "5c".repeat(128)),
        },
        CarrierContextQuery::Event {
            address: addr(6),
            context: "0x".into(),
        },
    ] {
        assert_eq!(
            client
                .check_raw_transaction(CheckRawTransactionQuery {
                    transaction: "0x010203".into(),
                    carrier: carrier.clone(),
                })
                .await
                .unwrap(),
            transaction_check(),
            "{carrier:?}"
        );
    }
}

#[tokio::test]
async fn transaction_check_requests_are_closed_and_bounded() {
    use serde_json::json;
    let (client, _handle) = connected().await;
    let address = format!("0x{}", "22".repeat(20));
    let method = "pcash_checkRawTransaction";
    let check = |request: serde_json::Value| {
        let client = &client;
        async move {
            client
                .inner()
                .request::<serde_json::Value, _>(method, jsonrpsee::rpc_params![request])
                .await
        }
    };

    let inbox = json!({ "kind": "inbox", "address": address });
    for accepted in [
        json!({ "transaction": "0x01", "carrier": inbox }),
        json!({ "transaction": "0x01", "carrier": { "kind": "event", "address": address, "context": "0x" } }),
    ] {
        check(accepted.clone())
            .await
            .unwrap_or_else(|error| panic!("{accepted} was refused: {error}"));
    }

    for malformed in [
        json!("0x01"),
        json!({}),
        json!({ "transaction": "0x01" }),
        json!({ "transaction": "0x01", "carrier": null }),
        json!({ "transaction": "0x01", "carrier": inbox, "extra": true }),
        json!({ "transaction": "0x0", "carrier": inbox }),
        json!({ "transaction": "0x01", "carrier": inbox, "carrierContextHash": "0x00" }),
        json!({ "transaction": "0x01", "carrier": { "address": address } }),
        json!({ "transaction": "0x01", "carrier": { "kind": "blob", "address": address } }),
        json!({ "transaction": "0x01", "carrier": { "kind": "inbox", "address": address, "context": "0x" } }),
        json!({ "transaction": "0x01", "carrier": { "kind": "event", "address": address } }),
        json!({ "transaction": "0x01", "carrier": { "kind": "event", "address": "0x22", "context": "0x" } }),
        json!({ "transaction": "0x01", "carrier": { "kind": "event", "address": address, "context": "0x", "logIndex": "0x0" } }),
    ] {
        assert_eq!(
            raw_error_code(&client, method, vec![malformed.clone()]).await,
            Some(-32602),
            "{malformed}"
        );
    }

    // Each byte string is bounded before it is decoded, so one over its
    // ceiling is refused whether or not it is hex.
    let tx_max = pcash_rpc::MAX_MEMPOOL_TX_BYTES;
    let context_max = pcash_rpc::MAX_CHECK_CONTEXT_BYTES;
    let event = |context: serde_json::Value| json!({ "transaction": "0x01", "carrier": { "kind": "event", "address": address, "context": context } });
    for oversized in [
        json!({ "transaction": format!("0x{}", "00".repeat(tx_max + 1)), "carrier": inbox }),
        json!({ "transaction": "zz".repeat(tx_max + 1), "carrier": inbox }),
        event(json!(format!("0x{}", "00".repeat(context_max + 1)))),
        event(json!("zz".repeat(context_max + 1))),
    ] {
        let error = check(oversized).await.unwrap_err();
        assert_eq!(error_code(&error), Some(-32602), "{error}");
        assert!(error.to_string().contains("exceeds"), "{error}");
    }
    // Byte fields are hex strings only. A byte array, which the bound on
    // strings would not see, is refused at any length. The stub answers every
    // request that reaches it, so an error means no check was queued.
    for array in [
        json!({ "transaction": [1, 2, 3], "carrier": inbox }),
        json!({ "transaction": vec![0u8; tx_max + 1], "carrier": inbox }),
        event(json!([1, 2])),
        event(json!(vec![0u8; context_max + 1])),
    ] {
        assert_eq!(
            raw_error_code(&client, method, vec![array]).await,
            Some(-32602)
        );
    }
    check(json!({ "transaction": format!("0x{}", "00".repeat(tx_max)), "carrier": inbox }))
        .await
        .unwrap();
    check(event(json!(format!("0x{}", "00".repeat(context_max)))))
        .await
        .unwrap();
}

#[tokio::test]
async fn fixed_width_and_quantity_decoders_reject_malformed_input() {
    use serde_json::json;
    let (client, _handle) = connected().await;
    let hex = |bytes: usize| json!(format!("0x{}", "11".repeat(bytes)));

    // 32-byte values: one byte short, one byte long, empty, odd, and non-hex.
    for bad in [
        hex(31),
        hex(33),
        json!("0x"),
        json!(format!("0x{}1", "11".repeat(31))),
        json!(format!("0x{}zz", "11".repeat(31))),
    ] {
        for method in ["pcash_getTransaction", "pcash_getMempoolTransaction"] {
            assert_eq!(
                raw_error_code(&client, method, vec![bad.clone()]).await,
                Some(-32602),
                "{method} {bad}"
            );
        }
        assert_eq!(
            raw_error_code(
                &client,
                "pcash_getBlockByHash",
                vec![bad.clone(), json!(false)]
            )
            .await,
            Some(-32602),
            "pcash_getBlockByHash {bad}"
        );
        // The same value inside a typed query object is refused by serde.
        assert_eq!(
            raw_error_code(
                &client,
                "pcash_getSubmission",
                vec![json!({ "contentHash": bad })]
            )
            .await,
            Some(-32602),
            "pcash_getSubmission {bad}"
        );
    }

    // 20-byte addresses.
    for bad in [
        hex(19),
        hex(21),
        hex(32),
        json!("0x"),
        json!(format!("0x{}zz", "11".repeat(19))),
    ] {
        for method in [
            "pcash_getAccount",
            "pcash_getAccountProof",
            "pcash_getContract",
        ] {
            assert_eq!(
                raw_error_code(&client, method, vec![bad.clone()]).await,
                Some(-32602),
                "{method} {bad}"
            );
        }
        assert_eq!(
            raw_error_code(
                &client,
                "pcash_getAccountHistory",
                vec![json!({ "address": bad })]
            )
            .await,
            Some(-32602),
            "pcash_getAccountHistory {bad}"
        );
    }

    // Quantities: non-hex, empty, signed, and wider than u64.
    for bad in ["0xzz", "latest", "0x", "", "-0x1", "0x10000000000000000"] {
        assert_eq!(
            raw_error_code(
                &client,
                "pcash_getBlockByNumber",
                vec![json!(bad), json!(false)]
            )
            .await,
            Some(-32602),
            "pcash_getBlockByNumber {bad:?}"
        );
    }
    // A JSON number is not a quantity.
    assert_eq!(
        raw_error_code(
            &client,
            "pcash_getBlockByNumber",
            vec![json!(1), json!(false)]
        )
        .await,
        Some(-32602)
    );
}

#[tokio::test]
async fn result_proofs_return_null_for_missing_positions_and_reject_ambiguous_selectors() {
    let (client, _handle) = connected().await;
    assert!(client
        .get_result_proof(
            B256::from(U256::from(1).to_be_bytes::<32>()),
            0,
            pcash_rpc::dto::ResultPosition::PayoutIndex(0)
        )
        .await
        .unwrap()
        .is_none());
    let response: Result<serde_json::Value, _> = client
        .inner()
        .request(
            "pcash_getResultProof",
            jsonrpsee::rpc_params![
                format!("0x{:064x}", 1),
                "0x0",
                serde_json::json!({"payoutIndex":"0x0", "pcashTransactionIndex":"0x0"})
            ],
        )
        .await;
    assert_eq!(error_code(&response.unwrap_err()), Some(-32602));
}
