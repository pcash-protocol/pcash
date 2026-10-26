//! Named networks compiled into the binary.
//!
//! Chain ids and inboxes come from the generated network profile. This file
//! adds launch anchors and public bootnode addresses. A network without a
//! selected anchor cannot start.

use alloy_primitives::{address, b256, Address, B256};
use pcash_p2p::Multiaddr;

use crate::config::NetworkConfig;

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Network {
    /// The PCASH main network on Ethereum; its genesis anchor is not configured.
    Mainnet,
    /// The PCASH test network on Sepolia.
    Testnet,
}

// BEGIN GENERATED NETWORK IDENTITIES (scripts/gen_network_profile.mjs)
pub const DEFAULT_NETWORK: Network = Network::Testnet;
pub const PCASH_CHAIN_ID: u32 = DEFAULT_NETWORK.identity().0;
pub const L1_CHAIN_ID: u64 = DEFAULT_NETWORK.identity().1;
pub const DEFAULT_INBOX: Address = DEFAULT_NETWORK.identity().2;

impl Network {
    pub const fn identity(self) -> (u32, u64, Address) {
        match self {
            Self::Testnet => (
                23_100,
                11_155_111,
                address!("0x00000000000000000000000000000000000CA511"),
            ),
            Self::Mainnet => (
                231,
                1,
                address!("0x00000000000000000000000000000000000CA511"),
            ),
        }
    }
}
// END GENERATED NETWORK IDENTITIES

impl Network {
    pub fn name(self) -> &'static str {
        match self {
            Self::Mainnet => "mainnet",
            Self::Testnet => "testnet",
        }
    }

    pub fn anchor(self) -> Option<(u64, B256)> {
        match self {
            Self::Mainnet => None,
            Self::Testnet => Some((
                12_000_896,
                b256!("0x6e0036c4bdd89e39c2ef0803587302439edb1e2aa9cd0f1b3227c0ac56f67b0f"),
            )),
        }
    }

    pub fn config(self) -> eyre::Result<NetworkConfig> {
        let (block, hash) = self
            .anchor()
            .ok_or_else(|| eyre::eyre!("{} genesis anchor is not configured", self.name()))?;
        let (pcash_chain_id, l1_chain_id, inbox) = self.identity();
        Ok(NetworkConfig::new(
            pcash_chain_id,
            l1_chain_id,
            inbox,
            block,
            hash,
        ))
    }

    #[allow(
        clippy::expect_used,
        reason = "compiled constants, each parsed by every_bootnode_names_the_peer_to_dial"
    )]
    pub fn bootnodes(self) -> Vec<Multiaddr> {
        let addresses: &[&str] = match self {
            Self::Mainnet => &[],
            Self::Testnet => &[
                "/ip4/34.86.53.85/tcp/8646/p2p/12D3KooWAAECcXFFR5WKceYXo8Tg9c7fhSs28hqsmXqB355Pj7AM",
            ],
        };
        addresses
            .iter()
            .map(|address| address.parse().expect("compiled bootnode address"))
            .collect()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests use direct assertions")]
mod tests {
    use super::Network;
    use alloy_primitives::{address, b256};
    use clap::ValueEnum;

    #[test]
    fn preset_identities_and_launch_configuration() {
        assert_eq!(
            Network::Mainnet.identity(),
            (231, 1, address!("00000000000000000000000000000000000CA511"))
        );
        assert_eq!(Network::Mainnet.anchor(), None);
        assert!(Network::Mainnet.bootnodes().is_empty());
        assert_eq!(
            Network::Mainnet.config().unwrap_err().to_string(),
            "mainnet genesis anchor is not configured"
        );
        let testnet = Network::Testnet.config().unwrap();
        assert_eq!(testnet.pcash_chain_id, 23_100);
        assert_eq!(testnet.l1_chain_id, 11_155_111);
        assert_eq!(
            testnet.inbox,
            address!("00000000000000000000000000000000000CA511")
        );
        assert_eq!(testnet.genesis_l1_block, 12_000_896);
        assert_eq!(
            testnet.genesis_l1_block_hash,
            b256!("6e0036c4bdd89e39c2ef0803587302439edb1e2aa9cd0f1b3227c0ac56f67b0f")
        );
        assert!(!Network::Testnet.bootnodes().is_empty());
    }

    #[test]
    fn every_bootnode_names_the_peer_to_dial() {
        for network in Network::value_variants() {
            let bootnodes = network.bootnodes();
            for address in bootnodes {
                assert!(
                    pcash_p2p::peer_id_of(&address).is_some(),
                    "{address} does not end in /p2p/<peer-id>"
                );
            }
        }
    }

    #[test]
    fn a_network_name_is_its_command_line_value() {
        for network in Network::value_variants() {
            assert_eq!(
                network.to_possible_value().unwrap().get_name(),
                network.name()
            );
        }
    }
}
