//! Native derivation that records each range's witness, and the range and
//! aggregation programs with their proofs.

use std::cell::RefCell;
use std::path::Path;
use std::time::{Duration, Instant};

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::SolValue;
use derivation_proof_core::l1::Chain;
use derivation_proof_core::{
    compiled_rules, AggregationInput, AggregationOutputs, PublicValues, RangeStart, RawBlock, Source,
};
use eyre::{bail, ensure, eyre, Result};
use pcash_derive::{derive_block, ProtocolRules};
use pcash_state::codec::Codec;
use pcash_state::{Checkpoint, DerivationSource, StateSnapshot, WitnessState};
use pcash_verify::BbProcessVerifier;
use sp1_sdk::blocking::{CpuProver, MockProver, NetworkProver, ProveRequest, Prover, ProverClient};
use sp1_sdk::network::proto::GetProofRequestParamsResponse;
use sp1_sdk::{
    Elf, ExecutionReport, HashableKey, ProvingKey, SP1Proof, SP1ProofMode, SP1ProofWithPublicValues, SP1ProvingKey,
    SP1PublicValues, SP1Stdin,
};

/// The network's full state, derived natively with the guest's own block
/// authentication and rules, recording what each range touches.
pub struct Native {
    full: WitnessState,
    chain: Chain,
    rules: ProtocolRules,
    verifier: BbProcessVerifier,
}

fn derivation_source(source: &Source) -> DerivationSource {
    DerivationSource {
        pcash_chain_id: source.pcash_chain_id,
        l1_chain_id: source.l1_chain_id,
        inbox_address: source.inbox_address,
        genesis_l1_block: source.genesis_l1_block,
        genesis_l1_block_hash: source.genesis_l1_block_hash,
    }
}

impl Native {
    pub fn new(source: &Source) -> Result<Self> {
        Ok(Self {
            full: WitnessState::genesis(derivation_source(source)),
            chain: Chain::from_anchor(source.genesis_l1_block, source.inbox_address),
            rules: compiled_rules(),
            verifier: BbProcessVerifier::from_env()?,
        })
    }

    /// The state an encoded [`StateSnapshot`] holds, continuing from its
    /// tip's Ethereum block.
    pub fn from_snapshot(source: &Source, snapshot: &[u8]) -> Result<Self> {
        let snapshot = StateSnapshot::decode(snapshot).map_err(|error| eyre!("state snapshot: {error:?}"))?;
        let (l1_number, l1_hash) = (snapshot.tip.l1_origin.block_number, snapshot.tip.l1_origin.block_hash);
        Ok(Self {
            full: WitnessState::restore(derivation_source(source), snapshot),
            chain: Chain::from_checkpoint(l1_number, l1_hash, source.inbox_address),
            rules: compiled_rules(),
            verifier: BbProcessVerifier::from_env()?,
        })
    }

    /// The state after the last block derived, encoded.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let snapshot = self.full.snapshot().ok_or_else(|| eyre!("no block derived"))?;
        Ok(snapshot.encode())
    }

    /// The last PCASH block derived.
    pub fn number(&self) -> Option<u64> {
        self.full.inner().canonical_tip.as_ref().map(|tip| tip.header.number)
    }

    /// The checkpoint the state is at; before the first block, a zero block
    /// hash and the empty state's commitment, as the range program commits.
    pub fn checkpoint(&self) -> Checkpoint {
        self.full.checkpoint().unwrap_or(Checkpoint {
            block_hash: B256::ZERO,
            aux: self.full.aux(),
        })
    }

    /// Derive `blocks` and return what the range program needs to derive them:
    /// where they start (`None` at the anchor) with its witness.
    pub fn range(&mut self, blocks: &[RawBlock]) -> Result<Option<RangeStart>> {
        let start_state = self.full.inner().clone();
        let start = self.full.checkpoint();
        self.full.begin_range();
        self.derive(blocks)?;
        Ok(match start {
            None => None,
            Some(checkpoint) => Some(RangeStart {
                block_hash: checkpoint.block_hash,
                aux: checkpoint.aux,
                witness: self.full.witness(&start_state)?.encode(),
            }),
        })
    }

    pub fn derive(&mut self, blocks: &[RawBlock]) -> Result<()> {
        for raw in blocks {
            let block = self.chain.authenticate(raw);
            derive_block(&mut self.full, &block, &self.rules, &self.verifier)
                .map_err(|error| eyre!("native derivation of L1 block {}: {error}", block.header.number))?;
        }
        Ok(())
    }
}

/// A proof the prover must not buy on its own: the requester account cannot
/// pay for it, or a request ended without a proof, or the network may have
/// accepted a request whose ID was not kept. Retrying cannot help, or could
/// pay twice.
#[derive(Debug)]
pub struct Halt(pub String);

impl std::fmt::Display for Halt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Halt {}

/// One proof a run requests: its mode and the gas the prover network bills.
#[derive(Clone, Copy, Debug)]
pub struct ProofRequest {
    pub mode: SP1ProofMode,
    pub gas: u64,
}

/// The prover network's price for a set of requests, in PROVE wei: base fees
/// plus gas at the network's floor price, and at the most a request offers by
/// default (the network's maximum with the SDK's buffer).
pub struct Quote {
    pub gas: u64,
    pub low: u128,
    pub high: u128,
}

impl std::fmt::Display for Quote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let prove = |wei: u128| wei as f64 / 1e18;
        write!(
            f,
            "{:.2}B gas, {:.4} to {:.4} PROVE",
            self.gas as f64 / 1e9,
            prove(self.low),
            prove(self.high)
        )
    }
}

/// A proof mode's price per request: the base fee, and the network's floor
/// and the most a request offers per unit of gas (the network's maximum with
/// the SDK's buffer), in PROVE wei.
struct Price {
    base: u128,
    floor: u128,
    most: u128,
}

impl Price {
    /// The most a request of `gas` can cost.
    fn most(&self, gas: u64) -> u128 {
        self.base + self.most * u128::from(gas)
    }
}

/// Where proofs come from.
enum Backend {
    /// SP1's mock prover, which wraps the committed output in a placeholder
    /// proof of the same mode.
    Mock,
    /// SP1's CPU prover on this machine.
    Cpu(CpuProver),
    /// Succinct's prover network.
    Network(Box<NetworkProver>),
}

/// The range and aggregation programs with their keys. Each program runs in
/// the executor first and must exit with code 0, and its proof then comes
/// from the backend.
pub struct Programs {
    client: MockProver,
    backend: Backend,
    pub range: SP1ProvingKey,
    pub aggregation: Option<SP1ProvingKey>,
    requests: RefCell<Vec<ProofRequest>>,
}

impl Programs {
    pub fn load(range: &Path, aggregation: Option<&Path>) -> Result<Self> {
        let client = ProverClient::builder().mock().build();
        let setup = |path: &Path| -> Result<SP1ProvingKey> {
            let elf = Elf::from(std::sync::Arc::<[u8]>::from(std::fs::read(path)?));
            client.setup(elf).map_err(|error| eyre!("{error}"))
        };
        Ok(Self {
            range: setup(range)?,
            aggregation: aggregation.map(setup).transpose()?,
            client,
            backend: Backend::Mock,
            requests: RefCell::default(),
        })
    }

    /// Prove on Succinct's prover network, paid by the requester account
    /// whose key is in `NETWORK_PRIVATE_KEY`.
    pub fn with_network(mut self) -> Result<Self> {
        let key = std::env::var("NETWORK_PRIVATE_KEY").map_err(|_| eyre!("NETWORK_PRIVATE_KEY is not set"))?;
        self.backend = Backend::Network(Box::new(ProverClient::builder().network().private_key(key.trim()).build()));
        Ok(self)
    }

    /// Prove with SP1's CPU prover on this machine.
    pub fn with_cpu(mut self) -> Self {
        self.backend = Backend::Cpu(ProverClient::builder().cpu().build());
        self
    }

    /// Whether proofs are real, for a verifier that checks them.
    pub fn real(&self) -> bool {
        !matches!(self.backend, Backend::Mock)
    }

    /// A program's verification key: the digest guests verify proofs
    /// against, and the BN254 form on-chain verifiers take.
    pub fn vkey(key: &SP1ProvingKey) -> ([u32; 8], B256) {
        let vk = key.verifying_key();
        (vk.hash_u32(), B256::from(vk.bytes32_raw()))
    }

    /// Run a program. A guest panic is an execution with a nonzero exit code,
    /// not an error, so it is turned into one here.
    fn execute(
        &self,
        key: &SP1ProvingKey,
        stdin: SP1Stdin,
        verify_inner_proofs: bool,
    ) -> Result<(SP1PublicValues, ExecutionReport, Duration)> {
        let started = Instant::now();
        let (public_values, report) = self
            .client
            .execute(key.elf().clone(), stdin)
            .deferred_proof_verification(verify_inner_proofs)
            .run()
            .map_err(|error| eyre!("{error}"))?;
        ensure!(report.exit_code == 0, "program exited with code {}", report.exit_code);
        Ok((public_values, report, started.elapsed()))
    }

    /// The proof of a run the executor measured: the one kept in `saved`, or
    /// one from the network, with the measured cycles and gas as limits, or a
    /// mock proof. A proof is kept under a name committing to the program, the
    /// proof mode and the public values, so a proof of anything else is never
    /// found in its place.
    fn proof(
        &self,
        key: &SP1ProvingKey,
        stdin: SP1Stdin,
        mode: SP1ProofMode,
        report: &ExecutionReport,
        public_values: SP1PublicValues,
        saved: Option<&Path>,
    ) -> Result<SP1ProofWithPublicValues> {
        let path = saved.map(|dir| {
            let statement = [Self::vkey(key).1.as_slice(), public_values.as_slice()].concat();
            dir.join(format!("{mode:?}-{}.proof", keccak256(statement)))
        });
        if let Some(path) = path.as_ref().filter(|path| path.exists()) {
            println!("reusing {}", path.display());
            return SP1ProofWithPublicValues::load(path).map_err(|error| eyre!("{}: {error}", path.display()));
        }
        let gas = report.gas().unwrap_or_default();
        self.requests.borrow_mut().push(ProofRequest { mode, gas });
        let proof = match &self.backend {
            Backend::Mock => SP1ProofWithPublicValues::create_mock_proof(
                key.verifying_key(),
                public_values,
                mode,
                self.client.version(),
            ),
            Backend::Cpu(cpu) => {
                let request = cpu.prove(key, stdin);
                let request = match mode {
                    SP1ProofMode::Compressed => request.compressed(),
                    SP1ProofMode::Plonk => request.plonk(),
                    _ => { bail!("unexpected proof mode {mode:?}"); }
                };
                let started = Instant::now();
                let proof = request.run().map_err(|error| eyre!("{error}"))?;
                println!("CPU {mode:?} proof: {:?}", started.elapsed());
                proof
            }
            Backend::Network(network) => {
                let path = path.as_ref().ok_or_else(|| eyre!("network proofs are kept in a directory"))?;
                self.network_proof(network, key, stdin, mode, report, public_values, &path.with_extension("request"))?
            }
        };
        if let Some(path) = &path {
            let partial = path.with_extension("partial");
            proof.save(&partial).map_err(|error| eyre!("{}: {error}", partial.display()))?;
            std::fs::rename(&partial, path)?;
        }
        Ok(proof)
    }

    /// A proof from the network. The file `request` is written before a
    /// request is sent and holds its ID once the network accepts it, so a
    /// later attempt waits for that request instead of paying for another.
    /// When the request ends without a proof, or the network may have
    /// accepted it without its ID being kept, the prover halts and leaves the
    /// file; deleting it allows a new request.
    #[allow(clippy::too_many_arguments, reason = "one proof's whole description")]
    fn network_proof(
        &self,
        network: &NetworkProver,
        key: &SP1ProvingKey,
        stdin: SP1Stdin,
        mode: SP1ProofMode,
        report: &ExecutionReport,
        public_values: SP1PublicValues,
        request: &Path,
    ) -> Result<SP1ProofWithPublicValues> {
        let gas = report.gas().unwrap_or_default();
        let file = request.display();
        let kept = request.exists().then(|| std::fs::read_to_string(request)).transpose()?;
        let id = match kept {
            Some(kept) => {
                let Ok(id) = kept.trim().parse::<B256>() else {
                    bail!(Halt(format!(
                        "a network {mode:?} request may have been accepted without its ID being kept: \
                         check the requester's requests, then delete {file} to request again"
                    )));
                };
                println!("waiting for network {mode:?} request {id}");
                id
            }
            None => {
                let most = Self::price(network, mode)?.most(gas);
                let balance = network.get_balance().map_err(|error| eyre!("{error}"))?;
                if balance < U256::from(most) {
                    bail!(Halt(format!(
                        "the requester account holds {balance} PROVE wei; this {mode:?} proof may cost up to {most}"
                    )));
                }
                let cycles = report.total_instruction_count();
                let builder = network
                    .prove(key, stdin)
                    .cycle_limit(cycles + cycles / 10)
                    .gas_limit(gas + gas / 10)
                    .skip_simulation(true);
                let builder = match mode {
                    SP1ProofMode::Compressed => builder.compressed(),
                    SP1ProofMode::Plonk => builder.plonk(),
                    _ => { bail!("unexpected proof mode {mode:?}"); }
                };
                std::fs::write(request, "")?;
                let id = builder.request().map_err(|error| {
                    Halt(format!(
                        "network {mode:?} request: {error}; the network may have accepted it: \
                         check the requester's requests, then delete {file} to request again"
                    ))
                })?;
                std::fs::write(request, id.to_string())
                    .map_err(|error| Halt(format!("network request {id} was accepted, but {file}: {error}")))?;
                println!("network {mode:?} request {id}: {:.2}B gas", gas as f64 / 1e9);
                id
            }
        };
        let started = Instant::now();
        let proof = match network.wait_proof(id, None, None) {
            Ok(proof) => proof,
            Err(error) => {
                use sp1_sdk::network::Error;
                let ended = error.downcast_ref::<Error>().is_some_and(|error| {
                    matches!(
                        error,
                        Error::RequestUnexecutable { .. }
                            | Error::RequestUnfulfillable { .. }
                            | Error::RequestReverted { .. }
                            | Error::RequestExpired { .. }
                            | Error::RequestTimedOut { .. }
                            | Error::RequestAuctionTimedOut { .. }
                    )
                });
                if ended {
                    bail!(Halt(format!(
                        "network request {id} ended without a proof: {error}; delete {file} to request again"
                    )));
                }
                bail!("network request {id}: {error}");
            }
        };
        ensure!(
            proof.public_values.as_slice() == public_values.as_slice(),
            "the network's proof commits other public values"
        );
        println!("network {mode:?} proof {id}: {:?}", started.elapsed());
        Ok(proof)
    }

    /// The proofs requested since the last call.
    pub fn take_requests(&self) -> Vec<ProofRequest> {
        std::mem::take(&mut *self.requests.borrow_mut())
    }

    /// The network's price for a proof mode, in PROVE wei.
    fn price(network: &NetworkProver, mode: SP1ProofMode) -> Result<Price> {
        let params = network
            .get_proof_request_params(mode)
            .map_err(|error| eyre!("{error}"))?;
        let GetProofRequestParamsResponse::Auction(params) = params else {
            bail!("the network does not price requests by auction");
        };
        let buffer = u128::from(sp1_sdk::network::DEFAULT_MAX_PRICE_PER_PGU_BUFFER);
        Ok(Price {
            base: params.base_fee.parse()?,
            floor: params.network_floor_price_per_pgu.parse()?,
            most: params.max_price_per_pgu.parse::<u128>()? * buffer / 100,
        })
    }

    /// Price `requests` on the prover network. Reading prices needs no funds,
    /// so without a requester key a throwaway one is used.
    pub fn quote(&self, requests: &[ProofRequest]) -> Result<Quote> {
        let throwaway;
        let network = match &self.backend {
            Backend::Network(network) => network,
            _ => {
                let key = alloy_signer_local::PrivateKeySigner::random().to_bytes();
                throwaway = ProverClient::builder().network().private_key(&key.to_string()).build();
                &throwaway
            }
        };
        let mut quote = Quote { gas: 0, low: 0, high: 0 };
        for request in requests {
            let price = Self::price(network, request.mode)?;
            quote.gas += request.gas;
            quote.low += price.base + price.floor * u128::from(request.gas);
            quote.high += price.most(request.gas);
        }
        Ok(quote)
    }

    fn range_stdin(source: &Source, start: Option<RangeStart>, blocks: &[RawBlock]) -> SP1Stdin {
        let mut stdin = SP1Stdin::new();
        stdin.write(source);
        stdin.write(&start);
        stdin.write(&blocks.to_vec());
        stdin
    }

    /// Run the range program on `blocks`.
    pub fn range(
        &self,
        source: &Source,
        start: Option<RangeStart>,
        blocks: &[RawBlock],
    ) -> Result<(PublicValues, ExecutionReport, Duration)> {
        let (public_values, report, elapsed) =
            self.execute(&self.range, Self::range_stdin(source, start, blocks), true)?;
        Ok((PublicValues::abi_decode(public_values.as_slice())?, report, elapsed))
    }

    /// Prove the range program on `blocks`: a compressed proof, which the
    /// aggregation program verifies.
    pub fn prove_range(
        &self,
        source: &Source,
        start: Option<RangeStart>,
        blocks: &[RawBlock],
        saved: Option<&Path>,
    ) -> Result<(SP1ProofWithPublicValues, ExecutionReport, Duration)> {
        let stdin = Self::range_stdin(source, start, blocks);
        let (public_values, report, elapsed) = self.execute(&self.range, stdin.clone(), true)?;
        let proof = self.proof(&self.range, stdin, SP1ProofMode::Compressed, &report, public_values, saved)?;
        Ok((proof, report, elapsed))
    }

    /// Prove the aggregation of `ranges`: a PLONK proof for an on-chain
    /// verifier. The range proofs are attached for the program to verify.
    pub fn prove_aggregation(
        &self,
        ranges: Vec<SP1ProofWithPublicValues>,
        headers: Vec<Vec<u8>>,
        prover_address: Address,
        saved: Option<&Path>,
    ) -> Result<(AggregationOutputs, SP1ProofWithPublicValues)> {
        let key = self.aggregation.as_ref().ok_or_else(|| eyre!("no aggregation program"))?;
        let mut stdin = SP1Stdin::new();
        stdin.write(&AggregationInput {
            range_vkey: Self::vkey(&self.range).0,
            ranges: ranges.iter().map(|proof| proof.public_values.to_vec()).collect(),
            headers,
            prover_address,
        });
        for proof in ranges {
            let SP1Proof::Compressed(inner) = proof.proof else {
                bail!("a range proof is not compressed");
            };
            stdin.write_proof(*inner, self.range.verifying_key().vk.clone());
        }
        // The executor verifies real range proofs before the aggregation is
        // requested; a mock range proof holds no proof to verify.
        let (public_values, report, elapsed) = self.execute(key, stdin.clone(), self.real())?;
        println!(
            "aggregation: {} cycles, {} gas, executor {elapsed:?}",
            report.total_instruction_count(),
            report.gas().unwrap_or_default()
        );
        let outputs = AggregationOutputs::abi_decode(public_values.as_slice())?;
        let proof = self.proof(key, stdin, SP1ProofMode::Plonk, &report, public_values, saved)?;
        Ok((outputs, proof))
    }
}

/// Prove `blocks` as consecutive ranges of `range_blocks` from `native`'s
/// state, and check each range against native derivation. With `saved`, the
/// proofs are kept there.
pub fn prove_ranges(
    programs: &Programs,
    native: &mut Native,
    source: &Source,
    blocks: &[RawBlock],
    range_blocks: usize,
    saved: Option<&Path>,
) -> Result<Vec<SP1ProofWithPublicValues>> {
    let mut proofs = Vec::new();
    for range in blocks.chunks(range_blocks.max(1)) {
        let pre = native.checkpoint();
        let start = native.range(range)?;
        let post = native.checkpoint();
        let witness_bytes = start.as_ref().map_or(0, |start| start.witness.len());
        let (proof, report, elapsed) = programs.prove_range(source, start, range, saved)?;
        let values = PublicValues::abi_decode(proof.public_values.as_slice())?;
        ensure!(
            values.preBlockHash == pre.block_hash && values.preAux == pre.aux,
            "range at PCASH {} starts from another checkpoint",
            values.pcashNumber
        );
        ensure!(
            values.pcashHash == post.block_hash && values.aux == post.aux,
            "range at PCASH {} reaches checkpoint {}/{}, native derivation {}/{}",
            values.pcashNumber,
            values.pcashHash,
            values.aux,
            post.block_hash,
            post.aux
        );
        let expected_l1 = range.last().map(|block| keccak256(&block.header)).unwrap_or_default();
        ensure!(values.l1Hash == expected_l1, "range L1 hash differs from the fetched block");
        let mut phases: Vec<String> = report
            .cycle_tracker
            .iter()
            .map(|(phase, cycles)| format!("{phase} {cycles}"))
            .collect();
        phases.sort();
        println!(
            "range L1 {}..={}, PCASH {}: witness {witness_bytes} bytes, {} cycles, {} gas, executor {elapsed:?}; {}",
            values.l1Number + 1 - range.len() as u64,
            values.l1Number,
            values.pcashNumber,
            report.total_instruction_count(),
            report.gas().unwrap_or_default(),
            phases.join(", ")
        );
        proofs.push(proof);
    }
    Ok(proofs)
}
