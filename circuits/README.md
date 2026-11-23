# PCASH circuits

These are the Noir circuits behind every PCASH client proof. They are proved with Barretenberg's CHONK folding scheme over BN254; the Nargo, Barretenberg, and CRS versions are pinned in `assets/prover-toolchain.json`. A manifest's `compiler_version` cannot name a pre-release, so the manifests require `=1.0.0` and the binary hash in that file is the binding pin. This file is a map of the directory and the reasoning behind its shape. `docs/protocol-spec.md` is normative for what each circuit must enforce, and each section below links to the part of the spec that defines it.

## Layout

```
manifest.json              Catalog of every provable circuit: package, path, role, profile, proving runtimes
Nargo.toml                 Generated workspace
protocol/                  Consensus: everything the node's pinned keys cover
  lib/                     pcash_protocol: the protocol relations every protocol circuit wraps
    src/primitives/        Hashing, range checks, and witness types
    src/state/             Merkle and block-header openings
    src/authorization/     Account commitments and rule-entry authentication
    src/ledger/            Shared by every proof-carrying type: notes and nullifiers, the private value
                           and its commitment, input openings, assets, and the native fee relation
    src/kernels/           The five type 0x00 kernel relations
    src/recursion.nr       Proof linking and the hiding-kernel relation
    src/events.nr          Uniform event verification, entry, and commitment
    src/generated/         Constants owned by generators
  no_op_event_application/       Reference no-op event application; its VK is not pinned by consensus
  private_value/{s,l}/     Type 0x00: five protocol kernels and the hiding kernel per profile
  user_account_update/     Type 0x03: protocol kernel and hiding kernel
rules/                     The reference wallet's account rules and the standard mint and transfer rules: not consensus
  lib/                     reference_rule_common: relations shared by the rules
signature/                 signature_common: secp256k1 and EIP-712 for applications
fixtures/                  Test and demonstration applications
vendor/                    Pruned Poseidon2 and Keccak crates
```

The protocol kernels and library define consensus; `protocol/no_op_event_application/` is the reference no-op convention. The directories `rules/`, `signature/`, and `fixtures/` serve authorization rules and event applications. All Noir dependencies are local paths, so compiling needs no network access.

## How one proof is assembled

A transaction carries one proof, but that proof folds an ordered stack of circuits ([spec §8.1](../docs/protocol-spec.md#81-chonk-proofs-and-verification-keys)):

```
application  ->  application  ->  protocol kernel  ->  hiding kernel
  private          private            private         public inputs
```

Single-rule stacks contain four circuits, the fewest Barretenberg's CHONK accepts: one rule, an event application, the protocol kernel, and the hiding kernel. Sponsored transfers, restricted transfers and mints fold two rules followed by an event application, then the two kernels, for five circuits, and a restricted sponsored transfer folds three rules, for six.

- An **account rule** is the application an account installs to authorize its actions. It decides whether this account approves this action, by whatever means the rule's author chose, and returns the rule statement `[authorizationCommitment, actionCommitment, recentPcashBlockHash, eventEntry]`: which account acts under which configuration, what it approves on this chain, the block whose state the proof reads, and the actual event entry ([§8.2](../docs/protocol-spec.md#82-the-rule-statement)). A rule computes each field it can open and takes the rest as witnesses.
- An **asset rule**, a mint rule or a transfer rule, is named by an asset's definition rather than installed by an account. It returns the same statement shape with a mint context or transfer context in place of the authorization commitment, and the kernel binds it to the asset by deriving the asset ID from its VK hash ([§11.6](../docs/protocol-spec.md#116-assets), [§11.8](../docs/protocol-spec.md#118-restricted-transfer-kernels)).
- An **event application** returns `[actionCommitment, recentPcashBlockHash, event]`. The kernel checks its action and anchor and binds its actual VK and claim into the event entry. The reference no-op (`protocol/no_op_event_application/`) returns the supplied action and anchor with claim `0`; it follows the same relation as every other event application.
- A **protocol kernel** enforces the ledger rules for one kind of action: account and rule membership, note ownership, nullifiers, and value conservation. It recomputes the statement it expects from each rule and links the applications' proofs.
- A **hiding kernel** accepts only the protocol kernels pinned for its family and exposes the kernel's statement as public inputs. It is the only circuit with public inputs; everything before it hands its statement along privately through the CHONK databus.

Barretenberg calls the MegaZK circuit that ends a CHONK stack the hiding kernel.

Each layer is proved in its own Barretenberg flavour: applications as MegaApp, protocol kernels as MegaKernel, and hiding kernels as MegaZK. MegaKernel has no lookup or non-native-field relation, and MegaZK additionally has no elliptic or memory relation. MegaApp checks only the return-data bus and MegaZK only `call_data(0)`, so an application must not read `call_data`, and a hiding kernel must not read another bus or return databus data. The pinned Barretenberg refuses to build a circuit whose gates or buses its kind's flavor does not constrain.

Two facts are specific to this directory. The verification-key pins each layer compiles in come from `protocol/lib/src/generated/protocol_stack_hashes.nr`, each named for the package it pins: `PRIVATE_VALUE_TRANSFER_KERNEL_VK_HASH` pins `private_value_transfer_kernel`. Profile dimensions live in `assets/private_value_profiles.json`; browsers prove S by default and L is proved natively.

## Protocol stacks

Each entry point under `protocol/` is one Noir package named `<family>[_large]_<directory>`: `private_value_transfer_kernel` is the S transfer kernel, `private_value_large_transfer_kernel` its L counterpart.

### Private value (`protocol/private_value/{s,l}/`)

Transaction type `0x00` ([spec §11](../docs/protocol-spec.md#11-private-value-transactions-txtype-0x00)). The kernel relations are in `protocol/lib/src/kernels/`, and the hiding-kernel relation in `protocol/lib/src/recursion.nr`.

- `transfer_kernel` — one account spends its own notes: native payment, asset transfer or burn, or an action that spends nothing. It opens the account and its rule entry, opens each real input and derives its nullifier, checks native and asset conservation, and links one rule, then an event application. Relation: `transfer.nr`. [§11.4](../docs/protocol-spec.md#114-the-transfer-kernel)
- `sponsored_transfer_kernel` — a contract account's asset action whose native fee is paid by a distinct user account. It authenticates both accounts, assigns asset inputs to the contract and native inputs to the sponsor, and links two rules with role-separated statements, then one event application. It is a separate kernel because it consumes two rules where the transfer kernel consumes one, and because the sponsor's authority must stay bounded to its own fee contribution. Relation: `sponsored_transfer.nr`. [§11.7](../docs/protocol-spec.md#117-sponsored-transfer)
- `restricted_transfer_kernel` and `restricted_sponsored_transfer_kernel` — the two relations above for an asset with a transfer rule. Each derives the asset ID from the definition's core and transfer rule, requires the restricted class, a real asset input and account membership, and folds the rule's application for this profile after the account rules, with a statement that names the asset, the rule's configuration, the owner of the asset inputs and the deadline. The unrestricted kernels accept only asset IDs of the unrestricted class, so a restricted asset cannot move without its rule. Relations: `restricted_transfer.nr`, `restricted_sponsored_transfer.nr`, over the relations of `transfer.nr` and `sponsored_transfer.nr`.
- `mint_kernel` — the only relation that creates asset value. One authenticated account, a user or a contract, approves the mint and pays its fee from its own native notes. The kernel derives the asset ID from the definition with the VK hash of the mint rule it folds, requires the class the transfer rule implies and at least one mint marker, and folds the account's rule, then the asset's mint rule, then an event application. The mint rule's statement names the asset, the rule's configuration, the account and the deadline; the rule bounds what is minted. Relation: `mint.nr`.
- `hiding_kernel` — accepts any of the five protocol kernels above for its profile and exposes the transaction's public inputs ([§11.2](../docs/protocol-spec.md#112-public-inputs-and-validation)). Relation: `recursion.nr`.

### User-account update (`protocol/user_account_update/`)

Transaction type `0x03` ([spec §12.3](../docs/protocol-spec.md#123-user-account-update-txtype-0x03)). The kernel checks a compare-and-swap of the account's state, with the account's own native notes paying the fee, and links the account's administration rule. Its hiding kernel adds the account update commitment as a public input, which the node recomputes from the live account row; the rule approves the update's action commitment, which binds that commitment and the fee payment.

User-account updates are compiled at S dimensions and use `fee_payment.nr` for the fee relation. Contract creation is proof-free; a private-value transaction can attach its body or a signed user creation.

## Reference rules (`rules/`)

Two kinds of ordinary application live here, and the protocol requires neither: the account rules the reference wallet installs, and the standard mint and transfer rules an asset's definition can name. Each passes its private `eventEntry` witness through as the fourth return word and does not constrain which event accompanies the approved action.

### Account rules

The authorization applications the reference wallet installs. Each opens the complete transaction it approves, and all but `mine` verify a secp256k1 signature over an action-specific EIP-712 message.

- `mine` — signature-free rule that approves only a transaction with no real inputs.
- `payment` — a native payment to one recipient, with one change output and an optional relay output.
- `asset_payment` — a payment of one asset.
- `asset_burn` — a burn of one asset.
- `batch_transfer/{s,l}` — multiple recipients, native and asset, with an optional burn.
- `mint/{s,l}` — an account's approval of a mint under any mint rule. It shares its name with `mint_kernel` because it authorizes exactly the action that kernel proves. Every minted unit is a declared output.
- `contract_fee_sponsorship/{s,l}` — a user account paying the fee for a named contract's action.
- `admin` — a user-account update.

Rules with `s` and `l` directories are generated wrappers over a relation in `rules/lib/`. The others are hand-written at S dimensions.

Each ECDSA configuration commits the EIP-712 domain separator, as two 128-bit halves, under which the rule verifies signatures, and the account's nullifier-key commitment ([Appendix B.2](../docs/protocol-spec.md#b2-recoverable-ownership)). It names no signer: the rule derives the signer's address from the public key and returns it in its authorization commitment, so the kernel accepts the signature only from the account's own key. The rule opens the nullifier-key commitment with the `nkRoot` from which it derives owner change and self-designated issuance secrets, so a proof builder cannot substitute another root. Each signed message carries the PCASH chain ID that the rule hashes into its action commitment. Exact configuration fields, slots, type strings, and VKs live in `sdk/src/rules/`, `sdk/src/eip712/`, and here.

**What the value rules authorize.** Payment, asset payment, burn, and batch rules authorize the displayed external effects and reject state markers they cannot describe. Ordinary outputs not declared as payments must return to the owner under the owner's deterministic change secret, except one exact private native relay output. Change in one namespace is split one way only, into full-size notes and then one remainder, so the owner can recompute every change amount. The signed transaction context fixes every nullifier the action spends. A mint has its own readable approval for the asset ID, the declaration of every minted output, the open fee, private relay payment, issuance destination, and timing; the signed transaction context fixes its mint markers.

The payment rule accepts any payment amount, including zero. A positive amount is a native note to the recipient. At zero the payment slot must be a canonical dummy, so the action creates no recipient note and credits no balance, but the recipient is still a signed field of the approved message; the signed transaction context binds the action's nullifiers, including the dummy ones, so each authorization executes at most once.

**What a value rule binds about publication.** Its semantic approval binds the public `openFeeAmount` and `nativeBurnAmount`, the exact ordinary private relay amount and owner commitment when present, `issuanceOwnerCommitment`, and the transaction context. A selected relayer is paid through an ordinary native output with a fresh owner commitment independent from any designated issuance commitment; the signed rule binds both effects, and its circuit rejects unexpected extra outputs. Self-publication has no PCASH fee output and may designate the wallet's own one-time issuance commitment; when the signer names its own address, the rule requires the secret its payout seed derives for the transaction, so a seed restore recovers that issuance. The wallet authenticates a selected-relayer quote before signing; the circuit does not add another recipient-signature scheme.

**Native burns.** Each value rule, `admin` included, accepts two message types. The base type carries no burn, and the rule requires a zero `nativeBurnAmount`. Its `WithBurn` variant inserts the network fee and the voluntary burn after the open fee, and the rule requires each below 2^128 and their sum to equal `nativeBurnAmount`. The burn selects the type, so the rule hashes one encoding: `signature_common` absorbs both lengths in one Keccak sponge and keeps the state after the selected message's last block.

**Sponsorship.** The sponsorship rule approves a bounded native contribution to a named CONTRACT action or creation: an open fee or one exact ordinary private relay output, the native burn, and sponsor change under the sponsor's derived change secret. It signs the relay amount and owner commitment separately from the issuance destination and cannot authorize spending the primary contract's value. A CONTRACT action through the transfer kernel separately permits native or mixed contract-owned inputs, native payouts, and contract-funded open fees without a USER initiator.

**Administration.** The `admin` rule signs the exact account transition, open fee, native burn, optional private relay amount and owner commitment, transaction context, and validity window. The transition names the new rule set only by its root, so an update installs whatever rule set the wallet app built, and the signer cannot check what that rule set contains. The account revision prevents replay after a successful update; expiry is also signed. Its proof permits only the open fee, the exact private relay output, and owner change under the owner's derived change secret. Updates earn no issuance, so the rule signs no issuance destination; the node supplies the zero issuance word.

**Contract rules and recovery.** A CONTRACT rule decides whether its actions leave issuance to the successful poster or designate a one-time issuance commitment, and how that recipient obtains the secret opening. Its authorization must separately account for any open fee or ordinary private relay output. It cannot assume that its nullifier key is private: a published-root contract exposes that material in its identity. Recovery is up to each application, not a universal convention.

### Standard mint and transfer rules

No account installs these: an asset's definition names them as its mint rule or its transfer rule, and none verifies a signature. Wallets recognize one by its complete pair of VK hashes and its decoded configuration, and show any other rule as custom.

- `fixed_supply` — a standard mint rule: one mint, of exactly the configured supply, under a marker keyed by a secret the configuration commits to. One VK serves both profiles.
- `account_mint` — a standard mint rule: the configured account mints whenever its own rule approves. It reads no private value. One VK serves both profiles.
- `deposit_mint` — a standard mint rule: one mint per `Deposit` log of the configured Ethereum vault, opened under the recent block, of exactly the deposited amount to the PCASH address the log's recipient commitment opens to, with the chain and the asset being minted, under a marker keyed by the log's block, its leaf index in the block's normalized-log tree and the commitment's salt. It has an S key only: a deposit mints one note.
- `sender_deny_list` — the standard transfer rule: the sender of a restricted asset is not on its issuer's deny list as of a recent unpaused publication from the issuer's Ethereum contract. It reads no private value. One VK serves both profiles and both restricted kernels.

## Fixtures (`fixtures/`)

Demonstration and regression applications. They are compiled, tested, and bundled like the rules above but are not shipped wallet rules.

- `full_transaction` — a fixed-shape owner-only rule that signs every output declaration; the signer is the authorizing account. It serves low-level testing; it is not a product USER rule.
- `multisig` — two of three secp256k1 signers. It commits its threshold and sorted signer set, and the configured signers approve the account's address and the exact action commitment, whose private value binds the open fee, ordinary outputs, and issuance destination. A production multisig should supply readable semantics for its supported actions and a recovery convention for any issuance destination it designates; the website does not present the opaque approval as a product USER rule.
- `asset_covenant` — a contract rule that lets asset value move only to one successor contract. It sends all real outputs to an authenticated live successor and caps the public open fee and native burn together, leaving any issuance destination to the proving application. It controls whichever asset the kernel authenticates; it does not redefine an asset or mint another supply.
- `sender_authentication` and `large_sender_authentication` — events proving the owner of an opened input note under S and L.
- `event` — a claim with action and anchor witnesses for kernel-family binding tests.
- `event_gate` — a rule whose installed configuration requires one event entry, returned directly for the kernel to match.
- `shared_asset_claim` — one application valid under either profile, as the rule of a transfer or the primary rule of a sponsored transfer. Native proving only.
- `voucher_minter` — a mint rule that mints a fixed amount of its asset once per voucher; any account may submit the mint. Native proving only.

## Libraries

```
vendor/poseidon   <- pcash_protocol   <- reference_rule_common
vendor/keccak256  <- signature_common <- reference_rule_common
```

- `pcash_protocol` (`protocol/lib/`) is the protocol relation, kept apart from any authorization rule or wallet convention; [Layout](#layout) lists its modules. Every protocol circuit depends on this library alone.
- `signature_common` (`signature/`) provides secp256k1 verification, Ethereum address derivation, and EIP-712 hashing to applications: the rules, the fixtures, and the marketplace reclaim circuit. No protocol circuit uses it.
- `reference_rule_common` (`rules/lib/`) provides the checks the wallet rules have in common: configuration commitments, issuance openings, owner change, relay terms, and the payout and output note-secret derivations of spec Appendix B. It also holds the profile projection that lets one application open either profile. Sharing source keeps those checks identical across rules without the rules sharing a key.
- `vendor/` crates are pruned upstream releases; [`PROVENANCE.md`](../PROVENANCE.md) records their origin and local edits.

Verification-key pins add a build-order dependency: protocol kernels must be built before their hiding kernel. The SDK also records the reference no-op event-application identity so builders can prepare its entry before authorization.

## Generated files

`manifest.json` and the files under `assets/` and `vectors/` are the sources. `scripts/circuits/gen_constants.mjs` writes the workspace `Nargo.toml`, each executable package's `Nargo.toml`, the entry-point wrappers (every `main.nr` under `protocol/private_value/`, the account-action hiding kernels, and the `s`/`l` reference rules), the domain-tag and profile constants in `protocol/lib/src/generated/`, and `rules/lib/src/generated/reference_rule_constants.nr`. `scripts/gen_network_profile.mjs` writes `rules/lib/src/generated/network_profile.nr`, `scripts/circuits/gen_reference_message_types.mjs` sets the EIP-712 type hash in each hand-written circuit from the TypeScript type string its signer uses, and `scripts/gen_vectors.mjs` writes the `*_vectors.nr` files. Every generated file names its generator on its first line. Generators write Noir in `nargo fmt` layout through `scripts/noir_layout.mjs`, and full CI runs `nargo fmt --check` over the workspace (`vendor/` keeps upstream formatting; [`PROVENANCE.md`](../PROVENANCE.md) lists its local edits) and the marketplace and token packages. To add a circuit or change a profile dimension, edit the source and run `just generate`, which runs every generator in order.

`manifest.json` declares each stack link: the `call_data` bus of each circuit a circuit folds, and the pinned circuits that may fill it. The event application occupies one databus position with no special case for the reference no-op. Circuit-bundle generation derives the verification-key pins in that dependency order (`scripts/circuits/stack_pins.mjs`), and derives the rule pins its known-answer proofs use in the same build tree (`scripts/circuits/application_pins.mjs`), so a bundle never depends on the committed pins. After a circuit change, `just pins` writes the stack pins to `protocol/lib/src/generated/protocol_stack_hashes.nr`, the rule pins to `sdk/src/constants/rulePins.ts`, and each contract function's pin to its application's `applicationPins.ts` and its contract's `manifest.json`; `just pins --check` rejects a stale pin.

The library manifests are hand-written, as is the source of the no-op event application, the account-action protocol kernels, the unprofiled reference rules, and the fixtures.

## Building and testing

```sh
just tools                                       # install the pinned Nargo and Barretenberg
just test-noir                                   # nargo test across the workspace
just generate --check                            # reject stale generated files
just circuit-bundle                              # compile, derive keys, and produce known-answer proofs
```

Compiled circuits, verification keys, and proofs are never committed.

### Circuit bundles

`assets/network_profile.json` supplies the circuit-static EIP-712 type/name/version hashes and the reference deployment defaults. PCASH/L1 chain ids and the inbox are runtime network configuration; they do not change circuit artifacts. The inbox is a routing tag, not a smart contract: PCASH reads transactions sent to it as data. Run `node scripts/gen_network_profile.mjs --check` to reject stale generated Noir, TypeScript, or Rust outputs. `assets/prover-toolchain.json` pins the supported Nargo/Noir and Barretenberg release archives, the `nargo` and `bb` binaries inside them, and the BN254 and Grumpkin CRS files; `just tools` authenticates and installs them under the ignored `.pcash-tools/` directory.

Run `just circuit-bundle` to generate or reuse the development circuit bundle. Generation copies one immutable source snapshot, derives the first cache key from the exact bytes in that snapshot, and builds only that snapshot. The key covers the core and marketplace circuit sources, SDK sources, network profile, pinned compiler and verifier stack, CRS, and generator inputs. The rule and application pins are outputs of the bundle, not inputs to its key. A second digest identifies the compiled circuits, verification keys, and manifests, so two builds of one commit produce the same digest; the randomized known-answer proofs are hashed beside them, outside that digest. The ignored layout is `.cache/pcash/circuit-bundles/<kat-set>/<source-fingerprint>/<bundle-digest>/`, where the known-answer set is `full` or `runtime` (`PCASH_CIRCUIT_KAT_SET`). The bundle contains compiled browser artifacts, hiding-kernel and application VKs, verifier known answers, and manifests. `just build`, SDK and marketplace tests, Rust builds, CLI proving, and the E2E suite resolve the same bundle automatically. `PCASH_CIRCUIT_BUNDLE=/path/to/bundle` supplies an explicit bundle and fails if its inventory, hashes, or source-input fingerprint are invalid; it does not select a separate committed-artifact mode.

`just ci` runs the release proving suites against one freshly generated bundle with `PCASH_REQUIRE_PROVER=1`, so missing tools fail them rather than skip them. Generated circuit artifacts are not source files and are not committed.
