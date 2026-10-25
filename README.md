# PCASH

PCASH is private money Ethereum can program. Like other private money, its payments hide the sender, recipient, asset and amount. PCASH is the native asset, and anyone can create another that moves with the same privacy. Every PCASH account decides privately what it takes to spend its money, anyone can write a rule, a rule can depend on anything public, including Ethereum, and Ethereum contracts can move PCASH. A payment can also carry a private proof of where its funds came from. PCASH runs on Ethereum's consensus, so it has no validators or security budget of its own, and a trade for ETH settles in one Ethereum transaction with no custodian.

Read the [white paper](docs/whitepaper.md) for the case, [Security](docs/security.md) for how PCASH protects its money, and the [protocol specification](docs/protocol-spec.md) for the exact rules.

## What's here

- [`node/`](node/): the Rust node. It computes PCASH from Ethereum's history, verifies proofs, and serves wallets.
- [`sdk/`](sdk/): the TypeScript protocol library that builds and proves transactions.
- [`wallet/`](wallet/) and [`relayer/`](relayer/): a headless wallet, and a relayer that publishes other people's transactions.
- [`circuits/`](circuits/): the protocol circuits and the reference account rules ([README](circuits/README.md)).
- [`marketplace/`](marketplace/): PCASH-for-ETH trades through escrow ([README](marketplace/README.md)).
- [`lineage/`](lineage/): an event application that certifies where PCASH came from ([README](lineage/README.md)).
- [`web/`](web/): the website, with its wallet, marketplace, explorer, tokens, messages and documents.
- [`e2e/`](e2e/): end-to-end scenarios against real nodes ([README](e2e/README.md)).

Also here: `bench/` (the browser proving lab), `vectors/` (cross-language conformance fixtures), `assets/` (network, circuit and toolchain inputs), `test-support/`, `scripts/` and `compose/`.

## Documentation

Everything under [`docs/`](docs/) is published on the website.

- [White paper](docs/whitepaper.md): what PCASH is and why.
- [Security](docs/security.md): how PCASH protects its money and the people who use it, and the latest security review. [`SECURITY.md`](SECURITY.md) says how to report a vulnerability.
- [Building on PCASH](docs/guides/building-on-pcash.md): what applications can do with account rules and contracts.
- [Running a node](docs/guides/running-a-node.md): running and configuring a node and the wallet service.
- [Protocol specification](docs/protocol-spec.md): the exact rules every implementation follows. It is normative.
- [Terms of Service](docs/terms.md) and [Privacy Policy](docs/privacy.md) for the website.

## Prerequisites

The local workflow needs Rust, Node.js 24.12 or newer, `just`, `direnv`, and `tar`. On macOS, install the package-manager prerequisites without executing a remote shell pipeline:

```bash
# Rust, Cargo, Node.js, just, and direnv
brew install rustup-init node just direnv
rustup-init
```

Install the [direnv shell hook](https://direnv.net/docs/hook.html) once for your shell so entering the repository loads its approved environment.

Install the root npm workspace, then install and verify the repository-pinned prover toolchain:

```bash
npm install
just tools
just tools-check
```

`just tools` verifies the SHA-256 digest of each pinned Nargo, Barretenberg and CRS archive before installing it under the ignored `.pcash-tools/` directory, and `just tools-check` verifies an installation without downloading anything. `PCASH_TOOL_ROOT` selects another root. The node checks the same `bb` digest at startup.

Cargo downloads Rust dependencies automatically. Foundry's Soldeer installs checksum-locked `forge-std` archives under each Solidity project's ignored `dependencies/` directory.

## Run a node

With the prerequisites installed, `just build` builds the release node, and [Running a node](docs/guides/running-a-node.md) covers configuring and running it. With `--enable-catalog`, a node also serves the optional publication catalog that marketplace offers and token drops use for discovery; the catalog is not consensus. For local development, `just anvil`, `just node` and `just web` start Anvil, a node and the website.

## Develop and test

Select Node 24.12 or newer and Foundry 1.8.5 or newer.

- `just setup` installs checkout-local dependencies, regenerates the checked-in generated files, builds the circuit bundle and regenerates the release pins. Review the generated changes before committing. How circuit bundles work is in [`circuits/README.md`](circuits/README.md#circuit-bundles).
- `just ci` runs the core validation suite against one freshly generated circuit bundle. `just ci-fast` skips circuit generation.
- `just ci-acceptance` runs real-node scenarios, `just ci-browser` runs browser proving and the wallet and marketplace journeys, and `just ci-all` runs everything once. `node scripts/ci-all.mjs <suite> --list` shows a selection without running it.
- `just e2e` runs the end-to-end scenarios against a fresh local Anvil ([`e2e/README.md`](e2e/README.md)), and `just test-anvil-reorg` runs the Anvil-backed reorg gate.

## License and security

PCASH is licensed under the [Apache License 2.0](LICENSE). Report vulnerabilities privately, as [`SECURITY.md`](SECURITY.md) describes. This repository is published as snapshots of the development repository, without its commit history.
