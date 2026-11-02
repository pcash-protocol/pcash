#![allow(
    clippy::unreadable_literal,
    reason = "test fixtures preserve protocol chain identifiers"
)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stderr,
    reason = "tests use direct assertions and diagnostics for fixture validation"
)]
//! Live end-to-end node-pipeline test against Sepolia.
//!
//! Marked `#[ignore]` so the offline suite passes with it skipped. Run it for
//! real (sandbox off, network on):
//!
//! ```text
//! cargo test -p pcash-node --test live_sepolia -- --ignored --nocapture
//! ```
//!
//! It starts the node against `https://rpc.sepolia.ethpandaops.io`, sets
//! `GENESIS_L1_BLOCK_NUMBER = finalized − 15`, runs the reorg-aware follow loop
//! until it reaches the finalized tag. The ordinary Ethereum activity must not
//! allocate native PCASH on this empty-genesis test network.

use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::U256;
use pcash_l1::{Follower, L1Client, SEPOLIA_RPC_URL};
use pcash_metrics::NoopMetrics;
use pcash_node::{
    build_node, run_follow, BeaconClient, NetworkConfig, NodeHandle, DEFAULT_INBOX, L1_CHAIN_ID,
    PCASH_CHAIN_ID,
};
use pcash_rpc::NodeApi;
use pcash_verify::{Verifier, VerifyError};

/// Clean-reject stub: real Sepolia blocks carry no PCASH inbox batches, so the
/// verifier is never consulted for issuance; if some tx did hit the configured
/// inbox, its proof entries reject cleanly rather than aborting the run.
struct NoVerify;
impl Verifier for NoVerify {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        Ok(false)
    }
}

#[tokio::test]
#[ignore = "live: hits real Sepolia RPC; run with --ignored --nocapture"]
async fn live_ethereum_activity_creates_no_grants() -> eyre::Result<()> {
    let client = L1Client::new(SEPOLIA_RPC_URL)?;
    let finalized = client.finalized_block_number().await?;
    let genesis = finalized - 15;
    let target = finalized;
    eprintln!(
        "LIVE Sepolia: finalized={finalized}, deriving genesis={genesis}..=target={target} ({} blocks)",
        target - genesis + 1
    );

    let tmp = tempfile::tempdir()?;
    let genesis_hash = client.block_hash_by_number(genesis).await?;
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        genesis,
        genesis_hash,
    );
    let inner = build_node(&tmp.path().join("state.redb"), &cfg)?;

    // Run the real follow loop (always follows latest) up to the finalized tag,
    // which the bounded `target` stops it at.
    let follower = Follower::new(L1Client::new(SEPOLIA_RPC_URL)?, genesis);
    let beacon_endpoint = std::env::var("PCASH_BEACON_API")
        .map_err(|_| eyre::eyre!("PCASH_BEACON_API is required for the live Sepolia test"))?;
    let beacon = Arc::new(BeaconClient::connect(&beacon_endpoint).await?);
    run_follow(
        inner.clone(),
        follower,
        NoVerify,
        Some(target),
        Duration::from_secs(1),
        beacon,
        None,
        Arc::new(NoopMetrics),
    )
    .await?;

    // ---- assertions through the RPC surface --------------------------------
    let handle = NodeHandle::new(inner.clone());
    let status = handle.status().unwrap();

    assert_eq!(
        status.latest_l1_block_number, target,
        "must have derived up to finalized"
    );
    assert_eq!(status.issued_so_far, U256::ZERO);
    assert_ne!(status.l1_origin_root, alloy_primitives::B256::ZERO);

    // ---- captured evidence -------------------------------------------------
    eprintln!("LIVE EVIDENCE ------------------------------------------------");
    eprintln!("  block range      : {genesis}..={target}");
    eprintln!("  latestBlock      : {}", status.latest_block);
    eprintln!("  finalizedBlock   : {}", status.finalized_block);
    eprintln!("  latestL1Block    : {}", status.latest_l1_block_number);
    eprintln!("  finalizedL1Block : {}", status.finalized_l1_block_number);
    eprintln!("  stateRoot      : 0x{}", hex::encode(status.state_root));
    eprintln!("  issuedSoFar(wei): {}", status.issued_so_far);
    eprintln!("--------------------------------------------------------------");

    Ok(())
}
