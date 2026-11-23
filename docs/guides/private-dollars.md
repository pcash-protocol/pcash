# Private dollars

How to issue a private dollar on PCASH. Holders get a dollar whose balances and payments nobody else can see, and the issuer keeps the controls a stablecoin needs: who may deposit, redemptions, and freezing stolen funds. Holders' wallets mint their own deposits, so the issuer never learns who holds what, and Ethereum shows every unit issued and every unit paid out.

Everything on this page ships in the repository: the Ethereum contracts in [`stablecoin/l1-contracts`](../../stablecoin/l1-contracts/), the standard deposit-mint and deny-list rules, deposit support in the SDK wallet, and the issuer's service in [`stablecoin`](../../stablecoin/). [`e2e/src/scenarios/stablecoin.ts`](../../e2e/src/scenarios/stablecoin.ts) runs every step against local Ethereum and PCASH nodes with real proofs. [Building on PCASH](building-on-pcash.md#recipe-6-private-dollars) places the design among the other things PCASH rules can do, [Security](../security.md#private-dollars) says what holders trust, and [spec §11.6](../protocol-spec.md#116-assets) defines assets and their rules.

## What the issuer deploys

Nothing on PCASH. On Ethereum, the issuer deploys a reserve vault and creates a deny list, then defines its dollar.

- **The reserve vault** ([`ReserveVault.sol`](../../stablecoin/l1-contracts/src/ReserveVault.sol)) holds the USDC. `deposit(amount, recipientCommitment, nonce)` takes USDC from an address the issuer has allowed, up to the issuer's cap per deposit, unless the issuer has paused deposits, and emits `Deposit(depositor, recipientCommitment, nonce, amount)`. `credit(recipientCommitment, nonce, amount)` emits the same event from the issuer without taking USDC, once per commitment and nonce. `payout(to, amount, redemptionId)` pays each redemption once.
- **The deny list** lives on a [`DenyList.sol`](../../stablecoin/l1-contracts/src/DenyList.sol) contract, which holds the issuer's list of frozen addresses, a publication window and a pause flag. One contract serves any number of issuers' lists.
- **The dollar's definition** names the vault in its mint rule, the standard deposit mint, and the list in its transfer rule, the standard sender deny list, with the longest publication window the issuer may ever set. `stablecoinDefinition` builds it. The asset ID is the definition's hash, so neither rule can change, and wallets show the dollar as minted once per deposit to the vault and frozen through the list.

The issuer publishes the definition as a share link, and every holder's wallet verifies it against the asset ID.

## How holders deposit and receive

1. The holder's wallet creates a deposit code (`createDepositCode`). It carries a fresh nonce and a commitment to the PCASH chain, the dollar's asset ID and the holder's PCASH address under a salt the wallet derives from its keys and that nonce, with the chain, the vault and a checksum. A fresh code for every deposit keeps deposits unlinkable on Ethereum.
2. The depositor, whether the holder's own Ethereum account, an exchange or an employer, approves USDC to the vault and calls `deposit` with the code's commitment and nonce.
3. PCASH derives that Ethereum block within seconds. The holder's wallet finds the deposit (`listDeposits`) and mints it (`mintDeposit`). Its proof opens the vault's log under a recent PCASH block, shows that the commitment opens to this chain, this dollar and the holder's address, and creates one note of the deposited amount.

Each deposit mints once: its mint marker comes from the log's position and the salt, and the network accepts each marker once. The commitment names the chain and the dollar, so a deposit mints nothing else: not another asset that names the same vault, and not another PCASH chain that reads the same Ethereum. Only the holder's wallet can make the proof, because only it can open the commitment. The holder needs a PCASH account, which its wallet's setup creates. While the protocol fee is waived, a holder can mint and pay with no PCASH; once it applies, each transaction burns a little PCASH, which a holder can buy on the Marketplace.

A deposit never expires: a wallet can mint it at any later time. A wallet restored from its seed finds its deposits by reading the vault's logs from the network's first Ethereum block and deriving the salt from each logged nonce, with no saved state; while it stays open, later listings read only newer blocks. If a reorganization of Ethereum removes the deposit's block, the mint goes with it, so minting needs no wait for finality.

The minted dollars are ordinary private notes. Holders pay each other the way they pay PCASH, and on the Marketplace they can sell dollars for ETH.

## Credits

The issuer credits wires and replacement units with `credit`, given a holder's deposit code and an amount. The vault emits the same `Deposit` event with the issuer as depositor, and the holder's wallet mints it like any deposit, privately. Every unit ever issued therefore appears on Ethereum. Credits are backed by whatever the issuer received off-chain, not by the vault's USDC.

The vault credits each deposit code once and reverts a second `credit` of the same code, so a credit the issuer retries because it never saw the first one's outcome cannot issue twice. A credit needs a fresh code from the holder. Deposits have no such limit: two deposits with one code are two payments, and both mint.

## Redemptions

A holder redeems by sending dollars to the issuer's PCASH address with the memo `redeem 0x…`, naming the Ethereum address to pay. The issuer's service finds each redemption in a finalized PCASH block, burns the units, waits for the burn to be final, and pays USDC from the vault to that address. The vault pays each redemption ID once, so a restart or retry never pays twice.

## Freezes and pauses

Every transfer and burn of the dollar proves that its sender is not on the issuer's deny list in a recent publication of the list. When the issuer freezes an address, that address can no longer send or burn the dollar once older publications expire, within the window the issuer set; everyone else is unaffected. A frozen address can still receive dollars, which then cannot leave it. A pause stops every transfer the same way. The issuer can credit replacement units to a theft victim.

A publication authorizes transfers only for its window, so the issuer's service publishes the unchanged list again whenever its latest publication is 15 minutes old. With a one-hour window, transfers never wait for a publication. Anyone can call the contract's heartbeat, and the contract publishes only the list it stores, so no one can revive an old list.

The issuer never sees balances or transfers, and cannot take or erase a frozen balance. A freeze takes effect within the window, so a thief watching Ethereum can move funds first.

## What is public

- On Ethereum: each deposit's depositor, amount and time; each credit's amount and time; each payout's address and amount; the vault's policy; and the deny list with every change to it.
- Private: who each deposit mints to, which PCASH transaction minted it, and every balance and transfer.

Ethereum shows what the issuer owes: deposits plus credits, less payouts. It does not show how many dollars circulate, because deposits not yet minted and burns not yet paid out are private.

Finding and minting deposits tells the wallet's Ethereum endpoint and its PCASH node some of this:

- Listing deposits reads every `Deposit` log of the vault from the Ethereum endpoint, the same requests whichever wallet lists, so the endpoint learns only that the wallet follows the vault. The wallet then asks its PCASH node whether the mint markers of its own deposits are spent, so the node learns how many deposits the wallet has and can tell the wallet's mint transactions once they land.
- Minting a deposit reads that deposit's transaction receipt from the Ethereum endpoint and asks the PCASH node for the deposit's proof, so each learns which deposit is the wallet's.

At each sync, a holder's wallet asks its Ethereum endpoint for the deny list's logs and its PCASH node for the opening of the list's latest publication, which tells both that the wallet holds some asset under that list.

A holder who runs its own PCASH node and its own Ethereum node keeps all of this to itself. Minting soon after a deposit links the two by timing, so a holder can wait before minting. A user account's address is its owner's Ethereum address, so a deposit sent from that address points to that account.

## What the issuer runs

The `stablecoin` package is the issuer's service. It never mints.

- **`StablecoinIssuer`** credits (`credit`), sets the vault's policy (`allow`, `setDepositCap`, `setDepositsPaused`), and redeems (`processRedemptions`, called on a timer). It runs on the issuer's PCASH wallet, which receives redemptions, and the vault's issuer key, and keeps each redemption's progress in a state store so a restart resumes it.
- **`DenyListAdmin`** freezes and unfreezes addresses, pauses and unpauses, sets the window, and runs the heartbeat (`startHeartbeat`). It runs on the list's issuer key.

Both send their Ethereum transactions through an `EthereumWriter`, one per key, which sends one transaction at a time and reports a transaction that another one replaced as not done. The vault and the list can share one key by sharing its writer.

The issuer also needs an Ethereum endpoint and its own PCASH node: it pays out USDC on what that node reports, so a node that lied could make it pay for a redemption that never happened.

## Run it

`just e2e stablecoin` starts Anvil and a PCASH node and runs the steps above with one issuer key for the vault and the list: the issuer sets the vault's policy, a deposit from an allowed account mints in the recipient's wallet without naming it on Ethereum and is listed under no other asset with the same vault, a wallet restored from its keys mints an unminted deposit and a second proof of the same deposit is refused, holders pay each other, a freeze and a pause stop senders, heartbeats keep transfers flowing as Ethereum time passes, a credit mints replacement units and a repeated credit is refused, a redemption pays out USDC once, a frozen Marketplace escrow is held and then reclaimed, and a reorganization that drops a deposit drops its mint.
