# PCASH Protocol Specification

This specification defines the deterministic PCASH state transition: how a node turns canonical Ethereum history into PCASH blocks. It covers canonical commitments, transaction wire formats, proof relations, the account-rule interface, genesis, fork rules, and, in Appendix A, the criterion for when a later protocol may claim monetary continuity with this chain. Outside the appendices, a requirement belongs here only when differing implementations could derive different PCASH state, compute different protocol commitments, or disagree on whether a transaction or proof is valid. Appendix A instead defines when a later protocol may claim canonical monetary continuity with this chain; it imposes no state transition. Appendix B records conventions of the reference node and wallet that are not consensus.

Node, SDK, wallet, RPC, storage, relay, recovery, and application conventions are outside protocol semantics; Appendix B records the few that another implementation needs in order to interoperate. The reference implementation's account rules are described in [`circuits/README.md`](../circuits/README.md#reference-rules-rules).

**How this document is organized.** Section 1 explains every concept the protocol uses and how the pieces fit together; read it first. Sections 2–8 define data: encodings and primitives, configuration, notes, accounts, state, blocks, and proofs. Sections 9–15 define processing: §9 gives the per-block procedure and how a node reads Ethereum; §10–§13 admit and execute transactions of each type and define fees; §14 covers issuance and block settlement; §15 covers system payouts. Section 16 pins the proof-system release, and §17 lists conformance vectors. Appendix A gives the monetary continuity criterion, and Appendix B the reference conventions that are not consensus.

## Conventions

* **Requirement words.** MUST, MUST NOT, SHOULD, and MAY are requirements on implementations. Formulas, layouts, tables, and check orders are normative. Explanatory prose says why a rule exists or how the pieces fit, and adds no requirement of its own. Appendix B holds reference conventions, which are not consensus rules.
* **Byte strings.** `‖` is byte concatenation. In a wire layout, `name (n)` is a field of `n` bytes, `u8`, `u16`, `u32`, and `u64` are unsigned integers of that many bits, and every multi-byte integer is big-endian (`u16be` and `uint64be` say so explicitly). `count × [ ... ]` repeats a group `count` times.
* **Field elements and widths.** Circuit values are elements of the BN254 scalar field (§2.2). Inside a hash input, `uintN(x)` is the integer `x`, which MUST fit in `N` bits, used as a field element. The one exception is the contract address, where `uint160(...)` explicitly takes the low 160 bits (§12.4). `xHigh128` and `xLow128` are the big-endian high and low 128-bit halves of a 256-bit value `x`, a lossless split used for Ethereum block hashes (§7.2, §7.4), Ethereum log topics (§7.2), and the signed issuance lag (§6.5).
* **Hashes.** `poseidon(...)` is the length-tagged Poseidon2 sponge of §2.3, and `poseidonBytes(DOMAIN, b)` is its form over a byte string `b`. PCASH hashes with Poseidon2; §2.3 lists the places that use Keccak-256 instead. `keccak256` is Ethereum's original Keccak-256, not NIST SHA3-256. `H(...)` in Appendix B also means `poseidon(...)`.
* **Formulas.** Code blocks give exact formulas and layouts. Operand order in every hash is normative.
* **L1** means Ethereum, the chain PCASH derives from.
* **Canonical** has three senses, distinguished by context. A block, transaction, or hash is canonical when it is part of the current canonical Ethereum chain or the PCASH chain derived from it. A field value is canonical when it is below `p` (§2.2). An encoding is canonical when it is the unique valid representation of its value.

## 1. Overview

This section explains what a PCASH node computes and introduces every concept the rest of the specification uses. It is a guide, not the rule text: where it states a rule, the section it names is normative, and that section governs if the two ever differ.

### 1.1 What a node computes

PCASH is a private-value network whose blocks are computed from Ethereum. Ethereum supplies ordering and data availability: PCASH transactions are posted in ordinary Ethereum transactions, as calldata, blobs, or event logs. Ethereum does not execute them, and there is no PCASH smart contract on Ethereum. Every PCASH node reads canonical Ethereum history and applies the rules in this document to it. Because the rules are deterministic, every correct node derives the same PCASH chain, and so does anything else that evaluates them, including a proof system that could prove the result to a light client or an Ethereum contract.

The chain starts at a configured Ethereum block, the **anchor**. Every canonical Ethereum block from the anchor onward produces exactly one PCASH block: Ethereum block `anchor + N` produces PCASH block `N`. No one proposes or signs PCASH blocks. A PCASH block is the result of executing, in Ethereum order, the PCASH transactions that the Ethereum block carries, then settling fees and issuance for the block, then committing the resulting state and history. When Ethereum reorganizes, the PCASH blocks derived from abandoned Ethereum blocks are discarded and the replacement blocks are derived from the common parent state (§9.5).

Native PCASH is the network's own money and its fee currency. It starts at zero: genesis has no notes, no accounts, and no spent nullifiers. New native PCASH is created only by issuance to successful qualifying transactions (§14), up to a gross total of 1,000,000,000 PCASH, with no calendar deadline. Fees move existing PCASH and never create supply. There is no public spendable balance and no public form of PCASH. With nothing to deposit or withdraw, no holder's privacy depends on how much value others keep in a shielded pool. PCASH is its own asset, not a claim on ETH, and the protocol does not redeem it. It trades for ETH through PCASH contracts that require the Ethereum payment in the same Ethereum transaction (§10.6), so an exchange needs no custodian or bridge operator.

### 1.2 Concepts

**Notes.** Value exists only as notes. A note has an owner, an asset ID, and an amount, plus a secret known to whoever holds the note. Asset ID `0` is native PCASH. A nonzero asset ID names one instance of the standard fixed-supply fungible asset (§11.6), which anyone can create. The ledger never stores a note's contents. It stores a commitment built in three layers (§4.3): an **owner commitment** hides the owner behind the note secret; a **note-body commitment** adds the asset ID and amount; and an **output commitment** adds the note's position in the output tree. The data needed to recompute a commitment is the note's **opening**. Receiving a note requires no registration and no consent from the recipient.

**The output tree.** Every note ever created is appended, as its output commitment, to one append-only Merkle tree keyed by a sequential `outputIndex` (§6.2). Spent notes are never removed from it.

**Nullifiers.** Spending a note publishes its **nullifier**, a value derived from the note's output commitment, its owner's note key, and its secret (§4.3). Every valid spend of the same note produces the same nullifier, and nothing public links the nullifier to the note. Nodes keep the set of all nullifiers ever published (§6.4); a transaction that presents one already in the set fails. The same set also holds three other kinds of one-time markers: dummy nullifiers for padding slots, application markers that account rules use for replay protection, and asset-creation markers that make each asset's creation happen once (§11.3).

**Accounts.** An account is the control point for spending. It is identified by a 160-bit address and stored as one `AccountState` row in the account tree (§5, §6.3). The row commits the account's address, its **nullifier-key commitment** (a commitment to the account's note key root, `nkRoot`, normally secret and fixed forever at creation), its **rule set**, its kind, a revision counter, and an optional **receive key** that senders can use to encrypt note openings to it. There are two kinds:

* A **user account** (`USER`, kind `0`) belongs to an Ethereum address. The ECDSA key for that address authorizes its creation (§12.2), because no rules exist before it. After creation, only the account's installed rules can authorize its spending and its updates (§12.3). There is one user account per address.
* A **contract account** (`CONTRACT`, kind `1`) has no key. Its address is derived from its contents, its rules are fixed at creation, and it can never be updated (§12.4). Anyone can publish its body without a proof (§12.4), or attach it to a private-value transaction (§11.2). Afterwards a contract can hold native and asset notes, pay native fees, and pay out directly, without any user account initiating its actions.

A note's owner is an account address. Spending existing value requires authorization from the owning account's installed rules, so it requires a registered account. One case needs no registered account: a transaction whose inputs are all padding spends nothing and exercises no account's authority (§11.4).

**Actions.** An **action** is the complete content that one transaction asks account rules to authorize. It has two parts. The **private value** is the value the transaction moves: its inputs, outputs, fee, issuance destination, validity conditions, burn, and optional creation attachment, committed as one private-value commitment (§11.3). The **extra data** is what the action needs beyond the private value: the account change of an account update (§12.3), the contract whose fee a sponsor pays (§11.7), and otherwise nothing. Every proof-bearing transaction carries exactly one action, so this document counts qualifying actions and qualifying transactions interchangeably.

**Account rules and applications.** An account's rule set is a sparse Merkle tree of up to 256 **entries** (§5.2). An entry commits the hash of one circuit's verification key, called an **application**, plus a configuration commitment that the application interprets. A user account's entries are called **rules**; a contract account's entries are called **functions**. An application decides whether to authorize an action. It returns four values to the protocol, the permanent rule statement (§8.2): a commitment to the account it acts for and the configuration it applied, a commitment to the exact action it approves on this chain, the recent block whose state it read, and the transaction's event entry. PCASH attaches no meaning to an entry beyond that statement: there are no capability flags. Anyone can write an application, and a weak one endangers only the accounts that install it.

**Proofs.** Types `0x00` and `0x03` carry one CHONK zero-knowledge proof (§8.1); standalone user-account and contract-account creations carry none. The proof folds two applications, or three for a sponsored transfer, then a **protocol kernel** that enforces the ledger rules (note membership and ownership, nullifier derivation, output construction, value conservation, asset rules) and checks that each account rule approved the exact action, then a **hiding kernel** that accepts only the type's protocol kernels and exposes the transaction's public inputs. A kernel that consumes one rule folds an event application second (§8.6). Nodes verify only the final proof, against a hiding-kernel verification key pinned for the transaction type (and, for type `0x00`, for its profile). A type `0x00` proof uses one of three private kernels: the **transfer** kernel, where one account owns every real input; the **sponsored-transfer** kernel, where a user account pays the native fee of a contract account's asset action; and the **asset-creation** kernel, which creates a new asset (§11.5). Type `0x03` has its own kernel. CHONK is the client-side proof-folding scheme of the Barretenberg proving system, and MegaApp, MegaKernel, and MegaZK are its circuit and verification-key formats. A node verifies proofs by calling the pinned Barretenberg release (§8.1, §16); it does not implement the scheme itself. Which account acted, which rule approved, which notes were spent, and what amounts moved stay private.

**Transactions.** A transaction is one byte string, `txBytes`, with a common envelope naming its type and its PCASH chain ID (§10.1). There are four types:

* `0x00`, a **private-value transaction** (§11): spends and creates notes of native PCASH, of one private asset, or both. It uses one of two fixed **profiles**: S, with 4 input slots and 5 output slots, or L, with 32 of each.
* `0x01`, **user-account creation** (§12.2): registers a user account. It carries no proof and pays no PCASH fee.
* `0x02`, **contract-account creation** (§12.4): publishes a contract body without a proof, signature, or PCASH fee.
* `0x03`, **user-account update** (§12.3): replaces a user account's rule set or receive key, paid for from the account's own notes.

Types `0x00` and `0x03` contain the same **private-value section** (§10.3): the proof, its public inputs, one fixed-size data item per output, and one fixed-size arena shared by the outputs. Public inputs include the nullifier of every input slot, the note-body commitment of every output slot, one commitment to the section's output data and arena, the recent block the proof used, the open fee, the issuance destination, the time window, the carrier context the transaction requires, and a blinded event commitment, and an account-creation attachment commitment. Every slot is always filled: unused slots hold **padding** (class `DUMMY`), which is indistinguishable from real slots from outside the proof, so the public shape reveals only the profile.

**Recent block.** Every proof names one `recentPcashBlockHash`. A node accepts the transaction only while that block is canonical and at most `RECENT_PCASH_BLOCK_WINDOW_SECONDS` (one hour) older than the block being derived (§10.6). Inside the proof, the circuits open whatever state they need beneath that single hash: the output tree, the account tree, Ethereum history, or earlier PCASH blocks (§8.4). Nothing about which parts were opened is public.

**Batches, carriers, posters, and relaying.** A **batch** is a short header followed by a list of items, each item a candidate `txBytes` (§9). A **carrier** delivers one batch, in one of two ways. An Ethereum transaction sent to the configured `INBOX_ADDRESS` is an **Inbox transaction**, and its calldata, or the payload decoded from its blobs, is its carrier. Any Ethereum contract can also deliver a batch by emitting a `PcashBatch` log, a **carrier event**, and one Ethereum transaction may emit any number of them. Anyone may post a batch; there is no sequencer. The batch header names the poster's **poster owner commitment**, the recipient of open fees and open-route issuance, which is not the Ethereum address that sent or emitted the carrier.

**Carrier context.** Every carrier has a **carrier context**: the Ethereum address that vouches for it and what that address says. For an Inbox carrier it is the Ethereum sender, which says nothing more; for a carrier event it is the emitting contract and the context bytes it emits with the batch (§9.1). A transaction may require one exact carrier context, which the node checks at execution, as it checks the time bounds (§10.6). A transaction can thereby require, for example, that one contract deliver it with context bytes describing a payment that contract took in the same Ethereum execution.

**Admission, outcomes, and fatal errors.** An item is **admitted** as a transaction only if it is at most `MAX_TX_BYTES`, its envelope names this chain, its bytes decode completely as their transaction type, that type is active at the Ethereum block's timestamp, and, for a direct-mode account creation, an Inbox carrier delivers it (§10.2). Non-admitted items are skipped and produce no result. Every admitted transaction executes in order against the state left by every earlier successful transaction, and receives exactly one **outcome** (§10.5): `Succeeded`, or the first failed check in a fixed order. A failed transaction changes no state, but its outcome is part of the block, and its bytes are committed through the block's L1 origin (§7.3, §7.8). A block is derived only once all of its input is available: blob data that cannot be obtained yet is fetched again before derivation starts (§9.2). When a node cannot evaluate something at all, such as a verifier that cannot run, that is a **fatal derivation error**: derivation stops at that Ethereum block and never turns the problem into an outcome.

**Fees and issuance destinations.** Every private-value section declares an `openFeeAmount`, existing native PCASH paid publicly to the poster of the batch that successfully includes it, and a type `0x00` transaction also declares an `issuanceOwnerCommitment`, where its issuance goes (§13). A nonzero issuance commitment names a one-time destination fixed by the proof; zero sends issuance to the successful poster. A positive open fee and a nonzero issuance commitment are mutually exclusive. A wallet can also pay a chosen relayer privately, as an ordinary encrypted output.

**Issuance and settlement.** After all transactions in a block have executed, the node counts the successful qualifying transactions (every successful type `0x00` transaction), computes one issuance amount `rewardEach` that each of them earns (§14.2), and appends **system payout notes**: first designated issuance in transaction order, then each poster's open fees and open-route issuance as separate notes, fees first and zero amounts skipped. System payouts are ordinary native notes with public amounts and hidden owners (§15). Because settlement appends these notes after the block's transactions, each transaction reserves room in the output tree for the payout notes it could cause, and fails with `OutputCapacity` if that room is not available (§14.3).

**State, blocks, and history.** After each block, the state is summarized by a **StateRoot** (§6.5) committing the output tree, the account tree, the nullifier set, gross issuance, and the issuance controller's lag. The **block header** (§7.5) commits the parent block, number, timestamp, the block's transaction and payout results, the StateRoot, a tree of every Ethereum block since the anchor with its event logs (§7.2), and a tree of every earlier PCASH block (§7.6). The block hash is the root of the header tree.

### 1.3 The derivation loop

The normative block procedure is at the start of §9. This outline shows the whole of derivation at a glance, with the section that defines each step.

```text
parent = empty genesis state and no parent block                      (§7.7)
for N = 0, 1, 2, ...:
    B     = canonical Ethereum block GENESIS_L1_BLOCK_NUMBER + N
    rules = fork rules active at B.timestamp                            (§3.2)
    issuance inputs from the parent state and B.timestamp               (§14.1)
    for each top-level Ethereum transaction in B, in index order:
        for each carrier: Inbox carrier if any, then carrier events     (§9.1, §9.4)
            candidate batch = calldata, decoded blobs, or event batch   (§9.1–9.2)
                (unavailable blobs are a fatal error; a malformed carrier is ignored)
            frame the batch into items, or ignore it whole              (§9.3)
            for each item, in order:
                if the item is not admitted: record why; continue       (§10.2)
                outcome = first failing check, else Succeeded           (§10.5, §11–§12)
                if Succeeded: apply its effects to the working state
                record TransactionResult and keep the exact bytes       (§7.3, §7.8)
    settle the block: rewardEach, system payouts, issuance, lag         (§14.2–14.3)
    record each payout's PayoutResult                                   (§7.3)
    append L1 origin leaf N; build StateRoot and header                 (§6.5, §7.2, §7.5)
    commit the block atomically, then append history leaf N             (§14.4, §7.6)
```

## 2. Encodings and Primitives

### 2.1 Integer encodings

Multi-byte integers in PCASH wire formats are unsigned and big-endian, except for the signed issuance lag of §14 and §6.5. Field elements are encoded as 32-byte big-endian integers. Ethereum and PCASH account addresses are 20 bytes, widened to `uint160` inside field arithmetic.

Value ranges:

* `PCASH_CHAIN_ID` is a PCASH network identifier `< 2^32`. `L1_CHAIN_ID` is the EIP-155 identifier of the Ethereum chain that carries PCASH data.
* A PCASH block number is `< 2^64`.
* Every note amount and every native-PCASH fee MUST be `< 2^AMOUNT_BITS`, with `AMOUNT_BITS = 128`. Burn amounts and an asset's initial supply MUST be `< 2^131`. Asset input and output sums are bounded by provenance (§11.8): no transaction can spend more of an asset than its fixed initial supply, so they are also below `2^131`.
* Gross native issuance is at most `S` (§14), the signed Q128 lag is committed as a signed 256-bit two's-complement integer (§6.5), and §14 evaluates Q128 values with exact integer intermediates. Issuance arithmetic never reduces values modulo the proof field.
* Native amounts use 18 decimal places: one PCASH is `10^18` atomic units.

### 2.2 Field

All circuit arithmetic is over the BN254 scalar field:

```text
p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
  = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
```

Every public input interpreted as a field element MUST satisfy `x < p`. A value `< p` is called **canonical**.

**32-byte values in commitments.** Because `p < 2^256`, a 32-byte value does not always fit in one field element. Values that commitments must preserve exactly use a lossless encoding: Ethereum block hashes and log topics are split into 128-bit halves (§7.2, §7.4), log data into 16-byte chunks (§7.2), and the signed issuance lag into halves (§6.5). Reducing an arbitrary 256-bit word instead would let `x` and `x + p` collide whenever both fit. Receive keys, output data, and arenas are hashed with `poseidonBytes` (§2.3), and domain tags are derived with the same encoding (§2.5). Both produce a field element, so no PCASH commitment reduces a 256-bit digest. Wherever a field value is represented as bytes, including an EIP-712 `bytes32` value, it is the canonical 32-byte big-endian encoding of the field element.

### 2.3 Poseidon2 hash

PCASH hashes with Poseidon2 over the BN254 scalar field. Keccak-256 appears in exactly two places, each defined where it appears:

* verifying the user-account creation signature (§12.1), whose EIP-712 digest and address recovery Ethereum wallets fix;
* `contentHash` (§7.4), the only hash over a whole serialized transaction. Poseidon2 over 32–80 KB would take hundreds to thousands of permutations for every transaction, and no proof needs it: proofs identify an included transaction by its result position (§7.3) and transaction ID (§7.4).

Ethereum values that PCASH only reads, such as Ethereum block hashes, are inputs, not hashes PCASH computes, and an account rule may use whatever hash its own message format needs (§8.2). The carrier-event topic (§9.1) is likewise a fixed constant that nodes compare log topics with, not a hash derivation computes.

Parameters: state width `t = 4`, rate `3`, capacity `1`, S-box `x^5`, `R_F = 8` full rounds, `R_P = 56` partial rounds, and matrices and round constants exactly as in the parameter file `poseidon2_bn254_t4_rf8_rp56.json` (§17). In that file, `M_E = externalMatrix`, `D_I = internalDiagonal`, and `RC = roundConstants`; every value is interpreted as a field element.

For a state `s` of four field elements, define `extern(s) = M_E · s`. Define `intern(s)` by `S = s[0] + s[1] + s[2] + s[3]` and `intern(s)[i] = S + D_I[i] × s[i]`. The permutation is:

1. Set `state = extern(state)`.
2. For full rounds `r = 0..3`, add `RC[4r + i]` to each `state[i]`, apply `x^5` to every element, then apply `extern`.
3. For partial rounds `r = 0..55`, add `RC[16 + r]` to `state[0]`, apply `x^5` only to `state[0]`, then apply `intern`.
4. For full rounds `r = 0..3`, add `RC[72 + 4r + i]` to each `state[i]`, apply `x^5` to every element, then apply `extern`.

The first full-round block therefore consumes `RC[0..15]`, the partial rounds consume `RC[16..71]`, and the second full-round block consumes `RC[72..87]`.

Every `poseidon(...)` in this specification is the following length-tagged sponge:

```text
poseidon(x_1, ..., x_N) = Poseidon2_sponge(x_1, ..., x_N)
```

`Poseidon2_sponge`: let `N` be the number of inputs. Initialize the 4-element state to `[0, 0, 0, N << 64]`. If `N = 0`, apply one permutation and return state element `0`. Otherwise, process the inputs in chunks of 3, zero-padding the final chunk: add each chunk element into `state[0..2]` mod `p`, then apply one permutation. Return state element `0`. There is no additional final permutation after the last absorbed chunk. Implementations MUST use this length-tagged sponge; the bare permutation with capacity `0` produces different values. Known-answer values and worked multi-chunk cases are in the conformance vectors (§17).

**Byte strings.** A hash over a byte string `b` of `L` bytes absorbs a domain tag, the length, and the bytes in 16-byte big-endian chunks:

```text
poseidonBytes(DOMAIN, b) = poseidon(DOMAIN, uint64(L), chunk_0, ..., chunk_(m-1))
m       = ceil(L / 16)
chunk_j = big-endian integer of bytes 16j .. min(16j + 16, L) - 1 of b
```

When `L` is not a multiple of 16, the final chunk is shorter than 16 bytes and is read as its big-endian integer. This is the data encoding of normalized logs (§7.2) without their minimum of eight chunks. It is injective: `L` fixes the chunk count, every chunk is below `2^128 < p`, and `L` also separates strings that differ only in leading zero bytes of the final chunk. The receive-key digest (§5.1), output-data hashes, and the arena hash (§10.3) use it, each with its own domain tag, and domain-tag derivation (§2.5) uses it without one.

### 2.4 Merkle trees

Most PCASH commitments are binary Merkle trees whose internal nodes are `poseidon(left, right)`. Empty leaves are `0`; `EMPTY[h + 1] = poseidon(EMPTY[h], EMPTY[h])`; the empty root of a depth-`D` tree is `EMPTY[D]`.

A membership proof for a depth-`D` tree is `D` sibling nodes, listed from the leaf level upward. At height `h`, bit `h` of the tree key (least significant bit first) selects the side: bit `0` means the current node is the left child.

```text
cur = leaf
idx = key
for h in 0..D-1:
    if (idx & 1) == 0: cur = poseidon(cur, siblings[h])
    else:              cur = poseidon(siblings[h], cur)
    idx = idx >> 1
root = cur
```

The circuit-facing trees are listed below; each is defined in the section cited. The state and header trees absorb a domain tag at every node instead of using this plain node function.

* **Output-commitment tree** (§6.2): depth 40, append-only, keyed by `outputIndex` (`uint64 < 2^40`, sequential from `0`). It contains indexed commitments to ordinary note bodies, including system payouts and padding bodies.
* **Address Account State Tree** (§6.3): depth 40, mutable, keyed by `accountIndex` (`uint64 < 2^40`, assigned sequentially from `0` when an address's account is first created).
* **Nullifier tree** (§6.4): depth `NULLIFIER_TREE_DEPTH = 41`, append-only, keyed by insertion position, with the sentinel at `0`; every allocated leaf is a domain hash, and a leaf is rewritten when its successor changes.
* **State commitment tree** (§6.5): depth `STATE_TREE_DEPTH = 4`, keyed by protocol-assigned integers `0–15`; every internal node absorbs `STATE_COMMITMENT_DOMAIN`.
* **Block-header tree** (§7.5): depth `BLOCK_HEADER_TREE_DEPTH = 4`, keyed by protocol-assigned integers `0–15`; every internal node absorbs `BLOCK_HEADER_DOMAIN`.
* **L1 origin tree** (§7.2): depth `L1_ORIGIN_TREE_DEPTH = 40`, append-only, keyed by `blockNumber − anchorNumber`.
* **Normalized-log tree** (§7.2): depth 64, one per Ethereum block, holding the block's normalized logs keyed by position in canonical log order. Its root is the `logsRoot` of the block's L1 origin leaf.
* **PCASH history tree** (§7.6): depth `HISTORY_TREE_DEPTH = 40`, append-only, keyed by PCASH block number, committing only completed prior blocks.
* **Transaction-results tree** (§7.3): depth `TRANSACTION_RESULTS_TREE_DEPTH = 64`, one per block, holding the block's transaction results at their `pcashTransactionIndex` and then its payout results.
* **Account-rule-set tree** (§5.2), a user account's rule set or a contract account's function set: depth `ACCOUNT_RULE_SET_DEPTH = 8`, sparse. Slot assignment is not protocol-constrained. Empty root `EMPTY[8]`.

### 2.5 Domain tags

Most Poseidon commitments take a domain tag as their first operand, so that a value computed for one purpose cannot be reinterpreted as another. Each tag is derived from a context string:

```text
DOMAIN = poseidon(uint64(L), chunk_0, ..., chunk_(m-1))
b      = "pcash." ‖ context_string
```

This is the byte-string encoding of §2.3 over `b` without its leading domain, since a tag cannot be hashed under a tag: `L` is the length of `b` in bytes, and `m` and `chunk_j` are as defined there. The prefix is the literal six-byte ASCII string `pcash.`, including its trailing dot.

| Constant | Context string |
|---|---|
| `NULLIFIER_KEY_COMMITMENT_DOMAIN` | `nullifier_key_commitment` |
| `NOTE_NULLIFIER_KEY_DOMAIN` | `note_nullifier_key` |
| `PAYOUT_SEED_DOMAIN` | `payout_seed` |
| `PAYOUT_TX_CONTEXT_DOMAIN` | `payout_tx_context` |
| `PAYOUT_NOTE_SECRET_DOMAIN` | `payout_note_secret` |
| `OWNER_COMMITMENT_DOMAIN` | `owner_commitment` |
| `NOTE_BODY_COMMITMENT_DOMAIN` | `note_body_commitment` |
| `OUTPUT_COMMITMENT_DOMAIN` | `output_commitment` |
| `NULLIFIER_DOMAIN` | `nullifier` |
| `DUMMY_NULLIFIER_DOMAIN` | `dummy_nullifier` |
| `APPLICATION_NULLIFIER_DOMAIN` | `application_nullifier` |
| `IMPLICIT_NOTE_SECRET_SEED_DOMAIN` | `implicit_note_secret_seed` |
| `TRANSACT_NOTE_SECRET_DOMAIN` | `transact_note_secret` |
| `EVENT_DOMAIN` | `transaction_events` |
| `EVENT_ENTRY_DOMAIN` | `transaction_event_entry` |
| `PRIVATE_VALUE_COMMITMENT_DOMAIN` | `private_value_commitment` |
| `OUTPUT_DATA_HASH_DOMAIN` | `output_data_hash` |
| `ARENA_HASH_DOMAIN` | `arena_hash` |
| `DELIVERY_COMMITMENT_DOMAIN` | `delivery_commitment` |
| `ACCOUNT_CREATION_ATTACHMENT_DOMAIN` | `account_creation_attachment` |
| `ASSET_ID_DOMAIN` | `asset_id` |
| `ASSET_SECRET_COMMITMENT_DOMAIN` | `asset_secret_commitment` |
| `ASSET_CREATION_MARKER_DOMAIN` | `asset_creation_marker` |
| `STATE_COMMITMENT_DOMAIN` | `state_commitment` |
| `BLOCK_HEADER_DOMAIN` | `block_header` |
| `GENESIS_PARENT_DOMAIN` | `genesis_parent` |
| `L1_ORIGIN_DOMAIN` | `l1_origin` |
| `L1_LOG_DOMAIN` | `l1_log` |
| `HISTORY_LEAF_DOMAIN` | `history_leaf` |
| `NULLIFIER_LEAF_DOMAIN` | `nullifier_leaf` |
| `TRANSACTION_STATEMENT_DOMAIN` | `transaction_statement` |
| `TRANSACTION_RESULT_DOMAIN` | `transaction_result` |
| `PAYOUT_RESULT_DOMAIN` | `payout_result` |
| `TRANSACTION_RESULTS_ROOT_DOMAIN` | `transaction_results_root` |
| `TRANSACTION_ID_DOMAIN` | `transaction_id` |
| `AUTHORIZATION_COMMITMENT_DOMAIN` | `authorization_commitment` |
| `TRANSFER_ACTION_DOMAIN` | `transfer_action` |
| `ASSET_CREATION_ACTION_DOMAIN` | `asset_creation_action` |
| `SPONSORED_TRANSFER_ACTION_DOMAIN` | `sponsored_transfer_action` |
| `CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN` | `contract_fee_sponsorship_action` |
| `ACCOUNT_UPDATE_ACTION_DOMAIN` | `account_update_action` |
| `ACCOUNT_UPDATE_COMMITMENT_DOMAIN` | `account_update_commitment` |
| `ACCOUNT_STATE_COMMITMENT_DOMAIN` | `account_state_commitment` |
| `RECEIVE_KEY_HASH_DOMAIN` | `receive_key_hash` |
| `ACCOUNT_RULE_ENTRY_DOMAIN` | `account_rule_entry` |
| `CONTRACT_ADDRESS_DOMAIN` | `contract_address` |
| `CARRIER_CONTEXT_DOMAIN` | `carrier_context` |

## 3. Network Configuration and Forks

### 3.1 Configuration and chain identity

A PCASH network is fixed by its derivation configuration:

* `PCASH_CHAIN_ID`: the PCASH network identifier, nonzero and below `2^32`.
* `L1_CHAIN_ID`: the EIP-155 chain ID of the Ethereum chain that carries the data.
* `INBOX_ADDRESS`: the Ethereum address whose incoming transactions carry PCASH batches (§9.1).
* `GENESIS_L1_BLOCK_NUMBER` and `GENESIS_L1_BLOCK_HASH`: the **anchor**, the Ethereum block that produces PCASH block `0`.

The named public networks use these chain identities:

| Network | `PCASH_CHAIN_ID` | `L1_CHAIN_ID` | `INBOX_ADDRESS` |
| --- | --- | --- | --- |
| Mainnet | `231` | `1` | `0x00000000000000000000000000000000000CA511` |
| Testnet (Sepolia) | `23100` | `11155111` | `0x00000000000000000000000000000000000CA511` |

Both networks use the vanity batch inbox address shown above.
The EIP-712 domain uses `L1_CHAIN_ID` and the inbox (§12.1).

### 3.2 Forks

A **fork** is a human-readable name and an Ethereum header activation timestamp compiled into a software release. Aster is the launch rule set and is active from genesis. The compiled fork schedule is empty: no later fork is scheduled. Fork names and timestamps are not hashed into `genesisHash`, `StateRoot`, or a separate upgrade identity.

Forks are the only way the rules change: there is no upgrade key or on-chain governance, and a fork binds whoever runs the release that compiles it, as an Ethereum hard fork does. Nodes running different rules derive different block hashes as soon as the rules produce different results, so a divergence is visible at once; which rules the network follows is settled by who runs them, not by the protocol.

For an Ethereum block with header timestamp `t`, derivation applies the rules of the latest compiled fork whose activation timestamp is `<= t`. Activation is by timestamp rather than height so that the scheduled wall-clock boundary is predictable. Historical replay uses each block's actual timestamp, so a reorganization reselects fork rules from the same deterministic input used during initial derivation.

At each activation timestamp, the fork definition fixes:

* the complete accepted batch-version set, as ascending unique bytes (§9.3);
* the transaction-type and verification-key mapping (§10.1).

Aster accepts batch version `0x01` (§9.3) and transaction types `0x00`, `0x01`, `0x02`, and `0x03` (§10.1), with the hiding-kernel VKs of §16 for the types and modes that carry a proof.

Each assigned transaction type permanently fixes its wire payload shape, verifier, and type-specific interpretation, and historical transactions always decode under that meaning. A fork may activate or retire a type for new blocks. Each assigned batch-version byte likewise permanently fixes the framing parser and structural bounds used to recover an ordered list of typed transactions; a different framing rule requires a different batch version. Historical derivation selects the exact rules in force at each Ethereum block's timestamp.

A later fork that stops trusting a predecessor proof system declares a monetary trust reset in its own rules; Appendix A states what that fork must establish.

## 4. Notes and Nullifiers

A note is a unit of private value. The ledger stores only commitments to notes; whoever holds a note's opening can prove things about it without revealing it. This section defines how notes name their owners, how they are committed, and how spending them produces nullifiers.

### 4.1 Owners

A note's owner is a 160-bit PCASH account address, and every note binds that address itself, as `uint160(address)` (§4.3). For a user account, `address` is the Ethereum-style secp256k1 address whose key authorizes the account's creation (§12.2); after that, the account's installed applications authorize its private-value transactions and updates (§8.2). For a contract account, `address` is derived from the contract's immutable contents (§12.4) and has no corresponding key.

The address is the account's only identity. The account tree holds at most one account per address (§6.3), and an account's nullifier-key commitment never changes (§4.2), so any identity derived from the two would be fixed by the address alone. A hash of the address would hide nothing either: the address is public, and what hides a note's owner is the note secret inside its owner commitment (§4.3).

Padding outputs belong to address `0`, where no account can exist. A user account's address is the Ethereum sender of its creation or the signer that a successful recovery returns, and a failed recovery fails the creation instead of yielding an address (§12.2). A contract's address is the low 160 bits of a hash (§12.4). Either kind reaches address `0` only through a 160-bit preimage search. Padding notes also hold amount zero, which no real input may have (§11.3). The kernel recognizes padding by its private slot class, not by its owner, so a real output owned by address `0` is spendable by no one: it burns its value.

### 4.2 Nullifier keys

Each account binds one BN254 scalar, its **nullifier-key root** `nkRoot`, through a public commitment stored in its account state (§5.1). Any field element is a valid root. `nkRoot` is secret unless a contract chooses to publish it, and a root that others know or can guess, zero included, gives them that account's nullifier material and, at the protocol level, nothing more (below); under the reference conventions it also lets them recognize and open the account's derived payouts and owner change (Appendix B.2). The note key used in note nullifiers is derived from it:

```text
nullifierKeyCommitment = poseidon(NULLIFIER_KEY_COMMITMENT_DOMAIN, nkRoot)      // published in every account
noteNk                 = poseidon(NOTE_NULLIFIER_KEY_DOMAIN, nkRoot)            // note nullifiers
```

Whoever spends the account's notes knows `nkRoot`. A contract account may also publish its `nkRoot` when its immutable `publishesNkRoot` flag is set (§12.4). `nullifierKeyCommitment` is immutable once written: account creation supplies it and no update can change it (§12.3). It is immutable because note nullifiers derive from `nkRoot`: a new root would give every existing note a second valid nullifier, so a spent note could be spent again. The cost is that an account whose `nkRoot` is lost can never spend its notes or change its rules; a rule can provide recovery from a lost signing key (§5.2), not from a lost `nkRoot`.

Disclosing `nkRoot` or `noteNk` reveals nullifier material but does not by itself authorize a spend. A real note's nullifier also requires the note's secret, and every transfer still requires a valid authorization proof.

### 4.3 Note commitments and nullifiers

A note's opening is its owner `address`, a secret `noteSecret`, its `assetId`, and its `amount`. Its commitment is built in three layers. The owner commitment hides the owner behind the secret. The body commitment adds what the note holds. The output commitment adds where the note sits in the output tree, which the node assigns when the transaction succeeds; separating the body from its position lets a wallet prove a transaction before knowing where its outputs will land.

```text
ownerCommitment      = poseidon(OWNER_COMMITMENT_DOMAIN, uint160(address), noteSecret)
noteBodyCommitment   = poseidon(NOTE_BODY_COMMITMENT_DOMAIN, ownerCommitment, assetId, amount)
outputCommitment     = poseidon(OUTPUT_COMMITMENT_DOMAIN, noteBodyCommitment, outputIndex)
nullifier            = poseidon(NULLIFIER_DOMAIN, outputCommitment, noteNk, noteSecret)
dummyNullifier       = poseidon(DUMMY_NULLIFIER_DOMAIN, dummyInputSeed, inputIndex)
applicationNullifier = poseidon(
    APPLICATION_NULLIFIER_DOMAIN,
    uint160(address), selectedEntryCommitment, replayId)
```

The operands are: `address`, the note's owner in `ownerCommitment` and the authorizing account in `applicationNullifier` (§4.1); `outputIndex`, the note's position in the output tree; `inputIndex`, the zero-based input slot index; `dummyInputSeed`, a private seed chosen once per action; `selectedEntryCommitment`, the `accountRuleEntryCommitment` (§5.2) of the rule entry selected to authorize the action; and `replayId`, a value defined by that rule (§11.3).

`nullifier` is the spend marker of a real note: it binds the exact output (and so its position), the owner's note key, and the note secret, so it is the same for every valid spend of that note and different for every other note. Every operand may take any value in its range, zero included; a zero secret is one operand of a domain-separated hash, not a zero nullifier. `dummyNullifier` and `applicationNullifier` are the markers of padding input slots and of account-rule replay protection; §11.3 defines when each is used. All three, together with asset-creation markers (§11.6), share one spent set (§6.4).

`assetId = 0` identifies native PCASH. A nonzero `assetId` identifies one instance of the standard fungible asset (§11.6).

Receiving native or asset notes requires neither registration nor the recipient's consent: a note's owner commitment needs only the owner's address, and nothing checks that the address has an account.

### 4.4 Real notes and padding

* A real input opens under whatever `noteSecret` its note was created with, zero included. The secret is what hides the owner, so a secret that others know or can guess lets them recognize the note's owner commitment. It does not let them spend the note, which still requires the owner's note key and the owning account's authorization. Giving a note a secret with entropy is the job of whoever creates it.
* A padding (dummy) input slot has no input commitment and no note secret. The protocol kernel derives its indexed nullifier from one private `dummyInputSeed` per action. Because the private-value commitment (§11.3) includes every input slot's class, commitment, and nullifier, changing `dummyInputSeed` produces a different authorized action. A dummy nullifier names no account: two actions that use the same seed publish the same dummy nullifier in every slot both leave as padding, so at most one of them succeeds, and anyone who knows or guesses a seed can publish its nullifiers first. The prover SHOULD draw a fresh unpredictable seed for each action; consensus constrains the derivation, not the seed.
* The note body has exactly the three semantic operands shown: owner commitment, asset ID, and amount. There is no note-state operand. Applications may commit opaque private material inside `noteSecret`, but consensus exposes no standardized, independently openable state field and no state-transition interface for it.
* For every real output, the protocol kernel receives an opaque `ownerCommitment`, which may be any field element, and constructs the body under the selected asset and amount. Consensus does not require the transaction's prover to know the opening of a real output's owner commitment, except a fee payer's native change output, which must open to the payer's address (§11.7, §12.3, §12.4). An owner commitment that no account can open, such as zero or one of address `0`, burns the output's value. Recipient acceptance, delivery, and derivation of output secrets are left to applications and wallets.
* A padding output has a private `dummySecret` and the owner commitment of address `0`, `ownerCommitment = poseidon(OWNER_COMMITMENT_DOMAIN, 0, dummySecret)` (§4.1). Its body is indistinguishable from a real one only when that secret is unpredictable; a zero or repeated secret gives the padding output a recognizable body. The prover SHOULD draw each `dummySecret` at random.
* A native-only action has one native input owner. An asset-bearing action has one input owner across every real native and asset input, except in a sponsored transfer (§11.7).

## 5. Accounts

An account is the durable control point for spending. Notes name their owner by address; the account row stored under that address says which rules may authorize spending and what the account's permanent key commitment is. Accounts are created by transaction types `0x01` and `0x02` and updated by type `0x03` (§12).

### 5.1 Account state

Each account is one `AccountState` row, committed as one leaf of the account tree (§6.3):

```text
accountStateCommitment = poseidon(ACCOUNT_STATE_COMMITMENT_DOMAIN,
    uint160(address),
    nullifierKeyCommitment,
    accountRuleSetCommitment,
    accountKind,
    accountRevision,
    receiveKeyHash)
```

This is the only account state commitment. It commits the account's immutable identity, its spending rules, its kind, its revision, and its receive-key state. The complete row and its leaf always change together as one transition. The fields are:

* `address`: the account's 160-bit address.
* `nullifierKeyCommitment`: the commitment to the account's `nkRoot` (§4.2). It commits the account's key hierarchy and is unrelated to the root of the global spent-nullifier set (state key `7`, §6.5). **Immutable**: creation supplies it, and every update derives the existing value from live state.
* `accountRuleSetCommitment`: the root of the account's rule set (§5.2), or `EMPTY[8]`. A user account supplies it as its mutable `ruleSetCommitment`; a contract account supplies it as its immutable `functionSetCommitment`.
* `accountKind`: `0` for a user account, `1` for a contract account. Each relation restricts which kind it accepts.
* `accountRevision`: a nonzero `u32`. Consensus sets it to `1` at creation and increments it exactly once on each accepted user-account update. It is never serialized by creation.
* `receiveKeyHash`: the account's receive-key digest, defined below.

A **receive key** is an ML-KEM-768 public key of exactly `ML_KEM768_PUBLIC_KEY_LEN = 1,184` bytes that senders may use to encrypt note openings to the account. State stores only its digest:

```text
receiveKeyHash = poseidonBytes(RECEIVE_KEY_HASH_DOMAIN, mlKem768PublicKey)
```

A zero `receiveKeyHash` means the account has no receive key. A nonzero `receiveKeyHash` is the digest of the exact key bytes introduced by creation or by the latest update `REPLACE` operation, and a later update may retain it with `KEEP` (§12.3). This one value is what the account state commitment, the contract address (§12.4), the account update commitment (§12.3), and the creation signature (§12.1) carry. The raw key is not part of intrinsic state. Raw keys remain recoverable from their creation or latest `REPLACE` body in Ethereum data; a node may store them beside intrinsic state.

A **user account** (`accountKind == 0`) is created by type `0x01` and updated by type `0x03`; there is at most one per Ethereum address. Its creation is authorized by that address's ECDSA key; afterwards it is governed only by its installed rule set. A **contract account** (`accountKind == 1`) is created by type `0x02`, is keyless, derives its address from its contents, and is never updated. A contract's immutability rests on its leaf commitment together with the write rules, not on the collision resistance of the address derivation.

### 5.2 Account-rule entries and rule sets

An account's rule set is a sparse depth-8 Poseidon tree (§2.4), so it holds at most 256 **entries**. Each entry names one authorization circuit, called an **application**, by the hash of its verification key, together with configuration that the application interprets:

```text
accountRuleEntryCommitment = poseidon(ACCOUNT_RULE_ENTRY_DOMAIN, applicationVkHash, configurationCommitment, commitmentBlinder)
```

* `applicationVkHash` is the canonical Poseidon2 hash of the application's 151-field MegaApp verification key (§8.1). It may commit to any MegaApp circuit that returns the permanent four-field rule statement (§8.2). The verification key itself is a private proving witness and is never published.
* `configurationCommitment` is opaque to the protocol. The selected application interprets it: it might commit to a signer, a threshold, a passkey, a recovery condition, or anything else. The rule statement carries it inside the authorization commitment (§8.2).
* `commitmentBlinder` separates otherwise identical entries in a user account, whose entries are never published. A wallet SHOULD draw it unpredictably, so that an installed rule cannot be recognized from a known template. A contract function uses the canonical blinder `0` (§12.4), because a contract's entries are published in full in Ethereum data and a published blinder hides nothing.

The entry contains no capability declaration: nothing in it says what kinds of action the application approves. The protocol kernel authenticates the account and the exact action commitment; the application decides which action shapes and conditions it accepts. A narrow application MUST reconstruct enough of the domain-separated action to fail closed for every shape it does not support. A deliberately universal application may treat the action commitment as opaque.

The two account kinds expose the same entries under different names:

| Account kind | An entry is exposed as | Selected by |
|---|---|---|
| User account (§12.2) | a **rule** | its slot → the entry index |
| Contract account (§12.4) | a **function** | its selector → the entry index |

Duplicate entries add no power. To revoke a user account's rule, the account must commit a new rule set that excludes every index containing it. A proof may name any recent block (§10.6), so a removed rule keeps authorizing transactions proven against blocks from before the update until those blocks leave the window.

## 6. State

### 6.1 Components

PCASH state is what transactions and block settlement change. The intrinsic transition state consists of:

* the append-only output-commitment tree and its count (§6.2);
* gross native issuance and the signed post-settlement Q128 issuance lag (§14);
* the mutable Address Account State Tree and its count, with each account address assigned one sequential index and one complete current `AccountState` row (§6.3);
* the append-only nullifier tree and its count (§6.4).

Canonical PCASH headers, exact `L1Origin` records (§7.1), the L1 origin tree, and the PCASH history tree are derived chain data, not intrinsic `StateRoot` components (§7). Raw transaction bodies, output data, and arenas are likewise not `StateRoot` components.

### 6.2 Output tree

The output tree (depth 40, §2.4) holds the output commitment of every note ever created, at sequential `outputIndex` values starting from `0`. Outputs are appended as follows:

* Every successful private-value section appends its selected profile's `O` ordinary output commitments, one per output slot, including padding.
* After the block's ordinary outputs, each positive system payout appends one ordinary native note: designated issuance in canonical transaction order, then poster payouts in first-positive-contribution order (§14.3).
* Standalone user-account and contract creation append no output. User-account updates carry a five-output fee section and may produce an open-fee payout. A creation attachment adds no outputs beyond its carrying value action.

A transaction fails with `OutputCapacity` if its outputs, the payout notes it could cause, and the payout notes reserved by earlier successful transactions in the block could together exceed `2^40` outputs (§14.3).

### 6.3 Account tree

The Address Account State Tree (depth 40, §2.4) holds one `accountStateCommitment` (§5.1) per account at its `accountIndex`. The first account created receives index `0`, and each later creation receives the next index. Creation (types `0x01` and `0x02`) fails with `AccountCapacity` unless `accountCount + pendingNewAccounts + 1 <= 2^40`, where `accountCount` is the count at the start of the block and `pendingNewAccounts` is the number of accounts created earlier in the block. Nodes also keep an address-to-index mapping and each account's complete current row; the row and its leaf are always written together.

### 6.4 Nullifier set

The spent-nullifier set is an append-only indexed Merkle tree of depth `NULLIFIER_TREE_DEPTH = 41` under the conventions of §2.4: internal nodes are `poseidon(left, right)` and an unallocated slot is `0`. Note, dummy, asset-creation, and application nullifiers all share it. Its values are the nonzero canonical field elements, compared as integers.

Leaf `0` is the sentinel, with value `0`. Leaf `i` for `1 <= i <= nullifierCount` holds the `i`-th nullifier inserted, in canonical order: block, then transaction, then input slot. Every allocated leaf, the sentinel included, commits its value, the smallest larger value in the set, and that value's leaf index; both pointer fields are `0` on the leaf with the largest value, which ends the list:

```text
nullifierLeaf(value, nextValue, nextIndex) = poseidon(NULLIFIER_LEAF_DOMAIN, value, nextValue, nextIndex)
```

The initial tree holds only the sentinel, `nullifierLeaf(0, 0, 0)` at index `0`, and `nullifierCount = 0`. Inserting a nullifier `n` that is not in the set:

1. Let `low` be the leaf with the largest value below `n`; it is the sentinel when `n` is below every value in the set.
2. Write `nullifierLeaf(n, low.nextValue, low.nextIndex)` at index `nullifierCount + 1`.
3. Rewrite `low` as `nullifierLeaf(low.value, n, nullifierCount + 1)`, and increment `nullifierCount`.

The tree after a block is the tree these single insertions produce in canonical order; an implementation may compute the block's rewritten leaves and paths together, provided the result is identical. Double-spend rejection is a direct lookup in the set (§11.2), not a tree opening.

An opening is a leaf preimage `(value, nextValue, nextIndex)`, its index, and 41 siblings, verified against `nullifierRoot` by §2.4. It proves, for a nonzero `n` (the sentinel's value `0` is never a nullifier):

* `n` **spent** if the leaf's `value = n`;
* `n` **absent** if the leaf's `value < n`, and either `n < nextValue` or `nextValue = nextIndex = 0`.

Because every allocated leaf, the sentinel included, is a domain hash, no preimage, including the all-zero one, opens at an unallocated slot's `0`, so an opener needs no check that the slot is allocated. An absence opening holds for the state whose root it opens under: a later insertion into the gap rewrites the low leaf, so a witness for an earlier state must come from that state's tree (§7.6).

The set is an indexed tree rather than a sparse tree keyed by value because its depth is fixed by the number of entries rather than by the width of the values, its leaves are only appended or rewritten in place, and an absence proof costs one depth-41 opening and two comparisons, which a browser proof can afford. The depth is 41 because the sentinel takes leaf `0` and nullifiers never outnumber outputs: each private-value section inserts at most as many nullifiers as it appends outputs, no other transaction inserts any, and §6.2 caps outputs at `2^40`.

### 6.5 StateRoot

After every completed transition, the state is summarized by a fixed depth-4 Poseidon tree whose leaves are the state components:

| Key | Value |
|---:|---|
| 0 | `outputRoot` |
| 1 | `outputCount` |
| 2 | `issuedSoFar` |
| 3 | `lagHigh128` |
| 4 | `lagLow128` |
| 5 | `accountStateRoot` |
| 6 | `accountCount` |
| 7 | `nullifierRoot` |
| 8 | `nullifierCount` |
| 9–15 | `0`, unassigned |

* Output, account, and nullifier counts are in `[0, 2^40]`. Occupied output and account indices are below their counts and fit `uint40`; the allocated nullifier leaves are `0` through `nullifierCount`. Counts are committed because a Merkle root authenticates contents but not the next free append position.
* The lag halves are the big-endian high and low 128-bit halves of the canonical signed 256-bit two's-complement encoding of `lagQ` (§14.1).
* `nullifierRoot` is the root of the nullifier tree (§6.4).

```text
stateNode(left, right) = poseidon(STATE_COMMITMENT_DOMAIN, left, right)
StateRoot = root(stateLeaves, depth = 4, node = stateNode)
```

`StateRoot` deliberately excludes Ethereum provenance, PCASH history, source configuration, the header timestamp, raw material, and lookup indexes. Keys 9–15 are literal zero leaves when constructing this root. They preserve the typed opening formula used by immutable circuits; no current circuit may treat an unassigned leaf's zero value as a protocol fact.

## 7. Blocks and History

A PCASH block records what one Ethereum block did to PCASH: the outcome of every admitted transaction, the resulting state, and authenticated history. Its hash is the root of a small typed header tree, so a circuit can open any one header fact without the others.

### 7.1 One PCASH block per Ethereum block

Derivation produces one canonical PCASH block for every canonical Ethereum block from the anchor onward. The anchor produces PCASH block `0`, and each later block has number `parent.number + 1`. PCASH block `N` therefore corresponds to Ethereum block `GENESIS_L1_BLOCK_NUMBER + N`. No earlier Ethereum block produces a PCASH block. A PCASH block's timestamp is its Ethereum block's header timestamp.

Each block has an associated `L1Origin = (blockNumber, blockHash, blockTimestamp, l1LogsRoot, l1LogCount)`, from which its L1 origin leaf is computed (§7.2). `L1Origin` records which Ethereum input produced the block as derivation provenance and keeps the full Ethereum block hash. It is not a separate header field, but through that leaf it enters the block hash via the header's `l1OriginRoot`. Explanatory failure operands and diagnostic exclusion strings are not protocol inputs either.

### 7.2 L1 origin tree and normalized logs

Every PCASH block commits a record of every canonical Ethereum block since the anchor, including each block's event logs, so that account rules can prove Ethereum facts (§8.4).

Derivation maintains a depth-`L1_ORIGIN_TREE_DEPTH` (§2.4) append-only Poseidon Merkle tree over canonical Ethereum blocks. Leaf `i` commits Ethereum block `anchorNumber + i`, where the configured anchor is leaf `0`:

```text
l1OriginLeaf_i = poseidon(
    L1_ORIGIN_DOMAIN,
    uint64(blockNumber),
    blockHashHigh128,
    blockHashLow128,
    uint64(blockTimestamp),
    logsRoot,
    uint64(logCount))
```

PCASH block `N` appends L1 origin leaf `N` before its header is constructed, so `l1OriginRoot_N` contains indices `0..N`.

**Normalized logs.** For each canonical Ethereum block and its ordered execution receipts, derivation orders every receipt log by transaction index and then by receipt-local log index, and commits the logs in a depth-64 Poseidon tree. How an implementation acquires canonical Ethereum blocks and execution results is outside the protocol. Each log is normalized as follows:

* Its topics are padded to four 32-byte values and each is split losslessly into its big-endian `High128` and `Low128` halves, eight values in total. Unused topic values are zero.
* Its data is split into consecutive 16-byte big-endian chunks. The final short chunk is interpreted as its big-endian integer.

```text
logLeaf = poseidon(
    L1_LOG_DOMAIN,
    uint64(transactionIndex), uint64(receiptLocalLogIndex), uint160(emitter),
    uint3(topicCount), topic0High128, topic0Low128, ..., topic3High128, topic3Low128,
    uint64(dataByteLength), dataChunk_0, ..., dataChunk_(m-1))
m = max(8, ceil(dataByteLength / 16))
logsRoot = merkleRoot({ logLeaf_j at index j in canonical log order }, depth = 64)
```

The data occupies `m` chunk slots, zero past its end, so a log with at most 128 data bytes is exactly 22 hash inputs and a longer log appends its remaining chunks; the encoding is injective because the sponge's length tag (§2.3) and `dataByteLength` fix the chunk count, `topicCount` separates zero topics from absent ones, and `dataByteLength` separates encodings that differ only in leading zeros of the final chunk.

`EMPTY_LOGS_ROOT = EMPTY[64]` under the ordinary `poseidon(left, right)` node function.

Each L1 origin leaf binds the Ethereum block number, the full block hash as its two 128-bit halves, the timestamp, the normalized-log root, and the log count. The hash is split rather than reduced so that an opening authenticates all 256 bits: under a reduction, `h` and `h + p` would open the same leaf yet give different transaction IDs (§7.4).

*Note, how applications use the tree.* An application that authenticates an Ethereum event opens key `5` of a recent PCASH header, then the exact L1 origin leaf beneath that root, then the exact log beneath `logsRoot`, and then interprets the emitter, topics, and data according to its own semantics. Unrelated logs change only the block's log root and the selected path; they do not enlarge the application circuit. A proof-serving index need retain only log coordinates, leaf indices and hashes, and shared tree nodes; the caller supplies the public raw log and recomputes its leaf against the returned opening. From the authenticated block hash, a generic application may instead use raw header, receipt, state, storage, transaction, timestamp, or PREVRANDAO proofs: it recomputes Keccak-256 over the encoded Ethereum header and compares the result's two halves with the opened ones.

The commitment is derived state and requires no PCASH-owned Ethereum contract. Canonical Ethereum history and the derivation rules determine the tree; circuits need no separate source or anchor opening. PCASH does not reproduce Ethereum's receipts root in its header; the proof-friendly normalized-log root inside each L1 origin leaf takes its place.

### 7.3 Transaction results

Every admitted transaction (§10.2) contributes one transaction result to its block, and every system payout note (§14.3) contributes one payout result:

```text
TransactionResult = (txType, accountCreation, l1TransactionIndex, batchItemIndex, outcomeCode,
                     posterOwnerCommitment, outputStartIndex, statementHash)
PayoutResult      = (outputIndex, ownerCommitment, openFeeAmount, issuanceAmount)
```

Transaction results are ordered by Ethereum transaction index and then by batch item index. A transaction result's dense zero-based position among the block's transaction results is its `pcashTransactionIndex`. By contrast, `batchItemIndex` is the item's zero-based position among the items of its Ethereum transaction's carriers (§9.4) and may have gaps where items were not admitted. Payout results follow in settlement order, which is the order of their output indices (§14.3).

A transaction result's fields are:

* `txType` (§10.1) identifies the statement format together with its length, which the sponge length tag binds (§2.3). `accountCreation` is `1` when this transaction inserts an account, `2` when an attached creation reuses a compatible existing account (§11.2), and `0` otherwise, including every failed transaction. Standalone successful creations use `1`. Reuse authenticates that outcome without claiming a write or a new account index.
* `l1TransactionIndex` and `batchItemIndex`, the transaction's position on Ethereum (§9.4).
* `outcomeCode`, the transaction's outcome (§10.5).
* `posterOwnerCommitment`, the poster commitment of the transaction's batch (§9.3), which receives the transaction's open fee and any open-route issuance (§13). Batch framing requires it to be canonical before any item is admitted.
* `outputStartIndex`: for a successful transaction with a private-value section, `outputIndex0`, the output index at which its outputs were appended (§11.2); otherwise `0`. An output commitment includes the index that execution assigns, so the statement's note-body commitments determine the outputs only together with this index.
* `statementHash`: for a successful transaction, the hash of its statement; otherwise `0`.

A transaction's **statement** is an ordered list of field elements. A proof-bearing transaction (types `0x00` and `0x03`) states the public inputs its verifier reconstructs, in verifier order (§11.2, §12.3, §12.4); those of a successful transaction are canonical. Committing the whole vector rather than selected fields covers every public input of every proof-bearing type, including any a later type adds. A standalone user-account or contract creation carries no proof and states the account state row it writes (§5.1), less the two fields its type fixes, `accountKind` from `txType` and `accountRevision = 1` from creation:

```text
statement = (uint160(address), nullifierKeyCommitment, accountRuleSetCommitment, receiveKeyHash)
```

A failed transaction changes no state, so its result proves only its type, positions, poster, and outcome. It makes no claim about what the transaction submitted: a rejected word need not be a field element (§10.2), and a contract creation can fail before its address is derived.

A payout result holds the payout's assigned `outputIndex`, its owner commitment `C`, and the open-fee and issuance components whose sum is the note's amount (§14.3, §15). Exactly one component is nonzero: a payout contains only fees or only issuance. Because settlement combines fees across the block, tracing a poster payout's fee component to its sources means opening every contributing transaction's result: the successful results of the same block that name the payout's owner commitment as their poster, whose statements' `openFeeAmount` values sum to the payout's fee component. With both kinds, every note in the output tree has a committed creation record: an ordinary output through its transaction's statement and `outputStartIndex`, and a payout note through its payout result.

`transactionResultsRoot` commits both kinds in one Poseidon tree of depth `TRANSACTION_RESULTS_TREE_DEPTH = 64` (§2.4), bound with its two counts. With `T` transaction results and `P` payout results:

```text
statementHash = poseidon(TRANSACTION_STATEMENT_DOMAIN, s_0, ..., s_(n-1))
transactionResultLeaf_i = poseidon(
    TRANSACTION_RESULT_DOMAIN,
    uint8(txType), uint8(accountCreation), uint64(l1TransactionIndex), uint64(batchItemIndex),
    uint16(outcomeCode), posterOwnerCommitment, uint40(outputStartIndex), statementHash)
payoutResultLeaf_j = poseidon(
    PAYOUT_RESULT_DOMAIN,
    uint40(outputIndex), ownerCommitment, uint128(openFeeAmount), uint128(issuanceAmount))
resultsTreeRoot = merkleRoot({ transactionResultLeaf_i at index i | 0 <= i < T }
                             ∪ { payoutResultLeaf_j at index T + j | 0 <= j < P }, depth = 64)
transactionResultsRoot = poseidon(TRANSACTION_RESULTS_ROOT_DOMAIN, uint64(T), uint64(P), resultsTreeRoot)
```

Here `i` is the transaction's `pcashTransactionIndex` and `j` the payout's position in settlement order. The leaf omits `pcashTransactionIndex` because its tree index is that position, as a history leaf omits its block number (§7.6) and a log leaf its leaf index (§7.2). A block with no transactions and no payouts commits `poseidon(TRANSACTION_RESULTS_ROOT_DOMAIN, 0, 0, EMPTY[64])`. The depth is 64, as for normalized logs (§7.2), because only Ethereum bounds a block's transaction count. The two counts fix where the payout results begin and where the results end, so a proof about one payout, or about every transaction of a block, needs no further opening to find either boundary. With both counts the binding hash has four inputs and costs two permutations, which every opening of a result pays once.

The results restate facts the block already commits through its L1 origin. PCASH block `N` appends L1 origin leaf `N`, which commits Ethereum block `anchorNumber + N` (§7.2). That block hash commits Ethereum's transaction list and receipts. The transaction list commits each Inbox carrier's calldata, or its blob versioned hashes, which commit the blobs through their KZG commitments, and the receipts commit each carrier event; `l1TransactionIndex` and `batchItemIndex` then select the exact item and its batch header (§9.1–9.4). Opening that path in a proof costs Keccak over Ethereum's header and transaction or receipt encodings and, for a blob carrier, a KZG opening over BLS12-381, which puts it out of reach of a browser proof. A carrier event is also a normalized log beneath the L1 origin leaf (§7.2), but its log leaf absorbs the whole log data, context and batch together, so a circuit that opens it must hash the complete batch and be sized for the largest batch it accepts. As the normalized-log tree does for Ethereum receipts (§7.2), the results tree commits again, in Poseidon form, what a proof about a transaction or a payout needs: that a transaction succeeded, spent these nullifiers, and appended these outputs, or that a payout note holds this open fee and this issuance. A successful transaction's statement includes its `carrierContextHash` (§11.2), so the fact that a transaction requiring a given carrier context succeeded opens from its result without the carrier event. A proof opens a result of its recent block beneath that header's key `3` (§7.5), and a result of an earlier block beneath the earlier header's key `3`, which it reaches through the recent header's `historyRoot` (§7.6). From key `3` it opens the preimage `(T, P, resultsTreeRoot)`, then the result leaf beneath `resultsTreeRoot`, then the leaf's preimage (§8.4).

A result does not commit the transaction's bytes. Checking one transaction's bytes against a block needs Ethereum data: the Ethereum transaction or carrier event that carried it and, for a blob carrier after Ethereum discards the blob, the blob from an archive. Derivation already has that dependency (§9.2). Comparing block hashes therefore does not detect two nodes that derive different bytes for an item with the same result, such as an item that fails on both. Such a divergence changes no state.

`Succeeded` means that the transaction's state transition applied. Any deterministic execution failure records the first outcome selected by the precedence rules of §10.5 and leaves state unchanged for that transaction. Two nodes that assign different outcomes disagree on the canonical block even if they compute the same `stateRoot`.

### 7.4 Transaction identity

A transaction has two identifiers, for two different questions.

`contentHash = keccak256(txBytes)` names one exact serialization; before inclusion it is the only identifier a transaction has. It does not name a logical payment or intent: many valid proof byte strings can encode one statement, and re-proving the same action produces different bytes. Conflicts between transactions are determined by the nullifiers they consume, not by content hashes.

`transactionId` names one exact canonical inclusion:

```text
transactionId = poseidon(
    TRANSACTION_ID_DOMAIN,
    blockHashHigh128, blockHashLow128,
    uint64(l1TransactionIndex), uint64(batchItemIndex))
```

`blockHash` is the full hash of the block's L1 origin (`L1Origin.blockHash`, §7.1). The ID is a field element; wherever it is represented as bytes, it is its canonical 32-byte big-endian encoding (§2.2). `transactionId` is derived from the block's L1 origin and the result's coordinates and is not committed again: the L1 origin leaf commits the same two halves (§7.2), and the transaction result commits `l1TransactionIndex` and `batchItemIndex` (§7.3), so a proof that opens a transaction's result and its block's L1 origin leaf can compute the transaction's ID. `batchItemIndex` counts the items of all of an Ethereum transaction's carriers in carrier order (§9.4), so the two indices name one item even when one Ethereum transaction delivers several batches. Identical bytes included at different Ethereum coordinates have distinct transaction IDs, and an Ethereum reorganization that changes the block hash invalidates the old ID. `transactionId` is unique within one chain and does not include `PCASH_CHAIN_ID`, `genesisHash`, or the PCASH block hash: an item is admitted only when its envelope names this network's `PCASH_CHAIN_ID` (§10.2).

### 7.5 Block header and block hash

The header is a fixed depth-4 Poseidon tree with empty leaf `0`:

| Key | Value |
|---:|---|
| 0 | `parentHash` |
| 1 | `number` |
| 2 | `timestamp` |
| 3 | `transactionResultsRoot` |
| 4 | `stateRoot` |
| 5 | `l1OriginRoot` |
| 6 | `historyRoot` |
| 7–15 | `0`, unassigned |

`parentHash` (§7.7), `transactionResultsRoot` (§7.3), `stateRoot` (§6.5), `l1OriginRoot` (§7.2), and `historyRoot` (§7.6) are canonical BN254 field elements. `number` and `timestamp` fit `uint64`. Keys 7–15 are literal zero leaves when constructing this root. They preserve the typed opening formula used by immutable circuits; no current circuit may treat an unassigned leaf's zero value as a protocol fact.

```text
headerNode(left, right) = poseidon(BLOCK_HEADER_DOMAIN, left, right)
blockHash = root(headerLeaves, depth = 4, node = headerNode)
```

Raw `L1Origin`, fork name, software version, and batch version are not header fields.

### 7.6 PCASH history tree

For block `N`, `historyRoot_N` commits exactly the completed PCASH blocks `0..N-1`:

```text
historyLeaf_i = poseidon(HISTORY_LEAF_DOMAIN, blockHash_i)
historyRoot_N = merkleRoot({ historyLeaf_i at index i | 0 <= i < N }, depth = 40)
```

Block `0` therefore commits `EMPTY[40]`. After block `N`, `historyLeaf_N` is appended to the accumulator used by block `N + 1`. The leaf omits the block number: the path position fixes `i`, and `blockHash_i` commits the number at header key `1`. The leaf is still a domain hash rather than the bare block hash, so a claimed block hash, including zero, never matches an empty slot's `0` leaf, and no opener needs a nonzero check.

A rule may use authenticated historical state as facts or as authorization; history authentication itself imposes no freshness or revocation semantics. The history root authenticates old headers but does not imply the availability of every mutable historical leaf witness. Witness availability is an implementation and service property.

### 7.7 Genesis

Initial state has empty output and account trees, a nullifier tree holding only its sentinel (§6.4), zero gross issuance, and the initialized signed issuance lag (§14). The anchor Ethereum block has zero elapsed issuance time and produces ordinary PCASH block `0`: its admitted transactions execute, its L1 origin leaf is appended, and its completed state is committed.

Block `0` has no parent, so its `parentHash` commits the chain IDs and inbox of the network configuration (§3.1):

```text
parentHash_0 = poseidon(
    GENESIS_PARENT_DOMAIN,
    uint32(PCASH_CHAIN_ID), uint64(L1_CHAIN_ID), uint160(INBOX_ADDRESS))
parentHash_N = blockHash_(N-1) for N > 0
```

`parentHash_0` is not a block hash; parent links end at block number `0`. L1 origin leaf `0` commits the anchor block (§7.2), and derivation requires that block's hash to be `GENESIS_L1_BLOCK_HASH` (§9), so `genesisHash = blockHash_0` binds all five configuration values. Later blocks carry the genesis identity through the parent chain.

### 7.8 Block body

The canonical block body retains the exact `txBytes` of every admitted transaction, successful or failed, aligned one-to-one with the block's `TransactionResult` values by `pcashTransactionIndex`. A full block response supplies those bytes; a compact response may omit them. The body is authenticated through the block's L1 origin: decoding the carriers that the L1 block hash commits for `l1TransactionIndex` and taking the item at `batchItemIndex` (§9) must yield `txBytes`. Transaction bodies are canonical PCASH history, not StateRoot leaves. The reference node also retains a delivery manifest for each carrier; that record is not consensus (Appendix B.1).

## 8. Proofs and Account Rules

Types `0x00` and `0x03` carry one zero-knowledge proof; standalone user-account and contract-account creations carry none. This section defines the proof system, the interface between an account's authorization application and the protocol, and what a proof may read.

### 8.1 CHONK proofs and verification keys

All client proofs are zero-knowledge CHONK proofs over BN254, produced and verified by the pinned Barretenberg build. One proof folds an ordered stack of four Mega circuits, or five for a sponsored transfer:

1. private **applications**, proved as MegaApp circuits: the two account rules a sponsored transfer consumes (§11.7), or the one selected rule any other kernel consumes, followed by one event application;
2. one **protocol kernel**, which enforces the transaction's ledger rules and links its applications, proved as a MegaKernel circuit;
3. one **hiding kernel**, which accepts only release-pinned protocol-kernel verification keys and alone exposes the transaction type's ordered public inputs, proved as a MegaZK circuit.

The pinned implementation accepts no stack of fewer than four circuits: the first must be an application, and the hiding kernel, last, folds exactly one protocol kernel. The event application makes every single-rule stack meet that minimum without a circuit between the protocol kernel and the hiding kernel.

Verifying each layer's proof inside the next circuit would put browser proving beyond a phone's practical memory. With folding, proving cost follows the largest single circuit in the stack, not the sum, which is why each layer is a separate small circuit. The costs include a more involved proving system and a consensus dependency on one pinned release of it (§16).

The BN254 trusted-setup element `[x]_2` is compiled into the pinned verifier. At run time the verifier uses only the BN254 generator and the first 2^15 points of Barretenberg's Grumpkin SRS, which is transparent: it is generated deterministically from a public seed. The pinned implementation loads those points as part of a 65,536-point prefix, so §16 pins the SHA-256 of `[x]_2` and of the first 65,536 Grumpkin points. There are no per-circuit setup ceremonies; soundness depends on the universal BN254 setup behind `[x]_2` and the pinned proof-system implementation.

**Verification keys.** Applications use the 151-field MegaApp verification key (VK), and protocol kernels the 151-field MegaKernel VK. The persistent identity of each VK is Barretenberg's canonical VK hash, `poseidon(vk_0, ..., vk_150)`. An account-rule entry commits that exact MegaApp VK hash (§5.2). The protocol kernel receives each application's VK privately: it authenticates a rule's hash through the installed entry, binds an event application to the typed action and anchor (§8.6), and links every application through CHONK's databus. Hiding kernels accept only release-pinned protocol-kernel VK hashes. The final 119-field MegaZK hiding-kernel VK is fixed by the active transaction-type rule and is the only VK used in consensus verification.

**Verification.** Under the pinned implementation, a compressed CHONK proof begins with the hiding kernel's public inputs, one 32-byte word each: the transaction's statement words, then 28 words of recursion-accumulator data that the verifier consumes. Every statement word is either serialized elsewhere in `txBytes` or derived by the node, so `txBytes` carries the **posted proof body**: the compressed proof without the statement words. The accumulator words remain in the posted body. A proof is valid exactly when the pinned verifier accepts it:

1. Reconstruct the transaction's ordered public inputs (§11.2, §12.3), each as a 32-byte big-endian word. A word `>= p` has already failed as `PublicInputNotInField`.
2. Prepend those words, in order, to the posted proof body, and decompress the result with the pinned Barretenberg release.
3. Verify the decompressed proof against the type's hiding-kernel VK.

The verifier thus checks the proof against exactly the statement the node reconstructed. The posted body occupies exactly its pinned length (§16), with no length prefix, so a section whose proof bytes are too few or too many is not admitted (§10.3). A correctly sized body that fails decompression or verification is `ProofRejected` (§10.5). The pinned verifier's behavior is consensus. Nodes must agree exactly on which proofs are valid, so consensus names one exact verifier, bugs included. A later fork can change the verifier for later blocks (§3.2) or declare a monetary trust reset (Appendix A). Notes are private, so counterfeit value from a soundness bug need not show in any public figure, gross issuance included (§6.5); a reset carries forward at most the native value issued before it (Appendix A), which contains counterfeit value but does not make legitimate holders whole. The hiding-kernel VKs are pinned in §16. The accepted protocol-kernel VK hashes are compiled into the hiding kernels. Event application identities are not pinned by consensus; each entry commits the actual application VK hash (§8.6).

### 8.2 The rule statement

Every protocol kernel that authorizes value or account changes (the transfer, sponsored-transfer, asset-creation, and user-account-update kernels) links private account-rule applications. An application defines the condition under which its entry authorizes the exact action and account contribution that the kernel supplies.

**Permanent rule statement.** Every account-rule application returns exactly these four values, in this order, as its CHONK `return_data`, which the protocol kernel reads through its `call_data` bus:

```text
[authorizationCommitment, actionCommitment, recentPcashBlockHash, eventEntry]

authorizationCommitment = poseidon(AUTHORIZATION_COMMITMENT_DOMAIN, uint160(address), configurationCommitment)
```

* `authorizationCommitment` says which account acts, under which settings of the selected rule. `address` names the account (§4.1). It does not change when the account's rule set, receive key, or revision changes. Each application decides which keys may authorize the account, so an account can delegate authority or rotate signers without changing which address owns its notes; the reference ECDSA rules accept only the key whose address is the account's (Appendix B.2). `configurationCommitment` is the opaque, application-owned value that the selected entry commits (§5.2); PCASH defines neither its derivation nor its meaning. The account's nullifier key is not part of the statement: kernels use the authenticated `nkRoot` for note nullifiers and the account leaf, and a rule that needs nullifier-key material takes it from its own configuration or from an opening of an account leaf. The transfer, sponsored-transfer, and asset-creation kernels prove that the account exists under the recent block's account-state root, except in a transfer whose every input is `DUMMY` (§11.4). The user-account-update kernel instead binds the account's current state commitment into the public account update commitment, which the node recomputes from the live row (§12.3).
* `actionCommitment` says what the owner approves, on this chain. §8.3 defines it for each role.
* `recentPcashBlockHash` names the snapshot of chain state that the proof reads (§8.4).
* `eventEntry` identifies the actual event application and its claim (§8.6). Both rules of a sponsored transfer approve the same entry.

The kernel computes the same four values from the account and entry it authenticated, the private value it built, the role it proves, and the network's chain ID, and requires the application's `return_data` to equal them under the pinned databus link (§16). The chain ID is not a separate field: it enters through the action commitment (§8.3).

How an application obtains the four values is its own. A rule that opens a field computes it: the authorization commitment from the address and configuration it derives, the action commitment from the private value it opens. A rule that does not open a field takes it as a private witness and returns it unchanged. Either way, the kernel's comparison fixes the returned values, and with them every value that a rule hashed into them, the chain ID included.

An application MUST NOT read CHONK `call_data`. The MegaApp flavor constrains `return_data` but not `call_data`, so anything an application read from `call_data` would be unconstrained prover input.

The application defines its complete authorization relation and must constrain whatever action fields, signer, threshold, or external facts it intends. A narrow application MUST privately open the private value and compute the action commitment of each role it accepts (§8.3), and no other: an application that took `actionDomain` as a free witness would let the prover choose any role, including one the application never meant to approve. An application that approves any action commitment for its authenticated account is universal by construction. A rule that requires an event constrains its application identity and contents through `eventEntry`; passing the entry through as a witness alone does not express signer consent to that event. A rule may sign the raw action and account identity or a semantic projection of them, but its circuit must bind that authorization to the authorization and action commitments it returns.

**Signed projections.** A rule that verifies a signature over a projection of the action, selected fields that its circuit then ties to the private value it opens, MUST include in the signed message the same `pcashChainId` that it hashes into the action commitment. The kernel's comparison pins that value to this network, so the signature authorizes the action on this chain only. Without it, the signature could be reused to compute a valid action commitment on any PCASH chain that the signing domain does not distinguish, such as another chain sharing the L1 inbox when the domain names only `L1_CHAIN_ID` and `INBOX_ADDRESS`.

The authorization commitment, action commitment, and event entry stay private. Consensus learns that the folded proof is valid, not which account acted, which rule ran, which configuration it opened, or what secret satisfied it.

### 8.3 Action commitments

Every action commitment is one formula over the action's two parts (§1.2):

```text
actionCommitment = poseidon(actionDomain, pcashChainId, privateValueCommitment, extraData)
```

`privateValueCommitment` binds the private value (§11.3), and `pcashChainId` is the network's `PCASH_CHAIN_ID` (§10.1). `actionDomain` names the role in which a rule approves the action, and `extraData` carries what that role needs beyond the private value. A kernel supplies one action commitment for each account it authorizes:

| `actionDomain` | Role | `extraData` | Defined in |
|---|---|---|---|
| `TRANSFER_ACTION_DOMAIN` | the account of a transfer | `0` | §11.4 |
| `ASSET_CREATION_ACTION_DOMAIN` | the account of an asset creation | the created asset's `assetId` | §11.6 |
| `SPONSORED_TRANSFER_ACTION_DOMAIN` | the contract account of a sponsored transfer | `0` | §11.7 |
| `CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN` | the user account that pays a contract’s fee in a sponsored transfer | the contract’s address | §11.7 |
| `ACCOUNT_UPDATE_ACTION_DOMAIN` | the account of a user-account update, together with its fee | `accountUpdateCommitment` | §12.3 |

`extraData` binds what a rule approves to a value that the kernel derives or checks, or that consensus supplies: the asset ID the kernel derives from the asset definition, the address of the contract account it authenticates in a sponsored transfer, or the account update commitment the kernel computes. The rule's approval and the kernel's value therefore meet directly in the action commitment. An asset ID would otherwise meet the kernel's only through the asset output bodies, which a rule that treats the private value as opaque never opens.

Distinct action domains keep an approval in one role from becoming authority in another: a sponsorship cannot be replayed as a transfer or for another contract, and the contract side of a sponsored transfer cannot be replayed through the transfer kernel (§11.7). Each distinct approval has its own domain: two kernels share one only when the approval means the same thing to the signer and the rule's checks do not depend on which kernel runs. The sponsorship domain authorizes the user’s bounded fee contribution to the named contract action (§11.7).

The chain ID is an operand of every action commitment, so an approval on one PCASH chain is not an approval on another. A rule that computes its action commitment cannot leave the chain out, and a universal rule that approves any action commitment never handles the chain ID at all. The private-value and account-update commitment formulas add no chain ID operand; a signed user attachment already contains a signature bound to its network (§12.1). `recentPcashBlockHash` is not an operand (§8.4). `eventEntry` is also separate: an event application may prove a claim about the action without a circular commitment.

### 8.4 What a proof can open

Every proof-bearing transaction names one `recentPcashBlockHash`. Its execution succeeds only while that hash identifies a canonical block in the recent-block window (§10.6); block `N` first becomes usable in block `N + 1`. The hash authenticates the complete depth-4 header (§7.5), and a circuit opens only the header and state facts it consumes. A rule that does not consume a fact does not pay for its path.

* Current account-rule selection proves `recentPcashBlockHash -> stateRoot -> accountStateRoot`, then opens the selected account and rule entry. The account-update kernel instead opens the rule entry against the current rule set that its public account update commitment binds to the live row (§12.3).
* A private-value transaction proves its required output and account memberships against that one completed state snapshot. There are no independently selected output, account, or state-root windows. Transfers whose inputs are all padding retain the block and state-root bindings but do not require account membership (§11.4).
* The header's `number` and `timestamp` open directly beneath the header. Intrinsic roots open through `stateRoot`. Ethereum facts open through `l1OriginRoot` (§7.2), and earlier PCASH blocks through `historyRoot` (§7.6).
* Transaction and payout results open through header key `3`, `transactionResultsRoot` (§7.3): a result of the recent block beneath its own header, and a result of an earlier block beneath that block's header, reached through `historyRoot`.

The rule statement carries `recentPcashBlockHash` directly (§8.2), so applications read context through the same anchor as the kernel: everything a proof may read comes through it. It stays outside the action commitment because it names what the proof reads, not what the owner approves. A different qualifying block proves the same approval, so an unchanged action can be re-proved against newer state (§10.6). The statement carries the chain ID only inside the action commitment: a rule that needs the chain ID hashes its chain-ID witness into the action commitment it returns, and the kernel's comparison pins that witness to this network. A rule may prove older PCASH or Ethereum facts through the recent header's append-only roots; authenticating them does not make them current.

### 8.5 Rules and functions

Every authorized action uses the same entry mechanism: the protocol kernel proves the entry's membership under the exact committed MegaApp VK hash and links the selected application through CHONK, all privately. User accounts expose entries as rules whose slot maps to an entry index; contract accounts expose entries as callable functions whose selector maps to an entry index (§5.2).

Rules are permissionless. Anyone may write and install any application. A weak or trivial application cannot bypass the protocol kernel, which enforces the ledger, asset, or account-update invariants outside the application. Account membership authenticates installed authority, except in an all-padding transfer (§11.4), which spends no existing value, and in an account update, whose rule set the node authenticates against the live row (§12.3). Permissionless rules may intentionally use broader reusable approvals. Installed applications may be arbitrarily inexpensive; the protocol does not impose the reference wallet's ECDSA cost on every action. All-padding actions still execute the ordinary recursive application and transfer-kernel stack, whether or not the supplied account exists.

PCASH imposes no configuration schema, salt requirement, signing convention, or replay formula on an account rule, beyond binding the chain ID in what it signs (§8.2). The reference implementation's rules, their configuration, and the EIP-712 messages they sign are described with the [reference account rules](../circuits/README.md#reference-rules-rules).

### 8.6 Transaction events

Every proof-bearing transaction exposes one `eventsCommitment` after the base private-value statement. Its private opening contains a field salt and an event entry. The prover SHOULD choose a fresh cryptographically random salt for each transaction to hide equal entries; the circuit constrains the commitment, not the entropy of its opening.

An event application returns `[actionCommitment, recentPcashBlockHash, event]`. The kernel requires the first two fields to equal the typed action and anchor it derives. The action is the ordinary transfer, asset-creation, or account-update action for that kernel; in a sponsored transfer it is the primary contract's sponsored-transfer action. Any MegaApp circuit with this statement may serve as an event application. Account authorization comes only from installed rules, so the event slot needs no account authentication and grants no authority to change the ledger transition.

```text
eventEntry = poseidon(EVENT_ENTRY_DOMAIN, applicationVkHash, event)
eventsCommitment = poseidon(EVENT_DOMAIN, eventEntry, salt)
```

The application VK is authenticated by CHONK and included in the entry because an event's credibility depends on the code that proved it. Every authorizing rule returns the actual entry as its fourth statement word (§8.2). PCASH has no receive-side authorization step, so a rule that enforces an event policy does so when its holder spends.

Consensus neither interprets event contents nor gives `event = 0` special status. Every event application follows the same relation and contributes its VK-bound entry. Consumers choose which application identities and claims they accept. Every proof-bearing transaction has exactly one event application; changing that count requires a protocol change.

## 9. Deriving Blocks from Ethereum

This section gives the procedure that turns each Ethereum block into a PCASH block, then defines how a node finds PCASH data in an Ethereum block and splits it into candidate transactions. PCASH consumes only the few Ethereum facts listed in §9.6 and never executes the EVM.

**Block procedure.** For each canonical Ethereum block `B` from the anchor onward, a node derives PCASH block `N = B.number - GENESIS_L1_BLOCK_NUMBER` as follows:

1. Let `t = B.timestamp`, which becomes the PCASH block's timestamp (§7.1). For `N = 0`, require `B.hash = GENESIS_L1_BLOCK_HASH` (§3.1); a different hash halts derivation, as does a reorganization that replaces the anchor. For `N > 0`, require `t >= parentTimestamp`; a regression halts derivation.
2. Select the fork rules active at `t` (§3.2).
3. Compute the block quote from the parent state and elapsed time (§14.1). Initialize the capacity reservation state (§14.3) and the count of accounts created in this block (§6.3).
4. For each top-level transaction of `B`, in index order, take its carriers in carrier order: its Inbox carrier if it is an Inbox transaction, then its carrier events (§9.1, §9.4). For each carrier, obtain its candidate batch (§9.1–9.2) and frame it (§9.3). Then, for each framed item in order, at its `batchItemIndex` (§9.4):
   1. Decide admission (§10.2). A non-admitted item is skipped. (Appendix B.1 describes the record a node keeps of it.)
   2. Run the admitted transaction's checks in its type's order (§10.5, §11–§12), against the state left by every earlier successful transaction, with its carrier's carrier context (§9.1).
   3. If every check passes, apply its effects. In every case, record its `TransactionResult` and exact bytes (§7.3, §7.8).
5. Settle the block: compute `rewardEach`, append the system payouts and record each one's `PayoutResult` (§7.3), and set the new gross issuance and lag (§14.2–14.3).
6. Append L1 origin leaf `N` (§7.2), compute `StateRoot` (§6.5), and build the header and block hash (§7.5), whose `historyRoot` covers blocks `0..N-1` (§7.6).
7. Commit the block atomically (§14.4). Block `N`'s hash then becomes selectable as a recent block (§10.6), and history leaf `N` is appended for block `N + 1`.

Derivation of `B` starts only once its required input is available (§9.2). If evaluation itself fails at any step, derivation stops at `B` (§10.5); it never records a guess. Reorganizations re-run this procedure from the common ancestor (§9.5).

### 9.1 Inbox and carriers

A **carrier** delivers one candidate batch. There are two kinds, Inbox carriers and carrier events, and every carrier has a carrier context.

**Inbox carriers.** `INBOX_ADDRESS` is a routing tag, not a smart contract. A top-level Ethereum transaction with `to == INBOX_ADDRESS` is an **Inbox transaction**. It selects exactly one **Inbox carrier**, its calldata or its blobs, and the carrier yields one candidate batch:

* If its `blobVersionedHashes` list is empty, its complete calldata is the candidate batch bytes.
* If `blobVersionedHashes` is nonempty, its calldata MUST be empty, the hash count MUST be at most `MAX_BATCH_BLOBS`, every hash MUST use KZG version `0x01`, and the ordered blobs MUST be available and match those hashes. Their canonical decoding (§9.2) is the candidate batch bytes.
* If the transaction has both nonempty calldata and blob hashes, an unsupported blob-hash version, more than `MAX_BATCH_BLOBS` blob hashes, or calldata longer than `MAX_BATCH_BYTES`, its Inbox carrier is ignored in full. No blob retrieval is attempted for it.

Internal calls to `INBOX_ADDRESS` are not recognized: only top-level transactions are Inbox transactions. A contract delivers a batch with a carrier event instead. An Inbox transaction's Ethereum value, receipt status, and any code at `INBOX_ADDRESS` are ignored.

**Carrier events.** A contract delivers a batch by emitting the Ethereum event `PcashBatch(bytes context, bytes batch)`. A **carrier event** is a log, from any emitter, whose only topic is the constant `0x670af012ce670be5675273ba9381a51588870ed8b0539ed9874aa9a9a173f9df`. That constant is the event's Ethereum signature topic, `keccak256("PcashBatch(bytes,bytes)")`, given here as its provenance: nodes compare log topics with the constant and compute no hash. A log with that first topic and any other topic count is not a carrier. Its data MUST be the canonical ABI encoding of `(context, batch)`, where `C` and `B` are the byte lengths of `context` and `batch`, every `uint256` is a 32-byte big-endian word, and `B <= MAX_BATCH_BYTES`:

```text
data     = uint256(0x40) ‖ uint256(0x60 + pad32(C)) ‖
           uint256(C) ‖ context ‖ zero (pad32(C) − C) ‖
           uint256(B) ‖ batch ‖ zero (pad32(B) − B)
pad32(n) = 32 × ceil(n / 32)
```

Data of any other form, including nonzero padding or trailing bytes, ignores the carrier in full, as a malformed Inbox carrier is ignored. Otherwise `batch` is the candidate batch bytes. `context` is any byte string, empty included, chosen by the emitter; the protocol uses it only by hashing it into the carrier context below.

Carrier events are ordinary logs: they are among the logs the L1 origin tree commits (§7.2), with no special treatment. A reverted call leaves no log, so no receipt status is consulted. One Ethereum transaction may emit any number of carrier events, beside its Inbox carrier if it is an Inbox transaction; §9.4 orders them.

**Carrier context.** Every carrier has a carrier context: a kind, the Ethereum address that vouches for the carrier, and context bytes.

| Carrier | `carrierKind` | Address | Context |
|---|---|---|---|
| Inbox carrier, calldata or blobs | `CARRIER_KIND_INBOX = 0` | the Inbox transaction's sender | empty |
| Carrier event | `CARRIER_KIND_EVENT = 1` | the log's emitter | the event's `context` |

```text
carrierContextHash = poseidon(
    CARRIER_CONTEXT_DOMAIN,
    uint8(carrierKind), uint160(address),
    uint64(contextByteLength), contextChunk_0, ..., contextChunk_(m-1))
m = max(8, ceil(contextByteLength / 16))
```

The context is chunked exactly as log data is (§7.2): consecutive 16-byte big-endian chunks, the final short chunk read as its big-endian integer, in `m` chunk slots that are zero past its end. The encoding is injective for the same reasons. The kind keeps the two sources apart: under EIP-7702 an externally owned account can run code and emit events, and without the kind, a batch that code at address `A` emits on others' behalf would carry the same hash as an Inbox transaction that `A` itself signed and sent. A transaction may require one exact carrier context (§10.6).

`MAX_BATCH_BLOBS = 6`, matching Ethereum's Fusaka maximum for one blob transaction. `MAX_BATCH_BYTES = (MAX_BATCH_BLOBS × 4,096 − 1) × 31 = 761,825`: one field element is reserved for the length header and every other field element carries 31 bytes. The calldata bound above, the blob length bound (§9.2), and the carrier-event bound make every candidate batch at most `MAX_BATCH_BYTES` long.

### 9.2 Blob encoding

A blob is 4,096 consecutive 32-byte field elements. A blob carrier encodes the candidate batch bytes as follows:

* The first byte of every field element is zero.
* The first field element stores the candidate-batch byte length as an eight-byte big-endian integer in bytes 1 through 8; the rest of that field element is zero.
* Starting at the next field element, each field element stores up to 31 consecutive candidate-batch bytes in bytes 1 through 31.
* The final partial field element and all remaining field elements are zero.
* The transaction MUST carry the minimum number of blobs needed for the declared nonzero length, the declared length MUST be at most `MAX_BATCH_BYTES`, and exactly one value is encoded.

Any other representation is noncanonical, and the Inbox carrier is ignored in full.

**Availability versus validity.** An implementation verifies untrusted blob bytes by recomputing each EIP-4844 KZG commitment and its versioned hash and matching the transaction's ordered `blobVersionedHashes`. Failure to obtain every blob with matching content is an availability failure: the blobs are fetched again before that Ethereum block is derived, rather than treating the transaction as invalid. Once all hashes have been verified, a noncanonical blob encoding or a batch-level parse failure is deterministic malformed input, and the carrier is ignored in full.

Ethereum nodes discard blob contents after about 18 days, so deriving older blocks needs each blob from a source that kept it, such as an archiving beacon node; the source need not be trusted, because each blob is checked against its versioned hash. That dependence on archives is the cost of accepting blobs as a carrier; calldata lasts as long as Ethereum history does. Treating a blob that could not be fetched as invalid would let a node that merely failed a download fork away from the network.

### 9.3 Batch framing

The candidate batch bytes parse as:

```text
batchVersion (1, = 0x01) ‖ posterOwnerCommitment (32) ‖ posterContext (32) ‖ count (u16) ‖ count × [len (u32) ‖ txBytes]
```

* `batchVersion` selects only the encoding that recovers the ordered `txBytes` items. It never selects the Ethereum carrier, transaction parsing, verification keys, or execution semantics. Version `0x01` is the only defined encoding.
* The 67-byte header carries a canonical field element `posterOwnerCommitment` and a canonical field element `posterContext`, even when no item pays an open fee or earns issuance. The poster commitment names the recipient of every open fee and any open-route issuance in the batch (§13); it is not the Ethereum sender address. Any canonical value is accepted, zero included, and the batch's payouts are settled under it whatever it is (§14.3), so a poster that names a commitment it cannot open forfeits them. The context is chosen before posting and imposes no inclusion-height or freshness constraint. The reference payout-recovery convention uses it (Appendix B.2).
* `count` items follow, each a `u32` length and then that many bytes.

**Ignoring a whole batch.** The batch is ignored in full, producing no transactions and no results, when any of the following holds, because its claimed framing cannot be trusted:

* `batchVersion` is not a batch version accepted at the block's timestamp (§3.2);
* `posterOwnerCommitment` or `posterContext` is not canonical;
* `count` exceeds `MAX_BATCH_ENTRIES = 1,024`;
* the bytes end before the header, `count`, or any item's `u32` length is complete, or a declared item length, at any position, runs past the end of the bytes;
* bytes remain after the last declared item.

Conditions that ignore a carrier before any batch exists are in §9.1–9.2.

**Oversized items.** If a declared item length is fully present but exceeds `MAX_TX_BYTES`, framing consumes exactly those bytes without allocating that declared size, the item is not admitted (`ItemTooLarge`), and parsing continues at the next item.

`MAX_TX_BYTES = 131,072` is a fixed parsing bound. Exact per-type structural decoding (§10.2) enforces every transaction's wire shape; an item between its real maximum size and this bound fails structural decoding and is not admitted.

There is no batch atomicity: each item is admitted and executed on its own.

### 9.4 Ordering

Transactions are ordered by Ethereum block number, then Ethereum transaction index, then batch item index. Within one Ethereum transaction, carriers are in **carrier order**: its Inbox carrier first, if it is an Inbox transaction, then its carrier events in ascending receipt-local log index (§9.1). `batchItemIndex` is the item's zero-based position among all items of the Ethereum transaction's validly framed carriers, in carrier order. A carrier ignored before or during framing contributes no positions, and items that are not admitted leave gaps among admitted transactions. For an Ethereum transaction with one validly framed carrier, `batchItemIndex` is the item's position in its batch. `pcashTransactionIndex` is a separate dense zero-based ordinal over the admitted transactions of one PCASH block (§7.3).

Each transaction executes at its position against the state produced by all prior successful transactions. When transactions conflict, the first one to succeed changes state, and each later conflicting transaction fails with its first applicable outcome. An earlier transaction that fails its own checks consumes nothing, so it cannot block a later one.

### 9.5 Reorganizations and finality

Derivation is a pure function of canonical Ethereum history. When Ethereum reorganizes, the node removes the orphaned PCASH suffix and derives the replacement suffix from the common parent state, with the ordinary derivation rules. The required result is exactly the state a fresh node would derive from genesis over the new canonical history. Ethereum finality does not change transaction or block validity.

A reorganization also removes abandoned PCASH block hashes from the recent-block window immediately (§10.6).

### 9.6 Unsupported Ethereum data

PCASH consumes only: each block's number, hash, and timestamp; each top-level transaction's index, recipient, sender, calldata, and blob versioned hashes; resolved blob bytes; and each block's receipt logs, each with its transaction and receipt-local indices, emitter, topics, and data, for the L1 origin tree (§7.2) and carrier events (§9.1). If an implementation cannot decode a block, transaction, or receipt into those required values, or cannot resolve a structurally valid blob carrier, derivation halts rather than skipping data and risking a different result. Unrecognized blob-hash versions are deterministically invalid carriers as defined in §9.1; they do not acquire meaning retroactively. The protocol does not attempt to predict or encode future Ethereum fork activations.

There is no per-block proof-verification budget; Ethereum's gas limit and gas prices bound and price the verification work. A per-block cap would let anyone who fills it make every later proof-bearing transaction in the block fail. The cost is that PCASH does not set the bound: it rises with Ethereum's gas and blob limits, and carrier events, which can repeat proof bytes at Ethereum's log-data price, carry the most proofs per block.

## 10. Transactions

This section defines what every transaction has in common: its envelope, when an item counts as a transaction at all, the shared private-value section, and how execution selects an outcome. Sections 11 and 12 define each type's specific rules.

### 10.1 Envelope and types

Every transaction has one common envelope:

```text
txBytes = txType (u8) ‖ pcashChainId (u32be) ‖ txPayload
```

An assigned `txType` permanently fixes its payload grammar and type-specific interpretation; private-value profiles select exact capacities and verifier keys within that grammar. An assigned type MUST NOT be reinterpreted or reused. A fork MAY activate or retire a type for new blocks without changing how historical bytes decode (§3.2).

`pcashChainId` occurs exactly once in `txBytes`, at the fixed envelope offset, and admission requires it to equal `PCASH_CHAIN_ID` (§10.2). Cryptographic statements use the network's `PCASH_CHAIN_ID`, which every admitted envelope equals: position `0` of every private-value section's public inputs (types `0x00` and `0x03`), which the kernels hash into every action commitment (§8.3), and the numeric `pcashChainId` of the account-creation EIP-712 message (§12.1). Proof statements use this conversion, whose result is below `p` by construction:

```text
chainIdWord = bytes28(0) || uint32be(pcashChainId)
```

The four assigned types are:

| `txType` | Transaction | Carries a proof | Defined in |
|---|---|---|---|
| `0x00` | private-value transaction | yes | §11 |
| `0x01` | user-account creation | no | §12.2 |
| `0x02` | contract-account creation | no | §12.4 |
| `0x03` | user-account update | yes | §12.3 |

### 10.2 Admission and structural decoding

An item is **admitted** as a transaction if and only if it passes these checks, in this order:

1. Its length is at most `MAX_TX_BYTES` (§9.3).
2. It holds the complete fixed envelope `txType (u8) ‖ pcashChainId (u32be)`.
3. Its envelope `pcashChainId == PCASH_CHAIN_ID`. Nothing after the envelope is read when they differ.
4. Its payload structurally decodes under `txType`, consuming the item exactly.
5. `txType` is active at the executing Ethereum block's timestamp (§3.2).
6. A user-account creation in direct mode (§12.2) is delivered by an Inbox carrier (§9.1).

Admission happens before signature recovery, proof verification, or any state access, so every node decides it identically. The first failing check names the item's **non-admission class**. The order decides only which class an excluded item records, never whether an item is admitted: a wrong-chain item is `WrongChainId` even when its type is unassigned or inactive or its payload is malformed, and an oversized item is `ItemTooLarge` whatever it holds.

Non-admission classes are not outcome codes: a non-admitted item produces no transaction, no transaction result, and no transaction ID, only a gap in `batchItemIndex`. A node's delivery manifest records the exclusion (Appendix B.1).

| Class | Meaning |
|---|---|
| `ItemTooLarge` | the declared item length exceeds `MAX_TX_BYTES` (§9.3) |
| `Empty` | the item has no bytes |
| `UnknownKind` | the type byte is unassigned, or the type is not active at the block's timestamp |
| `UnknownPrivateValueShape` | a type `0x00` profile selector other than `0` or `1` (§10.4) |
| `UnknownAuthorizationMode` | a user-account creation authorization mode other than `0` or `1` (§12.2) |
| `UnknownAccountCreationTag` | an account-creation attachment tag other than `0`, `1`, or `2` (§11.2) |
| `DirectCreationAttachment` | a direct-mode user creation in an attachment (§11.2) |
| `UnknownReceiveKeyMode` | a creation receive-key mode other than `0` or `1`, or an update receive-key operation other than `0`, `1`, or `2` |
| `UnknownPublishesNkRootFlag` | a contract body `publishesNkRoot` flag other than `0` or `1` (§12.4) |
| `UnknownYParity` | a signed user-account creation `yParity` other than `0` or `1` (§12.2) |
| `Truncated` | the bytes end before the envelope or the payload structure does, including a declared function count beyond the remaining bytes |
| `TrailingBytes` | bytes remain after the structure ends |
| `WrongChainId` | the envelope chain ID is not `PCASH_CHAIN_ID` |
| `DirectModeOutsideInbox` | a direct-mode user-account creation is delivered by a carrier event (§12.2) |

A correct envelope chain ID paired with a proof produced for another domain is admitted and then fails execution. A creation signature produced for another domain is admitted and recovers to an unrelated address, so it cannot create the intended account (§12.2). A wrong envelope chain ID is non-admitted without decoding its payload or invoking recovery or verification. Carriers and batches rejected before trustworthy item boundaries are framed likewise produce no transaction results.

**Structural decoding** determines exact field boundaries and complete byte consumption, and decodes every closed-set selector byte: `txType`, the type `0x00` profile selector `shapeId`, the user-account-creation `authorizationMode` and `yParity`, the account-creation attachment tag, every receive-key mode and operation, and the contract body's `publishesNkRoot`. One rule covers them all: a selector byte outside its set makes the item undecodable, with the class named in the table above. No field carries a length prefix: field sizes follow from the type, these selectors, and the contract body's `functionCount`. Every other value is preserved raw until ordered execution validation: 32-byte words need not be canonical field elements, signature scalars are not range-checked, and function lists are not checked for emptiness or order. Such values are execution failures of the admitted transaction.

**Receive-key fields.** User-account creation and the contract body encode `receiveKeyMode (u8) ‖ receiveKeyBytes`, with `ABSENT = 0` and `PRESENT = 1`. User-account update encodes `receiveKeyOperation (u8) ‖ receiveKeyBytes`, with `KEEP = 0`, `CLEAR = 1`, and `REPLACE = 2`. `receiveKeyBytes` is exactly `ML_KEM768_PUBLIC_KEY_LEN` (§5.1) bytes for `PRESENT` and `REPLACE`, and empty for every other mode. Any other mode or operation byte is non-admitted as `UnknownReceiveKeyMode`.

### 10.3 The private-value section

One structure, the **private-value section**, carries every relation that spends notes or pays a fee: the section following a type `0x00` profile byte and the fee payment ending a type `0x03` update. With `I` input slots and `O` output slots:

```text
privateValueSection = wireWords × verifierInput (32) ‖ proof (proofBytes) ‖ O × outputData (1,213) ‖ arena (arenaBytes)
```

* The serialized words are the private-value verifier inputs (§11.2) other than the chain ID, delivery commitment, and account-creation attachment commitment, which derivation supplies. A type `0x00` section has `wireWords = I + O + 7`. A type `0x03` fee section uses profile S without a profile byte, also omits the zero issuance commitment, and supplies zero for the attachment commitment. It has fifteen wire words and occupies 31,609 bytes.
* `proofBytes = 22,432` for every proof-bearing type and profile (§16). The posted proof body omits the public inputs that begin a compressed CHONK proof; verification prepends the transaction's reconstructed public inputs (§8.1).
* Every private-value section carries exactly `O` output-data items of exactly `OUTPUT_DATA_BYTES = 1,213` bytes each, followed by one arena of exactly `arenaBytes = 32 + 520 × O` bytes: 2,632 in profile S and 16,672 in profile L. Derivation computes, from the exact posted bytes:

  ```text
  outputDataHash_i   = poseidonBytes(OUTPUT_DATA_HASH_DOMAIN, outputData_i)
  arenaHash          = poseidonBytes(ARENA_HASH_DOMAIN, arena)
  deliveryCommitment = poseidon(DELIVERY_COMMITMENT_DOMAIN, outputDataHash_0, ..., outputDataHash_(O-1), arenaHash)
  ```

  The contents are opaque to consensus. Genuine encrypted deliveries and randomized filler are equally valid; format selectors, zero-byte counts, entropy, ciphertext validity, and carrier cost do not affect acceptance. One output-data item serves one output, and the arena holds data that any output's recipient, or the sender, may need; Appendix B.4 gives the reference scheme that fills both. The delivery commitment is the only public word for all of a section's delivery data. A circuit that binds one output's data, or the arena, takes the output-data hashes and the arena hash as witnesses and opens them from the commitment.
* No field in the section carries a length prefix: the proof, output-data, and arena sizes are framing rules that fix where each later field begins. A section whose total length is wrong fails structural decoding (`Truncated` or `TrailingBytes`), so the item is not admitted. A correctly sized proof that does not verify fails with `ProofRejected` (§8.1).

### 10.4 Type payloads

* `txType 0x00`, **private-value transaction**: `shapeId (u8) ‖ privateValueSection ‖ accountCreationAttachment`. The profile selector is `0` for S or `1` for L (§11.1); another selector is non-admitted as `UnknownPrivateValueShape`. The attachment is exactly one tagged value (§11.2), including a single zero tag when absent.
* `txType 0x01`, **user-account creation**: the authorization mode, the user-account creation payload, a recent block hash, a deadline, and an ECDSA signature only for signed authorization (§12.2). It has no proof and no fee, and it carries no address: the account address is the authenticated top-level Ethereum sender in direct mode, or the signer node-side `ecrecover` returns in signed mode. Shared creation-only state checks follow. Consensus derives `accountRevision = 1`.
* `txType 0x02`, **contract-account creation**: a recent block hash, deadline, and unsigned contract body (§12.4). It has no proof, signature, private-value section, fee, or issuance.
* `txType 0x03`, **user-account update**: the account's address, the proposed rule set commitment and receive-key operation, the asserted account update commitment, and a private-value section that pays the fee from the updated account's own native notes (§12.3). The section's `recentPcashBlockHash` and `validUntilTimestamp` are the update's recent block and deadline. Consensus derives the immutable `nullifierKeyCommitment`, the next revision, and the resulting account state row from live state. The proof has twenty public inputs: the section's nineteen, with a zero attachment commitment, then the account update commitment.

### 10.5 Execution and outcomes

Once admitted, a transaction executes its type's checks in a fixed order. The first failing check determines the `outcomeCode`; if every check passes, the outcome is `Succeeded`. An implementation may parallelize internal computation only if it always selects the same first failure. These orders are consensus. Each type's order is defined with the type: private value in §11.2, user-account creation in §12.2, user-account update in §12.3, and contract-account creation in §12.4.

**Failures versus fatal errors.** A verifier rejection, including a proof body that fails decompression, is `ProofRejected`. The pinned verifier refuses a proof the same way when its own execution fails, for example by running out of memory, so a refusal is a rejection only when the verifier reports a failure caused by the proof. Any other refusal, a verifier crash, timeout, missing verification key, invalid verifier response, or any other inability to obtain the pinned verifier's verdict is a **fatal derivation error**. A false state predicate is an included failed transaction; a state read, I/O, corruption, or other infrastructure error is fatal. Fatal derivation errors halt derivation at the Ethereum block and never become transaction outcomes.

**Atomicity.** All checks and state changes for one transaction are atomic. Only `Succeeded` marks nullifiers, records fees, updates accounts, or appends outputs.

**Outcome codes.** The stable `uint16 outcomeCode` values are:

| Code | Outcome |
|---:|---|
| 0 | `Succeeded` |
| 1 | `PublicInputNotInField` |
| 2 | `RecentPcashBlockNotInWindow` |
| 3 | `Expired` |
| 4 | `NotYetValid` |
| 5 | `ZeroNullifier` |
| 6 | `DuplicateInputNullifier` |
| 7 | `NullifierAlreadySpent` |
| 8 | `ProofRejected` |
| 9 | `OutputCapacity` |
| 10 | `AccountCapacity` |
| 11 | `InvalidAccountSignature` |
| 12 | `AccountNotFound` |
| 13 | `AccountAlreadyExists` |
| 14 | `AccountRevisionExhausted` |
| 15 | `WrongAccountKind` |
| 16 | `ClearWithoutReceiveKey` |
| 17 | `ReplaceWithIdenticalReceiveKey` |
| 18 | `AccountUpdateCommitmentMismatch` |
| 19 | `NonCanonicalAccountField` |
| 20 | `ContractAddressExists` |
| 21 | `NonCanonicalContractField` |
| 22 | `EmptyContractFunctionSet` |
| 23 | `SelectorsNotStrictlyIncreasing` |
| 24 | `CarrierContextMismatch` |
| 25 | `AccountCreationMismatch` |

The integers are explicit protocol values, not positions inferred from a language-level array. Unknown numeric values are unsupported and MUST NOT be shifted, aliased, or reinterpreted.

### 10.6 Recent block window and validity conditions

A proof reads only history: everything it opens hangs from one recent block (§8.4). The Ethereum execution that delivers a transaction happens after its proof is made, so facts about that execution, the executing block's timestamp and the carrier that delivers the transaction, are in no block the proof can read. A transaction can only state conditions on them, and the node checks those conditions at execution: the time bounds and the carrier context.

**The recent block.** Every proof-selected protocol-state snapshot is identified by one public `recentPcashBlockHash`. Let `currentTimestamp` be the timestamp of the block being derived. The hash passes the window check if and only if it is the hash of an already committed block `B` of the current canonical PCASH chain with

```text
0 <= currentTimestamp - B.timestamp <= RECENT_PCASH_BLOCK_WINDOW_SECONDS
```

where `RECENT_PCASH_BLOCK_WINDOW_SECONDS = 3,600`. The block being derived is not yet committed, so block `N` first becomes usable in block `N + 1`, and values produced by earlier transactions in the same block cannot be selected. The proof privately opens the state it consumes beneath this block (§8.4).

A block hash passes only while it belongs to the current parent-linked header chain and remains within the window. An orphaned block hash fails immediately rather than remaining usable until its former age limit: after a reorganization removes a block, an admitted transaction naming it fails with `RecentPcashBlockNotInWindow` and must be rebuilt to succeed.

**Time bounds.** `notBeforeTimestamp` and `validUntilTimestamp` bound when the authorized action may execute. `validUntilTimestamp` is a pure deadline and does not extend the lifetime of the referenced block.

**Carrier context.** `carrierContextHash` (§11.2) names the carrier context (§9.1) that the transaction requires. Zero states no condition: the transaction executes however it is delivered. A nonzero value is satisfied only when it equals the `carrierContextHash` of the carrier that delivers the transaction, so only by an Inbox transaction from that sender or by a carrier event from that emitter with exactly that context; otherwise the transaction fails with `CarrierContextMismatch`, checked immediately after `NotYetValid` in every proof-bearing type's order (§11.2, §12.3). Kernels bind the value into the private-value commitment (§11.3) and do not interpret it. A rule that relies on it opens the private value and constrains the value, choosing which parts of the carrier context to pin: it recomputes the hash in its circuit and may leave the address or any part of the context as a free witness. The condition is not part of the rule statement (§8.2) or of any action's extra data (§8.3).

**Authorization lifetime versus proof lifetime.** Every proof is separately bound to its exact `recentPcashBlockHash` and can succeed only while that snapshot passes the window check. If the selected application's authorization condition does not itself commit to the snapshot, the same unchanged action may be re-proved against a newer qualifying snapshot without being reauthorized. Changing any action field produces a different action and requires authorization for that action.

## 11. Private-Value Transactions (`txType 0x00`)

A private-value transaction spends notes and creates notes. It moves native PCASH, one standard non-native asset, or both, in one shared relation. Every private-value transaction has the same public shape for its profile: a fixed number of input slots, each publishing one nullifier, and a fixed number of output slots, each publishing one note-body commitment and one data item. The proof shows privately that the real slots obey the ledger rules and that the owning account's rule approved the exact transaction.

This section first defines what nodes see and check (§11.1–11.2), then the relation the proof establishes (§11.3–11.8).

### 11.1 Profiles

Exactly two public profiles select compiled instances of one shared relation:

| Profile | shapeId | Inputs I | Outputs O | Public fields | Wire words |
|---|---:|---:|---:|---:|---:|
| S | 0 | 4 | 5 | 19 | 16 |
| L | 1 | 32 | 32 | 74 | 71 |

* Dimensions are fixed by the profile, never inferred from vector lengths or configured by a client.
* Each profile selects its own exact hiding-kernel VK (§16).
* Real occupancy is private: which slots carry value is not public, within the limits each kernel sets (§11.4–11.7), and minimally occupied L actions are valid.
* S and L share notes, the output tree, and the spent set. A note keeps its creation secret when it is spent through the other profile.

A type `0x00` transaction is `262 + 32*I + 1765*O + proofBytes + attachmentBytes` bytes, where `proofBytes = 22,432` (§16). An absent attachment occupies one byte, so S occupies 31,648 bytes and L 80,199 bytes. One unattached L transaction plus the 67-byte batch header and 4-byte item framing occupies 80,270 bytes, within one blob’s 126,945-byte capacity. The largest contract attachment occupies 17,795 bytes, making the largest L transaction 97,993 bytes. Every carrier kind admits both profiles.

### 11.2 Public inputs and validation

**Public inputs.** For the selected profile, the proof's public inputs are, in this fixed order:

```text
0                chainId
1                recentPcashBlockHash
2 .. 1+I         nullifiers
2+I .. 1+I+O     outputBodyCommitments
2+I+O            deliveryCommitment
3+I+O            openFeeAmount
4+I+O            issuanceOwnerCommitment  (0 = open route)
5+I+O            notBeforeTimestamp       (< 2^64; 0 = unconstrained)
6+I+O            validUntilTimestamp      (< 2^64)
7+I+O            carrierContextHash       (0 = no condition)
8+I+O            eventsCommitment
9+I+O            accountCreationCommitment
```

There are `I + O + 10` public inputs. The wire serializes the `I + O + 7` non-derived fields, omitting the chain ID, delivery commitment, and attachment commitment (§10.3). Derivation supplies the chain ID, computes the delivery commitment from every output-data item and the arena, and computes the attachment commitment from the exact tagged attachment below.

The fields mean:

* `nullifiers`: one per input slot. A real input publishes its note's nullifier; a padding input or marker slot publishes its marker (§11.3).
* `outputBodyCommitments`: one note-body commitment per output slot, including padding. Every body appends one ordinary output commitment.
* `deliveryCommitment`: the commitment to the section's exact output-data items and arena (§10.3).
* `openFeeAmount` and `issuanceOwnerCommitment`: the public fee and the issuance destination (§13).
* `accountCreationCommitment`: the exact tagged attachment commitment, or zero when absent.
* `notBeforeTimestamp` and `validUntilTimestamp`: the time window (§10.6).
* `carrierContextHash`: the carrier context the transaction requires, or `0` for none (§9.1, §10.6).

`assetId`, slot classes, the selected kernel path, application VKs, owner accounts, funding composition, and amounts are not public inputs.

**Event commitment.** `eventsCommitment` is the salted commitment to the authenticated event application and its claim (§8.6). The proof binds its opening to every authorizing rule's event entry. The node treats it as an opaque canonical field word.

**Rules the proof enforces.** The following hold for every valid proof, and nodes do not check them separately: `notBeforeTimestamp < 2^64`; `validUntilTimestamp < 2^64`; `openFeeAmount < 2^128`; and a nonzero `issuanceOwnerCommitment` requires `openFeeAmount = 0`. A transaction that violates one of them fails with `ProofRejected`, unless an earlier check fails first. The proof does not require a nonzero `validUntilTimestamp` or nonzero nullifiers: the node rejects a zero deadline as `Expired` and a zero nullifier as `ZeroNullifier` in the checks below. The capacity reservation does not depend on the size of an open fee (§14.3), so an open fee of `2^128` or more reaches proof verification. The selected relation privately opens the state roots it needs through `recentPcashBlockHash -> stateRoot`, and nested rules may open other authenticated facts they consume (§8.4).

**Validation.** Nodes apply these checks in order (§10.5):

1. Require every reconstructed public input to be canonical (`PublicInputNotInField`).
2. Require `recentPcashBlockHash` within the recent-block window (§10.6) (`RecentPcashBlockNotInWindow`).
3. Require `currentTimestamp <= validUntilTimestamp` (`Expired`).
4. Require `notBeforeTimestamp <= currentTimestamp` (`NotYetValid`). `notBeforeTimestamp == 0` is unconstrained below, and there is no maximum lookahead.
5. If `carrierContextHash != 0`, require it to equal the delivering carrier's `carrierContextHash` (§9.1, §10.6) (`CarrierContextMismatch`).
6. Validate the attachment as specified below, including its signature or body, its own user-creation freshness, compatibility with an existing account, and capacity for a new account.
7. Require the nullifiers, in this order: no zero value (`ZeroNullifier`), pairwise distinct (`DuplicateInputNullifier`), then globally unseen (`NullifierAlreadySpent`). Report the lowest failing input slot. Then require the capacity reservations of §14.3 (`OutputCapacity`).
8. Verify the proof against the selected profile's pinned hiding-kernel VK (`ProofRejected`).

**Effects.** Only if every check succeeds, atomically:

1. Insert all `I` nullifiers into the spent set (§6.4).
2. Append the `O` output commitments at `outputIndex0 = nextOutputIndex`, for `0 <= i < O`:

   ```text
   outputCommitment_i = poseidon(OUTPUT_COMMITMENT_DOMAIN, outputBodyCommitment_i, outputIndex0 + i)
   ```

3. Update the capacity reservations (§14.3).
4. Record the settlement obligations `(openFeeAmount, issuanceOwnerCommitment, posterOwnerCommitment)` (§13), and count the transaction as a qualifying action (§14).
5. Insert the staged account, if absent, with the next account index and revision `1`. If it already existed compatibly, leave its row, index, revision, receive material, and original creation provenance unchanged. Record insertion or reuse in the transaction result (§7.3).

**Account-creation attachment.** Its canonical encoding is:

```text
0: tag (u8 = 0)
1: tag (u8 = 1) ‖ signedUserCreationPayload (§12.2, including authorizationMode = 1)
2: tag (u8 = 2) ‖ contractBody (§12.4)
```

The user payload has no transaction envelope: its EIP-712 chain ID is the enclosing transaction’s chain ID. Direct authorization is non-admitted as `DirectCreationAttachment`, because it would authenticate the poster rather than the intended owner. An unknown tag is non-admitted as `UnknownAccountCreationTag`. Structural decoding consumes the attachment exactly. The commitment is zero for tag `0`, otherwise `poseidonBytes(ACCOUNT_CREATION_ATTACHMENT_DOMAIN, tag ‖ payload)`. Both the public statement and private-value commitment bind this word; signature recovery and body interpretation are node checks.

For tag `1`, first recover and validate the signature as in §12.1 (`InvalidAccountSignature`); require canonical nullifier-key and rule-set commitments (`NonCanonicalAccountField`); require the creation’s recent block in the canonical recent window (`RecentPcashBlockNotInWindow`); and require its deadline not passed (`Expired`). Then read the address recovered from the signature. If present, require a USER account with exactly the signed nullifier-key commitment (`AccountCreationMismatch`). Keep its current rule set, receive key, and revision. If absent, require account capacity (`AccountCapacity`) and stage the signed initial row.

For tag `2`, apply the canonical-field, key-derivation, function-list, function-set and address-derivation checks of §12.4 in that order. If the address exists, require kind CONTRACT, the derived nullifier-key and function-set commitments, revision `1`, and the derived receive-key digest (`AccountCreationMismatch`). Comparing the complete row prevents a different body that collides in the 160-bit address from being reused. If absent, require account capacity and stage the initial row.

Body, signature and user-creation freshness checks run for both insertion and reuse. Reuse allocates no account index and needs no spare account capacity. Copying and publishing an identical creation first therefore does not invalidate the carrying transaction. No attachment effect commits unless every subsequent value check and proof succeeds.

An attachment grants no spending, sponsorship, or installed-rule authority: those still require membership under the value transaction’s recent account root. The new account may receive outputs, but outputs are not required to fund it. The transaction earns its ordinary single issuance share; the attachment earns none. The public attachment links the account to this transaction. Standalone creation remains available.


### 11.3 Slot classes, markers, and the private-value commitment

**Slot classes.** Every slot has a private class. Classes `0..2` are shared by inputs and outputs and name the value the slot holds: `DUMMY = 0` (padding), `NATIVE = 1`, `ASSET = 2`. `ASSET_CREATION = 3` and `APPLICATION = 4` are input-only **marker** classes: they carry no note, and exist only to publish a one-time marker in the spent set. The classes are private fields of the private-value commitment.

An input slot that holds no note still publishes a nonzero nullifier. The three kinds of non-note input differ in who defines their nullifier and what it is scoped to:

| Class | Nullifier defined by | Scoped to |
|---|---|---|
| `DUMMY` | the protocol kernel, from one fresh per-action seed | nothing |
| `ASSET_CREATION` | the fixed-supply relation (§11.6) | the asset |
| `APPLICATION` | the selected account rule (§8.2) | (account, entry) |

Slot requirements:

* A dummy, asset-creation, or application input has zero input commitment. A native or asset input's input commitment is the output commitment of the note it opens (§4.3), which includes its output index.
* A native or asset input spends a note of positive amount, and a native or asset output has a positive 128-bit amount. A dummy output has asset ID zero and amount zero.
* Every real note output carries an opaque owner commitment, which may be any field element (§4.4). Nothing compares it with the transaction's `issuanceOwnerCommitment`: an output that reuses that commitment is still a separate note under its own indexed output commitment, but anyone can link it to the public payout result (§7.3), so wallets keep the two independent (§13). Every dummy output carries the owner commitment of address `0` under its private dummy secret (§4.4).
* Every input nullifier is nonzero; the node checks that (§11.2).

The prover chooses each slot's class freely, and the kernel requires it to be one of the classes above. The kernel derives every other slot field, as this section states.

**Private-value commitment.** The private-value commitment binds the complete private value: the profile, the fee, issuance destination, time bounds, required carrier context, private burn amount, delivery commitment, attachment commitment, and every slot's class and commitment, with each input's nullifier, in slot order. Every action commitment is built on it (§8.3).

```text
privateValueCommitment = poseidon(
    PRIVATE_VALUE_COMMITMENT_DOMAIN,
    shapeId, N_IN, N_OUT,
    openFeeAmount, issuanceOwnerCommitment, notBeforeTimestamp, validUntilTimestamp,
    carrierContextHash, assetBurnAmount, deliveryCommitment, accountCreationCommitment,
    inputSlotClass_0, inputCommitment_0, nullifier_0,
    ..., inputSlotClass_(N_IN-1), inputCommitment_(N_IN-1), nullifier_(N_IN-1),
    outputSlotClass_0, outputBodyCommitment_0,
    ..., outputSlotClass_(N_OUT-1), outputBodyCommitment_(N_OUT-1))
```

The commitment binds the selected profile, every slot in order, and the private `assetBurnAmount`, without binding transient tree roots or the chain ID. The action commitment adds the chain ID (§8.3), so an unchanged action can be re-proved against a newer recent block (§10.6). A signed creation attachment separately commits its own recent block and deadline; refreshing that attachment changes the action and requires renewed authorization. The profile fixes the number of operands, so each slot's position and class are bound: an output cannot be moved, and a slot cannot be reinterpreted, without changing the authorized action. Require `0 <= assetBurnAmount < 2^131`.

**Selecting the relation.** The asset ID is not a transaction field. The transfer and sponsored-transfer kernels take it as a private witness, and the asset-creation kernel derives it from the asset definition (§11.6). It is the note namespace of every `ASSET` input and output, and every kernel requires it to be nonzero for each `ASSET` slot it opens or constructs. When no slot is `ASSET`, the transfer kernel's asset-ID witness is unused. An `APPLICATION` marker carries no asset value and does not select the asset path. The slot classes then admit exactly these asset shapes:

* One or more `ASSET` inputs and no `ASSET_CREATION` marker take the transfer kernel (§11.4) or the two-account sponsored-transfer kernel (§11.7). Both kernels reject every `ASSET_CREATION` input, and the sponsored-transfer kernel requires at least one `ASSET` input.
* No `ASSET` input and exactly one `ASSET_CREATION` marker take the asset-creation kernel (§11.6). It requires `assetBurnAmount = 0` and asset outputs that sum to the initial supply. Every real output amount is positive, so a positive supply has at least one `ASSET` output and a zero supply has none.
* Every other asset shape fails. With no `ASSET` input and no marker, only the transfer kernel can accept, and its asset conservation `0 = sum(asset outputs) + assetBurnAmount` forces no `ASSET` output and `assetBurnAmount = 0`, because every real output amount is positive and the sum stays far below the field modulus.

The slot grammar determines the relation in every case but one. Slot classes name namespaces, not owners, so they cannot express whether a second account funds the fee. A transfer and a sponsored transfer therefore use different private protocol kernels, both accepted by the same hiding kernel. The sponsored-transfer kernel's two authenticated accounts have different kinds and are therefore different accounts (§11.7), so a one-account action cannot gratuitously take that path.

**Padding inputs.** The protocol kernel derives every dummy input's nullifier as `poseidon(DUMMY_NULLIFIER_DOMAIN, dummyInputSeed, inputIndex)` from one private seed per action (§4.4). A dummy input is shape noise, not application replay protection: its value is slot-indexed and fresh per action, which is the exact opposite of what a marker requires.

**Application markers.** An account rule that must allow some fact to be used only once, such as a claim against an escrow, consumes an `APPLICATION` slot whose nullifier is:

```text
applicationNullifier = poseidon(
    APPLICATION_NULLIFIER_DOMAIN,
    uint160(address), selectedEntryCommitment, replayId)
```

The authenticated account's address and the exact selected account-rule entry supply the scope. One account exists per address, so the address scopes markers as uniquely and as permanently as the account itself. `replayId` is defined entirely by that rule and is never interpreted by any fixed relation. Scoping to the entry rather than to the account alone means a sibling entry cannot consume another entry's markers. Because markers are scoped to one entry, two installed entries never share replay state. An application whose S and L variants must share replay state MUST therefore be installed as one entry whose VK accepts both profiles; its S opening excludes the canonically zero trailing capacity. Separately installed note-funded entries need no shared replay state, because the real-note nullifiers they consume already prevent double spending.

The operand list is closed and normative. It binds no slot index, no input note commitment, no output, no fee, no timestamp, no recent root, no chain ID, and no proof randomness. If it bound any of them, a party could reshape the transaction (spend different inventory, move the marker to another slot, change the fee) and derive a fresh marker for the same fact. Independence from slot and transaction shape is what makes the value one-shot at all. No PCASH nullifier binds the chain ID. A marker that must be unguessable, or must differ across chains, carries a secret inside `replayId`, as `noteSecret` and the asset secret do elsewhere.

The transfer kernel (§11.4), the sponsored-transfer kernel (§11.7), and the asset-creation kernel (§11.6) enforce markers by authenticating both the account and the selected entry against the same transaction; the sponsored-transfer kernel scopes every marker to its primary account, and the asset-creation kernel to the creating account. Each kernel:

* takes a private `replayId` for each `APPLICATION` slot and requires that slot's nullifier to equal the value above; replay witnesses in other slots are unused. Any field element, zero included, is a valid `replayId`: the slot's class, not its value, makes it a marker;
* relies on the selected application to derive its own canonical `replayId` independently and assert the same equality against the same nullifier, so the two agree only if the replay identities are equal. The application receives `selectedEntryCommitment` privately and does not re-derive its own entry, which would be a self-reference with no fixed point.

There is no protocol cap on the number of `APPLICATION` slots; an application caps itself.

**Output construction.** The kernel constructs all `O` output bodies from the owner commitments, the slot-derived asset ID, and the amounts. For `ASSET` outputs it uses the action's nonzero asset ID; for `NATIVE` and `DUMMY` outputs it uses zero. It does not open a real output's owner commitment, except the fee payer's native change output in a sponsored transfer (§11.7). For each dummy slot `i`, it takes a private `dummySecret_i` and derives the slot's owner commitment as `poseidon(OWNER_COMMITMENT_DOMAIN, 0, dummySecret_i)`, the owner commitment of address `0` (§4.4).

### 11.4 The transfer kernel

The transfer kernel proves the ordinary one-account spend: one account owns every real input, and one of its installed rules authorizes the complete transaction. It handles native payments, asset transfers and burns, and actions that spend nothing.

A transfer contains no `ASSET_CREATION` input. It MAY contain `NATIVE` inputs, `ASSET` inputs, or both, and it MAY contain `APPLICATION` markers, whose nullifiers the transfer kernel enforces (§11.3). Markers require historical account membership even when the action spends no real note.

**With real inputs.** All real inputs belong to one authenticated `USER` or `CONTRACT` account. A `NATIVE` input uses `assetId = 0`, and an `ASSET` input uses the action's nonzero asset ID. A native-only action additionally has no `ASSET` output and `assetBurnAmount = 0`. The kernel:

1. proves every real input's note membership and canonical nullifier;
2. constructs native, asset, and dummy output bodies;
3. enforces native conservation including the fee, and asset conservation including the burn (§11.6);
4. authenticates one application entry against the supplied rule-set commitment by its exact MegaApp VK hash;
5. links that application and requires its rule statement (§8.2) to equal `[authorizationCommitment, actionCommitment, recentPcashBlockHash, eventEntry]` for the account's address, the entry's `configurationCommitment`, and the transfer action (`TRANSFER_ACTION_DOMAIN`, `extraData = 0`, §8.3).

The address is one of the supplied account fields, which historical account membership authenticates whenever any input is not `DUMMY`.

**With only padding inputs.** An action whose inputs are all `DUMMY` spends nothing. For such an action:

* it requires no registered account, because the kernel does not prove that the supplied account exists;
* the output rules of §11.3 and both conservation equations force `openFeeAmount = 0`, `assetBurnAmount = 0`, and only `DUMMY` outputs; the action's asset-ID witness is unused when no slot carries an asset;
* it is still a qualifying action if it succeeds (§14), and its issuance uses the ordinary destination rules (§13). This lets a newcomer earn PCASH without holding any.

The kernel still opens the supplied account and rule set, binds the exact application VK and rule statement, and recursively verifies the application. The account-leaf and Merkle computations and rule membership all remain mandatory. Only one check is conditional:

```text
allInputsDummy OR reconstructedAccountRoot == historicalAccountRoot
```

`allInputsDummy` is derived in constrained code from every private input class being exactly `DUMMY`; `APPLICATION` and `ASSET_CREATION` never qualify. The supplied account fields and rule set on this path therefore do not represent authenticated installed-account authority.

Dummy nullifiers remain globally single-spend (§11.2, §6.4), so an accepted proof cannot earn issuance twice. Registration itself earns no issuance. A registration and an all-padding action may be published in one batch with independent outcomes; the action is valid regardless of the registration's position or success, including when no registration is published. A creation attachment couples registration and the action under §11.2. Spending a recovered reward later requires normal historical account and note membership.

Both cases use the same transfer kernel and VK within their profile, followed by the ordinary hiding kernel. The sponsored-transfer and asset-creation kernels require unconditional account membership; the account-update kernel relies on the node's check of the live row (§12.3). The folded stack is `selected application → event application → transfer kernel → hiding kernel`. A zero-fee action remains valid when ordinary conservation holds.

### 11.5 Protocol kernels

The protocol kernels own ledger structure: exact slot classification, note-body construction, dummy padding, the private-value commitment, timestamp and amount bounds, note membership, namespace isolation, conservation, burn, and fees. The asset-creation kernel also owns asset identity and one-shot supply (§11.6). An asset creator supplies no circuit or executable logic.

A type `0x00` proof privately selects one of three kernels, each compiled for S and L:

* the **transfer** kernel (§11.4): one account owns every real input;
* the **sponsored-transfer** kernel (§11.7): a contract account's asset action with a distinct user account paying the native fee;
* the **asset-creation** kernel with optional native funding (§11.6): creates a new asset's supply.

The hiding kernel accepts exactly these three kernel VKs. The selected kernel and application identities are private.

Every kernel that spends notes authenticates the relevant owner account, authenticates each selected installed entry, and links each application. For every real input slot it proves exact note membership, owner binding, amount range, asset namespace, and canonical nullifier. Application identity, account identity, note secrets, nullifier-key material, account openings, and amounts remain private inside the folded proof.

Real-input witnesses cover every `ASSET` and `NATIVE` slot exactly once; the protocol kernel separately owns marker and dummy slots. One transaction may contain only one nonzero asset ID. All positive fees are funded by native notes. Contract-owned native inputs take the transfer kernel; the sponsored-transfer kernel does not reinterpret them as a user contribution. Zero-fee native and asset actions remain consensus-valid.

`assetBurnAmount` is a field of the private value: it changes the private-value commitment and is therefore available to any installed application that opens the private value, but it is not a public proof input.

### 11.6 Standard fungible assets

Every nonzero asset is an instance of one semantic protocol law, the standard fungible asset: a fixed supply created once, then only transferred, split, merged, or burned. An asset's identity is a commitment to its immutable definition:

```text
assetSecretCommitment = poseidon(
    ASSET_SECRET_COMMITMENT_DOMAIN, assetSecret)

assetId = poseidon(
    ASSET_ID_DOMAIN,
    metadataCommitment, initialSupply, assetSecretCommitment)
```

* `assetSecret` and `metadataCommitment` may be any field elements and `initialSupply` any value in the range below, zero included. A zero metadata commitment is one more opaque value, and a zero supply creates the asset and its creation marker but no note.
* `initialSupply <= 5 × (2^128 - 1)`, and the selected creation shape is valid only when its asset output slots can represent that supply.
* There is no asset registry, transition VK, executable asset configuration, mutable supply object, public supply counter, or public asset-ID field.

**Asset definition.** The canonical definition opening of one standard asset is `standardFungibleAssetDefinition = (metadataCommitment, initialSupply, assetSecretCommitment)`, from which anyone recomputes `assetId`. It contains the asset-secret commitment rather than the secret, and grants no authority to create or spend. Wallets and applications MAY retain it privately to authenticate metadata, prove the immutable original supply, or establish lineage to a successor asset under Appendix A. Consensus never requires it to be public, and a successor application MAY identify a source asset by `assetId` alone.

**Transfer and burn.** A nonzero asset is ordinary notes under its own namespace with a second conservation equation, so transfer and burn take the transfer kernel (§11.4) alongside native PCASH: it authenticates the account, opens every real input in either namespace, links the selected application, and enforces both conservation equations itself. There is no separate asset-transfer relation, and no definition opening is needed on transfer. The transfer kernel requires one to `I` asset inputs when the action carries an asset, no `ASSET_CREATION` marker, and zero to `O` asset outputs. It range-checks each note amount to 128 bits and enforces:

```text
sum(asset inputs)  = sum(asset outputs)  + transaction.assetBurnAmount
sum(native inputs) = sum(native outputs) + openFeeAmount
```

Conservation intermediates are bounded by the compiled slot capacities and each note's 128-bit amount: for L, each sum of notes is below `2^133` and a native output sum plus the fee is below `2^134`. The private-value commitment relation bounds `assetBurnAmount` below `2^131`. Asset sums also cannot exceed the fixed initial supply (§11.8), because the node rejects duplicate and spent nullifiers. All these quantities are strictly below the field modulus, so both equalities have their integer meanings. `assetBurnAmount` is not a separate relation witness: the kernel opens the value already bound by `privateValueCommitment`.

The transfer kernel proves that every real asset and native input belongs to its one authenticated account. Each real input must have a valid note opening; note witnesses in marker and dummy slots are unused. Inputs owned by different accounts fail in the transfer kernel and are admitted only by §11.7, which authenticates a second account for the single purpose of funding the fee. One account owns every real input to an asset-bearing transfer, and one selected installed rule authorizes its complete contribution against the exact action commitment. The rule may enforce commercial terms such as price, required PCASH recipients, royalties, redemption conditions, schedules, reserve proofs, or successor custody.

**Asset creation.** Asset creation has its own kernel, because it derives the asset identity from its definition, fixes the initial supply, and consumes a one-shot marker, none of which an ordinary spend does:

```text
asset creation with optional native funding:
    installed account authorization → event application
    → asset-creation kernel → hiding kernel
```

The asset-creation kernel requires no asset input, exactly one `ASSET_CREATION` marker, and `assetBurnAmount = 0`. It:

1. opens the asset definition and derives `assetSecretCommitment` from `assetSecret`;
2. derives `assetId`, and opens every asset output under it;
3. publishes the creation marker in the marker slot:

   ```text
   creationMarker = poseidon(ASSET_CREATION_MARKER_DOMAIN, assetId, assetSecret)
   ```

4. requires the sum of asset outputs to equal `initialSupply` exactly;
5. supplies the asset-creation action commitment for that `assetId` (§8.3).

The marker is scoped to the asset, not to the authorizing account and installed entry, because an asset's creation must be one-shot whoever creates it. The secret may be any field element. It authorizes the initial allocation and blinds the public marker, and through its commitment it makes each asset ID unique, so identical metadata and supply under different secrets are different assets. `assetId` fixes the secret, so every reshaped creation of the same asset derives the same marker and the global spent set accepts at most one. Creation makes the whole supply in one transaction, so this one marker per asset ID is the only uniqueness check an asset needs. Reusing a secret on an identical definition yields the same asset ID and marker, which only makes the creator's second creation fail. Because the secret is the asset's only creation authority (below), anyone who knows or guesses it and the definition can create the asset first; a creating wallet SHOULD draw a fresh random secret for each asset. Ordinary transfer, split, merge, and burn use real-note nullifiers and no creation marker. No later mint path exists.

The asset-creation kernel also enforces the creating account's `APPLICATION` markers exactly as the transfer kernel does (§11.3). The creation marker stops only a second creation of the same asset, and another asset secret defines another asset. An application marker lets an installed rule allow at most one asset creation per fact, such as one asset per voucher or per L1 event, for that account and entry, given the rule's canonical `replayId`.

Every asset creation folds one installed authorization application from an existing `USER` or `CONTRACT` account, whose account and exact rule VK are authenticated against the selected recent state. That application approves the asset-creation action (`ASSET_CREATION_ACTION_DOMAIN`, `extraData = assetId`, §8.3) of the exact asset-creation transaction, including its account's native funding and its issuance route. The extra data binds the asset ID the application approves to the one the kernel derives (§8.3). It does not decide who may create the asset: the asset secret is the only asset-specific authority, so whoever holds it can create the asset, with any allocation, from any account whose installed rule approves the transaction. The asset-creation kernel accepts optional native note funding owned by this same account and enforces `sum(native inputs) = sum(native outputs) + openFeeAmount`. With no native inputs, positive native outputs and positive fees are impossible.

### 11.7 Sponsored transfer

In a transfer (§11.4) every real input belongs to the single authorizing account, so an action spending a contract's asset inventory must also be funded by the contract, not by the party who initiated it. This relation admits a second account in exactly one role: a user account supplies native PCASH for the open fee, or for one exact private relay output, of a named contract account's asset action, and receives its own native change.

The relation:

* authenticates two accounts and their selected installed rules under one account-state root, and requires the primary account's kind to be `CONTRACT` and the fee payer's kind to be `USER`. That root holds one account per address, so accounts of different kinds have different addresses;
* partitions inputs by slot class: `ASSET` inputs and every `APPLICATION` marker belong to the primary account, and `NATIVE` inputs belong to the fee payer. At least one `NATIVE` input is required;
* enforces `sum(asset inputs) = sum(asset outputs) + assetBurnAmount` and `sum(native inputs) = openFeeAmount + privateRelayAmount + nativeChangeAmount`;
* permits at most one ordinary private native relay output and one native change output. Change must open to the fee payer's address `sponsorAddress`, as `poseidon(OWNER_COMMITMENT_DOMAIN, uint160(sponsorAddress), changeSecret)` for a private `changeSecret`. Any field element is accepted as that secret; choosing one with entropy is the payer's job. The sponsor's rule authorizes the exact relay amount and owner commitment through the private-value commitment;
* admits no other native payment, no asset contribution from the fee payer, and no native input owned by the primary account. Payouts of the asset to third parties remain governed by the primary contract account's rule. An `ASSET_CREATION` marker is rejected.

The fee payer contributes no asset, owns no marker, and can lose at most `openFeeAmount + privateRelayAmount`. Exchange and every other multi-party settlement use application contracts and sequential actions rather than multi-owner type `0x00` proofs, because those require parties to contribute value to each other rather than only to the open fee and selected relay payment.

The two installed applications return their role-separated rule statements privately. The sponsored-transfer kernel authenticates both exact MegaApp VK hashes, links both rules and the event application, enforces the complete type `0x00` relation, and returns the same `I + O + 10`-field statement for the selected profile as the transfer and asset-creation kernels. The second account has no public identifier, transaction mode bit, or dedicated public input.

**Role-separated action commitments.** The two rules approve the same private value in different roles (§8.3):

```text
primaryActionCommitment = poseidon(
    SPONSORED_TRANSFER_ACTION_DOMAIN, pcashChainId, privateValueCommitment, 0)

sponsorActionCommitment = poseidon(
    CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN, pcashChainId, privateValueCommitment,
    primaryContractAddress)
```

The kernel requires the primary application to return `[authorizationCommitment(primaryContractAddress, primaryConfigurationCommitment), primaryActionCommitment, recentPcashBlockHash, eventEntry]` and the sponsor's application to return `[authorizationCommitment(sponsorAddress, sponsorConfigurationCommitment), sponsorActionCommitment, recentPcashBlockHash, eventEntry]` (§8.2). `primaryContractAddress` and `sponsorAddress` are the authenticated accounts' addresses, so a sponsorship approves paying only for the contract its rule names.

The separation is necessary. A primary rule might omit native constraints because this relation controls all native value. Replayed through the transfer kernel, where the primary account itself owns the native inputs, that rule would permit exactly the redirection this relation forbids. Separate domains make the two authorizations non-interchangeable: a transfer authorization cannot become a primary one, a primary authorization cannot spend the sponsor's notes, and sponsorship is never authority over application state or over another contract account.

### 11.8 Nonzero-asset provenance invariant

Every reachable nonzero-asset note descends from exactly one valid standard asset creation. The rules above prove this by induction:

* Genesis and every canonical reconstruction begin with no nonzero-asset note.
* Standard asset creation is the only relation that may create a nonzero-asset output without consuming a nonzero-asset input, and it authenticates the complete definition and derived asset ID.
* Every transfer or sponsored transfer with a nonzero asset requires at least one real asset input and constructs every asset output using exactly that input's asset ID.
* Account creation, account update, and every relation other than asset creation cannot create nonzero-asset value without consuming it.

Checkpoint restore, restart, reorg replay, and fresh reconstruction MUST reproduce outputs through canonical transaction execution; they MUST NOT admit independent output-tree contents that bypass this invariant. Conformance testing MUST attempt nonzero-asset creation through every non-asset relation and require it to be rejected.

The standard law fixes fungible transfer and burn semantics. The creator has no later mint, freeze, pause, clawback, blacklist, transfer-tax, receiver-hook, or administrative-spend path. Controlled distribution is ordinary contract custody: asset creation may create notes owned by a contract, and later movement of those notes must satisfy one installed rule capable of authorizing the contract's complete contribution. Contract conditions apply only while the contract owns the notes.

## 12. Account Transactions

Accounts are created by standalone user or contract creation (`0x01` or `0x02`), or ensured by a type `0x00` attachment (§11.2). A user account is created with its Ethereum key and afterwards changed only by its own rules through type `0x03`. A contract account’s body fixes its address and immutable rules. Account updates pay fees through a private-value section (§10.3); standalone creations are proof-free and pay no PCASH fee.

### 12.1 Protocol-defined EIP-712 message

Signed user-account creation uses EIP-712 with domain:

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name = "PCASH"   version = "1"   chainId = L1_CHAIN_ID   verifyingContract = INBOX_ADDRESS
```

The exact primary type is `PcashUserAccountCreation(uint256 pcashChainId,uint256 nullifierKeyCommitment,uint256 ruleSetCommitment,bytes32 receiveKeyHash,bytes32 recentPcashBlockHash,uint256 validUntilTimestamp)`. ECDSA is over secp256k1 with digest `keccak256(0x1901 || domainSeparator || hashStruct(message))`. The signature MUST have `0 < r < n` and `0 < s <= n/2`, and node-side `ecrecover` MUST succeed; the y-parity byte is `0` or `1` by structural decoding (§10.2). The message has no account field: the account address is the signer that `ecrecover` returns.

The node registers the account at the address the signature recovers. Registering an account at a chosen address with chosen material therefore requires a valid signature by that address's key. A changed payload or signature that still recovers creates an account at the address it recovers, which grants no authority over the intended one. An intended account therefore cannot be created without its key's authorization.

This is the only message the protocol itself signs over. Private-value and administration ECDSA messages are relations implemented by optional account-rule circuits (§8.2), not ambient protocol authority.

### 12.2 User-account creation (`txType 0x01`)

Creation registers a user account for an Ethereum address. It carries no proof, pays no PCASH fee, and earns no issuance. Because no rule exists before the account does, creation is authorized by the address's Ethereum key, in one of two modes.

**Payload.**

```text
authorizationMode (u8) ‖ nullifierKeyCommitment (32) ‖ ruleSetCommitment (32) ‖
receiveKeyMode (u8) ‖ receiveKeyBytes ‖ recentPcashBlockHash (32) ‖ validUntilTimestamp (u64) ‖ authorizationBytes
```

`receiveKeyBytes` is `ML_KEM768_PUBLIC_KEY_LEN` bytes for `PRESENT` and empty for `ABSENT` (§10.2). The payload carries no address; each mode determines it.

**Direct mode** (`authorizationMode = 0`) has empty `authorizationBytes`. The account address is the authenticated sender of the Inbox transaction carrying this batch item. This applies equally to calldata and blob carriers. A direct-mode item delivered by a carrier event is not admitted (`DirectModeOutsideInbox`, §10.2), because the Ethereum sender behind an event is whoever sent the transaction that reached the emitting contract, so any contract a user calls could otherwise register that user's address under someone else's keys. No sender claimed inside PCASH bytes or in a submission RPC request supplies this authority. The Ethereum transaction authenticates the complete carrier, including the account fields, PCASH chain ID, recent block, and deadline. A direct creation therefore registers whoever sends the carrier. A poster that carries another party's direct creation creates an account at the poster's own address under that party's nullifier-key commitment, rule set, and receive key. Only that party's rules can update it, and check 3 then refuses any other creation there. Another party's creation is carried in signed mode.

**Signed mode** (`authorizationMode = 1`) requires exactly `r (32) ‖ s (32) ‖ yParity (1)` as `authorizationBytes`; a `yParity` other than `0` or `1` is non-admitted (`UnknownYParity`). Any carrier may deliver it, so the registering address needs no ETH. The signature is over §12.1's exact domain and primary type, with `pcashChainId = PCASH_CHAIN_ID` (§10.1), `nullifierKeyCommitment` from the account body, and `receiveKeyHash` set to the account's receive-key digest (§5.1) as a canonical 32-byte big-endian word: `poseidonBytes(RECEIVE_KEY_HASH_DOMAIN, receiveKeyBytes)` for `PRESENT`, else zero. The account address is the recovered signer (§12.1).

Other modes are structurally undecodable (`UnknownAuthorizationMode`); missing or extra authorization bytes are `Truncated` or `TrailingBytes`. A direct creation never falls back to signature recovery, and a signed creation never falls back to Ethereum sender authorization.

**Checks,** in order (§10.5):

1. Authorization. Direct mode: the address is the Inbox transaction's sender, and this step cannot fail. Signed mode: the signature satisfies §12.1's scalar ranges and recovers a signer, which is the address (`InvalidAccountSignature`, covering invalid scalar ranges, high `s`, and failed recovery).
2. `nullifierKeyCommitment < p` and `ruleSetCommitment < p` (`NonCanonicalAccountField`).
3. No account exists at the address (`AccountAlreadyExists`).
4. The recent block is canonical and in the recent window (`RecentPcashBlockNotInWindow`).
5. The candidate block's timestamp does not exceed `validUntilTimestamp` (`Expired`).
6. Account capacity (`AccountCapacity`).

Checks 4 and 5 together bound how long these bytes can succeed: until the earlier of `validUntilTimestamp` and the end of the recent block's window.

Check 2 accepts every canonical `nullifierKeyCommitment`. A commitment with no known opening, such as zero, creates an account that no kernel can authenticate, so nothing can spend its notes or update it; committing a root it holds is the creating wallet's job.

**Effects.** Consensus derives `accountRevision = 1`; it is neither serialized nor signed. On success, assign the next 40-bit `accountIndex` and atomically write the complete account state row, the account state commitment, and the address-to-index mapping. Raw receive-key publication material is not part of intrinsic state.

Creation cannot update an existing account. Neither authorization mode grants any authority after creation: later actions must satisfy the installed rule set.

### 12.3 User-account update (`txType 0x03`)

An update may replace a user account's rule set, its receive key, or both; an update that changes neither is valid and only increments the revision. It is authorized by one of the account's current rules and pays its own fee from the account's notes, so any relayer can include it. The account's address is public in the payload.

**Payload.** The proposed mutable account fields:

```text
address (20) ‖ newRuleSetCommitment (32) ‖ receiveKeyOperation (u8) ‖ receiveKeyBytes
```

followed by `accountUpdateCommitment (32) ‖ privateValueSection`. The section is the 31,609-byte S fee section of §10.3, so an update is 31,699 bytes, or 32,883 with a `REPLACE` key.

**Receive-key operations.** The operation encodings are defined in §10.2:

* `KEEP` copies the current digest.
* `CLEAR` requires the current digest to be nonzero and sets it to zero; otherwise it fails with `ClearWithoutReceiveKey`.
* `REPLACE` derives the receive-key digest of its key (§5.1) and requires it to differ from the current digest; otherwise it fails with `ReplaceWithIdenticalReceiveKey`.

Consequently, a transition that leaves the receive-key state unchanged has exactly one canonical encoding: `KEEP`.

**Fee section.** The private-value section is the update's fee payment (§13):

* every input slot is a `NATIVE` note owned by the updated account, or `DUMMY`;
* every output slot is `DUMMY` except an optional ordinary private `NATIVE` relay output and at most one `NATIVE` change note returning to the account's address;
* `assetBurnAmount = 0`, and `sum(native inputs) = openFeeAmount + privateRelayAmount + changeAmount`.

A zero fee with every slot dummy is valid. The proof has the nineteen private-value inputs of §11.2 (profile S), followed by `accountUpdateCommitment` at position `19`. The attachment commitment is zero and the kernel enforces that constraint; type `0x03` carries no attachment. Position `0` is the chain ID word, and the recent block and deadline are the section’s own words.

**The account update commitment.** At the transaction's exact sequential processing position, consensus reads the immutable `nullifierKeyCommitment` and `currentAccountRevision` from the live row, derives `newAccountRevision = currentAccountRevision + 1` without overflow, and derives the live current and proposed leaves:

```text
currentAccountStateCommitment = accountStateCommitment(address, nullifierKeyCommitment, currentRuleSetCommitment, USER,
                               currentAccountRevision, currentReceiveKeyHash)
newAccountStateCommitment     = accountStateCommitment(address, nullifierKeyCommitment, newRuleSetCommitment, USER,
                               newAccountRevision, newReceiveKeyHash)

accountUpdateCommitment = poseidon(
    ACCOUNT_UPDATE_COMMITMENT_DOMAIN,
    currentAccountStateCommitment,
    newAccountStateCommitment)
```

The installed rule approves the transition and its fee together, through the update's action commitment (§8.3), which carries the account update commitment as its extra data:

```text
accountUpdateActionCommitment = poseidon(
    ACCOUNT_UPDATE_ACTION_DOMAIN,
    pcashChainId,
    privateValueCommitment,
    accountUpdateCommitment)
```

where `privateValueCommitment` is the private-value commitment (§11.3) of the section. The account update commitment binds the transition alone, so consensus can recompute it from live state. It is serialized anyway so that the proof's statement is fixed by the transaction bytes and the named recent block: nodes verify update proofs before execution, as they do every other proof, and execution only compares. Both leaves commit the address, and the revision in the current leaf advances with every successful update, so the commitment names one account at one revision. The action commitment binds it to this chain and to the exact fee payment, including its time bounds and required carrier context, so one authorization cannot be reattached to different notes, a different fee, a different change note, or another PCASH chain.

**The update kernel.** The account-update kernel:

1. takes the account's `nkRoot` and derives `nullifierKeyCommitment` from it;
2. privately reconstructs the current account leaf, takes the proposed leaf as a witness, and computes the public account update commitment from both; consensus compares that commitment with its own derivation from live state, which fixes the proposed leaf and its successor revision;
3. opens the recent block's state root and output root;
4. proves every `NATIVE` input's membership and canonical nullifier under the account's note key, and enforces the change and conservation rules above;
5. proves a rule entry (§5.2) against `currentRuleSetCommitment`, and requires the canonical MegaApp VK hash to equal that entry's `applicationVkHash`;
6. links the rule's application, and requires its rule statement (§8.2) to equal `[authorizationCommitment(address, configurationCommitment), accountUpdateActionCommitment, recentPcashBlockHash, eventEntry]`.

The change note's secret is a free kernel witness; the authorizing rule binds whichever opening it approved.

**Execution.** Execution MUST validate the receive-key operation against the live current receive-key state, derive the resulting account state row, and reconstruct the account update commitment from the exact live row and the exact proposed rule set and receive-key operation, including earlier successful transactions in the same block, then require equality with the serialized proof input. The account update commitment binds the complete resulting account transition rather than the operation byte; the `CLEAR` and `REPLACE` preconditions make the operation encoding canonical.

**Checks,** in order (§10.5):

1. Every section word and the appended `accountUpdateCommitment` is canonical (`PublicInputNotInField`).
2. `newRuleSetCommitment < p` (`NonCanonicalAccountField`).
3. The recent block is in the window (`RecentPcashBlockNotInWindow`), then the deadline has not passed (`Expired`), then `notBeforeTimestamp` has been reached (`NotYetValid`), then the carrier context condition holds (`CarrierContextMismatch`) (§10.6).
4. An account exists at the address (`AccountNotFound`), and it is a user account (`WrongAccountKind`).
5. `currentAccountRevision + 1` fits in `u32` (`AccountRevisionExhausted`).
6. The receive-key operation's state precondition holds (`ClearWithoutReceiveKey`, then `ReplaceWithIdenticalReceiveKey`).
7. The reconstructed `accountUpdateCommitment` equals the serialized one (`AccountUpdateCommitmentMismatch`).
8. The section's nullifier and capacity checks, as in §11.2 step 7, then proof verification against the account-update hiding-kernel VK of §16 (`ProofRejected`).

**Effects.** On success, atomically mark the section's four nullifiers, record its fee, and append its five output commitments exactly as a private-value transaction does (§11.2), and replace the canonical row and account state commitment. On failure the transaction has no effect.

Validation MUST NOT reject duplicate `nullifierKeyCommitment` values across addresses.

### 12.4 Contract-account creation (`txType 0x02`)

A contract account is a keyless account whose kind is committed in its account state (`accountKind == 1`), whose address derives from its contents, and which consensus never updates. It exposes an immutable set of functions, each one account-rule entry (§5.2). Calling a function means folding that entry's application into the active protocol kernel, which authenticates the exact action and the account's contribution. There is no node-executed contract code and no contract storage. Notes owned by a contract are spendable only through one of its committed functions.

Contract creation is unsigned and proof-free. Its full contents are published in Ethereum data. Those contents determine its identity, and publishing them grants no authority over the account. Whoever posts it pays Ethereum gas; it pays no PCASH fee and earns no issuance. A recent block and deadline bound these exact bytes. To combine publication with a paying value action, attach the body under §11.2.

**Payload.**

```text
txPayload = recentPcashBlockHash (32) ‖ validUntilTimestamp (u64) ‖ body
```

The body starts at byte offset `45` of `txBytes`. No signature or proof follows it.

**Body.**

```text
publishesNkRoot (u8) ‖ nullifierKeyMaterial (32) ‖
receiveKeyMode (u8) ‖ receiveKeyBytes ‖
functionCount (u8) ‖
functionCount × { selector (u8) ‖ applicationVkHash (32) ‖ configurationCommitment (32) }
```

`receiveKeyBytes` is `ML_KEM768_PUBLIC_KEY_LEN` bytes for `PRESENT` and empty for `ABSENT` (§10.2).

**Nullifier-key publication.** The body carries exactly one representation of the account's nullifier-key material, selected by `publishesNkRoot`; a flag other than `0` or `1` is non-admitted (`UnknownPublishesNkRootFlag`, §10.2):

```text
publishesNkRoot = 0:  nullifierKeyMaterial = nullifierKeyCommitment
publishesNkRoot = 1:  nullifierKeyMaterial = nkRoot
                      nullifierKeyCommitment = poseidon(NULLIFIER_KEY_COMMITMENT_DOMAIN, nkRoot)
```

* A **private contract** (`publishesNkRoot = 0`) carries `nullifierKeyCommitment` and does not reveal `nkRoot`.
* A **published-root contract** (`publishesNkRoot = 1`) carries its `nkRoot`, and the commitment is derived from it. Publishing the root lets any party that knows one of the contract's note openings derive that note's nullifier, so parties other than the creator can spend the contract's notes whenever one of its functions authorizes it.

A contract body never carries both, so it cannot encode an `nkRoot` and a `nullifierKeyCommitment` that disagree. `publishesNkRoot` is an immutable part of the contract's identity because it is encoded in the body and in the contract-address preimage. It is not a separate account-state-commitment operand; the address already binds it.

A function entry is exactly 65 bytes. At the maximum count of 255, the largest body is 17,794 bytes. A complete standalone creation is `80 + 65 × functionCount` bytes without a receive key, or 1,184 bytes more with one, for a maximum of 17,839 bytes.

**Function set.** `functionSetCommitment` is derived from the complete canonical function list rather than serialized beside it:

```text
contractFunctionCommitment_i = poseidon(ACCOUNT_RULE_ENTRY_DOMAIN, applicationVkHash_i, configurationCommitment_i, 0)
functionSetCommitment        = depth-8 sparse root over (selector_i -> contractFunctionCommitment_i)
```

A contract function is an ordinary account-rule entry (§5.2) whose `commitmentBlinder` is the canonical `0`: a contract's entries are published in full, so a published per-function blinder would hide nothing, and distinct deployments already differ through `nullifierKeyCommitment`, which the address preimage binds. The selector is the entry's position in the depth-8 rule-set tree, not a hash-derived selector. It remains private when the function is called, because the function opening and application VK are kernel witnesses.

**Address derivation.**

```text
contractPreimage = poseidon(CONTRACT_ADDRESS_DOMAIN, nullifierKeyCommitment, functionSetCommitment, receiveKeyHash, publishesNkRoot)
address          = uint160(contractPreimage)    // low 160 bits of the canonical integer
```

`receiveKeyHash` is the receive-key digest of §5.1, zero without a receive key. A contract address therefore binds `nullifierKeyCommitment`, the derived `functionSetCommitment`, the receive-key digest, and `publishesNkRoot`. The standalone recent block and deadline are not address operands. Repeated standalone creation is rejected; an attachment may reuse the exact existing immutable row (§11.2). An application that needs a distinct instance must use a distinct `nkRoot` or a distinct committed function configuration. An ECDSA key that happens to correspond to a contract address authorizes nothing, because every consumed note authenticates an installed account rule (§11.5) and contract accounts reject all writes.

**Competing creations.** Anyone may publish the same body with fresh time bounds. The first successful standalone creation inserts it; a later standalone creation fails with `ContractAddressExists`. Attached creations instead ensure the exact immutable account exists (§11.2).

**Checks,** in order (§10.5):

1. `nullifierKeyMaterial < p`; then, for each function in body order, `applicationVkHash_i < p` and `configurationCommitment_i < p` (`NonCanonicalContractField`). Zero is allowed for a function’s hash and configuration.
2. Derive the nullifier-key commitment from the selected material. Every canonical material is accepted; a private commitment with no known opening cannot act.
3. Require a nonempty function set (`EmptyContractFunctionSet`), then strictly increasing selectors in body order (`SelectorsNotStrictlyIncreasing`).
4. Derive the function-set commitment from the complete list, then the contract address and account state commitment.
5. Require no account at that address (`ContractAddressExists`), then spare account capacity (`AccountCapacity`).
6. Require the recent block canonical and within the recent window (`RecentPcashBlockNotInWindow`), then require the deadline not passed (`Expired`).

**Effects.** On success, assign the next 40-bit account index and atomically write the kind-CONTRACT, revision-1 row, its leaf, and its address-to-index mapping. It has no nullifier, output, fee, or issuance effects. The raw body and receive key remain in Ethereum data. Failure writes nothing.

## 13. Fees, Relay Payments, and Issuance Destinations

A transaction reaches Ethereum only if someone posts it and pays the Ethereum gas. PCASH gives transactions two ways to pay whoever does that, and, because successful type `0x00` transactions earn issuance, a way to say where that issuance goes.

Every private-value transaction and user-account update declares `openFeeAmount` in its proof-bound private-value section, and a private-value transaction also declares `issuanceOwnerCommitment`.

**Open fee.** `openFeeAmount` is existing native PCASH offered publicly to the poster of the batch that successfully includes the action, identified by the batch's `posterOwnerCommitment` (§9.3). Native conservation is `sum(native inputs) = sum(ordinary native outputs) + openFeeAmount`. Issuance is created only at settlement, after the transaction, so it can never fund the same action's inputs or outputs.

**Private relay payment.** A wallet may also, or instead, pay a selected relayer with an ordinary encrypted output. Consensus sees only an ordinary output, so the payment can be in any asset the transaction carries; a native one is included in the ordinary-output sum above. It has no public fee classification. Consensus does not compare a real output's owner commitment with `issuanceOwnerCommitment` (§11.3). An output that reuses the issuance commitment remains a separate note, but its owner commitment links it to the public payout; by wallet convention every output's owner commitment, a relay payment's included, is fresh and independent of the issuance commitment (Appendix B.2).

**Issuance destination.** For a qualifying type `0x00` action:

* `issuanceOwnerCommitment = 0` sends issuance to the successful poster (the **open route**);
* a nonzero value sends issuance to that exact one-time owner commitment (the **designated route**). The destination is proof-bound, so copying the transaction into another batch cannot redirect it.

The open fee and open-route issuance are a public offer to whoever successfully includes the transaction, as an Ethereum priority fee goes to whoever builds the block, so a transaction can be broadcast without first arranging a relayer. Copying it into another batch never changes its inputs, outputs, fee, private relay payment, or designated destination, which its proof fixes; it changes only which poster collects its open fee and open-route issuance, which is competition among posters, not a loss to the sender. A sender that wants a particular party paid uses a private relay payment or the designated route.

A nonzero issuance commitment requires `openFeeAmount = 0`, and a positive open fee requires a zero issuance commitment. `openFeeAmount = 0` with a zero issuance commitment is valid and leaves issuance open to the poster. The proof enforces these rules (§11.2); nodes do not check them separately. User-account updates earn no issuance: their section omits the issuance word and derivation supplies zero (§10.3). Standalone user-account and contract-account creation have neither a mandatory nor an optional PCASH fee, and earn no issuance.

The open fee and issuance settle into separate native notes (§14.3). A selected relayer is paid from an ordinary output and may separately receive issuance through the designated commitment on an eligible action. Self-publication uses a zero open fee and no relay-payment output, and an eligible action may designate the wallet's own one-time issuance commitment.

**Who pays.** A user-account update spends the updated account's own notes (§12.3). Standalone contract creation pays no PCASH fee (§12.4); an attached creation shares the carrying value transaction’s fee and outcome. Subsequent contract actions may pay from contract-owned native notes without any user initiator. The two-account sponsorship relation (§11.7) bounds the sponsor's contribution to the open fee, one exact ordinary relay output, and the sponsor's change, without granting authority over the primary account's value.

## 14. Native Issuance and Block Settlement

All native PCASH goes to the people who use the network; there is no premine, allocation, or sale. Issuance helps pay for the costly part of using PCASH: every transaction has to be posted to Ethereum, which costs gas. A qualifying action's issuance goes either to whoever posts it, on the open route, so relaying other people's transactions pays, or to a destination the transaction names, where it offsets its sender's own cost of posting (§13).

Issuance does not depend on whether an action moves value, because consensus cannot tell: amounts and recipients are private. This is not a loss. An action that spends nothing has the same public form as any other zero-fee action of its profile (§11.4), so it adds to the cover real payments hide among, and it lets a newcomer, who holds nothing, earn their first PCASH. Mining does not crowd out payments: PCASH blocks have no transaction limit of their own, a block's issuance is capped however many actions share it, and a payment earns the same share.

Native PCASH is created only when a block is settled, as the issuance component of system payout notes (§14.3). Issuance follows a declining supply curve. A controller raises or lowers the per-transaction offer according to whether issuance is behind or ahead of that curve, and each block splits its issuance equally among its successful qualifying transactions. The per-block computation has three stages: a **block quote** computed from the parent state before any transaction executes (§14.1), a **capacity reservation** as each transaction executes (§14.3), and **settlement** after the last transaction (§14.2–14.3).

**Constants.** In this section, `S` is the supply cap, `I` is gross issuance, and `p(·)` is reference progress; they are unrelated to profile S, the input count `I`, and the field modulus `p`. Let:

* `S = 1,000,000,000 × 10^18` atomic units, the gross supply cap;
* `T = 365 × 86,400` seconds, the curve's reference duration;
* `tau = 12` seconds, the reference interval between qualifying actions;
* `H = 2 × 86,400` seconds, the controller's response half-life;
* `k = 3`, the maximum issuance speed: a block's allowance is `k` times the baseline;
* `Q = 2^128`, the fixed-point scale.

The initial lag is `0` (the initial state's `lagQ`, §7.7), so issuance starts at the reference pace with multiplier `1`. The maximum remembered positive lag is `LQ = 4 days × Q`, two half-lives, so the multiplier never exceeds `4`. There is no registration grant, issuance balance, entitlement tree, separate native spending representation, calendar deadline, or saved allowance from an empty or underfilled block.

**Qualification.** Only successful type `0x00` actions qualify, once per action, in either profile. Qualification counts actions, not participants, and does not depend on whether an action moves value: publicly callable contracts may authorize repeated qualifying actions. Standalone creations, updates, folded applications, failed actions, and system notes do not qualify. An attachment adds no share to its carrying type `0x00` action. A qualifying action's issuance goes to its issuance destination (§13), independently of any ordinary private relay output, and the action remains valid when its actual issuance is zero.

### 14.1 The block quote

The block quote is computed once per block, before any of its transactions execute, from the parent state (`I = issuedSoFar` and `lagQ`, §6.5) and the block's elapsed time. For block `0`, elapsed time is zero. For each later block, `elapsed = timestamp - parentTimestamp`; a timestamp regression is invalid and halts derivation.

**Exhausted supply.** If `I = S`, issuance has ended. The quote is all zero: baseline, offer, allowance, and `oneActionMax` are `0`, `rewardEach` will be `0`, and the next state keeps `issuedSoFar = S` and the parent's `lagQ` unchanged. Elapsed time is not added to the lag and no exponent is evaluated. The rest of §14.1 and §14.2 does not apply. Exhaustion is declared only at `I = S`.

**Supply curve.** Otherwise `I < S`. The equivalent reference progress is `p(I) = T × (1 - sqrt(1 - I/S))`, and the corresponding ideal curve is `I(p) = S × (2p/T - (p/T)^2)`. `T` shapes the declining baseline. It is not an expiry, nor a guarantee that issuance completes in one year. Consensus evaluates the curve with exact integer intermediates and Q128 outputs:

```text
q          = isqrt(floor((S - I) × Q² / S))
progressQ  = T × (Q - q)
baselineQ  = floor(2 × S × tau × q / T)
allowanceQ = k × baselineQ
```

At `I = S`, `q = 0` and `progressQ = T × Q`. The square-root floor rounds the baseline down and progress up. The same `progressQ` function is used before and after settlement, so progress differences telescope.

**Lag.** `lagQ` measures, in Q128 seconds, how far issuance is behind (positive) or ahead of (negative) the reference pace. The parent state stores the signed post-settlement `lagQ`. Before computing the offer, set:

```text
offerLagQ = min(LQ, lagQ + elapsed × Q)
```

This clamp discards excess positive delay from authenticated state. There is no negative-lag clamp. A missed Ethereum slot advances lag by its elapsed seconds but does not multiply the block allowance.

**Offer.** If `offerLagQ < -128 × H × Q`, set `multiplierQ = 0`. This cutoff is applied before the exponent is quantized. Otherwise evaluate, in exact integers:

```text
expQ16      = trunc(offerLagQ × 65536 / (H × Q))      # toward zero
shift       = floor(expQ16 / 65536)
frac        = expQ16 - shift × 65536                  # 0 <= frac < 65536
factorQ16   = ((195766423245049 × frac + 971821376 × frac² + 5127 × frac³ + 2^47) >> 48) + 65536
scaled      = shift < 0 ? (Q × factorQ16) >> -shift : (Q × factorQ16) << shift
multiplierQ = scaled >> 16
offerQ      = floor(baselineQ × multiplierQ / Q)
```

`multiplierQ` approximates `Q × 2^(offerLagQ / (H × Q))`. The exponent is quantized to 1/65536 of a half-life (2.63671875 seconds) by truncation toward zero, and `factorQ16` approximates `65536 × 2^(frac / 65536)` with the cubic of Bitcoin Cash's `aserti3-2d` difficulty algorithm, whose coefficients, rounding constant, and operation order are unchanged. Whole half-lives are exact: `offerLagQ = j × H × Q` gives `multiplierQ = 2^j × Q` for `-128 ≤ j ≤ 2`, so the initial lag gives exactly `Q`. Against `2^(offerLagQ / (H × Q))` the relative error before the final floor is below 0.013%. The cutoff and the `LQ` clamp keep `-128 ≤ shift ≤ 2`, and the right shifts floor nonnegative values. `factorQ16 < 2 × 65536` for every `frac`, so `multiplierQ ≤ 4 × Q`, with equality only at `offerLagQ = LQ`. The polynomial exceeds the signed 64-bit range before its shift; no operation may wrap.

At the underflow boundary, `offerLagQ = -128 × H × Q` evaluates normally to `multiplierQ = 1`. A zero encoded offer is not terminal: elapsed time can raise the lag and restore a positive offer.

**One-action maximum.** The most any single action could earn in this block, if it were the only qualifying action, is:

```text
oneActionMax = min(floor(offerQ / Q), floor(allowanceQ / Q), S - I)
```

Issuance is **active** in the block when `oneActionMax > 0`. This predicate decides capacity reservations (§14.3) and does not depend on how many actions eventually qualify.

### 14.2 Complete-block equal settlement

After all of the block's transactions have executed, let `n` be the count of successful qualifying actions. The count does not change the quote. For `n > 0`, every qualifying action receives the same integer-atomic issuance:

```text
rewardEach = min(floor(offerQ / Q), floor(allowanceQ / (n × Q)), floor((S - I) / n))
nextIssued = I + n × rewardEach
nextLagQ   = offerLagQ - (progressQ(nextIssued) - progressQ(I))
```

For `n = 0`, issuance is zero and `nextLagQ = offerLagQ`. The block's post-settlement state is `issuedSoFar = nextIssued` and `lagQ = nextLagQ`, except in the exhausted case of §14.1.

The following are consequences of these formulas, not additional rules:

* Division remainders stay unissued. There is no transaction-order remainder recipient, final sweep, or allowance carry-over.
* If fewer than `n` atomic units remain, `rewardEach = 0` and the entire block pays zero; a later block with fewer qualifying actions may consume the remainder. Such a block is not exhausted, so its lag still advances by elapsed time.
* With several qualifying actions, the allowance and the remaining supply are divided equally, so actual issuance can be below both the internal offer and `oneActionMax`. Sparse or uneconomic participation can extend distribution indefinitely.
* Fees and burns do not change gross issuance. Spent, unspent, lost, and burned issuance all remain included in it.

### 14.3 Capacity reservation and payout order

Settlement appends payout notes after all of the block's ordinary outputs, and it must never fail for lack of output-tree space. So each transaction with a private-value section reserves, before it may succeed, room for every payout note it could cause.

**One note per payout.** Every system payout fits in one ordinary note. A fee payout is at most the block's successful open fees `F`, and an issuance payout is at most its new issuance `M`. Native conservation gives `F <= I`, and settlement gives `M <= S - I` (§14.2), so every payout is at most `S < 2^128`.

**Reservation.** At the start of each block:

```text
nextOutputIndex     = parent outputCount
pendingPayoutSlots  = 0
postersWithOpenFees = {}        // posterOwnerCommitments with a successful positive open fee, across all batches
```

For each transaction with a private-value section (types `0x00` and `0x03`), at the `OutputCapacity` step of its check order (§11.2, §12.3, §12.4), with `O` its output count, `f` its `openFeeAmount`, and `C` the `posterOwnerCommitment` of its batch:

```text
feeSlot = 1 if f > 0 and C is not in postersWithOpenFees, else 0
issSlot = 1 if the transaction is type 0x00 and issuance is active (§14.1), else 0
require nextOutputIndex + O + pendingPayoutSlots + feeSlot + issSlot <= 2^40
        // otherwise the outcome is OutputCapacity
```

A zero-fee type `0x00` transaction still reserves `issSlot`; zero-fee type `0x03` transactions reserve nothing beyond their outputs. A poster's fee note is reserved once per block by its first successful positive fee, whatever the fee's size. The reservation state changes only if the transaction succeeds:

```text
pendingPayoutSlots += feeSlot + issSlot
if f > 0: add C to postersWithOpenFees
nextOutputIndex    += O          // the transaction's ordinary outputs are appended now
```

A transaction that fails for capacity is not reconsidered, even when settlement ends up using fewer notes than were reserved.

**Settlement.** After the block's transactions have executed, compute `rewardEach` (§14.2) once and append the system payouts, in this order:

```text
// 1. Designated issuance, one payout per action, in transaction order.
for each successful type 0x00 transaction t, in block order:
    if t.issuanceOwnerCommitment != 0:
        appendPayout(t.issuanceOwnerCommitment, openFee = 0, issuance = rewardEach)

// 2. Poster groups: open fees, plus open-route issuance, per poster commitment.
for each successful transaction t with a private-value section, in block order:
    C = posterOwnerCommitment of t's batch
    group[C].openFee  += t.openFeeAmount
    if t is type 0x00 and t.issuanceOwnerCommitment == 0:
        group[C].issuance += rewardEach
    // a group's position is the first t that adds a positive amount to it
for each group (C, openFee, issuance), in position order:
    appendPayout(C, openFee, issuance = 0)
    appendPayout(C, openFee = 0, issuance)

appendPayout(C, openFee, issuance):
    A = openFee + issuance
    if A == 0: append nothing
    otherwise append one ordinary native note of amount A owned by C (§15), at nextOutputIndex
```

The open fee transfers existing PCASH; issuance creates new PCASH. Matching poster commitments aggregate across every batch in the block; distinct commitments and distinct PCASH blocks never aggregate. Each payout's result has exactly one nonzero component, open fee or issuance (§7.3). Gross issuance advances by exactly `n × rewardEach`. A system note has a payout result rather than a transaction result, and earns no issuance.

### 14.4 Atomic commit

Commit output leaves, nullifiers, account changes, gross issuance, post-settlement lag, ordered payouts, and canonical block history atomically. A verifier or infrastructure failure aborts derivation rather than omitting payouts or changing the accepted set. A proof opens new system notes and newly registered accounts only beneath a committed block, so from the next block on (§10.6). An account update reads the live row instead (§12.3), so it can act on an account created earlier in the same block.

## 15. System Payout Notes and Recovery

A system payout note contains either issuance or fees. Settlement creates designated issuance notes and separate fee and issuance notes for each poster group, skipping zero amounts (§14.3). For every positive system payout amount `A`, canonical owner commitment `C`, and assigned output index `j`, construct:

```text
body = poseidon(NOTE_BODY_COMMITMENT_DOMAIN, C, 0, A)
output = poseidon(OUTPUT_COMMITMENT_DOMAIN, body, j)
```

`C` is the action's `issuanceOwnerCommitment` for a designated payout, or the batch's `posterOwnerCommitment` for a poster payout. The payout's result commits `j`, `C`, and the open-fee and issuance components of `A` (§7.3). The note is spent with the ordinary rules: owner opening, account authorization, membership, amount bounds, and note nullifier. There is no system-note flag and no separate spending relation. The amount and system origin are public; the owner is hidden behind its secret-opening commitment. Distinct output indices distinguish otherwise identical payouts. Each designated issuance produces its own payout. Poster payouts aggregate per poster commitment across the complete block (§14.3), with separate fee and issuance notes, in that order, skipping zero amounts.

A payout note carries no encrypted output data, so its owner must be able to find it and reconstruct its opening another way. Appendix B.2 gives the reference wallet's conventions for doing that from a seed; Appendix B.3 gives the records a node keeps so that such recovery works.

## 16. Proof-System Release

These pins fix the proof system used in consensus verification (§8.1). Every other protocol parameter is stated in the section that uses it.

| Transaction | Protocol kernels | Hiding-kernel VK | Posted proof bytes |
|---|---|---|---:|
| `0x00`, profile S | transfer, sponsored transfer, and asset creation (§11.5) | `private_value_hiding_kernel` | 22,432 |
| `0x00`, profile L | the same three, compiled for L | `private_value_large_hiding_kernel` | 22,432 |
| `0x03` | user-account update (§12.3) | `user_account_update_hiding_kernel` | 22,432 |

The posted proof body length excludes the statement words, includes the 28 accumulator words (§8.1), and is a framing rule: a private-value section carries exactly this many proof bytes with no length prefix, so the length fixes where the output data begins (§10.3).

The pinned implementation's databus link compares a folded circuit's `return_data` with the folding circuit's `call_data` bus after zero-padding the shorter of the two. Each kernel reads a fixed number of statement words (§8.2, §8.6), so the link still fixes every word it reads: an application that returns fewer words supplies zeros for the rest, and one that returns more must return zeros beyond them.

A hiding-kernel VK is 119 field elements (§8.1). Its pin is the SHA-256 of those elements as consecutive 32-byte big-endian words, 3,808 bytes.

| Pin | Value |
|---|---|
| Barretenberg release | `6.0.0` |
| BN254 `[x]_2` element compiled into the verifier, SHA-256 | `0x01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f` |
| Grumpkin SRS, first 65,536 points, SHA-256 | `0x64236c9455e75aeea77a94587ea607eed2e978d2609a421d66bf10bb9698b8fd` |
| `private_value_hiding_kernel` VK, SHA-256 | `0x233b24d3cc6c6dcb3e8b3d8f7fb9c6165b7705a2580ddacfc3ad4de86f95c34a` |
| `private_value_large_hiding_kernel` VK, SHA-256 | `0x1319d52ee651bed3c6b0f001b911ee728531ce20ed8330ab52536d3f987932b2` |
| `user_account_update_hiding_kernel` VK, SHA-256 | `0x7282e43fa375e939eae95c9f17b61b3bb21a641fff208d9028abc627c67a1bd6` |

## 17. Conformance Vectors

The reference implementation publishes the Poseidon2 matrices and round constants of §2.3 in the parameter file `poseidon2_bn254_t4_rf8_rp56.json`, among its parameter files rather than with the vectors. Its SHA-256 is `0x582dce05c2b672bebbd27eb99c748bb1ec02eeb64b57e496bca9fc07193898f5`.

The protocol conformance vectors, published with the reference implementation, are these files:

* `poseidon2_vectors.json`: the field modulus, hash parameters, the empty-input case, single- and multi-chunk known answers, and byte-string hashes on both sides of the 16-byte chunk boundaries, for §2.3.
* `merkle_vectors.json`: the empty ladder and roots, plus worked least-significant-bit-first membership examples for §2.4.
* `blob_codec.json`: blob counts and per-blob SHA-256 digests of canonical blob encodings at boundary payload lengths, for §9.2.
* `issuance.json`: exact curve, lag, and settlement transitions, exponent quantization boundaries, rounding boundaries, saturation, terminal state, and dust (§14).
* `protocol_vectors.json`: chain-neutral note and dummy nullifiers; the private-value commitment; standard asset identity, creation, and transfer; authorization commitments; the action commitment of each action domain; the account update commitment and its complete unified account-state-commitment operands; account state commitments without a receive key and with the digest of an exact receive key; the output-data hash of an exact item, the hash of an exact arena, and the delivery commitment over them; reference output-note-secret derivation; designated-issuance and poster recovery; the nullifier tree; account-rule entries; the genesis parent hash; Ethereum and PCASH history leaves and trees, with an Ethereum block hash above `p`; carrier context hashes of an Inbox sender and of carrier events with contexts on both sides of the eight-chunk minimum; a transaction ID; transaction statements, transaction and payout result leaves, and the transaction-results root; typed StateRoot and header openings; the block hash; and contract-address derivation.
* `account_sections/`: attached contract creation and user-account update wire examples, with nineteen- and twenty-word statements respectively. Both include the derived delivery commitment and zero issuance; the attached creation commits its tagged body, while the update supplies a zero attachment commitment and appends its update commitment. Proofs and delivery data are placeholders for decoding and statement reconstruction.

JSON is only a transport and display container; no commitment consumes JSON bytes. `genesisHash` is derived from canonical block `0` and binds the network configuration (§7.7). Example-rule and reference-implementation vectors are documented with their respective components and are not protocol conformance vectors.

## Appendix A. Monetary Trust Resets

This appendix is a cross-version continuity criterion, not an Aster state transition. It defines when a later protocol may claim canonical monetary continuity with this chain after it stops trusting a predecessor proof system. Nodes implementing this specification evaluate nothing in it.

A fork declares a **monetary trust reset** when it no longer treats predecessor proofs as sufficient evidence that private value was created, conserved, spent, or authorized correctly. A fork without a reset carries value forward under its ordinary rules; a change of format, verifier, implementation, or parameter does not by itself require one. Let `H` be the final block of the distrusted generation. Blocks after `H` are re-derived under successor rules, so orphaned notes, payouts, and account effects are excluded. Account actions replay only when their authorization and recent-state requirements hold under successor rules.

**Establishing predecessor value.** A successor that recognizes predecessor value as native PCASH MUST independently establish, under the source generation's fixed historical interpretation:

* the commitment opening;
* authenticated membership in the applicable historical state;
* the asset identity and amount;
* ownership and a successor-recognized authorization relation;
* the canonical nullifier;
* that the nullifier was consumed neither at the recovery basis nor by an earlier successor claim.

The fork selects one recovery basis `B <= H` for native PCASH. Terminal recovery uses `B = H`. Snapshot recovery uses an earlier `B` at which native state is still trusted, admits only outputs present and unspent at `B`, and excludes every later native output and every descendant of a claimed note. Either way, the eligible set is one set and its claims are mutually exclusive. No predecessor proof is sufficient merely because it verified under its historical verifier. Historical transaction bytes, commitment and nullifier formulas, account states, and asset identifiers keep exactly their original meanings; a successor MUST NOT reinterpret a historical value to make it admissible. Value controlled by an authorization relation the successor cannot establish MAY remain unavailable.

**Native PCASH.** A successor claiming canonical native continuity MUST bound the aggregate predecessor-native value it admits:

```text
nativeIssuanceEnvelope_H = issuedSoFar_H
legacyNativeDebit       <= nativeIssuanceEnvelope_H
```

`issuedSoFar_H` is the gross issuance counter after block `H` (§6.5, §14). Native PCASH is created only by issuance, and the counter includes every issuance payout, including payouts to actions a distrusted verifier wrongly accepted. Every legitimate predecessor-native note therefore descends from value the counter records, whatever the predecessor proofs did, so the bound depends on no predecessor proof. It does not identify counterfeit notes. Fees do not enlarge the envelope and burns do not reduce it. All recognized predecessor-native notes compete for the same capacity. Capacities from different generations MUST NOT be added: each later reset establishes one fresh envelope through its boundary. Each accepted claim debits at least the net successor-native value it makes spendable, including any successor fee funded by inherited value.

A release MAY temporarily quarantine predecessor-native value, but MUST NOT describe canonical native continuity as completed unless it provides a deterministic, permissionless, trustless predecessor-native claim path. That path MAY reveal the amount charged to the capacity; it MUST NOT require disclosure of the source commitment, source account, claimant, recipient, or unrelated balances. Admitted value is ordinary native PCASH: its later validity MUST NOT depend on which predecessor claim funded it, and it is not subject to a provenance clawback. The envelope provides containment, not restitution. Indistinguishable counterfeit claims may exhaust it before legitimate claims. Incident-specific rules MAY prioritize claims established by independently trustworthy facts, such as membership below a defect boundary, but every admitted amount still counts against the capacity.

**Standard non-native assets.** A nonzero `assetId` is an immutable identity. A successor MUST NOT assign it different semantics, supply, metadata, or ownership history, and MUST NOT recognize predecessor value under an existing nonzero `assetId`; such notes MAY remain quarantined under their original identifier, and migration to a fresh asset is the only continuation path. Any party MAY create a fresh standard asset with a bounded inventory owned by an immutable contract account whose installed application releases that inventory against predecessor-note claims. That application defines its own eligibility criteria, including a basis earlier than `H` and the exclusion of later outputs and their descendants. Its fixed supply bounds its payouts under any criteria, it requires no reset, and it MAY exist within a generation. Each predecessor claim MUST be accepted at most once per such account, and recognizing it grants the predecessor asset no authority over the successor asset. Consensus does not choose which candidate, if any, carries a predecessor asset's identity.

**This protocol.** This protocol needs no generation field, inherited-value counter, asset registry, migration transaction, or state leaf to satisfy this criterion. Indexed note commitments and canonical nullifiers (§4.3), typed terminal state (§6.5), exact retained transaction bytes (§7.8), permanent transaction-type meanings (§3.2), the gross issuance counter (§6.5, §14), and the immutable standard-asset definition (§11.6) supply every predecessor fact above without accepting a predecessor proof.

## Appendix B. Reference Conventions

This appendix is not consensus. No root commits the manifests, records, or wallet derivations it describes, although a payout record determines the values its payout result commits (B.3), and an implementation that keeps different ones derives the same chain. It records the conventions of the reference node and wallet that another implementation needs in order to interoperate with them: what a node retains beside each block, how a wallet derives the owner commitments of payout notes so that a seed recovers them, and how wallets encrypt the output data and arena of a private-value section. Requirement words in this appendix bind an implementation that adopts these conventions. `H(...)` is `poseidon(...)`.

### B.1 Delivery manifests

Every canonical block retains a compact Ethereum delivery manifest for each carrier (§9.1) processed in its Ethereum block. A manifest contains:

* the Ethereum transaction index, hash, and sender; its Ethereum block is the block's L1 origin;
* the carrier type, calldata, blob, or event, with the carrier hash and length and the ordered blob versioned hashes; for a carrier event, the carrier hash and length cover the log's whole data field, and the manifest also holds the log's receipt-local log index, its emitter, and, when its data decodes, its context bytes;
* the batch-level exclusion reason, if any;
* each established item boundary, with its `batchItemIndex`, content hash, and optional exclusion reason; an item without an exclusion reason is admitted;
* for every validly framed batch, additionally the poster owner commitment and the explicit poster context (§9.3).

A log whose only topic is the carrier-event topic is a carrier and gets a manifest even when it is ignored: if its data is not the canonical encoding, or its batch exceeds `MAX_BATCH_BYTES`, the manifest carries a batch-level exclusion reason, exactly as a malformed or oversize Inbox carrier's does (§9.1). A log with that first topic and any other topic count is not a carrier and gets no manifest.

The ordered manifests cover every carrier in the Ethereum block exactly once, in Ethereum transaction order and then carrier order (§9.4), and an item is found by its coordinates `(l1TransactionIndex, batchItemIndex)`. Admitted manifest items are in bijection with the block's `TransactionResult` values: every result has exactly one matching admitted item, no admitted item lacks a result, and no excluded item occupies a result coordinate. A manifest need not retain raw non-admitted bytes once this recovery context is stored. Admitted items refer to the canonical PCASH transaction bodies; original rejected or unparseable bytes remain retrievable only from the identified Ethereum calldata, receipt log, or beacon blob sidecars.

Explanatory exclusion reasons are not committed in the PCASH block header. The manifest is nevertheless mandatory core node history: it is stored and rewound with its canonical block and MUST NOT be reconstructed from a synthetic carrier.

### B.2 Recoverable ownership

Conformance vectors cover these derivations (§17) so that wallets interoperate.

**Designated issuance.** The reference wallet derives a designated issuance destination with these domain-separated derivations, where `address` and `nkRoot` belong to the recipient:

```text
payoutSeed = H(PAYOUT_SEED_DOMAIN, noteNk(nkRoot))
txContext = H(PAYOUT_TX_CONTEXT_DOMAIN, chainId, shapeId, N_IN, N_OUT, nullifier_0, ..., nullifier_(N_IN-1))
issuanceSecret = H(PAYOUT_NOTE_SECRET_DOMAIN, payoutSeed, ISSUANCE_ROLE=3, txContext)
issuanceOwnerCommitment = H(OWNER_COMMITMENT_DOMAIN, uint160(address), issuanceSecret)
```

The reference USER rules require this derivation whenever the signer designates its own address, so a restore from the seed recovers self-designated issuance. The `nkRoot` they use for it, and for owner change under the output secrets below, must open the nullifier-key commitment in their configuration:

```text
configurationCommitment = H(REFERENCE_CONFIGURATION_DOMAIN, domainSeparatorHigh128, domainSeparatorLow128, nullifierKeyCommitment)
```

Reference-rule vectors, not the protocol conformance vectors, cover this commitment. `REFERENCE_CONFIGURATION_DOMAIN` is the domain tag (§2.5) of the context string `configuration`, `domainSeparator` is the EIP-712 domain separator under which the rule verifies signatures, and `nullifierKeyCommitment` is the installing account's (§4.2). Because the rule recomputes that commitment from the root it derives secrets from, a transaction builder cannot substitute another root once the rule is installed. The configuration names no signer: the rule derives the signer's address from the key that verifies the signature and returns it in its authorization commitment (§8.2), and the kernel requires that address to be the account's. The installing wallet commits the account's own `nullifierKeyCommitment`, computed from the `nkRoot` it holds. A rule configured with any other value can be satisfied only under a root that opens that value, so a value whose root the owner does not hold makes the rule unusable, and an account whose installed rules all carry such a value can neither spend nor change its rules.

The transaction context includes the compiled shape and the complete ordered nullifier list. It excludes proof bytes, the final transaction hash, the amount, outputs, the block, and the output index. Re-proving against another recent state therefore preserves recovery as long as the profile and nullifiers stay fixed. Every successful transaction consumes all its input nullifiers, including dummy nullifiers, so the same nullifiers cannot succeed again. Whether one authorization permits multiple distinct transactions is determined by the installed account rule.

**Output secrets.** Reference implicit output secrets bind the same compiled dimensions and every ordered nullifier:

```text
noteSecretSeed = H(IMPLICIT_NOTE_SECRET_SEED_DOMAIN, noteNk(nkRoot))
noteSecret_i = H(TRANSACT_NOTE_SECRET_DOMAIN, noteSecretSeed, shapeId, N_IN, N_OUT,
                 nullifier_0, ..., nullifier_(N_IN-1), i, outputEntropy_i)
```

A note keeps this creation secret when it is spent through another profile; spending does not rederive it using the consuming transaction's profile.

**Selected relayers.** On a designated route, the receiving wallet derives `issuanceSecret` from its own payout seed and the transaction context. After the nullifiers are fixed, a selected relayer supplies an authenticated quote containing: that one-time issuance opening; a separate authenticated private receive destination for an ordinary native fee note; the exact private fee amount; the chain and transaction context; and an expiry. The ordinary fee note uses an independent fresh owner commitment and must never reuse the public `issuanceOwnerCommitment`. The wallet's semantic approval binds the exact private fee note, issuance commitment, transaction context, and expiry. The relayer decrypts its output envelope and recomputes the proof-bound ordinary note commitment before publishing. A different issuance secret for the same identity is a different commitment and requires new approval; changing the nullifiers requires a new quote. Quote authentication happens in the wallet, without a second in-circuit recipient-signature system.

**Open route.** For the open route, the poster chooses `posterContext`, any canonical field element, carries it in the batch header (§9.3), and derives:

```text
posterSecret = H(PAYOUT_NOTE_SECRET_DOMAIN, payoutSeed, POSTER_ROLE=2, posterContext)
posterOwnerCommitment = H(OWNER_COMMITMENT_DOMAIN, uint160(address), posterSecret)
```

The reference poster draws a fresh random context for every batch, so no two of its batches share a commitment. Seed-only recovery reads each context from the node's recovery records (B.3), so the poster does not need to remember or rederive it. A poster that reuses a context makes those batches publicly linkable, including across different inclusion blocks. The context does not have to match the inclusion block, so delayed submissions remain valid and recoverable. The node cannot infer common ownership of different commitments.

Copying a transaction preserves a designated destination, which is proof-bound. An open destination pays the poster of the successful inclusion, whoever that is: if the same transaction appears in two batches, the poster of the batch whose inclusion succeeds first collects its open fee and open-route issuance. A wallet that wants its issuance bound to itself or to a selected relayer uses the designated route.

These are application recovery conventions, not a universal secret derivation for contract keys. A contract rule that designates its issuance route supplies an independent secret or delivery convention; published contract `nkRoot` values cannot supply secret recovery material. Multiple authorizers approve one shared route according to their roles, and a distinct fee sponsor need not own the issuance.

**Creation attachments.** The reference wallet attaches the contract body to every funding chunk, so chunks may arrive in any order. For an attached signed user creation, it uses the value transaction’s recent block and deadline. Reference rules that sign value actions include the attachment commitment in their signed messages. Exact bytes remain the retry unit until expiry or loss of that canonical anchor. Refreshing requires a new creation signature, renewed action approval, and a new proof; the wallet retains the approved payment identity and reconciles prior submission before selecting another spend. On reuse, delivery uses the existing account’s authenticated current receive key rather than treating the creation’s initial key as an update.

### B.3 Canonical recovery records

The node retains designated transaction contexts, explicit batch poster contexts, and ordered payout records, produced by the same settlement pass that creates the payouts. They are discovery material, not another mint authority. Each payout record carries:

* its source, `designatedIssuance` or `posterPayout`;
* its component, `openFee` or `issuance`, and its note amount;
* its owner commitment and output index;
* its recovery contexts.

The tagged component expands to the existing committed pair: `openFee` maps to `(openFeeAmount = amount, issuanceAmount = 0)`, and `issuance` maps to `(openFeeAmount = 0, issuanceAmount = amount)`. That pair, the owner commitment, and the output index are the values the payout's result commits (§7.3); the source and recovery contexts are not committed.

A designated record identifies its source transaction by Ethereum transaction index and batch item index, and retains that transaction's single context. A poster record has no source transaction ID. Each note of a poster group retains the same contributing Ethereum transaction indices and the distinct contexts of all contributing batches in encounter order, including batches whose only contribution is issuance at zero fee. Individual successful fee contributions remain available through batch manifests and transaction records. Untrusted posters can copy a commitment with an unrelated context, so recovery tries every retained context rather than trusting the first.

Canonical blocks, checkpoints, and suffix replacement preserve these records, or sufficient history to rebuild them. A node advertising seed restoration MUST NOT silently prune them; state roots alone do not suffice.

A fresh wallet scans paginated node records, derives candidate commitments from its seed, reconstructs matching ordinary notes, and obtains canonical membership and spentness evidence at a coherent completed boundary. It requires no saved transaction hashes, quote list, plaintext backup, Ethereum connection, or historical blob retrieval. An explicitly lagging index is not an authoritative zero balance. Orphaned discoveries are replaced on reorganization. Recovered notes and notes delivered by encryption share one native inventory. Consolidation uses ordinary private-value transfers of a supported profile when necessary to fit a requested spend, or when explicitly requested by an operator.

### B.4 Delivery

Consensus fixes only the sizes of a section's output-data items and arena and the delivery commitment over them (§10.3). This section gives the reference scheme that fills them. Byte strings are big-endian. `HKDF` is HKDF-SHA-256, and `AEAD` is AES-256-GCM with a 16-byte tag and the all-zero 12-byte nonce: every key below encrypts exactly one plaintext. Labels are ASCII strings.

**Envelopes.** Each output-data item is an envelope that delivers one note opening or a message-only arena pointer to the holder of an ML-KEM-768 receive key (§5.1):

```text
envelope  = version (1) ‖ kemCiphertext (1,088) ‖ AEAD(noteKey, plaintext (108), aad = empty) ‖ tag (16)
noteKey   = HKDF(ikm = ss, salt = SHA-256("pcash.envelope-salt" ‖ version ‖ kemCiphertext), info = "pcash.note-key", 32)
plaintext = version (1) ‖ kind (1) ‖ chainId (4) ‖ assetId (32) ‖ amount (16) ‖ owner (20) ‖ noteSecret (32) ‖ outputIndex (1) ‖ anchor (1)
```

`version` is `1` in both places, and `ss` is the shared secret of the envelope's encapsulation. The envelope names no recipient: a wallet finds its outputs by trial decryption, and the tag rejects every envelope meant for another key. `owner` is the note's owner address (§4.1), and `outputIndex` is the output's slot. For a note, `kind` is `1` when it has a recipient region in the arena whose anchor cell is `anchor`, and `0` otherwise, with `anchor = 0`. For message-only delivery, `kind = 2`, the bytes occupied by `assetId`, `amount`, `owner`, and `noteSecret` are all zero, and `anchor` identifies its recipient region. A message-only envelope occupies a dummy output slot and creates no spendable note. Records reuse an existing note envelope when the recipient address and receive key match; other recipients use free dummy slots. A slot without in-band delivery carries a real envelope to a fresh key that is then discarded, so filler and deliveries are drawn from the same distribution. `ss` is the output's disclosure key: it opens the envelope and derives the keys of the output's region. A direct send's envelope takes `ss = SHA-256("pcash.direct-send" ‖ noteSecret)`, with `noteSecret` as 32 bytes, in place of an encapsulated secret, and its `kemCiphertext` encapsulates to a fresh key that is then discarded, as filler's does, so whoever holds the note's opening reads the envelope and its region.

**The arena.** Records that do not fit a fixed envelope, such as memos, asset definitions, application data, the sender's own recovery data, and application records published to every reader, live in one arena per section:

```text
arena = salt (32) ‖ cell_0 ‖ ... ‖ cell_(C-1)        C = 8 × O cells of 65 bytes: 40 in S, 256 in L
```

The writer draws a fresh random salt for every construction and fills every unused cell with random bytes. One fixed size per profile hides encrypted data lengths, and pooling the bytes lets any recipient, or the sender, use space that padding outputs would otherwise strand. Sixty-five-byte cells are the smallest that keep every cell index to one byte at 256 cells.

A **region** is one anchor cell and `n >= 0` continuation cells. The anchor is authenticated on its own and holds the region's directory and the start of its payload; the continuation cells, concatenated in ascending index order, are one ciphertext bound to the anchor:

```text
anchorCell      = AEAD(anchorKey, anchorPlaintext (49), aad = empty) ‖ tag
anchorPlaintext = count (1) ‖ directory ‖ payload prefix
bodyCells       = AEAD(bodyKey, remaining payload, aad = anchorCell) ‖ tag
```

The payload is the region's record list followed by zero padding to the end of the region (Payloads).

With `B = C / 8` (5 in S, 32 in L), the directory is the `n` continuation indices in strictly ascending order when `n <= B`, with `count = n`. Otherwise `count = 255` and the directory is a `B`-byte bitmap of the continuation cells, with cell `i` at bit `7 − (i mod 8)` of byte `⌊i / 8⌋`. The writer uses the shorter form, so each region has one encoding: a list never names the anchor or an index `>= C`, and a bitmap sets more than `B` bits and never the anchor's. Cell `C − 1` is the sender region's anchor (Allocation). Every other cell index outside the public segment, including zero when there is no segment, is available to a recipient region as an anchor or continuation and to the sender region as a continuation, with continuation cells on either side of the anchor. These rules matter because a region's writer chooses its body plaintext and can therefore choose the bytes of any cell but the last: without them, a region could name itself or a cell twice and still authenticate. A `k`-cell region carries 48 payload bytes when `k = 1` and `65k − 33 − min(k − 1, B)` when `k >= 2`. A reader acts on a directory only after its anchor authenticates. It rejects a region whose anchor or body fails to authenticate, whose directory is not canonical, or whose record list is not followed only by zero bytes, and consumes none of its payload, not even the prefix in the anchor, until the whole region has verified.

**Keys and context.**

```text
anchorKey = HKDF(ikm, salt = arena salt, info = "pcash.arena." ‖ role ‖ ".anchor" ‖ txContext, 32)
bodyKey   = HKDF(ikm, salt = arena salt, info = "pcash.arena." ‖ role ‖ ".body" ‖ txContext, 32)
txContext = chainId (4) ‖ txType (1) ‖ shapeId (1) ‖ nullifier_0 (32) ‖ ... ‖ nullifier_(I-1) (32)
```

| Region | `role` | `ikm` |
|---|---|---|
| Recipient region | `recipient` | the output envelope's `ss` |
| Sender region | `sender` | the building wallet's outgoing key |

`txType` and `shapeId` are those of the transaction that carries the section (profile S for the fee sections of types `0x02` and `0x03`), and the nullifiers are the section's, in order. The salt and the context do different jobs. The salt makes every construction's keys fresh, including competing candidate transactions that spend the same notes. The context binds every region to its spend, so a salt and region copied into another transaction do not decrypt there, and a salt that repeats in another spend still gives other keys. The final transaction hash cannot serve as either, because it depends on the arena. The keys bind the role and the spend, so the anchor needs no associated data: the envelope authenticates the anchor it names, and the sender anchor is fixed.

The **outgoing key** is 32 bytes that the reference wallet derives from its recovery root. It is never `nkRoot`, which a contract may publish, and it is independent of every secret the wallet hands to applications. Exported alone, it gives outgoing-only viewing.

**Public segment.** A section may publish application records to every reader, in plaintext, in the arena's first `k` cells:

```text
publicSegment = "PCASHPUB" (8) ‖ listLength (2) ‖ record list (listLength) ‖ zero padding to the end of cell k − 1
k             = ⌈(10 + listLength) / 65⌉
```

The record list is nonempty and holds only application records. A section that publishes nothing has no segment, and its cell `0` is an ordinary cell. A reader needs only the arena bytes, with no key and no transaction context: the arena has public records when cell `0` begins with the marker, `1 <= listLength <= 65(C − 1) − 10`, the padding is zero, and the record list is valid and holds only application records; otherwise it has none. Random filler and encrypted cells match the eight-byte marker with probability `2^-64`. The segment reveals its records and its length to everyone and authenticates no author. Its bytes are bound to the transaction only as part of the arena the delivery commitment covers, so the same records can appear in any other transaction; an application that needs authorship signs within its record.

**Allocation.** One capacity plan accounts for the public segment, recipient regions, sender recovery and envelope slots. If they do not fit, construction fails before proving; records are never truncated or dropped to fit. The public segment takes cells `0` to `k − 1`. Cell `C − 1` is the sender region's anchor and is reserved in every build; a build without a sender region fills it with random bytes, so a recipient's cells do not reveal whether one exists. The writer assigns every other cell by a uniformly random permutation: each recipient region and the sender region's continuation receive a uniformly random set of them. Recipient identities never appear in plaintext delivery headers. The reference wallet writes a sender region in every transaction it builds, with an empty payload if it has nothing to record, so its outgoing key recognizes all of its transactions; for a sponsored transfer, that is the fee payer’s wallet.

**Payloads.** Every region and the public segment hold the same record list. In the public segment it fills exactly `listLength`. In a region it is followed by zero padding: the list ends where the next identifier would begin with a zero byte, every byte after that is zero, and a list that fills its region exactly has no terminator. A zero byte inside a record's length or data is not a terminator.

```text
record     = identifier ‖ dataLength (uvarint) ‖ data (dataLength)
identifier = type (1)            standard: first byte 0x01 to 0x7F
           | applicationId (4)   application: first byte 0x80 to 0xFF
```

`uvarint` is unsigned LEB128 in its shortest encoding, so `dataLength <= 65,535` takes at most three bytes. Standard types are assigned below; any other first byte below `0x80` invalidates the record list, and so does zero except as a region's terminator. An application ID is the first four bytes of SHA-256 of a namespaced ASCII name, without a terminator or length prefix, with the most significant bit of its first byte set. A name has at most 255 bytes and at least two dot-separated components, each starting with a lowercase letter and continuing with lowercase letters, digits or hyphens. Names such as `org.pcash.lineage` are local labels, never network lookup locations, and are not carried on the wire. Truncation makes accidental collisions unlikely, not impossible; an ID does not authenticate an application or its data.

Records are ordered lexicographically by their identifier bytes, so standard records precede application records. Each identifier occurs once per record list. Empty data is permitted. Schemas needing multiple items encode a collection within one payload. Unknown application IDs remain opaque records.

| Type | Data | Regions |
|---|---|---|
| 1 — memo | UTF-8 text | recipient, sender |
| 2 — asset definition | the definition opening of §11.6 with its metadata: `1 (1) ‖ initialSupply (17) ‖ assetSecretCommitment (32) ‖ nameLength (1) ‖ name ‖ symbolLength (1) ‖ symbol ‖ decimals (1) ‖ contentDigest (32)` | recipient, sender |
| 3 — claimed sender | a 20-byte address, unauthenticated | recipient, sender |
| 4 — sent envelopes | per envelope: `slotAndFlags (1) ‖ ss (32) ‖ recipientAddress (20)` | sender |
| 5 — sent openings | per output: `slotAndFlags (1) ‖ recipientAddress (20) ‖ assetId (32) ‖ amount (16) ‖ noteSecret (32)` | sender |
| 6 — direct-send openings | per opening: `version (1) ‖ chainId (4) ‖ contentHash (32) ‖ slot (1) ‖ owner (20) ‖ amount (16) ‖ noteSecret (32)` | sender |
| application ID | opaque | recipient, sender, public |

In a sent-envelope entry, the low seven bits of `slotAndFlags` encode the slot and the high bit marks records-only recovery: its records are recovered but its note is excluded from paid-output history. In a sent-opening entry, the high bit marks a direct send. The decoded slot must be below the selected profile’s output count. Every envelope carrying explicitly addressed records has a sent-envelope entry, including reused relay-fee and change envelopes, except a direct send's, whose flagged sent opening derives its key. Entries in sent-envelope and sent-opening records are in strictly ascending slot order, ignoring the flag bit; direct-send openings are in strictly ascending byte order. A standard type outside its region's column invalidates the region, and any standard type invalidates the public segment. A recipient's records are those of its region: a record sent to several recipients is copied into each of their regions, so no recipient learns that another received it. An unavailable record never invalidates a note: the envelope alone delivers the opening. A delivered asset definition is associated with a note only if it derives that note's asset ID; transaction data remains independent of note metadata. Recovery records are wallet-managed and cannot be supplied as application records.

**Recovery.** A recipient decapsulates each envelope with each of its receive keys and, for `kind = 1` or `kind = 2`, opens its region. A wallet holding only its outgoing key derives the sender keys for each transaction and decrypts one anchor, at cell `C − 1`; on a match it reads the body, opens every envelope listed in its sent-envelope record with its `ss` together with that output's region, and rebuilds each note listed in its sent-opening record, whose owner is `recipientAddress` (§4.1), opening a direct send's envelope and region with the key its note secret derives. Explicit self records and counterparty-directed records recover from the outgoing key even when the transaction creates no sent or received note. A restoring wallet takes asset definitions from every region it opens, its sender region included, whether or not the transaction has sent outputs. The reference wallet's asset actions from its own account carry the definition in the sender region rather than on that account's change or new holdings, so a wallet scanning with receive keys alone learns those definitions only from an earlier delivery. Wallets store records with transaction and block provenance independently of notes, following the same scan checkpoints and reorganization rollback as note inventory, including the public records of the transactions their outgoing key recognizes. Any reader, holding no key, reads public records from the arena alone. Decryption authenticates neither a claimed author nor inclusion: every recovered opening is checked against the transaction's output body commitments. The reference node serves each transaction's output data and arena together in its output feed, so a wallet reads every arena once, from the stream it already scans.

**Direct sends.** A wallet pays an address that publishes no receive key by a direct send: a native note whose envelope is keyed by its note secret (above), so it carries a memo and claimed sender like any payment, and whose opening the payer records as a flagged sent opening and delivers to the owner out of band, as a link carrying the type-6 encoding with version 1. That opening names its output by the content hash of the funding transaction and the output slot, not by leaf, because a reorganization can include the same bytes at another leaf; the owner's wallet resolves the leaf from the accepted receipt and checks the opening against the commitment there. Trial decryption cannot find such a note, so the owner's wallet keeps an opening once the output it names is accepted and opens under it, and matches that output whenever a scan passes it. Until a final transaction of the owner's records an opening in a direct-send-openings record, the owner's setup mining action carries it, and otherwise the first transaction that spends the note. A wallet that learns an opening, from a link or from such a record, after its scan passed the funding output reads the output feed from that output for a transaction consuming the note's nullifier, so a note another device on the same seed already spent stays spent, and takes the note's path from the node unless a final transaction spent it, since a reorganization can remove a spend that is not final. An opening neither recorded nor kept survives only in the link.

## References

* [EIP-2](https://eips.ethereum.org/EIPS/eip-2): low-s signature rule.
* [EIP-712](https://eips.ethereum.org/EIPS/eip-712): typed-data signing.
* [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844): blob transactions and KZG commitments.
* [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702): code for externally owned accounts.
* [Solidity ABI specification](https://docs.soliditylang.org/en/latest/abi-spec.html): event signatures and the ABI encoding of `bytes`.
* [Ethereum Execution APIs](https://ethereum.github.io/execution-apis/): Ethereum JSON-RPC and block tags.
