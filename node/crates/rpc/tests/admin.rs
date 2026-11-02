#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Transport and parameter contract for the operator-only `admin_*` server.
//!
//! The reason this namespace has its own listener is to keep browsers away from
//! peer management, so the tests that matter most here are about what the socket
//! refuses: a WebSocket upgrade, and a request whose shape does not mean what
//! the caller thinks it means.

use std::net::SocketAddr;

use pcash_rpc::test_support::serve_stub_admin;
use reqwest::header::{CONNECTION, UPGRADE};
use serde_json::{json, Value};

async fn call(addr: SocketAddr, method: &str, params: Value) -> Value {
    reqwest::Client::new()
        .post(format!("http://{addr}"))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
        .send()
        .await
        .expect("admin server answers")
        .json()
        .await
        .expect("admin server returns JSON")
}

fn error_code(response: &Value) -> i64 {
    response["error"]["code"]
        .as_i64()
        .unwrap_or_else(|| panic!("expected an error object, got {response}"))
}

#[tokio::test]
async fn a_websocket_upgrade_is_refused() {
    // jsonrpsee serves HTTP and WebSocket on one socket by default. Browsers do
    // not apply the same-origin policy to WebSockets, so leaving the upgrade
    // enabled would let any page the operator visits reach peer management —
    // the exact thing the separate listener exists to prevent, and something no
    // CORS configuration would have stopped.
    let (addr, _handle) = serve_stub_admin().await;

    let response = reqwest::Client::new()
        .get(format!("http://{addr}"))
        .header(CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("Origin", "https://evil.example")
        .send()
        .await
        .expect("the admin server answers the upgrade attempt");

    assert_ne!(
        response.status().as_u16(),
        101,
        "the admin listener accepted a WebSocket upgrade"
    );
}

#[tokio::test]
async fn ordinary_http_calls_still_work() {
    // The counterpart to the test above: refusing WebSockets must not have
    // refused the transport the admin client actually uses.
    let (addr, _handle) = serve_stub_admin().await;
    let info = call(addr, "admin_nodeInfo", json!([])).await;
    assert_eq!(info["result"]["peerId"], "12D3KooWSelf");
}

#[tokio::test]
async fn a_ban_flag_that_is_not_a_boolean_is_rejected_rather_than_ignored() {
    // `["peer", "true"]` is a caller asking for a ban with the wrong type.
    // Silently treating it as `ban: false` would hand them a plain disconnect
    // and no indication they did not get what they asked for.
    let (addr, _handle) = serve_stub_admin().await;

    for bad in [
        json!(["12D3KooWPeerA", "true"]),
        json!(["12D3KooWPeerA", 1]),
    ] {
        let response = call(addr, "admin_removePeer", bad.clone()).await;
        assert_eq!(error_code(&response), -32602, "accepted {bad}");
    }

    // A third positional argument is a shape this method does not have.
    let response = call(
        addr,
        "admin_removePeer",
        json!(["12D3KooWPeerA", true, "extra"]),
    )
    .await;
    assert_eq!(error_code(&response), -32602);
}

#[tokio::test]
async fn remove_peer_accepts_both_calling_conventions_and_defaults_ban_off() {
    let (addr, _handle) = serve_stub_admin().await;

    // Absent `ban` is the one case that legitimately defaults: disconnecting is
    // the lesser action.
    let bare = call(addr, "admin_removePeer", json!(["12D3KooWPeerA"])).await;
    assert_eq!(bare["result"]["banned"], json!(false));

    let positional = call(addr, "admin_removePeer", json!(["12D3KooWPeerA", true])).await;
    assert_eq!(positional["result"]["banned"], json!(true));

    let named = call(
        addr,
        "admin_removePeer",
        json!({"peerId": "12D3KooWPeerA", "ban": true}),
    )
    .await;
    assert_eq!(named["result"]["banned"], json!(true));

    let named_default = call(addr, "admin_removePeer", json!({"peerId": "12D3KooWPeerA"})).await;
    assert_eq!(named_default["result"]["banned"], json!(false));
}

#[tokio::test]
async fn add_peer_requires_an_address_that_names_a_peer() {
    let (addr, _handle) = serve_stub_admin().await;

    let response = call(addr, "admin_addPeer", json!(["/ip4/127.0.0.1/tcp/8646"])).await;
    assert_eq!(error_code(&response), -32040);

    let ok = call(
        addr,
        "admin_addPeer",
        json!(["/ip4/127.0.0.1/tcp/8646/p2p/12D3KooWPeerA"]),
    )
    .await;
    assert_eq!(ok["result"]["peerId"], "12D3KooWPeerA");
}

#[tokio::test]
async fn publish_source_verification_takes_one_positional_publication() {
    // The publication crosses this namespace as opaque JSON, so the only shape
    // the server itself can insist on is the one positional argument. Empty
    // params are the mistake worth catching here.
    let (addr, _handle) = serve_stub_admin().await;

    let response = call(addr, "admin_publishSourceVerification", json!([])).await;
    assert_eq!(error_code(&response), -32602);

    let ok = call(
        addr,
        "admin_publishSourceVerification",
        json!([{"version": 1, "manifest": {}, "attachments": {}}]),
    )
    .await;
    assert_eq!(ok["result"]["status"], "ready");

    // A second positional argument is a shape this method does not have.
    let extra = call(
        addr,
        "admin_publishSourceVerification",
        json!([{"version": 1, "manifest": {}, "attachments": {}}, "surplus"]),
    )
    .await;
    assert_eq!(error_code(&extra), -32602);
}

#[tokio::test]
async fn a_publication_larger_than_the_library_default_reaches_the_method() {
    // A legal publication serializes to as much as the registry's wire budget
    // allows, well over jsonrpsee's 10 MiB default request ceiling. A body just
    // under the listener's own ceiling must be answered through JSON-RPC rather
    // than refused at the transport with a 413.
    let (addr, _handle) = serve_stub_admin().await;

    let filler = "a".repeat(15 * 1024 * 1024 + 512 * 1024);
    let response = reqwest::Client::new()
        .post(format!("http://{addr}"))
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "admin_publishSourceVerification",
            "params": [{"version": 1, "manifest": {}, "attachments": {"src/main.nr": filler}}],
        }))
        .send()
        .await
        .expect("admin server answers");

    assert_eq!(response.status().as_u16(), 200, "{response:?}");
    let body: Value = response.json().await.expect("admin server returns JSON");
    assert_eq!(body["result"]["status"], "ready", "{body}");
}
