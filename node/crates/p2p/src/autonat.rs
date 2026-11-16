//! Bounded, replaceable probe addresses for libp2p AutoNAT v1.
//!
//! `probe_address` retains every observation forever. Its listen-address store,
//! however, supports expiry. This adapter feeds only a bounded set of validated
//! observations into that store using adapter-owned listener events. It never
//! forwards raw listen addresses or calls `probe_address`. These events stay
//! inside AutoNAT and do not advertise or bind an endpoint in the swarm.
use std::collections::VecDeque;
use std::task::{Context, Poll};

use libp2p::core::{
    transport::{ListenerId, PortUse},
    Endpoint,
};
use libp2p::swarm::{
    ConnectionDenied, ConnectionId, ExpiredListenAddr, FromSwarm, NetworkBehaviour, NewListenAddr,
    THandler, THandlerInEvent, THandlerOutEvent, ToSwarm,
};
use libp2p::{autonat, Multiaddr, PeerId};

use crate::policy::{endpoint_ip, is_public, transport_part};
use crate::{connectivity::relay_of, MAX_EXTERNAL_CANDIDATES};

pub(super) struct BoundedAutonat {
    inner: autonat::Behaviour,
    peer: PeerId,
    allow_private: bool,
    listener: ListenerId,
    candidates: VecDeque<Multiaddr>,
}

impl BoundedAutonat {
    pub fn new(peer: PeerId, config: autonat::Config) -> Self {
        Self {
            allow_private: !config.only_global_ips,
            inner: autonat::Behaviour::new(peer, config),
            peer,
            listener: ListenerId::next(),
            candidates: VecDeque::new(),
        }
    }

    pub fn nat_status(&self) -> autonat::NatStatus {
        self.inner.nat_status()
    }

    fn observe(&mut self, address: &Multiaddr) {
        if relay_of(address).is_some()
            || !endpoint_ip(address, self.peer)
                .is_some_and(|ip| self.allow_private || is_public(ip))
        {
            return;
        }
        let address = transport_part(address);
        if let Some(index) = self
            .candidates
            .iter()
            .position(|existing| existing == &address)
        {
            self.candidates.remove(index);
        } else {
            if self.candidates.len() == MAX_EXTERNAL_CANDIDATES {
                if let Some(expired) = self.candidates.pop_front() {
                    self.inner
                        .on_swarm_event(FromSwarm::ExpiredListenAddr(ExpiredListenAddr {
                            listener_id: self.listener,
                            addr: &expired,
                        }));
                }
            }
            self.inner
                .on_swarm_event(FromSwarm::NewListenAddr(NewListenAddr {
                    listener_id: self.listener,
                    addr: &address,
                }));
        }
        self.candidates.push_back(address);
    }
}

impl NetworkBehaviour for BoundedAutonat {
    type ConnectionHandler = <autonat::Behaviour as NetworkBehaviour>::ConnectionHandler;
    type ToSwarm = autonat::Event;

    fn handle_pending_inbound_connection(
        &mut self,
        id: ConnectionId,
        local: &Multiaddr,
        remote: &Multiaddr,
    ) -> Result<(), ConnectionDenied> {
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
        self.inner
            .handle_pending_outbound_connection(id, peer, addresses, role)
    }

    fn handle_established_outbound_connection(
        &mut self,
        id: ConnectionId,
        peer: PeerId,
        address: &Multiaddr,
        role: Endpoint,
        port: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        self.inner
            .handle_established_outbound_connection(id, peer, address, role, port)
    }

    fn on_swarm_event(&mut self, event: FromSwarm) {
        match event {
            FromSwarm::NewExternalAddrCandidate(event) => self.observe(event.addr),
            FromSwarm::ExternalAddrConfirmed(event) => self.observe(event.addr),
            FromSwarm::NewListenAddr(_) | FromSwarm::ExpiredListenAddr(_) => {}
            other => self.inner.on_swarm_event(other),
        }
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, reason = "test fixtures")]
mod tests {
    use super::*;
    use futures::StreamExt;
    use libp2p::{swarm::SwarmEvent, Swarm, SwarmBuilder};
    use std::time::Duration;

    async fn next_probe(
        client: &mut Swarm<BoundedAutonat>,
        server: &mut Swarm<autonat::Behaviour>,
    ) -> Vec<Multiaddr> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    _ = client.select_next_some() => {},
                    event = server.select_next_some() => {
                        if let SwarmEvent::Behaviour(autonat::Event::InboundProbe(autonat::InboundProbeEvent::Request {addresses, ..})) = event {
                            return addresses;
                        }
                    }
                }
            }
        }).await.expect("AutoNAT probe not received")
    }

    #[tokio::test]
    async fn observations_are_evicted_from_actual_probe_requests_even_after_disconnect() {
        let config = autonat::Config {
            boot_delay: Duration::from_millis(50),
            retry_interval: Duration::from_millis(50),
            throttle_server_period: Duration::ZERO,
            throttle_clients_period: Duration::ZERO,
            only_global_ips: false,
            max_peer_addresses: 1000,
            ..Default::default()
        };
        let mut server = SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                Default::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )
            .unwrap()
            .with_behaviour(|key| {
                autonat::Behaviour::new(key.public().to_peer_id(), config.clone())
            })
            .unwrap()
            .build();
        let mut client = SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                Default::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )
            .unwrap()
            .with_behaviour(|key| BoundedAutonat::new(key.public().to_peer_id(), config))
            .unwrap()
            .build();
        server
            .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
            .unwrap();
        let server_address = loop {
            if let SwarmEvent::NewListenAddr { address, .. } = server.select_next_some().await {
                break address;
            }
        };
        let server_peer = *server.local_peer_id();
        client
            .behaviour_mut()
            .inner
            .add_server(server_peer, Some(server_address.clone()));
        for round in 0..2 {
            for port in (10000 + round * 1000)..(11000 + round * 1000) {
                let address = format!("/ip4/127.0.0.1/tcp/{port}").parse().unwrap();
                client
                    .behaviour_mut()
                    .on_swarm_event(FromSwarm::NewExternalAddrCandidate(
                        libp2p::swarm::NewExternalAddrCandidate { addr: &address },
                    ));
            }
            assert_eq!(client.behaviour().candidates.len(), MAX_EXTERNAL_CANDIDATES);
            client
                .dial(server_address.clone().with_p2p(server_peer).unwrap())
                .unwrap();
            let addresses = next_probe(&mut client, &mut server).await;
            assert_eq!(addresses.len(), MAX_EXTERNAL_CANDIDATES);
            assert!(addresses.iter().all(|address| client
                .behaviour()
                .candidates
                .contains(&transport_part(address))));
            client.disconnect_peer_id(server_peer).unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while client.is_connected(&server_peer) {
                    tokio::select! { _ = client.select_next_some() => {}, _ = server.select_next_some() => {} }
                }
            }).await.unwrap();
        }
    }
}
