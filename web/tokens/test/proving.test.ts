// End-to-end template scenarios on a synthetic chain. Every transaction is
// proved and verified by the release-pinned native CHONK prover; the chain
// applies its public effects with execution's window and nullifier rules.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { networkForChain, ownerChangeNoteSecret } from "@pcash/sdk/protocol";
import { bytes32Hex } from "@pcash/sdk/utils";
import {
  buildClaimLinkSpend,
  buildDropClaim,
  buildDropReclaim,
  checkDropEligibility,
  claimantAccount,
  claimLinkContract,
  claimLinkNote,
  dropClaimMarker,
  dropInventoryNote,
  dropPublication,
  dropTermsForCreator,
  eligibilityDrop,
  formatClaimLinkUrl,
  parseClaimLink,
  parseDropPublication,
  planClaimLinks,
  planDropInventory,
  readClaimLink,
  readDropClaim,
  readDropEligibility,
  readTemplateWitness,
  serializeDropPublication,
  verifyDropPublication,
  type ClaimLink,
  type ClaimLinkNoteRef,
  type DropInventoryNote,
  type SponsoredRole,
} from "../src/index.ts";
import { CHAIN_ID, ExecutionFailure, SyntheticChain } from "./chain.ts";
import { fundContract, payAsset, proveTemplate, proverAvailable, receive } from "./prove.ts";
import { giveNote, registerUser, testToken, testUser, userAuthorization, type TestUser } from "./wallets.ts";

function sponsored(chain: SyntheticChain, payer: TestUser, note: { leafIndex: number; noteSecret: bigint; amount: bigint }, openFeeAmount: bigint): SponsoredRole {
  const rule = payer.rules.contractFeeSponsorshipRule;
  return {
    kind: "sponsored",
    feePayer: userAuthorization(chain, payer, rule),
    feePayerWallet: payer,
    feeChangeReceiveKey: payer.mlKemPublicKey,
    network: networkForChain(CHAIN_ID),
    nativeInputs: [{ ...note, siblings: chain.outputSiblings(note.leafIndex) }],
    openFeeAmount,
  };
}

function rejects(run: () => unknown, outcome: string): void {
  assert.throws(run, (error: unknown) => error instanceof ExecutionFailure && error.outcome === outcome);
}

describe("claim links", { skip: !proverAvailable }, () => {
  const chain = new SyntheticChain();
  const node = chain.node();
  const creator = testUser(1);
  const claimant = testUser(2);
  const payer = testUser(3);
  const { definition, assetId } = testToken(100n);
  const creatorSecret = 0xc0ffeen;
  const plan = planClaimLinks({ creatorSecret, assetId, amounts: [100n, 200n, 300n, 400n] });
  let links: ClaimLinkNoteRef[];
  let payerNote: { leafIndex: number; noteSecret: bigint; amount: bigint };
  let firstClaimNullifiers: bigint[];

  before(async () => {
    for (const user of [creator, claimant, payer]) registerUser(chain, user);
    chain.addContract(plan.contract);
    const source = giveNote(chain, creator, assetId, 5_000n, 0xa11ce0n);
    payerNote = giveNote(chain, payer, 0n, 1_000n, 0xfee0n);
    chain.seal();
    const leaves = await fundContract(chain, creator, {
      assetId,
      source,
      contract: plan.contract.address,
      notes: plan.links,
    });
    links = plan.links.map((link, index) => ({ leafIndex: leaves[index]!, amount: link.amount, linkKey: link.linkKey }));
  });

  it("claims a link to a claim-time recipient", async () => {
    const shared: ClaimLink = {
      contractSeed: plan.contract.contractSeed,
      funding: { contentHash: bytes32Hex(0xf0n), slot: 0 },
      amount: links[0]!.amount,
      linkKey: links[0]!.linkKey,
      definition,
    };
    const parsed = parseClaimLink(formatClaimLinkUrl(shared, "https://pcash.example/claim"));
    assert.deepEqual(parsed, shared);
    const contract = claimLinkContract({ contractSeed: parsed.contractSeed, assetId });
    assert.equal(contract.address, plan.contract.address);
    const link = links[0]!;
    const state = await readClaimLink(node, contract, link);
    assert.equal(state.status, "claimable");
    if (state.status !== "claimable") return;
    const action = buildClaimLinkSpend({
      contract,
      pcashChainId: CHAIN_ID,
      snapshot: state.witness.snapshot,
      contractOpening: state.witness.contractOpening,
      notes: [{ ...link, siblings: state.witness.notes[0]!.siblings }],
      recipient: { address: claimant.address, receiveKey: claimant.mlKemPublicKey },
      role: { kind: "transfer", issuance: { kind: "self", recipient: claimant } },
      assetDefinition: definition,
      validUntilTimestamp: chain.timestamp + 3_600n,
    });
    assert.equal(action.role, "transfer");
    await proveTemplate(action);
    firstClaimNullifiers = action.build.transaction.inputs.map((input) => BigInt(input.nullifier));
    const leaves = chain.apply(action.build.publicInputs, action.build.outputData);
    chain.seal();
    const received = receive(chain, claimant, leaves);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.amount, 100n);
    assert.equal(received[0]!.assetId, assetId);
    assert.equal(received[0]!.owner, claimant.address);
    assert.deepEqual(await readClaimLink(node, contract, link), { status: "claimed" });
  });

  it("rejects a second spend of the same link", async () => {
    const contract = plan.contract;
    const note = claimLinkNote(contract, links[0]!);
    assert.equal(firstClaimNullifiers[0], note.nullifier);
    const witness = await readTemplateWitness(node, {
      contract: contract.address,
      notes: [{ leafIndex: note.leafIndex, outputCommitment: note.outputCommitment }],
      nullifiers: [note.nullifier],
    });
    assert.ok(witness);
    assert.deepEqual(witness.spent, [true]);
    const again = buildClaimLinkSpend({
      contract,
      pcashChainId: CHAIN_ID,
      snapshot: witness.snapshot,
      contractOpening: witness.contractOpening,
      notes: [{ ...links[0]!, siblings: witness.notes[0]!.siblings }],
      recipient: { address: payer.address, receiveKey: payer.mlKemPublicKey },
      role: { kind: "transfer" },
      assetDefinition: definition,
      validUntilTimestamp: chain.timestamp + 3_600n,
    });
    assert.equal(again.build.transaction.inputs[0]!.nullifier, note.nullifier);
    rejects(() => chain.apply(again.build.publicInputs, again.build.outputData), "NullifierAlreadySpent");
  });

  it("claims a link with a USER account paying the open fee", async () => {
    const state = await readClaimLink(node, plan.contract, links[1]!, { accounts: [payer.address] });
    assert.equal(state.status, "claimable");
    if (state.status !== "claimable") return;
    assert.equal(state.witness.accounts[0]?.account.index, BigInt(chain.accountsByAddress.get(payer.address)!.index));
    const action = buildClaimLinkSpend({
      contract: plan.contract,
      pcashChainId: CHAIN_ID,
      snapshot: state.witness.snapshot,
      contractOpening: state.witness.contractOpening,
      notes: [{ ...links[1]!, siblings: state.witness.notes[0]!.siblings }],
      recipient: { address: payer.address, receiveKey: payer.mlKemPublicKey },
      role: sponsored(chain, payer, payerNote, 5n),
      assetDefinition: definition,
      validUntilTimestamp: chain.timestamp + 3_600n,
    });
    assert.equal(action.role, "sponsored");
    await proveTemplate(action, payer);
    const leaves = chain.apply(action.build.publicInputs, action.build.outputData);
    chain.seal();
    const received = receive(chain, payer, leaves);
    assert.deepEqual(received.map((note) => [note.assetId, note.amount]), [[assetId, 200n], [0n, 995n]]);
  });

  it("returns unclaimed links to the creator in one action", async () => {
    const regenerated = planClaimLinks({ creatorSecret, assetId, amounts: [100n, 200n, 300n, 400n] });
    assert.deepEqual(regenerated.links.map((link) => link.linkKey), plan.links.map((link) => link.linkKey));
    const notes = [links[2]!, links[3]!].map((link) => claimLinkNote(plan.contract, link));
    const witness = await readTemplateWitness(node, {
      contract: plan.contract.address,
      notes: notes.map((note) => ({ leafIndex: note.leafIndex, outputCommitment: note.outputCommitment })),
      nullifiers: notes.map((note) => note.nullifier),
    });
    assert.ok(witness);
    assert.deepEqual(witness.spent, [false, false]);
    const action = buildClaimLinkSpend({
      contract: plan.contract,
      pcashChainId: CHAIN_ID,
      snapshot: witness.snapshot,
      contractOpening: witness.contractOpening,
      notes: [links[2]!, links[3]!].map((link, index) => ({ ...link, siblings: witness.notes[index]!.siblings })),
      recipient: { address: creator.address, receiveKey: creator.mlKemPublicKey },
      role: { kind: "transfer" },
      assetDefinition: definition,
      validUntilTimestamp: chain.timestamp + 3_600n,
    });
    await proveTemplate(action);
    const leaves = chain.apply(action.build.publicInputs, action.build.outputData);
    chain.seal();
    assert.deepEqual(receive(chain, creator, leaves).map((note) => note.amount), [700n]);
  });
});

describe("eligibility drops", { skip: !proverAvailable }, () => {
  const chain = new SyntheticChain();
  const node = chain.node();
  const creator = testUser(11);
  const early = testUser(12);
  const second = testUser(13);
  const late = testUser(14);
  const { definition, assetId } = testToken(200n);
  let cutoffBlockNumber: bigint;
  let claimEndTimestamp: bigint;
  let secondNote: { leafIndex: number; noteSecret: bigint; amount: bigint };
  let verified: ReturnType<typeof verifyDropPublication>;
  let inventory: DropInventoryNote[];
  let claimedNote: { leafIndex: number; noteSecret: bigint; amount: bigint };

  before(async () => {
    for (const user of [creator, early, second]) registerUser(chain, user);
    const source = giveNote(chain, creator, assetId, 5_000n, 0xd00dn);
    secondNote = giveNote(chain, second, 0n, 1_000n, 0xfee1n);
    cutoffBlockNumber = chain.seal().header.number;
    registerUser(chain, late);
    claimEndTimestamp = chain.timestamp + 20_000n;
    const drop = eligibilityDrop(dropTermsForCreator({
      dropSeed: 0xd509n,
      assetId,
      claimAmount: 250n,
      cutoffBlockNumber,
      claimEndTimestamp,
      creator,
    }));
    chain.addContract(drop);
    chain.seal();
    const inventoryPlan = planDropInventory(drop, [3, 4, 5, 6]);
    const leaves = await fundContract(chain, creator, {
      assetId,
      source,
      contract: drop.address,
      notes: inventoryPlan,
    });
    const publication = parseDropPublication(serializeDropPublication(
      dropPublication(drop, { chainId: Number(CHAIN_ID), definition, funding: [{ contentHash: bytes32Hex(0xf1n), firstIndex: 3, count: leaves.length }] }),
    ));
    verified = verifyDropPublication(publication, { chainId: CHAIN_ID });
    assert.equal(verified.count, leaves.length);
    // The synthetic chain has no receipts; the client resolves these leaves from the funding receipt.
    inventory = leaves.map((leafIndex, position) => dropInventoryNote(verified.drop, inventoryPlan[position]!.index, leafIndex));
    assert.equal(verified.drop.address, drop.address);
  });

  it("reports eligibility from the account count at the cutoff", async () => {
    assert.equal((await checkDropEligibility(node, verified.drop, early.address)).status, "eligible");
    assert.equal((await checkDropEligibility(node, verified.drop, late.address)).status, "ineligible");
    assert.deepEqual(await checkDropEligibility(node, verified.drop, 0x1234n), { status: "noAccount" });
  });

  it("claims for an account that existed at the cutoff, into a recoverable and spendable note", async () => {
    const state = await readDropClaim(node, { drop: verified.drop, inventory: inventory, claimant: early });
    assert.equal(state.status, "claimable");
    if (state.status !== "claimable") return;
    const action = buildDropClaim({
      drop: verified.drop,
      pcashChainId: CHAIN_ID,
      snapshot: state.witness.snapshot,
      contractOpening: state.witness.contractOpening,
      inventory: { index: state.inventory.index, leafIndex: state.inventory.leafIndex, siblings: state.witness.notes[0]!.siblings },
      claimant: { address: early.address, nkRoot: early.nkRoot, receiveKey: early.mlKemPublicKey, account: state.claimant },
      eligibility: state.eligibility,
      role: { kind: "transfer" },
      assetDefinition: definition,
      validUntilTimestamp: chain.timestamp + 3_600n,
    });
    await proveTemplate(action);
    const nullifiers = action.build.transaction.inputs.map((input) => input.nullifier);
    assert.equal(nullifiers[1], dropClaimMarker(verified.drop, early));
    const leaves = chain.apply(action.build.publicInputs, action.build.outputData);
    chain.seal();
    const [claimed] = receive(chain, early, leaves);
    assert.ok(claimed);
    assert.equal(claimed.amount, 250n);
    assert.equal(claimed.owner, early.address);
    assert.equal(claimed.noteSecret, ownerChangeNoteSecret(early.nkRoot, nullifiers, 0));
    claimedNote = { leafIndex: claimed.leafIndex, noteSecret: claimed.noteSecret, amount: claimed.amount };

    const paid = await payAsset(chain, early, { assetId, note: claimedNote, recipient: late });
    assert.deepEqual(receive(chain, late, paid).map((note) => [note.assetId, note.amount]), [[assetId, 250n]]);
  });

  it("rejects a second claim by the same account through its marker", async () => {
    assert.deepEqual(
      await readDropClaim(node, { drop: verified.drop, inventory: inventory, claimant: early }),
      { status: "claimed" },
    );
    const unspent = inventory.find((note) => !chain.spent.has(note.nullifier))!;
    const witness = await readTemplateWitness(node, {
      contract: verified.drop.address,
      notes: [{ leafIndex: unspent.leafIndex, outputCommitment: unspent.outputCommitment }],
      nullifiers: [],
      accounts: [early.address],
    });
    assert.ok(witness);
    const eligibility = await readDropEligibility(node, verified.drop, { hash: witness.snapshot.recentPcashBlockHash, number: witness.recentBlockNumber });
    assert.ok(eligibility);
    const again = buildDropClaim({
      drop: verified.drop,
      pcashChainId: CHAIN_ID,
      snapshot: witness.snapshot,
      contractOpening: witness.contractOpening,
      inventory: { index: unspent.index, leafIndex: unspent.leafIndex, siblings: witness.notes[0]!.siblings },
      claimant: { address: early.address, nkRoot: early.nkRoot, receiveKey: early.mlKemPublicKey, account: claimantAccount(witness.accounts[0]!) },
      eligibility,
      role: { kind: "transfer" },
      assetDefinition: definition,
      validUntilTimestamp: chain.timestamp + 3_600n,
    });
    await proveTemplate(again);
    assert.equal(again.build.transaction.inputs[1]!.nullifier, dropClaimMarker(verified.drop, early));
    rejects(() => chain.apply(again.build.publicInputs, again.build.outputData), "NullifierAlreadySpent");
  });

  it("rejects an account created after the cutoff", async () => {
    const state = await readDropClaim(node, { drop: verified.drop, inventory: inventory, claimant: late });
    assert.equal(state.status, "ineligible");
    const unspent = inventory.find((note) => !chain.spent.has(note.nullifier))!;
    const witness = (await readTemplateWitness(node, {
      contract: verified.drop.address,
      notes: [{ leafIndex: unspent.leafIndex, outputCommitment: unspent.outputCommitment }],
      nullifiers: [],
      accounts: [late.address],
    }))!;
    const eligibility = (await readDropEligibility(node, verified.drop, { hash: witness.snapshot.recentPcashBlockHash, number: witness.recentBlockNumber }))!;
    const forced = buildDropClaim({
      drop: verified.drop,
      pcashChainId: CHAIN_ID,
      snapshot: witness.snapshot,
      contractOpening: witness.contractOpening,
      inventory: { index: unspent.index, leafIndex: unspent.leafIndex, siblings: witness.notes[0]!.siblings },
      claimant: { address: late.address, nkRoot: late.nkRoot, receiveKey: late.mlKemPublicKey, account: claimantAccount(witness.accounts[0]!) },
      eligibility,
      role: { kind: "transfer" },
      assetDefinition: definition,
      validUntilTimestamp: chain.timestamp + 3_600n,
    });
    await assert.rejects(proveTemplate(forced), /claimant account must exist at the cutoff block/);
  });

  it("claims with the claimant paying its own open fee", async () => {
    const state = await readDropClaim(node, {
      drop: verified.drop,
      inventory: inventory,
      claimant: second,
    });
    assert.equal(state.status, "claimable");
    if (state.status !== "claimable") return;
    const action = buildDropClaim({
      drop: verified.drop,
      pcashChainId: CHAIN_ID,
      snapshot: state.witness.snapshot,
      contractOpening: state.witness.contractOpening,
      inventory: { index: state.inventory.index, leafIndex: state.inventory.leafIndex, siblings: state.witness.notes[0]!.siblings },
      claimant: { address: second.address, nkRoot: second.nkRoot, receiveKey: second.mlKemPublicKey, account: state.claimant },
      eligibility: state.eligibility,
      role: sponsored(chain, second, secondNote, 7n),
      assetDefinition: definition,
      validUntilTimestamp: chain.timestamp + 3_600n,
    });
    await proveTemplate(action, second);
    const nullifiers = action.build.transaction.inputs.map((input) => input.nullifier);
    const leaves = chain.apply(action.build.publicInputs, action.build.outputData);
    chain.seal();
    const received = receive(chain, second, leaves);
    assert.deepEqual(received.map((note) => [note.assetId, note.amount]), [[assetId, 250n], [0n, 993n]]);
    assert.equal(received[0]!.noteSecret, ownerChangeNoteSecret(second.nkRoot, nullifiers, 0));
  });

  it("reclaims only once the claim window has closed", async () => {
    const remaining = inventory.filter((note) => !chain.spent.has(note.nullifier));
    assert.equal(remaining.length, 2);
    const witness = (await readTemplateWitness(node, {
      contract: verified.drop.address,
      notes: remaining.map((note) => ({ leafIndex: note.leafIndex, outputCommitment: note.outputCommitment })),
      nullifiers: [],
    }))!;
    const reclaim = (notBeforeTimestamp?: bigint) => buildDropReclaim({
      drop: verified.drop,
      pcashChainId: CHAIN_ID,
      snapshot: witness.snapshot,
      contractOpening: witness.contractOpening,
      inventory: remaining.map((note, index) => ({ index: note.index, leafIndex: note.leafIndex, siblings: witness.notes[index]!.siblings })),
      creator: { address: creator.address, nkRoot: creator.nkRoot, receiveKey: creator.mlKemPublicKey },
      role: { kind: "transfer" },
      ...(notBeforeTimestamp === undefined ? {} : { notBeforeTimestamp }),
      assetDefinition: definition,
      validUntilTimestamp: claimEndTimestamp + 100_000n,
    });
    await assert.rejects(proveTemplate(reclaim(claimEndTimestamp - 1n)), /reclaim must start at or after the claim end/);

    const action = reclaim();
    await proveTemplate(action);
    rejects(() => chain.apply(action.build.publicInputs, action.build.outputData), "NotYetValid");
    chain.seal(claimEndTimestamp - chain.timestamp);
    const nullifiers = action.build.transaction.inputs.map((input) => input.nullifier);
    const leaves = chain.apply(action.build.publicInputs, action.build.outputData);
    chain.seal();
    const [returned] = receive(chain, creator, leaves);
    assert.equal(returned?.amount, 500n);
    assert.equal(returned?.noteSecret, ownerChangeNoteSecret(creator.nkRoot, nullifiers, 0));
  });
});
