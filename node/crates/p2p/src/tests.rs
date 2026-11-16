#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]

use super::swarm::*;
use super::types::*;
use super::*;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use alloy_primitives::B256;
use libp2p::core::ConnectedPoint;
use libp2p::identity::Keypair;
use libp2p::multiaddr::Protocol;
use tokio::sync::mpsc;

fn capability(chain_id: u32, genesis_hash: B256) -> ForkCapability {
    ForkCapability {
        chain_id,
        genesis_hash,
        head_timestamp: 100,
        current_fork_count: 0,
        current_prefix_hash: B256::repeat_byte(0x11),
        next_activation_timestamp: 0,
        next_prefix_hash: B256::ZERO,
    }
}

#[test]
fn fork_capability_accepts_same_prefix_and_future_only_addition() {
    let local = capability(77, B256::repeat_byte(0xaa));
    let mut remote = local;
    remote.next_activation_timestamp = 200;
    remote.next_prefix_hash = B256::repeat_byte(0x22);
    assert_eq!(check_fork_compatibility(&local, &remote), Ok(()));
}

#[test]
fn fork_capability_accepts_one_recognized_transition_across_heads() {
    let mut older = capability(77, B256::repeat_byte(0xaa));
    older.head_timestamp = 199;
    older.next_activation_timestamp = 200;
    older.next_prefix_hash = B256::repeat_byte(0x22);
    let mut newer = older;
    newer.head_timestamp = 200;
    newer.current_fork_count = 1;
    newer.current_prefix_hash = B256::repeat_byte(0x22);
    newer.next_activation_timestamp = 0;
    newer.next_prefix_hash = B256::ZERO;
    assert_eq!(check_fork_compatibility(&older, &newer), Ok(()));
    assert_eq!(check_fork_compatibility(&newer, &older), Ok(()));
}

#[test]
fn fork_capability_rejects_conflicting_next_and_unknown_current() {
    let mut local = capability(77, B256::repeat_byte(0xaa));
    local.next_activation_timestamp = 200;
    local.next_prefix_hash = B256::repeat_byte(0x22);
    let mut conflicting_next = local;
    conflicting_next.next_activation_timestamp = 201;
    assert_eq!(
        check_fork_compatibility(&local, &conflicting_next),
        Err(ForkCompatibilityError::NextTransition)
    );
    let mut unknown = local;
    unknown.current_fork_count = 1;
    unknown.current_prefix_hash = B256::repeat_byte(0x33);
    unknown.next_activation_timestamp = 0;
    unknown.next_prefix_hash = B256::ZERO;
    assert_eq!(
        check_fork_compatibility(&local, &unknown),
        Err(ForkCompatibilityError::CurrentPrefix)
    );
}

async fn listen_address(events: &mut mpsc::Receiver<P2pEvent>) -> Multiaddr {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(P2pEvent::Listening(address)) = events.recv().await {
                break address;
            }
        }
    })
    .await
    .expect("swarm did not start listening")
}

async fn wait_for_peer_count(handle: &P2pHandle, expected: usize) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while handle.peer_count() != expected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("swarm did not reach {expected} connected peers"));
}

async fn wait_for_compatible_peer(handle: &P2pHandle) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !handle.peers().iter().any(|peer| peer.compatible) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("swarm did not account a compatible peer");
}

async fn next_candidate(
    events: &mut mpsc::Receiver<P2pEvent>,
) -> (PeerId, Vec<u8>, CandidateOrigin) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(P2pEvent::Candidate { tx_bytes, origin }) = events.recv().await {
                break (origin.publisher(), tx_bytes, origin);
            }
        }
    })
    .await
    .expect("candidate was not delivered")
}

async fn assert_no_candidate(events: &mut mpsc::Receiver<P2pEvent>, duration: Duration) {
    let candidate = tokio::time::timeout(duration, async {
        loop {
            match events.recv().await {
                Some(P2pEvent::Candidate { tx_bytes, .. }) => break Some(tx_bytes),
                Some(_) => {}
                None => break None,
            }
        }
    })
    .await;
    assert!(
        candidate.is_err(),
        "unexpected candidate delivered: {candidate:?}"
    );
}

/// A persistent identity, so a test that restarts a node under the same name
/// keeps its peer id.
fn identity_at(dir: &Path, name: &str) -> Keypair {
    load_or_create_identity(&dir.join(name)).unwrap()
}

fn test_config(dir: &Path, identity: &str, chain_id: u32, genesis_hash: B256) -> P2pConfig {
    P2pConfig {
        connectivity: crate::ConnectivityConfig::disabled(),
        chain_id,
        genesis_hash,
        identity: identity_at(dir, identity),
        listen: "/ip4/127.0.0.1/tcp/0".parse().unwrap(),
        bootstrap: Vec::new(),
        max_inventory: 8,
        anti_entropy_interval: Duration::from_millis(100),
        fork_capability: capability(chain_id, genesis_hash),
        peer_ban_duration: PEER_BAN_DURATION,
    }
}

#[test]
fn topic_and_sync_protocol_are_bound_to_chain_and_genesis_hash() {
    let topic = topic_for(77, B256::repeat_byte(0xab));
    assert_eq!(topic, format!("pcash/v1/77/{}/txs", "ab".repeat(32)));
    assert_eq!(
        sync_protocol_for(77, B256::repeat_byte(0xab)),
        format!("/pcash/mempool/1/77/{}/sync", "ab".repeat(32))
    );
}

#[test]
fn identity_is_persistent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p-key.pb");
    let first = load_or_create_identity(&path)
        .unwrap()
        .public()
        .to_peer_id();
    let second = load_or_create_identity(&path)
        .unwrap()
        .public()
        .to_peer_id();
    assert_eq!(first, second);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn a_hex_identity_is_the_identity_file_it_encodes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");
    let generated = generate_identity_file(&path, false).unwrap();
    let encoded = hex::encode(fs::read(&path).unwrap());

    let decoded = identity_from_hex(&encoded).unwrap();
    assert_eq!(decoded.public().to_peer_id(), generated.info.peer_id);
    let prefixed = identity_from_hex(&format!("0x{encoded}\n")).unwrap();
    assert_eq!(prefixed.public().to_peer_id(), generated.info.peer_id);

    assert!(identity_from_hex("zz").is_err());
    assert!(identity_from_hex(&encoded[..encoded.len() - 2]).is_err());
}

/// The file mode, where the platform has one.
#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn generating_an_identity_reports_it_and_inspecting_agrees() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");

    let generated = generate_identity_file(&path, false).unwrap();
    assert_eq!(generated.info.key_type, "Ed25519");
    assert!(generated.replaced.is_none());
    assert!(!generated.info.insecure_permissions());

    // Reading the file back must describe the same key, byte for byte: this is
    // what makes `inspect` an answer about the file rather than about whatever
    // the tool happened to hold in memory.
    let inspected = inspect_identity_file(&path).unwrap();
    assert_eq!(inspected.peer_id, generated.info.peer_id);
    assert_eq!(inspected.public_key, generated.info.public_key);
    assert_eq!(inspected.file_sha256, generated.info.file_sha256);

    // And the node must accept it as its own identity, unchanged.
    let loaded = load_or_create_identity(&path).unwrap();
    assert_eq!(loaded.public().to_peer_id(), generated.info.peer_id);

    #[cfg(unix)]
    assert_eq!(mode_of(&path), 0o600);
}

#[test]
fn generating_over_an_existing_key_refuses_and_leaves_it_untouched() {
    // The failure this guards is unrecoverable: a clobbered node key cannot be
    // recomputed, and the peer reputation scored against it is gone with it.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");

    let first = generate_identity_file(&path, false).unwrap();
    let before = fs::read(&path).unwrap();

    let error = generate_identity_file(&path, false).unwrap_err();
    assert!(
        matches!(&error, Error::IdentityIo(io) if io.kind() == std::io::ErrorKind::AlreadyExists),
        "expected an already-exists refusal, got {error}"
    );

    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        inspect_identity_file(&path).unwrap().peer_id,
        first.info.peer_id
    );
}

#[test]
fn forcing_replaces_the_key_and_names_the_one_it_retired() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");

    let first = generate_identity_file(&path, false).unwrap();
    let second = generate_identity_file(&path, true).unwrap();

    assert_eq!(second.replaced, Some(first.info.peer_id));
    assert_ne!(second.info.peer_id, first.info.peer_id);
    assert_eq!(
        inspect_identity_file(&path).unwrap().peer_id,
        second.info.peer_id
    );
    // The replacement is written through a temporary that must not survive.
    assert!(!dir.path().join("p2p_identity.pb.tmp").exists());
    #[cfg(unix)]
    assert_eq!(mode_of(&path), 0o600);
}

#[test]
fn forcing_onto_a_fresh_path_replaces_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("p2p_identity.pb");

    let generated = generate_identity_file(&path, true).unwrap();
    assert!(generated.replaced.is_none());
    assert_eq!(
        inspect_identity_file(&path).unwrap().peer_id,
        generated.info.peer_id
    );
}

#[test]
fn inspecting_never_creates_a_key() {
    // `load_or_create_identity` mints on a miss. An operator asking which key is
    // on a host must get an error for a mistyped path, not a brand new identity
    // and a confident wrong answer.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("absent.pb");

    assert!(inspect_identity_file(&path).is_err());
    assert!(!path.exists());
}

#[test]
fn inspecting_a_file_that_is_not_a_key_is_an_error() {
    let dir = tempfile::tempdir().unwrap();

    let empty = dir.path().join("empty.pb");
    fs::write(&empty, []).unwrap();
    assert!(inspect_identity_file(&empty).is_err());

    let garbage = dir.path().join("garbage.pb");
    fs::write(&garbage, b"not a protobuf keypair").unwrap();
    assert!(inspect_identity_file(&garbage).is_err());

    // A truncated key file: the right prefix, not enough bytes.
    let truncated = dir.path().join("truncated.pb");
    let whole = {
        let path = dir.path().join("whole.pb");
        generate_identity_file(&path, false).unwrap();
        fs::read(path).unwrap()
    };
    fs::write(&truncated, &whole[..whole.len() / 2]).unwrap();
    assert!(inspect_identity_file(&truncated).is_err());
}

#[cfg(unix)]
#[test]
fn a_group_readable_key_file_is_reported_as_insecure() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");
    generate_identity_file(&path, false).unwrap();
    assert!(!inspect_identity_file(&path).unwrap().insecure_permissions());

    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let info = inspect_identity_file(&path).unwrap();
    assert_eq!(info.file_mode, Some(0o644));
    assert!(info.insecure_permissions());
}

#[test]
fn a_bootstrap_address_is_the_transport_address_plus_the_peer_id() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p2p_identity.pb");
    let peer_id = generate_identity_file(&path, false).unwrap().info.peer_id;

    let transport: Multiaddr = "/ip4/203.0.113.7/tcp/8646".parse().unwrap();
    let bootstrap = bootstrap_address(&transport, peer_id);

    assert_eq!(
        bootstrap.to_string(),
        format!("/ip4/203.0.113.7/tcp/8646/p2p/{peer_id}")
    );
    // It is exactly what the dialer takes apart again, which is the property
    // that matters: `add-peer` must accept what `p2p-key --addr` prints.
    assert_eq!(peer_id_of(&bootstrap), Some(peer_id));
    let target = DialTarget::parse(bootstrap.clone()).unwrap();
    assert_eq!(target.peer, peer_id);
    assert_eq!(target.address, bootstrap);
    assert_eq!(target.dial_opts().get_peer_id(), Some(peer_id));
    assert!(DialTarget::parse(transport).is_err());
    for endpoint in [
        "/ip4/127.0.0.1/udp/8646",
        "/ip4/0.0.0.0/tcp/8646",
        "/ip4/127.0.0.1/tcp/0",
    ] {
        assert!(DialTarget::parse(format!("{endpoint}/p2p/{peer_id}").parse().unwrap()).is_err());
    }
}

#[test]
fn content_hashes_commit_to_exact_bytes() {
    assert_ne!(content_hash(b"a"), content_hash(b"a\0"));
    assert_eq!(
        content_hash(b""),
        alloy_primitives::b256!("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
    );
}

// libp2p request IDs are opaque. Capture real IDs from one behaviour rather
// than assuming its representation or adding a production test constructor.
async fn inbound_requests(
    count: usize,
) -> Vec<(
    libp2p::request_response::InboundRequestId,
    libp2p::request_response::ResponseChannel<SyncResponse>,
)> {
    use futures::StreamExt;
    use libp2p::{request_response, swarm::SwarmEvent};
    let build = || {
        libp2p::SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                libp2p::tcp::Config::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )
            .unwrap()
            .with_behaviour(|_| {
                request_response::cbor::Behaviour::<SyncRequest, SyncResponse>::new(
                    [(
                        libp2p::StreamProtocol::new("/budget-test"),
                        request_response::ProtocolSupport::Full,
                    )],
                    request_response::Config::default().with_max_concurrent_streams(64),
                )
            })
            .unwrap()
            .build()
    };
    let mut receiver = build();
    receiver
        .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
        .unwrap();
    let address = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let SwarmEvent::NewListenAddr { address, .. } = receiver.select_next_some().await {
                break address;
            }
        }
    })
    .await
    .expect("request-ID fixture listener did not start");
    let peer = *receiver.local_peer_id();
    let mut sender = build();
    sender.dial(bootstrap_address(&address, peer)).unwrap();
    for _ in 0..count {
        sender.behaviour_mut().send_request(
            &peer,
            SyncRequest {
                capability: capability(77, B256::ZERO),
                request: SyncRequestKind::Capability,
            },
        );
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut ids = Vec::new();
        while ids.len() < count {
            tokio::select! {
                _ = sender.select_next_some() => {},
                event = receiver.select_next_some() => {
                    if let SwarmEvent::Behaviour(request_response::Event::Message {
                        message: request_response::Message::Request { request_id, channel, .. }, ..
                    }) = event {
                        ids.push((request_id, channel));
                    }
                }
            }
        }
        ids
    })
    .await
    .expect("request IDs were not delivered")
}

async fn inbound_request_ids(count: usize) -> Vec<libp2p::request_response::InboundRequestId> {
    inbound_requests(count)
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

#[tokio::test]
async fn inbound_get_budget_is_global_and_per_peer_across_connections() {
    let first = Keypair::generate_ed25519().public().to_peer_id();
    let second = Keypair::generate_ed25519().public().to_peer_id();
    let third = Keypair::generate_ed25519().public().to_peer_id();
    let ids = inbound_request_ids(6).await;
    let mut budget = InboundGetBudget::with_limits(2, 1, 100, 70);

    assert!(budget.reserve(ids[0], first, 60));
    assert!(!budget.reserve(ids[1], first, 1), "per-peer response count");
    assert!(budget.reserve(ids[2], second, 40));
    assert!(
        !budget.reserve(ids[3], third, 1),
        "node-wide response count"
    );

    budget.release(ids[0]);
    assert!(!budget.reserve(ids[4], third, 61), "node-wide byte budget");
    assert!(budget.reserve(ids[5], third, 60));
}

#[tokio::test]
async fn inbound_get_budget_rejects_one_peer_exceeding_its_byte_share() {
    let peer = Keypair::generate_ed25519().public().to_peer_id();
    let ids = inbound_request_ids(3).await;
    let mut budget = InboundGetBudget::with_limits(4, 2, 1_000, 100);
    assert!(budget.reserve(ids[0], peer, 70));
    assert!(!budget.reserve(ids[1], peer, 31));
    budget.release(ids[0]);
    assert!(budget.reserve(ids[2], peer, 100));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gossip_waits_for_acceptance_before_forwarding() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "b.key", 77, B256::repeat_byte(0x40));
    let (b, mut b_events) = start(base.clone()).await.unwrap();
    let b_listen = listen_address(&mut b_events).await;
    let b_bootstrap = bootstrap_address(&b_listen, b.peer_id());

    let (a, _a_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "a.key"),
        bootstrap: vec![b_bootstrap.clone()],
        ..base.clone()
    })
    .await
    .unwrap();
    let (c, mut c_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "c.key"),
        bootstrap: vec![b_bootstrap],
        ..base
    })
    .await
    .unwrap();

    wait_for_peer_count(&a, 1).await;
    wait_for_peer_count(&c, 1).await;
    wait_for_peer_count(&b, 2).await;
    // Gossipsub exchanges subscriptions on its heartbeat after the TCP
    // connection is established.
    tokio::time::sleep(Duration::from_millis(1_250)).await;

    let bytes = vec![0x10, 0x20, 0x30];
    a.announce(bytes.clone()).await.unwrap();
    let (source, received, token) = next_candidate(&mut b_events).await;
    assert_eq!(source, a.peer_id());
    assert_eq!(received, bytes);
    assert!(matches!(
        &token,
        CandidateOrigin::Gossip {
            propagation_source,
            ..
        } if *propagation_source == a.peer_id()
    ));

    assert_no_candidate(&mut c_events, Duration::from_millis(300)).await;
    b.report_validation(token, ValidationResult::Accept)
        .await
        .unwrap();

    let (source, received, token) = next_candidate(&mut c_events).await;
    assert_eq!(
        source,
        a.peer_id(),
        "publisher attribution must survive forwarding"
    );
    assert_eq!(received, bytes);
    assert!(matches!(
        token,
        CandidateOrigin::Gossip {
            propagation_source,
            ..
        } if propagation_source == b.peer_id()
    ));

    c.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rejected_and_ignored_gossip_is_not_forwarded() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "b.key", 77, B256::repeat_byte(0x41));
    let (b, mut b_events) = start(base.clone()).await.unwrap();
    let b_listen = listen_address(&mut b_events).await;
    let b_bootstrap = bootstrap_address(&b_listen, b.peer_id());
    let (a, _a_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "a.key"),
        bootstrap: vec![b_bootstrap.clone()],
        ..base.clone()
    })
    .await
    .unwrap();
    let (c, mut c_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "c.key"),
        bootstrap: vec![b_bootstrap],
        ..base
    })
    .await
    .unwrap();

    wait_for_peer_count(&a, 1).await;
    wait_for_peer_count(&c, 1).await;
    wait_for_peer_count(&b, 2).await;
    tokio::time::sleep(Duration::from_millis(1_250)).await;

    for (bytes, result) in [
        (vec![0xde, 0xad], ValidationResult::Reject),
        (vec![0xbe, 0xef], ValidationResult::Ignore),
    ] {
        a.announce(bytes.clone()).await.unwrap();
        let (source, received, token) = next_candidate(&mut b_events).await;
        assert_eq!(source, a.peer_id());
        assert_eq!(received, bytes);
        b.report_validation(token, result).await.unwrap();
        assert_no_candidate(&mut c_events, Duration::from_millis(750)).await;
    }

    c.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn different_network_identities_do_not_exchange_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let a_config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x44));
    let initial = vec![4, 4, 4];
    let (a, mut a_events) = start_with_inventory(
        a_config.clone(),
        vec![InventoryEntry {
            content_hash: content_hash(&initial),
            tx_bytes: initial,
        }],
    )
    .await
    .unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let (b, mut b_events) = start(P2pConfig {
        connectivity: crate::ConnectivityConfig::disabled(),
        chain_id: 78,
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![bootstrap_address(&a_listen, a.peer_id())],
        fork_capability: capability(78, B256::repeat_byte(0x44)),
        ..a_config
    })
    .await
    .unwrap();

    // Noise/TCP connectivity is independent of the PCASH topic and sync
    // protocol identity, so this proves isolation above the transport.
    wait_for_peer_count(&a, 1).await;
    wait_for_peer_count(&b, 1).await;
    tokio::time::sleep(Duration::from_millis(1_250)).await;
    a.announce(vec![5, 5, 5]).await.unwrap();
    assert_no_candidate(&mut b_events, Duration::from_millis(750)).await;

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test]
async fn late_peer_fetches_paginated_inventory_as_untrusted_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let base = P2pConfig {
        connectivity: crate::ConnectivityConfig::disabled(),
        chain_id: 77,
        genesis_hash: B256::repeat_byte(0x42),
        identity: identity_at(dir.path(), "a.key"),
        listen: "/ip4/127.0.0.1/tcp/0".parse().unwrap(),
        bootstrap: Vec::new(),
        // Force every ID onto a separate page so the test covers cursor
        // pagination as well as the fetch path.
        max_inventory: 1,
        anti_entropy_interval: Duration::from_millis(100),
        fork_capability: capability(77, B256::repeat_byte(0x42)),
        peer_ban_duration: PEER_BAN_DURATION,
    };
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(P2pEvent::Listening(addr)) = a_events.recv().await {
                break addr;
            }
        }
    })
    .await
    .unwrap();

    let expected = [vec![2, 7, 9], vec![3, 1, 4], vec![8, 6, 5]];
    a.replace_inventory(
        expected
            .iter()
            .cloned()
            .map(|tx_bytes| InventoryEntry {
                content_hash: content_hash(&tx_bytes),
                tx_bytes,
            })
            .collect(),
    )
    .await
    .unwrap();

    let mut bootstrap = a_listen;
    bootstrap.push(Protocol::P2p(a.peer_id()));
    let (b, mut b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![bootstrap],
        ..base
    })
    .await
    .unwrap();

    let candidates = tokio::time::timeout(Duration::from_secs(10), async {
        let mut candidates = BTreeMap::new();
        while candidates.len() < expected.len() {
            if let Some(P2pEvent::Candidate { tx_bytes, origin }) = b_events.recv().await {
                assert_eq!(origin.publisher(), a.peer_id());
                assert!(matches!(
                    origin,
                    CandidateOrigin::Sync { peer } if peer == a.peer_id()
                ));
                candidates.insert(content_hash(&tx_bytes), tx_bytes);
            }
        }
        candidates
    })
    .await
    .unwrap();
    assert_eq!(candidates.len(), expected.len());
    for tx_bytes in expected {
        assert_eq!(candidates.get(&content_hash(&tx_bytes)), Some(&tx_bytes));
    }

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test]
async fn connected_peer_reconciles_new_inventory_without_reconnecting() {
    let dir = tempfile::tempdir().unwrap();
    let base = P2pConfig {
        connectivity: crate::ConnectivityConfig::disabled(),
        chain_id: 77,
        genesis_hash: B256::repeat_byte(0x43),
        identity: identity_at(dir.path(), "a.key"),
        listen: "/ip4/127.0.0.1/tcp/0".parse().unwrap(),
        bootstrap: Vec::new(),
        max_inventory: 8,
        anti_entropy_interval: Duration::from_millis(100),
        fork_capability: capability(77, B256::repeat_byte(0x43)),
        peer_ban_duration: PEER_BAN_DURATION,
    };
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(P2pEvent::Listening(addr)) = a_events.recv().await {
                break addr;
            }
        }
    })
    .await
    .unwrap();
    let mut bootstrap = a_listen;
    bootstrap.push(Protocol::P2p(a.peer_id()));
    let (b, mut b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![bootstrap],
        ..base
    })
    .await
    .unwrap();

    wait_for_peer_count(&b, 1).await;
    // Let at least one empty initial/periodic round finish, then add an item
    // while the same connection remains established.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let tx_bytes = vec![9, 8, 7];
    a.replace_inventory(vec![InventoryEntry {
        content_hash: content_hash(&tx_bytes),
        tx_bytes: tx_bytes.clone(),
    }])
    .await
    .unwrap();

    let candidate = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(P2pEvent::Candidate { tx_bytes, origin }) = b_events.recv().await {
                break (origin.publisher(), tx_bytes, origin);
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(candidate.0, a.peer_id());
    assert_eq!(candidate.1, tx_bytes);
    assert!(matches!(candidate.2, CandidateOrigin::Sync { .. }));

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_owner_channel_drops_candidates_without_stalling_the_swarm() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x46));
    let (a, mut a_events) = start_with_event_capacity(base.clone(), 1).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let (b, mut b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![bootstrap_address(&a_listen, a.peer_id())],
        ..base
    })
    .await
    .unwrap();
    let drain_b = tokio::spawn(async move { while b_events.recv().await.is_some() {} });

    wait_for_compatible_peer(&a).await;
    wait_for_compatible_peer(&b).await;
    // Connection establishment precedes gossipsub mesh formation.
    tokio::time::sleep(Duration::from_millis(1_250)).await;

    b.announce(vec![1, 2, 3]).await.unwrap();
    b.announce(vec![4, 5, 6]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let received = a.peer(b.peer_id()).map_or(0, |peer| peer.tx_received);
            if received >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("both candidates did not reach the receiving swarm");

    // Both messages reached A, but its capacity-one owner channel contains
    // only one event. At least one candidate therefore exercised the full/drop
    // path before the liveness assertions below.
    assert_eq!(a_events.len(), 1);
    let tx_bytes = vec![9, 8, 7];
    tokio::time::timeout(
        Duration::from_secs(2),
        a.replace_inventory(vec![InventoryEntry {
            content_hash: content_hash(&tx_bytes),
            tx_bytes,
        }]),
    )
    .await
    .expect("inventory replacement stalled behind the full owner channel")
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), a.shutdown())
        .await
        .expect("shutdown stalled behind the full owner channel")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), b.shutdown())
        .await
        .expect("publisher shutdown stalled")
        .unwrap();
    drain_b.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_is_listed_on_connect_and_only_becomes_compatible_after_the_handshake() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x50));
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let (b, _b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![bootstrap_address(&a_listen, a.peer_id())],
        ..base
    })
    .await
    .unwrap();

    // The peer is visible the moment the connection is established, before it
    // has proved anything. A listing and a count come from one table, so they
    // agree even in this window.
    wait_for_peer_count(&b, 1).await;
    let listed = b.peers();
    assert_eq!(listed.len(), b.peer_count());
    assert_eq!(listed[0].peer_id, a.peer_id());
    assert_eq!(listed[0].direction, Direction::Outbound, "b dialed a");

    wait_for_compatible_peer(&b).await;
    let peer = b.peer(a.peer_id()).expect("peer is still listed");
    assert!(peer.compatible);
    assert!(peer.incompatible_reason.is_none());
    assert_eq!(
        peer.capability.expect("capability recorded").genesis_hash,
        B256::repeat_byte(0x50)
    );

    // a accepted the connection, so it sees the mirror-image direction.
    wait_for_peer_count(&a, 1).await;
    assert_eq!(a.peers()[0].direction, Direction::Inbound);

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_head_advance_keeps_peers_compatible_and_a_fork_change_rehandshakes() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x51));
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let (b, _b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![bootstrap_address(&a_listen, a.peer_id())],
        ..base.clone()
    })
    .await
    .unwrap();
    wait_for_compatible_peer(&b).await;

    // The head moves every block. Commands are handled in order, so once the
    // follow-up round trip returns the update has been applied, and the peer
    // must not have been knocked back into a handshake.
    let advanced = ForkCapability {
        head_timestamp: base.fork_capability.head_timestamp + 12,
        ..base.fork_capability
    };
    b.try_update_fork_capability(advanced).unwrap();
    b.sync_session_peers().await;
    let peer = b.peer(a.peer_id()).expect("peer is still listed");
    assert!(peer.compatible, "a head-only advance reset the handshake");
    assert!(peer.capability.is_some());

    // A change to the fork rules is re-checked against every peer.
    let forked = ForkCapability {
        current_prefix_hash: B256::repeat_byte(0x22),
        ..advanced
    };
    b.try_update_fork_capability(forked).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while b
            .peer(a.peer_id())
            .is_none_or(|peer| peer.incompatible_reason.is_none())
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a fork change did not re-handshake the peer");
    assert!(!b.peer(a.peer_id()).unwrap().compatible);

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connection_uptime_advances_without_any_peer_traffic() {
    // `connected_for` is computed when the snapshot is built, so it only
    // advances because the swarm republishes on a timer. An idle connection is
    // exactly the case where nothing else would trigger a publish.
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x55));
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let (b, _b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![bootstrap_address(&a_listen, a.peer_id())],
        ..base
    })
    .await
    .unwrap();
    wait_for_peer_count(&b, 1).await;

    let first = b.peer(a.peer_id()).unwrap().connected_for;
    tokio::time::sleep(PEER_PUBLISH_INTERVAL * 2 + Duration::from_millis(200)).await;
    let later = b.peer(a.peer_id()).unwrap().connected_for;
    assert!(
        later > first,
        "uptime stalled at {first:?} on an idle connection"
    );

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn identify_and_ping_populate_peer_details() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x51));
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let (b, _b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![bootstrap_address(&a_listen, a.peer_id())],
        ..base
    })
    .await
    .unwrap();

    wait_for_peer_count(&b, 1).await;
    let peer = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(peer) = b
                .peer(a.peer_id())
                .filter(|peer| peer.protocol_version.is_some() && peer.rtt.is_some())
            {
                break peer;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("identify and ping details were not recorded");
    assert_eq!(peer.protocol_version.as_deref(), Some("/pcash/mempool/1"));
    assert!(peer.agent_version.is_some());

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn add_peer_connects_a_node_started_with_no_bootstrap() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x52));
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    // b knows nothing about a: no bootstrap entry at all.
    let (b, _b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        ..base
    })
    .await
    .unwrap();
    assert_eq!(b.peer_count(), 0);

    let address = bootstrap_address(&a_listen, a.peer_id());
    assert_eq!(b.add_peer(address.clone()).await.unwrap(), a.peer_id());
    wait_for_peer_count(&b, 1).await;
    wait_for_compatible_peer(&b).await;

    // Adding the same peer twice is not an error, and does not duplicate it.
    assert_eq!(b.add_peer(address).await.unwrap(), a.peer_id());
    assert_eq!(b.peer_count(), 1);

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn add_peer_rejects_an_address_that_names_no_peer() {
    let dir = tempfile::tempdir().unwrap();
    let (a, _events) = start(test_config(
        dir.path(),
        "a.key",
        77,
        B256::repeat_byte(0x53),
    ))
    .await
    .unwrap();

    let error = a
        .add_peer("/ip4/127.0.0.1/tcp/1".parse().unwrap())
        .await
        .expect_err("an address with no /p2p/ component is not dialable");
    assert!(
        error.to_string().contains("/p2p/"),
        "unhelpful error: {error}"
    );
    assert_eq!(a.peer_count(), 0);

    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_banned_peer_is_disconnected_and_not_redialed() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x54));
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let address = bootstrap_address(&a_listen, a.peer_id());
    // Reach a through the redial set, which is what a ban has to overcome.
    let (b, _b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![address.clone()],
        ..base
    })
    .await
    .unwrap();
    wait_for_peer_count(&b, 1).await;

    assert!(b.remove_peer(a.peer_id(), true).await.unwrap());
    wait_for_peer_count(&b, 0).await;

    // The redial loop runs every DIAL_RETRY_INITIAL; the ban must survive
    // more than one tick, and re-adding the peer must be refused while it holds.
    tokio::time::sleep(DIAL_RETRY_INITIAL + Duration::from_millis(500)).await;
    assert_eq!(b.peer_count(), 0, "a banned peer was redialed");
    let error = b
        .add_peer(address)
        .await
        .expect_err("a banned peer cannot be added back");
    assert!(error.to_string().contains("banned"), "{error}");

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_score_triggered_ban_keeps_the_address_and_redials_after_it_expires() {
    // A score ban is temporary, so it must disconnect without forgetting how to
    // reach the peer: dropping the address would leave the redial loop nothing
    // to retry and silently make the ban permanent. Only an explicit
    // `remove_peer` forgets. The ban test above uses explicit removal and so
    // cannot catch this.
    let dir = tempfile::tempdir().unwrap();
    // A ban short enough to outlast inside a test. The redial loop ticks every
    // DIAL_RETRY_INITIAL, so the ban must expire well inside one tick for
    // the reconnection to be attributable to the address having survived.
    let ban = Duration::from_secs(1);
    let base = P2pConfig {
        peer_ban_duration: ban,
        ..test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x56))
    };
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let address = bootstrap_address(&a_listen, a.peer_id());
    let (b, mut b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![address.clone()],
        ..base
    })
    .await
    .unwrap();
    wait_for_peer_count(&b, 1).await;
    wait_for_compatible_peer(&b).await;
    // Connection establishment precedes gossipsub mesh formation; publishing
    // before the first heartbeat exchanges subscriptions reaches nobody.
    tokio::time::sleep(Duration::from_millis(1_250)).await;

    // Drive a's score down on b by rejecting enough of a's candidates. Each
    // publication reaches b as a gossip candidate; reporting `Reject` is what
    // local admission does for bytes that cannot be valid under any state.
    // Stop as soon as the ban lands rather than assuming a rejection count: the
    // peer is disconnected the moment it crosses the threshold, so one more
    // publication after that would never arrive.
    let attempts = (PEER_SCORE_BAN_THRESHOLD / PEER_SCORE_REJECTED).unsigned_abs() as usize;
    for nonce in 0..attempts {
        a.announce(vec![0xde, 0xad, nonce as u8]).await.unwrap();
        let (_, _, token) = next_candidate(&mut b_events).await;
        b.report_validation(token, ValidationResult::Reject)
            .await
            .unwrap();
    }

    // The ban disconnects the peer...
    tokio::time::timeout(Duration::from_secs(10), async {
        while b.peer_count() != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a peer that crossed the ban threshold was not disconnected");

    // ...and while it holds, the peer is refused.
    let error = b
        .add_peer(address.clone())
        .await
        .expect_err("the peer is still banned");
    assert!(error.to_string().contains("banned"), "{error}");

    // ...and once it lapses the ordinary redial loop reaches for the peer again
    // on its own. This is the assertion that separates a temporary ban from
    // permanent forgetting: nothing here re-supplies the address, so a redial
    // attempt can only come from the address the ban left in place.
    //
    // The attempt is what is asserted, not a completed connection. Both nodes
    // are on loopback and libp2p reuses the listen port for outgoing dials, so
    // an immediate re-dial to the same remote reliably loses a race with the
    // kernel's TIME_WAIT and fails with EADDRINUSE. That is an artifact of the
    // test's environment; whether the address survived is the behavior at issue.
    // Either outcome proves it: the connection comes back, or the attempt is
    // reported as having failed. Both are polled rather than awaited, because a
    // redial that succeeds emits no event at all — waiting only on the event
    // stream would hang on exactly the happy path.
    let peer = a.peer_id().to_string();
    tokio::time::timeout(DIAL_RETRY_INITIAL * 3, async {
        loop {
            if b.peer_count() > 0 {
                return;
            }
            while let Ok(event) = b_events.try_recv() {
                if matches!(&event, P2pEvent::Warning(message) if message.contains(&peer)) {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the ban expired but the peer was never redialed");

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removing_a_peer_disconnects_it_and_it_stays_gone() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x57));
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let address = bootstrap_address(&a_listen, a.peer_id());
    let (b, _b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        ..base
    })
    .await
    .unwrap();

    // No await between these two, so the dial cannot have completed.
    b.add_peer(address).await.unwrap();
    b.remove_peer(a.peer_id(), false).await.unwrap();

    // Give the dial every chance to land and be accepted.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        b.peer_count(),
        0,
        "a dial completed after the peer was removed"
    );

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[test]
fn reputation_pruning_keeps_bans_and_drops_neutral_entries() {
    let now = Instant::now();
    let mut reputation = HashMap::new();
    let banned = Keypair::generate_ed25519().public().to_peer_id();
    let negative = Keypair::generate_ed25519().public().to_peer_id();
    reputation.insert(
        banned,
        Reputation {
            score: 0,
            banned_until: Some(now + Duration::from_mins(1)),
        },
    );
    reputation.insert(
        negative,
        Reputation {
            score: -30,
            banned_until: None,
        },
    );
    for _ in 0..MAX_TRACKED_REPUTATIONS {
        reputation.insert(
            Keypair::generate_ed25519().public().to_peer_id(),
            Reputation::default(),
        );
    }

    prune_reputation(&mut reputation, now);
    assert!(reputation.len() <= MAX_TRACKED_REPUTATIONS);
    assert!(reputation.contains_key(&banned), "a ban was pruned away");
    assert!(
        reputation.contains_key(&negative),
        "a negative score was pruned away"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capability_handshakes_schedule_inventory_without_starvation() {
    // One central syncer facing more compatible publishers than
    // MAX_CONCURRENT_SYNC_PEERS allows. The
    // capability-response path must schedule through the bounded scheduler:
    //   * the observed peak of distinct in-flight sessions stays at or below
    //     the cap while still exceeding one round (the gate actually ran —
    //     an ungated responder would start every publisher at once),
    //   * every compatible publisher is eventually scheduled (bounded must
    //     not mean starved),
    let dir = tempfile::tempdir().unwrap();
    let base = P2pConfig {
        connectivity: crate::ConnectivityConfig::disabled(),
        chain_id: 77,
        genesis_hash: B256::repeat_byte(0x44),
        identity: identity_at(dir.path(), "c.key"),
        listen: "/ip4/127.0.0.1/tcp/0".parse().unwrap(),
        bootstrap: Vec::new(),
        // One id per page keeps each session multi-request, so overlapping
        // sessions are observable rather than instantaneous.
        max_inventory: 1,
        anti_entropy_interval: Duration::from_millis(50),
        peer_ban_duration: PEER_BAN_DURATION,
        fork_capability: capability(77, B256::repeat_byte(0x44)),
    };
    let (central, mut central_events) = start(base).await.unwrap();
    let central_listen = listen_address(&mut central_events).await;

    const PUBLISHERS: usize = 6;
    const { assert!(PUBLISHERS > crate::MAX_CONCURRENT_SYNC_PEERS) };
    let mut publishers = Vec::new();
    for index in 0..PUBLISHERS {
        let (handle, events) = start(P2pConfig {
            connectivity: crate::ConnectivityConfig::disabled(),
            chain_id: 77,
            genesis_hash: B256::repeat_byte(0x44),
            identity: identity_at(dir.path(), &format!("p{index}.key")),
            listen: "/ip4/127.0.0.1/tcp/0".parse().unwrap(),
            bootstrap: vec![{
                let mut addr = central_listen.clone();
                addr.push(Protocol::P2p(central.peer_id()));
                addr
            }],
            max_inventory: 8,
            anti_entropy_interval: Duration::from_millis(50),
            peer_ban_duration: PEER_BAN_DURATION,
            fork_capability: capability(77, B256::repeat_byte(0x44)),
        })
        .await
        .unwrap();
        // Many entries per publisher: with the syncer paging one id at a
        // time, each session spans dozens of request round trips, so
        // overlapping sessions are reliably observable.
        let entries = (0u8..40)
            .map(|k| {
                let payload = vec![0xE0u8 + index as u8, k];
                InventoryEntry {
                    content_hash: content_hash(&payload),
                    tx_bytes: payload,
                }
            })
            .collect();
        handle.replace_inventory(entries).await.unwrap();
        publishers.push((handle, events));
    }

    // Drain with two invariants held simultaneously:
    //   * at every observation, distinct peers with an in-flight inventory
    //     session never exceed MAX_CONCURRENT_SYNC_PEERS,
    //   * every compatible publisher is eventually scheduled (its unique
    //     item arrives), so bounded never means starved.
    let mut scheduled = std::collections::HashSet::new();
    let mut observed_peak = 0usize;
    // Generous budget: this topology spawns eight real swarms and must stay
    // green on a loaded CI runner, not just an idle workstation.
    tokio::time::timeout(Duration::from_mins(2), async {
        loop {
            let sessions = central.sync_session_peers().await;
            if sessions.len() > observed_peak {
                observed_peak = sessions.len();
            }
            assert!(
                sessions.len() <= crate::MAX_CONCURRENT_SYNC_PEERS,
                "{} concurrent sessions exceeded MAX_CONCURRENT_SYNC_PEERS",
                sessions.len()
            );
            for peer in &sessions {
                scheduled.insert(*peer);
            }
            // Drain everything pending so the swarm's event channel cannot
            // back up while we wait on the command round trip below.
            while let Ok(event) = central_events.try_recv() {
                if let P2pEvent::Candidate { tx_bytes, origin } = event {
                    assert!(matches!(origin, CandidateOrigin::Sync { .. }));
                    assert_eq!(tx_bytes.len(), 2);
                    scheduled.insert(origin.publisher());
                }
            }
            if scheduled.len() == PUBLISHERS {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("every publisher scheduled without exceeding the session cap");
    assert_eq!(scheduled.len(), PUBLISHERS);

    for (handle, _) in publishers {
        handle.shutdown().await.unwrap();
    }
    central.shutdown().await.unwrap();
}

#[test]
fn sync_candidate_selection_filters_and_orders_deterministically() {
    // The scheduler's selection policy, exercised without a live swarm:
    // only compatible peers are eligible, in-flight peers are skipped, and
    // ordering is never-synced first then round-robin by sequence with a
    // peer-id tiebreak — which is what keeps the MAX_CONCURRENT_SYNC_PEERS
    // rotation fair and keeps incompatible peers permanently ineligible.
    let peer = |_| PeerId::random();
    let mut peers = BTreeMap::new();
    let state = |seq: u64| {
        let mut s = PeerState::new(Direction::Outbound, "/ip4/127.0.0.1/tcp/0".parse().unwrap());
        s.compatible = true;
        s.sync_sequence = seq;
        s
    };
    let mut incompatible = state(0);
    incompatible.compatible = false;

    let p_never_a = peer(1); // compatible, never synced (seq 0)
    let p_never_b = peer(2); // compatible, never synced (seq 0)
    let p_round_robin = peer(3); // compatible, already served once (seq 5)
    let p_active = peer(4); // compatible but mid-session
    let p_hostile = peer(5);

    peers.insert(p_never_a, state(0));
    peers.insert(p_never_b, state(0));
    peers.insert(p_round_robin, state(5));
    peers.insert(p_active, state(0));
    peers.insert(p_hostile, incompatible);

    let active = HashSet::from([p_active]);
    let picked: Vec<PeerId> = select_sync_candidates(&peers, &active)
        .into_iter()
        .map(|(id, _)| id)
        .collect();

    // Both never-synced peers come first (their internal order is the
    // peer-id tiebreak), and the already-served peer is last.
    let first_two: std::collections::HashSet<PeerId> = picked[..2].iter().copied().collect();
    assert_eq!(
        first_two,
        std::collections::HashSet::from([p_never_a, p_never_b]),
        "never-synced compatible peers are scheduled first"
    );
    assert_eq!(picked[2], p_round_robin, "round-robin peer follows");
    assert_eq!(picked.len(), 3);
}

// Limits on peer input, exercised by a hand-driven libp2p peer that speaks the
// node's protocols but is free to break its rules.

#[derive(libp2p::swarm::NetworkBehaviour)]
struct RawBehaviour {
    gossip: libp2p::gossipsub::Behaviour,
    sync: libp2p::request_response::cbor::Behaviour<SyncRequest, SyncResponse>,
}

type RawResponder = Box<dyn FnMut(SyncRequestKind) -> Option<SyncResponseKind> + Send>;

/// Answers the way an honest peer with an empty pool would.
fn honest_empty_responder() -> RawResponder {
    Box::new(|request| {
        Some(match request {
            SyncRequestKind::Capability => SyncResponseKind::Capability,
            SyncRequestKind::Heads => SyncResponseKind::Heads { heads: Vec::new() },
            SyncRequestKind::Inventory { .. } => SyncResponseKind::Inventory {
                content_hashes: Vec::new(),
                next: None,
            },
            SyncRequestKind::Get { .. } => SyncResponseKind::Transactions {
                entries: Vec::new(),
            },
        })
    })
}

struct RawPeer {
    swarm: libp2p::Swarm<RawBehaviour>,
    capability: ForkCapability,
    topic: libp2p::gossipsub::IdentTopic,
    node: PeerId,
    connected: bool,
    node_subscribed: bool,
    /// `None` from the responder drops the channel without answering.
    responder: RawResponder,
    hold_inventory: bool,
    held_inventory: Vec<libp2p::request_response::ResponseChannel<SyncResponse>>,
    capability_requests: usize,
}

impl RawPeer {
    fn new(config: &P2pConfig, node: &P2pHandle, node_listen: &Multiaddr) -> Self {
        use libp2p::{gossipsub, request_response};
        let keypair = Keypair::generate_ed25519();
        let gossip_config = gossipsub::ConfigBuilder::default()
            .validation_mode(gossipsub::ValidationMode::Strict)
            // Wide enough to emit what the node must refuse.
            .max_transmit_size(2 * MAX_RELAYED_TX_BYTES)
            .build()
            .unwrap();
        let mut gossip = gossipsub::Behaviour::new(
            gossipsub::MessageAuthenticity::Signed(keypair.clone()),
            gossip_config,
        )
        .unwrap();
        let topic = gossipsub::IdentTopic::new(config.topic());
        gossip.subscribe(&topic).unwrap();
        let protocol = libp2p::StreamProtocol::try_from_owned(sync_protocol_for(
            config.chain_id,
            config.genesis_hash,
        ))
        .unwrap();
        let sync = request_response::cbor::Behaviour::new(
            [(protocol, request_response::ProtocolSupport::Full)],
            request_response::Config::default(),
        );
        let mut swarm = libp2p::SwarmBuilder::with_existing_identity(keypair)
            .with_tokio()
            .with_tcp(
                libp2p::tcp::Config::default().nodelay(true),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )
            .unwrap()
            .with_behaviour(|_| RawBehaviour { gossip, sync })
            .unwrap()
            .with_swarm_config(|cfg| cfg.with_idle_connection_timeout(Duration::from_mins(2)))
            .build();
        swarm
            .dial(bootstrap_address(node_listen, node.peer_id()))
            .unwrap();
        Self {
            swarm,
            capability: config.fork_capability,
            topic,
            node: node.peer_id(),
            connected: false,
            node_subscribed: false,
            responder: honest_empty_responder(),
            hold_inventory: false,
            held_inventory: Vec::new(),
            capability_requests: 0,
        }
    }

    fn peer_id(&self) -> PeerId {
        *self.swarm.local_peer_id()
    }

    /// Handle one swarm event; a response to one of our requests is returned.
    async fn step(
        &mut self,
    ) -> Option<(
        libp2p::request_response::OutboundRequestId,
        SyncResponseKind,
    )> {
        use futures::StreamExt;
        use libp2p::swarm::SwarmEvent;
        use libp2p::{gossipsub, request_response};
        match self.swarm.select_next_some().await {
            SwarmEvent::ConnectionEstablished { .. } => self.connected = true,
            SwarmEvent::ConnectionClosed { .. } => self.connected = false,
            SwarmEvent::Behaviour(RawBehaviourEvent::Gossip(gossipsub::Event::Subscribed {
                ..
            })) => self.node_subscribed = true,
            SwarmEvent::Behaviour(RawBehaviourEvent::Sync(request_response::Event::Message {
                message,
                ..
            })) => match message {
                request_response::Message::Request {
                    request, channel, ..
                } => {
                    if matches!(request.request, SyncRequestKind::Capability) {
                        self.capability_requests += 1;
                    }
                    if self.hold_inventory
                        && matches!(request.request, SyncRequestKind::Inventory { .. })
                    {
                        self.held_inventory.push(channel);
                    } else if let Some(response) = (self.responder)(request.request) {
                        let _ = self.swarm.behaviour_mut().sync.send_response(
                            channel,
                            SyncResponse {
                                capability: self.capability,
                                response,
                            },
                        );
                    }
                }
                request_response::Message::Response {
                    request_id,
                    response,
                } => return Some((request_id, response.response)),
            },
            _ => {}
        }
        None
    }

    async fn connect(&mut self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !self.connected {
                self.step().await;
            }
        })
        .await
        .expect("raw peer did not connect");
    }

    async fn request(&mut self, request: SyncRequestKind) -> SyncResponseKind {
        let capability = self.capability;
        let node = self.node;
        let id = self.swarm.behaviour_mut().sync.send_request(
            &node,
            SyncRequest {
                capability,
                request,
            },
        );
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some((request_id, response)) = self.step().await {
                    if request_id == id {
                        break response;
                    }
                }
            }
        })
        .await
        .expect("node did not answer the raw peer")
    }

    async fn publish(&mut self, data: Vec<u8>) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !self.node_subscribed {
                self.step().await;
            }
        })
        .await
        .expect("node never announced its subscription");
        let topic = self.topic.clone();
        self.swarm
            .behaviour_mut()
            .gossip
            .publish(topic, data)
            .expect("raw publish");
    }

    /// Keep the raw swarm polled while waiting for the node's next candidate.
    async fn drive_until_candidate(
        &mut self,
        events: &mut mpsc::Receiver<P2pEvent>,
        duration: Duration,
    ) -> Option<Vec<u8>> {
        tokio::time::timeout(duration, async {
            loop {
                tokio::select! {
                    event = events.recv() => {
                        if let Some(P2pEvent::Candidate { tx_bytes, .. }) = event {
                            break tx_bytes;
                        }
                    }
                    _ = self.step() => {}
                }
            }
        })
        .await
        .ok()
    }

    async fn drive_until_node_sees_compatibility(&mut self, handle: &P2pHandle) {
        let peer = self.peer_id();
        tokio::time::timeout(Duration::from_secs(10), async {
            while !handle.peer(peer).is_some_and(|info| info.compatible) {
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_millis(10)) => {}
                    _ = self.step() => {}
                }
            }
        })
        .await
        .expect("node never accounted the raw peer as compatible");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn head_advance_preserves_an_in_flight_inventory_session() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x71));
    let (node, mut events) = start(config.clone()).await.unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    raw.hold_inventory = true;
    let payload = b"during-head-advance".to_vec();
    let payload_content_hash = content_hash(&payload);
    raw.responder = Box::new(move |request| {
        Some(match request {
            SyncRequestKind::Capability => SyncResponseKind::Capability,
            SyncRequestKind::Heads => SyncResponseKind::Heads { heads: Vec::new() },
            SyncRequestKind::Inventory { .. } => SyncResponseKind::Inventory {
                content_hashes: vec![payload_content_hash],
                next: None,
            },
            SyncRequestKind::Get { .. } => SyncResponseKind::Transactions {
                entries: vec![payload.clone()],
            },
        })
    });
    raw.connect().await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while raw.held_inventory.is_empty() {
            raw.step().await;
        }
    })
    .await
    .expect("inventory request was not held");
    raw.drive_until_node_sees_compatibility(&node).await;
    let initial_probes = raw.capability_requests;
    assert!(node.sync_session_peers().await.contains(&raw.peer_id()));

    let mut advanced = config.fork_capability;
    advanced.head_timestamp += 1;
    node.try_update_fork_capability(advanced).unwrap();
    assert!(node.sync_session_peers().await.contains(&raw.peer_id()));
    assert!(node.peer(raw.peer_id()).unwrap().compatible);
    // Poll the transport so a new capability probe cannot hide in its queue.
    let _ = tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            raw.step().await;
        }
    })
    .await;
    assert_eq!(raw.capability_requests, initial_probes);

    raw.hold_inventory = false;
    let channel = raw.held_inventory.pop().unwrap();
    raw.swarm
        .behaviour_mut()
        .sync
        .send_response(
            channel,
            SyncResponse {
                capability: raw.capability,
                response: SyncResponseKind::Inventory {
                    content_hashes: vec![payload_content_hash],
                    next: None,
                },
            },
        )
        .unwrap();
    assert_eq!(
        raw.drive_until_candidate(&mut events, Duration::from_secs(10))
            .await,
        Some(b"during-head-advance".to_vec())
    );
    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fork_prefix_transition_preserves_inventory_and_rollback_rehandshakes() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x73));
    config.fork_capability.head_timestamp = 199;
    config.fork_capability.next_activation_timestamp = 200;
    config.fork_capability.next_prefix_hash = B256::repeat_byte(0x22);
    let (node, mut events) = start(config.clone()).await.unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    raw.hold_inventory = true;
    let payload = b"during-fork-transition".to_vec();
    let payload_content_hash = content_hash(&payload);
    raw.responder = Box::new(move |request| {
        Some(match request {
            SyncRequestKind::Capability => SyncResponseKind::Capability,
            SyncRequestKind::Heads => SyncResponseKind::Heads { heads: Vec::new() },
            SyncRequestKind::Inventory { .. } => SyncResponseKind::Inventory {
                content_hashes: vec![payload_content_hash],
                next: None,
            },
            SyncRequestKind::Get { .. } => SyncResponseKind::Transactions {
                entries: vec![payload.clone()],
            },
        })
    });
    raw.connect().await;
    raw.drive_until_node_sees_compatibility(&node).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while raw.held_inventory.is_empty() {
            raw.step().await;
        }
    })
    .await
    .expect("inventory request was not held");
    let initial_probes = raw.capability_requests;
    assert!(node.sync_session_peers().await.contains(&raw.peer_id()));

    let mut transitioned = config.fork_capability;
    transitioned.head_timestamp = 200;
    transitioned.current_fork_count = 1;
    transitioned.current_prefix_hash = config.fork_capability.next_prefix_hash;
    transitioned.next_activation_timestamp = 0;
    transitioned.next_prefix_hash = B256::ZERO;
    node.try_update_fork_capability(transitioned).unwrap();
    assert!(node.sync_session_peers().await.contains(&raw.peer_id()));
    tokio::time::timeout(Duration::from_secs(10), async {
        while raw.capability_requests == initial_probes {
            raw.step().await;
        }
    })
    .await
    .expect("fork transition did not rehandshake");

    raw.hold_inventory = false;
    let channel = raw.held_inventory.pop().unwrap();
    raw.swarm
        .behaviour_mut()
        .sync
        .send_response(
            channel,
            SyncResponse {
                capability: raw.capability,
                response: SyncResponseKind::Inventory {
                    content_hashes: vec![payload_content_hash],
                    next: None,
                },
            },
        )
        .unwrap();
    assert_eq!(
        raw.drive_until_candidate(&mut events, Duration::from_secs(10))
            .await,
        Some(b"during-fork-transition".to_vec())
    );

    let after_transition = raw.capability_requests;
    node.try_update_fork_capability(config.fork_capability)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if raw.capability_requests > after_transition
                && node.peer(raw.peer_id()).is_some_and(|info| info.compatible)
            {
                break;
            }
            tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(10)) => {}
                _ = raw.step() => {}
            }
        }
    })
    .await
    .expect("fork rollback did not rehandshake");
    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_inventory_uses_the_supplied_content_hashes_without_rehashing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x74));
    let bytes = b"locally-admitted".to_vec();
    let supplied_content_hash = B256::repeat_byte(0x99);
    assert_ne!(supplied_content_hash, content_hash(&bytes));
    let (node, mut events) = start_with_inventory(
        config.clone(),
        vec![InventoryEntry {
            content_hash: supplied_content_hash,
            tx_bytes: bytes.clone(),
        }],
    )
    .await
    .unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    raw.connect().await;
    match raw
        .request(SyncRequestKind::Inventory {
            after: None,
            limit: 1,
        })
        .await
    {
        SyncResponseKind::Inventory { content_hashes, .. } => {
            assert_eq!(content_hashes, vec![supplied_content_hash]);
        }
        other => panic!("expected inventory, got {other:?}"),
    }
    match raw
        .request(SyncRequestKind::Get {
            content_hashes: vec![supplied_content_hash],
        })
        .await
    {
        SyncResponseKind::Transactions { entries } => assert_eq!(entries, vec![bytes]),
        other => panic!("expected transactions, got {other:?}"),
    }
    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn peer_payload_with_the_wrong_advertised_content_hash_is_rejected() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x75));
    let (node, mut events) = start(config.clone()).await.unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    let good = b"advertised".to_vec();
    let advertised = content_hash(&good);
    let served_good = std::sync::Arc::new(AtomicBool::new(false));
    let served_good_in_peer = served_good.clone();
    let (get_tx, mut get_rx) = mpsc::unbounded_channel();
    raw.responder = Box::new(move |request| {
        Some(match request {
            SyncRequestKind::Capability => SyncResponseKind::Capability,
            SyncRequestKind::Heads => SyncResponseKind::Heads { heads: Vec::new() },
            SyncRequestKind::Inventory { .. } => SyncResponseKind::Inventory {
                content_hashes: vec![advertised],
                next: None,
            },
            SyncRequestKind::Get { .. } => {
                let good_response = served_good_in_peer.load(Ordering::Relaxed);
                let _ = get_tx.send(good_response);
                SyncResponseKind::Transactions {
                    entries: vec![if good_response {
                        good.clone()
                    } else {
                        b"wrong-bytes".to_vec()
                    }],
                }
            }
        })
    });
    raw.connect().await;
    let served_bad = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(good_response) = get_rx.try_recv() {
                break good_response;
            }
            tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(10)) => {}
                _ = raw.step() => {}
            }
        }
    })
    .await
    .expect("peer was not asked for the advertised payload");
    assert!(!served_bad);
    assert!(raw
        .drive_until_candidate(&mut events, Duration::from_millis(250))
        .await
        .is_none());
    served_good.store(true, Ordering::Relaxed);
    assert_eq!(
        raw.drive_until_candidate(&mut events, Duration::from_secs(10))
            .await,
        Some(b"advertised".to_vec())
    );
    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn oversized_gossip_is_rejected_before_it_reaches_the_owner() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x60));
    let (node, mut events) = start(config.clone()).await.unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    raw.connect().await;
    assert!(matches!(
        raw.request(SyncRequestKind::Capability).await,
        SyncResponseKind::Capability
    ));
    raw.drive_until_node_sees_compatibility(&node).await;

    // One byte over the ceiling still fits the node's gossipsub frame limit, so
    // it is the swarm's own check that has to refuse it. The follow-up message
    // travels the same ordered stream: it arriving first proves the oversized
    // one was dropped rather than merely delayed.
    raw.publish(vec![0xAB; MAX_RELAYED_TX_BYTES + 1]).await;
    let at_limit = vec![0xCD; MAX_RELAYED_TX_BYTES];
    raw.publish(at_limit.clone()).await;
    let delivered = raw
        .drive_until_candidate(&mut events, Duration::from_secs(10))
        .await
        .expect("a payload exactly at the limit is a candidate");
    assert!(delivered == at_limit, "the wrong payload was delivered");
    assert!(raw
        .drive_until_candidate(&mut events, Duration::from_millis(500))
        .await
        .is_none());
    // Counters are republished on a tick; two of them cover any staleness.
    tokio::time::sleep(PEER_PUBLISH_INTERVAL * 2).await;
    let info = node.peer(raw.peer_id()).expect("raw peer still connected");
    assert_eq!(info.tx_received, 1, "the oversized payload was accounted");
    assert_eq!(info.payload_bytes_received, MAX_RELAYED_TX_BYTES as u64);
    assert_eq!(
        info.score, PEER_SCORE_REJECTED,
        "the oversized payload cost its sender nothing"
    );

    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gossip_from_a_peer_without_a_completed_handshake_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x61));
    let (node, mut events) = start(config.clone()).await.unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    // Never answer the node's capability probe and never send one.
    raw.responder = Box::new(|_| None);
    raw.connect().await;

    raw.publish(b"before-handshake".to_vec()).await;
    assert!(
        raw.drive_until_candidate(&mut events, Duration::from_secs(1))
            .await
            .is_none(),
        "gossip from an unproven peer reached the owner"
    );
    let info = node.peer(raw.peer_id()).expect("raw peer is listed");
    assert!(!info.compatible);
    assert_eq!(info.tx_received, 0);

    // The same peer is heard once it proves its fork capability, so the
    // silence above is attributable to the handshake and nothing else.
    assert!(matches!(
        raw.request(SyncRequestKind::Capability).await,
        SyncResponseKind::Capability
    ));
    raw.drive_until_node_sees_compatibility(&node).await;
    raw.publish(b"after-handshake".to_vec()).await;
    let delivered = raw
        .drive_until_candidate(&mut events, Duration::from_secs(10))
        .await
        .expect("gossip after the handshake is a candidate");
    assert_eq!(delivered, b"after-handshake");

    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_inbound_get_over_the_id_limit_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x62));
    let payload = b"held".to_vec();
    let held = content_hash(&payload);
    let (node, mut events) = start_with_inventory(
        config.clone(),
        vec![InventoryEntry {
            content_hash: held,
            tx_bytes: payload.clone(),
        }],
    )
    .await
    .unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    raw.connect().await;

    let ids = |count: usize| {
        let mut ids = vec![held];
        ids.extend((1..count).map(|n| B256::left_padding_from(&(n as u64).to_be_bytes())));
        ids
    };
    match raw
        .request(SyncRequestKind::Get {
            content_hashes: ids(MAX_GET_IDS + 1),
        })
        .await
    {
        SyncResponseKind::Error(message) => assert_eq!(message, "fetch request exceeds limit"),
        other => panic!("expected an error, got {other:?}"),
    }
    // Exactly at the limit is served.
    match raw
        .request(SyncRequestKind::Get {
            content_hashes: ids(MAX_GET_IDS),
        })
        .await
    {
        SyncResponseKind::Transactions { entries } => assert_eq!(entries, vec![payload]),
        other => panic!("expected transactions, got {other:?}"),
    }

    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inbound_inventory_pages_are_clamped_and_seek_strictly_after_the_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let config = P2pConfig {
        // Above the hard page ceiling, so the ceiling is what clamps.
        max_inventory: MAX_INVENTORY_PAGE_IDS * 4,
        ..test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x63))
    };
    let total = MAX_INVENTORY_PAGE_IDS + 44;
    let entries = (0..total)
        .map(|n| {
            let tx_bytes = (n as u32).to_be_bytes().to_vec();
            InventoryEntry {
                content_hash: content_hash(&tx_bytes),
                tx_bytes,
            }
        })
        .collect::<Vec<_>>();
    let mut sorted = entries
        .iter()
        .map(|entry| entry.content_hash)
        .collect::<Vec<_>>();
    sorted.sort();
    let (node, mut events) = start_with_inventory(config.clone(), entries).await.unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    raw.connect().await;

    async fn page(raw: &mut RawPeer, after: Option<B256>, limit: u16) -> (Vec<B256>, Option<B256>) {
        match raw
            .request(SyncRequestKind::Inventory { after, limit })
            .await
        {
            SyncResponseKind::Inventory {
                content_hashes,
                next,
            } => (content_hashes, next),
            other => panic!("expected an inventory page, got {other:?}"),
        }
    }

    // The largest limit a peer can ask for yields one hard-capped page.
    let (ids, next) = page(&mut raw, None, u16::MAX).await;
    assert_eq!(ids, sorted[..MAX_INVENTORY_PAGE_IDS]);
    assert_eq!(next, Some(sorted[MAX_INVENTORY_PAGE_IDS - 1]));
    // Following the cursor returns the remainder and ends the walk.
    let (ids, next) = page(&mut raw, next, u16::MAX).await;
    assert_eq!(ids, sorted[MAX_INVENTORY_PAGE_IDS..]);
    assert_eq!(next, None);

    // A zero limit is served as one id rather than an empty page.
    let (ids, next) = page(&mut raw, None, 0).await;
    assert_eq!(ids, sorted[..1]);
    assert_eq!(next, Some(sorted[0]));

    // after = None starts at the smallest id.
    let (ids, next) = page(&mut raw, None, 3).await;
    assert_eq!(ids, sorted[..3]);
    assert_eq!(next, Some(sorted[2]));
    // after = a present id is exclusive.
    let (ids, next) = page(&mut raw, Some(sorted[2]), 3).await;
    assert_eq!(ids, sorted[3..6]);
    assert_eq!(next, Some(sorted[5]));
    // after = an absent id strictly between two entries resumes at the entry
    // above it; the cursor need not name something the node still holds.
    let mut between = sorted[5];
    between.0[31] = between.0[31].wrapping_add(1);
    assert!(sorted[5] < between && between < sorted[6], "test id choice");
    let (ids, next) = page(&mut raw, Some(between), 3).await;
    assert_eq!(ids, sorted[6..9]);
    assert_eq!(next, Some(sorted[8]));
    // A page that ends exactly at the last id carries no cursor.
    let (ids, next) = page(&mut raw, Some(sorted[total - 4]), 3).await;
    assert_eq!(ids, sorted[total - 3..]);
    assert_eq!(next, None);
    // after = the last id, and after = above every id, are empty and final.
    let (ids, next) = page(&mut raw, Some(sorted[total - 1]), 3).await;
    assert!(ids.is_empty());
    assert_eq!(next, None);
    let (ids, next) = page(&mut raw, Some(B256::repeat_byte(0xff)), 3).await;
    assert!(ids.is_empty());
    assert_eq!(next, None);

    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_get_response_with_more_entries_than_requested_is_dropped_whole() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x64));
    let (node, mut events) = start(config.clone()).await.unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);

    // Advertise one id, then answer the fetch for it with that transaction
    // plus one nobody asked for.
    let wanted = b"advertised".to_vec();
    let advertised = content_hash(&wanted);
    let (asked_tx, mut asked_rx) = mpsc::unbounded_channel();
    raw.responder = Box::new(move |request| {
        Some(match request {
            SyncRequestKind::Capability => SyncResponseKind::Capability,
            SyncRequestKind::Heads => SyncResponseKind::Heads { heads: Vec::new() },
            SyncRequestKind::Inventory { .. } => SyncResponseKind::Inventory {
                content_hashes: vec![advertised],
                next: None,
            },
            SyncRequestKind::Get { content_hashes } => {
                let _ = asked_tx.send(content_hashes);
                SyncResponseKind::Transactions {
                    entries: vec![wanted.clone(), b"unrequested".to_vec()],
                }
            }
        })
    });
    raw.connect().await;

    let warned = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            tokio::select! {
                event = events.recv() => match event.expect("node event stream") {
                    P2pEvent::Candidate { tx_bytes, .. } => {
                        panic!("an over-delivered response produced a candidate: {tx_bytes:?}")
                    }
                    P2pEvent::Warning(message)
                        if message.contains("sent too many transactions") =>
                    {
                        break message;
                    }
                    _ => {}
                },
                _ = raw.step() => {}
            }
        }
    })
    .await
    .expect("the node never objected to the over-delivery");
    assert!(warned.contains(&raw.peer_id().to_string()), "{warned}");
    assert_eq!(asked_rx.recv().await.unwrap(), vec![advertised]);
    wait_for_score(&node, raw.peer_id(), PEER_SCORE_REJECTED).await;

    node.shutdown().await.unwrap();
}

/// An origin attributing a verdict to `peer` without any network traffic.
fn sync_origin(peer: PeerId) -> CandidateOrigin {
    CandidateOrigin::Sync { peer }
}

async fn wait_for_score(handle: &P2pHandle, peer: PeerId, expected: i32) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while handle.peer(peer).map(|info| info.score) != Some(expected) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "score never reached {expected}: {:?}",
            handle.peer(peer).map(|info| info.score)
        )
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn peer_score_is_clamped_at_the_ceiling() {
    let dir = tempfile::tempdir().unwrap();
    let base = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x65));
    let (a, mut a_events) = start(base.clone()).await.unwrap();
    let a_listen = listen_address(&mut a_events).await;
    let (b, _b_events) = start(P2pConfig {
        identity: identity_at(dir.path(), "b.key"),
        bootstrap: vec![bootstrap_address(&a_listen, a.peer_id())],
        ..base
    })
    .await
    .unwrap();
    wait_for_peer_count(&b, 1).await;

    let beyond = (PEER_SCORE_CEILING / PEER_SCORE_ACCEPTED) as usize + 50;
    for _ in 0..beyond {
        b.report_validation(sync_origin(a.peer_id()), ValidationResult::Accept)
            .await
            .unwrap();
    }
    wait_for_score(&b, a.peer_id(), PEER_SCORE_CEILING).await;
    // Commands are handled in order, so once this rejection shows, every
    // acceptance above has been applied: the score fell from the ceiling, not
    // from an unclamped total.
    b.report_validation(sync_origin(a.peer_id()), ValidationResult::Reject)
        .await
        .unwrap();
    wait_for_score(&b, a.peer_id(), PEER_SCORE_CEILING + PEER_SCORE_REJECTED).await;
    // `Ignore` is never the peer's fault.
    b.report_validation(sync_origin(a.peer_id()), ValidationResult::Ignore)
        .await
        .unwrap();
    b.report_validation(sync_origin(a.peer_id()), ValidationResult::Accept)
        .await
        .unwrap();
    wait_for_score(
        &b,
        a.peer_id(),
        PEER_SCORE_CEILING + PEER_SCORE_REJECTED + PEER_SCORE_ACCEPTED,
    )
    .await;
    let info = b.peer(a.peer_id()).unwrap();
    assert_eq!(info.tx_accepted, beyond as u64 + 1);
    assert_eq!(info.tx_rejected, 1);

    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn peer_score_is_clamped_at_twice_the_ban_threshold() {
    // A ban disconnects the peer, and scores are only visible for connected
    // peers, so the verdicts are delivered while the peer is absent and the
    // score is read when it connects after the (short) ban has lapsed.
    let dir = tempfile::tempdir().unwrap();
    let ban = Duration::from_millis(200);
    let base = P2pConfig {
        peer_ban_duration: ban,
        ..test_config(dir.path(), "b.key", 77, B256::repeat_byte(0x66))
    };
    let (b, mut b_events) = start(base.clone()).await.unwrap();
    let b_listen = listen_address(&mut b_events).await;
    let a_identity = dir.path().join("a.key");
    let a_peer = load_or_create_identity(&a_identity)
        .unwrap()
        .public()
        .to_peer_id();

    let floor = PEER_SCORE_BAN_THRESHOLD * 2;
    let beyond = (floor / PEER_SCORE_REJECTED) as usize + 5;
    for _ in 0..beyond {
        b.report_validation(sync_origin(a_peer), ValidationResult::Reject)
            .await
            .unwrap();
    }
    tokio::time::sleep(ban * 3).await;

    let (a, _a_events) = start(P2pConfig {
        identity: load_or_create_identity(&a_identity).unwrap(),
        bootstrap: vec![bootstrap_address(&b_listen, b.peer_id())],
        ..base
    })
    .await
    .unwrap();
    assert_eq!(a.peer_id(), a_peer);
    wait_for_peer_count(&b, 1).await;
    let score = b.peer(a_peer).unwrap().score;
    // One decay tick may land inside the test on a slow runner; an unclamped
    // score would sit far below either value.
    assert!(
        score == floor || score == floor + PEER_SCORE_DECAY_STEP,
        "score {score} is not the floor {floor}"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn inbound_get_budget_defaults_enforce_the_per_peer_and_node_wide_limits() {
    let mut ids = inbound_request_ids(32).await.into_iter();
    let mut budget = InboundGetBudget::new();
    let peers = (0..=MAX_INBOUND_GET_RESPONSES)
        .map(|_| PeerId::random())
        .collect::<Vec<_>>();

    // One peer is held to its own share however small the responses are.
    for _ in 0..MAX_INBOUND_GET_RESPONSES_PER_PEER {
        assert!(budget.reserve(ids.next().unwrap(), peers[0], 1));
    }
    assert!(
        !budget.reserve(ids.next().unwrap(), peers[0], 1),
        "per-peer response count"
    );
    // A full-size response is the whole per-peer byte share.
    assert!(budget.reserve(
        ids.next().unwrap(),
        peers[1],
        MAX_INBOUND_GET_RESPONSE_BYTES_PER_PEER
    ));
    assert!(
        !budget.reserve(ids.next().unwrap(), peers[1], 1),
        "per-peer byte share"
    );
    assert!(
        !budget.reserve(
            ids.next().unwrap(),
            peers[2],
            MAX_INBOUND_GET_RESPONSE_BYTES_PER_PEER + 1
        ),
        "one response above the per-peer byte share"
    );

    // Distinct peers cannot exceed the node-wide response count between them.
    let mut admitted_peers = Vec::new();
    for peer in &peers[2..] {
        let expected = budget.responses < MAX_INBOUND_GET_RESPONSES;
        assert_eq!(budget.reserve(ids.next().unwrap(), *peer, 1), expected);
        if expected {
            admitted_peers.push(*peer);
        }
    }
    assert_eq!(budget.responses, MAX_INBOUND_GET_RESPONSES);
    assert!(
        admitted_peers.len() < peers[2..].len(),
        "nothing was refused"
    );

    // Releasing everything empties the account, including the per-peer table,
    // which must not grow with peers that have come and gone.
    budget.release_peer(peers[0]);
    budget.release_peer(peers[1]);
    for peer in admitted_peers {
        budget.release_peer(peer);
    }
    assert_eq!(budget.responses, 0);
    assert_eq!(budget.bytes, 0);
    assert!(
        budget.per_peer.is_empty(),
        "released peers are still tracked"
    );
}

#[tokio::test]
async fn inbound_get_budget_node_wide_bytes_bind_across_peers() {
    let mut ids = inbound_request_ids(16).await.into_iter();
    let mut budget = InboundGetBudget::new();
    let share = MAX_INBOUND_GET_RESPONSE_BYTES_PER_PEER;
    let full_shares = MAX_INBOUND_GET_RESPONSE_BYTES / share;
    assert!(full_shares < MAX_INBOUND_GET_RESPONSES, "bytes bind first");
    for _ in 0..full_shares {
        assert!(budget.reserve(ids.next().unwrap(), PeerId::random(), share));
    }
    let spill = MAX_INBOUND_GET_RESPONSE_BYTES - full_shares * share;
    assert!(!budget.reserve(ids.next().unwrap(), PeerId::random(), spill + 1));
}

#[tokio::test]
async fn inbound_get_release_is_by_request_and_late_completion_is_harmless() {
    let ids = inbound_request_ids(4).await;
    let first = PeerId::random();
    let second = PeerId::random();
    let mut budget = InboundGetBudget::with_limits(3, 2, 100, 70);
    assert!(budget.reserve(ids[0], first, 30));
    assert!(budget.reserve(ids[1], first, 40));
    assert!(budget.reserve(ids[2], second, 20));
    // A send failure or stream completion releases exactly that request.
    budget.release(ids[0]);
    budget.release(ids[0]);
    assert_eq!((budget.responses, budget.bytes), (2, 60));
    assert_eq!(budget.per_peer[&first].bytes, 40);
    // Final disconnect releases the remaining peer requests; their later
    // InboundFailure/ResponseSent events must not release another peer's work.
    budget.release_peer(first);
    budget.release(ids[1]);
    assert_eq!((budget.responses, budget.bytes), (1, 20));
    assert!(!budget.per_peer.contains_key(&first));
    assert_eq!(budget.per_peer[&second].bytes, 20);
    assert!(budget.reserve(ids[3], first, 70));
    budget.release(ids[2]);
    budget.release_peer(first);
    assert_eq!((budget.responses, budget.bytes), (0, 0));
    assert!(budget.per_peer.is_empty());
}

fn test_connectivity(
    swarm: &mut libp2p::Swarm<Behaviour>,
    config: ConnectivityConfig,
    protocol: &str,
) -> (
    crate::connectivity::ConnectivityManager,
    Arc<Mutex<NetworkStatus>>,
) {
    let local = *swarm.local_peer_id();
    let (_, relay_client) = libp2p::relay::client::new(local);
    swarm.behaviour_mut().connectivity = crate::connectivity::Connectivity::new(
        &config,
        local,
        libp2p::StreamProtocol::try_from_owned(protocol.to_owned()).unwrap(),
        relay_client,
    );
    let status = Arc::new(Mutex::new(NetworkStatus::default()));
    let manager =
        crate::connectivity::ConnectivityManager::new(config, protocol.to_owned(), status.clone());
    (manager, status)
}

fn test_swarm() -> libp2p::Swarm<Behaviour> {
    test_swarm_with_connectivity(ConnectivityConfig::disabled())
}

pub(super) fn test_swarm_with_connectivity(config: ConnectivityConfig) -> libp2p::Swarm<Behaviour> {
    use libp2p::{gossipsub, identify, ping, request_response};
    let key = Keypair::generate_ed25519();
    libp2p::SwarmBuilder::with_existing_identity(key.clone())
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default(),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )
        .unwrap()
        .with_relay_client(libp2p::noise::Config::new, libp2p::yamux::Config::default)
        .unwrap()
        .with_behaviour(|_, relay_client| crate::policy::Guarded {
            policy: crate::policy::Policy::new(key.public().to_peer_id(), true),
            limits: libp2p::connection_limits::Behaviour::new(Default::default()),
            inner: crate::swarm::Protocols {
                connectivity: crate::connectivity::Connectivity::new(
                    &config,
                    key.public().to_peer_id(),
                    libp2p::StreamProtocol::new("/test/kad"),
                    relay_client,
                ),
                gossip: gossipsub::Behaviour::new(
                    gossipsub::MessageAuthenticity::Signed(key.clone()),
                    Default::default(),
                )
                .unwrap(),
                identify: identify::Behaviour::new(identify::Config::new(
                    "/test".into(),
                    key.public(),
                )),
                ping: ping::Behaviour::new(Default::default()),
                sync: request_response::cbor::Behaviour::new(
                    [(
                        libp2p::StreamProtocol::new("/budget-test"),
                        request_response::ProtocolSupport::Full,
                    )],
                    Default::default(),
                ),
            },
        })
        .unwrap()
        .build()
}

// Drive the production event handler with real, now-closed response channels.
// No swarm polling is needed for these completion and send-failure branches.
async fn handle_budget_event(
    event: libp2p::request_response::Event<SyncRequest, SyncResponse>,
    budget: &mut InboundGetBudget,
) {
    let mut swarm = test_swarm();
    let (events, _receiver) = mpsc::channel(1);
    handle_sync_event(
        event,
        &mut swarm,
        SyncEventContext {
            inventory: &BTreeMap::new(),
            heads: &[],
            max_inventory: MAX_INVENTORY_PAGE_IDS,
            pending_sync: &mut HashMap::new(),
            inbound_get_budget: budget,
            peers: &mut BTreeMap::new(),
            peer_ban_duration: PEER_BAN_DURATION,
            next_sync_sequence: &mut 1,
            local_capability: capability(77, B256::ZERO),
            events: &events,
        },
    )
    .await;
}

#[tokio::test]
async fn inbound_get_budget_releases_on_send_failure_and_stream_completion() {
    use libp2p::{request_response, swarm::ConnectionId};
    let mut requests = inbound_requests(3).await;
    let (request_id, channel) = requests.pop().unwrap();
    // Swarm drop schedules connection-task shutdown; wait until that task has
    // closed the receiver so this exercises send_response's immediate failure.
    tokio::time::timeout(Duration::from_secs(5), async {
        while channel.is_open() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("response channel did not close after swarm drop");
    let peer = PeerId::random();
    let connection_id = ConnectionId::new_unchecked(1);
    let mut budget = InboundGetBudget::new();
    // The receiver swarm has been dropped. A Get still reserves before cloning
    // its response, and the closed channel must return that reservation.
    handle_budget_event(
        request_response::Event::Message {
            peer,
            connection_id,
            message: request_response::Message::Request {
                request_id,
                request: SyncRequest {
                    capability: capability(77, B256::ZERO),
                    request: SyncRequestKind::Get {
                        content_hashes: vec![],
                    },
                },
                channel,
            },
        },
        &mut budget,
    )
    .await;
    assert_eq!((budget.responses, budget.bytes), (0, 0));
    let (request_id, _) = requests.pop().unwrap();
    assert!(budget.reserve(request_id, peer, 70));
    handle_budget_event(
        request_response::Event::ResponseSent {
            peer,
            connection_id,
            request_id,
        },
        &mut budget,
    )
    .await;
    assert_eq!((budget.responses, budget.bytes), (0, 0));
    let (request_id, _) = requests.pop().unwrap();
    assert!(budget.reserve(request_id, peer, 70));
    handle_budget_event(
        request_response::Event::InboundFailure {
            peer,
            connection_id,
            request_id,
            error: request_response::InboundFailure::ConnectionClosed,
        },
        &mut budget,
    )
    .await;
    assert_eq!((budget.responses, budget.bytes), (0, 0));
    assert!(budget.per_peer.is_empty());
}

#[tokio::test]
async fn redial_targets_keep_distinct_addresses_and_forget_every_address_for_a_peer() {
    let mut swarm = test_swarm();
    let first = PeerId::random();
    let second = PeerId::random();
    let first_address = bootstrap_address(&"/ip4/127.0.0.1/tcp/1".parse().unwrap(), first);
    let other_address = bootstrap_address(&"/ip4/127.0.0.1/tcp/2".parse().unwrap(), first);
    let second_address = bootstrap_address(&"/ip4/127.0.0.1/tcp/3".parse().unwrap(), second);
    assert_eq!(add_peer(&mut swarm, first_address.clone()).unwrap(), first);
    assert_eq!(add_peer(&mut swarm, first_address).unwrap(), first);
    assert_eq!(
        swarm.behaviour().policy.configured_addresses(first).len(),
        1,
        "exact address duplicates collapse"
    );
    assert_eq!(add_peer(&mut swarm, other_address).unwrap(), first);
    assert_eq!(
        add_peer(&mut swarm, second_address.clone()).unwrap(),
        second
    );
    assert_eq!(
        swarm.behaviour().policy.configured_addresses(first).len(),
        2,
        "one peer may retain several addresses"
    );
    disconnect_and_forget(&mut swarm, first);
    assert!(!swarm.behaviour().policy.is_configured(first));
    assert_eq!(
        swarm.behaviour().policy.configured_addresses(second),
        &[second_address]
    );
}

fn head(l1_block_number: u64, l1_block_hash: u8, block_hash: u8) -> CanonicalHead {
    CanonicalHead {
        l1_block_number,
        l1_block_hash: B256::repeat_byte(l1_block_hash),
        block_hash: B256::repeat_byte(block_hash),
    }
}

#[test]
fn divergence_needs_the_same_l1_block_and_reports_the_newest_unreported() {
    let local = [
        head(10, 0x10, 0xa0),
        head(11, 0x11, 0xa1),
        head(12, 0x12, 0xa2),
    ];
    // The same chain, a peer ahead of this node, and a peer behind it.
    assert_eq!(find_divergence(&local, &local, None), None);
    assert_eq!(
        find_divergence(&local, &[head(12, 0x12, 0xa2), head(13, 0x13, 0xff)], None),
        None
    );
    assert_eq!(find_divergence(&local, &[head(9, 0x09, 0xff)], None), None);
    // Another L1 fork at the same heights.
    assert_eq!(
        find_divergence(&local, &[head(11, 0x21, 0xb1), head(12, 0x22, 0xb2)], None),
        None
    );

    let forked = [
        head(10, 0x10, 0xa0),
        head(11, 0x11, 0xb1),
        head(12, 0x12, 0xb2),
    ];
    let newest = BlockHashDivergence {
        l1_block_number: 12,
        l1_block_hash: B256::repeat_byte(0x12),
        local_block_hash: B256::repeat_byte(0xa2),
        peer_block_hash: B256::repeat_byte(0xb2),
    };
    assert_eq!(find_divergence(&local, &forked, None), Some(newest));
    assert_eq!(find_divergence(&local, &forked, Some(11)), Some(newest));
    assert_eq!(find_divergence(&local, &forked, Some(12)), None);
}

/// A raw peer that answers heads requests with `claims` and counts them.
fn heads_responder(
    claims: Arc<Mutex<Vec<CanonicalHead>>>,
    served: Arc<std::sync::atomic::AtomicUsize>,
) -> RawResponder {
    Box::new(move |request| {
        Some(match request {
            SyncRequestKind::Capability => SyncResponseKind::Capability,
            SyncRequestKind::Inventory { .. } => SyncResponseKind::Inventory {
                content_hashes: Vec::new(),
                next: None,
            },
            SyncRequestKind::Get { .. } => SyncResponseKind::Transactions {
                entries: Vec::new(),
            },
            SyncRequestKind::Heads => {
                served.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                SyncResponseKind::Heads {
                    heads: claims.lock().unwrap().clone(),
                }
            }
        })
    })
}

/// Drive the raw peer until the node has asked it for heads `rounds` more
/// times, and return the divergences and warnings the node emitted meanwhile.
///
/// The node starts a peer's next round only after the previous round's
/// responses are handled, so once the raw peer has served request `n + 1` the
/// node has finished with response `n`.
async fn drive_heads_rounds(
    raw: &mut RawPeer,
    events: &mut mpsc::Receiver<P2pEvent>,
    served: &std::sync::atomic::AtomicUsize,
    rounds: usize,
) -> (Vec<BlockHashDivergence>, Vec<String>) {
    let target = served.load(std::sync::atomic::Ordering::SeqCst) + rounds + 1;
    let raw_peer = raw.peer_id();
    let mut divergences = Vec::new();
    let mut warnings = Vec::new();
    let mut record = |event: P2pEvent| match event {
        P2pEvent::BlockHashDivergence { peer, divergence } => {
            assert_eq!(peer, raw_peer);
            divergences.push(divergence);
        }
        P2pEvent::Warning(message) => warnings.push(message),
        _ => {}
    };
    tokio::time::timeout(Duration::from_secs(20), async {
        while served.load(std::sync::atomic::Ordering::SeqCst) < target {
            tokio::select! {
                event = events.recv() => record(event.expect("node event stream")),
                _ = raw.step() => {}
            }
        }
    })
    .await
    .expect("node did not keep exchanging heads");
    while let Ok(event) = events.try_recv() {
        record(event);
    }
    (divergences, warnings)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_with_a_different_block_hash_is_reported_once_per_block() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x81));
    let (node, mut events) = start(config.clone()).await.unwrap();
    let local = vec![head(10, 0x10, 0xa0), head(11, 0x11, 0xa1)];
    node.try_replace_heads(local.clone()).unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    let claims = Arc::new(Mutex::new(vec![head(10, 0x10, 0xa0), head(11, 0x11, 0xb1)]));
    let served = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    raw.responder = heads_responder(claims.clone(), served.clone());
    raw.connect().await;

    let first = BlockHashDivergence {
        l1_block_number: 11,
        l1_block_hash: B256::repeat_byte(0x11),
        local_block_hash: B256::repeat_byte(0xa1),
        peer_block_hash: B256::repeat_byte(0xb1),
    };
    let (divergences, _) = drive_heads_rounds(&mut raw, &mut events, &served, 3).await;
    assert_eq!(divergences, vec![first]);

    // Reporting changes nothing else about the peer.
    tokio::time::timeout(Duration::from_secs(5), async {
        while node.peer(raw.peer_id()).unwrap().divergence.is_none() {
            raw.step().await;
        }
    })
    .await
    .expect("divergence was not published in the peer table");
    let info = node.peer(raw.peer_id()).unwrap();
    assert_eq!(info.divergence, Some(first));
    assert!(info.compatible);
    assert_eq!(info.score, 0);
    assert!(info.banned_for.is_none());

    // A newer divergent block is reported once more.
    node.try_replace_heads(vec![
        head(10, 0x10, 0xa0),
        head(11, 0x11, 0xa1),
        head(12, 0x12, 0xa2),
    ])
    .unwrap();
    node.replace_inventory(Vec::new()).await.unwrap();
    claims.lock().unwrap().push(head(12, 0x12, 0xb2));
    let (divergences, _) = drive_heads_rounds(&mut raw, &mut events, &served, 3).await;
    assert_eq!(
        divergences,
        vec![BlockHashDivergence {
            l1_block_number: 12,
            l1_block_hash: B256::repeat_byte(0x12),
            local_block_hash: B256::repeat_byte(0xa2),
            peer_block_hash: B256::repeat_byte(0xb2),
        }]
    );
    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_on_another_l1_fork_is_not_reported() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x82));
    let (node, mut events) = start(config.clone()).await.unwrap();
    node.try_replace_heads(vec![head(10, 0x10, 0xa0), head(11, 0x11, 0xa1)])
        .unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    let claims = Arc::new(Mutex::new(vec![head(10, 0x10, 0xa0), head(11, 0x21, 0xb1)]));
    let served = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    raw.responder = heads_responder(claims, served.clone());
    raw.connect().await;

    let (divergences, warnings) = drive_heads_rounds(&mut raw, &mut events, &served, 3).await;
    assert!(divergences.is_empty(), "{divergences:?}");
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(node.peer(raw.peer_id()).unwrap().divergence, None);
    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_oversized_heads_response_is_not_compared() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x83));
    let (node, mut events) = start(config.clone()).await.unwrap();
    node.try_replace_heads(vec![head(10, 0x10, 0xa0)]).unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    let mut oversized = vec![head(10, 0x10, 0xb0)];
    oversized.resize(MAX_CANONICAL_HEADS + 1, head(9, 0x09, 0xb9));
    let served = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    raw.responder = heads_responder(Arc::new(Mutex::new(oversized)), served.clone());
    raw.connect().await;

    let (divergences, warnings) = drive_heads_rounds(&mut raw, &mut events, &served, 2).await;
    assert!(divergences.is_empty(), "{divergences:?}");
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("sent too many canonical heads")),
        "{warnings:?}"
    );
    assert_eq!(node.peer(raw.peer_id()).unwrap().divergence, None);
    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn heads_requests_are_answered_from_the_supplied_heads() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x84));
    let (node, mut events) = start(config.clone()).await.unwrap();
    let local = vec![head(10, 0x10, 0xa0), head(11, 0x11, 0xa1)];
    node.try_replace_heads(local.clone()).unwrap();
    node.replace_inventory(Vec::new()).await.unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    raw.connect().await;
    match raw.request(SyncRequestKind::Heads).await {
        SyncResponseKind::Heads { heads } => assert_eq!(heads, local),
        other => panic!("expected heads, got {other:?}"),
    }
    node.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_connection_round_does_not_request_heads() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let dir = tempfile::tempdir().unwrap();
    let mut config = test_config(dir.path(), "a.key", 77, B256::repeat_byte(0x85));
    // No timed round runs during the test, only the one the capability probe
    // starts on connection.
    config.anti_entropy_interval = Duration::from_hours(1);
    let (node, mut events) = start(config.clone()).await.unwrap();
    node.try_replace_heads(vec![head(10, 0x10, 0xa0)]).unwrap();
    let listen = listen_address(&mut events).await;
    let mut raw = RawPeer::new(&config, &node, &listen);
    let inventory_requests = Arc::new(AtomicUsize::new(0));
    let heads_requests = Arc::new(AtomicUsize::new(0));
    let (inventory_seen, heads_seen) = (inventory_requests.clone(), heads_requests.clone());
    raw.responder = Box::new(move |request| {
        Some(match request {
            SyncRequestKind::Capability => SyncResponseKind::Capability,
            SyncRequestKind::Inventory { .. } => {
                inventory_seen.fetch_add(1, Ordering::SeqCst);
                SyncResponseKind::Inventory {
                    content_hashes: Vec::new(),
                    next: None,
                }
            }
            SyncRequestKind::Get { .. } => SyncResponseKind::Transactions {
                entries: Vec::new(),
            },
            SyncRequestKind::Heads => {
                heads_seen.fetch_add(1, Ordering::SeqCst);
                SyncResponseKind::Heads {
                    heads: vec![head(10, 0x10, 0xb0)],
                }
            }
        })
    });
    raw.connect().await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while inventory_requests.load(Ordering::SeqCst) == 0 {
            raw.step().await;
        }
    })
    .await
    .expect("connection did not start an inventory round");
    let _ = tokio::time::timeout(Duration::from_millis(300), async {
        loop {
            raw.step().await;
        }
    })
    .await;
    assert_eq!(heads_requests.load(Ordering::SeqCst), 0);
    node.shutdown().await.unwrap();
}

fn discovery_config(dir: &Path, name: &str) -> P2pConfig {
    let mut config = test_config(dir, name, 77, B256::repeat_byte(0xab));
    config.connectivity = ConnectivityConfig {
        discovery: true,
        nat: false,
        allow_private_addresses: true,
        ..Default::default()
    };
    config
}

// Let the actual swarm retain its ephemeral socket, then confirm that bound
// address. No bind/drop/rebind port reservation is needed by discovery tests.
async fn start_discovery(config: P2pConfig) -> (P2pHandle, mpsc::Receiver<P2pEvent>, Multiaddr) {
    let (handle, mut events) = start(config).await.unwrap();
    let address = listen_address(&mut events).await;
    handle
        .commands
        .send(Command::ConfirmTestAddress(address.clone()))
        .await
        .unwrap();
    let advertised = bootstrap_address(&address, handle.peer_id());
    (handle, events, advertised)
}

async fn wait_for_connection(handle: &P2pHandle, peer: PeerId) {
    tokio::time::timeout(Duration::from_secs(45), async {
        while !handle.peer(peer).is_some_and(|p| p.compatible) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("discovered peer did not become compatible");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_finds_peers_and_survives_seed_loss() {
    let dir = tempfile::tempdir().unwrap();
    let seed_config = discovery_config(dir.path(), "seed");
    let (seed, _seed_events, seed_address) = start_discovery(seed_config).await;
    let mut b_config = discovery_config(dir.path(), "b");
    b_config.bootstrap.push(seed_address.clone());
    let (b, _b_events, b_address) = start_discovery(b_config).await;
    wait_for_connection(&b, seed.peer_id()).await;
    let mut a_config = discovery_config(dir.path(), "a");
    a_config.bootstrap.push(seed_address);
    let (a, mut a_events, _) = start_discovery(a_config).await;
    wait_for_connection(&a, b.peer_id()).await;
    assert_ne!(a.network_status().discovery_mode, crate::DiscoveryMode::Off);
    seed.shutdown().await.unwrap();
    // A new peer knows only B. A must find it without its configured seed.
    let mut c_config = discovery_config(dir.path(), "c");
    c_config.bootstrap.push(b_address);
    let (c, _c_events, _) = start_discovery(c_config).await;
    wait_for_connection(&a, c.peer_id()).await;
    c.announce(vec![4, 5, 6]).await.unwrap();
    let (_, bytes, origin) =
        tokio::time::timeout(Duration::from_secs(10), next_candidate(&mut a_events))
            .await
            .unwrap();
    assert_eq!(bytes, vec![4, 5, 6]);
    a.report_validation(origin, ValidationResult::Accept)
        .await
        .unwrap();
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
    c.shutdown().await.unwrap();
}

#[tokio::test]
async fn kademlia_addresses_cannot_bypass_the_dial_policy() {
    use libp2p::{kad, swarm::dial_opts::DialOpts, StreamProtocol};
    let mut swarm = test_swarm();
    swarm.behaviour_mut().policy.allow_private_for_test(false);
    let peer = PeerId::random();
    let mut kad = kad::Behaviour::with_config(
        *swarm.local_peer_id(),
        kad::store::MemoryStore::new(*swarm.local_peer_id()),
        kad::Config::new(StreamProtocol::new("/test/kad")),
    );
    kad.add_address(&peer, "/ip4/127.0.0.1/tcp/8646".parse().unwrap());
    swarm.behaviour_mut().connectivity.kad = Some(kad).into();
    assert!(swarm.dial(DialOpts::peer_id(peer).build()).is_err());
    swarm.behaviour_mut().policy.allow_private_for_test(true);
    swarm.behaviour_mut().policy.remove(peer);
    assert!(swarm.dial(DialOpts::peer_id(peer).build()).is_err());
    swarm.behaviour_mut().policy.configure(
        &DialTarget::parse(
            format!("/ip4/127.0.0.1/tcp/8646/p2p/{peer}")
                .parse()
                .unwrap(),
        )
        .unwrap(),
    );
    swarm
        .behaviour_mut()
        .policy
        .ban(peer, Duration::from_mins(1));
    assert!(swarm.dial(DialOpts::peer_id(peer).build()).is_err());
}

#[tokio::test]
async fn discovery_store_refuses_values_and_provider_records() {
    use libp2p::kad::{store::RecordStore, ProviderRecord, Record};
    let mut swarm = test_swarm_with_connectivity(ConnectivityConfig::default());
    let peer = *swarm.local_peer_id();
    let store = swarm
        .behaviour_mut()
        .connectivity
        .kad
        .as_mut()
        .unwrap()
        .store_mut();
    assert!(store.put(Record::new(vec![1], vec![2])).is_err());
    assert!(store
        .add_provider(ProviderRecord::new(vec![1], peer, vec![]))
        .is_err());
    assert_eq!(store.records().count(), 0);
    assert!(store.providers(&vec![1].into()).is_empty());
}

#[tokio::test]
async fn identify_admission_is_namespaced_bounded_and_replaces_withdrawn_addresses() {
    use crate::discovery_protocol_for as protocol;
    use libp2p::{identify, StreamProtocol};
    let mut swarm = test_swarm();
    let name = protocol(77, B256::repeat_byte(0xab));
    let config = ConnectivityConfig {
        nat: false,
        ..Default::default()
    };
    let (mut connectivity, _) = test_connectivity(&mut swarm, config, &name);
    swarm.behaviour_mut().policy.allow_private_for_test(false);
    let remote = Keypair::generate_ed25519();
    let peer = remote.public().to_peer_id();
    let mut info = identify::Info {
        public_key: remote.public(),
        protocol_version: "/pcash/mempool/1".into(),
        agent_version: "test".into(),
        listen_addrs: (1..20)
            .map(|p| format!("/ip4/8.8.8.8/tcp/{p}").parse().unwrap())
            .collect(),
        protocols: vec![StreamProtocol::try_from_owned(name).unwrap()],
        observed_addr: "/ip4/8.8.4.4/tcp/8646".parse().unwrap(),
        signed_peer_record: None,
    };
    connectivity.identify(&mut swarm, peer, &info);
    assert_eq!(swarm.behaviour().policy.addresses(peer).len(), 4);
    info.listen_addrs = vec![
        "/ip4/8.8.4.4/tcp/8646".parse().unwrap(),
        "/ip4/127.0.0.1/tcp/8646".parse().unwrap(),
    ];
    connectivity.identify(&mut swarm, peer, &info);
    assert_eq!(
        swarm.behaviour().policy.addresses(peer),
        vec![info.listen_addrs[0].clone()]
    );
    for other in [
        protocol(78, B256::repeat_byte(0xab)),
        protocol(77, B256::repeat_byte(0xac)),
    ] {
        info.protocols = vec![StreamProtocol::try_from_owned(other).unwrap()];
        connectivity.identify(&mut swarm, peer, &info);
        assert!(swarm.behaviour().policy.addresses(peer).is_empty());
        assert_eq!(
            swarm
                .behaviour_mut()
                .connectivity
                .kad
                .as_mut()
                .unwrap()
                .kbuckets()
                .map(|b| b.num_entries())
                .sum::<usize>(),
            0
        );
    }
}

#[tokio::test]
async fn only_confirmed_endpoints_enable_discovery_serving_and_expiry_withdraws_them() {
    use libp2p::swarm::{FromSwarm, NetworkBehaviour, NewExternalAddrCandidate};
    let mut swarm = test_swarm();
    let local = *swarm.local_peer_id();
    let config = ConnectivityConfig {
        nat: false,
        ..Default::default()
    };
    let (mut connectivity, status) = test_connectivity(&mut swarm, config, "/test/kad");
    let address: Multiaddr = "/ip4/8.8.8.8/tcp/8646".parse().unwrap();
    swarm
        .behaviour_mut()
        .on_swarm_event(FromSwarm::NewExternalAddrCandidate(
            NewExternalAddrCandidate { addr: &address },
        ));
    connectivity.tick(&mut swarm, &BTreeMap::new());
    assert_eq!(
        status.lock().unwrap().discovery_mode,
        crate::DiscoveryMode::Client
    );
    assert!(status.lock().unwrap().external_addresses.is_empty());
    let relay: Multiaddr = format!(
        "/ip4/8.8.4.4/tcp/8646/p2p/{}/p2p-circuit/p2p/{local}",
        PeerId::random()
    )
    .parse()
    .unwrap();
    for endpoint in [address, relay] {
        swarm.add_external_address(endpoint.clone());
        connectivity.tick(&mut swarm, &BTreeMap::new());
        assert_eq!(
            status.lock().unwrap().discovery_mode,
            crate::DiscoveryMode::Server
        );
        assert_eq!(
            status.lock().unwrap().external_addresses,
            vec![bootstrap_address(
                &crate::policy::transport_part(&endpoint),
                local
            )]
        );
        swarm.remove_external_address(&endpoint);
        connectivity.tick(&mut swarm, &BTreeMap::new());
        assert_eq!(
            status.lock().unwrap().discovery_mode,
            crate::DiscoveryMode::Client
        );
        assert!(status.lock().unwrap().external_addresses.is_empty());
    }
}

#[tokio::test]
async fn every_dial_path_shares_the_pending_connection_ceiling() {
    use libp2p::{connection_limits, swarm::dial_opts::DialOpts};
    let mut swarm = test_swarm();
    swarm.behaviour_mut().limits = connection_limits::Behaviour::new(
        connection_limits::ConnectionLimits::default()
            .with_max_pending_outgoing(Some(MAX_PENDING_OUTBOUND_CONNECTIONS)),
    );
    // Do not poll the swarm: these attempts stay pending, without opening sockets.
    for _ in 0..MAX_PENDING_OUTBOUND_CONNECTIONS {
        assert!(swarm
            .dial(
                DialOpts::peer_id(PeerId::random())
                    .addresses(vec!["/ip4/127.0.0.1/tcp/8646".parse().unwrap()])
                    .build()
            )
            .is_ok());
    }
    assert_eq!(
        swarm.behaviour().policy.pending_count(),
        MAX_PENDING_OUTBOUND_CONNECTIONS as usize
    );
    assert!(swarm
        .dial(
            DialOpts::peer_id(PeerId::random())
                .addresses(vec!["/ip4/127.0.0.1/tcp/8646".parse().unwrap()])
                .build()
        )
        .is_err());
    assert_eq!(
        swarm.behaviour().policy.pending_count(),
        MAX_PENDING_OUTBOUND_CONNECTIONS as usize
    );
}

#[tokio::test]
async fn inbound_relay_endpoints_and_direct_upgrades_preserve_peer_accounting() {
    use libp2p::{
        core::{transport::PortUse, Endpoint},
        swarm::ConnectionId,
    };
    let mut swarm = test_swarm();
    let peer = PeerId::random();
    let relay = PeerId::random();
    let local = *swarm.local_peer_id();
    let relayed = ConnectionId::new_unchecked(1);
    let direct = ConnectionId::new_unchecked(2);
    let circuit: Multiaddr = format!("/ip4/8.8.8.8/tcp/8646/p2p/{relay}/p2p-circuit/p2p/{local}")
        .parse()
        .unwrap();
    swarm.behaviour_mut().policy.established(
        peer,
        relayed,
        ConnectedPoint::Listener {
            local_addr: circuit,
            send_back_addr: format!("/p2p/{peer}").parse().unwrap(),
        },
    );
    let mut state = PeerState::new(Direction::Inbound, format!("/p2p/{peer}").parse().unwrap());
    state.compatible = true;
    state.payload_bytes_received = 1234;
    let mut peers = BTreeMap::from([(peer, state)]);
    refresh_endpoint(&swarm, &mut peers, peer);
    assert!(peers[&peer]
        .remote_address
        .to_string()
        .contains("/p2p-circuit"));
    let address: Multiaddr = "/ip4/8.8.4.4/tcp/8646".parse().unwrap();
    swarm.behaviour_mut().policy.established(
        peer,
        direct,
        ConnectedPoint::Dialer {
            address: address.clone(),
            role_override: Endpoint::Dialer,
            port_use: PortUse::Reuse,
        },
    );
    refresh_endpoint(&swarm, &mut peers, peer);
    assert_eq!(peers[&peer].connections, 2);
    assert_eq!(peers[&peer].remote_address, address);
    swarm.behaviour_mut().policy.closed(peer, relayed);
    refresh_endpoint(&swarm, &mut peers, peer);
    assert_eq!(peers[&peer].connections, 1);
    assert!(peers[&peer].compatible);
    assert_eq!(peers[&peer].payload_bytes_received, 1234);
}

#[tokio::test]
async fn nine_valid_hole_punch_addresses_are_admitted_under_the_socket_budget() {
    use libp2p::swarm::dial_opts::DialOpts;
    let mut swarm = test_swarm();
    let addresses = (1..=9)
        .map(|port| format!("/ip4/8.8.8.8/tcp/{port}").parse().unwrap())
        .collect();
    assert!(swarm
        .dial(
            DialOpts::peer_id(PeerId::random())
                .addresses(addresses)
                .build()
        )
        .is_ok());
    assert_eq!(swarm.behaviour().policy.pending_count(), 1);
}

#[tokio::test]
async fn autonat_public_replacement_retires_only_autonat_owned_addresses() {
    let mut swarm = test_swarm();
    let address_a: Multiaddr = "/ip4/8.8.8.8/tcp/8646".parse().unwrap();
    let address_b: Multiaddr = "/ip4/8.8.4.4/tcp/8646".parse().unwrap();
    let operator: Multiaddr = "/ip4/1.1.1.1/tcp/8646".parse().unwrap();
    let upnp: Multiaddr = "/ip4/1.0.0.1/tcp/8646".parse().unwrap();
    let config = ConnectivityConfig {
        nat: false,
        discovery: false,
        advertised_address: Some(operator.clone()),
        ..Default::default()
    };
    let (mut connectivity, status) = test_connectivity(&mut swarm, config, "/test/kad");
    connectivity.event(
        &mut swarm,
        crate::connectivity::ConnectivityEvent::Upnp(libp2p::upnp::Event::NewExternalAddr(
            upnp.clone(),
        )),
    );
    connectivity.replace_autonat_address(&mut swarm, Some(address_a.clone()));
    connectivity.tick(&mut swarm, &BTreeMap::new());
    connectivity.replace_autonat_address(&mut swarm, Some(address_b.clone()));
    connectivity.tick(&mut swarm, &BTreeMap::new());
    let external = status.lock().unwrap().external_addresses.clone();
    assert!(!external.contains(&bootstrap_address(&address_a, *swarm.local_peer_id())));
    for address in [&address_b, &operator, &upnp] {
        assert!(external.contains(&bootstrap_address(address, *swarm.local_peer_id())));
    }
    // Losing AutoNAT ownership must preserve independently confirmed mappings.
    connectivity.replace_autonat_address(&mut swarm, Some(upnp.clone()));
    connectivity.replace_autonat_address(&mut swarm, None);
    connectivity.tick(&mut swarm, &BTreeMap::new());
    assert!(status
        .lock()
        .unwrap()
        .external_addresses
        .contains(&bootstrap_address(&upnp, *swarm.local_peer_id())));
}

#[tokio::test]
async fn negotiated_hole_punch_with_nine_public_candidates_reaches_the_transport() {
    use futures::StreamExt;
    use libp2p::swarm::{
        behaviour::toggle::Toggle, FromSwarm, NetworkBehaviour, NewExternalAddrCandidate,
        SwarmEvent,
    };
    use libp2p::{dcutr, relay};

    #[derive(NetworkBehaviour)]
    struct Punch {
        relay_client: relay::client::Behaviour,
        relay_server: Toggle<relay::Behaviour>,
        dcutr: dcutr::Behaviour,
    }

    fn swarm(server: bool) -> libp2p::Swarm<crate::policy::Guarded<Punch>> {
        libp2p::SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                Default::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )
            .unwrap()
            .with_relay_client(libp2p::noise::Config::new, libp2p::yamux::Config::default)
            .unwrap()
            .with_behaviour(|key, relay_client| {
                let peer = key.public().to_peer_id();
                crate::policy::Guarded {
                    limits: libp2p::connection_limits::Behaviour::new(
                        libp2p::connection_limits::ConnectionLimits::default()
                            .with_max_pending_outgoing(Some(MAX_PENDING_OUTBOUND_CONNECTIONS)),
                    ),
                    policy: crate::policy::Policy::new(peer, true),
                    inner: Punch {
                        relay_client,
                        relay_server: server
                            .then(|| relay::Behaviour::new(peer, Default::default()))
                            .into(),
                        dcutr: dcutr::Behaviour::new(peer),
                    },
                }
            })
            .unwrap()
            .with_swarm_config(|config| {
                config.with_dial_concurrency_factor(
                    std::num::NonZeroU8::new(DIAL_CONCURRENCY).unwrap(),
                )
            })
            .build()
    }

    let mut relay = swarm(true);
    relay
        .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
        .unwrap();
    let relay_address = loop {
        if let SwarmEvent::NewListenAddr { address, .. } = relay.select_next_some().await {
            relay.add_external_address(address.clone());
            break bootstrap_address(&address, *relay.local_peer_id());
        }
    };
    let mut source = swarm(false);
    let mut destination = swarm(false);
    let source_id = *source.local_peer_id();
    let destination_id = *destination.local_peer_id();
    // No Identify behaviour supplies extra candidates. Both sides really
    // negotiate these nine public endpoints through the DCUtR wire protocol.
    for client in [&mut source, &mut destination] {
        for port in 1..=9 {
            let address = format!("/ip4/8.8.8.8/tcp/{port}").parse().unwrap();
            client
                .behaviour_mut()
                .on_swarm_event(FromSwarm::NewExternalAddrCandidate(
                    NewExternalAddrCandidate { addr: &address },
                ));
        }
    }
    let circuit = relay_address
        .with(Protocol::P2pCircuit)
        .with(Protocol::P2p(destination_id));
    destination.listen_on(circuit.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tokio::select! {
                _ = relay.select_next_some() => {},
                event = destination.select_next_some() => {
                    if matches!(event, SwarmEvent::NewListenAddr { .. }) { break; }
                }
            }
        }
        source.dial(circuit).unwrap();
        loop {
            let (event, pending) = tokio::select! {
                _ = relay.select_next_some() => { continue; },
                event = source.select_next_some() => (event, source.behaviour().policy.pending_count()),
                event = destination.select_next_some() => (event, destination.behaviour().policy.pending_count()),
            };
            if let SwarmEvent::Dialing { peer_id: Some(peer), .. } = event {
                if peer == source_id || peer == destination_id {
                    assert!(pending > 0 && pending <= MAX_PENDING_OUTBOUND_CONNECTIONS as usize);
                    // Swarm emits Dialing after admission, before polling the
                    // transport futures. Drop them without contacting public IPs.
                    return;
                }
            }
        }
    }).await.expect("negotiated DCUtR dial was denied before reaching the transport");
}

#[test]
fn simultaneous_relay_circuits_leave_a_slot_for_direct_upgrade_at_both_ends() {
    use libp2p::{
        core::{transport::PortUse, Endpoint},
        swarm::ConnectionId,
    };
    let first = PeerId::random();
    let second = PeerId::random();
    let relay = PeerId::random();
    let circuit = |peer| {
        format!("/ip4/8.8.8.8/tcp/8646/p2p/{relay}/p2p-circuit/p2p/{peer}")
            .parse::<Multiaddr>()
            .unwrap()
    };
    let mut left = crate::policy::Policy::new(first, false);
    let mut right = crate::policy::Policy::new(second, false);
    let left_dial = ConnectionId::new_unchecked(1);
    let left_inbound = ConnectionId::new_unchecked(2);
    let right_dial = ConnectionId::new_unchecked(3);
    let right_inbound = ConnectionId::new_unchecked(4);
    let dialer = |peer| ConnectedPoint::Dialer {
        address: circuit(peer),
        role_override: Endpoint::Dialer,
        port_use: PortUse::Reuse,
    };
    let listener = |local, remote| ConnectedPoint::Listener {
        local_addr: circuit(local),
        send_back_addr: format!("/p2p/{remote}").parse().unwrap(),
    };
    left.established(second, left_dial, dialer(second));
    left.established(second, left_inbound, listener(first, second));
    right.established(first, right_dial, dialer(first));
    right.established(first, right_inbound, listener(second, first));
    let (left_closed, right_closed) = if first < second {
        (left_inbound, right_dial)
    } else {
        (left_dial, right_inbound)
    };
    assert_eq!(left.redundant_relays(second), vec![left_closed]);
    assert_eq!(right.redundant_relays(first), vec![right_closed]);
    left.closed(second, left_closed);
    right.closed(first, right_closed);
    assert!(left.redundant_relays(second).is_empty());
    assert!(right.redundant_relays(first).is_empty());
}

#[test]
fn duplicate_direct_connections_close_to_one_that_both_ends_keep() {
    use libp2p::{
        core::{transport::PortUse, Endpoint},
        swarm::ConnectionId,
    };
    let address: Multiaddr = "/ip4/8.8.8.8/tcp/8646".parse().unwrap();
    let dialer = |role_override| ConnectedPoint::Dialer {
        address: address.clone(),
        role_override,
        port_use: PortUse::Reuse,
    };
    let listener = ConnectedPoint::Listener {
        local_addr: address.clone(),
        send_back_addr: address.clone(),
    };
    // Connections in dial order: (dialed by `a`, hole punch).
    let scenarios: [&[(bool, bool)]; 4] = [
        // An AutoNAT dial-back to a peer this end already dialed.
        &[(true, false), (true, false)],
        // A dial-back the other way, or simultaneous dials.
        &[(true, false), (false, false)],
        &[(false, false), (true, false)],
        // Both ends dial a hole punch; `a` holds the dialer role.
        &[(true, true), (false, false)],
    ];
    let first = PeerId::random();
    let second = PeerId::random();
    for (a, b) in [(first, second), (second, first)] {
        for connections in scenarios {
            let mut ends = [
                crate::policy::Policy::new(a, false),
                crate::policy::Policy::new(b, false),
            ];
            for (index, &(by_a, punched)) in connections.iter().enumerate() {
                let id = ConnectionId::new_unchecked(index);
                ends[0].established(
                    b,
                    id,
                    match (by_a, punched) {
                        (true, _) => dialer(Endpoint::Dialer),
                        (false, true) => dialer(Endpoint::Listener),
                        (false, false) => listener.clone(),
                    },
                );
                ends[1].established(
                    a,
                    id,
                    match (by_a, punched) {
                        (false, _) => dialer(Endpoint::Dialer),
                        (true, true) => dialer(Endpoint::Listener),
                        (true, false) => listener.clone(),
                    },
                );
            }
            let closed_by_a = ends[0].redundant_direct(b);
            let closed_by_b = ends[1].redundant_direct(a);
            let dialed_by = |by_a_end: bool| {
                (0..connections.len())
                    .filter(|&index| connections[index].0 == by_a_end)
                    .map(ConnectionId::new_unchecked)
                    .collect::<Vec<_>>()
            };
            assert!(closed_by_a.iter().all(|id| dialed_by(true).contains(id)));
            assert!(closed_by_b.iter().all(|id| dialed_by(false).contains(id)));
            let closed: std::collections::BTreeSet<_> =
                closed_by_a.into_iter().chain(closed_by_b).collect();
            assert_eq!(
                closed.len(),
                connections.len() - 1,
                "{connections:?} with a {} b",
                if a < b { "<" } else { ">" }
            );
            for id in &closed {
                ends[0].closed(b, *id);
                ends[1].closed(a, *id);
            }
            assert!(ends[0].redundant_direct(b).is_empty());
            assert!(ends[1].redundant_direct(a).is_empty());
        }
        // The dial-back closes, not the connection that carried its request.
        let mut end = crate::policy::Policy::new(a, false);
        end.established(b, ConnectionId::new_unchecked(0), dialer(Endpoint::Dialer));
        end.established(b, ConnectionId::new_unchecked(1), dialer(Endpoint::Dialer));
        assert_eq!(
            end.redundant_direct(b),
            vec![ConnectionId::new_unchecked(1)]
        );
    }
}

#[tokio::test]
async fn a_refused_connection_warning_names_the_refusing_limit() {
    use libp2p::{
        connection_limits,
        core::{transport::PortUse, Endpoint},
        swarm::{ConnectionId, DialError, NetworkBehaviour},
    };
    let mut swarm = test_swarm();
    swarm.behaviour_mut().limits = connection_limits::Behaviour::new(
        connection_limits::ConnectionLimits::default().with_max_established_per_peer(Some(0)),
    );
    let peer = PeerId::random();
    let address: Multiaddr = "/ip4/8.8.8.8/tcp/8646".parse().unwrap();
    let Err(cause) = swarm
        .behaviour_mut()
        .handle_established_outbound_connection(
            ConnectionId::new_unchecked(1),
            peer,
            &address,
            Endpoint::Dialer,
            PortUse::Reuse,
        )
    else {
        panic!("the per-peer limit admitted a connection");
    };
    assert_eq!(
        crate::swarm::dial_failure_warning(Some(peer), &DialError::Denied { cause }),
        format!(
            "failed to reach {peer}: Dial error: connection denied: connection limit exceeded: \
             at most 0 established connections per peer are allowed"
        )
    );
}
