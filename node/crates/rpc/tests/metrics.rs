#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]

use std::collections::HashSet;
use std::sync::Arc;

use jsonrpsee::server::middleware::rpc::RpcServiceBuilder;
use jsonrpsee::server::Server;
use jsonrpsee::RpcModule;
use pcash_metrics::PrometheusMetrics;
use pcash_rpc::server::{register_read, BlockingReads};
use pcash_rpc::test_support::{StubAdmin, StubNode};
use pcash_rpc::{
    serve_admin_with_metrics, serve_with_metrics, AdminApi, NodeApi, RpcMetricsService,
};
use serde_json::json;

fn rpc_count(metrics: &PrometheusMetrics, method: &str) -> u64 {
    let text = metrics.encode().expect("encode metrics");
    let prefix = format!("pcash_node_rpc_requests_total{{method=\"{method}\"}} ");
    text.lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .unwrap_or_else(|| panic!("missing {prefix} in {text}"))
        .parse()
        .expect("counter value")
}

#[tokio::test]
async fn invalid_params_increments_rpc_errors() {
    let metrics = Arc::new(PrometheusMetrics::new());
    let api: Arc<dyn NodeApi> = Arc::new(StubNode::populated());
    let (addr, _handle) = serve_with_metrics(
        "127.0.0.1:0".parse().expect("loopback address"),
        api,
        Arc::clone(&metrics) as Arc<dyn pcash_metrics::Metrics>,
        pcash_rpc::RpcMethods::new(),
    )
    .await
    .expect("serve binds");

    let response: serde_json::Value = reqwest::Client::new()
        .post(format!("http://{addr}"))
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pcash_getAccount",
            "params": ["not-an-address"]
        }))
        .send()
        .await
        .expect("rpc call")
        .json()
        .await
        .expect("json body");
    assert_eq!(response["error"]["code"], -32602, "{response}");

    let unknown: serde_json::Value = reqwest::Client::new()
        .post(format!("http://{addr}"))
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "no_such_method",
            "params": []
        }))
        .send()
        .await
        .expect("rpc call")
        .json()
        .await
        .expect("json body");
    assert_eq!(unknown["error"]["code"], -32601, "{unknown}");

    let text = metrics.encode().expect("encode");
    assert!(
        text.contains(r#"pcash_node_rpc_errors_total{method="pcash_getAccount",code="-32602"} 1"#),
        "{text}"
    );
    assert!(
        text.contains(r#"pcash_node_rpc_errors_total{method="unknown",code="-32601"} 1"#),
        "{text}"
    );
    assert_eq!(rpc_count(&metrics, "pcash_getAccount"), 1);
    assert_eq!(rpc_count(&metrics, "unknown"), 1);
    assert!(!text.contains("no_such_method"), "{text}");
}

#[tokio::test]
async fn registered_methods_and_batches_keep_client_labels_bounded() {
    let metrics = Arc::new(PrometheusMetrics::new());
    let api: Arc<dyn NodeApi> = Arc::new(StubNode::populated());
    let (addr, _handle) = serve_with_metrics(
        "127.0.0.1:0".parse().expect("loopback address"),
        api,
        Arc::clone(&metrics) as Arc<dyn pcash_metrics::Metrics>,
        pcash_rpc::RpcMethods::new(),
    )
    .await
    .expect("serve binds");
    let client = reqwest::Client::new();
    let url = format!("http://{addr}");

    for method in [
        "pcash_getPayouts",
        "pcash_getBlockEconomics",
        "pcash_getIssuanceQuote",
    ] {
        let response: serde_json::Value = client
            .post(&url)
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": ["bad"]}))
            .send()
            .await
            .expect("registered call")
            .json()
            .await
            .expect("json response");
        assert_eq!(response["error"]["code"], -32602, "{response}");
        assert_eq!(rpc_count(&metrics, method), 1);
    }

    for index in 0..32 {
        let method = format!("missing_method_{index}");
        let response: serde_json::Value = client
            .post(&url)
            .json(&json!({"jsonrpc": "2.0", "id": index, "method": method}))
            .send()
            .await
            .expect("unknown call")
            .json()
            .await
            .expect("json response");
        assert_eq!(response["error"]["code"], -32601, "{response}");
    }

    let batch: serde_json::Value = client
        .post(&url)
        .json(&json!([
            {"jsonrpc": "2.0", "id": 100, "method": "pcash_status"},
            {"jsonrpc": "2.0", "id": 101, "method": "missing_in_batch"},
            {"jsonrpc": "2.0", "id": 102, "method": "admin_nodeInfo"}
        ]))
        .send()
        .await
        .expect("batch call")
        .json()
        .await
        .expect("json batch");
    assert!(batch.is_array(), "{batch}");
    assert_eq!(batch[1]["error"]["code"], -32601, "{batch}");
    assert_eq!(batch[2]["error"]["code"], -32601, "{batch}");

    assert_eq!(rpc_count(&metrics, "pcash_status"), 1);
    assert_eq!(rpc_count(&metrics, "unknown"), 34);
    let text = metrics.encode().expect("encode");
    assert!(text.contains(r#"method="pcash_getPayouts""#), "{text}");
    assert!(!text.contains("missing_method_"), "{text}");
    assert!(!text.contains("missing_in_batch"), "{text}");
    assert!(!text.contains(r#"method="admin_nodeInfo""#), "{text}");
}

#[tokio::test]
async fn admin_listener_labels_only_its_registered_namespace() {
    let metrics = Arc::new(PrometheusMetrics::new());
    let api: Arc<dyn AdminApi> = Arc::new(StubAdmin);
    let (addr, _handle) = serve_admin_with_metrics(
        "127.0.0.1:0".parse().expect("loopback address"),
        api,
        Arc::clone(&metrics) as Arc<dyn pcash_metrics::Metrics>,
    )
    .await
    .expect("admin serve binds");
    let client = reqwest::Client::new();
    for (method, expected_code) in [("admin_removePeer", -32602), ("pcash_status", -32601)] {
        let response: serde_json::Value = client
            .post(format!("http://{addr}"))
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": [42]}))
            .send()
            .await
            .expect("admin call")
            .json()
            .await
            .expect("json response");
        assert_eq!(response["error"]["code"], expected_code, "{response}");
    }
    assert_eq!(rpc_count(&metrics, "admin_removePeer"), 1);
    assert_eq!(rpc_count(&metrics, "unknown"), 1);
    let text = metrics.encode().expect("encode");
    assert!(!text.contains(r#"method="pcash_status""#), "{text}");
}

#[tokio::test]
async fn capacity_error_uses_its_numeric_metric_code() {
    let mut module = RpcModule::new(());
    register_read(
        &BlockingReads::with_permits(0),
        &mut module,
        "capacity_read",
        |_, &(), ()| Ok(serde_json::Value::Null),
    )
    .expect("register capacity method");
    let registered_methods = Arc::new(module.method_names().collect::<HashSet<_>>());
    let metrics = Arc::new(PrometheusMetrics::new());
    let rpc_metrics = Arc::clone(&metrics) as Arc<dyn pcash_metrics::Metrics>;
    let rpc_middleware = RpcServiceBuilder::new().layer_fn(move |service| RpcMetricsService {
        service,
        metrics: Arc::clone(&rpc_metrics),
        registered_methods: Arc::clone(&registered_methods),
    });
    let server = Server::builder()
        .set_rpc_middleware(rpc_middleware)
        .build(
            "127.0.0.1:0"
                .parse::<std::net::SocketAddr>()
                .expect("loopback address"),
        )
        .await
        .expect("server binds");
    let addr = server.local_addr().expect("server address");
    let _handle = server.start(module);
    let response: serde_json::Value = reqwest::Client::new()
        .post(format!("http://{addr}"))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "capacity_read"}))
        .send()
        .await
        .expect("capacity call")
        .json()
        .await
        .expect("json response");
    assert_eq!(response["error"]["code"], -32004);
    let text = metrics.encode().expect("encode");
    assert!(
        text.contains(r#"pcash_node_rpc_errors_total{method="capacity_read",code="-32004"} 1"#),
        "{text}"
    );
}
