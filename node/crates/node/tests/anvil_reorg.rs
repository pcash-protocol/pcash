#![allow(
    clippy::unreadable_literal,
    reason = "test fixtures preserve protocol chain identifiers"
)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Anvil-backed L1 reorg integration test.
//!
//! Unlike `reorg.rs`, which uses a controllable in-process transport for broad
//! canonical-state and derived-index coverage, this test crosses the real HTTP JSON-RPC adapter.
//! It derives an Anvil branch, reverts Anvil to a snapshot, derives a competing
//! branch, and checks that rollback plus re-derivation matches a clean sync.

mod common;

use common::{batch, word};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alloy_primitives::{B256, U256};
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{PrivateValueSection, Transaction};
use pcash_l1::{Follower, L1Client, Step};
use pcash_metrics::NoopMetrics;
use pcash_node::{
    build_node, handle_reorg, run_follow, BeaconClient, NetworkConfig, NodeHandle, NodeInner,
    DEFAULT_INBOX,
};
use pcash_rpc::{NodeApi, PayoutRecordDto};
use pcash_verify::{Verifier, VerifyError};

const PCASH_CHAIN_ID: u32 = 1346589512;
const L1_CHAIN_ID: u64 = 31_337;
const GENESIS: u64 = 0;
const COMMON_TIP: u64 = 4;
const BRANCH_HEIGHT: u64 = 5;
const REPLACEMENT_TIP: u64 = 6;

const BRANCH_A_SENDER: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const BRANCH_B_SENDER: &str = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TRANSFER_RECIPIENT: &str = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

struct AcceptVerifier;

impl Verifier for AcceptVerifier {
    fn verify(&self, _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, VerifyError> {
        Ok(true)
    }
}

struct AnvilProcess {
    child: Child,
    rpc_url: String,
}

impl AnvilProcess {
    fn start() -> eyre::Result<Self> {
        require_command("cast")?;
        require_command("anvil")?;

        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        drop(listener);

        let child = Command::new("anvil")
            .args([
                "--port",
                &port.to_string(),
                "--silent",
                "--no-mining",
                "--slots-in-an-epoch",
                "1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| eyre::eyre!("start anvil: {error}"))?;
        let rpc_url = format!("http://127.0.0.1:{port}");
        let process = Self { child, rpc_url };
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if TcpStream::connect(("127.0.0.1", port)).is_ok()
                && cast(&process.rpc_url, "eth_chainId", &[]).is_ok()
            {
                return Ok(process);
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        let rpc_url = process.rpc_url.clone();
        Err(eyre::eyre!("anvil did not start on {rpc_url}"))
    }
}

impl Drop for AnvilProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn require_command(name: &str) -> eyre::Result<()> {
    let status = Command::new(name)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| eyre::eyre!("{name} is required for this test: {error}"))?;
    if !status.success() {
        eyre::bail!("{name} --version exited with {status}");
    }
    Ok(())
}

fn cast(rpc_url: &str, method: &str, params: &[&str]) -> eyre::Result<String> {
    let output = Command::new("cast")
        .arg("rpc")
        .arg("--rpc-url")
        .arg(rpc_url)
        .arg(method)
        .args(params)
        .output()
        .map_err(|error| eyre::eyre!("run cast rpc {method}: {error}"))?;
    if !output.status.success() {
        eyre::bail!(
            "cast rpc {method} exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn mine(rpc_url: &str, count: u64) -> eyre::Result<()> {
    cast(rpc_url, "anvil_mine", &[&count.to_string()])?;
    Ok(())
}

fn snapshot(rpc_url: &str) -> eyre::Result<String> {
    let encoded = cast(rpc_url, "evm_snapshot", &[])?;
    serde_json::from_str(&encoded).map_err(Into::into)
}

fn revert(rpc_url: &str, snapshot_id: &str) -> eyre::Result<()> {
    let reverted = cast(rpc_url, "evm_revert", &[snapshot_id])?;
    if reverted.trim() != "true" {
        eyre::bail!("evm_revert returned {reverted}");
    }
    Ok(())
}

fn send_transfer(rpc_url: &str, sender: &str, fee_payment: &[u8]) -> eyre::Result<()> {
    // Ensure the branch transaction has a later timestamp than its parent.
    cast(rpc_url, "evm_increaseTime", &["1"])?;
    let transaction = serde_json::json!({
        "from": sender,
        "to": TRANSFER_RECIPIENT,
        "value": "0x1",
    });
    cast(
        rpc_url,
        "eth_sendTransaction",
        &[&serde_json::to_string(&transaction)?],
    )?;
    let inbox_transaction = serde_json::json!({
        "from": sender,
        "to": DEFAULT_INBOX,
        "input": format!("0x{}", alloy_primitives::hex::encode(batch(&[fee_payment.to_vec()]))),
        "gas": "0x200000",
    });
    cast(
        rpc_url,
        "eth_sendTransaction",
        &[&serde_json::to_string(&inbox_transaction)?],
    )?;
    mine(rpc_url, 1)
}

fn fee_payment(recent: B256, salt: u64, deadline: u64) -> Vec<u8> {
    let mut wire = vec![recent];
    // Four nullifiers and five output bodies.
    wire.extend((2..11).map(|i| word(salt * 100 + i)));
    wire.extend([
        word(7), // openFeeAmount
        B256::ZERO,
        B256::ZERO,
        word(deadline),
        word(0), // carrierContextHash
        word(0), // eventsCommitment
    ]);
    Transaction::PrivateValue(
        PrivateValueSection::new(
            PrivateValueShape::S,
            PCASH_CHAIN_ID,
            &wire,
            // Proof verification is injected through AcceptVerifier.
            vec![1; pcash_derive::SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes()],
            vec![common::output_data(&[]); 5],
            common::arena(),
        )
        .unwrap(),
    )
    .encode(PCASH_CHAIN_ID)
    .unwrap()
}

async fn drive_to_head(inner: &Arc<Mutex<NodeInner>>, follower: &mut Follower) -> eyre::Result<()> {
    follower.refresh().await?;
    let ceiling = follower.head();
    while follower.cursor() <= ceiling {
        match follower.next().await? {
            Step::Block(data) => {
                let mut node = inner.lock().unwrap();
                let number = data.header.number;
                node.apply_block(&data, &AcceptVerifier)?;
                node.prune_finalized(follower.finalized().min(number))?;
            }
            Step::Reorg(reorg) => handle_reorg(inner, follower, reorg).await?,
            Step::AtHead => break,
        }
    }
    Ok(())
}

async fn fresh_node(
    path: &std::path::Path,
    client: &L1Client,
) -> eyre::Result<Arc<Mutex<NodeInner>>> {
    let genesis_hash = client.block_hash_by_number(GENESIS).await?;
    let cfg = NetworkConfig::new(
        PCASH_CHAIN_ID,
        L1_CHAIN_ID,
        DEFAULT_INBOX,
        GENESIS,
        genesis_hash,
    );
    build_node(path, &cfg)
}

/// The branch's only qualifying action pays separate poster fee and issuance notes.
/// The issuance amount depends on Anvil's wall-clock timestamps.
fn assert_poster_payouts(fee: &PayoutRecordDto, issuance: &PayoutRecordDto, issued_so_far: U256) {
    assert!(issued_so_far > U256::ZERO);
    assert_eq!(fee.component, pcash_state::PayoutComponent::OpenFee);
    assert_eq!(fee.amount, U256::from(7));
    assert_eq!(issuance.component, pcash_state::PayoutComponent::Issuance);
    assert_eq!(issuance.amount, issued_so_far);
    assert_eq!(fee.contexts, issuance.contexts);
}

#[tokio::test]
#[ignore = "requires anvil and cast; run with `just test-anvil-reorg`"]
async fn anvil_rpc_reorg_replaces_payout_notes_and_matches_clean_derivation() -> eyre::Result<()> {
    let anvil = AnvilProcess::start()?;
    mine(&anvil.rpc_url, COMMON_TIP)?;
    let snapshot_id = snapshot(&anvil.rpc_url)?;

    let client = L1Client::new(&anvil.rpc_url)?;
    let temp = tempfile::tempdir()?;
    let reorged = fresh_node(&temp.path().join("reorged.redb"), &client).await?;
    let mut follower = Follower::new(client.clone(), GENESIS);
    drive_to_head(&reorged, &mut follower).await?;
    assert_eq!(follower.cursor(), COMMON_TIP + 1);

    let common_status = NodeHandle::new(reorged.clone()).status()?;
    let deadline = common_status.latest_block_timestamp + 600;
    let branch_a_payment = fee_payment(common_status.latest_block_hash, 1, deadline);
    send_transfer(&anvil.rpc_url, BRANCH_A_SENDER, &branch_a_payment)?;
    drive_to_head(&reorged, &mut follower).await?;
    assert_eq!(follower.cursor(), BRANCH_HEIGHT + 1);
    let branch_a_hash = client.block_hash_by_number(BRANCH_HEIGHT).await?;

    let handle = NodeHandle::new(reorged.clone());
    let branch_a_payouts = handle.get_payouts(pcash_rpc::PayoutQuery::default())?;
    assert_eq!(branch_a_payouts.records.len(), 2);
    let branch_a_payout = &branch_a_payouts.records[0].payout.payout;
    assert_poster_payouts(
        branch_a_payout,
        &branch_a_payouts.records[1].payout.payout,
        handle.status()?.issued_so_far,
    );
    let orphaned_context = branch_a_payout.contexts.clone();

    revert(&anvil.rpc_url, &snapshot_id)?;
    let branch_b_payment = fee_payment(common_status.latest_block_hash, 2, deadline);
    send_transfer(&anvil.rpc_url, BRANCH_B_SENDER, &branch_b_payment)?;
    mine(&anvil.rpc_url, REPLACEMENT_TIP - BRANCH_HEIGHT)?;
    let branch_b_hash = client.block_hash_by_number(BRANCH_HEIGHT).await?;
    assert_ne!(branch_a_hash, branch_b_hash, "Anvil must replace block 5");

    // Consume the branch-A-anchored follower through the production loop. Its
    // next fetch sees branch B's child of the replaced block, so `run_follow`
    // must dispatch the discontinuity through production rollback,
    // `apply_derived_block`, and re-derivation before reaching the target.
    run_follow(
        reorged.clone(),
        follower,
        AcceptVerifier,
        Some(REPLACEMENT_TIP),
        Duration::from_millis(1),
        Arc::new(BeaconClient::for_test()),
        None,
        Arc::new(NoopMetrics),
    )
    .await?;
    let replacement_tip_hash = client.block_hash_by_number(REPLACEMENT_TIP).await?;

    let branch_b_payouts = handle.get_payouts(pcash_rpc::PayoutQuery::default())?;
    assert_eq!(branch_b_payouts.records.len(), 2);
    let branch_b_payout = &branch_b_payouts.records[0].payout.payout;
    // Gross issuance counts only the replacement branch's payout.
    assert_poster_payouts(
        branch_b_payout,
        &branch_b_payouts.records[1].payout.payout,
        handle.status()?.issued_so_far,
    );
    assert_eq!(branch_b_payout.contexts, orphaned_context);
    assert_eq!(
        B256::from(handle.status().unwrap().latest_l1_block_hash),
        replacement_tip_hash,
        "node must report the replacement branch tip"
    );

    let clean = fresh_node(&temp.path().join("clean.redb"), &client).await?;
    let mut clean_follower = Follower::new(client, GENESIS);
    drive_to_head(&clean, &mut clean_follower).await?;
    let reorged_status = handle.status().unwrap();
    let clean_status = NodeHandle::new(clean).status().unwrap();
    assert_eq!(reorged_status.state_root, clean_status.state_root);
    assert_eq!(
        reorged_status.latest_block_hash,
        clean_status.latest_block_hash
    );
    assert_eq!(reorged_status.issued_so_far, clean_status.issued_so_far);
    Ok(())
}
