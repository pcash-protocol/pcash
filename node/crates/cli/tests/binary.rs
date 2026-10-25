#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! End-to-end tests for the `pcash-cli` binary.
//!
//! These run the real executable against a real `pcash_*` server, so they cover
//! the whole path a user takes: argument parsing, the typed client, the server,
//! and both output modes. `--json` output is compared against the same fixtures
//! `pcash-rpc`'s frozen wire golden pins, which is what makes this an assertion
//! about the protocol rather than about the CLI's own idea of it.

use std::net::SocketAddr;
use std::process::Output;
use std::sync::Arc;

use pcash_pscan::api::{serve_pscan, ContractIndexReader, PscanApi};
use pcash_pscan::dto::{
    ContractConfigurationOpeningSubmission, ContractSourceBundle, ContractSourceView,
    ImplementationSource, ImplementationSourceFile, SourceVerificationApiError,
    SourceVerificationInfo, SubmissionApiError, SubmitContractConfigurationOpeningsResult,
    SubmitContractSourceResult, SubmittedImplementation, SubmittedSourceEnvelope,
};
use pcash_rpc::test_support::{
    addr, block_economics_page, fee_estimate, peer, serve_stub, serve_stub_admin, status,
    witness_snapshot, StubNode, ToWire,
};
use serde_json::Value;

/// Run the built binary against `endpoint` and return its output.
fn run(endpoint: SocketAddr, args: &[&str]) -> Output {
    std::process::Command::new(env!("CARGO_BIN_EXE_pcash-cli"))
        .arg("--rpc-url")
        .arg(format!("http://{endpoint}"))
        .args(args)
        .output()
        .expect("the pcash-cli binary runs")
}

/// Run the binary against an `admin_*` endpoint.
fn run_admin(admin: SocketAddr, args: &[&str]) -> Output {
    std::process::Command::new(env!("CARGO_BIN_EXE_pcash-cli"))
        .arg("--admin-url")
        .arg(format!("http://{admin}"))
        .args(args)
        .output()
        .expect("the pcash-cli binary runs")
}

fn json(endpoint: SocketAddr, args: &[&str]) -> Value {
    let mut with_json = vec!["--json"];
    with_json.extend_from_slice(args);
    let output = run(endpoint, &with_json);
    assert!(
        output.status.success(),
        "`{}` failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("--json prints JSON")
}

const ADDRESS: &str = "0x2e2f303132333435363738393a3b3c3d3e3f4041";
const HASH: &str = "0x0000000000000000000000000000000000000000000000000000000000000007";

#[tokio::test(flavor = "multi_thread")]
async fn json_output_is_the_response_the_node_sent() {
    let (endpoint, _handle) = serve_stub(StubNode::populated()).await;

    // `--json` must reproduce the node's response exactly, not a restatement.
    assert_eq!(json(endpoint, &["status"]), status().to_value());
    assert_eq!(
        json(endpoint, &["get-block-economics", "{}"]),
        block_economics_page().to_value()
    );
    assert_eq!(
        json(endpoint, &["estimate-fee", r#"{"byteSize":"0x8121"}"#]),
        fee_estimate().to_value()
    );

    // A quantity argument may be typed as decimal or hex and mean the same call.
    assert_eq!(
        json(endpoint, &["get-block-by-number", "102"]),
        json(endpoint, &["get-block-by-number", "0x66"])
    );

    // A mixed-case address is accepted and means the same as lower case.
    let upper = format!("0x{}", ADDRESS[2..].to_uppercase());
    assert_eq!(
        json(endpoint, &["get-account", ADDRESS]),
        json(endpoint, &["get-account", &upper])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn witness_snapshot_accepts_a_typed_query_and_preserves_the_response() {
    let (endpoint, _handle) = serve_stub(StubNode::populated()).await;
    let query = serde_json::json!({
        "accounts": [addr(1)],
        "contracts": [addr(2)],
        "outputs": ["0x0"],
        "nullifiers": [HASH],
        "l1Logs": [{
            "l1BlockNumber": "0x1",
            "transactionIndex": "0x0",
            "logIndex": "0x0",
        }],
    });
    assert_eq!(
        json(endpoint, &["get-witness-snapshot", &query.to_string()]),
        serde_json::to_value(witness_snapshot()).unwrap()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_human_renderer_decodes_the_same_response() {
    let (endpoint, _handle) = serve_stub(StubNode::populated()).await;

    let output = run(endpoint, &["status"]);
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    // Labels are humanized, quantities decoded, amounts and timestamps
    // expanded — none of which the raw JSON does.
    assert!(text.contains("Latest Block "), "{text}");
    assert!(text.contains("Issued So Far"), "{text}");
    assert!(text.contains("4 PCASH"), "{text}");
    assert!(text.contains("(0xabcd)"), "{text}");
    // Nested objects keep their structure rather than being flattened.
    assert!(text.contains("Fork Capability:"), "{text}");
    assert!(text.contains("Index:"), "{text}");
    assert!(!text.contains("\"latestBlock\""), "{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn every_subcommand_reaches_the_node() {
    let (endpoint, _handle) = serve_stub(StubNode::populated()).await;
    let submission = format!(r#"{{"contentHash":"{HASH}"}}"#);
    let account_history = format!(r#"{{"address":"{ADDRESS}"}}"#);
    let block_id = format!(r#"{{"blockNumber":"0x66","blockHash":"{HASH}"}}"#);
    let delivery = format!(r#"{{"l1TransactionHash":"{HASH}","limits":{{"maxBatches":"0x1"}}}}"#);

    // One invocation per command, with arguments the stub accepts. A command
    // whose arguments no longer encode correctly fails here rather than in
    // someone's terminal.
    let invocations: Vec<Vec<&str>> = vec![
        vec!["status"],
        vec!["get-payouts", "{}"],
        vec!["get-block-economics", "{}"],
        vec!["get-issuance-quote", "24"],
        vec!["get-witness-snapshot"],
        vec!["get-block-header"],
        vec!["get-block-header", "--block", "0x1"],
        vec!["get-block-header", "--block", HASH],
        vec!["get-account", ADDRESS],
        vec!["get-account", ADDRESS],
        vec!["get-contract", ADDRESS],
        vec!["get-account-proof", ADDRESS],
        vec!["get-account-proof", ADDRESS],
        vec!["get-output-path", "3"],
        vec!["get-output-paths", "1", "2"],
        vec!["get-l1-origin-proof", HASH, "0x112233"],
        vec!["get-l1-log-proof", HASH, "0x112233", "0", "0"],
        vec!["get-history-proof", HASH, "0x19"],
        vec!["get-block-by-number", "0x66"],
        vec!["get-block-by-hash", HASH],
        vec!["get-blocks", "--from", "0", "--to", "0x66"],
        vec!["get-blocks"],
        vec!["get-transactions", "{}"],
        vec!["get-transaction", HASH],
        vec!["get-submission", submission.as_str()],
        vec!["get-account-history", account_history.as_str()],
        vec!["get-transaction-by-nullifier", HASH],
        vec!["get-l1-delivery-batches", delivery.as_str()],
        vec!["get-block-payouts", block_id.as_str()],
        vec!["estimate-fee", r#"{"byteSize":"0x100"}"#],
        vec!["get-contracts", "{}"],
        vec!["are-nullifiers-spent", HASH],
        vec!["get-nullifier-proofs", HASH],
        vec!["get-receipt", "--tx-id", HASH],
        vec!["get-receipt", "--nullifier", HASH],
        vec![
            "get-receipt",
            "--l1-block-hash",
            HASH,
            "--l1-transaction-index",
            "2",
            "--batch-item-index",
            "5",
        ],
        vec![
            "get-receipt",
            "--address",
            ADDRESS,
            "--account-revision",
            "9",
        ],
        vec!["get-mempool"],
        vec!["get-mempool", "--kind", "privateValue", "--limit", "10"],
        vec!["get-mempool-transaction", HASH],
        vec!["submit-raw-transaction", "0x010203"],
        vec![
            "prepare-relay",
            "--content-hash",
            HASH,
            "--max-batch-bytes",
            "1024",
        ],
        vec!["catalog-info"],
        vec!["catalog-list"],
        vec!["catalog-get", HASH],
        vec![
            "get-outputs",
            r#"{"fromOutputIndex":"0x0","target":{"blockNumber":"0x55","blockHash":"0x0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b"}}"#,
        ],
        vec!["get-output-frontier", block_id.as_str()],
        vec![
            "get-account-changes",
            r#"{"fromBlock":"0x0","target":{"blockNumber":"0x55","blockHash":"0x0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b"},"limits":{"maxChanges":"0x10"}}"#,
        ],
    ];

    for args in invocations {
        let output = run(endpoint, &args);
        assert!(
            output.status.success(),
            "`{}` failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_admin_subcommand_reaches_the_admin_endpoint() {
    let (admin, _handle) = serve_stub_admin().await;

    let publication = serde_json::json!({
        "version": 1,
        "manifest": {},
        "attachments": {},
    });
    let publication_path = std::env::temp_dir().join("pcash-cli-admin-publication.json");
    std::fs::write(&publication_path, serde_json::to_vec(&publication).unwrap())
        .expect("temp publication writes");
    let publication_arg = publication_path.to_str().unwrap().to_owned();

    let invocations: Vec<Vec<&str>> = vec![
        vec!["node-info"],
        vec!["peers"],
        vec!["add-peer", "/ip4/127.0.0.1/tcp/8646/p2p/12D3KooWPeerA"],
        vec!["remove-peer", "12D3KooWPeerA"],
        vec!["remove-peer", "12D3KooWPeerA", "--ban"],
        vec!["publish-source-verification", &publication_arg],
    ];

    for args in invocations {
        let output = run_admin(admin, &args);
        assert!(
            output.status.success(),
            "`{}` failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn admin_subcommands_do_not_reach_the_public_endpoint() {
    // The whole point of the separate listener: the `pcash_*` server must not
    // answer peer management, whatever a caller aims at it. `--admin-url` is
    // pointed at the public server here, which is the mistake this guards.
    let (endpoint, _handle) = serve_stub(StubNode::populated()).await;

    for args in [vec!["peers"], vec!["node-info"]] {
        let output = run_admin(endpoint, &args);
        assert!(
            !output.status.success(),
            "`{}` unexpectedly succeeded against the pcash_* port",
            args.join(" ")
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("Method not found") || stderr.contains("-32601"),
            "expected a method-not-found error, got: {stderr}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn admin_peer_output_decodes_quantities_and_keeps_the_wire_shape() {
    let (admin, _handle) = serve_stub_admin().await;

    let output = run_admin(admin, &["--json", "peers"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let peers: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(peers.as_array().unwrap().len(), 1);
    assert_eq!(peers[0], peer().to_value());
    // Counters are hex quantities on the wire, like every other count.
    assert_eq!(peers[0]["payloadBytesReceived"], "0x5678");
    assert_eq!(peers[0]["direction"], "outbound");

    // The human renderer decodes those quantities, annotating the wire hex.
    let text = String::from_utf8(run_admin(admin, &["peers"]).stdout).unwrap();
    assert!(
        text.contains("Payload Bytes Received  22136  (0x5678)"),
        "{text}"
    );
    assert!(text.contains("Direction               outbound"), "{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn catalog_publish_derives_the_content_id_and_stores_the_payload() {
    let (endpoint, _handle) = serve_stub(StubNode::populated()).await;
    let payload = b"published through the CLI";
    let file = std::env::temp_dir().join("pcash-cli-publish-fixture.bin");
    std::fs::write(&file, payload).unwrap();

    let stored = json(
        endpoint,
        &["catalog-publish", "--payload-file", file.to_str().unwrap()],
    );

    // The node re-derives the content id and refuses a mismatch, so a stored
    // record proves the CLI committed to the node's chain id.
    assert_eq!(
        stored["contentId"],
        format!(
            "0x{}",
            hex::encode(pcash_rpc::catalog_content_id(
                pcash_rpc::MARKETPLACE_NAMESPACE,
                pcash_rpc::test_support::CHAIN_ID,
                payload,
            ))
        )
    );
    assert_eq!(stored["payload"], format!("0x{}", hex::encode(payload)));
    assert_eq!(stored["namespace"], pcash_rpc::MARKETPLACE_NAMESPACE);
    std::fs::remove_file(&file).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn node_errors_are_reported_on_stderr_with_a_nonzero_exit() {
    let (endpoint, _handle) = serve_stub(StubNode::absent()).await;

    // The catalog is off, so the node answers -32020 rather than a result.
    let output = run(endpoint, &["catalog-list"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.starts_with("error: "), "{stderr}");
    assert!(stderr.contains("catalog unavailable"), "{stderr}");
    assert!(output.stdout.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_arguments_fail_before_any_request() {
    // No server at all: a rejected argument must not need one.
    let unused: SocketAddr = "127.0.0.1:1".parse().unwrap();

    for args in [
        vec!["get-account", "0x1234"],
        vec!["get-output-path", "not-a-number"],
        vec!["get-block-header", "--block", "0xnothex"],
        vec!["get-mempool", "--kind", "notAKind"],
        vec!["get-witness-snapshot", r#"{"outputs":["not-a-number"]}"#],
        vec!["catalog-list", "--namespace", "Not A Namespace"],
        vec!["get-receipt"],
        vec!["get-receipt", "--tx-id", HASH, "--nullifier", HASH],
    ] {
        let output = run(unused, &args);
        assert!(
            !output.status.success(),
            "`{}` should have been rejected",
            args.join(" ")
        );
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(
            !stderr.contains("Connection refused") && !stderr.contains("failed to connect"),
            "`{}` reached the network: {stderr}",
            args.join(" ")
        );
    }
}

/// Run the binary with no endpoint flags at all. `p2p-key` is answered from
/// local files, so a reachable node is not merely unnecessary — needing one
/// would be the bug.
fn run_local(args: &[&str]) -> Output {
    std::process::Command::new(env!("CARGO_BIN_EXE_pcash-cli"))
        .args(args)
        .output()
        .expect("the pcash-cli binary runs")
}

fn local_json(args: &[&str]) -> Value {
    let mut with_json = vec!["--json"];
    with_json.extend_from_slice(args);
    let output = run_local(&with_json);
    assert!(
        output.status.success(),
        "`{}` failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("--json prints JSON")
}

#[test]
fn p2p_key_generate_and_inspect_describe_the_same_key_without_a_node() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");
    let path = path.to_str().unwrap();

    let generated = local_json(&["p2p-key", "generate", "--out", path]);
    let inspected = local_json(&["p2p-key", "inspect", path]);
    assert_eq!(generated, inspected);

    assert!(generated["peerId"]
        .as_str()
        .expect("a peer id")
        .starts_with("12D3Koo"));
    assert_eq!(generated["keyType"], "Ed25519");
    assert_eq!(generated["insecurePermissions"], Value::Bool(false));
    assert_eq!(
        generated["publicKey"].as_str().expect("a public key").len(),
        2 + 64,
        "the public key is 32 bytes of hex"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(generated["filePermissions"], "0600");
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn p2p_key_output_never_contains_key_material() {
    // The security property, asserted rather than reviewed: whatever these
    // commands print, in either output mode, the private half of the key is not
    // in it. `pcash-p2p` hands the CLI a record with no accessor for the secret,
    // and this is the test that would catch that guarantee being undone.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");
    let path = path.to_str().unwrap();

    run_local(&["p2p-key", "generate", "--out", path]);
    let file = std::fs::read(path).unwrap();
    // The libp2p protobuf is `08 01 12 40` then secret(32) || public(32). If this
    // layout ever changes, the slice below stops naming the secret and the whole
    // test would quietly assert nothing — so it is pinned.
    assert_eq!(file.len(), 68, "unexpected key file layout");

    for args in [
        vec!["p2p-key", "inspect", path],
        vec!["--json", "p2p-key", "inspect", path],
        vec!["p2p-key", "generate", "--out", path, "--force"],
        vec!["--json", "p2p-key", "generate", "--out", path, "--force"],
    ] {
        // Re-read each time: the `--force` runs replace the key as they go, and
        // the secret that must not leak is the one on disk for *this* run.
        let file = std::fs::read(path).unwrap();
        let secret = &file[4..36];
        let output = run_local(&args);
        let printed = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        // A leak does not have to arrive in the encoding this test prefers.
        for leaked in [
            hex::encode(&file),
            hex::encode(secret),
            hex::encode_upper(secret),
        ] {
            assert!(
                !printed.contains(&leaked),
                "`{}` printed key material",
                args.join(" ")
            );
        }
    }
}

#[test]
fn p2p_key_generate_refuses_to_clobber_a_key_unless_forced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");
    let path = path.to_str().unwrap();

    let first = local_json(&["p2p-key", "generate", "--out", path]);
    let before = std::fs::read(path).unwrap();

    let output = run_local(&["p2p-key", "generate", "--out", path]);
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.starts_with("error: "), "{stderr}");
    assert!(stderr.contains("--force"), "{stderr}");
    // The key it refused to overwrite is untouched, which is the whole point: a
    // clobbered node key cannot be recomputed.
    assert_eq!(std::fs::read(path).unwrap(), before);

    let second = local_json(&["p2p-key", "generate", "--out", path, "--force"]);
    assert_ne!(second["peerId"], first["peerId"]);
    assert_eq!(second["replacedPeerId"], first["peerId"]);
}

#[test]
fn p2p_key_composes_the_bootstrap_address_add_peer_expects() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");
    let path = path.to_str().unwrap();

    let generated = local_json(&[
        "p2p-key",
        "generate",
        "--out",
        path,
        "--addr",
        "/ip4/203.0.113.7/tcp/8646",
    ]);
    let peer_id = generated["peerId"].as_str().expect("a peer id");
    assert_eq!(
        generated["bootstrapAddress"],
        Value::String(format!("/ip4/203.0.113.7/tcp/8646/p2p/{peer_id}"))
    );

    // `--addr` is the transport address; the suffix is what this command adds.
    let suffixed = format!("/ip4/203.0.113.7/tcp/8646/p2p/{peer_id}");
    let output = run_local(&["p2p-key", "inspect", path, "--addr", &suffixed]);
    assert!(!output.status.success());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("drop the /p2p/<peer-id> suffix"));

    // Without --addr there is no address to report rather than a guessed one.
    let plain = local_json(&["p2p-key", "inspect", path]);
    assert_eq!(plain.get("bootstrapAddress"), None);
}

#[test]
fn p2p_key_inspect_never_creates_a_key_and_warns_about_loose_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("absent.pb");

    let output = run_local(&["p2p-key", "inspect", absent.to_str().unwrap()]);
    assert!(!output.status.success());
    assert!(!absent.exists(), "inspect minted a key for a mistyped path");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.path().join("p2p_identity.pb");
        let path = path.to_str().unwrap();
        run_local(&["p2p-key", "generate", "--out", path]);
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let output = run_local(&["p2p-key", "inspect", path]);
        // A key the whole host can read is reported, not fatal: finding that out
        // is exactly why an operator ran this.
        assert!(output.status.success());
        assert!(String::from_utf8(output.stderr)
            .unwrap()
            .contains("readable by group or other"));
        assert_eq!(
            local_json(&["p2p-key", "inspect", path])["insecurePermissions"],
            Value::Bool(true)
        );
    }
}

/// A `PscanApi` stub answering every read successfully, so the binary can be
/// driven against a real `pscan_*` server exactly like the pcash/admin ones.
struct StubSource;

impl ContractIndexReader for StubSource {
    fn contract_for_source(
        &self,
        _address: alloy_primitives::Address,
    ) -> Result<Option<pcash_rpc::ContractDto>, String> {
        Ok(None)
    }

    fn contract_verification_changed(
        &self,
        _address: Option<alloy_primitives::Address>,
    ) -> Result<(), String> {
        Ok(())
    }
}

thread_local! {
    /// Receipts captured by [`StubSource::submit_blocking`], keyed by nothing:
    /// the test drives one submission at a time.
    static LAST_SUBMIT: std::cell::RefCell<Option<SubmittedSourceEnvelope>> =
        const { std::cell::RefCell::new(None) };
}

impl PscanApi for StubSource {
    fn info(&self) -> SourceVerificationInfo {
        SourceVerificationInfo::disabled()
    }

    fn get_contract_source(
        &self,
        _address: alloy_primitives::Address,
    ) -> Result<Option<ContractSourceView>, SourceVerificationApiError> {
        Ok(None)
    }

    fn get_implementation_source(
        &self,
        _hash: &alloy_primitives::B256,
    ) -> Result<Option<ImplementationSource>, SourceVerificationApiError> {
        Ok(None)
    }

    fn get_implementation_source_file(
        &self,
        _hash: &alloy_primitives::B256,
        _path: &str,
    ) -> Result<Option<ImplementationSourceFile>, SourceVerificationApiError> {
        Ok(None)
    }

    fn get_contract_source_bundle(
        &self,
        _address: alloy_primitives::Address,
    ) -> Result<Option<ContractSourceBundle>, SourceVerificationApiError> {
        Ok(None)
    }

    fn submission_permits(&self) -> Arc<tokio::sync::Semaphore> {
        Arc::new(tokio::sync::Semaphore::new(1))
    }

    fn submit_blocking(
        &self,
        envelope: SubmittedSourceEnvelope,
    ) -> Result<SubmitContractSourceResult, SubmissionApiError> {
        LAST_SUBMIT.with(|slot| *slot.borrow_mut() = Some(envelope));
        Ok(SubmitContractSourceResult {
            content_id: alloy_primitives::B256::ZERO,
            deduplicated: false,
            reproduced_implementations: 0,
            configuration_opening_count: 0,
            implementations: Vec::<SubmittedImplementation>::new(),
        })
    }

    fn submit_configuration_openings_blocking(
        &self,
        submission: ContractConfigurationOpeningSubmission,
    ) -> Result<SubmitContractConfigurationOpeningsResult, SubmissionApiError> {
        Ok(SubmitContractConfigurationOpeningsResult {
            contract_address: submission.contract_address,
            content_id: alloy_primitives::B256::ZERO,
            configuration_opening_count: submission.openings.len() as u64,
            deduplicated: false,
        })
    }
}

/// Run the binary against a `pscan_*` endpoint.
fn run_source(endpoint: SocketAddr, args: &[&str]) -> Output {
    std::process::Command::new(env!("CARGO_BIN_EXE_pcash-cli"))
        .arg("--pscan-url")
        .arg(format!("http://{endpoint}"))
        .args(args)
        .output()
        .expect("the pcash-cli binary runs")
}

#[tokio::test(flavor = "multi_thread")]
async fn every_source_subcommand_reaches_the_pscan_endpoint() {
    let addr: SocketAddr = "127.0.0.1:0".parse().expect("loopback socket");
    let api: std::sync::Arc<dyn PscanApi> = std::sync::Arc::new(StubSource);
    let (endpoint, _handle) = serve_pscan(addr, api).await.expect("serve pscan");

    // One submission envelope, written to disk so the CLI reads it verbatim.
    let envelope = serde_json::json!({
        "contractAddresses": [ADDRESS],
        "publication": {
            "version": 1,
            "manifest": {},
            "attachments": {},
        },
    });
    let envelope_path = std::env::temp_dir().join("pcash-cli-submit-envelope.json");
    std::fs::write(&envelope_path, serde_json::to_vec(&envelope).unwrap())
        .expect("temp envelope writes");
    let envelope_arg = envelope_path.to_str().unwrap().to_owned();

    let invocations: Vec<Vec<&str>> = vec![
        vec!["source-verification-info"],
        vec!["get-contract-source", ADDRESS],
        vec!["get-implementation-source", HASH],
        vec!["get-implementation-source-file", HASH, "claim/src/main.nr"],
        vec!["get-contract-source-bundle", ADDRESS],
        vec!["submit-contract-source", &envelope_arg],
    ];

    for args in invocations {
        let output = run_source(endpoint, &args);
        assert!(
            output.status.success(),
            "`{}` failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
