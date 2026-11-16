//! One dial boundary for application, discovery, reachability and relay traffic.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::ops::{Deref, DerefMut};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use crate::swarm::Reputation;
use libp2p::core::{transport::PortUse, ConnectedPoint, Endpoint};
use libp2p::multiaddr::Protocol;
use libp2p::swarm::{
    ConnectionDenied, ConnectionId, FromSwarm, NetworkBehaviour, THandler, THandlerInEvent,
    THandlerOutEvent, ToSwarm,
};
use libp2p::{Multiaddr, PeerId};
use rand::seq::SliceRandom;

use crate::{CANDIDATE_TTL, MAX_ADDRESSES, MAX_CANDIDATES, MAX_DIAL_ADDRESSES};

#[derive(Clone)]
struct Candidate {
    addresses: Vec<Multiaddr>,
    relay: bool,
    retry_at: Instant,
    failures: u32,
    seen: Instant,
}

pub(crate) struct Policy {
    local: PeerId,
    allow_private: bool,
    configured: HashMap<PeerId, Vec<Multiaddr>>,
    reputation: HashMap<PeerId, Reputation>,
    // Operator removal prevents our outbound reconnects, including in-flight dials.
    removed: HashSet<PeerId>,
    candidates: HashMap<PeerId, Candidate>,
    pending: HashMap<ConnectionId, Option<PeerId>>,
    connections: HashMap<PeerId, HashMap<ConnectionId, ConnectedPoint>>,
    dial_failures: u64,
}

impl Policy {
    pub fn new(local: PeerId, allow_private: bool) -> Self {
        Self {
            local,
            allow_private,
            configured: HashMap::new(),
            reputation: HashMap::new(),
            removed: HashSet::new(),
            candidates: HashMap::new(),
            pending: HashMap::new(),
            connections: HashMap::new(),
            dial_failures: 0,
        }
    }

    pub fn banned(&self, peer: PeerId) -> bool {
        self.reputation
            .get(&peer)
            .is_some_and(|entry| entry.is_banned(Instant::now()))
    }

    pub fn connected(&self, peer: PeerId) -> bool {
        self.connections.contains_key(&peer)
    }

    pub fn permitted(&self, peer: PeerId, address: &Multiaddr) -> bool {
        endpoint_ip(address, peer).is_some_and(|ip| {
            self.allow_private
                || is_public(ip)
                || self.configured.get(&peer).is_some_and(|addresses| {
                    addresses
                        .iter()
                        .any(|configured| transport_part(configured) == transport_part(address))
                })
        })
    }

    pub fn learn(&mut self, peer: PeerId, addresses: Vec<Multiaddr>, replace: bool) {
        if peer == self.local || self.removed.contains(&peer) || self.banned(peer) {
            return;
        }
        let addresses: Vec<_> = addresses
            .into_iter()
            .filter(|address| self.permitted(peer, address))
            .take(MAX_ADDRESSES)
            .collect();
        if addresses.is_empty() && !replace {
            return;
        }
        if !self.candidates.contains_key(&peer) && self.candidates.len() >= MAX_CANDIDATES {
            if let Some(oldest) = self
                .candidates
                .iter()
                .min_by_key(|(_, candidate)| candidate.seen)
                .map(|(peer, _)| *peer)
            {
                self.candidates.remove(&oldest);
            }
        }
        let now = Instant::now();
        let candidate = self.candidates.entry(peer).or_insert_with(|| Candidate {
            addresses: Vec::new(),
            relay: false,
            retry_at: now,
            failures: 0,
            seen: now,
        });
        candidate.seen = now;
        if replace {
            candidate.addresses.clear();
        }
        for address in addresses {
            if candidate.addresses.len() < MAX_ADDRESSES && !candidate.addresses.contains(&address)
            {
                candidate.addresses.push(address);
            }
        }
        candidate
            .addresses
            .sort_by_key(|address| crate::connectivity::relay_of(address).is_some());
    }

    pub fn failed(&mut self, peer: PeerId) {
        if self.connected(peer) {
            return;
        }
        if let Some(candidate) = self.candidates.get_mut(&peer) {
            candidate.failures = candidate.failures.saturating_add(1);
            let seconds = (crate::DIAL_RETRY_INITIAL
                .as_secs()
                .saturating_mul(1u64 << candidate.failures.saturating_sub(1).min(31)))
            .min(crate::DIAL_RETRY_MAX.as_secs());
            candidate.retry_at = Instant::now() + Duration::from_secs(seconds);
        }
    }

    pub fn ready(&mut self, discovery: bool) -> Vec<(PeerId, Vec<Multiaddr>)> {
        let now = Instant::now();
        self.candidates.retain(|peer, candidate| {
            self.configured.contains_key(peer) || now.duration_since(candidate.seen) < CANDIDATE_TTL
        });
        let mut peers: Vec<_> = self
            .configured
            .keys()
            .chain(self.candidates.keys())
            .copied()
            .collect();
        peers.sort_unstable();
        peers.dedup();
        peers.retain(|peer| {
            (discovery || self.is_configured(*peer))
                && !self.connected(*peer)
                && !self.pending.values().any(|pending| *pending == Some(*peer))
                && !self.banned(*peer)
                && !self.removed.contains(peer)
                && self
                    .candidates
                    .get(peer)
                    .is_none_or(|candidate| candidate.retry_at <= now)
        });
        peers.shuffle(&mut rand::thread_rng());
        peers.sort_by_key(|peer| !self.is_configured(*peer));
        peers
            .into_iter()
            .filter_map(|peer| {
                let mut addresses = self.addresses(peer).to_vec();
                if let Some(configured) = self.configured.get(&peer) {
                    for address in configured {
                        if !addresses
                            .iter()
                            .any(|known| transport_part(known) == transport_part(address))
                        {
                            addresses.push(address.clone());
                        }
                    }
                }
                addresses.sort_by_key(|address| crate::connectivity::relay_of(address).is_some());
                // Leave room for Kademlia's additional endpoints in the guard.
                addresses.truncate(MAX_DIAL_ADDRESSES - MAX_ADDRESSES);
                (!addresses.is_empty()).then_some((peer, addresses))
            })
            .collect()
    }

    pub fn configure(&mut self, target: &crate::swarm::DialTarget) {
        // Adding a peer back withdraws the operator's earlier removal.
        self.removed.remove(&target.peer);
        let addresses = self.configured.entry(target.peer).or_default();
        if !addresses.contains(&target.address) {
            addresses.push(target.address.clone());
        }
    }

    #[cfg(test)]
    pub fn configured_addresses(&self, peer: PeerId) -> &[Multiaddr] {
        self.configured
            .get(&peer)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    pub fn is_configured(&self, peer: PeerId) -> bool {
        self.configured.contains_key(&peer)
    }

    pub fn known(&self, peer: PeerId) -> bool {
        self.connected(peer) || self.is_configured(peer) || self.candidates.contains_key(&peer)
    }

    pub fn remove(&mut self, peer: PeerId) {
        self.removed.insert(peer);
        self.configured.remove(&peer);
        self.candidates.remove(&peer);
    }

    pub fn defer(&mut self, peer: PeerId, until: Instant) {
        if let Some(candidate) = self.candidates.get_mut(&peer) {
            candidate.retry_at = until;
        }
    }

    pub fn observe_identify(
        &mut self,
        peer: PeerId,
        addresses: Vec<Multiaddr>,
        relay: bool,
    ) -> Vec<Multiaddr> {
        self.learn(peer, addresses, true);
        if let Some(candidate) = self.candidates.get_mut(&peer) {
            candidate.relay = relay;
            return candidate.addresses.clone();
        }
        Vec::new()
    }

    pub fn addresses(&self, peer: PeerId) -> &[Multiaddr] {
        self.candidates
            .get(&peer)
            .map_or(&[], |candidate| candidate.addresses.as_slice())
    }

    pub fn relay_candidates(&self) -> Vec<(PeerId, Multiaddr)> {
        self.candidates
            .iter()
            .filter(|(peer, candidate)| {
                candidate.relay && !self.banned(**peer) && !self.removed.contains(peer)
            })
            .filter_map(|(peer, candidate)| {
                // Operator endpoints remain usable when the relay does not
                // advertise our discovery protocol. Identify still supplies
                // relay capability, and the manager requires fork compatibility.
                self.configured
                    .get(peer)
                    .into_iter()
                    .flatten()
                    .chain(&candidate.addresses)
                    .find(|address| crate::connectivity::relay_of(address).is_none())
                    .map(|address| (*peer, transport_part(address)))
            })
            .collect()
    }

    pub fn connections_of(
        &self,
        peer: PeerId,
    ) -> impl Iterator<Item = (&ConnectionId, &ConnectedPoint)> {
        self.connections
            .get(&peer)
            .into_iter()
            .flat_map(|connections| connections.iter())
    }

    pub fn outbound(&self, peer: PeerId) -> bool {
        self.is_configured(peer)
            || self
                .connections_of(peer)
                .any(|(_, endpoint)| endpoint.is_dialer())
    }

    pub fn preferred_endpoint(&self, peer: PeerId) -> Option<(&ConnectedPoint, usize)> {
        let connections = self.connections.get(&peer)?;
        let endpoint = connections
            .values()
            .min_by_key(|endpoint| endpoint.is_relayed())?;
        Some((endpoint, connections.len()))
    }

    pub fn redundant_relays(&self, peer: PeerId) -> Vec<ConnectionId> {
        let direct = self
            .connections_of(peer)
            .any(|(_, endpoint)| !endpoint.is_relayed());
        let mut relayed: Vec<_> = self
            .connections_of(peer)
            .filter(|(_, endpoint)| endpoint.is_relayed())
            .collect();
        // Both ends prefer the circuit initiated by the smaller peer ID, then
        // the same relay. Keep one slot free for a direct upgrade even when
        // discovery initiated circuits concurrently in both directions.
        relayed.sort_by_key(|(_, endpoint)| {
            let address = match endpoint {
                ConnectedPoint::Dialer { address, .. } => address,
                ConnectedPoint::Listener { local_addr, .. } => local_addr,
            };
            (
                endpoint.is_dialer() != (self.local < peer),
                crate::connectivity::relay_of(address),
            )
        });
        relayed
            .into_iter()
            .skip(usize::from(!direct))
            .map(|(id, _)| *id)
            .collect()
    }

    /// An AutoNAT dial-back reaches a peer that is already connected. Left
    /// open, it holds the second per-peer slot and every later dial-back is
    /// refused, which the prober counts as evidence that it is private. Each
    /// end closes only direct connections it dialed, so the ends cannot keep
    /// different ones: dials by the smaller peer ID win, then the oldest dial.
    pub fn redundant_direct(&self, peer: PeerId) -> Vec<ConnectionId> {
        let direct = || {
            self.connections_of(peer)
                .filter(|(_, endpoint)| !endpoint.is_relayed())
        };
        let mut dialed: Vec<_> = direct()
            .filter(|(_, endpoint)| dialed_by_us(endpoint))
            .map(|(id, _)| *id)
            .collect();
        dialed.sort_unstable();
        let remote_wins =
            peer < self.local && direct().any(|(_, endpoint)| !dialed_by_us(endpoint));
        dialed.into_iter().skip(usize::from(!remote_wins)).collect()
    }

    pub fn established(&mut self, peer: PeerId, id: ConnectionId, endpoint: ConnectedPoint) {
        self.pending.remove(&id);
        self.connections
            .entry(peer)
            .or_default()
            .insert(id, endpoint.clone());
        if let Some(candidate) = self.candidates.get_mut(&peer) {
            candidate.failures = 0;
            candidate.retry_at = Instant::now();
            candidate.seen = Instant::now();
            if let ConnectedPoint::Dialer { address, .. } = endpoint {
                if crate::connectivity::relay_of(&address).is_none() {
                    candidate
                        .addresses
                        .sort_by_key(|other| transport_part(other) != transport_part(&address));
                }
            }
        }
    }

    pub fn closed(&mut self, peer: PeerId, id: ConnectionId) {
        if let Some(connections) = self.connections.get_mut(&peer) {
            connections.remove(&id);
            if connections.is_empty() {
                self.connections.remove(&peer);
            }
        }
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn dial_failures(&self) -> u64 {
        self.dial_failures
    }

    pub fn reputations(&self) -> &HashMap<PeerId, Reputation> {
        &self.reputation
    }

    pub fn ban(&mut self, peer: PeerId, duration: Duration) {
        let entry = self.reputation.entry(peer).or_default();
        entry.banned_until = Some(Instant::now() + duration);
        entry.score = entry.score.min(crate::PEER_SCORE_BAN_THRESHOLD);
    }

    pub fn adjust_score(&mut self, peer: PeerId, delta: i32, duration: Duration) -> bool {
        let entry = self.reputation.entry(peer).or_default();
        entry.score = (entry.score + delta).clamp(
            crate::PEER_SCORE_BAN_THRESHOLD * 2,
            crate::PEER_SCORE_CEILING,
        );
        if entry.score <= crate::PEER_SCORE_BAN_THRESHOLD && !entry.is_banned(Instant::now()) {
            tracing::warn!(%peer, score = entry.score, "banning misbehaving P2P peer");
            self.ban(peer, duration);
            return true;
        }
        false
    }

    pub fn decay_reputation(&mut self) {
        let now = Instant::now();
        for entry in self.reputation.values_mut() {
            entry.score -=
                entry.score.signum() * entry.score.abs().min(crate::PEER_SCORE_DECAY_STEP);
            if entry.banned_until.is_some_and(|until| until <= now) {
                entry.banned_until = None;
            }
        }
        crate::swarm::prune_reputation(&mut self.reputation, now);
    }

    #[cfg(test)]
    pub fn allow_private_for_test(&mut self, allowed: bool) {
        self.allow_private = allowed;
    }
}

/// A hole punch dials from both ends; the end in the listener role counts the
/// connection as the remote's.
fn dialed_by_us(endpoint: &ConnectedPoint) -> bool {
    matches!(
        endpoint,
        ConnectedPoint::Dialer {
            role_override: Endpoint::Dialer,
            ..
        }
    )
}

pub(crate) fn transport_part(address: &Multiaddr) -> Multiaddr {
    let mut address = address.clone();
    if matches!(address.iter().last(), Some(Protocol::P2p(_))) {
        address.pop();
    }
    address
}

/// Addresses arrive from remote Identify and Kademlia messages. Only the TCP
/// transport and a single circuit hop are supported; peer IDs bind the endpoint.
pub(crate) fn endpoint_ip(address: &Multiaddr, peer: PeerId) -> Option<IpAddr> {
    let mut parts = address.iter();
    let ip = match parts.next()? {
        Protocol::Ip4(ip) if !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast() => {
            IpAddr::V4(ip)
        }
        Protocol::Ip6(ip) if !ip.is_unspecified() && !ip.is_multicast() => IpAddr::V6(ip),
        _ => return None,
    };
    if !matches!(parts.next(), Some(Protocol::Tcp(port)) if port != 0) {
        return None;
    }
    let bound = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (None, None, None, None) => true,
        (Some(Protocol::P2p(id)), None, None, None) => id == peer,
        (Some(Protocol::P2p(relay)), Some(Protocol::P2pCircuit), None, None) => relay != peer,
        (Some(Protocol::P2p(relay)), Some(Protocol::P2pCircuit), Some(Protocol::P2p(id)), None) => {
            relay != peer && id == peer
        }
        _ => false,
    };
    bound.then_some(ip)
}

pub(crate) fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

#[cfg(test)]
fn valid_address(address: &Multiaddr, peer: PeerId, allow_private: bool) -> bool {
    endpoint_ip(address, peer).is_some_and(|ip| allow_private || is_public(ip))
}

/// Wrapping the composite behaviour lets the policy inspect addresses returned
/// by *all* child behaviours before Swarm opens a socket. A sibling behaviour
/// cannot inspect addresses supplied by its siblings.
pub(super) struct Guarded<B> {
    pub inner: B,
    pub limits: libp2p::connection_limits::Behaviour,
    pub policy: Policy,
}

impl<B> Deref for Guarded<B> {
    type Target = B;

    fn deref(&self) -> &B {
        &self.inner
    }
}

impl<B> DerefMut for Guarded<B> {
    fn deref_mut(&mut self) -> &mut B {
        &mut self.inner
    }
}

fn denied() -> ConnectionDenied {
    ConnectionDenied::new(std::io::Error::other("P2P connection policy"))
}

impl<B: NetworkBehaviour> NetworkBehaviour for Guarded<B> {
    type ConnectionHandler = B::ConnectionHandler;
    type ToSwarm = B::ToSwarm;

    fn handle_pending_inbound_connection(
        &mut self,
        id: ConnectionId,
        local: &Multiaddr,
        remote: &Multiaddr,
    ) -> Result<(), ConnectionDenied> {
        self.limits
            .handle_pending_inbound_connection(id, local, remote)?;
        self.inner
            .handle_pending_inbound_connection(id, local, remote)
    }

    fn handle_established_inbound_connection(
        &mut self,
        id: ConnectionId,
        peer: PeerId,
        local: &Multiaddr,
        remote: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        if self.policy.banned(peer) {
            return Err(denied());
        }
        self.limits
            .handle_established_inbound_connection(id, peer, local, remote)?;
        self.inner
            .handle_established_inbound_connection(id, peer, local, remote)
    }

    fn handle_pending_outbound_connection(
        &mut self,
        id: ConnectionId,
        peer: Option<PeerId>,
        addresses: &[Multiaddr],
        role: Endpoint,
    ) -> Result<Vec<Multiaddr>, ConnectionDenied> {
        let Some(peer) = peer else {
            return Err(denied());
        };
        if peer == self.policy.local
            || self.policy.banned(peer)
            || self.policy.removed.contains(&peer)
            || (!self.policy.connected(peer)
                && self
                    .policy
                    .candidates
                    .get(&peer)
                    .is_some_and(|candidate| candidate.retry_at > Instant::now()))
        {
            return Err(denied());
        }
        self.limits
            .handle_pending_outbound_connection(id, Some(peer), addresses, role)?;
        let additional =
            self.inner
                .handle_pending_outbound_connection(id, Some(peer), addresses, role)?;
        // Reject a mixed public/private list as a whole: explicit DialOpts
        // addresses cannot be removed by a NetworkBehaviour callback.
        if addresses.len() + additional.len() > MAX_DIAL_ADDRESSES
            || addresses
                .iter()
                .chain(&additional)
                .any(|address| !self.policy.permitted(peer, address))
        {
            return Err(denied());
        }
        // Retrying an endpoint is not fresh discovery evidence. In particular,
        // repeated failed dials must not extend a candidate's lifetime.
        if !self.policy.candidates.contains_key(&peer) {
            self.policy.learn(
                peer,
                addresses.iter().chain(&additional).cloned().collect(),
                false,
            );
        }
        self.policy.pending.insert(id, Some(peer));
        Ok(additional)
    }

    fn handle_established_outbound_connection(
        &mut self,
        id: ConnectionId,
        peer: PeerId,
        address: &Multiaddr,
        role: Endpoint,
        port: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        if self.policy.banned(peer) || self.policy.removed.contains(&peer) {
            return Err(denied());
        }
        self.limits
            .handle_established_outbound_connection(id, peer, address, role, port)?;
        self.inner
            .handle_established_outbound_connection(id, peer, address, role, port)
    }

    fn on_swarm_event(&mut self, event: FromSwarm) {
        match event {
            FromSwarm::NewExternalAddrCandidate(event)
                if !endpoint_ip(event.addr, self.policy.local)
                    .is_some_and(|ip| self.policy.allow_private || is_public(ip)) =>
            {
                // Identify on a circuit can report only /p2p/id. Do not let
                // unsupported or private observations poison AutoNAT/DCUtR's
                // candidate sets alongside otherwise usable TCP endpoints.
                return;
            }
            FromSwarm::ConnectionEstablished(event) => {
                self.policy
                    .established(event.peer_id, event.connection_id, event.endpoint.clone());
            }
            FromSwarm::ConnectionClosed(event) => {
                self.policy.closed(event.peer_id, event.connection_id);
            }
            FromSwarm::DialFailure(event)
                if self.policy.pending.remove(&event.connection_id).is_some() =>
            {
                self.policy.dial_failures += 1;
                if let Some(peer) = event.peer_id {
                    self.policy.failed(peer);
                }
            }
            _ => {}
        }
        self.limits.on_swarm_event(event);
        self.inner.on_swarm_event(event);
    }

    fn on_connection_handler_event(
        &mut self,
        peer: PeerId,
        id: ConnectionId,
        event: THandlerOutEvent<Self>,
    ) {
        self.inner.on_connection_handler_event(peer, id, event);
    }

    fn poll(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        self.inner.poll(cx)
    }
}

// Reject non-routable and special-use ranges at the remote-address boundary.
fn public_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !ip.is_private()
        && !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_documentation()
        && a != 0 // 0.0.0.0/8: current network.
        && a < 224 // 224.0.0.0/3: multicast and reserved.
        && !(a == 100 && (64..=127).contains(&b)) // 100.64.0.0/10: shared CGNAT.
        && !(a == 198 && (b == 18 || b == 19)) // 198.18.0.0/15: benchmarking.
        && !(a == 192 && b == 0 && c == 0) // 192.0.0.0/24: protocol assignments.
}

fn public_v6(ip: std::net::Ipv6Addr) -> bool {
    let segments = ip.segments();
    // Global unicast only. Mapped IPv4 and transition ranges must not bypass
    // the IPv4 address policy through an IPv6 spelling.
    (segments[0] & 0xe000) == 0x2000 // 2000::/3: global unicast.
        && !(segments[0] == 0x2001 && segments[1] < 0x200) // 2001::/23: special-use.
        && !(segments[0] == 0x2001 && segments[1] == 0xdb8) // 2001:db8::/32: documentation.
        && segments[0] != 0x2002 // 2002::/16: 6to4.
        && !(segments[0] == 0x3fff && segments[1] < 0x1000) // 3fff::/20: documentation.
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "test fixtures")]
mod tests {
    use super::*;

    #[test]
    fn untrusted_addresses_cannot_escape_tcp_or_the_peer_identity() {
        let peer = PeerId::random();
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.2.1",
            "198.19.0.1",
            "0.1.2.3",
            "240.0.0.1",
        ] {
            assert!(!valid_address(
                &format!("/ip4/{ip}/tcp/8646").parse().unwrap(),
                peer,
                false
            ));
        }
        for address in [
            "/ip6/::ffff:127.0.0.1/tcp/8646",
            "/ip6/::1/tcp/8646",
            "/ip6/fc00::1/tcp/8646",
            "/ip4/8.8.8.8/udp/8646",
            "/ip4/8.8.8.8/tcp/0",
        ] {
            assert!(!valid_address(&address.parse().unwrap(), peer, false));
        }
        assert!(valid_address(
            &"/ip4/8.8.8.8/tcp/8646".parse().unwrap(),
            peer,
            false
        ));
        assert!(valid_address(
            &"/ip6/2606:4700::1111/tcp/8646".parse().unwrap(),
            peer,
            false
        ));
        let relay = PeerId::random();
        let address = format!("/ip4/8.8.8.8/tcp/8646/p2p/{relay}/p2p-circuit/p2p/{peer}")
            .parse()
            .unwrap();
        assert!(valid_address(&address, peer, false));
        assert!(!valid_address(&address, PeerId::random(), false));
        let nested = format!("{address}/p2p-circuit/p2p/{peer}").parse().unwrap();
        assert!(!valid_address(&nested, peer, false));
    }

    #[test]
    fn configured_private_addresses_do_not_authorize_other_endpoints_or_identities() {
        let peer = PeerId::random();
        let other = PeerId::random();
        let mut policy = Policy::new(PeerId::random(), false);
        let address: Multiaddr = format!("/ip4/10.0.0.1/tcp/8646/p2p/{peer}")
            .parse()
            .unwrap();
        policy.configured.insert(peer, vec![address.clone()]);
        assert!(policy.permitted(peer, &address));
        assert!(!policy.permitted(
            peer,
            &format!("/ip4/10.0.0.1/tcp/8646/p2p/{other}")
                .parse()
                .unwrap()
        ));
        assert!(!policy.permitted(peer, &"/ip4/10.0.0.2/tcp/8646".parse().unwrap()));
        assert!(!policy.permitted(other, &address));
        policy.learn(peer, vec![address], false);
        policy.learn(peer, Vec::new(), true);
        assert!(policy.candidates[&peer].addresses.is_empty());
    }

    #[test]
    fn learned_candidates_are_bounded_backed_off_and_expire() {
        let mut policy = Policy::new(PeerId::random(), false);
        for _ in 0..MAX_CANDIDATES + 10 {
            policy.learn(
                PeerId::random(),
                (1..12)
                    .map(|port| format!("/ip4/8.8.8.8/tcp/{port}").parse().unwrap())
                    .collect(),
                false,
            );
        }
        assert_eq!(policy.candidates.len(), MAX_CANDIDATES);
        assert!(policy
            .candidates
            .values()
            .all(|candidate| candidate.addresses.len() == MAX_ADDRESSES));
        let peer = *policy.candidates.keys().next().unwrap();
        policy.failed(peer);
        assert!(!policy.ready(true).iter().any(|(id, _)| *id == peer));
        for _ in 0..20 {
            policy.failed(peer);
        }
        assert!(
            policy.candidates[&peer]
                .retry_at
                .duration_since(Instant::now())
                <= Duration::from_mins(5)
        );
        policy.candidates.get_mut(&peer).unwrap().seen =
            Instant::now().checked_sub(CANDIDATE_TTL).unwrap();
        policy.ready(true);
        assert!(!policy.candidates.contains_key(&peer));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "test fixtures")]
mod establishment_tests {
    use super::*;
    use libp2p::{
        connection_limits::{Behaviour as Limits, ConnectionLimits},
        swarm::dummy,
    };
    use std::convert::Infallible;

    #[derive(Default)]
    struct StatefulProbe {
        allocated: HashSet<ConnectionId>,
    }

    impl NetworkBehaviour for StatefulProbe {
        type ConnectionHandler = dummy::ConnectionHandler;
        type ToSwarm = Infallible;

        fn handle_established_inbound_connection(
            &mut self,
            id: ConnectionId,
            _: PeerId,
            _: &Multiaddr,
            _: &Multiaddr,
        ) -> Result<THandler<Self>, ConnectionDenied> {
            self.allocated.insert(id);
            Ok(dummy::ConnectionHandler)
        }

        fn handle_established_outbound_connection(
            &mut self,
            id: ConnectionId,
            _: PeerId,
            _: &Multiaddr,
            _: Endpoint,
            _: PortUse,
        ) -> Result<THandler<Self>, ConnectionDenied> {
            self.allocated.insert(id);
            Ok(dummy::ConnectionHandler)
        }

        fn on_swarm_event(&mut self, _: FromSwarm) {}

        fn on_connection_handler_event(
            &mut self,
            _: PeerId,
            _: ConnectionId,
            event: THandlerOutEvent<Self>,
        ) {
            match event {}
        }

        fn poll(
            &mut self,
            _: &mut Context<'_>,
        ) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
            Poll::Pending
        }
    }

    #[test]
    fn rejected_establishments_never_allocate_downstream_state() {
        let peer = PeerId::random();
        let address = "/ip4/8.8.8.8/tcp/8646".parse().unwrap();
        for limits in [
            ConnectionLimits::default().with_max_established_per_peer(Some(0)),
            ConnectionLimits::default()
                .with_max_established_incoming(Some(0))
                .with_max_established_outgoing(Some(0)),
        ] {
            let mut guarded = Guarded {
                inner: StatefulProbe::default(),
                policy: Policy::new(PeerId::random(), false),
                limits: Limits::new(limits),
            };
            for id in 1..100 {
                assert!(guarded
                    .handle_established_inbound_connection(
                        ConnectionId::new_unchecked(id),
                        peer,
                        &address,
                        &address
                    )
                    .is_err());
                assert!(guarded
                    .handle_established_outbound_connection(
                        ConnectionId::new_unchecked(id + 100),
                        peer,
                        &address,
                        Endpoint::Dialer,
                        PortUse::Reuse
                    )
                    .is_err());
            }
            assert!(guarded.inner.allocated.is_empty());
            guarded.limits = Limits::new(ConnectionLimits::default());
            assert!(guarded
                .handle_established_inbound_connection(
                    ConnectionId::new_unchecked(300),
                    peer,
                    &address,
                    &address
                )
                .is_ok());
            assert_eq!(guarded.inner.allocated.len(), 1);
        }
    }

    #[test]
    fn removal_rejects_outbound_only_and_bans_reject_both_directions() {
        let peer = PeerId::random();
        let address = "/ip4/8.8.8.8/tcp/8646".parse().unwrap();
        let mut guarded = Guarded {
            inner: StatefulProbe::default(),
            policy: Policy::new(PeerId::random(), false),
            limits: Limits::new(ConnectionLimits::default()),
        };
        guarded.policy.removed.insert(peer);
        let id = ConnectionId::new_unchecked(1);
        assert!(guarded
            .handle_established_inbound_connection(id, peer, &address, &address)
            .is_ok());
        assert!(guarded
            .handle_established_outbound_connection(
                id,
                peer,
                &address,
                Endpoint::Dialer,
                PortUse::Reuse
            )
            .is_err());
        assert!(guarded
            .handle_established_outbound_connection(
                id,
                PeerId::random(),
                &address,
                Endpoint::Dialer,
                PortUse::Reuse
            )
            .is_ok());
        guarded.policy.reputation.insert(
            peer,
            Reputation {
                score: -100,
                banned_until: Some(Instant::now() + Duration::from_mins(1)),
            },
        );
        assert!(guarded
            .handle_established_inbound_connection(id, peer, &address, &address)
            .is_err());
        assert!(guarded
            .handle_established_outbound_connection(
                id,
                peer,
                &address,
                Endpoint::Dialer,
                PortUse::Reuse
            )
            .is_err());
    }
}
