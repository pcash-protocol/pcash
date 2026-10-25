# PCASH: Private Money Ethereum Can Program

# Abstract

Using Ethereum today publishes your financial life: who paid whom, how much, and how those payments connect over time. Conventional finance does not publish everyday payments by default.

PCASH is private money Ethereum can program. Like other private money, its payments hide the sender, the recipient, the asset, and the amount. What sets it apart is what the money can do. PCASH is the native asset, and anyone can create another, such as a private dollar or a token, that moves with the same privacy. Every PCASH account decides privately what it takes to spend its money. Anyone can write a rule without asking permission, and a rule can depend on anything public, including what happens on Ethereum. PCASH contracts are accounts whose rules no one can change, and Ethereum contracts can move PCASH. A payment can also carry a private proof of where its funds came from, so a business can check what it needs to know without learning who paid.

PCASH runs on Ethereum's consensus instead of its own. Ethereum orders its transactions and every PCASH node computes the ledger from Ethereum's history, so PCASH has no validators to pay and no operator, sequencer, or upgrade key. ETH trades for PCASH in one Ethereum transaction, with no exchange, bridge, or custodian.

At most one billion PCASH will exist, all of it issued to the people who make and carry its transactions, with no premine, insider allocation, or sale. Anyone can earn it by publishing a transaction even with no payment to make, and each such transaction adds cover for other people's payments.

# Part I — Why PCASH

## What Is PCASH?

Private money has so far meant a chain of its own. Zcash and Monero each run their own network, with miners of their own to pay for its security, and no application on Ethereum can use their money. Privacy tools on Ethereum work the other way: they hold users' ETH and tokens in a pool beside it. PCASH is its own private money, as ZEC and XMR are, built to work with Ethereum:

* **Private assets.** PCASH is the native money: it pays the network's public fees and is issued to the people who use the network. Anyone can create another asset, such as a private dollar or a token, and it moves with the same privacy. No one can see which asset moved, so every asset's holders share one crowd ([Assets Anyone Can Create](#assets-anyone-can-create)).
* **Private rules Ethereum can drive.** Every PCASH account decides privately what it takes to spend its money. Anyone can write a rule without asking permission, and a rule can depend on anything public, including what happens on Ethereum: a payment an Ethereum contract recorded, an oracle's report, a deadline. PCASH contracts are accounts whose rules no one can change, and Ethereum contracts can move PCASH. That is how PCASH trades for ETH with no custodian, and how an Ethereum auction, vote, or deposit contract can move private money without a bridge ([Rules Each Account Chooses](#rules-each-account-chooses)).
* **Proofs that travel with money.** A payment can carry a private proof about itself, such as that its funds came only from sources a published policy approves, and later holders can rely on it. An exchange, issuer, or merchant can require that proof without learning who paid ([Proofs That Travel With Money](#proofs-that-travel-with-money)).
* **Ethereum's consensus, with no security budget.** PCASH has no validators of its own to keep paying. Ethereum orders its transactions and keeps them live, so the end of issuance ends no security budget ([Built on Ethereum](#built-on-ethereum)).

Ethereum has shown how much people build when money is programmable. PCASH brings that to private money, in a form Ethereum's contracts can use directly.

## What You Can Build

A few things PCASH makes possible:

* **Private dollars.** A dollar stablecoin whose holders can be paid, pay suppliers, and save without publishing their balances or payment history. The issuer releases units as dollars arrive, redeems them later, and can refuse stolen funds at redemption, wherever they have moved, by requiring a proof of where redeemed units came from ([Building on PCASH](guides/building-on-pcash.md#recipe-6-private-dollars)).
* **A market for PCASH and ETH.** Buyers and sellers trade directly through PCASH escrow contracts, with no custodian ([Trading PCASH for ETH](#trading-pcash-for-eth)). The reference marketplace works this way.
* **Ethereum apps that move private money.** An auction, a vote, or a deposit contract on Ethereum can decide when PCASH held in a PCASH contract is released.
* **Money with a verified history.** A PCASH contract can release funds only when they carry a private certificate that they come from approved sources, without anyone learning who sent them.
* **Vesting and sales.** A PCASH contract holds an asset's supply and releases it on a schedule, or to buyers who pay, on terms no one can change.
* **Shared and recoverable accounts.** A treasury that needs two of three keys, or a personal account with a recovery key held by a friend or a service, all with private balances.

## Why Privacy

Public blockchains suit public financial activity well and private payments poorly. A salary paid on-chain can reveal compensation to landlords, counterparties, and data brokers. A rent payment can link an address to a home. A purchase can connect identity, balance, and shopping history in a way no bank would publish.

Privacy is part of what makes money censorship-resistant and safe to use. Money that publishes every payment is money people cannot safely use for their whole financial lives.

## Private Only

Paying with PCASH works like paying with any token: you send an amount to an address. The difference is what everyone else sees. Each payment carries a zero-knowledge proof that it is valid, so the network accepts it without learning who paid whom, how much, which asset, or anyone's balance.

There is no public PCASH, nothing to deposit and nothing to withdraw, and that is the center of the design. Privacy is not something a user opts into: every unit, transaction, and balance is private, so nothing stands out for being private. A shielded pool brings an existing public asset into private use, with deposits and withdrawals connecting the two. PCASH begins in private ownership and stays there through every payment. Joining takes no deposit, an empty PCASH account looks the same as a full one, and any PCASH ever created could be what a new payment spends.

<figure data-diagram="no-public-pcash"><figcaption><p>PCASH is created and transferred privately, with no deposit or withdrawal boundary between public and private forms.</p></figcaption></figure>

Selling PCASH for ETH transfers it to another private owner; nothing leaves for a public form. That is deliberate: a way to redeem PCASH for ETH would need a public form, with the deposits and withdrawals that come with one. PCASH has its own market price instead, and trades for ETH in one Ethereum transaction ([Trading PCASH for ETH](#trading-pcash-for-eth)).

## What You Pay With

PCASH is both the network and its money, as bitcoin is on Bitcoin. At most one billion PCASH will ever exist, and all of it goes to the people who make and carry its transactions: there is no premine, no allocation to insiders, and no sale.

Most PCASH is issued in about a year. Every qualifying transaction in a block earns an equal share of that block's issuance, for its sender or for the relayer who publishes it, so users earn by making payments and relayers earn by carrying them. A newcomer needs no PCASH and no PCASH account to start, because a transaction that spends nothing still earns. The reward starts high and falls as supply is issued, and it rises whenever few people are mining ([How Issuance Keeps Pace](#how-issuance-keeps-pace)).

<figure data-diagram="money-supply"><figcaption><p>Gross issuance starts at zero and can never exceed one billion PCASH.</p></figcaption></figure>

Most PCASH goes to the people who take part early, as most bitcoin did, because that is when the network most needs activity and the risk is highest. Issuance runs for about a year so that who holds PCASH is settled early instead of over decades. Whoever values new PCASH more than the Ethereum gas it costs to earn will mine, so issuance goes to the people who expect it to be worth the most, and anyone can take a position by buying instead.

Issuance also pays for what PCASH needs most: its transactions reaching Ethereum. PCASH is owned by the people who keep the network alive, whether they use it or not.

## Mining for Privacy

A new private payment network faces a coordination problem: privacy comes from other people's activity, and early on there is little of it. Issuance pays people to supply it. Anyone can earn PCASH by proving and publishing a transaction even when they have no payment to make. This is PCASH mining.

A mine looks like a payment. It has the same public form as any zero-fee payment of the same size, and the empty outputs it creates look like real ones, so to an outside observer each mine is cover for other people's payments.

Mining also puts real money into private hands. Each reward is ordinary PCASH, spendable like any other: its amount is public and its owner hidden, and once it reaches someone else, even the miner cannot recognize its next spend.

Payments and mining earn on the same terms, so the protocol never has to judge whether a transaction paid a merchant or moved one person's funds, and a payment's reward can pay the relayer who publishes it. As issuance falls, people pay to publish their own payments, directly or through relayers, as Ethereum users pay gas. PCASH's security never depended on issuance.

## Assets Anyone Can Create

Anyone with a PCASH account can create a private asset with its own name and a fixed supply, such as a private dollar or a token, and people hold and send it with the same privacy as PCASH. The network cannot even see which asset moved, so the holders of every asset share one crowd. No one can mint more of an asset, freeze it, or take it back, and the same rules and PCASH contracts that govern PCASH govern it. An issuer that redeems an asset decides what it redeems, which is how a private dollar can stop stolen funds ([What You Can Build](#what-you-can-build)). Holders of an asset never need PCASH: they can publish their own transactions with no PCASH fee, paying only Ethereum gas, or pay a relayer privately in the asset itself.

## Rules Each Account Chooses

Each PCASH account sets its own security. Its rules can require a signature from an Ethereum key or a hardware wallet, a passkey, two of three keys, a recovery key held by someone else, or any combination, and the owner can switch from one to another without moving any funds.

Wallet software prepares payments, but only the owner's key or device approves them. Anyone can write a new kind of rule and use it without asking anyone: a rule is any condition that can be proved. As on Ethereum, what can be built is limited by what someone can write, not by a list of features. A flawed rule can hurt only the accounts that choose it: no rule can create money or spend someone else's.

<figure data-diagram="account-authority"><figcaption><p>An account commits a set of rules. The selected rule decides whether to approve, and the protocol still enforces every ledger rule.</p></figcaption></figure>

### PCASH Contracts

A PCASH contract is a PCASH account whose rules can never change. It has no key and no owner, and its rules are fixed when it is created. Money sent to a contract moves only on the contract's terms, and not even its creator can change them. That is what makes escrow, vesting, sales, and shared custody trustworthy.

PCASH contracts are private too. Using one means proving privately that its terms allow the action, so there is no public contract state and nothing for nodes to execute. Anyone can publish one.

<figure data-diagram="contract-account"><figcaption><p>A PCASH contract is published once with fixed functions. Each later use moves its funds under one of them.</p></figcaption></figure>

PCASH contracts hold money, not shared state. No sequencer orders updates to a common state, because nothing needs one: an application whose users must share state, such as an auction or a vote, keeps it in public in an Ethereum contract, and that Ethereum contract moves PCASH. Ethereum holds the shared state, and PCASH keeps the money private.

## Proofs That Travel With Money

A recipient can ask a payment to prove what it needs, such as that its funds came only from sources a published policy approves. The sender proves it without revealing who paid or the route the money took, and the proof travels on with the money, so the next recipient can check it too. An exchange, merchant, or issuer chooses what it needs proved, and a PCASH contract can require a proof before it releases funds. Compliance checks a proof instead of everyone's history ([Claims That Travel With a Transaction](#claims-that-travel-with-a-transaction)).

## Built on Ethereum

Ethereum is the strongest foundation available for open, neutral, internet-native money. It has deep economic security, resists censorship, lets anyone participate, and keeps a widely replicated history.

PCASH has no validators or sequencer of its own. Ethereum orders and carries its transactions, and every PCASH node computes the same ledger from Ethereum's history, one PCASH block for each Ethereum block. There is no second set of participants to trust or bribe, and no security budget to fund: a proof-of-work coin must keep paying miners for its security, while PCASH's ordering and liveness stay Ethereum's after issuance ends. The proofs every node checks keep the ledger valid.

<figure data-diagram="derivation-pipeline"><figcaption><p>Each Ethereum block produces one PCASH block, from transactions that people and Ethereum contracts post to Ethereum.</p></figcaption></figure>

The connection runs both ways, which makes PCASH composable with the rest of Ethereum. PCASH rules can act on what happened on Ethereum, such as a payment to a certain address. And Ethereum contracts can trigger PCASH transactions, so an Ethereum contract's own logic can decide when private money moves.

### Trading PCASH for ETH

The most direct use is trading with ETH without a bridge or a custodian. A seller locks PCASH in a PCASH escrow contract, and a buyer pays ETH through an Ethereum payment contract that claims the PCASH in the same Ethereum transaction. If no one buys before a deadline, the seller takes the PCASH back.

<figure data-diagram="eth-trade"><figcaption><p>Trading PCASH for ETH: one Ethereum transaction pays the seller and claims the PCASH.</p></figcaption></figure>

Getting ZEC with ETH goes through an exchange, a swap service, or a bridge's validators, any of which can hold your funds or stop a swap partway. Here no one holds either side's money at any point: the trade follows contract rules anyone can read before trading.

## No One Can Censor or Change It

No one runs PCASH. There is no operator, administrator, sequencer, or upgrade key, and no Ethereum contract holds anyone's funds.

No one can stop a valid transaction. Anyone can publish one directly to Ethereum, every time. Relayers add convenience and privacy, but if one refuses, you can use another or publish yourself. The rules give no one special powers, so the only possible censor is Ethereum itself.

No one can change the rules. Each version is fixed, and new rules apply only when people choose to run new software, as with Ethereum itself. There is no upgrade key to steal or capture, and fixing a bug never means moving everyone to a new Ethereum contract and splitting their crowd ([How Can PCASH Fix a Bug Without an Upgrade Key?](#how-can-pcash-fix-a-bug-without-an-upgrade-key)).

Nothing depends on anyone staying around. If the PCASH website, every relayer, and every public node went away, a node built from the published source would still compute the ledger from Ethereum alone, through an Ethereum RPC and a Beacon endpoint that keeps old blob data, and a wallet built from the same source would still find its payments, prove on its own device, and publish to Ethereum directly.

# Part II — The Technology

## One Proof per Transaction

Each payment carries a single zero-knowledge proof, made on the user's own device with CHONK, the client-side proof-folding scheme of the Barretenberg proving system. Inside it is a stack of small circuits, each folded into the next:

* the account's **rule**, which approves this exact payment;
* an **event application**, which can attach a proven claim to it;
* the **protocol kernel**, the same for everyone, which checks that the money is real and belongs to the account, marks each spend so it cannot happen twice, and checks that value balances and that the rule approved;
* the **hiding kernel**, which reveals only what the network needs to see.

<figure data-diagram="proof-stack"><figcaption><p>One proof per transaction: the account's rule and an event application are folded into the protocol kernel, then into a hiding kernel that every transaction of a kind shares.</p></figcaption></figure>

This split is what makes rules open-ended: a rule is any circuit anyone writes, and it never touches the ledger rules. Folding each circuit into the next keeps proving light enough for a browser on a phone. And because every payment ends in a shared hiding kernel, nodes check one small proof and learn nothing about the rule behind it.

## Everything a Proof Can Reach

A proof can draw on almost anything public without revealing what it used. Each proof is made against one recent PCASH block, and that block's hash commits the whole current ledger, the results of the block's transactions, and the full history of both PCASH and Ethereum. A proof can therefore show privately that funds exist and are yours, that an account has a certain rule, that an earlier transaction succeeded, or that something happened on Ethereum, while the transaction reveals only which block it used.

<figure data-diagram="header-state-map"><figcaption><p>A PCASH block hash commits the block's results, the current state, and two histories: Ethereum's and PCASH's own.</p></figcaption></figure>

That is how rules read Ethereum. A rule can prove that an Ethereum payment contract recorded a payment to a certain address, that an oracle reported a value, or that a deadline has passed, and act on it.

<figure data-diagram="normalized-log"><figcaption><p>A rule opens one Ethereum event beneath a recent PCASH block and interprets it.</p></figcaption></figure>

## Claims That Travel With a Transaction

A payment can carry a private, proven claim about itself, and later holders can rely on it. Each proof includes one event application, a circuit that proves something about the transaction, such as where its funds came from. The claim itself stays private. An account's rules can require a claim before they approve, and a later proof can check the claim of an earlier transaction, so a fact can travel with money from holder to holder without ever being made public.

The reference lineage application uses this to certify that PCASH comes only from approved sources, under a policy a provider publishes on Ethereum.

## Private Delivery

You can be paid before you have a PCASH account, and nothing in a payment names its recipient: the recipient's wallet finds it by trying to open new payments with its key. Receive keys are post-quantum (ML-KEM-768), and every payment carries encrypted data of the same fixed size.

<figure data-diagram="payment-journey"><figcaption><p>Alice's wallet prepares and proves the payment, anyone can publish it, nodes check it, and Bob's wallet finds his payment.</p></figcaption></figure>

A wallet restored from its secrets finds everything again, with no saved history to back up.

## How Issuance Keeps Pace

Issuance follows a declining supply curve with a one-year reference pace. Its baseline starts near 761 PCASH per qualifying transaction and falls as supply is issued. A controller modeled on Bitcoin Cash's difficulty adjustment raises the offer when issuance falls behind the reference pace and lowers it when issuance runs ahead. Each block has a total allowance, and every qualifying transaction in it receives the same reward, so mining harder doesn't issue more: more miners split the allowance, and the reward falls whenever issuance runs ahead.

<figure data-diagram="money-controller"><figcaption><p>The baseline falls with issued supply, the controller scales it by how far issuance is behind or ahead, and each block's allowance is shared equally.</p></figcaption></figure>

# Part III — Privacy and Trust

## What Is Public

A payment hides who paid whom, how much, which asset, and every balance. The main things that are public:

* which addresses have joined, and when an account changes its settings;
* a PCASH contract's full definition, when it is created;
* that a transaction happened, and when;
* its transaction type and size profile;
* its public fee, if it offers one;
* any Ethereum contract it was sent through;
* the amount of each public fee payout and issuance payout, with its owner hidden;
* total issuance, and each block's issuance and public fees.

Surrounding information can tie a transaction to someone. Publishing from your own Ethereum address exposes the publisher, a marketplace purchase is linked to the buyer's ETH payment, and knowledge about a rarely held asset can narrow its possible users. A relayer may publish for many unrelated people, so the publisher is not necessarily the owner. Wallet, RPC, and network information can reveal activity that the public ledger hides.

## What You Trust

**Users rely on:**

* the soundness of PCASH's zero-knowledge proofs and the cryptography under them: CHONK proofs over the BN254 curve, their universal setup, and the Poseidon2 hash function
* when buying PCASH with ETH, an honest PCASH node to check the listing before paying; running your own means trusting no one else

**Users do not rely on:**

* a sequencer or privileged batch poster
* a multisig administrator or upgrade key
* a bridge operator or custodian
* other users keeping their money in a shielded pool
* any particular Ethereum contract being the canonical PCASH contract

## Questions

### Can I Turn PCASH Back into ETH?

Not through the protocol: there is no withdrawal and no bridge. You sell it to someone for ETH through a PCASH escrow contract ([Trading PCASH for ETH](#trading-pcash-for-eth)).

### How Can PCASH Fix a Bug Without an Upgrade Key?

With a hard fork that people choose to run, as Ethereum does: a new version carries everyone's balances forward under new rules.

### What If the Proof System Has a Bug?

Every private money has this risk, because hidden balances leave no public supply to check counterfeit against. PCASH bounds it. A later version can stop trusting the proofs and readmit PCASH from the historical record only up to the total issuance that Ethereum history shows ever occurred, so a reset never readmits more than was ever issued. Within that total, counterfeit claims would compete with real ones, as they would in any private currency ([Security](security.md#counterfeiting)).

### What About Quantum Computers?

PCASH is built for post-quantum encryption. Receive keys are ML-KEM-768 keys and every payment carries encrypted data sized for them, so a payment encrypted that way stays unreadable even to a quantum computer that knows the accounts involved, which Zcash's and Monero's elliptic-curve encryption can't promise. Encryption is a wallet's choice rather than a consensus rule: any scheme that fits the same size looks the same. As on nearly every chain, PCASH's proofs and signatures are not post-quantum.

### What If a Key Is Lost or Stolen?

Two different secrets protect a PCASH account. Its rules decide who can approve a payment, such as an Ethereum key, a passkey, or two of three keys, and a recovery rule installed in advance can replace a lost one. The account's nullifier key, made with it, is what lets it spend. Someone who steals the nullifier key still can't spend, because every payment needs the account's rules to approve it. No one can replace it, though, so losing it loses the account's PCASH: keep it as safely as a seed phrase.

# Conclusion

PCASH is private money Ethereum can program. Its payments are private, for PCASH and for any asset issued on it. Every PCASH account sets private rules for spending that can act on Ethereum, Ethereum contracts can move it, and a payment can prove what a business needs to know without revealing who paid. It runs on Ethereum's consensus, so it has no validators of its own to pay, and it trades for ETH in one Ethereum transaction with no custodian. Its issuance puts it into private hands with no premine, and pays for the activity that makes everyone's payments private.
