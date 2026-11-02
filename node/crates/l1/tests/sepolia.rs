#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout,
    reason = "tests use direct assertions and diagnostics for fixture validation"
)]
//! Live integration test against the real Sepolia RPC.
//!
//! `#[ignore]` so `cargo test -p pcash-l1` stays green offline. Run explicitly
//! (requires network / sandbox disabled):
//!
//! ```text
//! cargo test -p pcash-l1 --test sepolia -- --ignored --nocapture
//! ```

use pcash_l1::{L1Client, SEPOLIA_RPC_URL};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "hits the live Sepolia RPC; run with --ignored"]
async fn finalized_block_by_number_matches_by_hash() {
    let client = L1Client::new(SEPOLIA_RPC_URL).expect("client");

    // Learn the finalized height, then fetch that block two ways.
    let finalized_number = client
        .finalized_block_number()
        .await
        .expect("finalized number");
    let by_number = client
        .block_data_by_number(finalized_number)
        .await
        .expect("block by number");

    let by_hash = client
        .block_data_by_hash(by_number.header.hash)
        .await
        .expect("block by hash");

    // By-number and by-hash must agree.
    assert_eq!(by_number.header, by_hash.header, "header mismatch");
    assert_eq!(by_number.txs.len(), by_hash.txs.len(), "tx count mismatch");
    assert_eq!(by_number, by_hash, "full block data mismatch");

    // txs and receipts align in count (assemble already enforces this).
    let header = &by_number.header;
    for (i, (tx, _receipt)) in by_number.txs.iter().enumerate() {
        assert_eq!(tx.tx_index as usize, i, "tx index alignment");
    }

    let sample_sender = by_number.txs.first().map(|(t, _)| t.from);
    println!(
        "SEPOLIA finalized block #{} hash={} txs={} sample_sender={:?}",
        header.number,
        header.hash,
        by_number.txs.len(),
        sample_sender,
    );

    // Head must be at or above finalized.
    let head = client.latest_block_number().await.expect("head");
    println!("SEPOLIA head #{head} finalized #{finalized_number}");
    assert!(head >= finalized_number, "head below finalized");
}
