# End-to-end scenarios

This workspace is the complete user-journey gate. Scenarios drive in-process wallets, and one harness L1 key publishes and relays every action. `just e2e` runs them serially against a fresh local Anvil with one or two PCASH nodes it launches. `just e2e-live` runs the same scenarios against a network something else runs, such as a deployed node or a `just e2e-up` stack. The scenarios cover P2P propagation, wallet delivery and isolation, multi-input and change spending, semantic private assets, targeted Contract Account fee sponsorship, note issuance and restoration, zero-value payments, selected private relay payment and issuance, the PCASH-for-ETH marketplace, and durable restart/resume. Reorg, restart, timestamp control, P2P, and source publication need nodes the harness launched, so they run only locally.

Run every default scenario against a fresh local Anvil, or name the ones you want:

```bash
just e2e
just e2e core reorg
```

Run the real-MetaMask Wallet activation journey separately. Dappwright downloads and launches the MetaMask extension, while the test starts Anvil and one PCASH node; on Linux, supply a display with Xvfb as CI does:

```bash
npm exec --workspace @pcash/e2e -- playwright install chromium
npm run e2e:metamask
# Linux:
xvfb-run -a npm run e2e:metamask
```

The runner builds the required Rust and TypeScript packages once per run. Each local scenario gets isolated ports and temporary state. Successful local artifacts are removed; failures preserve their process logs and redacted `evidence.json`. Pass `--keep-artifacts` to preserve successful runs or `--out /absolute/output/directory` to choose the output location (a parent directory when multiple scenarios run). An explicit output directory must be new or empty; the runner makes it private with mode `0700` before writing credentials.

Every actor is a fresh key with an in-process wallet. Actors hold no ETH: one harness key posts their batches, naming the acting wallet's commitment, and relays the entries they admit to the public mempool. It funds only the few actors that must send an Ethereum transaction themselves, such as a marketplace buyer.

## Against a live network

Live mode attaches to a running node and its L1 and launches nothing. Every E2E setting uses the `PCASH_E2E_` prefix, so a run never picks up the names a checkout's `.envrc` sets for its own services. Set three variables, in the shell or in the ignored `.envrc.e2e` (copy [`.envrc.e2e.example`](../.envrc.e2e.example)):

```bash
PCASH_E2E_RPC_URL=https://<node>/rpc
PCASH_E2E_L1_RPC=https://<execution RPC for the node's L1>
PCASH_E2E_L1_KEY=0x...   # funded on that L1; pays every batch the run publishes
just e2e-live core
just e2e-live traffic --duration 2h --marketplace
```

`just e2e-live` with no names runs every default scenario a remote network can host. Each run uses new actors, so reruns never replay earlier state. Use one `PCASH_E2E_L1_KEY` per running harness: concurrent runs sharing a key race its nonces. Live runs keep their artifacts, including each actor's key under `credentials/`.

`traffic` generates long-running activity to watch in Explorer: payments relayed from the mempool, self-published payments that keep earning issuance, several payments in one carrier, complete asset lifecycles, and paid marketplace trades. Several workers run these concurrently, and the harness keeps several L1 transactions in flight and batches what arrives together, so each L1 block carries several actions. It runs until `--duration` elapses or until interrupted; any L1 but Anvil requires the duration, which prevents an accidental unlimited gas workload. The first interrupt lets each worker finish its current round, and a second stops at once. On a live network it trades only with `--marketplace`, at most once every ten minutes, because catalog records never expire. On a live L1, which cannot be advanced past the 24-hour claim window, the marketplace scenario leaves its unpaid offer escrowed instead of reclaiming it.

## Against a local stack

`just e2e-up` serves Anvil and one node on live mode's default endpoints until interrupted. Its node takes a public node's mempool policy, so live runs against it need no variables, pay with Anvil account 5, and rehearse a remote network:

```bash
just e2e-up                                   # terminal 1
just e2e-live traffic --duration 10m          # terminal 2
just seed
```

`just e2e-live traffic` and `just seed` run the same way against the local development services started with `just anvil`, `just node`, and `just web`, and own none of them. To run either hermetically instead, name it as a local scenario, `just e2e seed` or `just e2e traffic --duration 30s`, and the fixture starts and tears down a complete isolated stack.
