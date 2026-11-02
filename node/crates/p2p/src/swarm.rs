use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Bound;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use libp2p::connection_limits;
use libp2p::core::ConnectedPoint;
use libp2p::gossipsub::{self, IdentTopic, MessageAcceptance, MessageId};
use libp2p::identify;
use libp2p::multiaddr::Protocol;
use libp2p::ping;
use libp2p::request_response::{self, ProtocolSupport};
use libp2p::swarm::dial_opts::{DialOpts, PeerCondition};
use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
use libp2p::{Multiaddr, PeerId, StreamProtocol, SwarmBuilder};
use serde::{Deserialize, Deserializer, Serialize};
use tokio::sync::mpsc;

use alloy_primitives::B256;

use crate::types::{
    check_fork_compatibility, content_hash, find_divergence, sync_protocol_for,
    BlockHashDivergence, CandidateOrigin, CanonicalHead, Command, Direction, Error, ForkCapability,
    ForkCompatibilityError, InventoryEntry, P2pConfig, P2pEvent, P2pHandle, PeerInfo, PeerTable,
    RuntimeConfig, ValidationResult,
};
use crate::{
    COMMAND_CAPACITY, EVENT_CAPACITY, MAX_CANONICAL_HEADS, MAX_CONCURRENT_SYNC_PEERS,
    MAX_CONNECTIONS_PER_PEER, MAX_ESTABLISHED_CONNECTIONS, MAX_ESTABLISHED_INBOUND_CONNECTIONS,
    MAX_GET_IDS, MAX_INBOUND_GET_RESPONSES, MAX_INBOUND_GET_RESPONSES_PER_PEER,
    MAX_INBOUND_GET_RESPONSE_BYTES, MAX_INBOUND_GET_RESPONSE_BYTES_PER_PEER, MAX_INVENTORY_ENTRIES,
    MAX_INVENTORY_PAGE_IDS, MAX_PENDING_INBOUND_CONNECTIONS, MAX_RELAYED_TX_BYTES,
    MAX_SYNC_REQUEST_BYTES, MAX_SYNC_RESPONSE_BYTES, MAX_TRACKED_REPUTATIONS,
    PEER_PUBLISH_INTERVAL, PEER_SCORE_ACCEPTED, PEER_SCORE_DECAY_INTERVAL, PEER_SCORE_REJECTED,
};

pub(super) fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SyncRequest {
    pub(super) capability: ForkCapability,
    pub(super) request: SyncRequestKind,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) enum SyncRequestKind {
    Capability,
    Inventory {
        #[serde(deserialize_with = "required_nullable")]
        after: Option<B256>,
        limit: u16,
    },
    Get {
        content_hashes: Vec<B256>,
    },
    Heads,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SyncResponse {
    pub(super) capability: ForkCapability,
    pub(super) response: SyncResponseKind,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) enum SyncResponseKind {
    Capability,
    Inventory {
        content_hashes: Vec<B256>,
        #[serde(deserialize_with = "required_nullable")]
        next: Option<B256>,
    },
    Transactions {
        entries: Vec<Vec<u8>>,
    },
    Heads {
        heads: Vec<CanonicalHead>,
    },
    Error(String),
}

#[derive(Debug)]
pub(super) enum PendingSyncRequest {
    Capability {
        peer: PeerId,
    },
    Inventory {
        peer: PeerId,
        after: Option<B256>,
        remaining: usize,
    },
    Get {
        peer: PeerId,
        content_hashes: HashSet<B256>,
    },
    Heads {
        peer: PeerId,
    },
}

impl PendingSyncRequest {
    pub(super) fn peer(&self) -> PeerId {
        match self {
            Self::Capability { peer }
            | Self::Inventory { peer, .. }
            | Self::Get { peer, .. }
            | Self::Heads { peer } => *peer,
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(super) struct InboundGetUsage {
    pub(super) responses: usize,
    pub(super) bytes: usize,
}

pub(super) struct InboundGetBudget {
    charges: HashMap<request_response::InboundRequestId, (PeerId, usize)>,
    pub(super) responses: usize,
    pub(super) bytes: usize,
    pub(super) per_peer: HashMap<PeerId, InboundGetUsage>,
    pub(super) max_responses: usize,
    pub(super) max_responses_per_peer: usize,
    pub(super) max_bytes: usize,
    pub(super) max_bytes_per_peer: usize,
}

/// Everything the swarm tracks about one connected peer.
///
/// Connection, handshake, and accounting state share one entry so peer counts
/// and listings use the same set of peers.
pub(super) struct PeerState {
    pub(super) connected_at: Instant,
    pub(super) direction: Direction,
    pub(super) remote_address: Multiaddr,
    pub(super) connections: u32,
    pub(super) compatible: bool,
    pub(super) incompatible_reason: Option<String>,
    pub(super) capability: Option<ForkCapability>,
    pub(super) agent_version: Option<String>,
    pub(super) protocol_version: Option<String>,
    pub(super) rtt: Option<Duration>,
    pub(super) payload_bytes_sent: u64,
    pub(super) payload_bytes_received: u64,
    pub(super) tx_received: u64,
    pub(super) tx_accepted: u64,
    pub(super) tx_rejected: u64,
    /// Newest reported divergence. Later responses report only newer L1
    /// blocks, so one divergent block is logged and counted once.
    pub(super) divergence: Option<BlockHashDivergence>,
    /// Round-robin cursor for anti-entropy inventory sync. Peers with no prior
    /// round sort first.
    pub(super) sync_sequence: u64,
}

impl PeerState {
    pub(super) fn new(direction: Direction, remote_address: Multiaddr) -> Self {
        Self {
            connected_at: Instant::now(),
            direction,
            remote_address,
            connections: 1,
            compatible: false,
            incompatible_reason: None,
            capability: None,
            agent_version: None,
            protocol_version: None,
            rtt: None,
            payload_bytes_sent: 0,
            payload_bytes_received: 0,
            tx_received: 0,
            tx_accepted: 0,
            tx_rejected: 0,
            divergence: None,
            sync_sequence: 0,
        }
    }
}

/// Score and ban state, kept apart from [`PeerState`] because it must outlive
/// the connection: a ban that evaporated when the peer reconnected would not be
/// a ban at all.
#[derive(Clone, Copy, Default)]
pub(super) struct Reputation {
    pub(super) score: i32,
    pub(super) banned_until: Option<Instant>,
}

impl Reputation {
    pub(crate) fn is_banned(&self, now: Instant) -> bool {
        self.banned_until.is_some_and(|until| until > now)
    }
}

/// Reputation for peers that are not currently connected is retained so bans
/// and scores survive a reconnect, but it cannot grow without bound: peer ids
/// are cheap to mint. Entries that carry nothing worth remembering — a
/// non-negative score and no active ban — are dropped first.
pub(super) fn prune_reputation(reputation: &mut HashMap<PeerId, Reputation>, now: Instant) {
    if reputation.len() <= MAX_TRACKED_REPUTATIONS {
        return;
    }
    reputation.retain(|_, entry| entry.score < 0 || entry.is_banned(now));
    if reputation.len() <= MAX_TRACKED_REPUTATIONS {
        return;
    }
    // Still over budget with nothing expendable left: keep the worst offenders,
    // which are the ones a ban decision would otherwise have to relearn.
    let mut entries = reputation
        .iter()
        .map(|(peer, e)| (*peer, *e))
        .collect::<Vec<_>>();
    entries.sort_by_key(|(peer, entry)| (entry.score, *peer));
    for (peer, _) in entries.into_iter().skip(MAX_TRACKED_REPUTATIONS) {
        reputation.remove(&peer);
    }
}

/// Move a peer's score and ban it once it crosses the threshold.
fn adjust_score(
    swarm: &mut libp2p::Swarm<Behaviour>,
    peer: PeerId,
    delta: i32,
    ban_duration: Duration,
) {
    if swarm
        .behaviour_mut()
        .policy
        .adjust_score(peer, delta, ban_duration)
    {
        if let Some(kad) = swarm.behaviour_mut().connectivity.kad.as_mut() {
            kad.remove_peer(&peer);
        }
        // Disconnect, but keep the peer's address: this ban is temporary, and
        // forgetting the address would make it permanent by leaving the redial
        // loop nothing to retry once it expires. Only an explicit `RemovePeer`
        // forgets an address.
        let _ = swarm.disconnect_peer_id(peer);
    }
}

/// Republish the connected-peer view for readers outside the swarm task.
pub(super) fn publish_peers(
    peers: &BTreeMap<PeerId, PeerState>,
    reputation: &HashMap<PeerId, Reputation>,
    table: &PeerTable,
) {
    let now = Instant::now();
    let snapshot = peers
        .iter()
        .map(|(peer, state)| {
            let entry = reputation.get(peer).copied().unwrap_or_default();
            (
                *peer,
                PeerInfo {
                    peer_id: *peer,
                    remote_address: state.remote_address.clone(),
                    direction: state.direction,
                    connected_for: now.saturating_duration_since(state.connected_at),
                    connections: state.connections,
                    compatible: state.compatible,
                    incompatible_reason: state.incompatible_reason.clone(),
                    capability: state.capability,
                    agent_version: state.agent_version.clone(),
                    protocol_version: state.protocol_version.clone(),
                    rtt: state.rtt,
                    payload_bytes_sent: state.payload_bytes_sent,
                    payload_bytes_received: state.payload_bytes_received,
                    tx_received: state.tx_received,
                    tx_accepted: state.tx_accepted,
                    tx_rejected: state.tx_rejected,
                    score: entry.score,
                    banned_for: entry
                        .banned_until
                        .and_then(|until| until.checked_duration_since(now)),
                    divergence: state.divergence,
                },
            )
        })
        .collect();
    *table
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot;
}

pub(super) struct SyncEventContext<'a> {
    pub(super) inventory: &'a BTreeMap<B256, Vec<u8>>,
    /// This node's recent canonical heads, as its owner last supplied them.
    pub(super) heads: &'a [CanonicalHead],
    pub(super) max_inventory: usize,
    pub(super) pending_sync:
        &'a mut HashMap<request_response::OutboundRequestId, PendingSyncRequest>,
    pub(super) inbound_get_budget: &'a mut InboundGetBudget,
    pub(super) peers: &'a mut BTreeMap<PeerId, PeerState>,
    pub(super) peer_ban_duration: Duration,
    /// Round-robin cursor shared by the anti-entropy tick and the capability
    /// response path, whose sessions must respect the same rotation.
    pub(super) next_sync_sequence: &'a mut u64,
    pub(super) local_capability: ForkCapability,
    pub(super) events: &'a mpsc::Sender<P2pEvent>,
}

impl InboundGetBudget {
    pub(super) fn new() -> Self {
        Self::with_limits(
            MAX_INBOUND_GET_RESPONSES,
            MAX_INBOUND_GET_RESPONSES_PER_PEER,
            MAX_INBOUND_GET_RESPONSE_BYTES,
            MAX_INBOUND_GET_RESPONSE_BYTES_PER_PEER,
        )
    }

    pub(super) fn with_limits(
        max_responses: usize,
        max_responses_per_peer: usize,
        max_bytes: usize,
        max_bytes_per_peer: usize,
    ) -> Self {
        Self {
            charges: HashMap::new(),
            responses: 0,
            bytes: 0,
            per_peer: HashMap::new(),
            max_responses,
            max_responses_per_peer,
            max_bytes,
            max_bytes_per_peer,
        }
    }

    pub(super) fn reserve(
        &mut self,
        request_id: request_response::InboundRequestId,
        peer: PeerId,
        bytes: usize,
    ) -> bool {
        let usage = self.per_peer.get(&peer).copied().unwrap_or_default();
        if self.responses >= self.max_responses
            || usage.responses >= self.max_responses_per_peer
            || self.bytes.saturating_add(bytes) > self.max_bytes
            || usage.bytes.saturating_add(bytes) > self.max_bytes_per_peer
        {
            return false;
        }
        self.charges.insert(request_id, (peer, bytes));
        self.responses += 1;
        self.bytes += bytes;
        self.per_peer.insert(
            peer,
            InboundGetUsage {
                responses: usage.responses + 1,
                bytes: usage.bytes + bytes,
            },
        );
        true
    }

    pub(super) fn release(&mut self, request_id: request_response::InboundRequestId) {
        let Some((peer, bytes)) = self.charges.remove(&request_id) else {
            return;
        };
        self.responses -= 1;
        self.bytes -= bytes;
        if let Some(usage) = self.per_peer.get_mut(&peer) {
            usage.responses -= 1;
            usage.bytes -= bytes;
            if usage.responses == 0 {
                self.per_peer.remove(&peer);
            }
        }
    }

    pub(super) fn release_peer(&mut self, peer: PeerId) {
        self.charges
            .retain(|_, (charged_peer, _)| *charged_peer != peer);
        if let Some(usage) = self.per_peer.remove(&peer) {
            self.responses -= usage.responses;
            self.bytes -= usage.bytes;
        }
    }
}

/// Attribute PCASH protocol payload to a peer. See [`PeerInfo::payload_bytes_sent`]
/// for exactly what these numbers do and do not include.
pub(super) fn record_payload_sent(
    peers: &mut BTreeMap<PeerId, PeerState>,
    peer: PeerId,
    bytes: u64,
) {
    if let Some(state) = peers.get_mut(&peer) {
        state.payload_bytes_sent = state.payload_bytes_sent.saturating_add(bytes);
    }
}

pub(super) fn record_payload_received(
    peers: &mut BTreeMap<PeerId, PeerState>,
    peer: PeerId,
    bytes: u64,
) {
    if let Some(state) = peers.get_mut(&peer) {
        state.payload_bytes_received = state.payload_bytes_received.saturating_add(bytes);
    }
}

pub(super) fn get_response_work_bytes<'a>(entries: impl Iterator<Item = &'a Vec<u8>>) -> usize {
    entries.fold(4_096usize, |total, bytes| {
        total.saturating_add(bytes.len().saturating_add(64))
    })
}

pub(super) type Behaviour = crate::policy::Guarded<Protocols>;

#[derive(NetworkBehaviour)]
#[behaviour(to_swarm = "BehaviourEvent")]
pub(super) struct Protocols {
    pub(super) connectivity: crate::connectivity::Connectivity,
    pub(super) gossip: gossipsub::Behaviour,
    pub(super) identify: identify::Behaviour,
    pub(super) ping: ping::Behaviour,
    pub(super) sync: request_response::cbor::Behaviour<SyncRequest, SyncResponse>,
}

#[derive(Debug)]
pub(super) enum BehaviourEvent {
    Connectivity(crate::connectivity::ConnectivityEvent),
    Gossip(gossipsub::Event),
    Identify(Box<identify::Event>),
    Ping(ping::Event),
    Sync(request_response::Event<SyncRequest, SyncResponse>),
}

impl From<gossipsub::Event> for BehaviourEvent {
    fn from(value: gossipsub::Event) -> Self {
        Self::Gossip(value)
    }
}
impl From<crate::connectivity::ConnectivityEvent> for BehaviourEvent {
    fn from(event: crate::connectivity::ConnectivityEvent) -> Self {
        Self::Connectivity(event)
    }
}

impl From<identify::Event> for BehaviourEvent {
    fn from(value: identify::Event) -> Self {
        Self::Identify(Box::new(value))
    }
}
impl From<ping::Event> for BehaviourEvent {
    fn from(value: ping::Event) -> Self {
        Self::Ping(value)
    }
}
impl From<request_response::Event<SyncRequest, SyncResponse>> for BehaviourEvent {
    fn from(value: request_response::Event<SyncRequest, SyncResponse>) -> Self {
        Self::Sync(value)
    }
}

/// Start the P2P task. The returned event receiver is intentionally bounded;
/// control events apply backpressure, while transaction candidates are shed if
/// the owner cannot keep up rather than stalling the swarm or growing memory
/// without bound.
pub async fn start(config: P2pConfig) -> Result<(P2pHandle, mpsc::Receiver<P2pEvent>), Error> {
    start_with_inventory(config, Vec::new()).await
}

/// Start with an already-admitted inventory snapshot installed before the
/// swarm begins polling connections. This prevents restart-time peers from
/// observing a transient empty inventory.
pub async fn start_with_inventory(
    config: P2pConfig,
    initial_inventory: Vec<InventoryEntry>,
) -> Result<(P2pHandle, mpsc::Receiver<P2pEvent>), Error> {
    start_with_inventory_and_event_capacity(config, initial_inventory, EVENT_CAPACITY).await
}

#[cfg(test)]
pub(super) async fn start_with_event_capacity(
    config: P2pConfig,
    event_capacity: usize,
) -> Result<(P2pHandle, mpsc::Receiver<P2pEvent>), Error> {
    start_with_inventory_and_event_capacity(config, Vec::new(), event_capacity).await
}

async fn start_with_inventory_and_event_capacity(
    config: P2pConfig,
    initial_inventory: Vec<InventoryEntry>,
    event_capacity: usize,
) -> Result<(P2pHandle, mpsc::Receiver<P2pEvent>), Error> {
    if config.anti_entropy_interval.is_zero() {
        return Err(Error::Transport(
            "anti-entropy interval must be positive".to_owned(),
        ));
    }
    config
        .fork_capability
        .validate()
        .map_err(|error| Error::Transport(error.to_string()))?;
    if config.fork_capability.chain_id != config.chain_id
        || config.fork_capability.genesis_hash != config.genesis_hash
    {
        return Err(Error::Transport(
            "fork capability does not match the P2P chain identity".to_owned(),
        ));
    }
    let keypair = config.identity.clone();
    let peer_id = keypair.public().to_peer_id();
    crate::connectivity::validate(&config.connectivity, peer_id)?;
    let discovery_protocol = StreamProtocol::try_from_owned(crate::discovery_protocol_for(
        config.chain_id,
        config.genesis_hash,
    ))
    .map_err(|e| Error::Transport(e.to_string()))?;
    let topic_name = config.topic();
    let topic = IdentTopic::new(topic_name.clone());
    let bootstrap = config
        .bootstrap
        .iter()
        .chain(&config.connectivity.relay_seeds)
        .cloned()
        .map(DialTarget::parse)
        .collect::<Result<Vec<_>, _>>()?;

    let gossip_config = gossipsub::ConfigBuilder::default()
        .validation_mode(gossipsub::ValidationMode::Strict)
        .validate_messages()
        .message_id_fn(|message| MessageId::from(hex::encode(content_hash(&message.data))))
        // libp2p's ceiling covers the signed pubsub frame, not only `data`.
        .max_transmit_size(MAX_RELAYED_TX_BYTES + 2_048)
        .build()
        .map_err(|e| Error::GossipConfig(e.to_string()))?;
    let mut gossip = gossipsub::Behaviour::new(
        gossipsub::MessageAuthenticity::Signed(keypair.clone()),
        gossip_config,
    )
    .map_err(|e| Error::GossipConfig(e.to_string()))?;
    gossip
        .subscribe(&topic)
        .map_err(|e| Error::GossipSubscription(e.to_string()))?;

    let identify = identify::Behaviour::new(
        identify::Config::new("/pcash/mempool/1".to_owned(), keypair.public())
            .with_cache_size(0)
            .with_hide_listen_addrs(true)
            .with_push_listen_addr_updates(true),
    );
    let ping = ping::Behaviour::new(ping::Config::new());
    let sync_config = request_response::Config::default()
        .with_request_timeout(Duration::from_secs(15))
        .with_max_concurrent_streams(32);
    let sync_codec = request_response::cbor::codec::Codec::<SyncRequest, SyncResponse>::default()
        .set_request_size_maximum(MAX_SYNC_REQUEST_BYTES)
        .set_response_size_maximum(MAX_SYNC_RESPONSE_BYTES);
    let sync_protocol =
        StreamProtocol::try_from_owned(sync_protocol_for(config.chain_id, config.genesis_hash))
            .map_err(|e| Error::Transport(e.to_string()))?;
    let sync = request_response::cbor::Behaviour::with_codec(
        sync_codec,
        [(sync_protocol, ProtocolSupport::Full)],
        sync_config,
    );

    let make_protocols = |relay_client| Protocols {
        connectivity: crate::connectivity::Connectivity::new(
            &config.connectivity,
            peer_id,
            discovery_protocol.clone(),
            relay_client,
        ),
        gossip,
        identify,
        ping,
        sync,
    };
    let mut swarm = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default().nodelay(true),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )
        .map_err(|e| Error::Transport(e.to_string()))?
        .with_relay_client(libp2p::noise::Config::new, libp2p::yamux::Config::default)
        .map_err(|e| Error::Transport(e.to_string()))?
        .with_behaviour(|_, client| crate::policy::Guarded {
            inner: make_protocols(client),
            limits: connection_limits::Behaviour::new(
                connection_limits::ConnectionLimits::default()
                    .with_max_pending_outgoing(Some(crate::MAX_PENDING_OUTBOUND_CONNECTIONS))
                    .with_max_pending_incoming(Some(MAX_PENDING_INBOUND_CONNECTIONS))
                    .with_max_established_incoming(Some(MAX_ESTABLISHED_INBOUND_CONNECTIONS))
                    .with_max_established(Some(MAX_ESTABLISHED_CONNECTIONS))
                    .with_max_established_per_peer(Some(MAX_CONNECTIONS_PER_PEER)),
            ),

            policy: crate::policy::Policy::new(
                peer_id,
                config.connectivity.allow_private_addresses,
            ),
        })
        .map_err(|e| Error::Transport(e.to_string()))?
        .with_swarm_config(|cfg| {
            cfg.with_idle_connection_timeout(Duration::from_mins(2))
                .with_dial_concurrency_factor(
                    std::num::NonZeroU8::new(crate::DIAL_CONCURRENCY)
                        .unwrap_or(std::num::NonZeroU8::MIN),
                )
        })
        .build();

    if let Some(address) = &config.connectivity.advertised_address {
        swarm.add_external_address(address.clone());
    }
    for target in &bootstrap {
        swarm.behaviour_mut().policy.configure(target);
        if let Some(kad) = swarm.behaviour_mut().connectivity.kad.as_mut() {
            kad.add_address(&target.peer, target.address.clone());
        }
    }
    swarm
        .listen_on(config.listen.clone())
        .map_err(|e| Error::Listen(e.to_string()))?;
    let (command_tx, command_rx) = mpsc::channel(COMMAND_CAPACITY);
    let (event_tx, event_rx) = mpsc::channel(event_capacity);
    // The table is created here rather than passed in through the config so
    // that cloning a config to start a second node cannot silently share one
    // node's peer view with another.
    let peers: PeerTable = Arc::new(Mutex::new(BTreeMap::new()));
    let network = Arc::new(Mutex::new(crate::NetworkStatus::default()));
    let handle = P2pHandle {
        network: Arc::clone(&network),
        peer_id,
        topic: topic_name,
        commands: command_tx,
        peers: Arc::clone(&peers),
    };
    tokio::spawn(run(
        swarm,
        topic,
        RuntimeConfig {
            connectivity: crate::connectivity::ConnectivityManager::new(
                config.connectivity,
                discovery_protocol.to_string(),
                network,
            ),
            max_inventory: config.max_inventory.clamp(1, MAX_INVENTORY_PAGE_IDS),
            anti_entropy_interval: config.anti_entropy_interval,
            fork_capability: config.fork_capability,
            peers,
            peer_ban_duration: config.peer_ban_duration,
        },
        initial_inventory,
        command_rx,
        event_tx,
    ));
    Ok((handle, event_rx))
}

/// Candidate delivery is the high-volume event path. It must never wait on the
/// owner because the owner also sends commands back to this swarm. Returning
/// `false` lets gossip callers release libp2p's pending validation state with an
/// explicit `Ignore` result.
fn emit_candidate(
    events: &mpsc::Sender<P2pEvent>,
    tx_bytes: Vec<u8>,
    origin: CandidateOrigin,
) -> bool {
    events
        .try_send(P2pEvent::Candidate { tx_bytes, origin })
        .is_ok()
}

/// Diagnostics are lossy so a slow owner cannot block the swarm's command loop.
fn emit_warning(events: &mpsc::Sender<P2pEvent>, message: String) {
    let _ = events.try_send(P2pEvent::Warning(message));
}

async fn run(
    mut swarm: libp2p::Swarm<Behaviour>,
    topic: IdentTopic,
    config: RuntimeConfig,
    initial_inventory: Vec<InventoryEntry>,
    mut commands: mpsc::Receiver<Command>,
    events: mpsc::Sender<P2pEvent>,
) {
    let RuntimeConfig {
        mut connectivity,
        max_inventory,
        anti_entropy_interval,
        mut fork_capability,
        peers: peer_table,
        peer_ban_duration,
    } = config;
    let mut inventory = inventory_snapshot(initial_inventory);
    let mut heads = Vec::<CanonicalHead>::new();
    let mut peers = BTreeMap::<PeerId, PeerState>::new();
    let mut pending_sync =
        HashMap::<request_response::OutboundRequestId, PendingSyncRequest>::new();
    let mut inbound_get_budget = InboundGetBudget::new();
    let mut next_sync_sequence = 1u64;
    let mut score_decay = tokio::time::interval(PEER_SCORE_DECAY_INTERVAL);
    score_decay.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    score_decay.tick().await;
    let mut peer_publish = tokio::time::interval(PEER_PUBLISH_INTERVAL);
    peer_publish.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut anti_entropy = tokio::time::interval(anti_entropy_interval);
    anti_entropy.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Do not start a second initial sync immediately after ConnectionEstablished.
    anti_entropy.tick().await;

    loop {
        tokio::select! {
            _ = peer_publish.tick() => {
                connectivity.tick(&mut swarm, &peers);
                publish_peers(&peers, swarm.behaviour().policy.reputations(), &peer_table);
            }
            _ = score_decay.tick() => {
                swarm.behaviour_mut().policy.decay_reputation();
                publish_peers(&peers, swarm.behaviour().policy.reputations(), &peer_table);
            }
            _ = anti_entropy.tick(), if peers.values().any(|state| state.compatible) => {
                let scheduled = schedule_inventory_sync(
                    &mut swarm,
                    &mut pending_sync,
                    &mut peers,
                    &mut next_sync_sequence,
                    max_inventory,
                    fork_capability,
                );
                // Heads ride only the rounds this timer starts, not the round
                // a new connection's capability probe starts. A peer's claims
                // are therefore read at most MAX_CONCURRENT_SYNC_PEERS times per
                // interval node-wide, however fast peers reconnect or rotate
                // identities.
                for peer in scheduled {
                    request_heads(&mut swarm, &mut pending_sync, peer, fork_capability);
                }
            }
            command = commands.recv() => match command {
                Some(Command::Announce(bytes)) => {
                    let payload = bytes.len() as u64;
                    match swarm.behaviour_mut().gossip.publish(topic.clone(), bytes) {
                        Ok(message_id) => {
                            // Attribute the published payload to every peer
                            // gossipsub actually forwarded it to, which is
                            // the mesh for this topic rather than every
                            // connected peer.
                            let recipients = swarm
                                .behaviour()
                                .gossip
                                .all_mesh_peers()
                                .copied()
                                .collect::<Vec<_>>();
                            for peer in recipients {
                                record_payload_sent(&mut peers, peer, payload);
                            }
                            tracing::trace!(%message_id, "gossip published");
                        }
                        Err(error) => {
                            emit_warning(&events, format!("gossip publish failed: {error}"));
                        }
                    }
                }
                Some(Command::Validation { origin, result }) => {
                    // Local admission's verdict is the peer-misconduct signal:
                    // `Reject` means the bytes cannot be valid under any state,
                    // which is attributable to whoever sent them, while
                    // `Ignore` covers this node being behind, full, or unable
                    // to verify — never the peer's fault.
                    let peer = origin.propagation_peer();
                    let delta = match result {
                        ValidationResult::Accept => {
                            if let Some(state) = peers.get_mut(&peer) {
                                state.tx_accepted = state.tx_accepted.saturating_add(1);
                            }
                            PEER_SCORE_ACCEPTED
                        }
                        ValidationResult::Reject => {
                            if let Some(state) = peers.get_mut(&peer) {
                                state.tx_rejected = state.tx_rejected.saturating_add(1);
                            }
                            PEER_SCORE_REJECTED
                        }
                        ValidationResult::Ignore => 0,
                    };
                    if delta != 0 {
                        adjust_score(&mut swarm, peer, delta, peer_ban_duration);
                    }
                    if let CandidateOrigin::Gossip { message_id, propagation_source, .. } = origin {
                        let acceptance = match result {
                            ValidationResult::Accept => MessageAcceptance::Accept,
                            ValidationResult::Reject => MessageAcceptance::Reject,
                            ValidationResult::Ignore => MessageAcceptance::Ignore,
                        };
                        swarm.behaviour_mut().gossip.report_message_validation_result(
                            &message_id,
                            &propagation_source,
                            acceptance,
                        );
                    }
                }
                #[cfg(test)]
                Some(Command::ConfirmTestAddress(address)) => {
                    swarm.add_external_address(address);
                }
                Some(Command::AddPeer { address, done }) => {
                    let result = add_peer(
                        &mut swarm,
                        address,
                    );
                    let _ = done.send(result);
                }
                Some(Command::RemovePeer { peer, ban, done }) => {
                    let known = swarm.behaviour().policy.known(peer);
                    if ban {
                        swarm.behaviour_mut().policy.ban(peer, peer_ban_duration);
                    }
                    disconnect_and_forget(&mut swarm, peer);
                    publish_peers(&peers, swarm.behaviour().policy.reputations(), &peer_table);
                    let _ = done.send(known);
                }
                Some(Command::ReplaceInventory { entries, done }) => {
                    inventory = inventory_snapshot(entries);
                    if let Some(done) = done {
                        let _ = done.send(());
                    }
                }
                Some(Command::ReplaceHeads(next)) => {
                    heads = next;
                }
                #[cfg(test)]
                Some(Command::SyncSessions(done)) => {
                    let _ = done.send(
                        pending_sync
                            .values()
                            .filter(|request| {
                                !matches!(request, PendingSyncRequest::Capability { .. })
                            })
                            .map(PendingSyncRequest::peer)
                            .collect::<HashSet<_>>()
                            .into_iter()
                            .collect(),
                    );
                }
                Some(Command::UpdateForkCapability(capability)) => {
                    if capability != fork_capability {
                        let mut previous_rules = fork_capability;
                        previous_rules.head_timestamp = 0;
                        let mut next_rules = capability;
                        next_rules.head_timestamp = 0;
                        fork_capability = capability;
                        if previous_rules != next_rules {
                            for (peer, state) in &mut peers {
                                state.compatible = false;
                                state.incompatible_reason = None;
                                state.capability = None;
                                request_capability(&mut swarm, &mut pending_sync, *peer, fork_capability);
                            }
                            publish_peers(&peers, swarm.behaviour().policy.reputations(), &peer_table);
                        }
                    }
                }
                Some(Command::Shutdown(done)) => {
                    let _ = done.send(());
                    break;
                }
                None => break,
            },
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } if crate::connectivity::relay_of(&address).is_none() => {
                        let _ = events.send(P2pEvent::Listening(address)).await;
                    }
                    SwarmEvent::ExpiredListenAddr { address, .. } if crate::connectivity::relay_of(&address).is_none() => {
                        let _ = events.send(P2pEvent::ListeningExpired(address)).await;
                    }
                    SwarmEvent::ListenerClosed { listener_id, .. } => {
                        connectivity.listener_closed(&mut swarm, listener_id);
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                        // A second connection keeps the existing admission and
                        // reputation state while its endpoint is updated below.
                        if let std::collections::btree_map::Entry::Vacant(entry) = peers.entry(peer_id) {
                            let (direction, address) = match &endpoint {
                                ConnectedPoint::Dialer { address, .. } => {
                                    (Direction::Outbound, address.clone())
                                }
                                ConnectedPoint::Listener { send_back_addr, .. } => {
                                    (Direction::Inbound, send_back_addr.clone())
                                }
                            };
                            entry.insert(PeerState::new(direction, address));
                            request_capability(
                                &mut swarm,
                                &mut pending_sync,
                                peer_id,
                                fork_capability,
                            );
                        }
                        refresh_endpoint(&swarm, &mut peers, peer_id);
                        close_redundant_connections(&mut swarm, peer_id);
                        publish_peers(&peers, swarm.behaviour().policy.reputations(), &peer_table);
                    }
                    SwarmEvent::ConnectionClosed { peer_id, num_established, .. } => {
                        if num_established > 0 {
                            refresh_endpoint(&swarm, &mut peers, peer_id);
                            publish_peers(&peers, swarm.behaviour().policy.reputations(), &peer_table);
                            continue;
                        }
                        peers.remove(&peer_id);
                        pending_sync.retain(|_, request| request.peer() != peer_id);
                        inbound_get_budget.release_peer(peer_id);
                        publish_peers(&peers, swarm.behaviour().policy.reputations(), &peer_table);
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Gossip(gossipsub::Event::Message {
                        propagation_source,
                        message_id,
                        message,
                    })) => {
                        if message.data.len() > MAX_RELAYED_TX_BYTES {
                            swarm.behaviour_mut().gossip.report_message_validation_result(
                                &message_id,
                                &propagation_source,
                                MessageAcceptance::Reject,
                            );
                            // No honest peer forwards bytes over the limit, so
                            // the sender is the offender.
                            adjust_score(&mut swarm, propagation_source, PEER_SCORE_REJECTED, peer_ban_duration);
                            continue;
                        }
                        if !peers.get(&propagation_source).is_some_and(|state| state.compatible) {
                            swarm.behaviour_mut().gossip.report_message_validation_result(
                                &message_id,
                                &propagation_source,
                                MessageAcceptance::Ignore,
                            );
                            continue;
                        }
                        // Bandwidth is what this connection cost us, so it is
                        // charged to the peer that actually sent the bytes.
                        record_payload_received(&mut peers, propagation_source, message.data.len() as u64);
                        if let Some(state) = peers.get_mut(&propagation_source) {
                            state.tx_received = state.tx_received.saturating_add(1);
                        }
                        // Strict signed gossip carries the original publisher.
                        // Attribute expensive-work budgets to it rather than an
                        // honest mesh peer that merely forwarded the message.
                        let publisher = message.source.unwrap_or(propagation_source);
                        if !emit_candidate(
                            &events,
                            message.data,
                            CandidateOrigin::Gossip {
                                publisher,
                                message_id: message_id.clone(),
                                propagation_source,
                            },
                        ) {
                            swarm.behaviour_mut().gossip.report_message_validation_result(
                                &message_id,
                                &propagation_source,
                                MessageAcceptance::Ignore,
                            );
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Sync(event)) => {
                        handle_sync_event(
                            event,
                            &mut swarm,
                            SyncEventContext {
                                inventory: &inventory,
                                heads: &heads,
                                max_inventory,
                                pending_sync: &mut pending_sync,
                                inbound_get_budget: &mut inbound_get_budget,
                                peers: &mut peers,
                                peer_ban_duration,
                                next_sync_sequence: &mut next_sync_sequence,
                                local_capability: fork_capability,
                                events: &events,
                            },
                        )
                        .await;
                    }
                    // A dial that fails after being queued is reported here
                    // rather than by `swarm.dial`, so without this arm a node
                    // that cannot reach its bootstrap peers says nothing at all.
                    SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                        emit_warning(&events, dial_failure_warning(peer_id, &error));
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Connectivity(event)) => {
                        connectivity.event(&mut swarm, event);
                    }
                    SwarmEvent::ExternalAddrConfirmed { .. } | SwarmEvent::ExternalAddrExpired { .. } => {
                        let connected: Vec<_> = swarm.connected_peers().copied().collect();
                        swarm.behaviour_mut().identify.push(connected);
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Identify(event)) => {
                        if let identify::Event::Received { peer_id, info, .. } = *event {
                            connectivity.identify(&mut swarm, peer_id, &info);
                            if let Some(state) = peers.get_mut(&peer_id) {
                                state.agent_version = Some(info.agent_version);
                                state.protocol_version = Some(info.protocol_version);
                            }
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Ping(event)) => {
                        if let Ok(rtt) = event.result {
                            if let Some(state) = peers.get_mut(&event.peer) {
                                state.rtt = Some(rtt);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

pub(super) fn inventory_snapshot(entries: Vec<InventoryEntry>) -> BTreeMap<B256, Vec<u8>> {
    entries
        .into_iter()
        .take(MAX_INVENTORY_ENTRIES)
        .map(|entry| (entry.content_hash, entry.tx_bytes))
        .collect()
}

/// Whether an established connection must be dropped because the operator
/// removed the peer while its dial was still in flight.
///
/// Dial an operator peer and retain it in the shared policy's persistent set.
pub(super) fn add_peer(
    swarm: &mut libp2p::Swarm<Behaviour>,
    address: Multiaddr,
) -> Result<PeerId, String> {
    let target = DialTarget::parse(address).map_err(|error| error.to_string())?;
    let peer = target.peer;
    if swarm.local_peer_id() == &peer {
        return Err("refusing to dial this node's own peer id".to_owned());
    }
    if swarm.behaviour().policy.banned(peer) {
        return Err(format!("peer {peer} is banned"));
    }
    swarm.behaviour_mut().policy.configure(&target);
    let options = target.dial_opts();
    match swarm.dial(options) {
        Ok(()) => Ok(peer),
        // Already connected or dialing is the requested end state, not a
        // failure: the address is in the redial set either way.
        Err(libp2p::swarm::DialError::DialPeerConditionFalse(_)) => Ok(peer),
        Err(error) => Err(format!("failed to dial {peer}: {error}")),
    }
}

/// Disconnect a peer and drop it from the redial set, so it does not come back
/// on the next redial tick.
pub(super) fn disconnect_and_forget(swarm: &mut libp2p::Swarm<Behaviour>, peer: PeerId) {
    swarm.behaviour_mut().policy.remove(peer);
    if let Some(kad) = swarm.behaviour_mut().connectivity.kad.as_mut() {
        kad.remove_peer(&peer);
    }
    let _ = swarm.disconnect_peer_id(peer);
}

/// The peer id a `/p2p/<peer-id>`-terminated address names.
pub fn peer_id_of(address: &Multiaddr) -> Option<PeerId> {
    match address.iter().last() {
        Some(Protocol::P2p(peer_id)) => Some(peer_id),
        _ => None,
    }
}

/// A transport address plus the `/p2p/<peer-id>` suffix a dialer expects.
///
/// This is the inverse of what `DialTarget::parse` takes apart, and the exact
/// string `admin_addPeer` and `--p2p-bootnode` accept. Written once so the
/// address `admin_nodeInfo` reports and the one `pcash-cli p2p-key` composes
/// from a key file cannot drift.
pub fn bootstrap_address(transport: &Multiaddr, peer_id: PeerId) -> Multiaddr {
    let mut address = transport.clone();
    address.push(Protocol::P2p(peer_id));
    address
}

/// Parsed once at the configuration or admin boundary and retained for retries.
pub(super) struct DialTarget {
    pub(super) peer: PeerId,
    pub(super) address: Multiaddr,
    transport_address: Multiaddr,
}

impl DialTarget {
    pub(super) fn parse(address: Multiaddr) -> Result<Self, Error> {
        let mut transport_address = address.clone();
        let Some(Protocol::P2p(peer)) = transport_address.pop() else {
            return Err(Error::Transport(format!(
                "bootstrap address must end in /p2p/<peer-id>: {address}"
            )));
        };
        if crate::policy::endpoint_ip(&address, peer).is_none() {
            return Err(Error::Transport(format!(
                "bootstrap address must contain an IP/TCP endpoint or a single relay hop: {address}"
            )));
        }
        Ok(Self {
            peer,
            address,
            transport_address,
        })
    }

    pub(super) fn dial_opts(&self) -> DialOpts {
        DialOpts::peer_id(self.peer)
            .condition(PeerCondition::DisconnectedAndNotDialing)
            .addresses(vec![self.transport_address.clone()])
            .build()
    }
}

/// Account a peer's advertised capability and its compatibility with ours. Both
/// the inbound-request and inbound-response paths go through here so they
/// cannot disagree about the peer set.
///
/// A peer that is not in the table has already disconnected; its handshake
/// result is dropped rather than resurrecting an entry the connection events no
/// longer own.
fn record_compatibility(
    peer: PeerId,
    capability: ForkCapability,
    local_capability: ForkCapability,
    peers: &mut BTreeMap<PeerId, PeerState>,
) -> Result<(), ForkCompatibilityError> {
    let outcome = check_fork_compatibility(&local_capability, &capability);
    if let Some(state) = peers.get_mut(&peer) {
        state.capability = Some(capability);
        state.compatible = outcome.is_ok();
        state.incompatible_reason = outcome.as_ref().err().map(ToString::to_string);
    }
    outcome
}

pub(super) async fn handle_sync_event(
    event: request_response::Event<SyncRequest, SyncResponse>,
    swarm: &mut libp2p::Swarm<Behaviour>,
    context: SyncEventContext<'_>,
) {
    let SyncEventContext {
        inventory,
        heads,
        max_inventory,
        pending_sync,
        inbound_get_budget,
        peers,
        peer_ban_duration,
        next_sync_sequence,
        local_capability,
        events,
    } = context;
    let request_response::Event::Message { peer, message, .. } = event else {
        match event {
            request_response::Event::OutboundFailure {
                peer,
                request_id,
                error,
                ..
            } => {
                pending_sync.remove(&request_id);
                emit_warning(events, format!("sync request to {peer} failed: {error}"));
            }
            request_response::Event::InboundFailure { request_id, .. }
            | request_response::Event::ResponseSent { request_id, .. } => {
                inbound_get_budget.release(request_id);
            }
            _ => {}
        }
        return;
    };
    match message {
        request_response::Message::Request {
            request,
            channel,
            request_id,
        } => {
            if let Err(error) =
                record_compatibility(peer, request.capability, local_capability, peers)
            {
                let _ = swarm.behaviour_mut().sync.send_response(
                    channel,
                    SyncResponse {
                        capability: local_capability,
                        response: SyncResponseKind::Error(error.to_string()),
                    },
                );
                return;
            }
            let response = match request.request {
                SyncRequestKind::Capability => SyncResponseKind::Capability,
                SyncRequestKind::Inventory { after, limit } => {
                    let limit = usize::from(limit).min(max_inventory).max(1);
                    let start = after.map_or(Bound::Unbounded, Bound::Excluded);
                    let ids: Vec<B256> = inventory
                        .range((start, Bound::Unbounded))
                        .map(|(id, _)| *id)
                        .take(limit + 1)
                        .collect();
                    let has_more = ids.len() > limit;
                    let content_hashes = ids.into_iter().take(limit).collect::<Vec<_>>();
                    let next = has_more.then(|| content_hashes.last().copied()).flatten();
                    SyncResponseKind::Inventory {
                        content_hashes,
                        next,
                    }
                }
                SyncRequestKind::Get { content_hashes } if content_hashes.len() <= MAX_GET_IDS => {
                    let mut seen = HashSet::new();
                    let selected = content_hashes
                        .into_iter()
                        .filter(|id| seen.insert(*id))
                        .filter_map(|id| inventory.get(&id))
                        .collect::<Vec<_>>();
                    let response_bytes = get_response_work_bytes(selected.iter().copied());
                    if inbound_get_budget.reserve(request_id, peer, response_bytes) {
                        let payload = selected.iter().map(|bytes| bytes.len() as u64).sum();
                        record_payload_sent(peers, peer, payload);
                        SyncResponseKind::Transactions {
                            entries: selected.into_iter().cloned().collect(),
                        }
                    } else {
                        SyncResponseKind::Error("fetch response budget exhausted".into())
                    }
                }
                SyncRequestKind::Get { .. } => {
                    SyncResponseKind::Error("fetch request exceeds limit".into())
                }
                SyncRequestKind::Heads => SyncResponseKind::Heads {
                    heads: heads.to_vec(),
                },
            };
            let sent = swarm.behaviour_mut().sync.send_response(
                channel,
                SyncResponse {
                    capability: local_capability,
                    response,
                },
            );
            if sent.is_err() {
                inbound_get_budget.release(request_id);
                emit_warning(events, format!("failed to answer sync request from {peer}"));
            }
        }
        request_response::Message::Response {
            request_id,
            response,
        } => {
            let Some(expected) = pending_sync.remove(&request_id) else {
                emit_warning(
                    events,
                    format!("sync peer {peer} sent an unsolicited response"),
                );
                return;
            };
            if expected.peer() != peer {
                emit_warning(events, "sync response peer mismatch".into());
                return;
            }
            if record_compatibility(peer, response.capability, local_capability, peers).is_err() {
                return;
            }
            match (expected, response.response) {
                (PendingSyncRequest::Capability { .. }, SyncResponseKind::Capability) => {
                    // Schedule through the bounded, fair rotation instead of
                    // starting an immediate session per responder: every
                    // compatible peer answers this probe, so an ungated
                    // session here would let a Sybil set up to the connection
                    // cap all sync at once, far beyond
                    // MAX_CONCURRENT_SYNC_PEERS.
                    schedule_inventory_sync(
                        swarm,
                        pending_sync,
                        peers,
                        next_sync_sequence,
                        max_inventory,
                        local_capability,
                    );
                }
                (
                    PendingSyncRequest::Inventory {
                        after, remaining, ..
                    },
                    SyncResponseKind::Inventory {
                        content_hashes,
                        next,
                    },
                ) => {
                    let ordered = content_hashes.windows(2).all(|pair| pair[0] < pair[1]);
                    let after_cursor = content_hashes
                        .first()
                        .is_none_or(|first| after.is_none_or(|cursor| *first > cursor));
                    let cursor_matches =
                        next.is_none_or(|cursor| content_hashes.last() == Some(&cursor));
                    if content_hashes.len() > max_inventory
                        || content_hashes.len() > remaining
                        || !ordered
                        || !after_cursor
                        || !cursor_matches
                    {
                        emit_warning(
                            events,
                            format!("sync peer {peer} sent an invalid inventory page"),
                        );
                        return;
                    }

                    let missing = content_hashes
                        .iter()
                        .copied()
                        .filter(|id| !inventory.contains_key(id))
                        .collect::<Vec<_>>();
                    for chunk in missing.chunks(MAX_GET_IDS) {
                        request_transactions(
                            swarm,
                            pending_sync,
                            peer,
                            chunk.to_vec(),
                            local_capability,
                        );
                    }

                    let remaining = remaining - content_hashes.len();
                    if let Some(after) = next.filter(|_| remaining > 0) {
                        request_inventory(
                            swarm,
                            pending_sync,
                            peer,
                            Some(after),
                            remaining,
                            max_inventory,
                            local_capability,
                        );
                    }
                }
                (
                    PendingSyncRequest::Get {
                        mut content_hashes, ..
                    },
                    SyncResponseKind::Transactions { entries },
                ) => {
                    if entries.len() > MAX_GET_IDS || entries.len() > content_hashes.len() {
                        emit_warning(
                            events,
                            format!("sync peer {peer} sent too many transactions"),
                        );
                        // Anti-entropy returns to this peer every round, so an
                        // unpenalized over-delivery would repeat forever.
                        adjust_score(swarm, peer, PEER_SCORE_REJECTED, peer_ban_duration);
                        return;
                    }
                    for tx_bytes in entries {
                        if tx_bytes.len() <= MAX_RELAYED_TX_BYTES
                            && content_hashes.remove(&content_hash(&tx_bytes))
                        {
                            record_payload_received(peers, peer, tx_bytes.len() as u64);
                            if let Some(state) = peers.get_mut(&peer) {
                                state.tx_received = state.tx_received.saturating_add(1);
                            }
                            emit_candidate(events, tx_bytes, CandidateOrigin::Sync { peer });
                        }
                    }
                }
                (PendingSyncRequest::Heads { .. }, SyncResponseKind::Heads { heads: claimed }) => {
                    if claimed.len() > MAX_CANONICAL_HEADS {
                        emit_warning(
                            events,
                            format!("sync peer {peer} sent too many canonical heads"),
                        );
                        return;
                    }
                    let Some(state) = peers.get_mut(&peer) else {
                        return;
                    };
                    let reported = state.divergence.map(|known| known.l1_block_number);
                    let Some(divergence) = find_divergence(heads, &claimed, reported) else {
                        return;
                    };
                    state.divergence = Some(divergence);
                    let _ = events
                        .send(P2pEvent::BlockHashDivergence { peer, divergence })
                        .await;
                }
                (_, SyncResponseKind::Error(_)) => {
                    emit_warning(events, format!("sync peer {peer} rejected a request"));
                }
                _ => {
                    emit_warning(
                        events,
                        format!("sync peer {peer} sent the wrong response type"),
                    );
                }
            }
        }
    }
}

pub(super) fn request_inventory(
    swarm: &mut libp2p::Swarm<Behaviour>,
    pending_sync: &mut HashMap<request_response::OutboundRequestId, PendingSyncRequest>,
    peer: PeerId,
    after: Option<B256>,
    remaining: usize,
    max_inventory: usize,
    capability: ForkCapability,
) {
    let limit = remaining.min(max_inventory).min(MAX_INVENTORY_PAGE_IDS);
    let request_id = swarm.behaviour_mut().sync.send_request(
        &peer,
        SyncRequest {
            capability,
            request: SyncRequestKind::Inventory {
                after,
                limit: limit as u16,
            },
        },
    );
    pending_sync.insert(
        request_id,
        PendingSyncRequest::Inventory {
            peer,
            after,
            remaining,
        },
    );
}

/// Start bounded, fair inventory rounds for compatible peers that do not
/// already have one in flight. Peers with no prior round sort before previously
/// synced peers; thereafter the monotonically increasing sequence is
/// round-robin. Returns the peers a round started for.
pub(super) fn schedule_inventory_sync(
    swarm: &mut libp2p::Swarm<Behaviour>,
    pending_sync: &mut HashMap<request_response::OutboundRequestId, PendingSyncRequest>,
    peers: &mut BTreeMap<PeerId, PeerState>,
    next_sync_sequence: &mut u64,
    max_inventory: usize,
    capability: ForkCapability,
) -> Vec<PeerId> {
    let active = pending_sync
        .values()
        .map(PendingSyncRequest::peer)
        .collect::<HashSet<_>>();
    let available = MAX_CONCURRENT_SYNC_PEERS.saturating_sub(active.len());
    if available == 0 {
        return Vec::new();
    }

    let candidates = select_sync_candidates(peers, &active);

    let mut scheduled = Vec::with_capacity(available);
    for (peer, _) in candidates.into_iter().take(available) {
        request_inventory(
            swarm,
            pending_sync,
            peer,
            None,
            MAX_INVENTORY_ENTRIES,
            max_inventory,
            capability,
        );
        if let Some(state) = peers.get_mut(&peer) {
            state.sync_sequence = *next_sync_sequence;
        }
        *next_sync_sequence = next_sync_sequence.wrapping_add(1).max(1);
        scheduled.push(peer);
    }
    scheduled
}

/// Ordered compatible peers that are not currently mid-session: never-synced
/// peers first (sequence 0), then round-robin by last-served sequence with a
/// peer-id tiebreak. Extracted so the selection policy is unit-testable
/// without a live swarm.
pub(super) fn select_sync_candidates(
    peers: &BTreeMap<PeerId, PeerState>,
    active: &HashSet<PeerId>,
) -> Vec<(PeerId, u64)> {
    let mut candidates = peers
        .iter()
        .filter(|(peer, state)| state.compatible && !active.contains(peer))
        .map(|(peer, state)| (*peer, state.sync_sequence))
        .collect::<Vec<_>>();
    candidates.sort_by(|(left, left_seq), (right, right_seq)| {
        left_seq
            .cmp(right_seq)
            .then_with(|| left.to_bytes().cmp(&right.to_bytes()))
    });
    candidates
}

pub(super) fn request_transactions(
    swarm: &mut libp2p::Swarm<Behaviour>,
    pending_sync: &mut HashMap<request_response::OutboundRequestId, PendingSyncRequest>,
    peer: PeerId,
    content_hashes: Vec<B256>,
    capability: ForkCapability,
) {
    let requested = content_hashes.iter().copied().collect();
    let request_id = swarm.behaviour_mut().sync.send_request(
        &peer,
        SyncRequest {
            capability,
            request: SyncRequestKind::Get { content_hashes },
        },
    );
    pending_sync.insert(
        request_id,
        PendingSyncRequest::Get {
            peer,
            content_hashes: requested,
        },
    );
}

pub(super) fn request_heads(
    swarm: &mut libp2p::Swarm<Behaviour>,
    pending_sync: &mut HashMap<request_response::OutboundRequestId, PendingSyncRequest>,
    peer: PeerId,
    capability: ForkCapability,
) {
    let request_id = swarm.behaviour_mut().sync.send_request(
        &peer,
        SyncRequest {
            capability,
            request: SyncRequestKind::Heads,
        },
    );
    pending_sync.insert(request_id, PendingSyncRequest::Heads { peer });
}

pub(super) fn request_capability(
    swarm: &mut libp2p::Swarm<Behaviour>,
    pending_sync: &mut HashMap<request_response::OutboundRequestId, PendingSyncRequest>,
    peer: PeerId,
    capability: ForkCapability,
) {
    let request_id = swarm.behaviour_mut().sync.send_request(
        &peer,
        SyncRequest {
            capability,
            request: SyncRequestKind::Capability,
        },
    );
    pending_sync.insert(request_id, PendingSyncRequest::Capability { peer });
}

pub(super) fn refresh_endpoint(
    swarm: &libp2p::Swarm<Behaviour>,
    peers: &mut BTreeMap<PeerId, PeerState>,
    peer: PeerId,
) {
    if let Some(state) = peers.get_mut(&peer) {
        if let Some((endpoint, count)) = swarm.behaviour().policy.preferred_endpoint(peer) {
            state.connections = count as u32;
            let (direction, address) = match endpoint {
                ConnectedPoint::Dialer { address, .. } => (Direction::Outbound, address.clone()),
                ConnectedPoint::Listener { local_addr, .. } if endpoint.is_relayed() => {
                    // The relay transport's send-back address is only /p2p/id.
                    // Keep the circuit hop visible in the operator's peer view.
                    let mut address = crate::policy::transport_part(local_addr);
                    address.push(libp2p::multiaddr::Protocol::P2p(peer));
                    (Direction::Inbound, address)
                }
                ConnectedPoint::Listener { send_back_addr, .. } => {
                    (Direction::Inbound, send_back_addr.clone())
                }
            };
            state.direction = direction;
            state.remote_address = address;
        }
    }
}

fn close_redundant_connections(swarm: &mut libp2p::Swarm<Behaviour>, peer: PeerId) {
    let policy = &swarm.behaviour().policy;
    let mut redundant = policy.redundant_relays(peer);
    redundant.extend(policy.redundant_direct(peer));
    for connection in redundant {
        swarm.close_connection(connection);
    }
}

/// A connection refused by this node's own limits or policy displays only as
/// "Dial error"; the cause is in the error's source chain.
pub(super) fn dial_failure_warning(
    peer: Option<PeerId>,
    error: &libp2p::swarm::DialError,
) -> String {
    let peer = peer.map_or_else(|| "unknown peer".to_owned(), |peer| peer.to_string());
    let mut message = format!("failed to reach {peer}: {error}");
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    message
}
