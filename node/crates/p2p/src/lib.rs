//! Non-consensus networking for the PCASH transaction pool.
//!
//! The transport deliberately knows nothing about canonical PCASH state. It
//! delivers candidates to its owner and waits for an explicit validation
//! result before gossipsub propagation. Late peers synchronize a bounded
//! inventory over request/response; fetched bytes are candidates too and must
//! pass the same local admission path.
//!
//! Timed sync rounds also compare recent canonical heads the owner supplies
//! with each peer's, and report a peer whose PCASH block hash differs for the
//! same L1 block. The report is an alert only: a peer's claim is not evidence,
//! so it never feeds back into derivation or peer scoring.

mod autonat;
mod connectivity;
mod identity;
mod policy;
mod swarm;
mod types;

use std::time::Duration;

pub use connectivity::{
    ConnectivityConfig, DiscoveryMode, NetworkCounters, NetworkStatus, Reachability,
};
pub use identity::{
    generate_identity_file, identity_from_hex, inspect_identity_file, load_or_create_identity,
    GeneratedIdentity, IdentityFileInfo,
};
pub use libp2p::identity::Keypair;
pub use libp2p::{Multiaddr, PeerId};
pub use swarm::{bootstrap_address, peer_id_of, start, start_with_inventory};
pub use types::{
    check_fork_compatibility, content_hash, discovery_protocol_for, sync_protocol_for, topic_for,
    BlockHashDivergence, CandidateOrigin, CanonicalHead, Direction, Error, ForkCapability,
    ForkCompatibilityError, InventoryEntry, P2pConfig, P2pEvent, P2pHandle, PeerInfo,
    ValidationResult,
};

/// Largest valid transaction on the wire: the widest shape the compiled
/// transaction types can produce. Transport and DoS ceilings derive from this,
/// not from the 131,072 `MAX_TX_BYTES` consensus parse bound — bytes above this
/// size can never be a valid transaction, so relaying them buys nothing. It
/// mirrors `pcash_derive::MAX_VALID_TX_BYTES` (asserted equal in the node
/// mempool tests) without taking a dependency on the derive crate.
pub const MAX_RELAYED_TX_BYTES: usize = 80_198;
/// Hard ceiling for one inventory page, regardless of local configuration.
pub const MAX_INVENTORY_PAGE_IDS: usize = 256;
/// Hard ceiling for one transaction fetch and response.
pub const MAX_GET_IDS: usize = 64;
/// Hard ceiling for both a local inventory snapshot and one peer sync session.
pub const MAX_INVENTORY_ENTRIES: usize = 4_096;
/// Recent canonical heads a node advertises, and the most it compares from one
/// peer response. 64 L1 blocks is about 13 minutes, so two nodes near the tip
/// overlap even when one lags.
pub const MAX_CANONICAL_HEADS: usize = 64;
pub(crate) const COMMAND_CAPACITY: usize = 256;
pub(crate) const EVENT_CAPACITY: usize = 256;
pub(crate) const MAX_SYNC_REQUEST_BYTES: u64 = 8 * 1_024;
pub(crate) const MAX_SYNC_RESPONSE_BYTES: u64 =
    (MAX_GET_IDS * (MAX_RELAYED_TX_BYTES + 64) + 4_096) as u64;
/// Desired compatible outbound peers, including configured peers.
pub const DEFAULT_TARGET_PEERS: usize = 16;
/// Maximum configurable peer target, below the established connection ceiling.
pub const MAX_TARGET_PEERS: usize = 128;
/// Shared pending dial budget for all behaviours and explicit application dials.
pub(crate) const MAX_PENDING_OUTBOUND_CONNECTIONS: u32 = 8;
/// Replaceable discovered peers retained in memory.
pub(crate) const MAX_CANDIDATES: usize = 1024;
/// Endpoints retained for one remote discovery candidate.
pub(crate) const MAX_ADDRESSES: usize = 4;
/// Local reachability observations retained by AutoNAT and DCUtR.
pub(crate) const MAX_EXTERNAL_CANDIDATES: usize = 20;
/// DCUtR can supply twenty explicit endpoints; Kademlia can add four more.
pub(crate) const MAX_DIAL_ADDRESSES: usize = MAX_EXTERNAL_CANDIDATES + MAX_ADDRESSES;
/// Concurrent socket attempts within one pending connection.
pub(crate) const DIAL_CONCURRENCY: u8 = 3;
/// Failed discovery evidence ages out independently of retries.
pub(crate) const CANDIDATE_TTL: Duration = Duration::from_mins(30);
/// Initial retry delay for a failed endpoint.
pub(crate) const DIAL_RETRY_INITIAL: Duration = Duration::from_secs(10);
/// Maximum exponential retry delay.
pub(crate) const DIAL_RETRY_MAX: Duration = Duration::from_mins(5);
/// Maximum simultaneous Kademlia query requests.
pub(crate) const KAD_PARALLELISM: usize = 3;
/// Time allowed for a Kademlia lookup.
pub(crate) const KAD_QUERY_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum accepted discovery packet size.
pub(crate) const KAD_MAX_PACKET_BYTES: usize = 16 * 1024;
/// Minimum interval between application-initiated random lookups.
pub(crate) const DISCOVERY_LOOKUP_INTERVAL: Duration = Duration::from_secs(30);
/// Delay before reconnecting an incompatible discovered peer.
pub(crate) const INCOMPATIBLE_RETRY: Duration = Duration::from_mins(10);
/// Time to obtain a reservation before selecting a replacement relay.
pub(crate) const RELAY_RESERVATION_GRACE: Duration = Duration::from_secs(30);
/// Give direct reachability discovery this long before reserving relays.
pub(crate) const DIRECT_REACHABILITY_GRACE: Duration = Duration::from_secs(30);
/// Retry delay after a relay reservation fails.
pub(crate) const RELAY_RETRY: Duration = Duration::from_mins(1);
/// Distinct relays reserved by a node without direct reachability.
pub(crate) const RELAY_TARGET: usize = 2;
/// Relay server reservations across all peers.
pub(crate) const RELAY_MAX_RESERVATIONS: usize = 64;
/// Relay server reservations for one peer.
pub(crate) const RELAY_MAX_RESERVATIONS_PER_PEER: usize = 1;
/// Relay server circuits across all peers.
pub(crate) const RELAY_MAX_CIRCUITS: usize = 16;
/// Relay server circuits for one peer.
pub(crate) const RELAY_MAX_CIRCUITS_PER_PEER: usize = 4;
/// Maximum lifetime of a relay circuit.
pub(crate) const RELAY_MAX_CIRCUIT_DURATION: Duration = Duration::from_mins(10);
/// Byte budget permits large PCASH inventory responses.
pub(crate) const RELAY_MAX_CIRCUIT_BYTES: u64 = 64 * 1024 * 1024;
/// Peer misconduct scoring. These are tuned defaults, not protocol values: the
/// signal they consume is local admission's own verdict on a peer's candidates,
/// which already distinguishes attributable misconduct (a transaction that
/// cannot be valid under any state) from a transient local condition (this node
/// is behind, busy, or its verifier is unavailable). Only the former moves the
/// score down, so a node that falls behind does not ban the peers it most needs.
///
/// A peer must send roughly `PEER_SCORE_BAN_THRESHOLD / PEER_SCORE_REJECTED`
/// unambiguously invalid transactions with no admitted ones in between to earn
/// a ban, and the score decays back toward zero so a ban is never permanent.
pub const PEER_SCORE_BAN_THRESHOLD: i32 = -100;
pub(crate) const PEER_SCORE_ACCEPTED: i32 = 1;
pub(crate) const PEER_SCORE_REJECTED: i32 = -20;
pub(crate) const PEER_SCORE_CEILING: i32 = 100;
pub const PEER_BAN_DURATION: Duration = Duration::from_mins(10);
pub(crate) const PEER_SCORE_DECAY_INTERVAL: Duration = Duration::from_mins(1);
/// Points recovered per decay tick, toward zero from either direction.
pub(crate) const PEER_SCORE_DECAY_STEP: i32 = 5;
/// Ceiling on retained reputation for peers that are not connected. Peer ids
/// are cheap to mint, so this table cannot be allowed to grow with the number
/// of identities that have ever misbehaved.
pub(crate) const MAX_TRACKED_REPUTATIONS: usize = 4_096;
/// How often the connected-peer snapshot is refreshed for outside readers.
///
/// Counters and elapsed times are republished on this tick rather than on every
/// gossip message: rebuilding the snapshot is proportional to the peer count, so
/// doing it per message would put that cost on the hottest path in the node to
/// serve a view an operator reads occasionally. Elapsed connection time needs
/// the tick regardless — it is computed when the snapshot is built, so without
/// one a quiet peer's uptime would stop advancing. Changes to the peer set
/// itself — a connection opening or closing, a disconnect an operator asked
/// for — publish immediately on top of this, so the tick governs how stale a
/// counter can be, never whether a peer appears at all.
pub(crate) const PEER_PUBLISH_INTERVAL: Duration = Duration::from_secs(1);
/// Bound simultaneous outbound inventory sessions. One session can fan out to
/// 64 transaction fetches, so starting a session for every connected peer at
/// once would defeat the request/response stream and pending-map bounds.
pub(crate) const MAX_CONCURRENT_SYNC_PEERS: usize = 4;
/// Inbound `Get` streams are limited per connection by libp2p. These limits are
/// node-wide and per peer ID across all of that peer's connections.
pub(crate) const MAX_INBOUND_GET_RESPONSES: usize = 8;
pub(crate) const MAX_INBOUND_GET_RESPONSES_PER_PEER: usize = 2;
pub(crate) const MAX_INBOUND_GET_RESPONSE_BYTES: usize = 2 * MAX_SYNC_RESPONSE_BYTES as usize;
pub(crate) const MAX_INBOUND_GET_RESPONSE_BYTES_PER_PEER: usize = MAX_SYNC_RESPONSE_BYTES as usize;
pub(crate) const MAX_PENDING_INBOUND_CONNECTIONS: u32 = 32;
pub(crate) const MAX_ESTABLISHED_INBOUND_CONNECTIONS: u32 = 128;
pub(crate) const MAX_ESTABLISHED_CONNECTIONS: u32 = 160;
pub(crate) const MAX_CONNECTIONS_PER_PEER: u32 = 2;

#[cfg(test)]
mod tests;
