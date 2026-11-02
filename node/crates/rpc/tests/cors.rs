#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreadable_literal,
    reason = "tests use direct assertions for fixture setup"
)]
//! Browser CORS integration test for the `pcash_*` server.
//!
//! A demo web app served from a Vite dev server on another port calls the node's
//! JSON-RPC from the browser, so `serve()` must answer a cross-origin preflight and
//! stamp `access-control-allow-origin` on responses. This starts a real server on an
//! ephemeral port and exercises both the `OPTIONS` preflight and a plain POST.

use std::net::SocketAddr;

use pcash_rpc::test_support::{serve_stub, StubNode, CHAIN_ID, CREATED_AT};
use pcash_rpc::{catalog_content_id, MARKETPLACE_NAMESPACE};
use reqwest::header::{ACCESS_CONTROL_ALLOW_ORIGIN, ORIGIN};
use reqwest::Method;
use serde_json::{json, Value};

async fn start() -> (SocketAddr, jsonrpsee::server::ServerHandle) {
    serve_stub(StubNode::absent()).await
}

fn closed_during_upload(error: &reqwest::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            return matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
            );
        }
        source = current.source();
    }
    false
}

async fn start_with_catalog(
    catalog_enabled: bool,
) -> (SocketAddr, jsonrpsee::server::ServerHandle) {
    serve_stub(StubNode::absent().with_catalog(catalog_enabled)).await
}

async fn start_with_state_failure() -> (SocketAddr, jsonrpsee::server::ServerHandle) {
    serve_stub(StubNode::absent().with_state_failure()).await
}

#[tokio::test]
async fn canonical_block_absence_and_storage_failure_are_distinct() {
    let (healthy, _healthy_handle) = start().await;
    let absent = rpc(healthy, 1, "pcash_getBlockByNumber", json!(["0x1", false])).await;
    assert_eq!(absent["result"], Value::Null);

    let (failing, _failing_handle) = start_with_state_failure().await;
    let failed = rpc(failing, 2, "pcash_getBlockByNumber", json!(["0x1", false])).await;
    assert_eq!(failed["error"]["code"], -32003);
    assert_eq!(failed["error"]["data"]["kind"], "storage");
    assert_eq!(
        failed["error"]["message"],
        "Backend(\"injected state read failure\")"
    );
}

/// What a publisher sends: no server-assigned fields.
fn catalog_artifact_json(payload: &[u8]) -> Value {
    json!({
        "namespace": MARKETPLACE_NAMESPACE,
        "pcashChainId": format!("0x{CHAIN_ID:x}"),
        "contentId": format!(
            "0x{}",
            hex::encode(catalog_content_id(MARKETPLACE_NAMESPACE, CHAIN_ID, payload))
        ),
        "payload": format!("0x{}", hex::encode(payload)),
    })
}

/// What the node returns: the artifact plus its creation time.
fn catalog_record_json(payload: &[u8]) -> Value {
    let mut record = catalog_artifact_json(payload);
    record["createdAt"] = json!(format!("0x{CREATED_AT:x}"));
    record
}

async fn rpc(addr: SocketAddr, id: u64, method: &str, params: Value) -> Value {
    reqwest::Client::new()
        .post(format!("http://{addr}"))
        .json(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
        .send()
        .await
        .expect("request")
        .json()
        .await
        .expect("JSON-RPC response")
}

#[tokio::test]
async fn catalog_http_contract_returns_flat_records_and_a_stored_record() {
    let (addr, _handle) = start_with_catalog(true).await;

    let info = rpc(addr, 40, "pcash_catalogInfo", json!([])).await;
    assert_eq!(info["result"]["status"], "available");
    assert_eq!(info["result"]["writable"], true);
    assert_eq!(info["result"]["pcashChainId"], format!("0x{CHAIN_ID:x}"));
    assert!(info["result"].get("genesisHash").is_none());
    assert_eq!(info["result"]["namespaces"], json!([MARKETPLACE_NAMESPACE]));

    let listed = rpc(
        addr,
        41,
        "pcash_catalogList",
        json!([{ "namespace": MARKETPLACE_NAMESPACE }]),
    )
    .await;
    assert_eq!(
        listed,
        json!({
            "jsonrpc": "2.0",
            "id": 41,
            "result": { "items": [], "nextCursor": null }
        })
    );

    // Publish echoes the stored record, not a boolean: callers need the content
    // id and the node-assigned creation time.
    let published = rpc(
        addr,
        42,
        "pcash_catalogPublish",
        json!([catalog_artifact_json(b"opaque")]),
    )
    .await;
    assert_eq!(
        published,
        json!({ "jsonrpc": "2.0", "id": 42, "result": catalog_record_json(b"opaque") })
    );

    // Point read of the same content id, and null for one that is absent.
    let content_id = catalog_artifact_json(b"opaque")["contentId"].clone();
    let got = rpc(
        addr,
        43,
        "pcash_catalogGet",
        json!([{ "namespace": MARKETPLACE_NAMESPACE, "contentId": content_id }]),
    )
    .await;
    assert_eq!(got["result"], catalog_record_json(b"opaque"));

    let absent = rpc(
        addr,
        44,
        "pcash_catalogGet",
        json!([{ "namespace": MARKETPLACE_NAMESPACE, "contentId": format!("0x{}", "11".repeat(32)) }]),
    )
    .await;
    assert_eq!(
        absent,
        json!({ "jsonrpc": "2.0", "id": 44, "result": null })
    );
}

#[tokio::test]
async fn catalog_errors_are_structured_with_their_allocated_codes() {
    let (disabled, _disabled_handle) = start().await;
    let (enabled, _enabled_handle) = start_with_catalog(true).await;

    // -32020 unavailable: the operator did not pass --enable-catalog.
    let body = rpc(
        disabled,
        43,
        "pcash_catalogList",
        json!([{ "namespace": MARKETPLACE_NAMESPACE }]),
    )
    .await;
    assert_eq!(
        body,
        json!({
            "jsonrpc": "2.0",
            "id": 43,
            "error": {
                "code": -32020,
                "message": "catalog unavailable",
                "data": { "kind": "unavailable" }
            }
        })
    );

    // Info still answers on a disabled node, so capability detection is stable.
    let info = rpc(disabled, 44, "pcash_catalogInfo", json!([])).await;
    assert_eq!(info["result"]["status"], "disabled");
    assert_eq!(info["result"]["writable"], false);

    // -32021 invalid: framing is rejected before any storage work.
    let mut tampered = catalog_artifact_json(b"opaque");
    // One byte of "opaque" changed; the committed content id no longer matches.
    tampered["payload"] = json!("0x6f7061717566");
    let body = rpc(enabled, 45, "pcash_catalogPublish", json!([tampered])).await;
    assert_eq!(body["error"]["code"], -32021);
    assert_eq!(body["error"]["data"]["kind"], "invalid");

    // -32022 exhausted: well-formed, but the store cannot accept it.
    let body = rpc(
        enabled,
        46,
        "pcash_catalogPublish",
        json!([catalog_artifact_json(b"far too large")]),
    )
    .await;
    assert_eq!(body["error"]["code"], -32022);
    assert_eq!(body["error"]["data"]["kind"], "exhausted");

    // A malformed request is rejected at the decoder, before any storage work,
    // and reports the same invalid code as a service-level rejection.
    let body = rpc(enabled, 47, "pcash_catalogList", json!([{}])).await;
    assert_eq!(body["error"]["code"], -32021);
    assert_eq!(body["error"]["data"]["kind"], "invalid");

    // Only a genuinely malformed JSON-RPC params array is a protocol error.
    let body = rpc(enabled, 48, "pcash_catalogList", json!([])).await;
    assert_eq!(body["error"]["code"], -32602);
}

#[tokio::test]
async fn cors_preflight_and_post_carry_allow_origin() {
    let (addr, _handle) = start().await;
    let url = format!("http://{addr}");
    let client = reqwest::Client::new();

    // A browser preflight: OPTIONS with Origin + Access-Control-Request-Method must
    // be answered by the CORS layer with an allow-origin header.
    let preflight = client
        .request(Method::OPTIONS, &url)
        .header(ORIGIN, "http://localhost:5173")
        .header("Access-Control-Request-Method", "POST")
        .send()
        .await
        .expect("preflight request");
    assert!(
        preflight.status().is_success(),
        "preflight status: {}",
        preflight.status()
    );
    assert_eq!(
        preflight
            .headers()
            .get(ACCESS_CONTROL_ALLOW_ORIGIN)
            .expect("preflight allow-origin header"),
        "*"
    );

    // The real cross-origin call: a POST from the same Origin succeeds and its
    // response also carries the allow-origin header the browser requires.
    let resp = client
        .post(&url)
        .header(ORIGIN, "http://localhost:5173")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pcash_areNullifiersSpent",
            "params": [[]],
        }))
        .send()
        .await
        .expect("post request");
    assert!(resp.status().is_success(), "post status: {}", resp.status());
    assert_eq!(
        resp.headers()
            .get(ACCESS_CONTROL_ALLOW_ORIGIN)
            .expect("post allow-origin header"),
        "*"
    );
    let body: Value = resp.json().await.expect("json-rpc body");
    assert_eq!(body["result"], json!([]), "unexpected body: {body}");
}

#[tokio::test]
async fn json_rpc_batch_fanout_is_bounded() {
    let (addr, _handle) = start().await;
    let url = format!("http://{addr}");
    let calls = (0..65)
        .map(|id| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "pcash_areNullifiersSpent",
                "params": [[]],
            })
        })
        .collect::<Vec<_>>();
    let response = reqwest::Client::new()
        .post(url)
        .json(&calls)
        .send()
        .await
        .expect("batch request");
    assert!(response.status().is_success());
    let body: Value = response.json().await.expect("json-rpc body");
    assert_eq!(body["error"]["message"], "The batch request was too large");
}

#[tokio::test]
async fn catalog_batches_are_bounded_by_the_aggregate_request_size() {
    let (addr, _handle) = start_with_catalog(true).await;
    let url = format!("http://{addr}");
    let publication =
        catalog_artifact_json(&vec![7; pcash_rpc::catalog::MAX_CATALOG_PAYLOAD_BYTES]);
    let batch = |calls: usize| {
        (0..calls)
            .map(|id| {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "pcash_catalogPublish",
                    "params": [publication],
                })
            })
            .collect::<Vec<_>>()
    };

    // Every call is individually valid and the count is within the batch
    // limit, but 32 maximum-size payloads are 16 MiB of hex before framing.
    // The server refuses from Content-Length and closes without reading the
    // body, so the client may see the close before it reads the 413.
    match reqwest::Client::new()
        .post(&url)
        .json(&batch(32))
        .send()
        .await
    {
        Ok(refused) => assert_eq!(refused.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE),
        Err(error) => assert!(
            closed_during_upload(&error),
            "oversized batch request: {error:?}"
        ),
    }

    // Split in half, the same publications reach their handlers.
    let served = reqwest::Client::new()
        .post(&url)
        .json(&batch(16))
        .send()
        .await
        .expect("split batch request");
    assert!(served.status().is_success());
    let body: Value = served.json().await.expect("json-rpc body");
    assert_eq!(body.as_array().map(Vec::len), Some(16));
}
