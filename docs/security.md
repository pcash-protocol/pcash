# Security

How PCASH protects its money and the people who use it, and the latest security review.

## Counterfeiting

If a bug in the proofs ever let someone create PCASH, a later version can stop trusting the old proofs and readmit balances from the historical record only up to the total ever issued, which anyone can compute from Ethereum history ([protocol specification](protocol-spec.md), Appendix A). A reset never readmits more than was ever issued.

Every private money carries this risk, because hidden balances mean no public figure shows counterfeit while it circulates. Zcash, the most studied private currency, has had two such bugs in its shielded proofs: one in Sprout, found in 2018 and [fixed before it was disclosed](https://electriccoin.co/blog/zcash-counterfeiting-vulnerability-successfully-remediated/), and one in Orchard, found in 2026. Pools have the same risk in another form: in Tornado Cash, Railgun or Privacy Pools, a proof bug lets someone withdraw deposits that aren't theirs. Tornado Cash had one in 2019. Anyone could have forged a deposit and emptied the pool, and its team [drained the pool itself to rescue the funds](https://blog.trailofbits.com/2022/09/15/it-pays-to-be-circomspect/) before anyone else did.

Zcash's [turnstile](https://zips.z.cash/zip-0209) protects its supply the same way, checking live where PCASH's bound is applied at a fork. The turnstile stops a shielded pool from paying out more than was paid into it, but it can't see counterfeit inside the pool, so for holders the result is the same: in both systems the supply is protected, and counterfeit claims compete with real ones within it. In both, the fix is a release that people choose to run. No one can push one, as no one can on Bitcoin.

## Who gets PCASH

No one was allocated any PCASH: there is no premine, no founders' reward, and no sale. Zcash, by comparison, paid 20% of its block rewards for its first four years, about a tenth of all ZEC, to its founders, investors and the organizations that built it.

Issuance goes to whoever pays to get PCASH transactions onto Ethereum, whether they are making payments, carrying other people's, or mining.

Mining PCASH means paying Ethereum gas, so issuance goes to whoever values new PCASH more than that cost, as bitcoin goes to whoever pays for the most hashpower. Mining early creates no continuing privilege: the cap and the pace are fixed and public, and later participants can mine under the same rules or buy. Mining harder doesn't issue more, because each block's allowance is capped, more miners split it, and the reward falls whenever issuance runs ahead. Most PCASH is issued in about a year, so that who holds it is settled early instead of over decades.

Whoever collects issuance is paid for what PCASH needs most: its transactions reaching Ethereum. That is the cheapest way to keep PCASH live and hard to censor. PCASH is owned by the people who keep the network alive, whether they use it or not.

## What a node can and can't do

A wallet reads PCASH from a node. A node can't move your money or make an invalid payment succeed: only a PCASH account's own rules approve a payment, and a proof made against a false state fails. The one action where you rely on what your node shows you is buying PCASH with ETH, because the ETH moves on Ethereum, which can't check PCASH state. The marketplace verifies the escrow through your PCASH node before paying. With an honest, synced node, the checked claim settles with the ETH payment. Run your own node to verify independently ([Running a node](guides/running-a-node.md)).

Your wallet does its own work. It downloads the same chain data every wallet downloads, finds your payments by decrypting them on your device, and proves there, so syncing and ordinary payments don't tell a node which notes are yours. The node you use does see your IP address and the transactions you send through it, and some features ask it about your own account, such as your activity list, marketplace offers and token claims. Running your own node keeps all of that to yourself.

Compare getting ZEC with ETH. Every route from ETH to ZEC trusts someone who can hold your funds or stop a swap partway: an exchange takes custody, a solver network fills the order and sees it, or a bridge's validators sign the other side. Trading ETH for PCASH settles in one Ethereum transaction under contract rules anyone can read in advance. No one holds either side's money along the way, and the only thing you rely on is the node you read from, which can be your own.

A light wallet could drop even that once a prover posts proven PCASH state to Ethereum, which would also let Ethereum contracts check PCASH state directly.

Nothing depends on the PCASH website staying up. A node built from the published source computes the ledger from Ethereum alone, through an Ethereum RPC and a Beacon endpoint that keeps old blob data, and a wallet built from the same source finds your payments and publishes to Ethereum directly.

## Private dollars

A stablecoin issuer can issue a private dollar on PCASH. It creates an asset with more supply than it will ever need, releases units as dollars or USDC arrive, either at its own discretion or automatically when the depositor proves the USDC deposit on Ethereum, and redeems units sent back to it.

It can stop stolen funds where it matters, at redemption. Each transfer of its dollar carries a private claim that the units descend from the issuer's releases and from no note its published policy denies, and the issuer redeems only units that arrive with that claim. A recipient runs the same check before counting a payment, so units the issuer won't redeem are refused in practice. When the issuer denies a note a thief took, every unit descending from it fails the next check, and the issuer can send the victim fresh units from its inventory. A freeze on Ethereum applies to one address; this one follows the value, as Privacy Pools' association sets do. The claim is an event application the issuer writes, and [Building on PCASH](guides/building-on-pcash.md#recipe-6-private-dollars) shows how.

## Quantum computers

PCASH is built for post-quantum encryption. Receive keys are ML-KEM-768 keys and every payment carries encrypted data sized for them, so a payment encrypted that way stays unreadable even to a quantum computer that knows every account's address. With Zcash's and Monero's elliptic-curve encryption, it could read every payment to an address it knows, and Monero's history alone would show it which coins each payment spent. Encryption is a wallet's choice rather than a consensus rule: any scheme that fits the same size looks the same.

## What the proofs rely on

Everyone relies on the soundness of PCASH's proofs and on the Poseidon2 hash function. The proofs use Aztec's Barretenberg prover, pinned to one release, and rely on the setup from Aztec's [Ignition ceremony](https://aztec.network/blog/announcing-ignition), which is secure if any one of its participants destroyed their secret. The proofs' second setup is generated from a public seed and needs no trust.

## Security review

PCASH is reviewed with [Auditician](https://github.com/defuse/auditician), the automated audit method from Taylor Hornby, who found the critical soundness bug in Zcash's Orchard circuit in 2026. A review runs AI agents through a full audit. They survey the code, write a threat model of what must never happen, review every file and every path that crosses components, try to prove or break each invariant, and validate each finding before it reaches the report.

Reviews cover the soundness of PCASH's proofs: whether any accepted transaction can create value, spend or redirect another account's notes, or have an effect its proofs and signatures don't authorize. That covers the protocol and hiding kernels, the reference account rules and signature libraries, the node's proof verification, state, issuance and derivation, and the release pins and the scripts that build the circuits. Node availability, the wallet and the applications are outside them.

The current review is in [pcash-protocol/audits](https://github.com/pcash-protocol/audits): its report, the source commit it covers, and what it found.

To test the method itself, three bugs were planted in the circuits, two of them silent ways to mint PCASH. Two soundness-focused reviews on different models each found all three.

### Run it yourself

Auditician is free software, and anyone can run it against the published source with a model of their choice and compare the results.
