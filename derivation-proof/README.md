# Derivation proof

A succinct proof that PCASH's rules, applied to Ethereum's history, produce a given PCASH block. An Ethereum contract checks the proof and records the block, so a light client or another contract can rely on PCASH state without running a node.

Nothing in the protocol depends on these proofs. Anyone can deploy the contract and anyone can prove it forward; no deployment or prover is official.

## What it trusts

A node trusts only Ethereum and PCASH's own proofs. Whatever relies on a root this contract records also trusts:

- SP1 6.10.0, the zkVM that runs the programs, and its recursion;
- SP1's PLONK wrap over BN254, whose reference string comes from Aztec's Ignition ceremony, the same one PCASH's own proofs use;
- SP1's v6.1.0 PLONK verifier contract, `0xc3c6dDDAc8829b233Dc6536Ec024775a57b0AF2A` on Ethereum and Sepolia, which has no owner;
- the programs in this directory, which run the node's derivation code and link bb's Chonk verifier at the version the node pins.

## Parts

- `guest/`: the range program. It authenticates a run of Ethereum blocks, their receipts and the blobs inbox carriers name, derives the PCASH blocks they produce from the state before them, and commits the checkpoints before and after. `verdicts` is its proof verifier on its own.
- `aggregation/`: verifies a chain of range proofs and commits what the contract checks: the checkpoints before and after, the network, the range program's key, an Ethereum block the derivation leads to, and the prover.
- `contracts/`: `PcashState`, which holds the latest proven checkpoint and advances it by its interval with each proof, and `ExecutedVerifier`, which stands in for SP1's verifier in development.
- `host/`: the command-line tool that bootstraps state, deploys the contract, proves it forward, and checks the programs.
- `bb/`: bb's Chonk verifier cross-compiled for SP1's RISC-V target.
- `core/`, `types/`: code the programs and the host share.

## Build

The programs build in a pinned linux/amd64 image, so a build anywhere gives the same programs and the same keys. Building needs Docker, Node 24, and the prover toolchain and circuit bundle the node uses:

```bash
export PCASH_TOOL_ROOT=$PWD/.pcash-tools PCASH_CIRCUIT_CACHE=$PWD/.cache/pcash/circuit-bundles
node scripts/bootstrap_prover_toolchain.mjs
derivation-proof/build-guest.sh
derivation-proof/build-guest.sh aggregation
```

`build-guest.sh` sets up SP1's toolchain and bb's verifier under `PCASH_SP1_ROOT` (`.cache/pcash/sp1` by default) on its first run, and prints the ELF's path. The range program, the aggregation program and `verdicts` land in `derivation-proof/target/guest/riscv64im-succinct-zkvm-elf/release/`.

The host builds natively and needs `protoc` and Go, for SP1's PLONK backend:

```bash
derivation-proof/build-host.sh
```

`forge build` in `contracts/` compiles the contract for `deploy`.

## Relying on a contract

Deploy your own `PcashState` to rely on: anyone can, and anyone can prove it forward. A bridge can create its own in its constructor. A deployment someone else made can be relied on only once you have established that it is exactly `PcashState` built from this source, with the verifier, program keys and network you expect, anchored at a block your own node derives.

`prover --quote` prices the next interval's proofs on the prover network and sends nothing:

```bash
derivation-proof-host prover --quote --l1-rpc <url> --beacon-api <url> --node-rpc <your node> \
  --elf <range ELF> --aggregation-elf <aggregation ELF> --contract <address> --state-dir <dir> --range-blocks <blocks>
```

## Prove

`bootstrap` derives the network to a finalized PCASH block and saves its state. `deploy` deploys `PcashState` anchored there, verifying proofs with SP1's PLONK verifier, and refuses a chain without it at its address (on Anvil, copy its code there with `anvil_setCode`); `--interval` sets the PCASH blocks per proof.

```bash
derivation-proof-host bootstrap --l1-rpc <url> --beacon-api <url> --node-rpc <url> --state-dir <dir> --start-block <n>
derivation-proof-host deploy --l1-rpc <url> --node-rpc <url> --elf <range ELF> --aggregation-elf <aggregation ELF> \
  --contracts derivation-proof/contracts --state-dir <dir> --start-block <n> --interval <blocks> --private-key-env <VAR>
```

`--beacon-api` is a Beacon endpoint that still serves the blobs of every block derived: from the network's anchor for `bootstrap`, as a node needs. Without it the Ethereum endpoint is asked, which serves blobs only on Anvil.

`prover` keeps the state at the contract's anchor, waits for the next interval's last Ethereum block to be finalized, derives it, proves it, and submits it with `proveBlock`:

```bash
derivation-proof-host prover --l1-rpc <url> --beacon-api <url> --node-rpc <url> \
  --elf <range ELF> --aggregation-elf <aggregation ELF> \
  --contract <address> --state-dir <dir> --range-blocks <blocks> --proofs network --intervals <k> --private-key-env <VAR>
```

- Before running anything, `prover` requires the contract's verifier to be SP1's PLONK verifier, so it never pays for proofs the contract would reject (with `--proofs mock`, `ExecutedVerifier` as compiled in `--contracts`), and its configuration and keys to match the programs'. It then compares the anchor with its own derivation.
- `--proofs network` buys proofs on Succinct's prover network, paid in PROVE by the account whose key is in `NETWORK_PRIVATE_KEY`. It requires `--intervals`, so proving stops.
- `--proofs cpu` proves on this machine. It is practical only for intervals of a few blocks without PCASH transactions: two empty blocks took 22 minutes and 99 GB of memory on an M5 Max.
- A network request's ID is saved before anything waits on it. A request that ends without a proof, or one that may have been accepted without its ID being saved, stops the prover until you check the requester's requests and delete the request file.
- A proof is bound to the account that submits it.
- The contract reads the proof's Ethereum head from EIP-2935's history of the last 8191 blocks, about 27 hours. A proof not submitted in time is not lost: the prover takes a new head and proves only the aggregation again.
- The prover keeps each interval's Ethereum blocks and blobs with its state, since Beacon nodes drop blobs after about 18 days.

## Development

- `run` proves Ethereum blocks from the anchor as chained ranges in SP1's executor and compares the result with a node; `--tamper` alters the input and requires the range program to refuse it.
- `deploy --executed-verifier` with `prover --proofs mock --contracts derivation-proof/contracts` runs the whole flow without proofs: the contract checks the aggregation program's output from an executor run.
- `verdicts` runs the range program's proof verifier and the node's on the circuit bundle's known answers and on altered proofs, and requires the same answer to each.
