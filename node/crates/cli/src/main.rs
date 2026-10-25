//! `pcash-cli` — a command-line client for the node's `pcash_*` JSON-RPC
//! namespace and its operator-only `admin_*` namespace (both served by
//! `node/crates/rpc`).
//!
//! One subcommand per RPC endpoint. Peer management and operator source
//! publication use the admin listener on `--admin-url`, which the node binds
//! only with `--admin-addr`. Each prints a decoded,
//! human-readable rendering of the response; `--json` prints the JSON `result`
//! instead. Neither the request encoding nor the response decoding lives here:
//! `pcash-rpc`'s typed client owns both, so this crate parses arguments and
//! renders answers and nothing else.
//!
//! `p2p-key` is the exception that contacts nothing: it reads and writes the
//! node's identity file directly, so an operator can provision a key before a
//! node's first start and identify one afterwards. `pcash-p2p` owns that file's
//! format there, exactly as `pcash-rpc` owns the wire.

#![allow(
    clippy::expect_used,
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "the CLI intentionally prints user-facing command output"
)]

mod args;
mod render;

use std::time::Duration;

use alloy_primitives::B256;
use clap::{Parser, Subcommand};
use eyre::{bail, Result};
use pcash_p2p::Multiaddr;
use pcash_pscan::api::PscanClientClient;
use pcash_pscan::dto::{SourceVerificationPublication, SubmittedSourceEnvelope};
use pcash_rpc::catalog::{namespace_is_valid, MARKETPLACE_NAMESPACE};
use pcash_rpc::{
    AccountChangesQuery, AccountHistoryQuery, AdminClient, AdminRpcClient, BlockId,
    BlockRangeQuery, BlockTag, CatalogGetQuery, CatalogListQuery, ContractsQuery, FeeEstimateQuery,
    L1DeliveryBatchesQuery, MempoolQuery, OutputQuery, PcashApiClient, PcashClient,
    PrepareRelayQuery, ReceiptQuery, SubmissionQuery, TransactionKind, TransactionsQuery,
    WitnessSnapshotQuery,
};
use serde_json::Value;

#[derive(Parser, Debug)]
#[command(
    name = "pcash-cli",
    about = "Command-line client for the node's pcash_* JSON-RPC",
    version
)]
struct Cli {
    /// Node RPC endpoint (matches the node's PCASH_RPC_ADDR default).
    #[arg(
        long,
        env = "PCASH_RPC_URL",
        default_value = "http://127.0.0.1:8645",
        global = true
    )]
    rpc_url: String,

    /// Operator-only admin endpoint, used by the peer subcommands and by
    /// `publish-source-verification`. This is a different socket from
    /// --rpc-url: the node binds it to loopback by default.
    #[arg(
        long,
        env = "PCASH_ADMIN_URL",
        default_value = "http://127.0.0.1:8647",
        global = true
    )]
    admin_url: String,

    /// Dedicated contract source-verification endpoint, used by the source
    /// subcommands. The node serves `pscan_*` only when started with
    /// --pscan-addr. 8648 keeps RPC 8645 / P2P 8646 / admin-docs 8647 /
    /// pscan 8648 apart.
    #[arg(
        long,
        env = "PCASH_PSCAN_URL",
        default_value = "http://127.0.0.1:8648",
        global = true
    )]
    pscan_url: String,

    /// Emit the JSON `result` instead of decoded, human-readable output.
    #[arg(long, global = true)]
    json: bool,

    /// Per-request HTTP timeout, in seconds.
    #[arg(long, default_value_t = 30, global = true)]
    timeout: u64,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// pcash_status — canonical boundary, index, derivation, and fork status.
    Status,

    /// pcash_getIssuanceQuote — estimate the next issuance at an explicit L1 timestamp.
    GetIssuanceQuote { candidate_timestamp: String },

    /// pcash_getPayouts — canonical system-note discovery records.
    GetPayouts {
        #[arg(default_value = "{}")]
        request: String,
    },

    /// pcash_getBlockEconomics — bucketed per-block issuance economics from the derived index.
    GetBlockEconomics {
        #[arg(default_value = "{}")]
        request: String,
    },

    /// pcash_getBlockHeader — current or retained PCASH block header.
    GetBlockHeader {
        /// PCASH block number or 32-byte block hash, or `latest` when omitted.
        #[arg(long)]
        block: Option<String>,
    },

    /// pcash_getAccount — the §5 user/contract account at an address.
    GetAccount {
        /// 20-byte address.
        address: String,
    },

    /// pcash_getContract — §12.4 decoded type-2 smart-contract data.
    GetContract {
        /// 20-byte address.
        address: String,
    },

    /// pcash_sourceVerificationInfo — optional operator source-registry status.
    SourceVerificationInfo,

    /// pcash_getContractSource — contract-wide source-correspondence view.
    GetContractSource {
        /// 20-byte contract address.
        address: String,
    },

    /// pcash_getImplementationSource — source index and Noir proving ABI.
    GetImplementationSource {
        /// 32-byte application VK hash.
        application_vk_hash: String,
    },

    /// pcash_getImplementationSourceFile — one published source file.
    GetImplementationSourceFile {
        /// 32-byte application VK hash.
        application_vk_hash: String,
        /// Relative source path from the implementation source index.
        path: String,
    },

    /// pcash_getContractSourceBundle — self-contained reproducible contract bundle.
    GetContractSourceBundle {
        /// 20-byte contract address.
        address: String,
    },

    /// pscan_submitContractSource — permissionless submission of a source bundle.
    SubmitContractSource {
        /// JSON file containing the submitted-source envelope object.
        envelope_file: std::path::PathBuf,
    },

    /// pcash_getAccountProof — unified account opening for an occupied address.
    GetAccountProof {
        /// 20-byte address.
        address: String,
    },

    /// pcash_getOutputPath — single output-tree opening for an output index.
    GetOutputPath {
        /// Output index (< 2^40), decimal or 0x-hex.
        output_index: String,
    },

    /// pcash_getOutputPaths — up to 64 output openings against one root snapshot.
    GetOutputPaths {
        /// Output indices (<= 64), decimal or 0x-hex.
        #[arg(required = true, num_args = 1..)]
        output_indices: Vec<String>,
    },

    /// pcash_getWitnessSnapshot — witnesses from one current canonical snapshot.
    GetWitnessSnapshot {
        /// Exact JSON query object; omitted lists request no witnesses.
        #[arg(default_value = "{}")]
        request: String,
    },

    /// pcash_getL1OriginProof — depth-40 L1 origin membership opening.
    GetL1OriginProof {
        /// Canonical nonzero recent PCASH block hash.
        block_hash: String,
        /// Ethereum block number, decimal or 0x-hex.
        l1_block_number: String,
    },

    /// pcash_getL1LogProof — authenticated normalized L1 log opening.
    GetL1LogProof {
        /// Canonical nonzero recent PCASH block hash.
        block_hash: String,
        /// Ethereum block number, decimal or 0x-hex.
        l1_block_number: String,
        /// Transaction index within the Ethereum block, decimal or 0x-hex.
        transaction_index: String,
        /// Log index within that transaction's receipt, decimal or 0x-hex.
        log_index: String,
    },

    /// pcash_getHistoryProof — depth-40 historical PCASH block membership opening.
    GetHistoryProof {
        /// Canonical nonzero recent PCASH block hash.
        block_hash: String,
        /// Historical PCASH block number, decimal or 0x-hex.
        historical_block_number: String,
    },

    /// pcash_getBlockByNumber — one canonical block and its transaction bodies.
    GetBlockByNumber {
        /// L2 height (0 = genesis), decimal or 0x-hex.
        height: String,
    },

    /// pcash_getBlockByHash — one canonical block and its transaction bodies.
    GetBlockByHash {
        /// Canonical PCASH block hash.
        hash: String,
    },

    /// pcash_getBlocks — derived block summaries for an inclusive L2-height range.
    GetBlocks {
        /// First L2 height (default genesis).
        #[arg(long)]
        from: Option<String>,
        /// Last L2 height (default current tip).
        #[arg(long)]
        to: Option<String>,
    },

    /// pcash_getTransactions — newest-first canonical transaction page.
    GetTransactions {
        /// Exact JSON query object.
        #[arg(default_value = "{}")]
        request: String,
    },

    /// pcash_getTransaction — exact accepted bytes and canonical inclusion attempts.
    GetTransaction {
        /// 32-byte transaction id.
        tx_id: String,
    },

    /// pcash_getSubmission — inclusions sharing one exact content hash.
    GetSubmission {
        /// Exact JSON query object.
        request: String,
    },

    /// pcash_getAccountHistory — account lifecycle transactions.
    GetAccountHistory {
        /// Exact JSON query object.
        request: String,
    },

    /// pcash_getTransactionByNullifier — successful consuming transaction.
    GetTransactionByNullifier { nullifier: String },

    /// pcash_getL1DeliveryBatches — one page of the delivery manifests of one L1 transaction's carriers.
    GetL1DeliveryBatches {
        /// Exact JSON request object containing l1TransactionHash, continuation, and limits.
        request: String,
    },

    /// pcash_getBlockPayouts — the block's open-fee and issuance payouts.
    GetBlockPayouts {
        /// Exact JSON BlockId object.
        request: String,
    },

    /// pcash_estimateFee — public open fee to declare before submitting an entry.
    EstimateFee {
        /// Exact JSON query object, e.g. `{"kind":"privateValue"}`.
        request: String,
    },

    /// pcash_getContracts — newest-first immutable contract creations.
    GetContracts {
        /// Exact JSON query object.
        #[arg(default_value = "{}")]
        request: String,
    },

    /// pcash_areNullifiersSpent — batch double-spend check; one bool per input.
    AreNullifiersSpent {
        /// 32-byte nullifiers.
        #[arg(required = true, num_args = 1..)]
        nullifiers: Vec<String>,
    },

    /// pcash_getNullifierProofs — membership or absence proofs at one boundary.
    GetNullifierProofs {
        /// Canonical nonzero BN254 nullifiers (maximum 256).
        #[arg(required = true, num_args = 1..)]
        nullifiers: Vec<String>,
    },

    /// pcash_getOutputs — opaque output data in output-tree order.
    GetOutputs {
        /// Exact JSON request object containing fromOutputIndex, target, continuation, and limits.
        request: String,
    },

    /// pcash_getOutputFrontier — output count, root, and append frontier at one block.
    GetOutputFrontier {
        /// Exact JSON BlockId object.
        request: String,
    },

    /// pcash_getAccountChanges — every account write in canonical order.
    GetAccountChanges {
        /// Exact JSON request object containing fromBlock, target, continuation, and limits.
        request: String,
    },

    /// pcash_getReceipt — look up inclusion receipts by one of the receipt query keys.
    GetReceipt(ReceiptArgs),

    /// pcash_getMempool — this node's local (non-consensus) mempool view.
    GetMempool {
        /// Exclusive-lower-bound cursor (32-byte content hash from a prior page).
        #[arg(long)]
        cursor: Option<String>,
        /// Max items to return.
        #[arg(long)]
        limit: Option<String>,
        /// Filter by transaction kind (for example, privateValue or contractAccount).
        #[arg(long)]
        kind: Option<String>,
        /// Minimum public open fee in PCASH-wei (decimal or 0x-hex).
        #[arg(long)]
        min_open_fee: Option<String>,
    },

    /// pcash_getMempoolTransaction — one queued transaction by its raw-entry hash.
    GetMempoolTransaction {
        /// 32-byte content hash of the exact transaction bytes.
        content_hash: String,
    },

    /// pcash_submitRawTransaction — admit exact encoded entry bytes to the queue.
    SubmitRawTransaction {
        /// Raw transaction hex (0x-prefixed). Mutually exclusive with --file.
        #[arg(required_unless_present = "file")]
        hex: Option<String>,
        /// Read the raw transaction hex from a file instead of the argument.
        #[arg(long, conflicts_with = "hex")]
        file: Option<std::path::PathBuf>,
    },

    /// pcash_prepareRelay — assemble a current-head-checked L1 batch for a relayer.
    PrepareRelay {
        /// Transaction content hashes to include (repeat --content-hash; <= 64).
        #[arg(long = "content-hash", required = true, num_args = 1..)]
        content_hashes: Vec<String>,
        /// Designated issuance commitments this relayer controls.
        #[arg(long = "controlled-issuance-owner-commitment")]
        controlled_issuance_owner_commitments: Vec<String>,
        /// Exact raw-entry content hashes whose designated issuance this relayer controls.
        #[arg(long = "controlled-issuance-content-hash")]
        controlled_issuance_content_hashes: Vec<String>,
        /// Maximum calldata size, in bytes (decimal or 0x-hex).
        #[arg(long)]
        max_batch_bytes: String,
    },

    /// pcash_catalogInfo — optional publication catalog status, policy, limits.
    CatalogInfo,

    /// pcash_catalogList — one page of catalog records for a namespace.
    CatalogList {
        /// Namespace to list.
        #[arg(long, default_value = MARKETPLACE_NAMESPACE)]
        namespace: String,
        /// Exclusive-lower-bound cursor (32-byte content id from a prior page).
        #[arg(long)]
        cursor: Option<String>,
        /// Max records to return.
        #[arg(long)]
        limit: Option<String>,
    },

    /// pcash_catalogGet — one catalog record by content id, or null.
    CatalogGet {
        /// 32-byte content id.
        content_id: String,
        /// Namespace holding the record.
        #[arg(long, default_value = MARKETPLACE_NAMESPACE)]
        namespace: String,
    },

    /// pcash_catalogPublish — store one record. The content id is computed here
    /// from the node's chain id, so no hashing is needed by hand.
    CatalogPublish {
        /// File holding the exact payload bytes (read verbatim, never parsed).
        #[arg(long)]
        payload_file: std::path::PathBuf,
        /// Namespace to publish under.
        #[arg(long, default_value = MARKETPLACE_NAMESPACE)]
        namespace: String,
    },

    /// admin_nodeInfo — this node's peer id and the address to give another
    /// node's `add-peer`. Needs --admin-url.
    NodeInfo,

    /// admin_peers — connected peers with addresses, uptime, traffic, and
    /// scores. Needs --admin-url.
    Peers,

    /// admin_addPeer — dial a peer and keep it in the redial set. Needs
    /// --admin-url.
    AddPeer {
        /// Multiaddress ending in /p2p/<peer-id>, as `node-info` reports.
        address: String,
    },

    /// admin_removePeer — disconnect a peer and drop it from the redial set.
    /// Needs --admin-url.
    RemovePeer {
        peer_id: String,
        /// Also refuse the peer for the ban duration, rather than only
        /// disconnecting it.
        #[arg(long)]
        ban: bool,
    },

    /// admin_publishSourceVerification — validate and persist a self-contained
    /// operator publication. Needs --admin-url.
    PublishSourceVerification {
        /// JSON file containing the publication request object.
        publication_file: std::path::PathBuf,
    },

    /// Work on a P2P identity file directly. No node and no network: these
    /// commands read and write `$PCASH_DATA_DIR/p2p_identity.pb` themselves.
    P2pKey {
        #[command(subcommand)]
        action: P2pKeyCommand,
    },
}

/// The node's P2P identity is not disposable state: other operators dial the
/// peer id derived from it, and peer reputation is scored against it. These two
/// commands let an operator provision one before a node's first start, and find
/// out what a key file on a host actually is — without a running node, and
/// without the private half ever being rendered.
#[derive(Subcommand, Debug)]
enum P2pKeyCommand {
    /// Mint a new Ed25519 identity file (owner-readable only) and report it.
    Generate {
        /// Where to write the key. The node reads `$PCASH_DATA_DIR/p2p_identity.pb`.
        #[arg(long)]
        out: std::path::PathBuf,
        /// Replace an existing key. This retires the node's network identity:
        /// its peer id changes, its reputation with every peer is gone, and the
        /// bootnode address other operators hold stops matching.
        #[arg(long)]
        force: bool,
        /// Also print the bootnode address this key makes, for a transport
        /// multiaddr with no `/p2p/` suffix (as --p2p-advertise-addr takes).
        #[arg(long)]
        addr: Option<String>,
    },

    /// Report everything public about an existing identity file.
    Inspect {
        /// The key file to read. Never created: a mistyped path is an error.
        path: std::path::PathBuf,
        /// Also print the bootnode address this key makes, for a transport
        /// multiaddr with no `/p2p/` suffix (as --p2p-advertise-addr takes).
        #[arg(long)]
        addr: Option<String>,
    },
}

impl Command {
    /// Whether this subcommand talks to the operator-only admin listener rather
    /// than the public `pcash_*` endpoint.
    fn is_admin(&self) -> bool {
        matches!(
            self,
            Self::NodeInfo
                | Self::Peers
                | Self::AddPeer { .. }
                | Self::RemovePeer { .. }
                | Self::PublishSourceVerification { .. }
        )
    }

    /// Whether this subcommand is answered from local files, with no endpoint
    /// contacted and no client built.
    fn is_local(&self) -> bool {
        matches!(self, Self::P2pKey { .. })
    }

    /// Whether this subcommand talks to the dedicated `pscan_*` listener
    /// rather than the public `pcash_*` endpoint.
    fn is_source(&self) -> bool {
        matches!(
            self,
            Self::SourceVerificationInfo
                | Self::GetContractSource { .. }
                | Self::GetImplementationSource { .. }
                | Self::GetImplementationSourceFile { .. }
                | Self::GetContractSourceBundle { .. }
                | Self::SubmitContractSource { .. }
        )
    }
}

/// The five mutually-exclusive `pcash_getReceipt` query forms.
#[derive(clap::Args, Debug)]
struct ReceiptArgs {
    /// Look up one canonical inclusion by transaction ID.
    #[arg(long)]
    tx_id: Option<String>,
    /// Look up every canonical inclusion of exact submitted bytes.
    #[arg(long)]
    content_hash: Option<String>,
    /// Look up an accepted private-value transaction by a consumed nullifier.
    #[arg(long)]
    nullifier: Option<String>,
    /// Inclusion coordinate: L1 block hash (needs --l1-tx-index, --batch-entry-index).
    #[arg(long, requires = "l1_transaction_index", requires = "batch_item_index")]
    l1_block_hash: Option<String>,
    #[arg(long)]
    l1_transaction_index: Option<String>,
    #[arg(long)]
    batch_item_index: Option<String>,
    /// Account write: address (needs --account-revision).
    #[arg(long, requires = "account_revision")]
    address: Option<String>,
    #[arg(long)]
    account_revision: Option<String>,
}

// One invocation makes one request (two for `catalog-publish`), so a
// current-thread runtime is all the client needs.
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(err) = run().await {
        // A clean, single-line error for a CLI (`{:#}` chains causes without the
        // eyre location/backtrace block).
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    let result = if cli.command.is_local() {
        dispatch_local(&cli.command)?
    } else if cli.command.is_admin() {
        let admin = AdminClient::with_timeout(&cli.admin_url, Duration::from_secs(cli.timeout))
            .map_err(|e| eyre::eyre!("failed to connect to {}: {e}", cli.admin_url))?;
        dispatch_admin(&cli.command, &admin).await?
    } else if cli.command.is_source() {
        let http = jsonrpsee_http_client(&cli.pscan_url, cli.timeout)?;
        dispatch_source(&cli.command, &http).await?
    } else {
        let client = PcashClient::builder()
            .request_timeout(Duration::from_secs(cli.timeout))
            .build(&cli.rpc_url)
            .map_err(|e| eyre::eyre!("failed to connect to {}: {e}", cli.rpc_url))?;
        dispatch(&cli.command, &client).await?
    };

    if cli.json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        render::print_result(&result);
    }
    Ok(())
}

/// Run one subcommand and return its response as JSON.
///
/// Every arm parses its arguments into the client's types and re-encodes the
/// typed response, producing the same JSON the server `encode()`s from the same
/// type. That is what `--json` prints and what the renderer walks, so neither
/// output is a restatement maintained separately from the response — but it is
/// a round trip through the typed shape, not the raw HTTP body: key order is
/// the map order of a `serde_json::Value`, and a field these types do not know
/// about would be dropped.
async fn dispatch(command: &Command, client: &PcashClient) -> Result<Value> {
    use args::{address_arg, bytes_arg, hash_arg, u256_arg, u64_arg};

    Ok(match command {
        Command::Status => wire(&client.status().await?),
        Command::GetIssuanceQuote {
            candidate_timestamp,
        } => wire(
            &client
                .get_issuance_quote(pcash_rpc::request::IssuanceQuoteQuery {
                    candidate_timestamp: u64_arg(candidate_timestamp)?,
                })
                .await?,
        ),
        Command::GetPayouts { request } => {
            wire(&client.get_payouts(serde_json::from_str(request)?).await?)
        }
        Command::GetBlockEconomics { request } => wire(
            &client
                .get_block_economics(serde_json::from_str(request)?)
                .await?,
        ),
        Command::GetBlockHeader { block } => {
            let tag = match block.as_deref() {
                None | Some("latest") => BlockTag::Latest,
                Some(value) if value.len() == 66 && value.starts_with("0x") => {
                    BlockTag::Hash(hash_arg(value)?)
                }
                Some(value) => BlockTag::Number(u64_arg(value)?),
            };
            wire(&client.get_block_header(tag).await?)
        }
        Command::GetAccount { address } => wire(&client.get_account(address_arg(address)?).await?),
        Command::GetContract { address } => {
            wire(&client.get_contract(address_arg(address)?).await?)
        }
        Command::GetAccountProof { address } => {
            wire(&client.get_account_proof(address_arg(address)?).await?)
        }
        Command::GetOutputPath { output_index } => {
            wire(&client.get_output_path(u64_arg(output_index)?).await?)
        }
        Command::GetOutputPaths { output_indices } => {
            let indices = output_indices
                .iter()
                .map(|value| u64_arg(value))
                .collect::<Result<Vec<_>>>()?;
            wire(&client.get_output_paths(indices).await?)
        }
        Command::GetWitnessSnapshot { request } => {
            let query: WitnessSnapshotQuery = serde_json::from_str(request).map_err(|error| {
                eyre::eyre!("witness-snapshot request must be a JSON object: {error}")
            })?;
            wire(&client.get_witness_snapshot(query).await?)
        }
        Command::GetL1OriginProof {
            block_hash,
            l1_block_number,
        } => wire(
            &client
                .get_l1_origin_proof(hash_arg(block_hash)?, u64_arg(l1_block_number)?)
                .await?,
        ),
        Command::GetL1LogProof {
            block_hash,
            l1_block_number,
            transaction_index,
            log_index,
        } => wire(
            &client
                .get_l1_log_proof(
                    hash_arg(block_hash)?,
                    u64_arg(l1_block_number)?,
                    u64_arg(transaction_index)?,
                    u64_arg(log_index)?,
                )
                .await?,
        ),
        Command::GetHistoryProof {
            block_hash,
            historical_block_number,
        } => wire(
            &client
                .get_history_proof(hash_arg(block_hash)?, u64_arg(historical_block_number)?)
                .await?,
        ),
        Command::GetBlockByNumber { height } => {
            wire(&client.get_block_by_number(u64_arg(height)?, true).await?)
        }
        Command::GetBlockByHash { hash } => {
            wire(&client.get_block_by_hash(hash_arg(hash)?, true).await?)
        }
        Command::GetBlocks { from, to } => {
            let range = BlockRangeQuery {
                from_block: from.as_deref().map(u64_arg).transpose()?,
                to_block: to.as_deref().map(u64_arg).transpose()?,
                full_transactions: false,
            };
            wire(&client.get_blocks(range).await?)
        }
        Command::GetTransactions { request } => {
            let query: TransactionsQuery = serde_json::from_str(request).map_err(|error| {
                eyre::eyre!("transactions request must be a JSON object: {error}")
            })?;
            wire(&client.get_transactions(query).await?)
        }
        Command::GetTransaction { tx_id } => wire(&client.get_transaction(hash_arg(tx_id)?).await?),
        Command::GetSubmission { request } => {
            let query: SubmissionQuery = serde_json::from_str(request).map_err(|error| {
                eyre::eyre!("submission request must be a JSON object: {error}")
            })?;
            wire(&client.get_submission(query).await?)
        }
        Command::GetAccountHistory { request } => {
            let query: AccountHistoryQuery = serde_json::from_str(request).map_err(|error| {
                eyre::eyre!("account-history request must be a JSON object: {error}")
            })?;
            wire(&client.get_account_history(query).await?)
        }
        Command::GetTransactionByNullifier { nullifier } => wire(
            &client
                .get_transaction_by_nullifier(hash_arg(nullifier)?)
                .await?,
        ),
        Command::GetL1DeliveryBatches { request } => {
            let query: L1DeliveryBatchesQuery = serde_json::from_str(request).map_err(|error| {
                eyre::eyre!("delivery batch request must be a JSON object: {error}")
            })?;
            wire(&client.get_l1_delivery_batches(query).await?)
        }
        Command::GetBlockPayouts { request } => {
            let block: BlockId = serde_json::from_str(request)
                .map_err(|error| eyre::eyre!("block id must be a JSON object: {error}"))?;
            wire(&client.get_block_payouts(block).await?)
        }
        Command::EstimateFee { request } => {
            let query: FeeEstimateQuery = serde_json::from_str(request).map_err(|error| {
                eyre::eyre!("fee estimate request must be a JSON object: {error}")
            })?;
            wire(&client.estimate_fee(query).await?)
        }
        Command::GetContracts { request } => {
            let query: ContractsQuery = serde_json::from_str(request)
                .map_err(|error| eyre::eyre!("contracts request must be a JSON object: {error}"))?;
            wire(&client.get_contracts(query).await?)
        }
        Command::AreNullifiersSpent { nullifiers } => {
            wire(&client.are_nullifiers_spent(hashes(nullifiers)?).await?)
        }
        Command::GetNullifierProofs { nullifiers } => {
            wire(&client.get_nullifier_proofs(hashes(nullifiers)?).await?)
        }
        Command::GetOutputs { request } => {
            let request: OutputQuery = serde_json::from_str(request)
                .map_err(|error| eyre::eyre!("output request must be a JSON object: {error}"))?;
            wire(&client.get_outputs(request).await?)
        }
        Command::GetOutputFrontier { request } => {
            let block: BlockId = serde_json::from_str(request)
                .map_err(|error| eyre::eyre!("block id must be a JSON object: {error}"))?;
            wire(&client.get_output_frontier(block).await?)
        }
        Command::GetAccountChanges { request } => {
            let request: AccountChangesQuery = serde_json::from_str(request).map_err(|error| {
                eyre::eyre!("account change request must be a JSON object: {error}")
            })?;
            wire(&client.get_account_changes(request).await?)
        }
        Command::GetReceipt(query) => wire(&client.get_receipt(receipt_query(query)?).await?),
        Command::GetMempool {
            cursor,
            limit,
            kind,
            min_open_fee,
        } => {
            let query = MempoolQuery {
                cursor: cursor.as_deref().map(hash_arg).transpose()?,
                limit: limit.as_deref().map(u64_arg).transpose()?,
                kind: kind.as_deref().map(transaction_kind).transpose()?,
                min_open_fee: min_open_fee.as_deref().map(u256_arg).transpose()?,
                ..MempoolQuery::default()
            };
            wire(&client.get_mempool(query).await?)
        }
        Command::GetMempoolTransaction { content_hash } => wire(
            &client
                .get_mempool_transaction(hash_arg(content_hash)?)
                .await?,
        ),
        Command::SubmitRawTransaction { hex, file } => {
            let raw = match (hex, file) {
                (Some(value), _) => value.clone(),
                (None, Some(path)) => std::fs::read_to_string(path)
                    .map_err(|e| eyre::eyre!("failed to read {}: {e}", path.display()))?
                    .trim()
                    .to_owned(),
                (None, None) => bail!("provide the raw transaction hex or --file"),
            };
            wire(&client.submit_raw_transaction(bytes_arg(&raw)?).await?)
        }
        Command::PrepareRelay {
            content_hashes,
            controlled_issuance_owner_commitments,
            controlled_issuance_content_hashes,
            max_batch_bytes,
        } => {
            let request = PrepareRelayQuery {
                content_hashes: hashes(content_hashes)?,
                controlled_issuance_owner_commitments: hashes(
                    controlled_issuance_owner_commitments,
                )?,
                controlled_issuance_content_hashes: hashes(controlled_issuance_content_hashes)?,
                max_batch_bytes: u64_arg(max_batch_bytes)?,
            };
            wire(&client.prepare_relay(request).await?)
        }
        Command::CatalogInfo => wire(&client.catalog_info().await?),
        Command::CatalogGet {
            content_id,
            namespace,
        } => {
            let query = CatalogGetQuery {
                namespace: valid_namespace(namespace)?,
                content_id: hash_arg(content_id)?,
            };
            wire(&client.catalog_get(query).await?)
        }
        Command::CatalogList {
            namespace,
            cursor,
            limit,
        } => {
            let query = CatalogListQuery {
                namespace: valid_namespace(namespace)?,
                cursor: cursor.as_deref().map(hash_arg).transpose()?,
                limit: limit.as_deref().map(u64_arg).transpose()?,
            };
            wire(&client.catalog_list(query).await?)
        }
        // Publishing is two round trips: the content id commits to the node's
        // chain id, so the client reads `pcash_catalogInfo` first.
        Command::CatalogPublish {
            payload_file,
            namespace,
        } => {
            let payload = std::fs::read(payload_file)
                .map_err(|e| eyre::eyre!("failed to read {}: {e}", payload_file.display()))?;
            wire(&client.publish_catalog_artifact(namespace, payload).await?)
        }
        // Handled by `dispatch_admin` against the operator-only listener.
        Command::NodeInfo
        | Command::Peers
        | Command::AddPeer { .. }
        | Command::RemovePeer { .. }
        | Command::PublishSourceVerification { .. } => {
            unreachable!("admin subcommands are routed to the admin endpoint")
        }
        // Handled by `dispatch_local`, which contacts nothing.
        Command::P2pKey { .. } => {
            unreachable!("local subcommands make no request")
        }
        _ => unreachable!("source subcommands are dispatched against --pscan-url"),
    })
}

/// Run one `admin_*` subcommand against the operator-only listener.
async fn dispatch_admin(command: &Command, admin: &AdminClient) -> Result<Value> {
    Ok(match command {
        Command::NodeInfo => wire(&admin.node_info().await?),
        Command::Peers => wire(&admin.peers().await?),
        Command::AddPeer { address } => wire(&admin.add_peer(address.clone()).await?),
        Command::RemovePeer { peer_id, ban } => {
            wire(&admin.remove_peer(peer_id.clone(), *ban).await?)
        }
        // Parsed into the publication type here so a malformed file fails
        // before a request is built; the admin namespace carries it as JSON.
        Command::PublishSourceVerification { publication_file } => {
            let publication: SourceVerificationPublication =
                serde_json::from_slice(&std::fs::read(publication_file).map_err(|error| {
                    eyre::eyre!("failed to read {}: {error}", publication_file.display())
                })?)
                .map_err(|error| eyre::eyre!("source publication must be valid JSON: {error}"))?;
            wire(
                &admin
                    .publish_source_verification(serde_json::to_value(&publication)?)
                    .await?,
            )
        }
        _ => unreachable!("non-admin subcommands are routed to the pcash endpoint"),
    })
}

/// Run one subcommand that is answered from local files.
///
/// The result is a `Value` like the two network dispatchers return, so `--json`
/// and the human renderer both work on it unchanged. Every field here is public
/// by construction: `pcash-p2p` hands back an `IdentityFileInfo`, which has no
/// accessor for the private half of the key, so this function could not print
/// key material even by mistake.
fn dispatch_local(command: &Command) -> Result<Value> {
    let Command::P2pKey { action } = command else {
        unreachable!("network subcommands are routed to an endpoint")
    };

    Ok(match action {
        P2pKeyCommand::Generate { out, force, addr } => {
            let transport = transport_addr(addr.as_deref())?;
            let generated = pcash_p2p::generate_identity_file(out, *force).map_err(|error| {
                // The common case is not a broken filesystem, it is an operator
                // pointing at a key that already exists — so say what that key
                // is and what replacing it would cost, rather than "os error 17".
                if already_exists(&error) {
                    return eyre::eyre!(
                        "{} already holds a key; inspect it with `p2p-key inspect {}`, or pass \
                         --force to replace it and retire that peer id",
                        out.display(),
                        out.display()
                    );
                }
                eyre::eyre!("failed to write {}: {error}", out.display())
            })?;
            let mut fields = identity_fields(&generated.info, transport.as_ref());
            if let Some(replaced) = generated.replaced {
                fields.insert("replacedPeerId".into(), replaced.to_string().into());
            }
            Value::Object(fields)
        }
        P2pKeyCommand::Inspect { path, addr } => {
            let transport = transport_addr(addr.as_deref())?;
            let info = pcash_p2p::inspect_identity_file(path)
                .map_err(|error| eyre::eyre!("failed to read {}: {error}", path.display()))?;
            // A private key the whole host can read is worth saying out loud,
            // not just recording in a field the operator may not be reading.
            if info.insecure_permissions() {
                eprintln!(
                    "warning: {} is readable by group or other; chmod 600 {}",
                    path.display(),
                    path.display()
                );
            }
            Value::Object(identity_fields(&info, transport.as_ref()))
        }
    })
}

/// The public facts of an identity file, in the same camelCase the response DTOs
/// use so the renderer treats them identically.
fn identity_fields(
    info: &pcash_p2p::IdentityFileInfo,
    transport: Option<&Multiaddr>,
) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert("peerId".into(), info.peer_id.to_string().into());
    map.insert("keyType".into(), info.key_type.clone().into());
    map.insert(
        "publicKey".into(),
        format!("0x{}", hex::encode(info.public_key)).into(),
    );
    map.insert("file".into(), info.path.display().to_string().into());
    map.insert(
        "fileSha256".into(),
        format!("0x{}", hex::encode(info.file_sha256)).into(),
    );
    map.insert(
        "filePermissions".into(),
        match info.file_mode {
            Some(mode) => format!("{mode:04o}").into(),
            None => Value::Null,
        },
    );
    map.insert(
        "insecurePermissions".into(),
        Value::Bool(info.insecure_permissions()),
    );
    if let Some(transport) = transport {
        map.insert(
            "bootstrapAddress".into(),
            pcash_p2p::bootstrap_address(transport, info.peer_id)
                .to_string()
                .into(),
        );
    }
    map
}

fn already_exists(error: &pcash_p2p::Error) -> bool {
    matches!(error, pcash_p2p::Error::IdentityIo(io)
        if io.kind() == std::io::ErrorKind::AlreadyExists)
}

/// A `--addr` transport multiaddr: what the bootnode address is built *from*,
/// so it must not already carry the `/p2p/<peer-id>` suffix this command is
/// about to append. This is the same address `--p2p-advertise-addr` takes.
fn transport_addr(addr: Option<&str>) -> Result<Option<Multiaddr>> {
    let Some(addr) = addr else {
        return Ok(None);
    };
    let parsed: Multiaddr = addr
        .parse()
        .map_err(|error| eyre::eyre!("`{addr}` is not a multiaddress: {error}"))?;
    if pcash_p2p::peer_id_of(&parsed).is_some() {
        bail!("--addr is the transport address only; drop the /p2p/<peer-id> suffix from `{addr}`");
    }
    Ok(Some(parsed))
}

/// A typed response as the node encoded it.
async fn dispatch_source<C: PscanClientClient>(command: &Command, client: &C) -> Result<Value> {
    use args::{address_arg, hash_arg};

    Ok(match command {
        Command::SourceVerificationInfo => wire(&client.source_verification_info().await?),
        Command::SubmitContractSource { envelope_file } => {
            let envelope: SubmittedSourceEnvelope =
                serde_json::from_slice(&std::fs::read(envelope_file).map_err(|error| {
                    eyre::eyre!("failed to read {}: {error}", envelope_file.display())
                })?)
                .map_err(|error| eyre::eyre!("submission envelope must be valid JSON: {error}"))?;
            wire(&client.submit_contract_source(envelope).await?)
        }
        Command::GetContractSource { address } => {
            wire(&client.get_contract_source(address_arg(address)?).await?)
        }
        Command::GetImplementationSource {
            application_vk_hash,
        } => wire(
            &client
                .get_implementation_source(hash_arg(application_vk_hash)?)
                .await?,
        ),
        Command::GetImplementationSourceFile {
            application_vk_hash,
            path,
        } => wire(
            &client
                .get_implementation_source_file(hash_arg(application_vk_hash)?, path.clone())
                .await?,
        ),
        Command::GetContractSourceBundle { address } => wire(
            &client
                .get_contract_source_bundle(address_arg(address)?)
                .await?,
        ),
        _ => bail!("command is not served by the pscan listener"),
    })
}

/// Build the JSON-RPC HTTP client for the dedicated `pscan_*` listener.
fn jsonrpsee_http_client(
    url: &str,
    timeout_secs: u64,
) -> Result<jsonrpsee::http_client::HttpClient> {
    jsonrpsee::http_client::HttpClientBuilder::default()
        .request_timeout(std::time::Duration::from_secs(timeout_secs))
        .build(url)
        .map_err(|e| eyre::eyre!("failed to connect to {url}: {e}"))
}

fn wire<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("response types serialize")
}

fn hashes(values: &[String]) -> Result<Vec<B256>> {
    values.iter().map(|value| args::hash_arg(value)).collect()
}

fn valid_namespace(namespace: &str) -> Result<String> {
    if !namespace_is_valid(namespace) {
        bail!("--namespace must match [a-z0-9][a-z0-9._-]{{0,63}}");
    }
    Ok(namespace.to_owned())
}

/// A `--kind` filter value.
///
/// The spelling comes from `TransactionKind`, so the CLI keeps no list of wire
/// names that could fall behind the node's. `unknown` is a real kind but not a
/// legal filter — the mempool admits nothing it cannot classify — so it is
/// refused here rather than sent for the node to refuse.
fn transaction_kind(kind: &str) -> Result<TransactionKind> {
    let parsed: TransactionKind = serde_json::from_value(Value::String(kind.to_owned()))
        .map_err(|_| eyre::eyre!("--kind must be one of {}", mempool_kinds().join(", ")))?;
    if !parsed.is_admissible() {
        bail!("--kind must be one of {}", mempool_kinds().join(", "));
    }
    Ok(parsed)
}

/// Every kind the mempool can hold, in wire spelling.
fn mempool_kinds() -> Vec<String> {
    [
        TransactionKind::PrivateValue,
        TransactionKind::UserAccountCreation,
        TransactionKind::UserAccountUpdate,
        TransactionKind::ContractAccount,
        TransactionKind::Unknown,
    ]
    .into_iter()
    .filter(|kind| kind.is_admissible())
    .filter_map(|kind| match serde_json::to_value(kind) {
        Ok(Value::String(name)) => Some(name),
        _ => None,
    })
    .collect()
}

/// Build the single receipt query, selecting exactly one of the five forms.
fn receipt_query(args: &ReceiptArgs) -> Result<ReceiptQuery> {
    use args::{address_arg, hash_arg, u64_arg};

    let selectors = [
        args.tx_id.is_some(),
        args.content_hash.is_some(),
        args.nullifier.is_some(),
        args.l1_block_hash.is_some(),
        args.address.is_some(),
    ];
    match selectors.iter().filter(|set| **set).count() {
        0 => bail!(
            "select one receipt query: --tx-id | --content-hash | --nullifier | \
             --l1-block-hash (+ --l1-tx-index --batch-entry-index) | --address (+ --account-revision)"
        ),
        1 => {}
        _ => bail!("the receipt query forms are mutually exclusive; pass exactly one"),
    }

    if let Some(id) = &args.tx_id {
        return Ok(ReceiptQuery::tx_id(hash_arg(id)?));
    }
    if let Some(content_hash) = &args.content_hash {
        return Ok(ReceiptQuery::content_hash(hash_arg(content_hash)?));
    }
    if let Some(nullifier) = &args.nullifier {
        return Ok(ReceiptQuery::nullifier(hash_arg(nullifier)?));
    }
    if let Some(block_hash) = &args.l1_block_hash {
        // clap `requires` guarantees the two indices are present.
        let tx_index = args
            .l1_transaction_index
            .as_ref()
            .expect("required by clap");
        let entry_index = args.batch_item_index.as_ref().expect("required by clap");
        return Ok(ReceiptQuery::inclusion(
            hash_arg(block_hash)?,
            u64_arg(tx_index)?,
            u64_arg(entry_index)?,
        ));
    }
    if let Some(address) = &args.address {
        let revision = args.account_revision.as_ref().expect("required by clap");
        let revision = u32::try_from(u64_arg(revision)?)
            .map_err(|_| eyre::eyre!("--account-revision must fit in a uint32"))?;
        return Ok(ReceiptQuery::account(address_arg(address)?, revision));
    }
    unreachable!("one selector was set")
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;

    // Pre-lowercased fixtures so the expected wire values stay obvious.
    const ADDR: &str = "0xabababababababababababababababababababab"; // 20 bytes
    const HASH_A: &str = "0x1111111111111111111111111111111111111111111111111111111111111111"; // 32 bytes

    /// What a request looks like on the wire, so a test asserts the bytes the
    /// node will read rather than an internal Rust shape.
    fn wire_of<T: serde::Serialize>(value: &T) -> Value {
        serde_json::to_value(value).unwrap()
    }

    fn empty_receipt_args() -> ReceiptArgs {
        ReceiptArgs {
            tx_id: None,
            content_hash: None,
            nullifier: None,
            l1_block_hash: None,
            l1_transaction_index: None,
            batch_item_index: None,
            address: None,
            account_revision: None,
        }
    }

    #[test]
    fn receipt_queries_select_exactly_one_form() {
        let args = ReceiptArgs {
            tx_id: Some(HASH_A.into()),
            ..empty_receipt_args()
        };
        assert_eq!(
            wire_of(&receipt_query(&args).unwrap()),
            Value::String(HASH_A.into())
        );

        let args = ReceiptArgs {
            nullifier: Some(HASH_A.into()),
            ..empty_receipt_args()
        };
        assert_eq!(
            wire_of(&receipt_query(&args).unwrap()),
            serde_json::json!({ "nullifier": HASH_A })
        );

        let args = ReceiptArgs {
            l1_block_hash: Some(HASH_A.into()),
            l1_transaction_index: Some("2".into()),
            batch_item_index: Some("0x5".into()),
            ..empty_receipt_args()
        };
        assert_eq!(
            wire_of(&receipt_query(&args).unwrap()),
            serde_json::json!({
                "inclusionId": {
                    "l1BlockHash": HASH_A,
                    "l1TransactionIndex": "0x2",
                    "batchItemIndex": "0x5",
                }
            })
        );

        let args = ReceiptArgs {
            address: Some(ADDR.into()),
            account_revision: Some("9".into()),
            ..empty_receipt_args()
        };
        assert_eq!(
            wire_of(&receipt_query(&args).unwrap()),
            serde_json::json!({ "address": ADDR, "accountRevision": "0x9" })
        );
    }

    #[test]
    fn receipt_queries_refuse_zero_or_several_forms() {
        assert!(receipt_query(&empty_receipt_args()).is_err());
        let both = ReceiptArgs {
            tx_id: Some(HASH_A.into()),
            nullifier: Some(HASH_A.into()),
            ..empty_receipt_args()
        };
        assert!(receipt_query(&both).is_err());
    }

    #[test]
    fn an_account_revision_must_fit_uint32() {
        let args = ReceiptArgs {
            address: Some(ADDR.into()),
            account_revision: Some(u64::from(u32::MAX).to_string()),
            ..empty_receipt_args()
        };
        assert!(receipt_query(&args).is_ok());

        let args = ReceiptArgs {
            address: Some(ADDR.into()),
            account_revision: Some((u64::from(u32::MAX) + 1).to_string()),
            ..empty_receipt_args()
        };
        assert!(receipt_query(&args).is_err());
    }

    #[test]
    fn mempool_kind_accepts_the_wire_names_and_nothing_else() {
        let kinds = mempool_kinds();
        assert_eq!(kinds.len(), 4, "{kinds:?}");
        for kind in &kinds {
            let parsed = transaction_kind(kind).unwrap();
            assert_eq!(wire_of(&parsed), Value::String(kind.clone()));
        }
        assert!(transaction_kind("nope").is_err());
        // The old spelling of the contract-account kind is not silently accepted.
        assert!(transaction_kind("contractAccountCreation").is_err());
        // `unknown` names a receipt kind, never a queued entry, so filtering by
        // it is refused rather than silently returning an empty page.
        assert!(transaction_kind("unknown").is_err());
        assert!(!kinds.iter().any(|kind| kind == "unknown"), "{kinds:?}");
    }

    #[test]
    fn optional_query_fields_are_omitted_rather_than_null() {
        // The node accepts either, but omitting keeps the request identical to
        // what every other client sends.
        assert_eq!(
            wire_of(&BlockRangeQuery::default()),
            serde_json::json!({ "fullTransactions": false })
        );
        assert_eq!(
            wire_of(&BlockRangeQuery {
                from_block: Some(1),
                to_block: None,
                full_transactions: false,
            }),
            serde_json::json!({ "fromBlock": "0x1", "fullTransactions": false })
        );
        assert_eq!(wire_of(&MempoolQuery::default()), serde_json::json!({}));
        assert_eq!(
            wire_of(&MempoolQuery {
                limit: Some(10),
                kind: Some(TransactionKind::PrivateValue),
                ..MempoolQuery::default()
            }),
            serde_json::json!({ "limit": "0xa", "kind": "privateValue" })
        );
    }

    #[test]
    fn namespaces_are_validated_before_a_request_is_sent() {
        assert_eq!(
            valid_namespace(MARKETPLACE_NAMESPACE).unwrap(),
            MARKETPLACE_NAMESPACE
        );
        assert!(valid_namespace("Not A Namespace").is_err());
        assert!(valid_namespace("").is_err());
    }

    #[test]
    fn prepare_relay_requests_encode_as_quantities_and_byte_strings() {
        let request = PrepareRelayQuery {
            content_hashes: vec![args::hash_arg(HASH_A).unwrap()],
            controlled_issuance_owner_commitments: vec![],
            controlled_issuance_content_hashes: vec![],
            max_batch_bytes: 256_000,
        };
        assert_eq!(
            wire_of(&request),
            serde_json::json!({
                "contentHashes": [HASH_A],
                "maxBatchBytes": "0x3e800",
            })
        );
    }
}
