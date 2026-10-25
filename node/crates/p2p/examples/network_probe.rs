//! Transport acceptance fixture; its generated payloads are not transactions.
//! The Linux harness supplies isolated identities and owns the process lifetime.
#![allow(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "JSON-lines network test fixture"
)]
use alloy_primitives::B256;
use pcash_p2p::{
    CandidateOrigin, ConnectivityConfig, ForkCapability, InventoryEntry, Keypair, P2pConfig,
    P2pEvent, P2pHandle, ValidationResult,
};
use std::{
    collections::BTreeMap,
    env,
    error::Error,
    io::BufRead,
    time::{Duration, Instant},
};

fn setting(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_owned())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "pcash_p2p=info".into()),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    let id: u8 = setting("P2P_TEST_ID", "1").parse()?;
    let key = Keypair::ed25519_from_bytes([id; 32])?;
    if env::args().any(|a| a == "--peer-id") {
        println!("{}", key.public().to_peer_id());
        return Ok(());
    }
    let genesis = B256::repeat_byte(0xab);
    let connectivity = ConnectivityConfig {
        nat: setting("P2P_TEST_NAT", "auto") == "auto",
        advertised_address: env::var("P2P_TEST_ADVERTISE")
            .ok()
            .map(|a| a.parse())
            .transpose()?,
        relay_server: setting("P2P_TEST_RELAY_SERVER", "false") == "true",
        allow_private_addresses: true,
        ..Default::default()
    };
    let config = P2pConfig {
        chain_id: 77,
        genesis_hash: genesis,
        identity: key,
        listen: setting("P2P_TEST_LISTEN", "/ip4/0.0.0.0/tcp/8646").parse()?,
        bootstrap: setting("P2P_TEST_BOOTNODES", "")
            .split(',')
            .filter(|s| !s.is_empty())
            .map(str::parse)
            .collect::<Result<_, _>>()?,
        connectivity,
        max_inventory: 8,
        anti_entropy_interval: Duration::from_secs(5),
        fork_capability: ForkCapability {
            chain_id: 77,
            genesis_hash: genesis,
            head_timestamp: 100,
            current_fork_count: 0,
            current_prefix_hash: B256::repeat_byte(0x11),
            next_activation_timestamp: 0,
            next_prefix_hash: B256::ZERO,
        },
        peer_ban_duration: pcash_p2p::PEER_BAN_DURATION,
    };
    let (handle, mut events) = pcash_p2p::start(config).await?;
    // The harness sends explicit inventory probes independently of gossip.
    let (control_tx, mut control_rx) = tokio::sync::mpsc::channel(16);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if control_tx.blocking_send(line).is_err() {
                break;
            }
        }
    });
    let burst = setting("P2P_TEST_BURST", "false") == "true";
    let started = Instant::now();
    let mut status_tick = tokio::time::interval(Duration::from_secs(1));
    let mut publish_tick = tokio::time::interval(if burst {
        Duration::from_millis(20)
    } else {
        Duration::from_secs(2)
    });
    publish_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut received = BTreeMap::<String, u64>::new();
    let mut sequence = 0u64;
    let mut fetched = BTreeMap::<String, String>::new();
    let mut last_command = String::new();
    let mut publishing = true;
    loop {
        tokio::select! {
            _ = status_tick.tick() => {
                println!("{}", snapshot(&handle, &received, &fetched, &last_command));
            }
            Some(line) = control_rx.recv() => {
                let command: Control = serde_json::from_str(&line)?;
                apply_control(&handle, &command, &mut publishing).await?;
                last_command = command.id;
            }
            _ = publish_tick.tick() => {
                // Let the blocked-punch attempt finish before exercising the
                // byte quota; otherwise quota closure cancels that attempt.
                if !publishing { continue; }
                if burst && started.elapsed() < Duration::from_secs(75) { continue; }
                sequence += 1;
                let mut payload = vec![id; if burst { pcash_p2p::MAX_RELAYED_TX_BYTES } else { 16 }];
                payload[1..9].copy_from_slice(&sequence.to_be_bytes());
                handle.announce(payload).await?;
            }
            event = events.recv() => {
                match event {
                    Some(P2pEvent::Candidate{origin, tx_bytes}) => {
                        if let CandidateOrigin::Sync { peer } = &origin {
                            fetched.insert(peer.to_string(), String::from_utf8(tx_bytes)?);
                        }
                        *received.entry(origin.publisher().to_string()).or_default() += 1;
                        handle.try_report_validation(origin,ValidationResult::Accept)?;
                    }
                    Some(P2pEvent::Warning(message)) => eprintln!("{message}"),
                    None => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct Control {
    id: String,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(serde::Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
enum Operation {
    Inventory { token: String },
    Remove { peer: pcash_p2p::PeerId },
    Add { address: pcash_p2p::Multiaddr },
    StopPublishing,
}

async fn apply_control(
    handle: &P2pHandle,
    command: &Control,
    publishing: &mut bool,
) -> Result<(), Box<dyn Error>> {
    match &command.operation {
        Operation::Inventory { token } => {
            let tx_bytes = token.as_bytes().to_vec();
            handle
                .replace_inventory(vec![InventoryEntry {
                    content_hash: pcash_p2p::content_hash(&tx_bytes),
                    tx_bytes,
                }])
                .await?;
        }
        Operation::Remove { peer } => {
            handle.remove_peer(*peer, false).await?;
        }
        Operation::Add { address } => {
            handle.add_peer(address.clone()).await?;
        }
        Operation::StopPublishing => *publishing = false,
    }
    Ok(())
}

fn snapshot(
    handle: &P2pHandle,
    received: &BTreeMap<String, u64>,
    fetched: &BTreeMap<String, String>,
    last_command: &str,
) -> serde_json::Value {
    let peers: Vec<_> = handle
        .peers()
        .into_iter()
        .map(|peer| {
            serde_json::json!({
                "id": peer.peer_id.to_string(),
                "address": peer.remote_address.to_string(),
                "compatible": peer.compatible,
                "connections": peer.connections,
                "receivedBytes": peer.payload_bytes_received,
            })
        })
        .collect();
    serde_json::json!({
        "id": handle.peer_id().to_string(), "network": handle.network_status(),
        "peers": peers, "received": received, "fetched": fetched, "lastCommand": last_command,
    })
}
