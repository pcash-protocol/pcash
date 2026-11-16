//! The PCASH derivation proof's host.
//!
//! - `run`: prove Ethereum blocks from the anchor as a chain of range proofs in
//!   SP1's executor and compare the result with a running node; with
//!   `--tamper`, require the range program to refuse altered input.
//! - `bootstrap`: derive the network to a final PCASH block and save its state.
//! - `deploy`: deploy `PcashState`, the contract of proven checkpoints,
//!   anchored at a saved state.
//! - `prover`: advance the contract's anchor with `proveBlock` (see `prover`).
//! - `verdicts`: require the range program's proof verifier to answer as the
//!   node's does (see `verdicts`).
//! - `keys`: print the programs' verification keys as a contract holds them.
//!
//! Programs run in SP1's executor first. The host derives every block natively
//! with the same code as the range program, records each range's state
//! witness, and requires each range to start from the checkpoint the previous
//! one reached.

mod blocks;
mod node;
mod prove;
mod prover;
mod contract;
mod tamper;
mod verdicts;

use std::path::PathBuf;
use std::time::Duration;

use alloy_primitives::{Address, B256};
use alloy_signer_local::PrivateKeySigner;
use clap::{Parser, Subcommand};
use derivation_proof_core::{config_hash, RawBlock, Source};
use eyre::{bail, ensure, eyre, Result};
use prove::{prove_ranges, Native, Programs};
use prover::{Endpoints, Prover, StateDir};
use contract::{Ethereum, ContractConfig};
use tokio::runtime::Runtime;

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Run(RunArgs),
    Bootstrap(BootstrapArgs),
    Deploy(DeployArgs),
    Prover(ProverArgs),
    Verdicts(VerdictsArgs),
    /// Print the programs' keys as `PcashState` holds them.
    Keys(ProgramArgs),
}

/// Where the blocks come from and which network they derive.
#[derive(clap::Args)]
struct NetworkArgs {
    /// Ethereum JSON-RPC endpoint.
    #[arg(long)]
    l1_rpc: String,
    /// Beacon API for the blobs of inbox blob carriers; the L1 endpoint by
    /// default, which is where Anvil serves it.
    #[arg(long)]
    beacon_api: Option<String>,
    /// PCASH node JSON-RPC endpoint. The network defaults to the node's
    /// (`pcash_status`), and each proven block's hash is compared
    /// with the node's.
    #[arg(long)]
    node_rpc: Option<String>,
    #[arg(long)]
    pcash_chain_id: Option<u32>,
    #[arg(long)]
    l1_chain_id: Option<u64>,
    #[arg(long)]
    inbox_address: Option<Address>,
    #[arg(long)]
    genesis_l1_block: Option<u64>,
    #[arg(long)]
    genesis_l1_block_hash: Option<B256>,
}

/// The range and aggregation programs.
#[derive(clap::Args)]
struct ProgramArgs {
    /// The range program ELF (`build-guest.sh` prints its path).
    #[arg(long)]
    elf: PathBuf,
    /// The aggregation program ELF.
    #[arg(long)]
    aggregation_elf: PathBuf,
}

/// The Ethereum account that sends transactions: a key in an environment
/// variable, or an account the Ethereum node holds unlocked.
#[derive(clap::Args)]
struct AccountArgs {
    /// The environment variable holding the account's private key.
    #[arg(long, conflicts_with = "from")]
    private_key_env: Option<String>,
    /// An unlocked account, as Anvil's are.
    #[arg(long)]
    from: Option<Address>,
}

/// Prove blocks from the anchor as chained ranges and compare with the node.
#[derive(clap::Args)]
struct RunArgs {
    #[command(flatten)]
    network: NetworkArgs,
    /// The range program ELF.
    #[arg(long)]
    elf: PathBuf,
    /// Last Ethereum block to derive; the node's latest by default.
    #[arg(long)]
    to_block: Option<u64>,
    /// Ethereum blocks per range proof; all of them in one by default.
    #[arg(long)]
    range_blocks: Option<usize>,
    /// Keep fetched blocks in this file and reuse them on later runs.
    #[arg(long)]
    blocks_cache: Option<PathBuf>,
    /// Alter the input and require the range program to refuse it.
    #[arg(long, value_enum)]
    tamper: Option<tamper::Tamper>,
}

/// Derive the network to a final PCASH block and save its state.
#[derive(clap::Args)]
struct BootstrapArgs {
    #[command(flatten)]
    network: NetworkArgs,
    /// Where the prover keeps its states.
    #[arg(long)]
    state_dir: PathBuf,
    /// The PCASH block to derive to.
    #[arg(long)]
    start_block: u64,
}

/// Deploy `PcashState` anchored at a PCASH block whose state `bootstrap` saved.
#[derive(clap::Args)]
struct DeployArgs {
    #[command(flatten)]
    network: NetworkArgs,
    #[command(flatten)]
    programs: ProgramArgs,
    #[command(flatten)]
    account: AccountArgs,
    /// The Foundry project holding the compiled contracts.
    #[arg(long)]
    contracts: PathBuf,
    /// Where the prover keeps its states.
    #[arg(long)]
    state_dir: PathBuf,
    /// The PCASH block the contract starts at.
    #[arg(long)]
    start_block: u64,
    /// PCASH blocks per proof.
    #[arg(long)]
    interval: u64,
    /// Deploy `ExecutedVerifier`, which takes a run's public values in place
    /// of a proof, for development, in place of SP1's PLONK verifier.
    #[arg(long)]
    executed_verifier: bool,
}

/// Advance the contract's anchor.
#[derive(clap::Args)]
struct ProverArgs {
    #[command(flatten)]
    network: NetworkArgs,
    #[command(flatten)]
    programs: ProgramArgs,
    #[command(flatten)]
    account: AccountArgs,
    /// The `PcashState` contract.
    #[arg(long)]
    contract: Address,
    /// The Foundry project holding the compiled contracts, for mock proofs:
    /// the contract's verifier must be `ExecutedVerifier` as compiled there.
    #[arg(long, required_if_eq("proofs", "mock"))]
    contracts: Option<PathBuf>,
    /// Where the state at the contract's anchor is kept; `deploy` writes the
    /// first. Earlier states are deleted once this contract's anchor passes them
    /// at Ethereum's finalized block, so a directory serves one contract.
    #[arg(long)]
    state_dir: PathBuf,
    /// Ethereum blocks per range proof.
    #[arg(long)]
    range_blocks: usize,
    #[arg(long, default_value_t = 12)]
    poll_secs: u64,
    /// Stop once the contract's anchor is this many intervals past where it was
    /// at the start, however it got there.
    #[arg(long)]
    intervals: Option<u64>,
    /// Where proofs come from.
    #[arg(long, value_enum, required_unless_present = "quote")]
    proofs: Option<Proofs>,
    /// Run the next interval's programs and price its proofs on the prover
    /// network, without requesting proofs or sending transactions.
    #[arg(long, conflicts_with_all = ["proofs", "intervals"])]
    quote: bool,
}

/// Compare the range program's proof verifier with the node's.
#[derive(clap::Args)]
struct VerdictsArgs {
    /// The verifier program ELF, which `build-guest.sh` builds beside the
    /// range program as `verdicts`.
    #[arg(long)]
    elf: PathBuf,
    /// The circuit bundle the programs were built with
    /// (`scripts/circuits/bundle.mjs --print-path`).
    #[arg(long)]
    bundle: PathBuf,
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum Proofs {
    /// SP1's mock prover, for a contract verified by `ExecutedVerifier`.
    Mock,
    /// SP1's CPU prover on this machine, for a contract verified by SP1's
    /// verifier. Practical only for intervals of a few cheap blocks.
    Cpu,
    /// Succinct's prover network, paid by the account whose key is in
    /// `NETWORK_PRIVATE_KEY`, for a contract verified by SP1's verifier.
    Network,
}

impl NetworkArgs {
    /// The network, from the flags or the node's status, and that status.
    fn source(&self, runtime: &Runtime) -> Result<(Source, Option<serde_json::Value>)> {
        let status = match &self.node_rpc {
            Some(node_rpc) => Some(runtime.block_on(node::status(node_rpc))?),
            None => None,
        };
        let field = |name: &str| -> Result<serde_json::Value> {
            status
                .as_ref()
                .map(|status| status[name].clone())
                .ok_or_else(|| eyre!("pass --{name} or --node-rpc"))
        };
        let source = Source {
            pcash_chain_id: match self.pcash_chain_id {
                Some(id) => id,
                None => u32::try_from(node::quantity(&field("pcashChainId")?)?)?,
            },
            l1_chain_id: match self.l1_chain_id {
                Some(id) => id,
                None => node::quantity(&field("l1ChainId")?)?,
            },
            inbox_address: match self.inbox_address {
                Some(address) => address,
                None => serde_json::from_value(field("inboxAddress")?)?,
            },
            genesis_l1_block: match self.genesis_l1_block {
                Some(number) => number,
                None => node::quantity(&field("genesisL1Block")?)?,
            },
            genesis_l1_block_hash: match self.genesis_l1_block_hash {
                Some(hash) => hash,
                None => serde_json::from_value(field("genesisL1BlockHash")?)?,
            },
        };
        Ok((source, status))
    }

    fn endpoints(&self) -> Endpoints {
        Endpoints {
            l1_rpc: self.l1_rpc.clone(),
            beacon_api: self.beacon_api.clone().unwrap_or_else(|| self.l1_rpc.clone()),
            node_rpc: self.node_rpc.clone(),
        }
    }
}

impl ProgramArgs {
    fn prover(&self, range_blocks: usize) -> Result<Prover> {
        Ok(Prover {
            programs: Programs::load(&self.elf, Some(&self.aggregation_elf))?,
            range_blocks,
        })
    }
}

impl AccountArgs {
    fn ethereum(&self, rpc: &str) -> Result<Ethereum> {
        match (&self.private_key_env, self.from) {
            (Some(variable), _) => {
                let key: PrivateKeySigner = std::env::var(variable)
                    .map_err(|_| eyre!("{variable} is not set"))?
                    .trim()
                    .parse()?;
                Ethereum::signing(rpc, key)
            }
            (None, Some(from)) => Ethereum::unlocked(rpc, from),
            (None, None) => { bail!("pass --private-key-env or --from"); }
        }
    }
}

fn main() -> Result<()> {
    let runtime = Runtime::new()?;
    match Cli::parse().command {
        Command::Run(args) => run(&runtime, args),
        Command::Bootstrap(args) => bootstrap(&runtime, args),
        Command::Deploy(args) => deploy(&runtime, args),
        Command::Prover(args) => prover(&runtime, args),
        Command::Verdicts(args) => verdicts::run(&args.elf, &args.bundle),
        Command::Keys(args) => keys(args),
    }
}

fn run(runtime: &Runtime, args: RunArgs) -> Result<()> {
    let (mut source, status) = args.network.source(runtime)?;
    let to_block = match (args.to_block, &status) {
        (Some(number), _) => number,
        (None, Some(status)) => node::quantity(&status["latestL1BlockNumber"])?,
        (None, None) => { bail!("pass --to-block or --node-rpc"); }
    };
    ensure!(to_block >= source.genesis_l1_block, "the last block is before the anchor");
    eprintln!("{source:?}, to L1 block {to_block}");
    let endpoints = args.network.endpoints();
    let mut blocks: Vec<RawBlock> = runtime.block_on(blocks::load(
        &endpoints.l1_rpc,
        &endpoints.beacon_api,
        source.inbox_address,
        source.genesis_l1_block,
        to_block,
        args.blocks_cache.as_deref(),
    ))?;
    let logs: usize = blocks.iter().map(blocks::log_count).sum();
    let transactions: usize = blocks.iter().map(|block| block.transactions.len()).sum();
    let blobs: usize = blocks.iter().map(|block| block.blobs.len()).sum();
    eprintln!("{} blocks, {transactions} transactions, {logs} logs, {blobs} carrier blobs", blocks.len());
    let programs = Programs::load(&args.elf, None)?;

    if let Some(tamper) = args.tamper {
        tamper::apply(tamper, &mut source, &mut blocks)?;
        // Altered input stops native derivation too, so one range from the
        // anchor runs in the range program alone.
        return match programs.range(&source, None, &blocks) {
            Err(error) => {
                println!("tamper {tamper:?}: refused ({error})");
                Ok(())
            }
            Ok((values, _, _)) => { bail!("tamper {tamper:?}: the range program accepted altered input: {values:?}"); }
        };
    }

    let mut native = Native::new(&source)?;
    prove_ranges(&programs, &mut native, &source, &blocks, args.range_blocks.unwrap_or(blocks.len()), None)?;
    let checkpoint = native.checkpoint();
    let pcash_number = to_block - source.genesis_l1_block;
    println!("PCASH block {pcash_number}: hash {}, aux {}", checkpoint.block_hash, checkpoint.aux);
    if let Some(node_rpc) = &endpoints.node_rpc {
        let node_hash = runtime.block_on(node::block_hash(node_rpc, pcash_number))?;
        ensure!(
            checkpoint.block_hash == node_hash,
            "PCASH block {pcash_number} hash: proofs {}, node {node_hash}",
            checkpoint.block_hash
        );
        println!("PCASH block {pcash_number} matches the node: {node_hash}");
    }
    Ok(())
}

/// A program key digest as the aggregation program commits it.
fn vkey_bytes(words: [u32; 8]) -> B256 {
    let bytes: Vec<u8> = words.iter().flat_map(|word| word.to_be_bytes()).collect();
    B256::from_slice(&bytes)
}

/// The keys `deploy` gives the contract: the aggregation program's, and the
/// range program's as the aggregation program commits it.
fn program_keys(programs: &Programs) -> Result<(B256, B256)> {
    let aggregation = programs.aggregation.as_ref().ok_or_else(|| eyre!("no aggregation program"))?;
    Ok((Programs::vkey(aggregation).1, vkey_bytes(Programs::vkey(&programs.range).0)))
}

fn keys(args: ProgramArgs) -> Result<()> {
    let (aggregation, range) = program_keys(&Programs::load(&args.elf, Some(&args.aggregation_elf))?)?;
    println!("aggregation {aggregation}\nrange {range}");
    Ok(())
}

fn bootstrap(runtime: &Runtime, args: BootstrapArgs) -> Result<()> {
    let (source, _) = args.network.source(runtime)?;
    let finalized = runtime.block_on(blocks::finalized(&args.network.l1_rpc))?;
    ensure!(
        source.genesis_l1_block + args.start_block <= finalized,
        "PCASH block {} is not final yet; Ethereum's finalized block is {finalized}",
        args.start_block
    );
    let dir = StateDir::new(&args.state_dir, &source);
    let state = prover::bootstrap(runtime, &args.network.endpoints(), &source, &dir, args.start_block)?;
    println!("PCASH block {}: root {}", state.number, state.root);
    Ok(())
}

fn deploy(runtime: &Runtime, args: DeployArgs) -> Result<()> {
    let (source, _) = args.network.source(runtime)?;
    let state = StateDir::new(&args.state_dir, &source).load(&source, args.start_block)?;
    let programs = Programs::load(&args.programs.elf, Some(&args.programs.aggregation_elf))?;
    let (aggregation_vkey, range_vkey) = program_keys(&programs)?;
    let ethereum = args.account.ethereum(&args.network.l1_rpc)?;
    let config = ContractConfig {
        interval: args.interval,
        start_block: args.start_block,
        start_root: state.root,
        pcash_chain_id: source.pcash_chain_id,
        inbox: source.inbox_address,
        genesis_l1_block: source.genesis_l1_block,
        genesis_l1_block_hash: source.genesis_l1_block_hash,
        aggregation_vkey,
        range_vkey,
    };
    let contract = runtime.block_on(ethereum.deploy_pcash_state(&args.contracts, &config, args.executed_verifier))?;
    let (contract_config, _, _) = runtime.block_on(ethereum.config(contract))?;
    ensure!(contract_config == config_hash(&source), "the contract's config hash differs from the network's");
    println!("anchored at PCASH block {}, root {}", args.start_block, state.root);
    Ok(())
}

fn prover(runtime: &Runtime, args: ProverArgs) -> Result<()> {
    let (source, _) = args.network.source(runtime)?;
    let mut prover = args.programs.prover(args.range_blocks)?;
    // A quote runs the programs in the executor, as mock proving does.
    match args.proofs {
        None | Some(Proofs::Mock) => {}
        Some(Proofs::Cpu) => prover.programs = prover.programs.with_cpu(),
        Some(Proofs::Network) => {
            ensure!(args.intervals.is_some(), "network proofs are paid for: pass --intervals so proving stops");
            prover.programs = prover.programs.with_network()?;
        }
    }
    // A quote sends nothing, so it needs no account.
    let ethereum = match (&args.account.private_key_env, args.account.from, args.quote) {
        (None, None, true) => Ethereum::unlocked(&args.network.l1_rpc, Address::ZERO)?,
        _ => args.account.ethereum(&args.network.l1_rpc)?,
    };
    // Proofs are worth making only for a verifier that accepts them.
    let verifier = runtime.block_on(ethereum.verifier(args.contract))?;
    if args.quote || prover.programs.real() {
        ensure!(
            runtime.block_on(ethereum.is_sp1_plonk_verifier(verifier))?,
            "the contract's verifier {verifier} is not SP1's v6.1.0 PLONK verifier, which real proofs need"
        );
    } else {
        let contracts = args.contracts.as_ref().expect("--proofs mock requires --contracts");
        ensure!(
            runtime.block_on(ethereum.code_is(verifier, contracts, "ExecutedVerifier"))?,
            "the contract's verifier {verifier} is not ExecutedVerifier, which mock proofs need"
        );
    }
    let (aggregation_vkey, range_vkey) = program_keys(&prover.programs)?;
    let (contract_config, contract_aggregation_vkey, contract_range_vkey) =
        runtime.block_on(ethereum.config(args.contract))?;
    ensure!(contract_config == config_hash(&source), "the contract derives another network");
    ensure!(contract_aggregation_vkey == aggregation_vkey, "the contract expects another aggregation program");
    ensure!(contract_range_vkey == range_vkey, "the contract expects another range program");
    prover::run(
        runtime,
        &args.network.endpoints(),
        &source,
        &prover,
        &ethereum,
        args.contract,
        &StateDir::new(&args.state_dir, &source),
        Duration::from_secs(args.poll_secs),
        args.intervals,
        args.quote,
    )
}
