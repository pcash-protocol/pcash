//! `pcash` — the node binary.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "startup and diagnostic command paths validate their prerequisites before use"
)]
//!
//! Proof rules and verification keys are compiled into the executable. Runtime
//! configuration selects the PCASH/L1 chain ids, inbox, and L1 anchor, either
//! flag by flag or as a compiled `--network` preset. Startup verifies the
//! external L1 identity/anchor, verifier release, CRS, and any persisted
//! checkpoint.

use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Address, B256};
use clap::Parser;
use eyre::Context;
use pcash_l1::{set_hash_concurrency, Follower, L1Client};
use pcash_metrics::{Metrics, NoopMetrics, PrometheusMetrics};
use pcash_node::{
    build_in_memory_node, catalog_path_for, catch_up_derived_index, follow_until_stopped,
    load_prover_assets, maintain_derived_index, mempool_path_for, release_pins, resolve_namespaces,
    resume_or_build_node_with_force_resync, run_follow_with_catchup, source_registry_path_for,
    start_p2p_with_metrics, AdmissionPool, BeaconClient, CatalogService, MempoolLimits,
    MempoolService, Network, NetworkConfig, NodeHandle, SourceVerificationService,
    DEFAULT_ADMISSION_QUEUE, DEFAULT_CATALOG_NAMESPACES, DEFAULT_INBOX, DEFAULT_MAX_BYTES,
    DEFAULT_MAX_ENTRIES, DEFAULT_MAX_UNPAID_ENTRIES, L1_CHAIN_ID, PCASH_CHAIN_ID,
};
use pcash_p2p::{
    identity_from_hex, load_or_create_identity, Keypair, Multiaddr, P2pConfig,
    MAX_INVENTORY_PAGE_IDS,
};
use pcash_state::StateDb;
use pcash_verify::BbProcessVerifier;

mod logging;

const DEV_MODE_WARNING: &str = "\
================================================================================\n\
= WARNING: PCASH DEVELOPMENT MODE IS ON                                      =\n\
= ALL NODE DATABASES ARE IN MEMORY. DATABASE DATA WILL BE LOST ON EXIT.      =\n\
= DO NOT USE THIS MODE FOR A PERSISTENT OR PRODUCTION NODE.                  =\n\
================================================================================";

/// Serves [`pcash_pscan::api::ContractIndexReader`] from this process's derived
/// index. This adapter is the node's entire coupling to the pscan listener.
struct NodeContractIndexReader {
    handle: pcash_node::NodeHandle,
}

impl pcash_pscan::api::ContractIndexReader for NodeContractIndexReader {
    fn contract_for_source(
        &self,
        address: Address,
    ) -> Result<Option<pcash_rpc::ContractDto>, String> {
        self.handle.contract_for_source(address)
    }

    fn contract_verification_changed(&self, address: Option<Address>) -> Result<(), String> {
        self.handle.contract_verification_changed(address)
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "pcash",
    about = "PCASH node (L1 follower + derivation + pcash_* RPC)"
)]
struct Cli {
    #[command(flatten)]
    logging: logging::LoggingOptions,

    /// Configured Ethereum JSON-RPC endpoint.
    #[arg(long, env = "PCASH_L1_RPC")]
    l1_rpc: String,

    /// Consensus-layer Beacon API used to retrieve EIP-4844 blobs on demand.
    #[arg(long, env = "PCASH_BEACON_API")]
    beacon_api: String,

    /// Data directory for persistent stores and the P2P identity. In development
    /// mode only the P2P identity uses this directory.
    #[arg(long, env = "PCASH_DATA_DIR")]
    data_dir: PathBuf,

    /// Run every node database in memory. All chain, index, mempool, source,
    /// and catalog data is lost when the process exits.
    #[arg(long, env = "PCASH_NODE_DEV", conflicts_with = "force_resync")]
    dev: bool,

    /// `addr:port` for the pcash_* RPC server (HTTP + WebSocket).
    #[arg(long, env = "PCASH_RPC_ADDR", default_value = "127.0.0.1:8645")]
    rpc_addr: String,

    /// Optional operator scrape address for Prometheus `/metrics`. Off when
    /// omitted. Use a loopback or operator-only bind; do not share 9464 with
    /// the relayer.
    #[arg(long, env = "PCASH_METRICS_ADDR")]
    metrics_addr: Option<String>,

    /// Optional `addr:port` for the operator-only `admin_*` RPC. Off when omitted. This is a
    /// separate socket from `--rpc-addr` on purpose — the `pcash_*` port is
    /// unauthenticated and browser-reachable by design, and dialing arbitrary
    /// addresses must not be. It is unauthenticated too, so its bind address is
    /// its access control: use loopback or an operator-only interface.
    #[arg(long, env = "PCASH_ADMIN_ADDR")]
    admin_addr: Option<String>,

    /// Named network whose chain identity, L1 anchor, and bootnodes are compiled
    /// in. Mainnet cannot start until its anchor is configured.
    /// It replaces the individual identity flags, so supplying any of them
    /// alongside it, including through the environment, is an error. The two
    /// chain ids are the exception: they may also be given when they equal the
    /// preset's, so one environment can configure the node and the website.
    #[arg(
        long,
        env = "PCASH_NETWORK",
        value_enum,
        conflicts_with_all = [
            "inbox_address",
            "genesis_l1_block",
            "genesis_l1_block_hash",
        ]
    )]
    network: Option<Network>,

    /// PCASH chain id. This is distinct from the Ethereum L1 chain id.
    /// Defaults to the local development id.
    #[arg(long, env = "PCASH_CHAIN_ID")]
    pcash_chain_id: Option<u32>,

    /// EIP-155 chain id of the Ethereum DA network and EIP-712 domain.
    /// Defaults to the local development id.
    #[arg(long, env = "PCASH_L1_CHAIN_ID")]
    l1_chain_id: Option<u64>,

    /// Inbox routing address and EIP-712 verifying contract.
    #[arg(long, env = "PCASH_INBOX_ADDRESS", default_value_t = DEFAULT_INBOX)]
    inbox_address: Address,

    /// First Ethereum block consumed by derivation.
    #[arg(
        long,
        env = "PCASH_GENESIS_L1_BLOCK",
        required_unless_present = "network"
    )]
    genesis_l1_block: Option<u64>,

    /// Exact hash of the finalized L1 anchor block.
    #[arg(
        long,
        env = "PCASH_GENESIS_L1_BLOCK_HASH",
        required_unless_present = "network"
    )]
    genesis_l1_block_hash: Option<B256>,

    /// Permit deletion/rebuild of an existing derived store when checkpoint
    /// validation or resume fails. Without this flag startup fails closed.
    #[arg(long)]
    force_resync: bool,

    /// Stream and revalidate every durable canonical block, preimage, hash
    /// index entry, and append-only root before starting services.
    #[arg(long)]
    audit_state_history: bool,

    /// Stop after deriving this L1 block (bounded/interruptible run for testing).
    #[arg(long)]
    run_until: Option<u64>,

    /// Poll interval, in seconds, when caught up to the follow tag.
    #[arg(long, env = "PCASH_POLL_SECS", default_value_t = 4)]
    poll_secs: u64,

    /// Maximum L1 JSON-RPC requests per second, shared by every L1 read,
    /// including catch-up fetches and retries. Each L1 block costs two
    /// requests (the block itself plus its receipts).
    #[arg(
        long,
        env = "PCASH_L1_RPC_MAX_REQUESTS_PER_SECOND",
        default_value_t = 30
    )]
    l1_rpc_max_requests_per_second: u32,

    /// Catch-up blocks fetched or being fetched but not yet applied. Fetch
    /// workers keep it filled at the L1 request rate.
    #[arg(
        long,
        env = "PCASH_CATCHUP_FETCH_QUEUE",
        default_value_t = pcash_node::DEFAULT_CATCHUP_FETCH_QUEUE
    )]
    catchup_fetch_queue: usize,

    /// Log-hash workers and catch-up in-flight hashes. Unset: min(available CPUs, 6).
    #[arg(long, env = "PCASH_HASH_THREADS", default_value_t = default_hash_threads())]
    hash_threads: usize,

    /// Maximum number of exact transactions retained in the local mempool.
    #[arg(long, env = "PCASH_MEMPOOL_MAX_ENTRIES", default_value_t = DEFAULT_MAX_ENTRIES)]
    mempool_max_entries: usize,

    /// Maximum aggregate exact transaction bytes retained in the local mempool.
    #[arg(long, env = "PCASH_MEMPOOL_MAX_BYTES", default_value_t = DEFAULT_MAX_BYTES)]
    mempool_max_bytes: usize,

    /// Maximum zero-open-fee non-type-0 transactions retained within the total pool.
    #[arg(long, env = "PCASH_MEMPOOL_MAX_UNPAID_ENTRIES", default_value_t = DEFAULT_MAX_UNPAID_ENTRIES)]
    mempool_max_unpaid_entries: usize,

    /// Admit proof-free user and contract account creation to the unpaid pool.
    #[arg(
        long,
        env = "PCASH_MEMPOOL_ACCEPT_UNPAID_REGISTRATION",
        default_value_t = false
    )]
    mempool_accept_unpaid_registration: bool,

    /// Mempool proof-verifier workers shared by RPC and P2P admission, each a
    /// separate `bb` process; derivation keeps its own. Unset: min(available CPUs, 4).
    #[arg(long, env = "PCASH_MEMPOOL_VERIFIERS", default_value_t = default_mempool_verifiers())]
    mempool_verifiers: usize,

    /// Admissions that may wait for a mempool verifier; a submission beyond this is refused.
    #[arg(long, env = "PCASH_MEMPOOL_ADMISSION_QUEUE", default_value_t = DEFAULT_ADMISSION_QUEUE)]
    mempool_admission_queue: usize,

    /// libp2p TCP listen multiaddress.
    #[arg(
        long,
        env = "PCASH_P2P_LISTEN",
        default_value = "/ip4/0.0.0.0/tcp/8646"
    )]
    p2p_listen: Multiaddr,

    /// Bootstrap peer multiaddress. Repeat for multiple peers.
    #[arg(long, env = "PCASH_P2P_BOOTNODES", value_delimiter = ',')]
    p2p_bootnode: Vec<Multiaddr>,

    /// Externally reachable multiaddress for this node, without the
    /// `/p2p/<peer-id>` suffix — for example `/ip4/203.0.113.7/tcp/8646`.
    ///
    /// Advertised through Identify and discovery, and reported by admin_nodeInfo.
    /// Without it, automatic reachability and relay reservations supply endpoints.
    #[arg(long, env = "PCASH_P2P_ADVERTISE_ADDR")]
    p2p_advertise_addr: Option<Multiaddr>,

    /// Automatically discover peers in this PCASH network.
    #[arg(long, env = "PCASH_P2P_DISCOVERY", value_enum, default_value = "auto")]
    p2p_discovery: ConnectivityMode,
    /// Desired compatible outbound peers, including static peers.
    #[arg(long, env = "PCASH_P2P_TARGET_PEERS", default_value_t = pcash_p2p::DEFAULT_TARGET_PEERS as u16, value_parser = clap::value_parser!(u16).range(1..=pcash_p2p::MAX_TARGET_PEERS as i64))]
    p2p_target_peers: u16,
    /// Automatic reachability detection, UPnP, relays and hole punching.
    #[arg(long, env = "PCASH_P2P_NAT", value_enum, default_value = "auto")]
    p2p_nat: ConnectivityMode,
    /// Optional relay seed; repeat for independent relay operators.
    #[arg(long, env = "PCASH_P2P_RELAYS", value_delimiter = ',')]
    p2p_relay: Vec<Multiaddr>,
    /// Serve bounded relay circuits at the advertised public TCP endpoint.
    #[arg(long, env = "PCASH_P2P_RELAY_SERVER")]
    p2p_relay_server: bool,
    /// Permit learned private/loopback endpoints on an isolated network.
    #[arg(long, env = "PCASH_P2P_ALLOW_PRIVATE_ADDRESSES")]
    p2p_allow_private_addresses: bool,

    /// This node's P2P identity: the hex of a `pcash-cli p2p-key generate` file,
    /// for a key kept in a secret store. Supply it through the environment. When
    /// set, `$PCASH_DATA_DIR/p2p_identity.pb` is neither read nor created.
    #[arg(long, env = "PCASH_P2P_IDENTITY_KEY", hide_env_values = true)]
    p2p_identity_key: Option<RedactedHex>,

    /// Disable P2P gossip and inventory sync.
    #[arg(long, env = "PCASH_DISABLE_P2P")]
    disable_p2p: bool,

    /// Optional public root for this build's versioned browser proving assets.
    /// The installed asset-set ID is appended after validating the packaged manifest.
    #[arg(
        long,
        env = "PCASH_PROVER_ASSETS_BASE_URL",
        requires = "prover_assets_manifest"
    )]
    prover_assets_base_url: Option<String>,

    /// Manifest describing the exact installed browser proving asset set.
    /// Required only when `--prover-assets-base-url` advertises asset hosting.
    #[arg(long, env = "PCASH_PROVER_ASSETS_MANIFEST")]
    prover_assets_manifest: Option<PathBuf>,

    /// Seconds between bounded inventory reconciliation rounds with connected peers.
    #[arg(long, env = "PCASH_P2P_ANTI_ENTROPY_SECS", default_value_t = 10)]
    p2p_anti_entropy_secs: u64,

    /// Enable the optional node-local publication catalog. Off by default: the
    /// database is neither opened nor created, and the catalog RPCs report
    /// `disabled`.
    #[arg(long, env = "PCASH_ENABLE_CATALOG")]
    enable_catalog: bool,

    /// Namespace the catalog accepts. Repeat for multiple namespaces.
    ///
    /// Supplying any namespace REPLACES the default namespaces, so an operator
    /// who wants them lists them. With none given, `--enable-catalog` enables
    /// `pcash.marketplace.offer.v1` and `pcash.tokens.drop.v1`.
    #[arg(
        long = "catalog-namespace",
        env = "PCASH_CATALOG_NAMESPACES",
        value_delimiter = ','
    )]
    catalog_namespaces: Vec<String>,

    /// Source-reproduction script used to validate new public source
    /// publications. When omitted or unhealthy, existing registry reads remain
    /// available but publication is disabled.
    #[arg(long, env = "PCASH_SOURCE_VERIFICATION_REPRODUCER")]
    source_verification_reproducer: Option<PathBuf>,

    /// Dedicated contract source-verification listener serving the `pscan_*`
    /// namespace (reads, operator publish, permissionless submissions). When
    /// omitted, no pscan socket is bound at all.
    #[arg(long, env = "PCASH_PSCAN_ADDR")]
    pscan_addr: Option<String>,

    /// Accept permissionless `pscan_submitContractSource` submissions on the
    /// `--pscan-addr` listener. Requires `--pscan-addr`.
    #[arg(long, env = "PCASH_ENABLE_SOURCE_SUBMISSIONS")]
    enable_source_submissions: bool,

    /// Accept permissionless configuration openings without enabling source
    /// package submission or compilation. Requires `--pscan-addr`.
    #[arg(long, env = "PCASH_ENABLE_CONFIGURATION_OPENING_SUBMISSIONS")]
    enable_configuration_opening_submissions: bool,
    /// Index message board posts and serve the `pboard_*` namespace on the
    /// `--rpc-addr` listener. The index is rebuildable and lags the node.
    #[arg(long, env = "PCASH_PBOARD")]
    pboard: bool,
}

/// Key material from the command line. It is decoded after parsing, not by clap,
/// because clap echoes a rejected value in its error; and it renders as
/// `<redacted>` so no `Debug` of the parsed command line can print it.
#[derive(Clone)]
struct RedactedHex(String);

impl std::str::FromStr for RedactedHex {
    type Err = std::convert::Infallible;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(Self(value.to_owned()))
    }
}

impl std::fmt::Debug for RedactedHex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

fn p2p_identity_key(cli: &Cli) -> eyre::Result<Option<Keypair>> {
    cli.p2p_identity_key
        .as_ref()
        .map(|key| {
            identity_from_hex(&key.0).map_err(|_| {
                eyre::eyre!("PCASH_P2P_IDENTITY_KEY is not the hex of a P2P identity file")
            })
        })
        .transpose()
}

fn load_network(cli: &Cli) -> eyre::Result<NetworkConfig> {
    if let Some(network) = cli.network {
        let config = network.config()?;
        if let Some(id) = cli.pcash_chain_id.filter(|id| *id != config.pcash_chain_id) {
            eyre::bail!(
                "--pcash-chain-id {id} does not match --network {}'s {}",
                network.name(),
                config.pcash_chain_id
            );
        }
        if let Some(id) = cli.l1_chain_id.filter(|id| *id != config.l1_chain_id) {
            eyre::bail!(
                "--l1-chain-id {id} does not match --network {}'s {}",
                network.name(),
                config.l1_chain_id
            );
        }
        return Ok(config);
    }
    let (Some(block), Some(hash)) = (cli.genesis_l1_block, cli.genesis_l1_block_hash) else {
        eyre::bail!(
            "--genesis-l1-block and --genesis-l1-block-hash are required without --network"
        );
    };
    let pcash_chain_id = cli.pcash_chain_id.unwrap_or(PCASH_CHAIN_ID);
    if pcash_chain_id == 0 {
        eyre::bail!("PCASH_CHAIN_ID must be nonzero");
    }
    Ok(NetworkConfig::new(
        pcash_chain_id,
        cli.l1_chain_id.unwrap_or(L1_CHAIN_ID),
        cli.inbox_address,
        block,
        hash,
    ))
}

/// The preset's bootnodes, then any given on the command line.
fn bootnodes(cli: &Cli) -> Vec<Multiaddr> {
    let mut bootnodes = cli.network.map(Network::bootnodes).unwrap_or_default();
    bootnodes.extend(cli.p2p_bootnode.iter().cloned());
    bootnodes
}

fn validate_genesis_l1_finality(block: u64, finalized_block: u64) -> eyre::Result<()> {
    if block > finalized_block {
        eyre::bail!(
            "genesis L1 block {block} is not finalized: RPC finalized block is {finalized_block}"
        );
    }
    Ok(())
}

fn validate_genesis_l1_hash(block: u64, expected: B256, actual: B256) -> eyre::Result<()> {
    if actual != expected {
        eyre::bail!(
            "genesis L1 block hash mismatch at {block}: expected {expected}, RPC returned {actual}"
        );
    }
    Ok(())
}

fn default_hash_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(1, NonZeroUsize::get)
        .clamp(1, 6)
}

fn default_mempool_verifiers() -> usize {
    std::thread::available_parallelism()
        .map_or(1, NonZeroUsize::get)
        .clamp(1, 4)
}

fn configured_prover_assets(
    base_url: Option<&str>,
    manifest: Option<&Path>,
) -> eyre::Result<Option<pcash_rpc::ProverAssetsDto>> {
    let Some(base_url) = base_url else {
        return Ok(None);
    };
    let manifest = manifest.ok_or_else(|| {
        eyre::eyre!(
            "--prover-assets-base-url requires --prover-assets-manifest (PCASH_PROVER_ASSETS_MANIFEST)"
        )
    })?;
    load_prover_assets(manifest, base_url)
        .wrap_err("validate configured browser prover assets")
        .map(Some)
}

#[tokio::main]
async fn main() -> eyre::Result<()> {
    let cli = Cli::parse();
    cli.logging.init();
    run_with_shutdown(move |ready, stop| run(cli, ready, stop)).await
}

async fn run_with_shutdown<F, Fut>(work: F) -> eyre::Result<()>
where
    F: FnOnce(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>) -> Fut
        + Send
        + 'static,
    Fut: std::future::Future<Output = eyre::Result<()>> + 'static,
{
    let shutdown = async move {
        #[cfg(unix)]
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .wrap_err("register SIGTERM handler")?;
        #[cfg(unix)]
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .wrap_err("register SIGINT handler")?;
        #[cfg(unix)]
        {
            tokio::select! {
                _ = terminate.recv() => Ok::<_, eyre::Report>("SIGTERM"),
                _ = interrupt.recv() => Ok::<_, eyre::Report>("SIGINT"),
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c().await?;
            Ok::<_, eyre::Report>("SIGINT")
        }
    };

    let (ready_tx, mut ready_rx) = tokio::sync::oneshot::channel();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let (startup_stop_tx, mut startup_stop_rx) = tokio::sync::watch::channel(false);
    let runtime = tokio::runtime::Handle::current();
    let mut running = tokio::task::spawn_blocking(move || {
        runtime.block_on(async move {
            tokio::select! {
                result = work(ready_tx, stop_rx) => result,
                _ = startup_stop_rx.changed() => Ok(()),
            }
        })
    });
    tokio::pin!(shutdown);
    tokio::select! {
        result = &mut running => result.wrap_err("node worker failed")?,
        signal = &mut shutdown => {
            tracing::info!(signal = signal?, "stopping PCASH node during startup");
            let _ = startup_stop_tx.send(true);
            // Await the worker before releasing startup resources.
            let _ = running.await.wrap_err("node worker failed during shutdown")?;
            Ok(())
        }
        _ = &mut ready_rx => {
            tokio::select! {
                result = &mut running => result.wrap_err("node worker failed")?,
                signal = &mut shutdown => {
                    tracing::info!(signal = signal?, "stopping PCASH node");
                    let _ = stop_tx.send(());
                    running.await.wrap_err("node worker failed during shutdown")?
                }
            }
        }
    }
}

#[cfg(unix)]
const DATA_DIR_SAMPLE_INTERVAL: Duration = Duration::from_secs(15);

/// Bytes an unprivileged process can still write to the filesystem holding `path`.
#[cfg(unix)]
fn free_bytes(path: &Path) -> std::io::Result<u64> {
    let stat = rustix::fs::statvfs(path)?;
    Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
}

/// Report the data directory's free space apart from derivation, so a node
/// halted on a full disk keeps reporting it.
#[cfg(unix)]
fn spawn_data_dir_sampler(data_dir: PathBuf, metrics: Arc<dyn Metrics>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(DATA_DIR_SAMPLE_INTERVAL);
        loop {
            tick.tick().await;
            match free_bytes(&data_dir) {
                Ok(bytes) => metrics.set_data_dir_free_bytes(bytes),
                Err(error) => {
                    tracing::warn!(%error, "could not read the data directory's free space");
                }
            }
        }
    });
}

async fn run(
    cli: Cli,
    ready: tokio::sync::oneshot::Sender<()>,
    stop: tokio::sync::oneshot::Receiver<()>,
) -> eyre::Result<()> {
    if cli.dev {
        tracing::warn!("{DEV_MODE_WARNING}");
    }
    if cli.l1_rpc_max_requests_per_second == 0 {
        eyre::bail!("PCASH_L1_RPC_MAX_REQUESTS_PER_SECOND must be positive");
    }
    if cli.hash_threads == 0 {
        eyre::bail!("PCASH_HASH_THREADS must be positive");
    }
    if cli.catchup_fetch_queue == 0 {
        eyre::bail!("PCASH_CATCHUP_FETCH_QUEUE must be positive");
    }
    set_hash_concurrency(cli.hash_threads);
    if cli.mempool_max_entries == 0
        || cli.mempool_max_bytes == 0
        || cli.mempool_max_unpaid_entries == 0
        || cli.mempool_max_unpaid_entries > cli.mempool_max_entries
    {
        eyre::bail!(
            "mempool limits must be positive and PCASH_MEMPOOL_MAX_UNPAID_ENTRIES must not exceed PCASH_MEMPOOL_MAX_ENTRIES"
        );
    }
    if cli.mempool_verifiers == 0 || cli.mempool_admission_queue == 0 {
        eyre::bail!("PCASH_MEMPOOL_VERIFIERS and PCASH_MEMPOOL_ADMISSION_QUEUE must be positive");
    }
    if cli.p2p_anti_entropy_secs == 0 {
        eyre::bail!("PCASH_P2P_ANTI_ENTROPY_SECS must be positive");
    }
    let cfg = load_network(&cli)?;
    let p2p_identity = p2p_identity_key(&cli)?;
    let prover_assets = configured_prover_assets(
        cli.prover_assets_base_url.as_deref(),
        cli.prover_assets_manifest.as_deref(),
    )?;
    let client =
        L1Client::with_max_requests_per_second(&cli.l1_rpc, cli.l1_rpc_max_requests_per_second)?;
    let beacon = Arc::new(
        BeaconClient::connect(&cli.beacon_api)
            .await
            .wrap_err("connect required Beacon API")?,
    );
    let verifier = BbProcessVerifier::from_env()?;

    // Resolve and validate every external identity input before opening state.
    let live_chain_id = client.chain_id().await.wrap_err("read L1 chain id")?;
    if live_chain_id != cfg.l1_chain_id {
        eyre::bail!(
            "L1 chain id mismatch: configured {}, RPC returned {}",
            cfg.l1_chain_id,
            live_chain_id
        );
    }
    let finalized_block = client
        .finalized_block_number()
        .await
        .wrap_err("read finalized L1 block")?;
    validate_genesis_l1_finality(cfg.genesis_l1_block, finalized_block)?;
    let anchor_header = client
        .block_header_by_number(cfg.genesis_l1_block)
        .await
        .wrap_err("read genesis L1 block")?;
    validate_genesis_l1_hash(
        cfg.genesis_l1_block,
        cfg.genesis_l1_block_hash,
        anchor_header.hash,
    )?;
    let pins = release_pins().wrap_err("read the compiled-in prover toolchain manifest")?;
    verifier.assert_release(
        pins.bb_sha256.0,
        pins.grumpkin_g1_prefix_bytes,
        pins.grumpkin_g1_prefix_sha256.0,
    )?;
    verifier.assert_known_answers()?;

    std::fs::create_dir_all(&cli.data_dir).wrap_err("create data dir")?;
    let db_path = cli.data_dir.join("state.redb");
    let mut start_plan = if cli.dev {
        build_in_memory_node(&cfg)?
    } else {
        resume_or_build_node_with_force_resync(&db_path, &cfg, &client, cli.force_resync).await?
    };
    let inner = start_plan.inner.clone();
    let mut follower_start = start_plan.follower_start;
    let mut anchor = start_plan.anchor;

    // A public genesis hash is the ordinary hash of canonical PCASH block zero,
    // so a cold node must derive the anchor block before identity-dependent
    // services start. Resume already restores block zero and the canonical tip
    // from the state database.
    if inner.lock().unwrap().state.canonical_tip().is_none() {
        run_follow_with_catchup(
            inner.clone(),
            Follower::new(client.clone(), cfg.genesis_l1_block),
            BbProcessVerifier::from_env()?,
            Some(cfg.genesis_l1_block),
            Duration::from_secs(cli.poll_secs),
            beacon.clone(),
            None,
            Arc::new(NoopMetrics),
            cli.catchup_fetch_queue,
        )
        .await
        .wrap_err("derive PCASH block zero")?;
        follower_start = cfg
            .genesis_l1_block
            .checked_add(1)
            .ok_or_else(|| eyre::eyre!("genesis L1 block number overflow"))?;
        anchor = Some(
            inner
                .lock()
                .unwrap()
                .state
                .canonical_tip()
                .expect("follow derived PCASH block zero")
                .l1_origin
                .block_hash,
        );
    }

    // A forced recovery is derived in a sibling database through an immutable
    // L1 height+hash captured before construction. No mempool, RPC, or P2P
    // service starts until the completed state file is atomically promoted.
    if let Some((target_number, target_hash)) = start_plan.replacement_target() {
        if follower_start <= target_number {
            let mut follower = Follower::new(client.clone(), follower_start);
            follower.rewind_to(follower_start, anchor);
            run_follow_with_catchup(
                inner.clone(),
                follower,
                BbProcessVerifier::from_env()?,
                Some(target_number),
                Duration::from_secs(cli.poll_secs),
                beacon.clone(),
                None,
                Arc::new(NoopMetrics),
                cli.catchup_fetch_queue,
            )
            .await
            .wrap_err("derive isolated force-resync replacement")?;
        }
        start_plan
            .promote_replacement()
            .wrap_err("promote force-resync replacement")?;
        follower_start = target_number
            .checked_add(1)
            .ok_or_else(|| eyre::eyre!("force-resync L1 target overflow"))?;
        anchor = Some(target_hash);
    }

    if cli.audit_state_history {
        inner
            .lock()
            .unwrap()
            .state
            .audit_full_history()
            .map_err(|error| eyre::eyre!("full canonical state-history audit failed: {error}"))?;
        tracing::info!("full canonical state-history audit passed");
    }

    // Externally reported PCASH chain identity, available now that block zero is derived or
    // restored. The source registry, P2P, and the optional catalog all bind to it.
    let genesis_hash = {
        let g = inner.lock().unwrap();
        g.state
            .canonical_genesis_hash()
            .expect("block zero is derived before identity-dependent services start")
    };

    let mut source_verification = if cli.dev {
        SourceVerificationService::open_in_memory(
            cfg.pcash_chain_id,
            genesis_hash,
            cli.source_verification_reproducer.clone(),
        )
    } else {
        SourceVerificationService::open(
            source_registry_path_for(&db_path),
            cfg.pcash_chain_id,
            genesis_hash,
            cli.source_verification_reproducer.clone(),
        )
    };
    if cli.enable_source_submissions {
        source_verification = source_verification.enable_source_submissions();
    }
    if cli.enable_configuration_opening_submissions {
        source_verification = source_verification.enable_configuration_opening_submissions();
    }
    let source_verification = Arc::new(source_verification);
    let source_info = source_verification.info();
    tracing::info!(
        status = ?source_info.status,
        implementations = source_info.implementation_count,
        source_submissions = ?source_info.source_submission_status,
        configuration_opening_submissions = ?source_info.configuration_opening_submission_status,
        "source-verification registry ready"
    );
    // The index writes a verification row for every contract it admits, so the
    // lookup has to be in place before the index catches up.
    inner
        .lock()
        .unwrap()
        .set_contract_verification(Arc::clone(&source_verification));

    // The query index is rebuildable and never controls canonical-state resume
    // or startup. Catch it up from stored canonical data before mempool/RPC/P2P
    // can observe it; a failure is retried once the node is following. Dev mode
    // builds both stores in memory and indexes block zero with its commit, so
    // there is nothing to catch up.
    if !cli.dev {
        if let Err(error) = catch_up_derived_index(&db_path, &inner).await {
            tracing::warn!(
                %error,
                "derived index did not catch up at startup; retrying while the node runs"
            );
        }
    }

    // The registry is a separate file that can change while the node is down,
    // so the verification view is rebuilt from the opened registry before
    // anything serves it. A registry that cannot answer clears the view instead
    // of leaving stale rows, and never stops the node.
    match NodeHandle::new(inner.clone()).recompute_contract_verification() {
        Ok(()) => {
            tracing::info!("contract verification rows recomputed from the source registry");
        }
        Err(error) => {
            tracing::warn!(%error, "contract verification rows were not recomputed");
        }
    }

    // The mempool owns its own persistent workers so admission remains
    // independent of canonical derivation. Establish every worker's KATs before
    // exposing RPC or P2P services.
    let mempool_verifiers: Vec<BbProcessVerifier> = (0..cli.mempool_verifiers)
        .map(|_| BbProcessVerifier::from_env())
        .collect::<Result<_, _>>()?;
    std::thread::scope(|scope| {
        let checks: Vec<_> = mempool_verifiers
            .iter()
            .map(|verifier| scope.spawn(|| verifier.assert_known_answers()))
            .collect();
        checks.into_iter().try_for_each(|check| {
            check
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
        })
    })?;
    let admission = AdmissionPool::new(mempool_verifiers, cli.mempool_admission_queue)
        .wrap_err("start mempool verifier workers")?;
    let prometheus = cli
        .metrics_addr
        .as_ref()
        .map(|_| Arc::new(PrometheusMetrics::new()));
    let metrics: Arc<dyn Metrics> = match &prometheus {
        Some(prometheus) => {
            prometheus.set_info(cfg.pcash_chain_id);
            Arc::clone(prometheus) as Arc<dyn Metrics>
        }
        None => Arc::new(NoopMetrics),
    };
    let mempool_limits = MempoolLimits {
        accept_unpaid_registration: cli.mempool_accept_unpaid_registration,
        max_entries: cli.mempool_max_entries,
        max_bytes: cli.mempool_max_bytes,
        max_unpaid_entries: cli.mempool_max_unpaid_entries,
    };
    let mempool = if cli.dev {
        MempoolService::open_in_memory_with_metrics(
            inner.clone(),
            admission,
            mempool_limits,
            Arc::clone(&metrics),
        )?
    } else {
        MempoolService::open_with_metrics(
            inner.clone(),
            mempool_path_for(&db_path),
            admission,
            mempool_limits,
            Arc::clone(&metrics),
        )?
    };

    // The catalog is optional and failure-isolated: a namespace policy error is
    // a configuration mistake and fails startup, but a storage problem only
    // makes the catalog unavailable.
    let catalog_namespaces =
        resolve_namespaces(&cli.catalog_namespaces).map_err(|error| eyre::eyre!(error))?;
    if cli.enable_catalog && !cli.catalog_namespaces.is_empty() {
        for default in DEFAULT_CATALOG_NAMESPACES {
            if !catalog_namespaces
                .iter()
                .any(|namespace| namespace == default)
            {
                tracing::warn!(
                    namespaces = ?catalog_namespaces,
                    "explicit --catalog-namespace list omits {default}; its publication is disabled"
                );
            }
        }
    }
    let catalog = Arc::new(if cli.enable_catalog && cli.dev {
        CatalogService::open_in_memory(cfg.pcash_chain_id, genesis_hash, catalog_namespaces)
    } else if cli.enable_catalog {
        CatalogService::open(
            catalog_path_for(&db_path),
            cfg.pcash_chain_id,
            genesis_hash,
            catalog_namespaces,
        )
    } else {
        CatalogService::disabled(cfg.pcash_chain_id, catalog_namespaces)
    });
    if cli.enable_source_submissions && cli.pscan_addr.is_none() {
        eyre::bail!("--enable-source-submissions requires --pscan-addr");
    }
    if cli.enable_configuration_opening_submissions && cli.pscan_addr.is_none() {
        eyre::bail!("--enable-configuration-opening-submissions requires --pscan-addr");
    }

    let p2p = if cli.disable_p2p {
        tracing::info!("PCASH P2P disabled");
        None
    } else {
        let fork_capability = { inner.lock().unwrap().fork_capability() };
        let identity = match p2p_identity {
            Some(identity) => identity,
            None => load_or_create_identity(&cli.data_dir.join("p2p_identity.pb"))
                .wrap_err("load P2P identity")?,
        };
        Some(
            start_p2p_with_metrics(
                P2pConfig {
                    connectivity: pcash_p2p::ConnectivityConfig {
                        discovery: cli.p2p_discovery == ConnectivityMode::Auto,
                        nat: cli.p2p_nat == ConnectivityMode::Auto,
                        target_peers: usize::from(cli.p2p_target_peers),
                        advertised_address: cli.p2p_advertise_addr.clone(),
                        relay_seeds: cli.p2p_relay.clone(),
                        relay_server: cli.p2p_relay_server,
                        allow_private_addresses: cli.p2p_allow_private_addresses,
                    },
                    chain_id: cfg.pcash_chain_id,
                    genesis_hash,
                    identity,
                    listen: cli.p2p_listen.clone(),
                    bootstrap: bootnodes(&cli),
                    max_inventory: MAX_INVENTORY_PAGE_IDS,
                    anti_entropy_interval: Duration::from_secs(cli.p2p_anti_entropy_secs),
                    peer_ban_duration: pcash_p2p::PEER_BAN_DURATION,
                    fork_capability,
                },
                mempool.clone(),
                Arc::clone(&metrics),
            )
            .await?,
        )
    };

    let rpc_addr: SocketAddr = cli.rpc_addr.parse().wrap_err("bad --rpc-addr")?;
    let node_handle = {
        let base = NodeHandle::new(inner.clone())
            .with_mempool(mempool.clone())
            .with_catalog(catalog.clone())
            .with_source_verification(source_verification.clone())
            .with_prover_assets(prover_assets.clone());
        match &p2p {
            Some(p2p) => base.with_p2p(p2p.handle.clone(), p2p.listen_addresses_watch()),
            None => base,
        }
    };
    let handle: Arc<dyn pcash_rpc::NodeApi> = Arc::new(node_handle.clone());
    let board = if cli.pboard {
        let network = pcash_pboard::BoardNetwork {
            chain_id: cfg.pcash_chain_id,
            genesis_hash,
        };
        let store = if cli.dev {
            pcash_pboard::BoardStore::in_memory(network)
        } else {
            pcash_pboard::BoardStore::open(pcash_pboard::board_path_for(&db_path), network)
        }
        .wrap_err("open board index")?;
        let store = Arc::new(store);
        tokio::spawn(pcash_pboard::follow(
            Arc::new(node_handle.clone()),
            Arc::clone(&store),
            node_handle.watch_index(),
        ));
        pcash_pboard::api::build_module(store).into()
    } else {
        pcash_rpc::RpcMethods::new()
    };
    let (local, server_handle) =
        pcash_rpc::serve_with_metrics(rpc_addr, handle, Arc::clone(&metrics), board).await?;
    tracing::info!(
        %local,
        network = cli.network.map(Network::name),
        pcash_chain_id = cfg.pcash_chain_id,
        l1_chain_id = cfg.l1_chain_id,
        inbox_address = %cfg.inbox,
        genesis_l1_block = cfg.genesis_l1_block,
        l1_rpc_max_requests_per_second = cli.l1_rpc_max_requests_per_second,
        pboard = cli.pboard,
        "pcash RPC listening (HTTP+WS)"
    );
    if let (Some(addr), Some(prometheus)) = (cli.metrics_addr.as_ref(), prometheus) {
        let bind: SocketAddr = addr.parse().wrap_err("bad --metrics-addr")?;
        let bound = pcash_metrics::spawn(bind, prometheus)
            .await
            .wrap_err("bind metrics HTTP")?;
        tracing::info!(address = %bound, "pcash metrics listening on /metrics");
        // Development mode keeps every store in memory, so the data directory's
        // free space says nothing about them.
        #[cfg(unix)]
        if !cli.dev {
            spawn_data_dir_sampler(cli.data_dir.clone(), Arc::clone(&metrics));
        }
    }
    // Dedicated pscan listener. The registry is shared with the node's own
    // getContracts enrichment; the reader adapter is the only chain coupling.
    let pscan_handle = match cli.pscan_addr.as_ref() {
        Some(addr) => {
            let bind: SocketAddr = addr.parse().wrap_err("bad --pscan-addr")?;
            let reader = NodeContractIndexReader {
                handle: node_handle.clone(),
            };
            let service = pcash_pscan::api::PscanService::new(source_verification, reader);
            let api: Arc<dyn pcash_pscan::api::PscanApi> = Arc::new(service);
            let (bound, handle) =
                pcash_pscan::api::serve_pscan_with_metrics(bind, api, Arc::clone(&metrics))
                    .await
                    .wrap_err("bind pscan RPC")?;
            tracing::info!(
                address = %bound,
                source_submissions = cli.enable_source_submissions,
                configuration_opening_submissions = cli.enable_configuration_opening_submissions,
                "pcash pscan RPC listening"
            );
            Some(handle)
        }
        None => None,
    };

    // Held for the process lifetime: dropping a `ServerHandle` stops its server.
    let admin_handle = match cli.admin_addr.as_ref() {
        Some(addr) => {
            let bind: SocketAddr = addr.parse().wrap_err("bad --admin-addr")?;
            let admin: Arc<dyn pcash_rpc::AdminApi> = Arc::new(node_handle);
            let (bound, handle) =
                pcash_rpc::serve_admin_with_metrics(bind, admin, Arc::clone(&metrics))
                    .await
                    .wrap_err("bind admin RPC")?;
            tracing::info!(address = %bound, "pcash admin RPC listening (operator-only)");
            Some(handle)
        }
        None => None,
    };

    let mut follower = Follower::new(client, follower_start);
    if let Some(h) = anchor {
        follower.rewind_to(follower_start, Some(h));
    }

    let _ = ready.send(());
    let result = {
        let index_inner = inner.clone();
        let index_metrics = Arc::clone(&metrics);
        let indexing = maintain_derived_index(
            (!cli.dev).then_some(db_path.as_path()),
            &index_inner,
            &index_metrics,
        );
        let following = run_follow_with_catchup(
            inner,
            follower,
            verifier,
            cli.run_until,
            Duration::from_secs(cli.poll_secs),
            beacon,
            Some(mempool),
            metrics,
            cli.catchup_fetch_queue,
        );
        // A halted node keeps serving and keeps maintaining its index until it is stopped.
        let following = follow_until_stopped(following, stop);
        tokio::pin!(following, indexing);
        tokio::select! {
            result = &mut following => result,
            never = &mut indexing => match never {},
        }
    };
    // Dropping the follower cancels its catch-up pipeline between commits, and
    // dropping the index maintenance stops it at a block boundary.
    let mut servers = vec![server_handle];
    servers.extend(pscan_handle);
    servers.extend(admin_handle);
    for server in &servers {
        server.stop().ok();
    }
    if let Some(p2p) = p2p {
        if let Err(error) = p2p.handle.shutdown().await {
            tracing::warn!(%error, "failed to stop PCASH P2P task");
        }
    }
    for server in servers {
        server.stopped().await;
    }
    // Runtime teardown joins blocking work and drops remaining task-owned database handles.
    result
}

/// Independent switches for discovery and automatic NAT connectivity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
enum ConnectivityMode {
    Auto,
    Off,
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::ConnectivityMode;
    // Parsed without PCASH_* environment fallbacks: parser behavior is a property
    // of the parser, not of the environment the test happens to run in.
    fn parse_launch_cli<I, T>(args: I) -> Result<super::Cli, clap::Error>
    where
        I: IntoIterator<Item = T>,
        T: Into<std::ffi::OsString> + Clone,
    {
        use clap::{CommandFactory, FromArgMatches};
        let matches = super::Cli::command()
            .mut_args(|arg| arg.env(None::<&'static str>))
            .try_get_matches_from(args)?;
        super::Cli::from_arg_matches(&matches)
    }
    use super::{
        bootnodes, configured_prover_assets, load_network, p2p_identity_key,
        validate_genesis_l1_finality, validate_genesis_l1_hash, Network, DEV_MODE_WARNING,
    };
    use alloy_primitives::{address, B256};

    #[cfg(unix)]
    #[test]
    fn free_bytes_reads_the_filesystem_holding_a_directory() {
        let directory = tempfile::tempdir().unwrap();
        assert!(super::free_bytes(directory.path()).unwrap() > 0);
        assert!(super::free_bytes(&directory.path().join("missing")).is_err());
    }

    #[test]
    fn runtime_derivation_config_reaches_node_config() {
        let cli = parse_launch_cli([
            "pcash",
            "--l1-rpc",
            "http://localhost:8545",
            "--beacon-api",
            "http://localhost:5052",
            "--data-dir",
            "/tmp/pcash-cli-network-test",
            "--dev",
            "--pcash-chain-id",
            "9191",
            "--l1-chain-id",
            "1",
            "--inbox-address",
            "0x1111111111111111111111111111111111111111",
            "--genesis-l1-block",
            "1234",
            "--genesis-l1-block-hash",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ])
        .unwrap();
        let cfg = load_network(&cli).unwrap();
        assert_eq!(cfg.pcash_chain_id, 9191);
        assert_eq!(cfg.l1_chain_id, 1);
        assert_eq!(
            cfg.inbox,
            address!("0x1111111111111111111111111111111111111111")
        );
        assert_eq!(cfg.genesis_l1_block, 1234);
        assert_eq!(cfg.genesis_l1_block_hash, B256::repeat_byte(0xaa));
        assert!(cli.metrics_addr.is_none());
    }

    #[test]
    fn zero_pcash_chain_id_is_rejected() {
        let cli = parse_launch_cli([
            "pcash",
            "--l1-rpc",
            "http://localhost:8545",
            "--beacon-api",
            "http://localhost:5052",
            "--data-dir",
            "/tmp/pcash-cli-zero-chain-id-test",
            "--dev",
            "--pcash-chain-id",
            "0",
            "--genesis-l1-block",
            "1",
            "--genesis-l1-block-hash",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ])
        .unwrap();
        let error = load_network(&cli).unwrap_err();
        assert_eq!(error.to_string(), "PCASH_CHAIN_ID must be nonzero");
    }

    #[test]
    fn metrics_addr_is_optional() {
        let cli = parse_launch_cli([
            "pcash",
            "--l1-rpc",
            "http://localhost:8545",
            "--beacon-api",
            "http://localhost:5052",
            "--data-dir",
            "/tmp/pcash-cli-metrics-test",
            "--dev",
            "--genesis-l1-block",
            "1",
            "--genesis-l1-block-hash",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--metrics-addr",
            "127.0.0.1:9465",
        ])
        .unwrap();
        assert_eq!(cli.metrics_addr.as_deref(), Some("127.0.0.1:9465"));
    }

    #[test]
    fn mempool_admission_flags_size_the_verifier_pool() {
        let base = [
            "pcash",
            "--l1-rpc",
            "http://localhost:8545",
            "--beacon-api",
            "http://localhost:5052",
            "--data-dir",
            "/tmp/pcash-cli-admission-test",
            "--dev",
            "--genesis-l1-block",
            "1",
            "--genesis-l1-block-hash",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ];
        let defaults = parse_launch_cli(base).unwrap();
        assert_eq!(
            defaults.mempool_verifiers,
            super::default_mempool_verifiers()
        );
        assert_eq!(
            defaults.mempool_admission_queue,
            super::DEFAULT_ADMISSION_QUEUE
        );

        let configured = parse_launch_cli(base.into_iter().chain([
            "--mempool-verifiers",
            "8",
            "--mempool-admission-queue",
            "32",
        ]))
        .unwrap();
        assert_eq!(configured.mempool_verifiers, 8);
        assert_eq!(configured.mempool_admission_queue, 32);
    }

    #[test]
    fn source_submission_flags_are_independent() {
        let base = [
            "pcash",
            "--l1-rpc",
            "http://localhost:8545",
            "--beacon-api",
            "http://localhost:5052",
            "--data-dir",
            "/tmp/pcash-cli-submission-flags-test",
            "--dev",
            "--genesis-l1-block",
            "1",
            "--genesis-l1-block-hash",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--pscan-addr",
            "127.0.0.1:8648",
        ];
        let source =
            parse_launch_cli(base.into_iter().chain(["--enable-source-submissions"])).unwrap();
        assert!(source.enable_source_submissions);
        assert!(!source.enable_configuration_opening_submissions);

        let openings = parse_launch_cli(
            base.into_iter()
                .chain(["--enable-configuration-opening-submissions"]),
        )
        .unwrap();
        assert!(!openings.enable_source_submissions);
        assert!(openings.enable_configuration_opening_submissions);
    }

    #[test]
    fn prover_assets_base_url_requires_an_explicit_manifest_path() {
        let base = [
            "pcash",
            "--l1-rpc",
            "http://localhost:8545",
            "--beacon-api",
            "http://localhost:5052",
            "--data-dir",
            "/tmp/pcash-cli-prover-assets-test",
            "--dev",
            "--genesis-l1-block",
            "1",
            "--genesis-l1-block-hash",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--prover-assets-base-url",
            "/proving/",
        ];
        let error = parse_launch_cli(base).expect_err("asset hosting needs a manifest path");
        assert!(error.to_string().contains("--prover-assets-manifest"));

        let cli = parse_launch_cli(base.into_iter().chain([
            "--prover-assets-manifest",
            "/tmp/browser-prover-release.json",
        ]))
        .unwrap();
        assert_eq!(
            cli.prover_assets_manifest.as_deref(),
            Some(std::path::Path::new("/tmp/browser-prover-release.json"))
        );
    }

    #[test]
    fn source_checkout_manifest_loads_through_startup_configuration() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../assets/browser-prover-release.json");
        let descriptor: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let advertised = configured_prover_assets(Some("/proving/"), Some(&path))
            .unwrap()
            .unwrap();
        let expected = descriptor["assetSetId"].as_str().unwrap();
        assert_eq!(advertised.asset_set_id, expected);
        assert_eq!(advertised.base_url, format!("/proving/{expected}/"));
    }

    #[test]
    fn dev_mode_is_explicit_and_conflicts_with_force_resync() {
        let base = [
            "pcash",
            "--l1-rpc",
            "http://localhost:8545",
            "--beacon-api",
            "http://localhost:8545",
            "--data-dir",
            "/tmp/pcash-cli-dev-test",
            "--genesis-l1-block",
            "0",
            "--genesis-l1-block-hash",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ];
        let cli = parse_launch_cli(base.into_iter().chain(["--dev"])).unwrap();
        assert!(cli.dev);
        assert!(DEV_MODE_WARNING.contains("ALL NODE DATABASES ARE IN MEMORY"));
        assert!(DEV_MODE_WARNING.contains("DATABASE DATA WILL BE LOST ON EXIT"));
        assert!(parse_launch_cli(base.into_iter().chain(["--dev", "--force-resync"])).is_err());
    }

    #[test]
    fn beacon_api_is_required() {
        let error = parse_launch_cli([
            "pcash",
            "--l1-rpc",
            "http://localhost:8545",
            "--data-dir",
            "/tmp/pcash-cli-beacon-test",
            "--genesis-l1-block",
            "1",
        ])
        .expect_err("a node cannot start without a Beacon API");
        assert!(error.to_string().contains("--beacon-api"));
    }

    #[test]
    fn genesis_l1_block_hash_is_required() {
        let error = parse_launch_cli([
            "pcash",
            "--l1-rpc",
            "http://localhost:8545",
            "--beacon-api",
            "http://localhost:5052",
            "--data-dir",
            "/tmp/pcash-cli-anchor-test",
            "--genesis-l1-block",
            "1",
        ])
        .expect_err("a node cannot start without an L1 anchor hash");
        assert!(error.to_string().contains("--genesis-l1-block-hash"));
    }

    #[test]
    fn genesis_l1_anchor_must_be_finalized() {
        let error = validate_genesis_l1_finality(101, 100).unwrap_err();
        assert_eq!(
            error.to_string(),
            "genesis L1 block 101 is not finalized: RPC finalized block is 100"
        );
        validate_genesis_l1_finality(100, 100).unwrap();
        validate_genesis_l1_finality(99, 100).unwrap();
    }

    #[test]
    fn genesis_l1_anchor_hash_must_match() {
        let error = validate_genesis_l1_hash(100, B256::repeat_byte(0xaa), B256::repeat_byte(0xbb))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("genesis L1 block hash mismatch at 100"));
        validate_genesis_l1_hash(100, B256::repeat_byte(0xaa), B256::repeat_byte(0xaa)).unwrap();
    }

    const NETWORK_BASE: [&str; 7] = [
        "pcash",
        "--l1-rpc",
        "http://localhost:8545",
        "--beacon-api",
        "http://localhost:5052",
        "--data-dir",
        "/tmp/pcash-cli-network-preset-test",
    ];

    #[test]
    fn a_network_preset_supplies_the_identity_and_bootnodes() {
        let cli = parse_launch_cli(NETWORK_BASE.iter().copied().chain([
            "--network",
            "testnet",
            "--p2p-bootnode",
            "/ip4/203.0.113.9/tcp/8646",
        ]))
        .unwrap();
        let cfg = load_network(&cli).unwrap();
        let preset = Network::Testnet.config().unwrap();
        assert_eq!(cfg.pcash_chain_id, preset.pcash_chain_id);
        assert_eq!(cfg.l1_chain_id, preset.l1_chain_id);
        assert_eq!(cfg.inbox, preset.inbox);
        assert_eq!(cfg.genesis_l1_block, preset.genesis_l1_block);
        assert_eq!(cfg.genesis_l1_block_hash, preset.genesis_l1_block_hash);

        let mut expected = Network::Testnet.bootnodes();
        expected.push("/ip4/203.0.113.9/tcp/8646".parse().unwrap());
        assert_eq!(bootnodes(&cli), expected);
    }

    #[test]
    fn a_network_preset_rejects_an_individual_identity_flag() {
        for network in ["mainnet", "testnet"] {
            for (flag, value) in [
                (
                    "--inbox-address",
                    "0x1111111111111111111111111111111111111111",
                ),
                ("--genesis-l1-block", "1"),
                (
                    "--genesis-l1-block-hash",
                    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                ),
            ] {
                let error = parse_launch_cli(NETWORK_BASE.iter().copied().chain([
                    "--network",
                    network,
                    flag,
                    value,
                ]))
                .expect_err("a preset and an individual identity flag cannot both apply");
                assert!(error.to_string().contains(flag), "{flag}: {error}");
            }
        }
    }

    #[test]
    fn a_network_preset_accepts_its_own_chain_ids_and_rejects_others() {
        let preset = Network::Testnet.config().unwrap();
        let (pcash, l1) = (
            preset.pcash_chain_id.to_string(),
            preset.l1_chain_id.to_string(),
        );
        let with = |flags: [&str; 4]| {
            let cli = parse_launch_cli(
                NETWORK_BASE
                    .iter()
                    .copied()
                    .chain(["--network", "testnet"])
                    .chain(flags),
            )
            .unwrap();
            load_network(&cli).map(|cfg| (cfg.pcash_chain_id, cfg.l1_chain_id))
        };
        assert_eq!(
            with(["--pcash-chain-id", &pcash, "--l1-chain-id", &l1]).unwrap(),
            (preset.pcash_chain_id, preset.l1_chain_id)
        );
        let error = with(["--pcash-chain-id", "1", "--l1-chain-id", &l1]).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("--pcash-chain-id 1 does not match"),
            "{error}"
        );
        let error = with(["--pcash-chain-id", &pcash, "--l1-chain-id", "999"]).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("--l1-chain-id 999 does not match"),
            "{error}"
        );
    }

    #[test]
    fn mainnet_is_recognized_but_cannot_start_without_its_anchor() {
        let cli =
            parse_launch_cli(NETWORK_BASE.iter().copied().chain(["--network", "mainnet"])).unwrap();
        assert_eq!(cli.network, Some(Network::Mainnet));
        assert_eq!(
            load_network(&cli).unwrap_err().to_string(),
            "mainnet genesis anchor is not configured"
        );
    }

    #[test]
    fn the_anchor_is_required_without_a_network_preset() {
        let error =
            parse_launch_cli(NETWORK_BASE).expect_err("a node cannot start without an L1 anchor");
        assert!(error.to_string().contains("--genesis-l1-block"));
    }

    #[test]
    fn discovery_and_nat_are_independently_configurable() {
        let base = NETWORK_BASE.iter().copied().chain(["--network", "testnet"]);
        let defaults = parse_launch_cli(base.clone()).unwrap();
        assert_eq!(defaults.p2p_discovery, ConnectivityMode::Auto);
        assert_eq!(defaults.p2p_nat, ConnectivityMode::Auto);
        assert_eq!(defaults.p2p_target_peers, 16);
        assert!(!defaults.p2p_relay_server);
        assert!(!defaults.p2p_allow_private_addresses);
        for (flag, discovery, nat) in [
            (
                "--p2p-discovery",
                ConnectivityMode::Off,
                ConnectivityMode::Auto,
            ),
            ("--p2p-nat", ConnectivityMode::Auto, ConnectivityMode::Off),
        ] {
            let cli = parse_launch_cli(base.clone().chain([flag, "off"])).unwrap();
            assert_eq!(cli.p2p_discovery, discovery);
            assert_eq!(cli.p2p_nat, nat);
        }
        assert!(parse_launch_cli(base.clone().chain(["--p2p-target-peers", "0"])).is_err());
        assert!(parse_launch_cli(base.clone().chain(["--p2p-target-peers", "129"])).is_err());
        assert!(parse_launch_cli(base.chain(["--p2p-nat", "unknown"])).is_err());
    }

    #[test]
    fn a_p2p_identity_key_is_the_identity_file_it_encodes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p2p_identity.pb");
        let generated = pcash_p2p::generate_identity_file(&path, false).unwrap();
        let encoded = hex::encode(std::fs::read(&path).unwrap());
        let cli = parse_launch_cli(NETWORK_BASE.iter().copied().chain([
            "--network",
            "testnet",
            "--p2p-identity-key",
            &encoded,
        ]))
        .unwrap();
        assert_eq!(
            p2p_identity_key(&cli)
                .unwrap()
                .unwrap()
                .public()
                .to_peer_id(),
            generated.info.peer_id
        );
        assert!(!format!("{cli:?}").contains(&encoded));

        let malformed = format!("{}00", &encoded[..encoded.len() - 2]);
        let cli = parse_launch_cli(NETWORK_BASE.iter().copied().chain([
            "--network",
            "testnet",
            "--p2p-identity-key",
            &malformed,
        ]))
        .unwrap();
        let error = p2p_identity_key(&cli).expect_err("a malformed key is a configuration error");
        assert!(!error.to_string().contains(&malformed[..16]));
    }
}
