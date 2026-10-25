# Running a node

How to run the PCASH software yourself: a node and the wallet service. [The protocol specification](../protocol-spec.md) is normative. Installing the toolchains and building are covered in the repository [`README.md`](../../README.md).

## Run and configure a node

A node follows one Ethereum network through an execution JSON-RPC endpoint and a Beacon API ([Blob availability](#blob-availability)). Protocol rules, fork activations, and hiding-kernel verification keys are compiled into the binary, so one build serves every network: runtime configuration alone selects the chain, through the PCASH chain ID, L1 chain ID, inbox address, and exact L1 anchor. The node-only workflow needs no wallet or signing keys; funded keys are needed only for the live proving and payment loop.

Clone the source and install the [prerequisites](../../README.md#prerequisites). Every command below runs from the checkout:

```sh
git clone https://github.com/pcash-protocol/pcash
cd pcash
```

Copy the development configuration template, edit it, and approve it locally:

```sh
cp .envrc.example .envrc
$EDITOR .envrc
direnv allow
```

Every node sets its Ethereum endpoints and its own local settings:

```sh
export PCASH_L1_RPC="https://sepolia-rpc.example"
export PCASH_BEACON_API="http://127.0.0.1:5052"
export PCASH_L1_RPC_MAX_REQUESTS_PER_SECOND="30"
export PCASH_DATA_DIR="$PWD/.cache/pcash/sepolia-node"
export PCASH_RPC_ADDR="127.0.0.1:8645"
export PCASH_POLL_SECS="4"
```

The chain the node follows is selected in one of two ways: by naming a network, or by supplying a network's identity.

### Join a named network

`--network` / `PCASH_NETWORK` selects a network compiled into the binary: its PCASH chain ID, L1 chain ID, inbox address, and L1 anchor, and the public bootnode addresses of the nodes that serve it. `testnet` is the PCASH test network on Sepolia:

```sh
export PCASH_NETWORK="testnet"
```

It replaces the five identity settings described next. Supplying the inbox address or anchor alongside it, as a flag or through the environment, is a startup error rather than a silent mix, so leave them out of `.envrc` when naming a network. The two chain IDs may stay, since the website reads them too, but each must equal the network's own value. `--p2p-bootnode` / `PCASH_P2P_BOOTNODES` adds peers to the network's list.

`mainnet` selects PCASH chain ID `231` on Ethereum mainnet. Its genesis anchor is not configured, so `--network mainnet` fails before connecting to L1 or opening state. Anchor overrides cannot enable the mainnet preset.

### Configure a custom network

Without `--network`, five settings identify the chain ([specification §3.1](../protocol-spec.md#31-configuration-and-chain-identity)):

```sh
export PCASH_CHAIN_ID="<PCASH chain ID>"
export PCASH_L1_CHAIN_ID="11155111"
export PCASH_INBOX_ADDRESS="0x00000000000000000000000000000000000CA511"
export PCASH_GENESIS_L1_BLOCK="<anchor block number>"
export PCASH_GENESIS_L1_BLOCK_HASH="<anchor block hash>"
```

`PCASH_CHAIN_ID` (`--pcash-chain-id`) is the PCASH chain ID, which is distinct from the Ethereum chain ID in `PCASH_L1_CHAIN_ID` (`--l1-chain-id`). `PCASH_INBOX_ADDRESS` (`--inbox-address`) is the Ethereum address whose incoming transactions carry PCASH batches. `PCASH_GENESIS_L1_BLOCK` and `PCASH_GENESIS_L1_BLOCK_HASH` (`--genesis-l1-block`, `--genesis-l1-block-hash`) are the anchor: the first Ethereum block derivation reads, and its exact hash. To join an existing chain, use its exact values. A new chain takes a nonzero PCASH chain ID that no other chain uses. The L1 chain ID and the inbox default to the values shown, and the PCASH chain ID to the test network's; the anchor has no default, and both of its values are required.

Block zero commits these five values, so every node of one chain configures exactly the same five, and a node that differs in any of them derives a different genesis hash. Before opening state the node checks that the L1 RPC reports the configured Ethereum chain ID, that the anchor block is finalized, and that its hash matches. A data directory belongs to one chain; start a different chain with an empty one.

A custom network has no compiled bootnodes. Name its peers with `--p2p-bootnode` / `PCASH_P2P_BOOTNODES`, which takes a comma-separated list of multiaddresses, or add them while the node runs ([Peer management](#peer-management)).

### Start the node

`just node` builds the node and runs it from this configuration. It selects the checkout's `.pcash-tools` through `PCASH_TOOL_ROOT` and passes the absolute path of the repository's source reproducer through `PCASH_SOURCE_VERIFICATION_REPRODUCER`. The node checks the external verifier before starting, and a different bb release or arbitrary CRS file is rejected with a version/digest error. The node uses the reproducer to rebuild contract source submitted for verification.

`just build` builds the release binary at `target/release/pcash-node`. To run it directly, set `PCASH_TOOL_ROOT` to the prover tools that `just tools` installs, by default the checkout's `.pcash-tools`.

Query the running node from another terminal; the recipe needs `jq`:

```sh
just status
```

A start whose saved checkpoint cannot be validated or restored fails closed; the node never resynchronizes on its own. `--force-resync` authorizes a rebuild. It replaces only canonical state and the derived index: the mempool, catalog, wallet, and application files are separate stores and are not reset.

### Configure logging

The node writes full text logs to stdout without color by default. `--log-format` / `PCASH_LOG_FORMAT` selects `full`, `compact`, `pretty` (multiline text), or `json` (one structured event per line). `--log-color` / `PCASH_LOG_COLOR` selects `never` (the default), `auto`, or `always`. Auto enables color only when stdout is a terminal and `NO_COLOR` is unset or empty. JSON always disables color. CLI flags override their environment settings.

With the node configuration above, use explicit plain text or JSON for cloud log collectors:

```sh
pcash-node --log-format full --log-color never
pcash-node --log-format json
```

For `just node`, configure the same options through the environment:

```sh
PCASH_LOG_FORMAT=json just node
```

`RUST_LOG` controls filtering for every format, with `info` used when it is unset or invalid. For example, `RUST_LOG=debug PCASH_LOG_FORMAT=compact just node` enables debug logs in compact text. These settings control node log events; CLI help, argument errors, and process-exit diagnostics retain their own formatting.

## Blob availability

Every node requires `--beacon-api` or `PCASH_BEACON_API`. The node maps execution timestamps to Beacon slots, requests only the versioned hashes named by structurally valid inbox carriers, verifies every returned blob against its KZG versioned hash, restores transaction hash order, and decodes the canonical batch in memory. Blob bytes are not retained or exchanged over PCASH P2P.

When a required blob is absent or mismatched during canonical derivation, the node leaves that L1 block pending and retries it from the same cursor. Each retry refreshes canonical execution-layer state first, so an unavailable orphan cannot hide a reorganization. Cold replay and force resynchronization require the Beacon endpoint to serve every referenced historical slot in the replay range. Consensus clients keep blobs for about 18 days by default, so a node that starts or replays later needs an endpoint that keeps them, such as an archiving consensus node. Catching up or rebuilding the integrated projection reads only the node's stored canonical records; it fetches nothing from the execution or Beacon endpoint.

## Peer management

Pass `--admin-addr` / `PCASH_ADMIN_ADDR` (for example `127.0.0.1:8647`) to bind an operator-only JSON-RPC listener serving the `admin_*` namespace. When the flag is omitted the node binds no admin port: static peers can then only be configured at startup with `--p2p-bootnode`, automatic discovery still runs, and no operator source publication is possible.

This is a separate socket from `--rpc-addr` on purpose. The `pcash_*` port is unauthenticated and browser-reachable by design, so a page the operator visits must not be able to drive their node's dialer or read its peer topology. The admin listener serves HTTP only and applies no CORS layer — dropping CORS alone would not be enough, because browsers do not apply the same-origin policy to WebSockets. It is unauthenticated too: its bind address is its access control, so bind it to loopback or an operator-only network, never to a public interface.

`pcash-cli` reaches it with `--admin-url` / `PCASH_ADMIN_URL`:

```
pcash-cli --admin-url http://127.0.0.1:8647 node-info
pcash-cli --admin-url http://127.0.0.1:8647 add-peer /ip4/203.0.113.7/tcp/8646/p2p/12D3Koo...
pcash-cli --admin-url http://127.0.0.1:8647 peers --json
pcash-cli --admin-url http://127.0.0.1:8647 remove-peer 12D3Koo... --ban
```

`node-info` reports bound `listenAddresses` separately from `bootstrapAddresses`, the operator-advertised or automatically confirmed endpoints another node can dial. The latter includes active relay endpoints and can be empty while reachability is unknown. Its `network` object reports discovery mode, routing peers, pending dials, reachability, relay reservations and connection outcomes. `--p2p-advertise-addr` / `PCASH_P2P_ADVERTISE_ADDR` registers a known reachable TCP endpoint in the swarm as well as reporting it through admin RPC.

Discovery and automatic NAT connectivity default to `auto`. Set `--p2p-discovery off` / `PCASH_P2P_DISCOVERY=off` for static peering, and `--p2p-nat off` / `PCASH_P2P_NAT=off` to disable automatic UPnP, AutoNAT, relay reservations and hole punching. `--disable-p2p` disables the entire stack. `--p2p-target-peers` / `PCASH_P2P_TARGET_PEERS` controls the desired compatible outbound peer count. Repeat `--p2p-relay` or set comma-separated `PCASH_P2P_RELAYS` to supply relay seeds; compatible relay-capable peers are also learned through discovery. NATed nodes retain relay fallback if direct TCP hole punching fails.

A public node can serve bounded relay circuits with `--p2p-relay-server` / `PCASH_P2P_RELAY_SERVER=true`, together with its advertised direct TCP endpoint. It uses the existing public P2P port; no additional public UDP port is required.

For isolated development networks, `--p2p-allow-private-addresses` / `PCASH_P2P_ALLOW_PRIVATE_ADDRESSES=true` permits learned private endpoints. Public deployments reject private discovery targets; explicitly configured private peers remain dialable. Reachability and discovery outcomes are exposed under `pcash_p2p_*` metrics without peer/address labels.

A [named network](#join-a-named-network) supplies its own bootnodes, and `--p2p-bootnode` / `PCASH_P2P_BOOTNODES` adds peers to that list; on a custom network it is the whole list.

A peer added with `add-peer` joins the redial set and is retried across a disconnect exactly like a configured bootnode; `remove-peer` drops it from that set again. A peer banned automatically for misconduct is disconnected but keeps its address, so when the ban lapses the ordinary redial loop reconnects — a ban is a pause, not a removal.

## P2P identity keys

The node's network identity is an Ed25519 keypair at `$PCASH_DATA_DIR/p2p_identity.pb`, minted on first start if it is absent. It is not disposable: the peer id derived from it is what other operators dial and what their nodes score reputation against, so replacing it retires the node's standing on the network and invalidates every bootnode address anyone holds for it. Back the file up, and keep it at mode `0600`.

`pcash-cli p2p-key` works on that file directly. It reads and writes the key itself, so it needs no running node, no `--rpc-url`, and no `--admin-url`:

```
pcash-cli p2p-key generate --out /var/lib/pcash/p2p_identity.pb --addr /ip4/203.0.113.7/tcp/8646
pcash-cli p2p-key inspect /var/lib/pcash/p2p_identity.pb
pcash-cli p2p-key inspect /var/lib/pcash/p2p_identity.pb --json
```

A node whose key lives in a secret store takes it through `PCASH_P2P_IDENTITY_KEY` instead: the hex of the identity file's bytes (for example `xxd -p -c0 p2p_identity.pb`). The node then neither reads nor creates the file in its data directory.

`generate` mints a key owner-readable only and refuses to overwrite an existing one; `--force` replaces it and reports the peer id it retired. `inspect` reports the peer id, key type, public key, the file's permissions, and a SHA-256 of the file — enough to tell two hosts' keys apart, and never any part of the private key.

Provisioning the key ahead of the node's first start is what `--addr` is for: pass the reachable transport address (the same value `--p2p-advertise-addr` takes, with no `/p2p/` suffix) and both commands print the finished bootnode address to hand to other operators, before the node has ever run. `inspect` warns when the file is readable by group or other, and answers for a key that a node is currently using — reading it does not disturb the node.

## Mempool admission

Type-0 private-value transactions may earn issuance on either the open or designated route and enter the public mempool with zero open fee. Proof-bearing USER updates and CONTRACT creations with zero open fee enter its bounded unpaid pool; `PCASH_MEMPOOL_MAX_UNPAID_ENTRIES` bounds their count, and the unpaid verification budget limits proof work. Proof-free unpaid USER registration and CONTRACT creation remain disabled unless `PCASH_MEMPOOL_ACCEPT_UNPAID_REGISTRATION=true` (or `--mempool-accept-unpaid-registration`) is set. When space is needed, paying transactions evict the oldest unpaid entries, then entries with a strictly lower explicit fee per byte.

## Node Prometheus metrics

The node process does not embed Grafana. Pass `--metrics-addr` / `PCASH_METRICS_ADDR` (for example `127.0.0.1:9465`, default in `just node`) to bind an operator-only HTTP listener serving `/metrics`. When omitted the node binds no scrape port.

Pre-provisioned dashboards are available for the node (`node/crates/metrics/dashboards/pcash-node.json`) and wallet (`wallet/dashboards/pcash-wallet.json`).

## Wallet service credentials

The local wallet service (`pcash-wallet`) holds keys, synchronizes notes, encrypts and decrypts payments, generates proofs, and submits transactions. Its CLI (`pcash-wallet-cli`) creates or restores a wallet from a 24-word BIP-39 recovery phrase. The service encrypts the seed and private wallet database with AES-256-GCM and derives the password key with Argon2id. On persistent startup the service generates a bearer token and saves it with its bound endpoint in an owner-only `connection.json` under the wallet data directory. The CLI discovers this connection automatically. Pass the same `--data-dir` (or `PCASH_WALLET_DATA_DIR`) to both processes when using a custom directory. Explicit URL and token settings override discovery; a discovered token is only sent to its recorded endpoint. Explicit tokens are never saved: set the same `PCASH_WALLET_TOKEN` in both terminals, or use the server’s `--token` and the CLI’s `--wallet-token`.

```sh
pcash-wallet --rpc-url http://127.0.0.1:8645 --l1-rpc <ethereum-rpc-url>
```

The service prompts for the vault password, with confirmation for a new vault. For unattended startup, provide `PCASH_WALLET_PASSWORD` through your secret manager or process environment. Passwords are not accepted on the command line. The wallet stays unlocked while the service runs; stop the service to lock it.

In another terminal, create a wallet, record all 24 recovery words, and confirm the three requested word positions:

```sh
pcash-wallet-cli wallet create
```

Creation displays the phrase only in an interactive terminal and asks for three distinct, randomly chosen words before importing it. Its result names the Ethereum funding address and L1 chain ID. Send ETH for gas to that address on the displayed network, then register:

```sh
pcash-wallet-cli account ensure
```

Registration defaults to direct L1 publication from the wallet's own Ethereum account. The preflight checks its ETH balance against the current maximum gas quote and reports the required and available wei if funding is insufficient. No second private key or sponsoring relayer is needed. Funding and registration publicly link that Ethereum address to PCASH use; the independent PQ receive key is unaffected.

Two optional publication routes remain:

- **Use another gas-paying account:** configure `--l1-key-file <path>` or `PCASH_WALLET_L1_KEY`, then run `pcash-wallet-cli account ensure --submit l1`. The file holds the funded Ethereum key as `{ "privateKey": "0x..." }`, owned by the current user with mode `0600`. After registration is accepted, the service can restart without that gas key.
- **Use a sponsoring relayer:** run `pcash-wallet-cli account ensure --submit mempool`. The node must enable `--mempool-accept-unpaid-registration`, and a relayer must agree to publish it, such as one running with `--sponsor-unpaid`.

Transfers and account updates default to the mempool. `--submit l1` self-publishes them with the configured gas key or the selected wallet's own key. None of these publication choices derives the PCASH seed or receive key from an Ethereum key.

Before broadcasting a `--submit l1` transaction, the service journals it in a `relay-journal` directory under its data directory, and it allows one in-flight transaction per Ethereum signing address. If a submission is interrupted or stuck, inspect and recover it:

```sh
pcash-wallet-cli relay-journal show
pcash-wallet-cli relay-journal reconcile
pcash-wallet-cli relay-journal resolve --transaction-hash <exact-hash>
```

`show` prints each in-flight entry's exact signed transaction; treat it as sensitive, because an RPC URL may contain credentials. `reconcile` checks each entry's Ethereum receipt and clears entries that were reverted or that the node has recorded. `resolve` moves one entry to an audit file; use it only after you have resolved a hashless or stuck attempt yourself.

Use `pcash-wallet-cli status` for network, sync, balances and pending actions, or `pcash-wallet-cli balance` for balances alone. Amounts and fees are atomic units. Commands print readable text by default; use `--json` for scripts, with structured errors on stderr. Use `<command> --help` for relevant options and examples. Submission waits for acceptance by default; `--wait finalized` waits for finality and `--wait none` returns after mempool submission.

After registration, run `pcash-wallet-cli receive`. The receive code lets a website wallet send funds to the new account; an existing website account is not converted. The website does not connect to this local service.

Restore on the same PCASH network with `pcash-wallet-cli wallet import`, which prompts without echoing the phrase, or with `pcash-wallet-cli wallet import --seed-file /absolute/path/to/seed.txt`. The file is plain phrase text, owned by the current user with mode `0600`; the CLI reads it locally. Import sends the phrase only to the authenticated loopback service and rescans chain history. The phrase recovers the PCASH keys, confirmed notes and payouts, and the standard first Ethereum address at `m/44'/60'/0'/0/0` with an empty BIP-39 passphrase. The vault password does not affect these keys. Other wallets need PCASH support to recover the PCASH account. Unsubmitted jobs and application records need their own backup.

Seed wallets use one fixed receive key. Receive-key creation, import, replacement and clearing are disabled, so the recovery phrase covers every receive key the wallet uses. The developer-only `--dev` service keeps disposable in-memory state and accepts test-key imports with `pcash-wallet-cli wallet import --dev --key-file <server-local-mode-0600-JSON-file>`.

This provides post-quantum note encryption, not post-quantum transaction authorization: signatures and proofs retain their existing security assumptions. A website sender's own recovery record contains each payment's decryption secret under a key derived from that sender's Ethereum signature, so moving funds from the website does not remove exposure of the original payment.

Every `pcash-wallet` option can also be set as `PCASH_WALLET_<OPTION>`; the wallet service does not read the shared `PCASH_*` names. It accepts `--da-mode auto|calldata|blobs` or `PCASH_WALLET_DA_MODE` for direct L1 submissions and defaults to `auto`.

### Wallet service metrics

Wallet metrics are disabled by default and create no listener. Pass `--metrics-addr <host:port>` to expose OpenMetrics from a dedicated loopback-only listener at `/metrics`; for example:

```sh
pcash-wallet serve --metrics-addr 127.0.0.1:9470
```

The wallet HTTP listener does not serve metrics, and the metrics listener serves no wallet API. A minimal Prometheus scrape configuration is:

```yaml
scrape_configs:
  - job_name: pcash-wallet
    static_configs:
      - targets: ["127.0.0.1:9470"]
```

The series cover service health, loaded accounts, per-account scan and finalized cursors, node-tip lag, inventory counts, synchronization behavior, bounded wallet action types, normalized HTTP traffic, and Node process behavior. Scan performance includes output throughput, ML-KEM trial-decrypt attempts per second, successful decryptions, recovered notes, and latency; process panels show memory, CPU, and event-loop lag. Account addresses are intentionally present as local labels. Transaction IDs, recipients, keys, assets, balances, amounts, request URLs, credentials, and error messages are never metric labels or values. Even so, account addresses and operational timing are private deployment metadata: keep the listener on loopback, restrict scraper access, and do not forward the scrape to a shared telemetry service without an explicit privacy review. Browser wallets use the local no-op recorder and transmit no metrics.

Import [`wallet/dashboards/pcash-wallet.json`](../../wallet/dashboards/pcash-wallet.json) into Grafana and select the Prometheus data source and wallet instance to view reachability, readiness, account state, scan throughput, process resources, sync and action usage, failures, latency, and HTTP traffic.
