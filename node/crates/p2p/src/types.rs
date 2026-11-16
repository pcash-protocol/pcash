use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alloy_primitives::{keccak256, B256};
use libp2p::gossipsub::MessageId;
use libp2p::identity::Keypair;
use libp2p::{Multiaddr, PeerId};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

/// Live connected-peer table, written by the swarm task and read through
/// [`P2pHandle::peers`]. One table is the whole peer surface: a count and a
/// listing taken from it can never disagree, which two separately maintained
/// mirrors could.
pub(super) type PeerTable = Arc<Mutex<BTreeMap<PeerId, PeerInfo>>>;

/// Which side opened the connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// The peer dialed us.
    Inbound,
    /// We dialed the peer.
    Outbound,
}

/// Everything the node knows about one connected peer.
///
/// A peer appears here the moment its first connection is established, before
/// the fork-capability handshake has run — `compatible` is false and
/// `capability` is `None` until it completes. That is the honest state, and it
/// is what an operator diagnosing a peer that connects but never syncs needs to
/// see.
#[derive(Clone, Debug)]
pub struct PeerInfo {
    pub peer_id: PeerId,
    /// Remote address of the first established connection.
    pub remote_address: Multiaddr,
    pub direction: Direction,
    /// How long the peer has been continuously connected.
    pub connected_for: Duration,
    /// Established connections to this peer, capped by `MAX_CONNECTIONS_PER_PEER`.
    pub connections: u32,
    pub compatible: bool,
    /// Why the peer is incompatible, when it is.
    pub incompatible_reason: Option<String>,
    /// The peer's advertised fork capability, once it has handshaked.
    pub capability: Option<ForkCapability>,
    /// libp2p identify: the peer's implementation and version string.
    pub agent_version: Option<String>,
    /// libp2p identify: the peer's advertised protocol version.
    pub protocol_version: Option<String>,
    /// Round-trip time from the most recent successful ping.
    pub rtt: Option<Duration>,
    /// PCASH protocol payload bytes exchanged with this peer since it
    /// connected: gossip message data plus mempool-sync request and response
    /// bodies. This deliberately excludes Noise encryption, Yamux framing,
    /// TCP/IP headers, and libp2p's own identify and ping traffic, so it
    /// measures what the peer contributed to and cost the mempool, not what it
    /// put on the wire.
    pub payload_bytes_sent: u64,
    pub payload_bytes_received: u64,
    /// Transaction candidates received from this peer, and how local admission
    /// judged them. `rejected` counts only attributable misconduct; a candidate
    /// dropped because this node was behind or busy is neither accepted nor
    /// rejected.
    pub tx_received: u64,
    pub tx_accepted: u64,
    pub tx_rejected: u64,
    /// Misconduct score. Starts at zero, rises with accepted candidates and
    /// falls with rejected ones; a peer is banned when it drops below
    /// [`crate::PEER_SCORE_BAN_THRESHOLD`].
    pub score: i32,
    /// Remaining ban, when the peer is banned.
    pub banned_for: Option<Duration>,
    /// The newest L1 block for which this peer advertised a different PCASH
    /// block hash than this node derived, since the peer connected.
    pub divergence: Option<BlockHashDivergence>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("identity I/O: {0}")]
    IdentityIo(#[from] std::io::Error),
    #[error("identity encoding: {0}")]
    IdentityEncoding(String),
    #[error("gossipsub configuration: {0}")]
    GossipConfig(String),
    #[error("gossipsub subscription: {0}")]
    GossipSubscription(String),
    #[error("transport configuration: {0}")]
    Transport(String),
    #[error("listen failed: {0}")]
    Listen(String),
    #[error("P2P task stopped")]
    Stopped,
    #[error("P2P command queue is full")]
    Busy,
}

#[derive(Clone, Debug)]
pub struct P2pConfig {
    pub chain_id: u32,
    pub genesis_hash: B256,
    /// The node's transport identity. The peer id derived from it is what other
    /// nodes dial and score, so the caller supplies a stable key.
    pub identity: Keypair,
    pub listen: Multiaddr,
    pub bootstrap: Vec<Multiaddr>,
    pub connectivity: crate::ConnectivityConfig,
    /// Requested content hashes per inventory page. Values above
    /// [`MAX_INVENTORY_PAGE_IDS`] are clamped to that hard limit. Fetches are
    /// independently chunked to [`MAX_GET_IDS`].
    pub max_inventory: usize,
    /// Periodic connected-peer anti-entropy. This retries entries that were
    /// temporarily inadmissible while a node was behind without requiring a
    /// reconnect or another gossip publication.
    pub anti_entropy_interval: Duration,
    /// Current/next rule-prefix capability at the canonical PCASH head. This is
    /// exchanged before transaction inventory or gossip is accepted.
    pub fork_capability: ForkCapability,
    /// How long a peer stays banned after its score crosses the threshold, or
    /// after an explicit banning removal. [`crate::PEER_BAN_DURATION`] is the
    /// default; this is configurable so the ban's expiry is observable without
    /// waiting out an operational duration.
    pub peer_ban_duration: Duration,
}

impl P2pConfig {
    pub fn topic(&self) -> String {
        topic_for(self.chain_id, self.genesis_hash)
    }
}

/// EIP-2124-style current/next fork capability. The chain and genesis fields
/// repeat the transport namespace deliberately: malformed or misrouted
/// handshakes fail before any sync data is exchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ForkCapability {
    pub chain_id: u32,
    pub genesis_hash: B256,
    pub head_timestamp: u64,
    pub current_fork_count: u16,
    pub current_prefix_hash: B256,
    pub next_activation_timestamp: u64,
    pub next_prefix_hash: B256,
}

impl ForkCapability {
    pub fn validate(&self) -> Result<(), ForkCompatibilityError> {
        let no_next_timestamp = self.next_activation_timestamp == 0;
        let no_next_hash = self.next_prefix_hash.is_zero();
        if no_next_timestamp != no_next_hash {
            return Err(ForkCompatibilityError::MalformedNext);
        }
        if !no_next_timestamp && self.next_activation_timestamp <= self.head_timestamp {
            return Err(ForkCompatibilityError::StaleNext);
        }
        Ok(())
    }

    pub fn has_next(&self) -> bool {
        self.next_activation_timestamp != 0
    }
}

/// One canonical PCASH block, named by the L1 block it was derived from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CanonicalHead {
    pub l1_block_number: u64,
    pub l1_block_hash: B256,
    /// The PCASH block hash.
    pub block_hash: B256,
}

/// A peer's PCASH block hash for an L1 block differs from this node's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockHashDivergence {
    pub l1_block_number: u64,
    pub l1_block_hash: B256,
    pub local_block_hash: B256,
    pub peer_block_hash: B256,
}

/// The newest claim above L1 block `after` that names the same L1 block as a
/// local head but a different PCASH block hash.
///
/// The PCASH block derived from an L1 block is deterministic, and the L1 block
/// hash commits to all of L1 history before it, so two compatible nodes that
/// agree on the L1 hash must agree on the PCASH hash. A claim about an L1
/// block this node has not derived, including the same height on another L1
/// fork, says nothing and is skipped.
pub(crate) fn find_divergence(
    local: &[CanonicalHead],
    claimed: &[CanonicalHead],
    after: Option<u64>,
) -> Option<BlockHashDivergence> {
    claimed
        .iter()
        .filter(|claim| after.is_none_or(|after| claim.l1_block_number > after))
        .filter_map(|claim| {
            let local = local.iter().find(|head| {
                head.l1_block_number == claim.l1_block_number
                    && head.l1_block_hash == claim.l1_block_hash
            })?;
            (local.block_hash != claim.block_hash).then_some(BlockHashDivergence {
                l1_block_number: claim.l1_block_number,
                l1_block_hash: claim.l1_block_hash,
                local_block_hash: local.block_hash,
                peer_block_hash: claim.block_hash,
            })
        })
        .max_by_key(|divergence| divergence.l1_block_number)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
pub enum ForkCompatibilityError {
    #[error("fork capability has a partial no-next sentinel")]
    MalformedNext,
    #[error("fork capability advertises a next activation at or before its head")]
    StaleNext,
    #[error("fork capability chain identity differs")]
    ChainIdentity,
    #[error("current fork prefixes differ without one recognized boundary")]
    CurrentPrefix,
    #[error("next fork transition conflicts")]
    NextTransition,
}

/// Decide whether two peers can exchange transaction inventory and gossip at
/// their respective heads. The local capability is already produced by the
/// node or checked at configuration startup; the remote capability is peer input.
/// A peer may know an additional future fork, and peers
/// may straddle exactly one transition when the older peer advertised the
/// newer peer's current prefix as its next prefix.
pub fn check_fork_compatibility(
    local: &ForkCapability,
    remote: &ForkCapability,
) -> Result<(), ForkCompatibilityError> {
    remote.validate()?;
    if local.chain_id != remote.chain_id || local.genesis_hash != remote.genesis_hash {
        return Err(ForkCompatibilityError::ChainIdentity);
    }
    if local.current_fork_count == remote.current_fork_count
        && local.current_prefix_hash == remote.current_prefix_hash
    {
        if local.has_next()
            && remote.has_next()
            && (local.next_activation_timestamp != remote.next_activation_timestamp
                || local.next_prefix_hash != remote.next_prefix_hash)
        {
            return Err(ForkCompatibilityError::NextTransition);
        }
        return Ok(());
    }

    let (older, newer) = if local.current_fork_count < remote.current_fork_count {
        (local, remote)
    } else {
        (remote, local)
    };
    if newer.current_fork_count != older.current_fork_count.saturating_add(1)
        || !older.has_next()
        || older.next_prefix_hash != newer.current_prefix_hash
        || older.next_activation_timestamp > newer.head_timestamp
        || older.head_timestamp >= older.next_activation_timestamp
    {
        return Err(ForkCompatibilityError::CurrentPrefix);
    }
    Ok(())
}

/// Candidate attribution retained through local admission. Gossip verdicts also
/// release libp2p's pending validation; sync verdicts update peer accounting.
#[derive(Clone, Debug)]
pub enum CandidateOrigin {
    Gossip {
        publisher: PeerId,
        propagation_source: PeerId,
        message_id: MessageId,
    },
    Sync {
        peer: PeerId,
    },
}

impl CandidateOrigin {
    /// Original publisher, used for admission work budgets.
    pub fn publisher(&self) -> PeerId {
        match self {
            Self::Gossip { publisher, .. } => *publisher,
            Self::Sync { peer } => *peer,
        }
    }

    /// Peer that delivered the bytes, used for transport accounting and scoring.
    pub fn propagation_peer(&self) -> PeerId {
        match self {
            Self::Gossip {
                propagation_source, ..
            } => *propagation_source,
            Self::Sync { peer } => *peer,
        }
    }

    pub fn is_gossip(&self) -> bool {
        matches!(self, Self::Gossip { .. })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidationResult {
    Accept,
    Reject,
    Ignore,
}

/// Peer connection, disconnection, and compatibility are not events: they are
/// state, and they live in the [`PeerTable`] the swarm writes directly. Only
/// things the owner must *act* on are events.
#[derive(Debug)]
pub enum P2pEvent {
    /// A listen address became available. A wildcard bind such as
    /// `/ip4/0.0.0.0/tcp/8646` produces one of these per matching interface, so
    /// this is an addition to a set, not the node's single address.
    Listening(Multiaddr),
    /// A listen address went away — an interface disappeared, or a listener was
    /// closed. Without this the address set would only ever grow and could
    /// advertise an address that no longer accepts connections.
    ListeningExpired(Multiaddr),
    Candidate {
        tx_bytes: Vec<u8>,
        origin: CandidateOrigin,
    },
    /// A peer advertised a different PCASH block hash for an L1 block this
    /// node derived. Reported once per L1 block per peer connection, and at
    /// most once per exchange.
    BlockHashDivergence {
        peer: PeerId,
        divergence: BlockHashDivergence,
    },
    Warning(String),
}

#[derive(Clone, Debug)]
pub struct InventoryEntry {
    /// Content hash already computed by local transaction admission.
    pub content_hash: B256,
    pub tx_bytes: Vec<u8>,
}

pub(super) enum Command {
    #[cfg(test)]
    ConfirmTestAddress(Multiaddr),
    Announce(Vec<u8>),
    Validation {
        origin: CandidateOrigin,
        result: ValidationResult,
    },
    ReplaceInventory {
        entries: Vec<InventoryEntry>,
        done: Option<oneshot::Sender<()>>,
    },
    UpdateForkCapability(ForkCapability),
    ReplaceHeads(Vec<CanonicalHead>),
    /// Distinct peers with an in-flight inventory session right now.
    #[cfg(test)]
    SyncSessions(oneshot::Sender<Vec<PeerId>>),
    AddPeer {
        address: Multiaddr,
        done: oneshot::Sender<Result<PeerId, String>>,
    },
    RemovePeer {
        peer: PeerId,
        ban: bool,
        done: oneshot::Sender<bool>,
    },
    Shutdown(oneshot::Sender<()>),
}

pub(super) struct RuntimeConfig {
    pub(super) max_inventory: usize,
    pub(super) anti_entropy_interval: Duration,
    pub(super) fork_capability: ForkCapability,
    pub(super) peers: PeerTable,
    pub(super) peer_ban_duration: Duration,
    pub(super) connectivity: crate::connectivity::ConnectivityManager,
}

/// Cloneable command side of a running swarm.
#[derive(Clone)]
pub struct P2pHandle {
    pub(super) peer_id: PeerId,
    pub(super) topic: String,
    pub(super) commands: mpsc::Sender<Command>,
    pub(super) peers: PeerTable,
    pub(super) network: Arc<Mutex<crate::NetworkStatus>>,
}

impl P2pHandle {
    pub fn network_status(&self) -> crate::NetworkStatus {
        self.network
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn try_command(&self, command: Command) -> Result<(), Error> {
        self.commands
            .try_send(command)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => Error::Busy,
                mpsc::error::TrySendError::Closed(_) => Error::Stopped,
            })
    }

    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    pub fn topic(&self) -> &str {
        &self.topic
    }

    /// The connected peers, ordered by peer id.
    ///
    /// This reads the swarm's published snapshot directly rather than asking
    /// the swarm task for it, so a busy or stalled swarm cannot turn a
    /// read-only query into a hang.
    pub fn peers(&self) -> Vec<PeerInfo> {
        self.peer_table().values().cloned().collect()
    }

    /// Number of connected peers. This is the length of the same table
    /// [`Self::peers`] lists, so the two can never disagree.
    pub fn peer_count(&self) -> usize {
        self.peer_table().len()
    }

    pub fn peer(&self, peer: PeerId) -> Option<PeerInfo> {
        self.peer_table().get(&peer).cloned()
    }

    fn peer_table(&self) -> std::sync::MutexGuard<'_, BTreeMap<PeerId, PeerInfo>> {
        self.peers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Publish an entry already admitted into the owner's ready pool. Local
    /// publications are signed and sent immediately; this method is not an
    /// admission or validation API.
    pub async fn announce(&self, tx_bytes: Vec<u8>) -> Result<(), Error> {
        self.commands
            .send(Command::Announce(tx_bytes))
            .await
            .map_err(|_| Error::Stopped)
    }

    /// Non-blocking form used by synchronous RPC handlers after local
    /// admission. A full networking queue does not roll back admission.
    pub fn try_announce(&self, tx_bytes: Vec<u8>) -> Result<(), Error> {
        self.try_command(Command::Announce(tx_bytes))
    }

    pub async fn report_validation(
        &self,
        origin: CandidateOrigin,
        result: ValidationResult,
    ) -> Result<(), Error> {
        self.commands
            .send(Command::Validation { origin, result })
            .await
            .map_err(|_| Error::Stopped)
    }

    /// Non-blocking validation report for overload paths. Dropping an `Ignore`
    /// result when the command queue is already full is preferable to stalling
    /// the owner of the bounded swarm event channel.
    pub fn try_report_validation(
        &self,
        origin: CandidateOrigin,
        result: ValidationResult,
    ) -> Result<(), Error> {
        self.try_command(Command::Validation { origin, result })
    }

    /// Atomically replace the sync snapshot. Only already-admitted ready entries
    /// belong here; the transport never invents or validates inventory contents.
    pub async fn replace_inventory(&self, entries: Vec<InventoryEntry>) -> Result<(), Error> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Command::ReplaceInventory {
                entries,
                done: Some(tx),
            })
            .await
            .map_err(|_| Error::Stopped)?;
        rx.await.map_err(|_| Error::Stopped)
    }

    /// Queue an inventory replacement without waiting for the swarm to apply
    /// it. This is for the event-stream owner, which must not wait on the swarm
    /// while it is also the sole consumer of the swarm's bounded event queue.
    pub fn try_replace_inventory(&self, entries: Vec<InventoryEntry>) -> Result<(), Error> {
        self.try_command(Command::ReplaceInventory {
            entries,
            done: None,
        })
    }

    /// Replace the recent canonical heads this node advertises and compares
    /// peers against: at most [`crate::MAX_CANONICAL_HEADS`], since a peer
    /// refuses a longer list. Non-blocking for the event-stream owner; a later
    /// refresh retries if the command queue is full.
    pub fn try_replace_heads(&self, heads: Vec<CanonicalHead>) -> Result<(), Error> {
        self.try_command(Command::ReplaceHeads(heads))
    }

    /// Live snapshot of distinct peers with an in-flight inventory session.
    /// Best-effort: returns an empty set when the command queue is saturated,
    /// so callers that are also draining the event stream cannot deadlock
    /// against it.
    #[cfg(test)]
    pub async fn sync_session_peers(&self) -> Vec<PeerId> {
        let (tx, rx) = oneshot::channel();
        if self.commands.try_send(Command::SyncSessions(tx)).is_err() {
            return Vec::new();
        }
        match tokio::time::timeout(Duration::from_millis(250), rx).await {
            Ok(Ok(peers)) => peers,
            _ => Vec::new(),
        }
    }

    /// Non-blocking capability refresh for the event-stream owner. A later
    /// refresh retries the latest capability if the command queue is full.
    pub fn try_update_fork_capability(&self, capability: ForkCapability) -> Result<(), Error> {
        self.try_command(Command::UpdateForkCapability(capability))
    }

    /// Dial a peer and keep it in the redial set, so it behaves exactly like a
    /// configured bootnode: a transient disconnect is retried rather than
    /// forgotten.
    ///
    /// This returns once the dial is scheduled, reporting the peer id parsed
    /// from the address — not once the connection is established. Dialing is
    /// retried on a timer, so "connected" is not a terminal state worth holding
    /// an RPC request open across an arbitrary network timeout for; the caller
    /// confirms the outcome by listing peers. The failures worth reporting
    /// synchronously — a malformed address, a missing `/p2p/` component, a
    /// banned peer — are all returned here.
    pub async fn add_peer(&self, address: Multiaddr) -> Result<PeerId, Error> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Command::AddPeer { address, done: tx })
            .await
            .map_err(|_| Error::Stopped)?;
        rx.await
            .map_err(|_| Error::Stopped)?
            .map_err(Error::Transport)
    }

    /// Disconnect a peer and drop it from the redial set. With `ban`, the peer
    /// is also refused for [`crate::PEER_BAN_DURATION`]. Returns whether the
    /// peer was connected or in the redial set.
    pub async fn remove_peer(&self, peer: PeerId, ban: bool) -> Result<bool, Error> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Command::RemovePeer {
                peer,
                ban,
                done: tx,
            })
            .await
            .map_err(|_| Error::Stopped)?;
        rx.await.map_err(|_| Error::Stopped)
    }

    pub async fn shutdown(&self) -> Result<(), Error> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Command::Shutdown(tx))
            .await
            .map_err(|_| Error::Stopped)?;
        rx.await.map_err(|_| Error::Stopped)
    }
}

/// Chain-specific Kademlia namespace.
pub fn discovery_protocol_for(chain_id: u32, genesis_hash: B256) -> String {
    format!("/pcash/{chain_id}/{}/kad", hex::encode(genesis_hash))
}

pub fn topic_for(chain_id: u32, genesis_hash: B256) -> String {
    format!("pcash/v1/{chain_id}/{}/txs", hex::encode(genesis_hash))
}

/// Stable mempool sync stream protocol, keyed only by genesis. Fork choice is a
/// local software decision and does not partition peers that share a network.
pub fn sync_protocol_for(chain_id: u32, genesis_hash: B256) -> String {
    format!(
        "/pcash/mempool/1/{chain_id}/{}/sync",
        hex::encode(genesis_hash)
    )
}

/// Hash of the exact transaction bytes, before canonical inclusion.
pub fn content_hash(bytes: &[u8]) -> B256 {
    keccak256(bytes)
}
