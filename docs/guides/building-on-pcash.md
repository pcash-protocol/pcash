# PCASH Smart Contracts — What You Can Build

[The protocol specification](../protocol-spec.md) is normative.

This is the builder's guide: nine recipes for what account rules, contracts and asset rules can do, what ships today, and where each stops. A smart contract here is a contract account, a keyless address whose notes move only when one of its immutable functions approves.

The whitepaper explains the concepts the recipes use: [account rules](../whitepaper.md#rules-each-account-chooses), [contracts](../whitepaper.md#pcash-contracts), [rules that read Ethereum](../whitepaper.md#everything-a-proof-can-reach), and [private assets](../whitepaper.md#assets-anyone-can-create). The specification has the exact rules: [accounts](../protocol-spec.md#5-accounts), [contract-account creation](../protocol-spec.md#124-contract-account-creation-txtype-0x02), [assets](../protocol-spec.md#116-assets), and the [proof stack](../protocol-spec.md#8-proofs-and-account-rules), which defines the permanent four-field rule statement every rule returns and the application, protocol kernel, and hiding kernel circuits the cost notes name.

Coming from Ethereum, the difference to absorb first is that a contract has no storage and no call stack. That removes reentrancy, `delegatecall`, proxy storage, and contract-local upgrades as attack surfaces, and with them flash loans, on-chain AMMs, and atomic multi-protocol routing: contracts compose asynchronously across blocks, so you can build an order book but not Uniswap. It does not remove circuit bugs or deliberately permissive functions. An immutable bad function keeps authorizing exactly what it implements.

One cost model applies to every recipe. One client action folds one account rule, or two for sponsored transfers, then the asset's mint rule in a mint, or its transfer rule in a transfer of an asset that has one, followed by an event application, a protocol kernel, and a hiding kernel into one CHONK proof, and proving cost follows the largest folded component rather than paying for a proof verifier inside another circuit.

## Time locks

Execution time is the one condition a rule constrains directly rather than by opening a fact. Every private-value commitment carries `notBeforeTimestamp`, and consensus enforces `notBeforeTimestamp <= executing block timestamp`. A rule that requires the transaction's lower bound to be later than some committed instant therefore gets a time lock the node enforces, without opening a header itself — that is exactly how the escrow's `reclaim()` refuses to run until after `T`. This works identically for every private funding composition because one rule authorizes the complete transaction. It is a floor, not a scheduler: PCASH has no queue, so a transaction included before its lower bound is recorded as a failed transaction at that position rather than held, and something off-chain has to submit it again once the chain reaches the time.

Account creation has no such field. An account update does: it carries a private-value fee section, so the rule that authorizes it can require a `notBeforeTimestamp` the same way. Put the delay on the update rather than on the spends it enables — an update that is not itself delayed can replace the rule carrying the delay.

---

## Recipe 1: The private-value wallet

**Scenario.** You want a wallet secured by a passkey, a 2-of-3 for real money, or a rule that caps each payment at $1,000.

**On Ethereum.** Account abstraction, a deployed smart-contract wallet, gas for every validation, and the wallet's smart contract address publicly advertises exactly what kind of account it is.

**Here.** Your auth method *is* an account-rule circuit registered as a rule on your User Account or a function on a Contract Account. The website installs a fixed owner-only ECDSA set for semantic PCASH payment, asset payment, mint, asset burn, batch transfer, Contract Account fee sponsorship, and account administration. Passkeys, delegation, User Account multisig, recovery secrets, per-app permissions, and cumulative limits are not website features; custom software must supply and maintain their circuits. A spend does not reveal which privately installed User Account rule it used.

**Cost.** One CHONK proof folds the selected application and the no-op event application with the transfer kernel and hiding kernel. Every product value rule the browser proves uses the 2^18 SRS profile. A larger custom application increases folded proving work but does not change the public statement or the hiding-kernel proof shape.

**Why it matters.** A User Account may commit arbitrary rules without publishing their openings, but the website deliberately supports only its reviewed rule identities. Their revision-1 installation needs no additional setup transaction, and native and custom-asset note inputs remain private behind the same semantic message. Contract Accounts publish their immutable function openings and are the protocol model for application-specific authority. The repository's opaque-action multisig is demonstration-only; a product multisig should define semantic approvals for every supported action.

This is not normally the right shape for shared or programmed custody. A user account remains mutable: any rule that can authorize an account update can replace the rules that were meant to constrain it. An exchange, institutional custodian, treasury, or other arrangement where the spending law is the commitment should normally use a Contract Account. Its rules are immutable and its address derives from its contents, so counterparties can verify the custody law rather than trust that it has not changed: fetch its creation data, recompute the address, compile the relevant function circuits with the pinned toolchain, compare application VK hashes, and check each relevant configuration commitment against the advertised parameters. See Recipe 4 for the narrower case where an immutable Contract Account deliberately delegates to mutable rules.

---

## Recipe 2: Create a private asset

**Scenario.** You want a private instrument, loyalty unit, claim, game currency, or dollar whose holders use the same note ledger and authorization accounts as PCASH.

**On Ethereum.** A token contract publishes asset identity, balances, transfers, and application calls. A separate privacy system must then hide or wrap those effects, usually reintroducing a deposit boundary or a trusted asset implementation.

**Here.** An asset's definition fixes three things, and its `assetId` is their hash, so none of them can change ([Assets Anyone Can Create](../whitepaper.md#assets-anyone-can-create), [spec §11.6](../protocol-spec.md#116-assets)): its metadata; its mint rule, a circuit every mint must satisfy; and an optional transfer rule, a circuit every transfer and burn must satisfy. Three standard mint rules ship: fixed supply, minted once in full by whoever holds the asset's secret; account mint, where one account mints whenever its own rules approve, so an issuer can rotate keys or signers without a new asset; and deposit mint, once per deposit to an Ethereum vault (Recipe 6). The standard transfer rule is a sender deny list (Recipe 6). A rule that must follow changing facts reads them through the recent block, as the standard rules read a vault's deposits or a deny list from the Ethereum contract their configuration names. An asset with a transfer rule has an ID in its own range, so moving any other asset needs only its `assetId` and opens no definition, while moving one with a transfer rule needs its definition. The creator shares the definition with holders, in a payment's delivery data or as a share link; wallets check it against the asset ID, name the standard rules and show any other rule as custom. A fixed-supply asset's secret is its only mint authority until the mint lands, so the creator keeps it private and stores it with the definition before broadcasting.

**Cost.** Ordinary asset transfer uses the same transfer kernel as native transfer. A mint folds the minting account's installed rule, the asset's mint rule and the no-op event application into the mint kernel, then the same hiding kernel: five circuits. The mint kernel itself derives the asset ID from the definition, checks the mint markers and zero burn, and accepts optional native funding from the same account without another application; the mint rule bounds what is minted. A mint rule may accept any account, so whoever requests a mint can submit it and pay its fee. A transfer of an asset with a transfer rule also folds that rule, one more circuit, through a restricted variant of the transfer kernel; transfers of other assets pay nothing for it. The public proof and hiding kernel remain the same shape as a native action. Every private-value action pays for its selected profile's full complement of output commitments and 1,213-byte output-data items — five for S, thirty-two for L — and the profile's fixed arena, to keep the public surface uniform.

**Limits.** A transaction moves PCASH and at most one other asset, and one account owns all of its inputs. The one exception is sponsorship, the bounded [sponsored transfer](../protocol-spec.md#117-sponsored-transfer): the sponsoring User Account contributes only native PCASH, for the public open fee, the protocol fee's burn, and one exact private payment, and receives its own change. The primary must be a Contract Account. The one payment may go to a relayer or to a seller, so a user can buy from a contract in one transaction: the contract's function releases the asset only when the transaction pays the seller, and the open fee pays for posting, or the user posts it. The reverse, a contract paying PCASH for a user's asset, takes two transactions, because the contract cannot contribute PCASH and the sponsor cannot contribute an asset. Two User Accounts cannot exchange in one transaction, because one proof has one prover. The reference sponsorship rule signs its payment as a relay fee, so a purchase needs a sponsor rule that shows the signer the seller and price. An asset has no mutable note-state field, metadata authority, or public supply counter, and neither a mint rule nor a transfer rule can move or erase a holder's notes.

**Why it matters.** An asset's law is its definition: a holder recomputes the `assetId` and sees its mint rule, such as a fixed supply or the one account that can mint, and which transfer rule applies. The only asset-specific code to review is its mint rule and its transfer rule, where it has one.

---

## Recipe 3: Sell private money for ETH without a trusted counterparty

**Scenario.** You hold PCASH and want to sell it for ETH on Ethereum, with no exchange, no escrow agent, no counterparty you have to trust.

**On Ethereum.** A DEX, or an OTC deal with a trusted intermediary, or an atomic-swap dance with liveness assumptions — and everything is public.

**Here.** This one is built and runs end to end on the website's Marketplace: an escrow contract with `claim()` and `reclaim()` functions, a `PaymentRouter` on Ethereum, and a deadline after which the seller can reclaim an unsold offer. Two router details matter when designing a similar flow. The router records only the first exact payment for an `(offerId, seller, amount)` tuple, and it permits EOAs, delegated accounts, and contract-wallet forwarding. The buyer also passes it the recent L1 block number and hash of the PCASH snapshot at which the client verified the escrow; if a reorg removes that verified state, resubmitting the payment on the replacement branch fails the router's block-hash check. The same escrow sells any asset. An asset with a transfer rule stays under it in escrow: the rule judges the escrow contract as the sender, so a freeze of the escrow's address holds both the sale and the reclaim until it is lifted.

**Cost.** The `claim()` application opens no Ethereum data: it requires the router's carrier context, which binds the router, offer ID, seller, price, and claim-key commitment. CHONK folds it and the no-op event application with the transfer kernel and hiding kernel into one final proof without embedding a proof verifier in the kernel.

**Why it matters.** The same function shape can support other "pay on L1, receive privately" flows, but lending and other applications require their own terms and circuits. The marketplace is an app-layer Smart Contract and router, not a protocol feature, so anyone can publish a different design even though the reference client accepts only its pinned implementation.

---

## Recipe 4: Immutable contract, mutable delegated rules

**Scenario.** A five-year treasury. You want the contract's delegation rule frozen, while the people who can approve spending change as members leave or keys are replaced.

**On Ethereum.** A long-lived treasury usually keeps mutable owner state in a multisig or smart account, or adds an upgrade authority, and its current control structure is public.

**Here.** A contract function can say: *"this executes if user account X's current rule authorizes the same transfer."* The contract never changes, while X's administration rule can replace X's rules as the team changes. Whatever rule can update X controls the delegated authority, so the governance risk moves to X rather than disappearing.

**Status.** An architectural pattern. It needs a custom application; no reference circuit or SDK builder exists for it yet.

---

## Recipe 5: Payouts settled by anything real

**Scenario.** A bet on the World Cup. A payment that only goes through if ETH is above $4,000. A note that unlocks when a specific deposit lands on L1.

**On Ethereum.** Doable, but public — everyone sees the bet, the condition, the parties.

**Here.** A custom Smart Contract function can open an Ethereum event and authorize a payout accordingly. A prediction-market function could settle from an oracle event, a price-conditioned payment could consume a price-feed event, and a deposit-authorized function could require a specific deposit event. Every result is grounded in the normalized Ethereum-log root committed by the selected PCASH block header.

**Status.** The standard deposit-mint and sender deny-list rules (Recipe 6) each open one Ethereum log beneath the recent block and are worked examples of the pattern. A payout function of this kind needs its own circuit.

**Cost.** An L1-conditioned function circuit's cost depends on the data structure, bounds, and hash work it opens; compile and measure the actual circuit.

**Why it matters.** A Smart Contract function can settle privately on an Ethereum fact that its bounded circuit can prove. That covers useful shapes such as conditional escrow and milestone payments without embedding arbitrary EVM execution inside PCASH. Consensus-enforced transfer time bounds are available too, but those bounds are public transfer fields rather than hidden function state.

---

## Recipe 6: Private dollars

**Scenario.** You issue a dollar stablecoin. Holders want private balances and payments; you need units minted as dollars arrive, redemptions, and a way to freeze stolen funds.

**On Ethereum.** The token is a public ERC-20: every balance and payment is visible.

**Here.** The issuer deploys a reserve vault and a deny list on Ethereum and defines a private asset (Recipe 2) whose mint rule is the standard deposit mint, naming the vault, and whose transfer rule is the standard sender deny list. A holder's wallet issues a deposit code: a fresh nonce and a commitment to the PCASH chain, the asset and the holder's address under a salt only that wallet derives. The depositor, the holder or whoever pays it, sends USDC to the vault with that code, and seconds later the holder's wallet mints it: the rule opens the vault's log and creates one note of the deposited amount to the committed address, once. Ethereum shows the deposit but not its PCASH recipient. The issuer credits wires through the vault with the same event, so every unit issued appears on Ethereum. A holder redeems by sending units to the issuer, which burns them and pays out from the vault. [Private dollars](private-dollars.md) walks through every step.

**The vault's policy.** The issuer chooses who may deposit, caps each deposit, and can pause deposits, all in the vault, so the rule on PCASH never changes. The vault has no refund: neither it nor the issuer can tell whether a deposit was minted, so a refund could pay twice. A mint anchored after its deposit's block fails if a reorganization removes that block, so minting needs no finality wait, and the L1 origin tree keeps every past deposit, so a deposit can be minted at any later time.

**Freezing.** Every transfer of the dollar proves that its sender is not on the issuer's deny list in a recent publication from the list's Ethereum contract. The issuer adds an address to the list, and within the list's publication window, which the issuer sets up to a maximum fixed in the asset's definition, that address can no longer send or burn the dollar; everyone else is unaffected. The issuer can pause every transfer the same way, and can credit replacement units to a theft victim. A publication authorizes transfers only for its window, so the issuer's service publishes the list again whenever its latest publication is 15 minutes old. Anyone can call the contract's heartbeat, and the contract publishes only the list it stores, so no one can revive an old one.

**What it does not do.** The issuer cannot see balances or transfers, and cannot erase a frozen balance. A freeze takes effect within the window, so a thief watching Ethereum can move funds first. The standard rule checks senders only; screening recipients needs a custom rule. Finding and minting deposits, and syncing the deny list, tell the holder's Ethereum endpoint and PCASH node which deposits are the holder's and that it holds an asset under the list, unless the holder runs both ([Security](../security.md#private-dollars)). Ethereum shows what the issuer owes, deposits and credits less payouts, but not the circulating supply, because deposits not yet minted and burns not yet paid out are private.

**What you build.** The standard deposit-mint rule and the sender deny list rule ship in the repository (`circuits/rules/deposit_mint`, `circuits/rules/sender_deny_list`), with two Ethereum contracts in `stablecoin/l1-contracts`: the deny list and the reserve vault. The SDK wallet issues deposit codes, lists its deposits and mints them. The `stablecoin` package is the issuer's service: credits and vault policy, redemptions, deny-list administration and the heartbeat. [Private dollars](private-dollars.md) walks through issuing one. A vault that lets anyone deposit makes the same rule a permissionless way in; the way out still trusts whoever pays from the vault.

**Why it matters.** Holders get dollars with private balances and payments, and the issuer keeps deposits, redemption, and freezing under its control without seeing who holds what.

---

## Recipe 7: The anonymous-member treasury

**Scenario.** A pseudonymous team with a shared budget, or a fund that pays anonymous grants or bounties. Any member should be able to pay from it without the proof revealing which member approved.

**Here.** The contract's rule is a group-membership proof: *"this spends for anyone who can prove they belong to the committed group."* A member spends by proving membership without revealing which member they are, on a chain where the payment itself is already private. Add a cap on each payment and you have an anonymous shared purse.

**Status.** It needs a new membership rule circuit and wallet support. The rule statement and private function selection it builds on already ship.

---

## Recipe 8: Composition

**Scenario.** "Spend if the multisig *and* the timelock both pass." Or require the remainder of a payment to return to the same contract.

**Here.** Two shapes, both built from ordinary rules:

- **Combinators.** A rule can check several conditions or proofs, such as `and(A, B)`, `or(A, B)` or a threshold, and pass when its fixed condition holds.
- **Self-relocking outputs.** A contract function can require a designated output to return to the same contract, keeping its conditions on that value. It binds only the current transfer, so on its own it cannot implement a vesting schedule or a cumulative limit.

**Status.** Anyone can publish such a rule without a protocol change. Each compiled circuit has its own bounds and proving cost, and none ships with the reference wallet.

---

## Recipe 9: What can evolve without a fork

Custom authorization schemes and conditions can evolve permissionlessly when their application returns the permanent rule statement. The protocol kernel supplies the authenticated account and exact domain-separated action commitment; the application circuit and its committed configuration define what may satisfy that invocation. Applications can inspect the action commitment and open PCASH state, Ethereum history, or prior PCASH blocks from `recentPcashBlockHash` without changing the protocol kernels.

A user account is not a general-purpose node-maintained registry. Its one account state commitment binds the immutable nullifier-root commitment, mutable depth-8 rule-set root, account revision, user-account kind, and optional receive-key digest. Every update is authorized by a private rule selected from the current rule set by the fixed account-update relation. Wallets maintain user rule entries and Merkle paths off-chain; nodes commit the rule-set root and complete account state row. A Smart Contract's function set is immutable and rejects every update.

That boundary is the useful one: new user-account rules and Smart Contract functions, including new note-spending and administration authorization methods, can live in user-space circuits. New shared state, update effects, transaction types, or assigned header/state keys require a protocol change or must live on Ethereum. The design keeps authorization extensible; it does not make protocol rules finished forever.

---

## Where to start

- The **SDK** builds User Accounts, Contract Accounts, native transfers, fixed-supply, account-mint and deposit-mint assets, their mints and transfers, restricted transfers included, and handles proving. The fixture-only asset covenant demonstrates moving contract-owned inventory to one exact already-live successor contract; it is not exported through the product SDK or staged by the website.
- The **marketplace** (`marketplace/`) is a complete worked example of Recipe 3 — one `PaymentRouter` Ethereum smart contract, one Escrow Smart Contract exposing mutually exclusive `claim()` and `reclaim()` spends, and an auditable client/recovery package. Its lifecycle branches from a funded offer: payment leads to `claim()`, while an unpaid or unclaimed timeout leads to `reclaim()`. Run `just e2e marketplace` to watch both paths against local L1 and PCASH nodes.
- The optional **contract source registry and Explorer** publish operator-verified source, the Noir proving ABI, and disclosed positional configuration for immutable functions; consenting nodes may also accept community-submitted bundles that pass the same rebuild-for-correspondence rule, labeled as public submissions.
- `circuits/README.md` documents the website's ECDSA reference rules, what each one approves and binds, the standard mint and transfer rules, and the demonstration Contract Account rules, in its "Reference rules" and "Fixtures" sections.

The shortest path to understanding what's possible: run the marketplace end-to-end, then read the `claim()` function circuit and notice that it returns the same four-field rule statement as every other account rule. Publishing that circuit needs no protocol change; a known Smart Contract can still be identified from its creation data and function hashes.
