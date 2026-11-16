repo-root := justfile_directory()
# The one prover tool root: every recipe and the processes it starts read this.
export PCASH_TOOL_ROOT := absolute_path(env("PCASH_TOOL_ROOT", ".pcash-tools"))
foundry-min := "1.8.5"

default:
    @just --list

# Install checkout-local dependencies and bring every generated file and release pin up to date.
setup:
    just _ci-setup
    just generate
    just pins

# Regenerate the checked-in files derived from assets/ and the circuit catalog; --check verifies them instead.
[positional-arguments]
generate *args:
    node "{{ repo-root }}/scripts/generate.mjs" "$@"

# Regenerate the pins derived from the circuit bundle and the installed toolchain; --check verifies them instead.
[positional-arguments]
pins *args:
    node "{{ repo-root }}/scripts/circuits/gen_release_pins.mjs" "$@"

# Install the release-pinned Nargo, Barretenberg, and CRS under this checkout.
tools:
    node "{{ repo-root }}/scripts/bootstrap_prover_toolchain.mjs"

# Verify the checkout-local prover toolchain without downloading anything.
tools-check:
    node "{{ repo-root }}/scripts/bootstrap_prover_toolchain.mjs" --check

# Check the issuance policy and frozen vectors with independent Python integers.
test-issuance-python:
    python3 "{{ repo-root }}/scripts/issuance/check_issuance_vectors.py" "{{ repo-root }}/vectors/issuance.json"

# Generate or reuse the content-addressed development circuit bundle.
circuit-bundle:
    node "{{ repo-root }}/scripts/circuits/bundle.mjs" --print-path

# Run package, Rust, circuit, contract, and generated-artifact checks.
ci:
    node "{{ repo-root }}/scripts/ci-all.mjs" core

# Run checks that need no circuit bundle or prover installation.
ci-fast:
    node "{{ repo-root }}/scripts/ci-all.mjs" fast

# Run real-node acceptance scenarios.
ci-acceptance:
    node "{{ repo-root }}/scripts/ci-all.mjs" acceptance

# Run browser protocol, wallet, and marketplace integration tests.
ci-browser:
    node "{{ repo-root }}/scripts/ci-all.mjs" browser

# Run every portable validation suite, continuing independent checks after failures.
ci-all:
    node "{{ repo-root }}/scripts/ci-all.mjs" all

# Run the marketplace browser journey with the installed dependencies.
marketplace-journeys: tools-check _solidity-dependencies
    npm run web:browser-marketplace-journey

# Run the real MetaMask extension smoke test.
e2e-metamask:
    node "{{ repo-root }}/scripts/ci-all.mjs" metamask

_setup-node-and-prover:
    #!/usr/bin/env bash
    set -euo pipefail
    npm_config_cache="{{ repo-root }}/.cache/pcash/npm" npm ci
    node --test scripts/bootstrap_prover_toolchain.test.mjs
    just tools

_ci-setup:
    just _setup-node-and-prover
    just _solidity-dependencies

_solidity-dependencies:
    #!/usr/bin/env bash
    set -euo pipefail
    for project in marketplace/l1-contracts; do
        (
            cd "{{ repo-root }}/$project"
            forge soldeer install --config-location foundry
        )
    done

_ci-noir-format:
    #!/usr/bin/env bash
    set -euo pipefail
    nargo="$PCASH_TOOL_ROOT/nargo/nargo"
    "$nargo" fmt --check --workspace --program-dir "{{ repo-root }}/circuits"
    find "{{ repo-root }}/marketplace/l2-contracts" "{{ repo-root }}/web/tokens/l2-contracts" "{{ repo-root }}/lineage/l2-contracts" -name Nargo.toml -not -path '*/target/*' | sort | while read -r manifest; do
        "$nargo" fmt --check --program-dir "$(dirname "$manifest")"
    done

# Build the optimized node binary.
build:
    node "{{ repo-root }}/scripts/circuits/bundle.mjs" exec -- cargo build --release -p pcash-node --bin pcash-node

# Start a fresh local Anvil; --anvil-chain-id=0 selects a random chain ID.
[positional-arguments]
anvil *options:
    node "{{ repo-root }}/scripts/dev/run.mts" anvil "$@"

# Prepare a pinned empty-genesis launch from finalized L1 metadata.
[positional-arguments]
prepare-launch *args:
    @node "{{ repo-root }}/scripts/prepare_launch.mjs" "$@"

# Build in debug mode by default, then run one node from environment configuration.
node:
    node "{{ repo-root }}/scripts/dev/run.mts" node

# Run the real-JSON-RPC Anvil branch-replacement integration test.
test-anvil-reorg:
    cargo test -p pcash-node --test anvil_reorg anvil_rpc_reorg_replaces_payout_notes_and_matches_clean_derivation -- --ignored --exact --nocapture

# Post a real batch to a local Anvil and check the mined calldata byte for byte.
test-anvil-relay:
    npm test --workspace @pcash/sdk -- --run test/relayer.anvil.test.ts

# Print the current node status through its public RPC.
status:
    @response=$(curl --fail --silent --show-error -X POST http://{{ env_var_or_default("PCASH_RPC_ADDR", "127.0.0.1:8645") }} \
        -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"pcash_status","params":[]}') && printf '%s\n' "$response" | jq

# Run the manual derivation benchmark (set_leaves batching and apply_block cost).
bench-derivation:
    cargo bench -p pcash-node --features benchmarks --bench derivation

# Derive worst-case blocks of forced proof verifications with the pinned verifier.
bench-forced-verification:
    node scripts/circuits/bundle.mjs exec -- cargo bench -p pcash-node --features benchmarks --bench forced_verification

# Launch the aggregate browser proving benchmark.
bench:
    npm run dev --workspace @pcash/bench

# Run one wallet HTTP server from environment configuration.
wallet:
    node "{{ repo-root }}/scripts/dev/run.mts" wallet

# Run one fallback relayer from environment configuration.
relayer:
    node "{{ repo-root }}/scripts/dev/run.mts" relayer

# Launch the website; options: --marketplace, --web-fresh (reset browser state and code cache).
[positional-arguments]
web *options:
    node "{{ repo-root }}/scripts/dev/run.mts" web "$@"

# Build the complete Explorer fixture against a running local stack.
seed:
    @just e2e-live seed

# Seed a running stack and record it as the Explorer's fixture data.
record-fixtures:
    PCASH_E2E_SEED_RECORD_DIR="{{ repo-root }}/web/src/routes/explorer/fixtures/recorded" PCASH_E2E_SEED_VOLUME_TRANSFERS="${PCASH_E2E_SEED_VOLUME_TRANSFERS:-32}" just e2e-live seed

# Run the default scenarios, or the named ones, against fresh local Anvil and nodes.
[positional-arguments]
e2e *args: tools-check _solidity-dependencies
    npm run e2e -- "$@"

# Run scenarios against a running network: PCASH_E2E_RPC_URL, PCASH_E2E_L1_RPC, PCASH_E2E_L1_KEY (or .envrc.e2e); defaults target `just e2e-up`.
[positional-arguments]
e2e-live *args: tools-check _solidity-dependencies
    node --env-file-if-exists="{{ repo-root }}/.envrc.e2e" "{{ repo-root }}/e2e/src/run.ts" --network live "$@"

# Serve local Anvil and a node on the default ports for `just e2e-live`, until interrupted.
e2e-up: tools-check
    npm run e2e -- --up

# Start the local Prometheus and Grafana metrics stack.
metrics-up:
    docker compose up -d --wait

# Stop the local Prometheus and Grafana metrics stack.
metrics-down:
    docker compose down

# Show the status of the metrics stack containers.
metrics-status:
    docker compose ps

# Run the core Noir workspace with the checkout-local pinned compiler.
test-noir: tools
    "$PCASH_TOOL_ROOT/nargo/nargo" test --workspace --program-dir "{{ repo-root }}/circuits"

# Run the marketplace Noir packages with the checkout-local pinned compiler.
test-marketplace-noir: tools
    "$PCASH_TOOL_ROOT/nargo/nargo" test --program-dir "{{ repo-root }}/marketplace/l2-contracts/escrow/common"
    "$PCASH_TOOL_ROOT/nargo/nargo" test --program-dir "{{ repo-root }}/marketplace/l2-contracts/escrow/claim"
    "$PCASH_TOOL_ROOT/nargo/nargo" test --program-dir "{{ repo-root }}/marketplace/l2-contracts/escrow/reclaim"

# Run the token claim-template Noir packages with the checkout-local pinned compiler.
test-tokens-noir: tools
    "$PCASH_TOOL_ROOT/nargo/nargo" test --program-dir "{{ repo-root }}/web/tokens/l2-contracts/claim-link/claim"
    "$PCASH_TOOL_ROOT/nargo/nargo" test --program-dir "{{ repo-root }}/web/tokens/l2-contracts/drop/claim"
    "$PCASH_TOOL_ROOT/nargo/nargo" test --program-dir "{{ repo-root }}/web/tokens/l2-contracts/drop/reclaim"
