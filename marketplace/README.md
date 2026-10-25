# PCASH marketplace application

The Marketplace is an optional PCASH application, not consensus. A seller escrows a native PCASH or standard-token note; a buyer proves a claim on that note and sends one Ethereum transaction to the `PaymentRouter`'s `buy`, which pays the exact gross ETH price, splits it into its deployment's immutable website fee and the seller's net proceeds, and carries the claim to PCASH as a `PcashBatch` event that the claim requires. `buy` reverts unless the buyer's anchor block is still canonical and it executes before the buyer's `notAfter`, which the client derives from the proof's snapshot and the claim deadline, so a claim checked against an honest, synced node settles with the payment; if the node that checked it was wrong but the escrow is real, `retry` carries a fresh claim for the recorded payment until the deadline; and the seller can reclaim an unclaimed escrow after the committed timeout. A deployment also names a guardian that can pause new purchases; it can't move funds, change a listing or the fee, or stop `retry` or a reclaim, so a pause never strands a payment or an escrow. A token escrow always pays out in full: its claim carries no PCASH fee, and its reclaim either carries no native value or has the seller's own account pay the network fee through the sponsored-transfer kernel.

## Layout

- `l1-contracts/` contains `PaymentRouter.sol`, deployment tooling, and Foundry tests.
- `l2-contracts/escrow/` contains the `claim()` and `reclaim()` Noir applications.
- `src/client/` contains browser-safe publication, verification, payment, claim, reclaim, persistence, and recovery flows.
- `src/tooling/` contains Node-only publication and source-verification deployment inputs.
- `test/` exercises the complete application package.

The runtime independently authenticates the expected selectors, application VK hashes, and configuration commitments before payment or spending. It never trusts the optional source registry. Deployment tooling separately publishes source and disclosed per-instance configuration through the generic source-verification system so the Explorer can reproduce the application in the same way an Ethereum explorer reproduces deployed bytecode and constructor arguments.

Run `npm test --workspace @pcash/marketplace`, `forge test` from `marketplace/l1-contracts/`, `just test-marketplace-noir`, and `just e2e marketplace` from the repository root.

Discovery is convenience only: catalog records and shared links are untrusted transport, and buyer claim recovery and seller reclaim never depend on the catalog.
