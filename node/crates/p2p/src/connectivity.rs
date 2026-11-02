//! Discovery and reachability use the same transport identity and address set.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::autonat::BoundedAutonat;
use crate::policy::{endpoint_ip, is_public, transport_part};
use crate::swarm::{Behaviour, PeerState};
use crate::{
    DEFAULT_TARGET_PEERS, DIRECT_REACHABILITY_GRACE, DISCOVERY_LOOKUP_INTERVAL, INCOMPATIBLE_RETRY,
    KAD_MAX_PACKET_BYTES, KAD_PARALLELISM, KAD_QUERY_TIMEOUT, MAX_PENDING_OUTBOUND_CONNECTIONS,
    MAX_TARGET_PEERS, RELAY_MAX_CIRCUITS, RELAY_MAX_CIRCUITS_PER_PEER, RELAY_MAX_CIRCUIT_BYTES,
    RELAY_MAX_CIRCUIT_DURATION, RELAY_MAX_RESERVATIONS, RELAY_MAX_RESERVATIONS_PER_PEER,
    RELAY_RESERVATION_GRACE, RELAY_RETRY, RELAY_TARGET,
};
use libp2p::core::transport::ListenerId;
use libp2p::multiaddr::Protocol;
use libp2p::swarm::{
    behaviour::toggle::Toggle,
    dial_opts::{DialOpts, PeerCondition},
    NetworkBehaviour,
};
use libp2p::{
    autonat, dcutr, identify, kad, relay, upnp, Multiaddr, PeerId, StreamProtocol, Swarm,
};
use serde::{Deserialize, Serialize};

/// Discovery, advertised reachability, and optional relay serving for one swarm.
#[derive(Clone, Debug)]
pub struct ConnectivityConfig {
    /// Enable chain-specific Kademlia discovery and target-based peer replacement.
    pub discovery: bool,
    /// Desired compatible outbound peers, including operator-configured peers.
    pub target_peers: usize,
    /// Enable AutoNAT, UPnP, relay reservations, and DCUtR together.
    pub nat: bool,
    /// Operator-confirmed direct IP/TCP endpoint, without a peer-ID suffix.
    pub advertised_address: Option<Multiaddr>,
    /// Additional operator-configured peers to discover relay capability through Identify.
    pub relay_seeds: Vec<Multiaddr>,
    /// Serve bounded relay circuits; requires an advertised direct endpoint.
    pub relay_server: bool,
    /// Permit learned private endpoints for an isolated network.
    pub allow_private_addresses: bool,
}

impl Default for ConnectivityConfig {
    fn default() -> Self {
        Self {
            discovery: true,
            target_peers: DEFAULT_TARGET_PEERS,
            nat: true,
            advertised_address: None,
            relay_seeds: Vec::new(),
            relay_server: false,
            allow_private_addresses: false,
        }
    }
}

impl ConnectivityConfig {
    /// Disable discovery and automatic NAT connectivity.
    pub fn disabled() -> Self {
        Self {
            discovery: false,
            nat: false,
            ..Self::default()
        }
    }
}

/// Discovery participation follows externally confirmed reachability.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiscoveryMode {
    #[default]
    Off,
    Client,
    Server,
}

impl DiscoveryMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Client => "client",
            Self::Server => "server",
        }
    }
}

/// Current usable advertised connectivity.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Reachability {
    #[default]
    Unknown,
    Public,
    Private,
    Relayed,
}

impl Reachability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Public => "public",
            Self::Private => "private",
            Self::Relayed => "relayed",
        }
    }
}

/// Cumulative swarm event counts. `since` produces increments for metric samples.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCounters {
    /// Circuits closed by the local relay server, including quota exhaustion.
    pub relay_circuits_closed: u64,
    /// Completed successful Kademlia bootstrap and closest-peer queries.
    pub discovery_queries_succeeded: u64,
    /// Completed failed Kademlia bootstrap and closest-peer queries.
    pub discovery_queries_failed: u64,
    /// Failed outbound connection attempts reported by the swarm.
    pub dial_failures: u64,
    /// Successful DCUtR upgrades to direct connections.
    pub hole_punches_succeeded: u64,
    /// DCUtR attempts that did not establish a direct connection.
    pub hole_punches_failed: u64,
}

impl NetworkCounters {
    pub fn since(self, earlier: Self) -> Self {
        Self {
            relay_circuits_closed: self.relay_circuits_closed - earlier.relay_circuits_closed,
            discovery_queries_succeeded: self.discovery_queries_succeeded
                - earlier.discovery_queries_succeeded,
            discovery_queries_failed: self.discovery_queries_failed
                - earlier.discovery_queries_failed,
            dial_failures: self.dial_failures - earlier.dial_failures,
            hole_punches_succeeded: self.hole_punches_succeeded - earlier.hole_punches_succeeded,
            hole_punches_failed: self.hole_punches_failed - earlier.hole_punches_failed,
        }
    }
}

/// Published by the swarm; operator reads never issue networking commands.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    /// Current Kademlia participation: disabled, client, or reachable server.
    pub discovery_mode: DiscoveryMode,
    /// Number of peers admitted to the Kademlia routing table.
    pub routing_peers: usize,
    /// Pending outbound connections across every behaviour and application dial.
    pub pending_dials: usize,
    /// Desired compatible outbound peers, including operator-configured peers.
    pub target_peers: usize,
    /// Current advertised direct or relayed reachability.
    pub reachability: Reachability,
    /// Confirmed, ready-to-dial endpoints, including this node’s peer ID.
    pub external_addresses: Vec<Multiaddr>,
    /// Distinct relay peers with active, advertised reservations.
    pub relay_reservations: Vec<PeerId>,
    /// Currently active circuits served by this node.
    pub relay_circuits: usize,
    /// Cumulative outcomes since this swarm started.
    #[serde(flatten)]
    pub counters: NetworkCounters,
}

#[derive(NetworkBehaviour)]
pub(super) struct Connectivity {
    pub kad: Toggle<kad::Behaviour<kad::store::MemoryStore>>,
    pub autonat: Toggle<BoundedAutonat>,
    pub upnp: Toggle<upnp::tokio::Behaviour>,
    pub relay_client: Toggle<relay::client::Behaviour>,
    /// Serve bounded relay circuits; requires an advertised direct endpoint.
    pub relay_server: Toggle<relay::Behaviour>,
    pub dcutr: Toggle<dcutr::Behaviour>,
}

impl Connectivity {
    pub fn new(
        config: &ConnectivityConfig,
        peer: PeerId,
        name: StreamProtocol,
        client: relay::client::Behaviour,
    ) -> Self {
        let kad = config.discovery.then(|| {
            let mut cfg = kad::Config::new(name);
            cfg.set_parallelism(NonZeroUsize::new(KAD_PARALLELISM).unwrap_or(NonZeroUsize::MIN))
                .set_query_timeout(KAD_QUERY_TIMEOUT)
                .set_kbucket_inserts(kad::BucketInserts::Manual)
                .set_max_packet_size(KAD_MAX_PACKET_BYTES)
                .set_replication_interval(None)
                .set_publication_interval(None)
                .set_provider_publication_interval(None);
            let store = kad::store::MemoryStore::with_config(
                peer,
                kad::store::MemoryStoreConfig {
                    max_records: 0,
                    max_value_bytes: 0,
                    max_provided_keys: 0,
                    max_providers_per_key: 0,
                },
            );
            kad::Behaviour::with_config(peer, store, cfg)
        });
        Self {
            kad: kad.into(),
            autonat: config
                .nat
                .then(|| {
                    BoundedAutonat::new(
                        peer,
                        autonat::Config {
                            only_global_ips: !config.allow_private_addresses,
                            ..Default::default()
                        },
                    )
                })
                .into(),
            upnp: config.nat.then(upnp::tokio::Behaviour::default).into(),
            relay_client: config.nat.then_some(client).into(),
            relay_server: config
                .relay_server
                .then(|| {
                    relay::Behaviour::new(
                        peer,
                        relay::Config {
                            max_reservations: RELAY_MAX_RESERVATIONS,
                            max_reservations_per_peer: RELAY_MAX_RESERVATIONS_PER_PEER,
                            max_circuits: RELAY_MAX_CIRCUITS,
                            max_circuits_per_peer: RELAY_MAX_CIRCUITS_PER_PEER,
                            max_circuit_duration: RELAY_MAX_CIRCUIT_DURATION,
                            max_circuit_bytes: RELAY_MAX_CIRCUIT_BYTES,
                            ..Default::default()
                        },
                    )
                })
                .into(),
            dcutr: config.nat.then(|| dcutr::Behaviour::new(peer)).into(),
        }
    }
}

pub(super) struct ConnectivityManager {
    config: ConnectivityConfig,
    protocol: String,
    started: Instant,
    next_lookup: Instant,
    query: Option<kad::QueryId>,
    reservations: HashMap<PeerId, (ListenerId, Instant)>,
    relay_retry: HashMap<PeerId, Instant>,
    status: NetworkStatus,
    autonat_address: Option<Multiaddr>,
    upnp_addresses: HashSet<Multiaddr>,
    snapshot: Arc<Mutex<NetworkStatus>>,
}

impl ConnectivityManager {
    pub fn new(
        config: ConnectivityConfig,
        protocol: String,
        snapshot: Arc<Mutex<NetworkStatus>>,
    ) -> Self {
        Self {
            config,
            protocol,
            started: Instant::now(),
            next_lookup: Instant::now(),
            query: None,
            reservations: HashMap::new(),
            relay_retry: HashMap::new(),
            status: NetworkStatus::default(),
            autonat_address: None,
            upnp_addresses: HashSet::new(),
            snapshot,
        }
    }

    pub fn identify(&mut self, swarm: &mut Swarm<Behaviour>, peer: PeerId, info: &identify::Info) {
        let discovery = info
            .protocols
            .iter()
            .any(|protocol| protocol.as_ref() == self.protocol);
        let relay = info
            .protocols
            .iter()
            .any(|protocol| protocol == &relay::HOP_PROTOCOL_NAME);
        // Identify is also used by clients and unrelated networks. Only peers
        // serving our discovery namespace may contribute discovery endpoints.
        let addresses = if discovery || !self.config.discovery {
            info.listen_addrs.clone()
        } else {
            Vec::new()
        };
        let retained = swarm
            .behaviour_mut()
            .policy
            .observe_identify(peer, addresses, relay);
        if let Some(kad) = swarm.behaviour_mut().connectivity.kad.as_mut() {
            kad.remove_peer(&peer);
            if discovery {
                for address in retained {
                    kad.add_address(&peer, address);
                }
            }
        }
    }

    pub fn event(&mut self, swarm: &mut Swarm<Behaviour>, event: ConnectivityEvent) {
        match event {
            ConnectivityEvent::Kad(kad::Event::OutboundQueryProgressed {
                id,
                result,
                step,
                ..
            }) => {
                if let kad::QueryResult::GetClosestPeers(Ok(ref result)) = result {
                    for peer in &result.peers {
                        swarm
                            .behaviour_mut()
                            .policy
                            .learn(peer.peer_id, peer.addrs.clone(), false);
                    }
                }
                if step.last {
                    let ok = match &result {
                        kad::QueryResult::GetClosestPeers(result) => result.is_ok(),
                        kad::QueryResult::Bootstrap(result) => result.is_ok(),
                        _ => return,
                    };
                    if ok {
                        self.status.counters.discovery_queries_succeeded += 1;
                    } else {
                        self.status.counters.discovery_queries_failed += 1;
                    }
                    if self.query == Some(id) {
                        self.query = None;
                    }
                }
            }
            ConnectivityEvent::Kad(kad::Event::ModeChanged { .. }) => {
                let peers: Vec<_> = swarm.connected_peers().copied().collect();
                swarm.behaviour_mut().identify.push(peers);
            }
            ConnectivityEvent::Dcutr(event) => {
                if event.result.is_ok() {
                    self.status.counters.hole_punches_succeeded += 1;
                } else {
                    self.status.counters.hole_punches_failed += 1;
                }
            }
            ConnectivityEvent::RelayServer(relay::Event::CircuitReqAccepted {
                src_peer_id,
                dst_peer_id,
            }) => {
                tracing::info!(%src_peer_id, %dst_peer_id, "relay circuit accepted");
                self.status.relay_circuits += 1;
            }
            ConnectivityEvent::RelayServer(relay::Event::CircuitClosed {
                src_peer_id,
                dst_peer_id,
                error,
            }) => {
                tracing::info!(%src_peer_id, %dst_peer_id, ?error, "relay circuit closed");
                self.status.counters.relay_circuits_closed += 1;
                self.status.relay_circuits = self.status.relay_circuits.saturating_sub(1);
            }
            ConnectivityEvent::Autonat(autonat::Event::OutboundProbe(
                autonat::OutboundProbeEvent::Response { address, .. },
            )) => {
                self.replace_autonat_address(swarm, Some(transport_part(&address)));
            }
            ConnectivityEvent::Autonat(autonat::Event::StatusChanged {
                new: autonat::NatStatus::Private | autonat::NatStatus::Unknown,
                ..
            }) => {
                self.replace_autonat_address(swarm, None);
            }
            ConnectivityEvent::Upnp(upnp::Event::NewExternalAddr(address)) => {
                self.upnp_addresses.insert(transport_part(&address));
            }
            ConnectivityEvent::Upnp(upnp::Event::ExpiredExternalAddr(address)) => {
                self.upnp_addresses.remove(&transport_part(&address));
            }
            ConnectivityEvent::RelayClient(event) => tracing::debug!(?event, "relay client"),
            ConnectivityEvent::Upnp(event) => tracing::debug!(?event, "UPnP"),
            _ => {}
        }
    }

    pub(super) fn replace_autonat_address(
        &mut self,
        swarm: &mut Swarm<Behaviour>,
        address: Option<Multiaddr>,
    ) {
        let previous = std::mem::replace(&mut self.autonat_address, address);
        if let Some(previous) = previous {
            if self.autonat_address.as_ref() != Some(&previous)
                && self.config.advertised_address.as_ref() != Some(&previous)
                && !self.upnp_addresses.contains(&previous)
            {
                let expired: Vec<_> = swarm
                    .external_addresses()
                    .filter(|address| transport_part(address) == previous)
                    .cloned()
                    .collect();
                for address in expired {
                    swarm.remove_external_address(&address);
                }
            }
        }
    }

    fn retain_owned_addresses(&self, swarm: &mut Swarm<Behaviour>) {
        for address in self
            .config
            .advertised_address
            .iter()
            .chain(&self.autonat_address)
            .chain(&self.upnp_addresses)
        {
            if !swarm
                .external_addresses()
                .any(|external| transport_part(external) == *address)
            {
                swarm.add_external_address(address.clone());
            }
        }
    }

    pub fn tick(&mut self, swarm: &mut Swarm<Behaviour>, peers: &BTreeMap<PeerId, PeerState>) {
        let now = Instant::now();
        self.retain_owned_addresses(swarm);
        self.evict_incompatible(swarm, peers, now);
        self.fill_outbound(swarm, peers, now);
        if self.config.nat {
            self.maintain_relays(swarm, peers, now);
        }
        self.publish_status(swarm);
    }

    fn evict_incompatible(
        &self,
        swarm: &mut Swarm<Behaviour>,
        peers: &BTreeMap<PeerId, PeerState>,
        now: Instant,
    ) {
        if !self.config.discovery {
            return;
        }
        for (peer, state) in peers {
            if state.incompatible_reason.is_none() {
                continue;
            }
            swarm
                .behaviour_mut()
                .policy
                .defer(*peer, now + INCOMPATIBLE_RETRY);
            if !swarm.behaviour().policy.is_configured(*peer) {
                let _ = swarm.disconnect_peer_id(*peer);
            }
        }
    }

    fn fill_outbound(
        &mut self,
        swarm: &mut Swarm<Behaviour>,
        peers: &BTreeMap<PeerId, PeerState>,
        now: Instant,
    ) {
        let outbound = peers
            .iter()
            .filter(|(peer, state)| state.compatible && swarm.behaviour().policy.outbound(**peer))
            .count();
        let discover = self.config.discovery && outbound < self.config.target_peers;
        if discover && now >= self.next_lookup && self.query.is_none() {
            if let Some(kad) = swarm.behaviour_mut().connectivity.kad.as_mut() {
                self.query = Some(kad.get_closest_peers(PeerId::random()));
            }
            self.next_lookup = now + DISCOVERY_LOOKUP_INTERVAL;
        }
        let mut pending_slots = (MAX_PENDING_OUTBOUND_CONNECTIONS as usize)
            .saturating_sub(swarm.behaviour().policy.pending_count());
        let mut discovered_slots = self.config.target_peers.saturating_sub(outbound);
        for (peer, addresses) in swarm.behaviour_mut().policy.ready(discover) {
            if pending_slots == 0 {
                break;
            }
            if !swarm.behaviour().policy.is_configured(peer) {
                if discovered_slots == 0 {
                    continue;
                }
                discovered_slots -= 1;
            }
            if swarm
                .dial(
                    DialOpts::peer_id(peer)
                        .addresses(addresses)
                        .condition(PeerCondition::DisconnectedAndNotDialing)
                        .build(),
                )
                .is_ok()
            {
                pending_slots -= 1;
            }
        }
    }

    fn autonat_private(swarm: &Swarm<Behaviour>) -> bool {
        swarm
            .behaviour()
            .connectivity
            .autonat
            .as_ref()
            .is_some_and(|autonat| matches!(autonat.nat_status(), autonat::NatStatus::Private))
    }

    fn publish_status(&mut self, swarm: &mut Swarm<Behaviour>) {
        let local = *swarm.local_peer_id();
        self.status.external_addresses = swarm
            .external_addresses()
            .map(|address| {
                let mut address = transport_part(address);
                address.push(Protocol::P2p(local));
                address
            })
            .collect();
        self.status.external_addresses.sort();
        self.status.external_addresses.dedup();
        self.status.relay_reservations = self
            .reservations
            .keys()
            .filter(|peer| {
                self.status
                    .external_addresses
                    .iter()
                    .any(|address| relay_of(address) == Some(**peer))
            })
            .copied()
            .collect();
        self.status.relay_reservations.sort();
        self.status.reachability = if self
            .status
            .external_addresses
            .iter()
            .any(|address| relay_of(address).is_none())
        {
            Reachability::Public
        } else if !self.status.relay_reservations.is_empty() {
            Reachability::Relayed
        } else if Self::autonat_private(swarm) {
            Reachability::Private
        } else {
            Reachability::Unknown
        };
        self.status.discovery_mode =
            swarm
                .behaviour()
                .connectivity
                .kad
                .as_ref()
                .map_or(DiscoveryMode::Off, |kad| match kad.mode() {
                    kad::Mode::Server => DiscoveryMode::Server,
                    kad::Mode::Client => DiscoveryMode::Client,
                });
        self.status.routing_peers = swarm
            .behaviour_mut()
            .connectivity
            .kad
            .as_mut()
            .map_or(0, |kad| {
                kad.kbuckets().map(|bucket| bucket.num_entries()).sum()
            });
        self.status.pending_dials = swarm.behaviour().policy.pending_count();
        self.status.counters.dial_failures = swarm.behaviour().policy.dial_failures();
        self.status.target_peers = self.config.target_peers;
        *self
            .snapshot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = self.status.clone();
    }

    pub fn listener_closed(&mut self, swarm: &mut Swarm<Behaviour>, listener: ListenerId) {
        let peer = self
            .reservations
            .iter()
            .find_map(|(peer, (reserved, _))| (*reserved == listener).then_some(*peer));
        if let Some(peer) = peer {
            self.withdraw_reservation(swarm, peer, Instant::now());
            self.publish_status(swarm);
        }
    }

    fn withdraw_reservation(&mut self, swarm: &mut Swarm<Behaviour>, peer: PeerId, now: Instant) {
        if let Some((listener, _)) = self.reservations.remove(&peer) {
            swarm.remove_listener(listener);
        }
        // The relay client expires confirmations on connection closure, but a
        // failed renewal or listener removal can leave that connection alive.
        let expired: Vec<_> = swarm
            .external_addresses()
            .filter(|address| relay_of(address) == Some(peer))
            .cloned()
            .collect();
        for address in expired {
            swarm.remove_external_address(&address);
        }
        // Explicit address removal updates Identify's address set but does not
        // emit a SwarmEvent to trigger the event loop's usual Identify push.
        let connected: Vec<_> = swarm.connected_peers().copied().collect();
        swarm.behaviour_mut().identify.push(connected);
        self.relay_retry.insert(peer, now + RELAY_RETRY);
    }

    fn maintain_relays(
        &mut self,
        swarm: &mut Swarm<Behaviour>,
        peers: &BTreeMap<PeerId, PeerState>,
        now: Instant,
    ) {
        let direct = swarm
            .external_addresses()
            .any(|address| relay_of(address).is_none());
        self.relay_retry.retain(|_, until| *until > now);
        let expired: Vec<_> = self
            .reservations
            .iter()
            .filter(|(peer, (_, started))| {
                direct
                    || (!swarm
                        .external_addresses()
                        .any(|address| relay_of(address) == Some(**peer))
                        && now.duration_since(*started) > RELAY_RESERVATION_GRACE)
            })
            .map(|(peer, _)| *peer)
            .collect();
        for peer in expired {
            self.withdraw_reservation(swarm, peer, now);
        }
        let private = Self::autonat_private(swarm);
        if direct || (!private && now.duration_since(self.started) < DIRECT_REACHABILITY_GRACE) {
            return;
        }
        let relays: Vec<_> = swarm
            .behaviour()
            .policy
            .relay_candidates()
            .into_iter()
            .filter(|(peer, _)| {
                peers.get(peer).is_some_and(|state| state.compatible)
                    && !self.reservations.contains_key(peer)
                    && !self.relay_retry.contains_key(peer)
            })
            .take(RELAY_TARGET.saturating_sub(self.reservations.len()))
            .collect();
        for (peer, mut address) in relays {
            address.push(Protocol::P2p(peer));
            address.push(Protocol::P2pCircuit);
            match swarm.listen_on(address) {
                Ok(listener) => {
                    self.reservations.insert(peer, (listener, now));
                }
                Err(_) => {
                    self.relay_retry.insert(peer, now + RELAY_RETRY);
                }
            }
        }
    }
}

pub(crate) fn relay_of(address: &Multiaddr) -> Option<PeerId> {
    let parts: Vec<_> = address.iter().collect();
    parts
        .windows(2)
        .find_map(|pair| match (&pair[0], &pair[1]) {
            (Protocol::P2p(peer), Protocol::P2pCircuit) => Some(*peer),
            _ => None,
        })
}

pub(crate) fn validate(config: &ConnectivityConfig, peer: PeerId) -> Result<(), crate::Error> {
    if config.target_peers == 0 || config.target_peers > MAX_TARGET_PEERS {
        return Err(crate::Error::Transport(
            "P2P target peers must be between 1 and 128".into(),
        ));
    }
    if let Some(address) = &config.advertised_address {
        if !endpoint_ip(address, peer)
            .is_some_and(|ip| config.allow_private_addresses || is_public(ip))
            || relay_of(address).is_some()
            || address
                .iter()
                .any(|protocol| matches!(protocol, Protocol::P2p(_)))
        {
            return Err(crate::Error::Transport(
                "advertised address must be a reachable IP/TCP transport address".into(),
            ));
        }
    }
    if config.relay_server && config.advertised_address.is_none() {
        return Err(crate::Error::Transport(
            "relay serving requires an advertised direct address".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "network test fixtures"
)]
mod tests {
    use super::*;
    use crate::swarm::{BehaviourEvent, DialTarget};
    use crate::tests::test_swarm_with_connectivity;
    use crate::Direction;
    use futures::StreamExt;
    use libp2p::swarm::SwarmEvent;
    use std::time::Duration;

    struct Relays {
        client: Swarm<Behaviour>,
        primary: Swarm<Behaviour>,
        replacement: Swarm<Behaviour>,
        replacement_address: Multiaddr,
        primary_observed_addresses: Option<Vec<Multiaddr>>,
        pushed_addresses: Option<Vec<Multiaddr>>,
        manager: ConnectivityManager,
        peers: BTreeMap<PeerId, PeerState>,
    }

    impl Relays {
        async fn new() -> Self {
            let server_config = ConnectivityConfig {
                relay_server: true,
                ..ConnectivityConfig::disabled()
            };
            let mut primary = test_swarm_with_connectivity(server_config.clone());
            // At capacity libp2p refuses the renewal, while ping/Identify keep
            // its authenticated TCP connection alive. No NAT events are mocked.
            let primary_id = *primary.local_peer_id();
            primary.behaviour_mut().connectivity.relay_server = Some(relay::Behaviour::new(
                primary_id,
                relay::Config {
                    max_reservations: 1,
                    reservation_duration: Duration::from_secs(4),
                    ..Default::default()
                },
            ))
            .into();
            let primary_address = listen(&mut primary).await;
            let mut replacement = test_swarm_with_connectivity(server_config);
            let replacement_address = listen(&mut replacement).await;
            let config = ConnectivityConfig {
                allow_private_addresses: true,
                relay_seeds: vec![primary_address.clone()],
                ..Default::default()
            };
            let mut client = test_swarm_with_connectivity(config.clone());
            let mut manager = ConnectivityManager::new(
                config,
                "/test/kad".into(),
                Arc::new(Mutex::new(NetworkStatus::default())),
            );
            manager.started = Instant::now()
                .checked_sub(DIRECT_REACHABILITY_GRACE)
                .unwrap();
            client
                .behaviour_mut()
                .policy
                .configure(&DialTarget::parse(primary_address.clone()).unwrap());
            // These fixtures isolate reservation lifecycle after compatibility
            // admission; the protocol compatibility handshake is tested separately.
            let mut state = PeerState::new(Direction::Outbound, primary_address);
            state.compatible = true;
            Self {
                client,
                primary,
                replacement,
                replacement_address,
                primary_observed_addresses: None,
                pushed_addresses: None,
                manager,
                peers: BTreeMap::from([(primary_id, state)]),
            }
        }

        async fn until(&mut self, condition: impl Fn(&Self) -> bool) {
            tokio::time::timeout(Duration::from_secs(10), async {
                let mut tick = tokio::time::interval(Duration::from_millis(20));
                loop {
                    if condition(self) {
                        return;
                    }
                    tokio::select! {
                        event = self.primary.select_next_some() => {
                            if let SwarmEvent::Behaviour(BehaviourEvent::Identify(event)) = event {
                                if let identify::Event::Received { info, .. } = *event {
                                    self.primary_observed_addresses = Some(info.listen_addrs);
                                }
                            }
                        },
                        _ = self.replacement.select_next_some() => {},
                        _ = tick.tick() => self.manager.tick(&mut self.client, &self.peers),
                        event = self.client.select_next_some() => self.client_event(event),
                    }
                }
            })
            .await
            .expect("relay lifecycle did not reach the expected state");
        }

        fn client_event(&mut self, event: SwarmEvent<BehaviourEvent>) {
            match event {
                SwarmEvent::Behaviour(BehaviourEvent::Identify(event)) => match *event {
                    identify::Event::Received { peer_id, info, .. } => {
                        assert!(!info
                            .protocols
                            .iter()
                            .any(|protocol| protocol.as_ref() == "/test/kad"));
                        self.manager.identify(&mut self.client, peer_id, &info);
                    }
                    identify::Event::Pushed { info, .. } => {
                        self.pushed_addresses = Some(info.listen_addrs);
                    }
                    _ => {}
                },
                SwarmEvent::Behaviour(BehaviourEvent::Connectivity(event)) => {
                    self.manager.event(&mut self.client, event);
                }
                SwarmEvent::ListenerClosed { listener_id, .. } => {
                    self.manager.listener_closed(&mut self.client, listener_id);
                }
                _ => {}
            }
        }

        fn snapshot(&self) -> NetworkStatus {
            self.manager.snapshot.lock().unwrap().clone()
        }
    }

    async fn listen(swarm: &mut Swarm<Behaviour>) -> Multiaddr {
        swarm
            .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
            .unwrap();
        loop {
            if let SwarmEvent::NewListenAddr { address, .. } = swarm.select_next_some().await {
                swarm.add_external_address(address.clone());
                return crate::bootstrap_address(&address, *swarm.local_peer_id());
            }
        }
    }

    #[tokio::test]
    async fn failed_renewal_with_live_connection_withdraws_and_replaces_discovery_off_relay() {
        let mut relays = Box::pin(Relays::new()).await;
        let primary = *relays.primary.local_peer_id();
        relays
            .until(|fixture| fixture.snapshot().relay_reservations == [primary])
            .await;
        assert_eq!(relays.snapshot().discovery_mode, DiscoveryMode::Server);
        assert_eq!(relays.snapshot().routing_peers, 0);
        assert!(relays
            .client
            .behaviour()
            .policy
            .addresses(primary)
            .is_empty());
        let old_listener = relays.manager.reservations[&primary].0;
        relays
            .until(|fixture| {
                fixture
                    .primary_observed_addresses
                    .as_ref()
                    .is_some_and(|addresses| {
                        addresses
                            .iter()
                            .any(|address| relay_of(address) == Some(primary))
                    })
            })
            .await;

        relays
            .until(|fixture| fixture.manager.relay_retry.contains_key(&primary))
            .await;
        assert!(relays.client.is_connected(&primary));
        assert!(!relays.manager.reservations.contains_key(&primary));
        assert!(relays.client.external_addresses().next().is_none());
        assert!(relays.snapshot().external_addresses.is_empty());
        assert!(relays.snapshot().relay_reservations.is_empty());
        assert_eq!(relays.snapshot().discovery_mode, DiscoveryMode::Client);
        assert!(relays.manager.relay_retry[&primary] > Instant::now());
        relays
            .until(|fixture| fixture.pushed_addresses.as_ref().is_some_and(Vec::is_empty))
            .await;

        let replacement = *relays.replacement.local_peer_id();
        relays
            .client
            .behaviour_mut()
            .policy
            .configure(&DialTarget::parse(relays.replacement_address.clone()).unwrap());
        let mut state = PeerState::new(Direction::Outbound, relays.replacement_address.clone());
        state.compatible = true;
        relays.peers.insert(replacement, state);
        relays
            .until(|fixture| fixture.snapshot().relay_reservations == [replacement])
            .await;
        assert!(relays.client.is_connected(&primary));
        assert_eq!(relays.snapshot().discovery_mode, DiscoveryMode::Server);
        assert!(relays
            .snapshot()
            .external_addresses
            .iter()
            .all(|address| relay_of(address) == Some(replacement)));
        assert_eq!(relays.snapshot().routing_peers, 0);
        relays
            .until(|fixture| {
                fixture
                    .primary_observed_addresses
                    .as_ref()
                    .is_some_and(|addresses| {
                        !addresses.is_empty()
                            && addresses
                                .iter()
                                .all(|address| relay_of(address) == Some(replacement))
                    })
            })
            .await;
        // A delayed/duplicate notification cannot erase a different reservation.
        relays
            .manager
            .listener_closed(&mut relays.client, old_listener);
        assert_eq!(relays.snapshot().relay_reservations, vec![replacement]);
    }

    #[tokio::test]
    async fn direct_reachability_releases_reservation_and_its_advertised_address() {
        let mut relays = Box::pin(Relays::new()).await;
        let primary = *relays.primary.local_peer_id();
        relays
            .until(|fixture| fixture.snapshot().relay_reservations == [primary])
            .await;
        relays
            .until(|fixture| {
                fixture
                    .primary_observed_addresses
                    .as_ref()
                    .is_some_and(|addresses| {
                        addresses
                            .iter()
                            .any(|address| relay_of(address) == Some(primary))
                    })
            })
            .await;
        let direct: Multiaddr = "/ip4/8.8.8.8/tcp/8646".parse().unwrap();
        relays.client.add_external_address(direct.clone());
        relays.manager.tick(&mut relays.client, &relays.peers);
        assert!(relays.client.is_connected(&primary));
        assert!(relays.manager.reservations.is_empty());
        assert!(relays.snapshot().relay_reservations.is_empty());
        assert_eq!(relays.snapshot().reachability, Reachability::Public);
        assert_eq!(
            relays.snapshot().external_addresses,
            vec![crate::bootstrap_address(
                &direct,
                *relays.client.local_peer_id()
            )]
        );
        relays
            .until(|fixture| {
                fixture
                    .primary_observed_addresses
                    .as_ref()
                    .is_some_and(|addresses| {
                        addresses.contains(&direct)
                            && addresses.iter().all(|address| relay_of(address).is_none())
                    })
            })
            .await;
    }
}
