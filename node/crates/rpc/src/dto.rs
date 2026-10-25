//! JSON-RPC response types, shared by the server and the client.
//!
//! These are wire types in the alloy sense: their Rust shape *is* the JSON
//! shape, so `serde` alone describes the encoding and both directions stay in
//! step by construction. Protocol byte strings are fixed-width lowercase `0x`
//! hex (`B256`, `Address`, `Bytes` already serialize exactly that) and counts,
//! indices, block numbers, and amounts are minimal JSON-RPC hex quantities
//! (`U256` natively, `alloy_serde::quantity` for the fixed-width integers).
//! The two gaps those leave — depth-40 openings and the foreign `pcash_state`
//! boundary types — are bridged in [`crate::wire`].

use alloy_primitives::{Address, Bytes, B256, I256, U256};
use serde::{Deserialize, Serialize};

use crate::wire;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BlockId {
    #[serde(with = "alloy_serde::quantity")]
    pub block_number: u64,
    pub block_hash: B256,
}

pcash_state::codec::codec_struct!(BlockId {
    block_number,
    block_hash
});

/// Where an issuance-eligible entry sends newly issued PCASH. Open fees
/// always belong to the successful poster.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssuanceRoute {
    /// The entry cannot earn issuance.
    None,
    /// A zero commitment: the successful including batch's poster collects.
    Open,
    /// A nonzero commitment names the destination.
    Designated,
}

/// The transaction kinds this RPC surface names. The wire spelling is the
/// single definition; `pcash_getMempool`'s `kind` filter uses the same set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransactionKind {
    PrivateValue,
    UserAccountCreation,
    UserAccountUpdate,
    ContractAccount,
    /// A retained entry whose type byte this node does not recognize.
    Unknown,
}

/// How a `contractAccount` transaction is funded: the funding-mode byte of its
/// admitted bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContractFundingMode {
    Unfunded,
    Sponsored,
}

pcash_state::codec::codec_enum!(ContractFundingMode: u8 {
    Unfunded,
    Sponsored
});

impl From<pcash_derive::ContractFundingMode> for ContractFundingMode {
    fn from(mode: pcash_derive::ContractFundingMode) -> Self {
        match mode {
            pcash_derive::ContractFundingMode::Unfunded => Self::Unfunded,
            pcash_derive::ContractFundingMode::Sponsored => Self::Sponsored,
        }
    }
}

impl ContractFundingMode {
    /// The funding mode of admitted transaction bytes, present exactly for a
    /// contract-account creation.
    pub fn of(tx_bytes: &[u8]) -> Option<Self> {
        pcash_derive::contract_funding_mode(tx_bytes).map(Self::from)
    }
}

impl TransactionKind {
    /// Whether this names a kind the mempool can hold.
    ///
    /// [`Unknown`](Self::Unknown) describes a retained entry whose type byte
    /// this node does not recognize, which only ever appears on a receipt. The
    /// mempool admits nothing it cannot classify, so filtering by it could only
    /// ever return an empty page and is refused instead.
    pub const fn is_admissible(self) -> bool {
        !matches!(self, Self::Unknown)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkCapabilityDto {
    #[serde(with = "alloy_serde::quantity")]
    pub chain_id: u32,
    pub genesis_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub head_timestamp: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub current_fork_count: u16,
    pub current_prefix_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub next_activation_timestamp: u64,
    pub next_prefix_hash: B256,
}

/// Which side opened a peer connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerDirectionDto {
    Inbound,
    Outbound,
}

/// Everything this node knows about one connected peer.
///
/// A peer appears here as soon as its connection is established, before the
/// fork-capability handshake has run: `compatible` is false and `capability` is
/// null until it completes. That window is real, and hiding it would hide the
/// most common reason a peer is connected but not syncing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfoDto {
    pub peer_id: String,
    /// Remote multiaddress of the connection.
    pub remote_address: String,
    pub direction: PeerDirectionDto,
    #[serde(with = "alloy_serde::quantity")]
    pub connected_seconds: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub connections: u64,
    pub compatible: bool,
    pub incompatible_reason: Option<String>,
    /// The peer's advertised fork capability, once it has handshaked.
    pub capability: Option<ForkCapabilityDto>,
    /// libp2p identify, absent until the peer has been identified.
    pub agent_version: Option<String>,
    pub protocol_version: Option<String>,
    /// Most recent successful ping round trip.
    #[serde(with = "alloy_serde::quantity::opt")]
    pub rtt_millis: Option<u64>,
    /// PCASH protocol payload exchanged with this peer since it connected:
    /// gossip message data plus mempool-sync request and response bodies. This
    /// is not wire bytes — Noise encryption, Yamux framing, TCP/IP headers, and
    /// libp2p's own identify and ping traffic are all excluded. It answers what
    /// the peer contributed to and cost the mempool, not what it put on the
    /// network.
    #[serde(with = "alloy_serde::quantity")]
    pub payload_bytes_sent: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub payload_bytes_received: u64,
    /// Candidates received from this peer, and how local admission judged them.
    /// `txRejected` counts only attributable misconduct; a candidate dropped
    /// because this node was behind or busy is neither accepted nor rejected,
    /// so the three need not sum.
    #[serde(with = "alloy_serde::quantity")]
    pub tx_received: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub tx_accepted: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub tx_rejected: u64,
    /// Misconduct score; negative means this peer is heading for a ban.
    pub score: i64,
    /// Remaining ban, when the peer is banned.
    #[serde(with = "alloy_serde::quantity::opt")]
    pub banned_seconds: Option<u64>,
    /// The newest L1 block for which this peer advertised a different PCASH
    /// block hash than this node derived, since it connected. An alert only:
    /// it does not stop derivation or change the peer's score.
    pub divergence: Option<BlockHashDivergenceDto>,
}

/// A peer's PCASH block hash for an L1 block differs from this node's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockHashDivergenceDto {
    #[serde(with = "alloy_serde::quantity")]
    pub l1_block_number: u64,
    pub l1_block_hash: B256,
    pub local_block_hash: B256,
    pub peer_block_hash: B256,
}

/// This node's own transport identity, and the addresses another node's
/// `admin_addPeer` can be given.
///
/// Bound interfaces and advertised endpoints are separate. The network
/// snapshot reports discovery, reachability and active relay reservations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfoDto {
    pub peer_id: String,
    /// Every address currently bound, without the `/p2p/<peer-id>` suffix.
    pub listen_addresses: Vec<String>,
    /// Confirmed or operator-advertised endpoints, including relay circuits.
    pub bootstrap_addresses: Vec<String>,
    pub network: P2pNetworkDto,
    pub topic: String,
    #[serde(with = "alloy_serde::quantity")]
    pub peer_count: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pNetworkDto {
    pub discovery_mode: String,
    #[serde(with = "alloy_serde::quantity")]
    pub routing_peers: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub pending_dials: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub target_peers: u64,
    pub reachability: String,
    pub relay_reservations: Vec<String>,
    #[serde(with = "alloy_serde::quantity")]
    pub relay_circuits: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub relay_circuits_closed: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub discovery_queries_succeeded: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub discovery_queries_failed: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub dial_failures: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub hole_punches_succeeded: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub hole_punches_failed: u64,
}

/// Result of `admin_addPeer`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPeerResultDto {
    pub peer_id: String,
}

/// Result of `admin_removePeer`. `removed` is false when the peer was neither
/// connected nor in the redial set; a ban is still recorded either way.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovePeerResultDto {
    pub removed: bool,
    pub banned: bool,
}

/// Derived-index health, and how far it has caught up.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusDto {
    pub status: String,
    pub cursor: Option<BlockId>,
}

/// Browser proving assets installed alongside this node deployment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProverAssetsDto {
    pub asset_set_id: String,
    pub base_url: String,
}

/// The input derivation is waiting for. It fetches that input again until it arrives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StallCause {
    /// The execution-layer RPC cannot be read.
    L1Rpc,
    /// Blob data for an inbox carrier cannot be obtained.
    Blobs,
}

impl StallCause {
    pub const ALL: [Self; 2] = [Self::L1Rpc, Self::Blobs];
}

/// Why derivation stopped. The error itself stays in the node's log, because its
/// text can carry an RPC credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HaltCause {
    /// The pinned verifier could not give a verdict.
    Verifier,
    /// A canonical state read or write failed.
    Storage,
    /// Ethereum data the node cannot derive from, such as a malformed block or a
    /// reorganization below the finalized height.
    L1Input,
    /// Any other failure of the node itself.
    Internal,
}

impl HaltCause {
    pub const ALL: [Self; 4] = [Self::Verifier, Self::Storage, Self::L1Input, Self::Internal];
}

/// Whether this node is deriving. `l1_block_number` is the first L1 block it has
/// not derived, and `since_unix_ms` is when the state began.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum DerivationDto {
    #[serde(rename_all = "camelCase")]
    Following {
        #[serde(with = "alloy_serde::quantity")]
        since_unix_ms: u64,
    },
    /// Retrying until the input is available.
    #[serde(rename_all = "camelCase")]
    Stalled {
        cause: StallCause,
        #[serde(with = "alloy_serde::quantity")]
        l1_block_number: u64,
        #[serde(with = "alloy_serde::quantity")]
        since_unix_ms: u64,
    },
    /// Stopped by a fatal derivation error until the node is restarted.
    #[serde(rename_all = "camelCase")]
    Halted {
        cause: HaltCause,
        #[serde(with = "alloy_serde::quantity")]
        l1_block_number: u64,
        #[serde(with = "alloy_serde::quantity")]
        since_unix_ms: u64,
    },
}

impl DerivationDto {
    pub const fn since_unix_ms(&self) -> u64 {
        match *self {
            Self::Following { since_unix_ms }
            | Self::Stalled { since_unix_ms, .. }
            | Self::Halted { since_unix_ms, .. } => since_unix_ms,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    #[serde(with = "alloy_serde::quantity")]
    pub latest_block: u64,
    pub latest_block_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub latest_block_timestamp: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub finalized_block: u64,
    pub finalized_block_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub finalized_block_timestamp: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub latest_l1_block_number: u64,
    pub latest_l1_block_hash: B256,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub observed_l1_block_number: Option<u64>,
    pub derivation: DerivationDto,
    #[serde(with = "alloy_serde::quantity")]
    pub finalized_l1_block_number: u64,
    pub finalized_l1_block_hash: B256,
    pub state_root: B256,
    pub l1_origin_root: B256,
    pub history_root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub output_count: u64,
    pub issued_so_far: U256,
    pub supply_cap: U256,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub total_succeeded: Option<u64>,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub total_failed: Option<u64>,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub total_transactions: Option<u64>,
    pub index: IndexStatusDto,
    /// Deployment capability only; absent hosting is represented explicitly as null.
    pub prover_assets: Option<ProverAssetsDto>,
    #[serde(with = "alloy_serde::quantity")]
    pub pcash_chain_id: u32,
    pub genesis_hash: B256,
    #[serde(with = "alloy_serde::quantity::vec")]
    pub accepted_transaction_types: Vec<u8>,
    #[serde(with = "alloy_serde::quantity::vec")]
    pub accepted_batch_versions: Vec<u8>,
    #[serde(with = "alloy_serde::quantity")]
    pub l1_chain_id: u64,
    pub inbox_address: Address,
    #[serde(with = "alloy_serde::quantity")]
    pub genesis_l1_block: u64,
    pub genesis_l1_block_hash: B256,
    pub fork_capability: ForkCapabilityDto,
}

/// The L1 batch a PCASH block was derived from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct L1OriginDto {
    #[serde(with = "alloy_serde::quantity")]
    pub block_number: u64,
    pub block_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub block_timestamp: u64,
    pub l1_logs_root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub l1_log_count: u64,
}

/// How a carrier delivered its batch: an Inbox transaction's calldata or
/// blobs, or a carrier event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CarrierTypeDto {
    Calldata,
    Blob,
    Event,
}

/// One canonical carrier's delivery manifest. Its Ethereum block is the L1
/// origin of the PCASH block that retains it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct L1DeliveryBatchDto {
    #[serde(with = "alloy_serde::quantity")]
    pub l1_block_number: u64,
    pub l1_block_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub l1_transaction_index: u64,
    pub l1_transaction_hash: B256,
    pub l1_sender: Address,
    pub carrier_type: CarrierTypeDto,
    /// A carrier event's receipt-local log index; null for an Inbox carrier.
    #[serde(with = "alloy_serde::quantity::opt")]
    pub log_index: Option<u64>,
    /// A carrier event's emitter; null for an Inbox carrier.
    pub emitter: Option<Address>,
    /// A carrier event's context bytes, when its data is the canonical
    /// encoding; null otherwise and for an Inbox carrier.
    pub context: Option<Bytes>,
    /// For a carrier event, the hash and length of its whole log data.
    pub carrier_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub carrier_length: u64,
    pub blob_versioned_hashes: Vec<B256>,
    pub poster_owner_commitment: Option<B256>,
    pub poster_context: Option<B256>,
    pub exclusion_reason: Option<pcash_state::BatchExclusionReason>,
    pub items: Vec<pcash_state::L1DeliveryItem>,
}

impl L1DeliveryBatchDto {
    pub fn new(l1_origin: &pcash_state::L1Origin, batch: pcash_state::L1DeliveryBatch) -> Self {
        let (carrier_type, log_index, emitter, context) = match batch.carrier_type {
            pcash_state::CarrierType::Calldata => (CarrierTypeDto::Calldata, None, None, None),
            pcash_state::CarrierType::Blob => (CarrierTypeDto::Blob, None, None, None),
            pcash_state::CarrierType::Event {
                log_index,
                emitter,
                context,
            } => (
                CarrierTypeDto::Event,
                Some(log_index),
                Some(emitter),
                context.map(Bytes::from),
            ),
        };
        Self {
            l1_block_number: l1_origin.block_number,
            l1_block_hash: l1_origin.block_hash,
            l1_transaction_index: batch.l1_transaction_index,
            l1_transaction_hash: batch.l1_transaction_hash,
            l1_sender: batch.l1_sender,
            carrier_type,
            log_index,
            emitter,
            context,
            carrier_hash: batch.carrier_hash,
            carrier_length: batch.carrier_length,
            blob_versioned_hashes: batch.blob_versioned_hashes,
            poster_owner_commitment: batch.poster_owner_commitment,
            poster_context: batch.poster_context,
            exclusion_reason: batch.exclusion_reason,
            items: batch.items,
        }
    }
}

/// Where the next page of the requested L1 transaction's manifests starts:
/// the carrier position `nextBatch` in carrier order, among the manifests the
/// PCASH block `block` retains.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct L1DeliveryBatchContinuationDto {
    pub block: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub next_batch: u64,
}

/// One page of an L1 transaction's carrier manifests, in carrier order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct L1DeliveryBatchPageDto {
    pub l1_transaction_hash: B256,
    pub batches: Vec<L1DeliveryBatchDto>,
    pub continuation: Option<L1DeliveryBatchContinuationDto>,
    pub complete: bool,
}

/// Consensus result for one admitted transaction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionResultDto {
    pub inclusion: InclusionId,
    pub content_hash: B256,
    #[serde(rename = "transactionId")]
    pub tx_id: B256,
    pub outcome: pcash_state::TransactionOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    #[serde(with = "alloy_serde::quantity")]
    pub number: u64,
    pub hash: B256,
    pub parent_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub timestamp: u64,
    pub transaction_results_root: B256,
    pub state_root: B256,
    pub l1_origin_root: B256,
    pub history_root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub transaction_result_count: u64,
    pub transaction_results: Vec<TransactionResultDto>,
    /// Exact canonical transaction bodies when the request selected the full
    /// form; null for the compact form.
    pub transaction_bytes: Option<Vec<Bytes>>,
    pub l1_origin: L1OriginDto,
}

/// The snapshot every current-state proof is authenticated against: the exact
/// `StateRoot` preimage, the exact header preimage, and the block hash they
/// commit to. A caller recomputes both commitments and requires one envelope
/// across every response it combines.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentBoundaryEnvelope {
    #[serde(with = "wire::StateComponentsDef")]
    pub state: pcash_state::StateComponents,
    #[serde(with = "wire::BlockHeaderDef")]
    pub header: pcash_state::BlockHeader,
    pub block_hash: B256,
}

impl CurrentBoundaryEnvelope {
    pub fn block_id(&self) -> BlockId {
        BlockId {
            block_number: self.header.number,
            block_hash: self.block_hash,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPathDto {
    #[serde(with = "alloy_serde::quantity")]
    pub output_index: u64,
    pub root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub count: u64,
    #[serde(with = "wire::hash_array")]
    pub siblings: [B256; 40],
    pub boundary: CurrentBoundaryEnvelope,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputLeafPathDto {
    #[serde(with = "alloy_serde::quantity")]
    pub output_index: u64,
    #[serde(with = "wire::hash_array")]
    pub siblings: [B256; 40],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPathsDto {
    pub root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub count: u64,
    pub paths: Vec<OutputLeafPathDto>,
    pub boundary: CurrentBoundaryEnvelope,
}

/// Whether an address publishes a receive key, and if so the key itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ReceiveMaterialDto {
    NotPresent,
    #[serde(rename_all = "camelCase")]
    Available {
        ml_kem768_public_key: Bytes,
    },
    #[serde(rename_all = "camelCase")]
    Unavailable {
        lifecycle: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDto {
    pub address: Address,
    #[serde(with = "alloy_serde::quantity")]
    pub index: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub account_revision: u32,
    #[serde(with = "alloy_serde::quantity")]
    pub account_kind: u8,
    pub nullifier_key_commitment: B256,
    pub account_rule_set_commitment: B256,
    pub receive_key_hash: B256,
    pub material: ReceiveMaterialDto,
}

/// An account proof is self-describing: the same `status: "present"` appears
/// whether the proof is the whole `pcash_getAccountProof` response or nested
/// inside a contract response, so the shape does not depend on where it sits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccountProofPresent {
    #[default]
    #[serde(rename = "present")]
    Present,
}

/// The counterpart discriminator for an address with no account.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccountProofNotFound {
    #[default]
    #[serde(rename = "notFound")]
    NotFound,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProofDto {
    #[serde(default)]
    pub status: AccountProofPresent,
    pub account: AccountDto,
    pub account_state_root: B256,
    #[serde(with = "wire::hash_array")]
    pub account_siblings: [B256; 40],
    #[serde(with = "alloy_serde::quantity")]
    pub account_count: u64,
    pub state_root_header_siblings: [B256; 4],
    pub account_state_root_state_siblings: [B256; 4],
    pub boundary: CurrentBoundaryEnvelope,
}

/// Untagged rather than internally tagged, because the `present` arm's `status`
/// belongs to [`AccountProofDto`] itself — a nested proof carries it too. The two
/// arms are told apart by that same discriminator, which each one requires.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AccountProofResultDto {
    #[serde(rename_all = "camelCase")]
    NotFound {
        status: AccountProofNotFound,
        address: Address,
        /// Always `false`: an absence carries no proof.
        authenticated: bool,
    },
    Present(Box<AccountProofDto>),
}

impl AccountProofResultDto {
    /// No account at `address`. The discriminator and `authenticated: false` are
    /// fixed by the shape, so no caller can spell them differently.
    pub fn not_found(address: Address) -> Self {
        Self::NotFound {
            status: AccountProofNotFound::NotFound,
            address,
            authenticated: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockHeaderDto {
    pub recent_pcash_block_hash: B256,
    pub boundary: CurrentBoundaryEnvelope,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct L1OriginProofDto {
    pub recent_pcash_block_hash: B256,
    pub l1_origin_root: B256,
    pub l1_origin_root_siblings: [B256; 4],
    #[serde(with = "alloy_serde::quantity")]
    pub l1_block_number: u64,
    /// The full Ethereum block hash. The L1 origin leaf commits its high and
    /// low 128-bit halves.
    pub l1_block_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub l1_block_timestamp: u64,
    pub l1_logs_root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub l1_log_count: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub l1_origin_index: u64,
    #[serde(with = "wire::hash_array")]
    pub l1_origin_siblings: [B256; 40],
    pub boundary: CurrentBoundaryEnvelope,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct L1LogProofDto {
    #[serde(flatten)]
    pub block: L1OriginProofDto,
    #[serde(with = "alloy_serde::quantity")]
    pub log_leaf_index: u64,
    #[serde(with = "wire::hash_array")]
    pub log_siblings: [B256; 64],
    #[serde(with = "alloy_serde::quantity")]
    pub transaction_index: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub log_index: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ResultPosition {
    #[serde(with = "alloy_serde::quantity")]
    PcashTransactionIndex(u64),
    #[serde(with = "alloy_serde::quantity")]
    PayoutIndex(u64),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ResultLeafDto {
    Transaction {
        tx_type: u8,
        funding_mode: u8,
        #[serde(with = "alloy_serde::quantity")]
        l1_transaction_index: u64,
        #[serde(with = "alloy_serde::quantity")]
        batch_item_index: u64,
        outcome: u16,
        poster_owner_commitment: B256,
        #[serde(with = "alloy_serde::quantity")]
        output_start_index: u64,
        statement_hash: B256,
        statement: Option<Box<ResultStatementDto>>,
    },
    Payout(Box<PayoutResultLeafDto>),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultStatementDto {
    pub words: Vec<B256>,
    pub account_update_opening: Option<AccountUpdateOpeningDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountUpdateOpeningDto {
    pub current_account_state: AccountUpdateCurrentAccountStateDto,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountUpdateCurrentAccountStateDto {
    pub nullifier_key_commitment: B256,
    pub rule_set_commitment: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub revision: u32,
    pub receive_key_hash: B256,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PayoutResultLeafDto {
    #[serde(with = "alloy_serde::quantity")]
    pub output_index: u64,
    pub owner_commitment: B256,
    pub open_fee_amount: U256,
    pub issuance_amount: U256,
    #[serde(with = "wire::hash_array")]
    pub output_siblings: [B256; 40],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultProofDto {
    pub recent_pcash_block_hash: B256,
    pub block: BlockHeaderDto,
    pub history: Option<HistoryProofDto>,
    pub results_root_siblings: [B256; 4],
    #[serde(with = "alloy_serde::quantity")]
    pub transaction_count: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub payout_count: u64,
    pub results_tree_root: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub leaf_index: u64,
    #[serde(with = "wire::hash_array")]
    pub siblings: [B256; 64],
    pub leaf: ResultLeafDto,
    pub recent_boundary: CurrentBoundaryEnvelope,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryProofDto {
    pub recent_pcash_block_hash: B256,
    pub history_root: B256,
    pub history_root_siblings: [B256; 4],
    #[serde(with = "alloy_serde::quantity")]
    pub historical_block_number: u64,
    pub historical_block_hash: B256,
    #[serde(with = "wire::hash_array")]
    pub history_siblings: [B256; 40],
    pub boundary: CurrentBoundaryEnvelope,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NullifierLeafDto {
    pub value: B256,
    pub next_value: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub next_index: u64,
}

/// The leaf holding the nullifier when it is spent, otherwise its low leaf.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NullifierProofDto {
    pub nullifier: B256,
    pub leaf: NullifierLeafDto,
    #[serde(with = "alloy_serde::quantity")]
    pub leaf_index: u64,
    #[serde(with = "wire::hash_array")]
    pub siblings: [B256; pcash_state::NULLIFIER_TREE_DEPTH],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NullifierProofsDto {
    #[serde(rename = "nullifierRoot")]
    pub root: B256,
    pub proofs: Vec<NullifierProofDto>,
    pub boundary: CurrentBoundaryEnvelope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InclusionId {
    #[serde(with = "alloy_serde::quantity")]
    pub l1_block_number: u64,
    pub l1_block_hash: B256,
    #[serde(rename = "l1TransactionIndex", with = "alloy_serde::quantity")]
    pub l1_transaction_index: u64,
    /// The L1 transaction that carried this batch. Names the delivery directly,
    /// so a reader reaches the batch and its Ethereum record without first
    /// resolving the index against an L1 block.
    #[serde(rename = "l1TransactionHash")]
    pub l1_transaction_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub batch_item_index: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractFunctionDto {
    #[serde(with = "alloy_serde::quantity")]
    pub selector: u8,
    pub application_vk_hash: B256,
    pub configuration_commitment: B256,
}

/// Like [`AccountProofDto`], a contract is self-describing: `pcash_getContract`
/// and the source-verification view both nest the identical object.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContractPresent {
    #[default]
    #[serde(rename = "contract")]
    Contract,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContractNotFound {
    #[default]
    #[serde(rename = "notFound")]
    NotFound,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContractNotContract {
    #[default]
    #[serde(rename = "notContract")]
    NotContract,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContractUnavailable {
    #[default]
    #[serde(rename = "unavailable")]
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractDto {
    #[serde(default)]
    pub status: ContractPresent,
    pub address: Address,
    pub account_proof: AccountProofDto,
    pub functions: Vec<ContractFunctionDto>,
    pub transaction: Bytes,
    pub origin: InclusionId,
}

/// Untagged for the same reason as [`AccountProofResultDto`]: the `contract` arm's
/// discriminator lives on [`ContractDto`], which is nested elsewhere. Every arm
/// requires its own one-value `status`, so exactly one can ever match.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ContractResultDto {
    #[serde(rename_all = "camelCase")]
    NotFound {
        status: ContractNotFound,
        address: Address,
        /// Always `false`: an absence carries no proof.
        authenticated: bool,
    },
    #[serde(rename_all = "camelCase")]
    NotContract {
        status: ContractNotContract,
        account_proof: AccountProofDto,
    },
    Contract(ContractDto),
    #[serde(rename_all = "camelCase")]
    Unavailable {
        status: ContractUnavailable,
        address: Address,
        lifecycle: String,
    },
}

impl ContractResultDto {
    /// No account at `address` at all.
    pub fn not_found(address: Address) -> Self {
        Self::NotFound {
            status: ContractNotFound::NotFound,
            address,
            authenticated: false,
        }
    }

    /// An account exists, but it is not a type-2 contract.
    pub fn not_contract(account_proof: AccountProofDto) -> Self {
        Self::NotContract {
            status: ContractNotContract::NotContract,
            account_proof,
        }
    }

    /// The contract index cannot answer right now.
    pub fn unavailable(address: Address, lifecycle: impl Into<String>) -> Self {
        Self::Unavailable {
            status: ContractUnavailable::Unavailable,
            address,
            lifecycle: lifecycle.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountReceiptDto {
    pub address: Address,
    #[serde(with = "alloy_serde::quantity")]
    pub account_revision: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptDto {
    pub inclusion: InclusionId,
    pub content_hash: B256,
    #[serde(rename = "transactionId")]
    pub tx_id: B256,
    pub outcome: pcash_state::TransactionOutcome,
    pub failure_detail: Option<pcash_state::FailureDetail>,
    pub l1_sender: Address,
    /// The resolved issuance destination: the designated commitment, or
    /// the including batch's poster for the open route. Absent for kinds that
    /// cannot earn issuance. A failed inclusion still reports the destination.
    pub issuance_owner_commitment: Option<B256>,
    pub settled_open_fee_amount: U256,
    /// The block's `rewardEach` for a successful type `0x00` action, else zero.
    pub settled_issuance_amount: U256,
    pub kind: TransactionKind,
    pub funding_mode: Option<ContractFundingMode>,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub output_leaf_start: Option<u64>,
    #[serde(with = "alloy_serde::quantity")]
    pub outputs_added: u64,
    pub nullifiers: Option<Vec<B256>>,
    pub account: Option<AccountReceiptDto>,
}

impl ReceiptDto {
    pub const fn accepted(&self) -> bool {
        self.outcome.is_succeeded()
    }
}

/// A newest-first Explorer continuation. `head` anchors the first page to one
/// exact canonical branch; the remaining fields identify the last item
/// returned and are exclusive on the next page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExplorerCursorDto {
    pub head: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub block_number: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub pcash_transaction_index: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionSummaryDto {
    pub l1_sender: Address,
    pub issuance_owner_commitment: Option<B256>,
    pub settled_open_fee_amount: U256,
    pub settled_issuance_amount: U256,
    #[serde(rename = "transactionId")]
    pub tx_id: B256,
    pub content_hash: B256,
    pub outcome: pcash_state::TransactionOutcome,
    pub failure_detail: Option<pcash_state::FailureDetail>,
    pub declared_open_fee_amount: Option<U256>,
    pub declared_issuance_owner_commitment: Option<B256>,
    pub issuance_route: IssuanceRoute,
    pub kind: TransactionKind,
    pub funding_mode: Option<ContractFundingMode>,
    pub block: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub pcash_transaction_index: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub timestamp: u64,
    pub inclusion: InclusionId,
    #[serde(with = "alloy_serde::quantity")]
    pub byte_size: u64,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub output_leaf_start: Option<u64>,
    #[serde(with = "alloy_serde::quantity")]
    pub outputs_added: u64,
    pub nullifiers: Option<Vec<B256>>,
    pub account: Option<AccountReceiptDto>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionPageDto {
    pub items: Vec<TransactionSummaryDto>,
    pub next_cursor: Option<ExplorerCursorDto>,
    pub head: BlockId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionDto {
    pub summary: TransactionSummaryDto,
    pub raw_transaction: Bytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContractVerificationStatusDto {
    Verified,
    NotVerified,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractSummaryDto {
    pub address: Address,
    pub block: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub pcash_transaction_index: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub timestamp: u64,
    pub transaction_id: B256,
    pub origin: InclusionId,
    pub functions: Vec<ContractFunctionDto>,
    pub source_verification: Option<ContractVerificationStatusDto>,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub configuration_opening_count: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractPageDto {
    pub items: Vec<ContractSummaryDto>,
    pub next_cursor: Option<ExplorerCursorDto>,
    pub head: BlockId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockPayoutsDto {
    pub block: BlockId,
    pub open_fees_total: U256,
    pub issuance_total: U256,
    pub payouts: Vec<PayoutRecordDto>,
}

/// One PCASH-wei fee per tier, already scaled to the estimate's byte size.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeTiersDto {
    pub low: U256,
    pub standard: U256,
    pub fast: U256,
}

/// Included and pending fee samples behind the estimate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeEstimateBasisDto {
    #[serde(with = "alloy_serde::quantity")]
    pub included_samples: u64,
    /// Fee-density percentiles of open-fee transactions included in the
    /// window, absent without samples.
    pub included: Option<FeeTiersDto>,
    #[serde(with = "alloy_serde::quantity")]
    pub pending_samples: u64,
    /// The same over ready open-fee entries in this node's pool.
    pub pending: Option<FeeTiersDto>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeEstimateDto {
    pub head: BlockId,
    /// Canonical blocks actually observed, at most the configured window.
    #[serde(with = "alloy_serde::quantity")]
    pub window_blocks: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub byte_size: u64,
    pub tiers: FeeTiersDto,
    pub basis: FeeEstimateBasisDto,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MempoolTransactionDto {
    pub content_hash: B256,
    pub statement_id: B256,
    pub kind: TransactionKind,
    pub funding_mode: Option<ContractFundingMode>,
    pub stable_id: String,
    pub conflict_keys: Vec<String>,
    pub open_fee_amount: U256,
    pub issuance_owner_commitment: B256,
    pub issuance_route: IssuanceRoute,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub valid_until: Option<u64>,
    /// The recent PCASH block a private-value section proves against; null
    /// for kinds without one.
    pub recent_pcash_block_hash: Option<B256>,
    #[serde(with = "alloy_serde::quantity")]
    pub byte_size: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub received_at_unix_ms: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub conflict_count: u64,
    pub status: String,
    #[serde(with = "alloy_serde::quantity")]
    pub head_checked_block: u64,
    pub head_checked_block_hash: B256,
    /// The application records in the arena's public segment, in identifier
    /// order; empty when the entry has none.
    pub public_records: Vec<PublicRecordDto>,
    pub raw_transaction: Option<Bytes>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicRecordDto {
    pub schema: alloy_primitives::FixedBytes<4>,
    pub data: Bytes,
}

impl From<pcash_derive::public_records::PublicRecord> for PublicRecordDto {
    fn from(record: pcash_derive::public_records::PublicRecord) -> Self {
        Self {
            schema: record.schema.into(),
            data: record.data.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MempoolPageDto {
    pub items: Vec<MempoolTransactionDto>,
    pub next_cursor: Option<B256>,
    #[serde(with = "alloy_serde::quantity")]
    pub head_checked_block: u64,
    pub head_checked_block_hash: B256,
    #[serde(with = "alloy_serde::quantity::opt")]
    pub peer_count: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MempoolStatusFilter {
    Ready,
    Suspended,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MempoolSort {
    #[default]
    ReceivedAt,
    FeeDensity,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MempoolRejectionDto {
    pub content_hash: B256,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRelayDto {
    pub selected_transactions: Vec<Bytes>,
    pub selected_content_hashes: Vec<B256>,
    pub rejected: Vec<MempoolRejectionDto>,
    /// Public open fees of selected entries, always owed to the successful poster.
    pub collectible_open_fee: U256,
    /// Selected type `0x00` entries whose destination the relayer controls.
    #[serde(with = "alloy_serde::quantity")]
    pub collectible_qualifying_actions: u64,
    /// Every selected type `0x00` entry; each dilutes the block's issuance.
    #[serde(with = "alloy_serde::quantity")]
    pub selected_qualifying_actions: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub batch_bytes: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub head_checked_block: u64,
    pub head_checked_block_hash: B256,
}

/// `pcash_checkRawTransaction` — what the next block would do with exact
/// transaction bytes, checked against the current head without admitting
/// them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionCheckDto {
    pub outcome: CheckOutcomeDto,
}

/// The item's non-admission class, or the admitted transaction's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CheckOutcomeDto {
    NotAdmitted(pcash_state::ItemExclusionReason),
    Executed(pcash_state::TransactionOutcome),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputItemDto {
    #[serde(with = "alloy_serde::quantity")]
    pub output_index: u64,
    pub output_commitment: B256,
    pub origin: OutputOriginDto,
    #[serde(flatten)]
    pub material: OutputMaterialDto,
}

/// The canonical block that created an output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OutputOriginDto {
    #[serde(with = "alloy_serde::quantity")]
    pub block_number: u64,
    pub block_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub block_timestamp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutputMaterialDto {
    #[serde(rename_all = "camelCase")]
    Ordinary {
        output_data: Bytes,
        transaction_id: B256,
        #[serde(with = "alloy_serde::quantity")]
        transaction_type: u8,
        #[serde(with = "alloy_serde::quantity::opt")]
        private_value_shape: Option<u8>,
        #[serde(with = "alloy_serde::quantity")]
        output_slot: u16,
        /// `keccak256` of the creating transaction's exact bytes.
        content_hash: B256,
        /// On the `outputSlot == 0` row, every nullifier the transaction's
        /// section inserted, in input-slot order; empty on every other row.
        nullifiers: Vec<B256>,
        /// On the `outputSlot == 0` row, the transaction's arena; absent on
        /// every other row.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arena: Option<Bytes>,
    },
    System {
        payout: PayoutOutputDto,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputTargetDto {
    pub block: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub output_count: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OutputContinuationDto {
    #[serde(with = "alloy_serde::quantity")]
    pub from_output_index: u64,
    pub target: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub target_output_count: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub next_output_index: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPageDto {
    #[serde(with = "alloy_serde::quantity")]
    pub from_output_index: u64,
    pub target: OutputTargetDto,
    pub outputs: Vec<OutputItemDto>,
    pub continuation: Option<OutputContinuationDto>,
    pub complete: bool,
}

/// The output-tree count and root one block committed, and its append
/// frontier: one node per set bit `h` of `outputCount`, ascending, each the
/// complete subtree at height `h` and index `(outputCount >> h) - 1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFrontierDto {
    pub block: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub output_count: u64,
    pub output_root: B256,
    pub ommers: Vec<B256>,
}

/// One account write: the complete account row after the write, its tree
/// index, and the exact receive key when this write introduced it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountChangeDto {
    pub origin: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub account_index: u64,
    pub address: Address,
    pub nullifier_key_commitment: B256,
    pub account_rule_set_commitment: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub account_kind: u8,
    #[serde(with = "alloy_serde::quantity")]
    pub account_revision: u32,
    pub receive_key_hash: B256,
    pub receive_key: Option<Bytes>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountChangeTargetDto {
    pub block: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub account_count: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AccountChangeContinuationDto {
    #[serde(with = "alloy_serde::quantity")]
    pub from_block: u64,
    pub target: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub next_block: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub next_ordinal: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountChangePageDto {
    #[serde(with = "alloy_serde::quantity")]
    pub from_block: u64,
    pub target: AccountChangeTargetDto,
    pub changes: Vec<AccountChangeDto>,
    pub continuation: Option<AccountChangeContinuationDto>,
    pub complete: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessSnapshotDto {
    pub status: StatusDto,
    pub block_header: Option<BlockHeaderDto>,
    pub block: Option<WitnessSnapshotBlockDto>,
    pub accounts: Vec<AccountProofResultDto>,
    pub contracts: Vec<ContractResultDto>,
    pub outputs: Option<OutputPathsDto>,
    pub nullifiers: Option<NullifierProofsDto>,
    pub l1_logs: Vec<Option<L1LogProofDto>>,
}

/// Current block identity and L1 origin used by witness consumers.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessSnapshotBlockDto {
    #[serde(with = "alloy_serde::quantity")]
    pub number: u64,
    pub hash: B256,
    pub l1_origin: L1OriginDto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PayoutCursorDto {
    pub anchor: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub next_block: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub next_payout_index: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutRecordDto {
    /// Provenance tagged by `kind`: `designatedIssuance` or `posterPayout`.
    pub source: pcash_state::PayoutSource,
    pub component: pcash_state::PayoutComponent,
    pub amount: U256,
    pub owner_commitment: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub output_index: u64,
    pub contexts: Vec<B256>,
}

impl From<pcash_state::PayoutRecord> for PayoutRecordDto {
    fn from(payout: pcash_state::PayoutRecord) -> Self {
        Self {
            source: payout.source,
            component: payout.component,
            amount: payout.amount,
            owner_commitment: payout.owner_commitment,
            output_index: payout.output_index,
            contexts: payout.contexts,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutScanRecordDto {
    #[serde(with = "alloy_serde::quantity")]
    pub block_number: u64,
    pub block_hash: B256,
    #[serde(flatten)]
    pub payout: PayoutOutputDto,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutPageDto {
    #[serde(with = "alloy_serde::quantity")]
    pub at_block_number: u64,
    pub at_block_hash: B256,
    pub records: Vec<PayoutScanRecordDto>,
    pub next_cursor: Option<PayoutCursorDto>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuanceParentDto {
    #[serde(with = "alloy_serde::quantity")]
    pub block_number: u64,
    pub block_hash: B256,
    #[serde(with = "alloy_serde::quantity")]
    pub timestamp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuanceQuoteDto {
    pub parent: IssuanceParentDto,
    #[serde(with = "alloy_serde::quantity")]
    pub candidate_timestamp: u64,
    pub supply_cap: U256,
    pub issued_so_far: U256,
    pub baseline: U256,
    pub internal_offer: U256,
    pub block_allowance: U256,
    pub max_single_action_reward: U256,
    /// The lag multiplier applied to the baseline, scaled by 2^128.
    pub multiplier_q: U256,
    /// The parent's post-settlement lag in seconds, scaled by 2^128.
    pub lag_q: I256,
    pub exhausted: bool,
    pub reward_possible: bool,
}

/// One bucket of consecutive PCASH blocks from the derived index's economics
/// series. Totals sum over the bucket; rates and lag are the last block's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockEconomicsRecordDto {
    #[serde(with = "alloy_serde::quantity")]
    pub first_block: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub last_block: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub first_timestamp: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub last_timestamp: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub blocks: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub qualifying_actions: u64,
    pub issuance_total: U256,
    pub open_fees_total: U256,
    pub reward_each: U256,
    pub baseline: U256,
    pub internal_offer: U256,
    pub block_allowance: U256,
    pub lag_q: I256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockEconomicsPageDto {
    #[serde(with = "alloy_serde::quantity")]
    pub at_block_number: u64,
    pub at_block_hash: B256,
    pub records: Vec<BlockEconomicsRecordDto>,
    /// The first block of the next bucket to request, or `None` at the head.
    #[serde(with = "alloy_serde::quantity::opt")]
    pub next_block: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutOutputDto {
    pub transaction_id: Option<B256>,
    #[serde(flatten)]
    pub payout: PayoutRecordDto,
}
