import assert from "node:assert/strict";
import test from "node:test";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import { accountStateCommitment, decodePayload, decodeTransaction, decryptEnvelope, generateMlKemKeyPair, noteBodyCommitment, ownerCommitment, privateValuePublicInputs, receiveKeyHash, WIRE_PROOF_BYTES } from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex, toHex } from "@pcash/sdk/utils";
import type { AssetActionOutput } from "@pcash/sdk/builders";
import type { SponsoredContractAssetActionIntent } from "@pcash/sdk/wallet/actions";
import type { WalletExecutionContext } from "@pcash/sdk/wallet";
import { walletRecipient } from "../src/client/action.ts";
import { claimDrop, type AvailableDrop } from "../src/client/drops.ts";
import { eligibilityDrop, dropTermsForCreator, planDropInventory } from "../src/drop.ts";
import { claimLink } from "../src/client/links.ts";
import type { TokensRuntime } from "../src/client/runtime.ts";
import { claimLinkContractOf, claimLinkNote, formatClaimLinkUrl, planClaimLinks, type ClaimLink } from "../src/link.ts";
import { CHAIN_ID, SyntheticChain } from "./chain.ts";
import { registerUser, testToken, testUser } from "./wallets.ts";

const profile = testUser(3);
const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(81));
const receiveHash = bytes32Hex(receiveKeyHash(rotated.publicKey));

function context(registered = true, owned = true): WalletExecutionContext {
  return {
    profile,
    store: {
      load: async () => ({ receiveKeys: owned ? [{ receiveKeyHash: receiveHash,
        mlKemPublicKey: toHex(rotated.publicKey), mlKemSecretKey: toHex(rotated.secretKey) }] : [] }),
      readChain: async (read: (chain: unknown) => unknown) => read({ accountResult: () => ({
        receiveKeyHash: registered ? receiveHash : "0x0",
        material: { status: "available", mlKem768PublicKey: toHex(rotated.publicKey) },
      }) }),
    },
  } as unknown as WalletExecutionContext;
}

test("token automatic self delivery uses the registered owned key", async () => {
  assert.deepEqual(await walletRecipient(context()), { address: profile.address, receiveKey: rotated.publicKey, self: true });
  await assert.rejects(walletRecipient(context(false)), /no registered receive key/);
  await assert.rejects(walletRecipient(context(true, false)), /does not own the registered receive key/);
});

for (const openFeeAmount of [0n, 1n]) test(`a token claim resumes before receive-key resolution (fee ${openFeeAmount})`, async () => {
  const { definition, assetId } = testToken(5n);
  const planned = planClaimLinks({ creatorSecret: 5n, assetId, amounts: [100n] });
  const link: ClaimLink = { contractSeed: planned.contract.contractSeed,
    funding: { contentHash: bytes32Hex(91n), slot: 0 }, amount: 100n, linkKey: planned.links[0]!.linkKey, definition };
  const contract = claimLinkContractOf(link);
  const note = claimLinkNote(contract, { ...link, leafIndex: 0 });
  let resumed = 0;
  const node = {
    getReceipt: async () => [{ outcome: "succeeded", outputLeafStart: 0n }],
    status: async () => { resumed++; throw new Error("resuming saved transaction"); },
  };
  const ctx = { profile, node, network: { chainId: CHAIN_ID }, store: {
    load: async () => ({ pendingAssetActions: [{ claimLinkRecipient: addressHex(profile.address),
      inputs: [{ nullifier: bytes32Hex(note.nullifier) }] }] }),
    readChain: async () => { throw new Error("current receive key must not be read for a retry"); },
  } };
  const rt = { node, submission: { mode: "mempool" }, wallet: {
    address: addressHex(profile.address), network: { chainId: CHAIN_ID },
    execute: async (action: (context: unknown) => unknown) => action(ctx),
  } } as unknown as TokensRuntime;
  // A saved explicit code is still an address for exact-transaction journal matching.
  const recipient = buildExtendedCode({ chainId: CHAIN_ID, address: profile.address, mlKemPublicKey: profile.mlKemPublicKey });
  await assert.rejects(claimLink(rt, formatClaimLinkUrl(link, "https://example.test/claim"), { openFeeAmount, recipient }), /resuming saved transaction/);
  assert.equal(resumed, 1);
});


for (const destination of ["automatic", "address", "code"] as const) test(`sponsored token claim resolves ${destination} self delivery at the final snapshot`, async () => {
  const { definition, assetId } = testToken(5n);
  const planned = planClaimLinks({ creatorSecret: 5n, assetId, amounts: [100n] });
  const link: ClaimLink = { contractSeed: planned.contract.contractSeed,
    funding: { contentHash: bytes32Hex(92n), slot: 0 }, amount: 100n, linkKey: planned.links[0]!.linkKey, definition };
  const chain = new SyntheticChain();
  const contractIndex = chain.addContract(planned.contract);
  chain.appendBody(0n);
  chain.seal();
  const oldPair = { publicKey: profile.mlKemPublicKey, secretKey: profile.mlKemSecretKey };
  const node = { getReceipt: async () => [{ outcome: "succeeded", outputLeafStart: 0n }] };
  const ctx = { profile, node, network: { chainId: CHAIN_ID }, store: {
    load: async () => ({ pendingAssetActions: [], receiveKeys: [oldPair, rotated].map(pair => ({
      receiveKeyHash: bytes32Hex(receiveKeyHash(pair.publicKey)), mlKemPublicKey: toHex(pair.publicKey), mlKemSecretKey: toHex(pair.secretKey),
    })) }),
    readChain: async () => { throw new Error("automatic payout must use the final sponsor snapshot"); },
  } };
  let payout: Extract<AssetActionOutput, { kind: "asset" | "native" }>["delivery"] | undefined;
  let currentKeyReads = 0;
  const rt = { node, submission: { mode: "mempool" }, wallet: {
    address: addressHex(profile.address), network: { chainId: CHAIN_ID },
    execute: async (action: (context: unknown) => unknown) => action(ctx),
    importAssetDefinition: async () => undefined,
    sponsorContractAction: async (intent: SponsoredContractAssetActionIntent) => {
      const side = await intent.primary({
        roots: chain.snapshot(), status: { latestBlockTimestamp: chain.timestamp },
        contractAccount: { account: { index: BigInt(contractIndex) }, accountSiblings: chain.accountSiblings(contractIndex) },
        outputPaths: [{ siblings: chain.outputSiblings(0) }],
        snapshot: { outputs: {}, nullifiers: { statuses: [{ spent: false }] } },
        selfReceiveKey: () => { currentKeyReads++; return rotated.publicKey; },
      } as unknown as Parameters<SponsoredContractAssetActionIntent["primary"]>[0]);
      const output = side.realizeOutputs([1n, 2n, 3n, 4n]).outputs[0]!.output;
      assert.notEqual(output.kind, "dummy");
      if (output.kind === "dummy") throw new Error("expected the payout output");
      payout = output.delivery;
      return { contentHash: bytes32Hex(93n), accepted: true, queued: false };
    },
  } } as unknown as TokensRuntime;
  const recipient = destination === "automatic" ? undefined : destination === "address" ? addressHex(profile.address)
    : buildExtendedCode({ chainId: CHAIN_ID, address: profile.address, mlKemPublicKey: profile.mlKemPublicKey });
  await claimLink(rt, formatClaimLinkUrl(link, "https://example.test/claim"), { openFeeAmount: 1n, ...(recipient === undefined ? {} : { recipient }) });
  // The wallet's builder seals the payout to this key; a payout to itself is not recorded as paid.
  assert.equal(payout?.kind, "canonical-encrypted");
  if (payout?.kind !== "canonical-encrypted") throw new Error("expected an encrypted payout");
  const intended = destination === "code" ? oldPair : rotated;
  assert.deepEqual(payout.receiveKey, intended.publicKey);
  assert.equal(payout.change, true);
  assert.equal(currentKeyReads, destination === "code" ? 0 : 1);
});


test("a sponsored token claim to another address reads its key in the sponsorship's snapshot", async () => {
  const { definition, assetId } = testToken(5n);
  const planned = planClaimLinks({ creatorSecret: 5n, assetId, amounts: [100n] });
  const link: ClaimLink = { contractSeed: planned.contract.contractSeed,
    funding: { contentHash: bytes32Hex(96n), slot: 0 }, amount: 100n, linkKey: planned.links[0]!.linkKey, definition };
  const chain = new SyntheticChain();
  const contractIndex = chain.addContract(planned.contract);
  chain.appendBody(0n);
  chain.seal();
  const bob = testUser(4);
  const snapshotKey = generateMlKemKeyPair(new Uint8Array(64).fill(83));
  const node = { getReceipt: async () => [{ outcome: "succeeded", outputLeafStart: 0n }] };
  const ctx = { profile, node, network: { chainId: CHAIN_ID }, store: {
    load: async () => ({ pendingAssetActions: [], receiveKeys: [] }),
    readChain: async () => { throw new Error("the recipient's key must come from the sponsorship's snapshot"); },
  } };
  const reads: string[] = [];
  let payout: Extract<AssetActionOutput, { kind: "asset" | "native" }>["delivery"] | undefined;
  const rt = { node, submission: { mode: "mempool" }, wallet: {
    address: addressHex(profile.address), network: { chainId: CHAIN_ID },
    execute: async (action: (context: unknown) => unknown) => action(ctx),
    importAssetDefinition: async () => undefined,
    sponsorContractAction: async (intent: SponsoredContractAssetActionIntent) => {
      const side = await intent.primary({
        roots: chain.snapshot(), status: { latestBlockTimestamp: chain.timestamp },
        contractAccount: { account: { index: BigInt(contractIndex) }, accountSiblings: chain.accountSiblings(contractIndex) },
        outputPaths: [{ siblings: chain.outputSiblings(0) }],
        snapshot: { outputs: {}, nullifiers: { statuses: [{ spent: false }] } },
        receiveKeyOf: async (address: string) => { reads.push(address); return snapshotKey.publicKey; },
        selfReceiveKey: () => { throw new Error("not a self claim"); },
      } as unknown as Parameters<SponsoredContractAssetActionIntent["primary"]>[0]);
      const output = side.realizeOutputs([1n, 2n, 3n, 4n]).outputs[0]!.output;
      if (output.kind === "dummy") throw new Error("expected the payout output");
      payout = output.delivery;
      return { contentHash: bytes32Hex(97n), accepted: true, queued: false };
    },
  } } as unknown as TokensRuntime;
  await claimLink(rt, formatClaimLinkUrl(link, "https://example.test/claim"), { openFeeAmount: 1n, recipient: addressHex(bob.address) });
  assert.deepEqual(reads, [addressHex(bob.address)]);
  assert.equal(payout?.kind, "canonical-encrypted");
  if (payout?.kind !== "canonical-encrypted") throw new Error("expected an encrypted payout");
  assert.deepEqual(payout.receiveKey, snapshotKey.publicKey);
});

test("an unsponsored token claim to another address seals to its key in the claim's snapshot", async () => {
  const bob = testUser(4);
  const fixture = await directClaimSnapshotFixture({ thirdParty: bob });
  await assert.rejects(claimLink(fixture.runtime, fixture.url, { recipient: addressHex(bob.address) }), /captured unsponsored payout/);
  assert.equal(fixture.syncs(), 1);
  const payout = fixture.transaction().outputData[0]!;
  assert.equal(decryptEnvelope(bob.mlKemSecretKey, payout), null);
  assert.ok(decryptEnvelope(fixture.thirdPartyKey.secretKey, payout));
});

test("an unsponsored drop claim resolves the key from each retry's claimant snapshot", async () => {
  const chain = new SyntheticChain();
  const claimantIndex = registerUser(chain, profile);
  const cutoffBlockNumber = chain.seal().header.number;
  const { definition, assetId } = testToken(5n);
  const drop = eligibilityDrop(dropTermsForCreator({ dropSeed: 17n, assetId, claimAmount: 100n,
    cutoffBlockNumber, claimEndTimestamp: chain.timestamp + 10000n, creator: profile }));
  chain.addContract(drop);
  for (const note of planDropInventory(drop, 2)) {
    chain.appendBody(noteBodyCommitment(ownerCommitment(drop.address, note.noteSecret), assetId, note.amount));
  }
  chain.seal();
  const node = { ...chain.node(), status: async () => ({ latestBlockTimestamp: chain.timestamp }),
    getReceipt: async () => [{ outcome: "succeeded", outputLeafStart: 0n }] };
  const oldPair = { publicKey: profile.mlKemPublicKey, secretKey: profile.mlKemSecretKey };
  const ctx = { profile, node, network: { chainId: CHAIN_ID }, store: {
    load: async () => ({ pendingAssetActions: [], receiveKeys: [oldPair, rotated].map(pair => ({
      receiveKeyHash: bytes32Hex(receiveKeyHash(pair.publicKey)), mlKemPublicKey: toHex(pair.publicKey), mlKemSecretKey: toHex(pair.secretKey),
    })) }),
    readChain: async () => { throw new Error("drop payout must use the claimant snapshot"); },
  } };
  const payouts: Uint8Array[] = [];
  const rt = { node, prover: { proveAssetAction: async () => ({ proof: new Uint8Array(WIRE_PROOF_BYTES) }) },
    submission: { mode: "mempool", preflight: async ({ transactionBytes }: { transactionBytes: Uint8Array }) => {
      const decoded = decodeTransaction(transactionBytes);
      assert.equal(decoded.kind, 0);
      if (decoded.kind !== 0) throw new Error("expected private-value claim");
      payouts.push(decoded.outputData[0]!);
      if (payouts.length === 1) {
        chain.spent.add(privateValuePublicInputs(decoded)[2]!);
        const account = chain.accountsByAddress.get(profile.address)!;
        account.receiveKey = rotated.publicKey;
        chain.accounts.setLeaf(claimantIndex, accountStateCommitment(profile.address, account.nullifierKeyCommitment,
          account.accountRuleSetCommitment, 0n, 1n, receiveKeyHash(rotated.publicKey)));
        chain.seal();
        throw new Error("inventory note was claimed first");
      }
      throw new Error("captured second claim");
    } },
    wallet: { address: addressHex(profile.address), network: { chainId: CHAIN_ID },
      execute: async (action: (context: unknown) => unknown) => action(ctx) },
  } as unknown as TokensRuntime;
  await assert.rejects(claimDrop(rt, { drop, definition, assetId, funding: [{ contentHash: bytes32Hex(94n), firstIndex: 0, count: 2 }] } as AvailableDrop), /captured second claim/);
  assert.equal(payouts.length, 2);
  assert.ok(decryptEnvelope(oldPair.secretKey, payouts[0]!));
  assert.equal(decryptEnvelope(rotated.secretKey, payouts[0]!), null);
  assert.equal(decryptEnvelope(oldPair.secretKey, payouts[1]!), null);
  assert.ok(decryptEnvelope(rotated.secretKey, payouts[1]!));
});

for (const destination of ["automatic", "address", "code"] as const) test(`unsponsored token claim binds ${destination} self delivery without querying the recipient`, async () => {
  const fixture = await directClaimSnapshotFixture();
  const recipient = destination === "automatic" ? undefined : destination === "address" ? addressHex(profile.address)
    : buildExtendedCode({ chainId: CHAIN_ID, address: profile.address, mlKemPublicKey: profile.mlKemPublicKey });
  await assert.rejects(claimLink(fixture.runtime, fixture.url, { ...(recipient === undefined ? {} : { recipient }) }), /captured unsponsored payout/);
  assert.equal(fixture.proofs(), 1);
  assert.equal(fixture.syncs(), destination === "code" ? 0 : 1);
  assert.equal(fixture.queries.length, 1);
  const transaction = fixture.transaction();
  assert.equal(privateValuePublicInputs(transaction)[1], fixture.targetBlockHash);
  const oldSecret = profile.mlKemSecretKey;
  const intended = destination === "code" ? oldSecret : rotated.secretKey;
  const other = destination === "code" ? rotated.secretKey : oldSecret;
  assert.equal(decryptEnvelope(other, transaction.outputData[0]!), null);
  const plaintext = decryptEnvelope(intended, transaction.outputData[0]!);
  assert.ok(plaintext);
  assert.equal(decodePayload(plaintext, { chainId: CHAIN_ID }).amount, 100n);
});

test("an unsponsored token claim fails before proving when synchronization passes its account snapshot", async () => {
  const fixture = await directClaimSnapshotFixture({ syncPastWitness: true });
  await assert.rejects(claimLink(fixture.runtime, fixture.url), /snapshot/);
  assert.equal(fixture.syncs(), 1);
  assert.equal(fixture.proofs(), 0);
  assert.equal(fixture.queries.length, 1);
});

/**
 * A direct claim whose local state is one block behind the claim's snapshot,
 * in which this wallet's key, and a `thirdParty` recipient's, rotated.
 */
async function directClaimSnapshotFixture(options: { syncPastWitness?: boolean; thirdParty?: ReturnType<typeof testUser> } = {}) {
  const { definition, assetId } = testToken(5n);
  const planned = planClaimLinks({ creatorSecret: 5n, assetId, amounts: [100n] });
  const link: ClaimLink = { contractSeed: planned.contract.contractSeed,
    funding: { contentHash: bytes32Hex(95n), slot: 0 }, amount: 100n, linkKey: planned.links[0]!.linkKey, definition };
  const chain = new SyntheticChain();
  const accountIndex = registerUser(chain, profile);
  const thirdPartyIndex = options.thirdParty === undefined ? undefined : registerUser(chain, options.thirdParty);
  chain.addContract(planned.contract);
  const note = claimLinkNote(planned.contract, { ...link, leafIndex: 0 });
  chain.appendBody(noteBodyCommitment(ownerCommitment(note.owner, note.noteSecret), assetId, note.amount));
  chain.seal();
  const backend = chain.node();
  const initialAccount = await backend.getAccountProof(addressHex(profile.address));
  assert.equal(initialAccount.status, "present");
  if (initialAccount.status !== "present") throw new Error("fixture account missing");
  let localAccount = initialAccount.account;
  let localRoot = chain.head.state.accountStateRoot;
  const localKeys = new Map(options.thirdParty === undefined ? [] : [[options.thirdParty.address, options.thirdParty.mlKemPublicKey]]);
  const setKey = (address: bigint, index: number, key: Uint8Array) => {
    const account = chain.accountsByAddress.get(address)!;
    account.receiveKey = key;
    chain.accounts.setLeaf(index, accountStateCommitment(address, account.nullifierKeyCommitment,
      account.accountRuleSetCommitment, 0n, 1n, receiveKeyHash(key)));
  };
  const replaceKey = (key: Uint8Array) => {
    setKey(profile.address, accountIndex, key);
    chain.seal();
  };
  const thirdPartyKey = generateMlKemKeyPair(new Uint8Array(64).fill(84));
  if (options.thirdParty !== undefined) setKey(options.thirdParty.address, thirdPartyIndex!, thirdPartyKey.publicKey);
  replaceKey(rotated.publicKey);
  const targetBlockHash = chain.head.hash;
  const third = generateMlKemKeyPair(new Uint8Array(64).fill(82));
  const pairs = [{ publicKey: profile.mlKemPublicKey, secretKey: profile.mlKemSecretKey }, rotated, third];
  const queries: string[][] = [];
  const node = { ...backend, status: async () => ({ latestBlockTimestamp: chain.timestamp }),
    getReceipt: async () => [{ outcome: "succeeded", outputLeafStart: 0n }],
    getWitnessSnapshot: async (query: Parameters<typeof backend.getWitnessSnapshot>[0]) => {
      assert.deepEqual(query.accounts, [addressHex(planned.contract.address)]);
      queries.push([...(query.accounts ?? [])]);
      return backend.getWitnessSnapshot(query);
    },
    getAccountProof: async () => { throw new Error("recipient-specific account queries are not allowed"); },
  };
  let syncs = 0;
  let proofs = 0;
  let transaction: Extract<ReturnType<typeof decodeTransaction>, { kind: 0 }> | undefined;
  const ctx = { profile, node, network: { chainId: CHAIN_ID }, store: {
    load: async () => ({ pendingAssetActions: [], receiveKeys: pairs.map(pair => ({
      receiveKeyHash: bytes32Hex(receiveKeyHash(pair.publicKey)), mlKemPublicKey: toHex(pair.publicKey), mlKemSecretKey: toHex(pair.secretKey),
    })) }),
    readChain: async (read: (chain: unknown) => unknown) => read({
      requireAnchor: () => ({ state: { accountStateRoot: localRoot } }),
      accountRoot: () => localRoot,
      accountResult: () => localAccount,
      receiveKey: (address: string) => localKeys.get(BigInt(address)) ?? null,
    }),
  }, synchronize: async () => {
    syncs++;
    if (options.syncPastWitness === true) replaceKey(third.publicKey);
    const account = await backend.getAccountProof(addressHex(profile.address));
    if (account.status !== "present") throw new Error("fixture account missing");
    localAccount = account.account;
    localRoot = chain.head.state.accountStateRoot;
    for (const address of localKeys.keys()) localKeys.set(address, chain.accountsByAddress.get(address)!.receiveKey!);
  } };
  const runtime = { node, prover: { proveAssetAction: async () => { proofs++; return { proof: new Uint8Array(WIRE_PROOF_BYTES) }; } },
    submission: { mode: "mempool", preflight: async ({ transactionBytes }: { transactionBytes: Uint8Array }) => {
      const decoded = decodeTransaction(transactionBytes);
      if (decoded.kind !== 0) throw new Error("expected private-value claim");
      transaction = decoded;
      throw new Error("captured unsponsored payout");
    } },
    wallet: { address: addressHex(profile.address), network: { chainId: CHAIN_ID },
      execute: async (action: (context: unknown) => unknown) => action(ctx) },
  } as unknown as TokensRuntime;
  return { runtime, url: formatClaimLinkUrl(link, "https://example.test/claim"), queries, targetBlockHash, thirdPartyKey,
    proofs: () => proofs, syncs: () => syncs,
    transaction: () => { assert.ok(transaction); return transaction; } };
}
