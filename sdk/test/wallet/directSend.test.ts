// Direct sends: a payment to an address with no receive key, delivered by a
// link carrying its opening. The wallets here run their real transfer, setup,
// and synchronization paths against a simulated chain; proofs are stand-ins.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rootFromIndex } from "@pcash/sdk/crypto";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { formatDirectSendLink, memoSchema, parseDirectSendLink } from "@pcash/sdk/delivery";
import {
  claimedSenderSchema,
  decodeDirectSendOpening,
  directSendOpeningsSchema,
  directSendOutputCommitment,
  encodeDirectSendOpening,
  sentOpeningsSchema,
  WIRE_PROOF_BYTES,
  type DirectSendOpening,
} from "@pcash/sdk/protocol";
import { addressHex, fromHex, toHex } from "@pcash/sdk/utils";
import { resumeValueTransaction } from "../../src/wallet/actions/resumeValueTransaction.ts";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { syncWallet } from "../../src/wallet/actions/syncWallet.ts";
import { createWalletRuntime } from "../../src/wallet/actions/walletRuntime.ts";
import { NativeActivityReader } from "../../src/wallet/actions/nativeActivity.ts";
import type { DurableSubmissionAdapter } from "../../src/wallet/actions/durableSubmission.ts";
import { derivePcashProfileFromPrivateKey, type PcashProfile } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStoreBackend } from "../../src/wallet/memoryStoreBackend.ts";
import { walletStore, type WalletStateStore } from "../../src/wallet/store.ts";
import { privateBalance, spendableBalance } from "../../src/wallet/noteStore.ts";
import {
  addDirectSendOpening,
  directSendsToRecord,
  inspectDirectSend,
  paidDirectSends,
  receivedDirectSends,
} from "../../src/wallet/directSends.ts";
import { ChainSim } from "./chainFixture.ts";

const CHAIN_ID = 0x1ff6n;
const NETWORK = { pcashChainId: CHAIN_ID, l1ChainId: 11_155_111n, inboxAddress: `0x${"66".repeat(20)}` };

const prover = {
  proveAndEncode: async (build: { encodeTransaction(proof: Uint8Array): Uint8Array }) =>
    build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)),
};

interface Actor {
  profile: PcashProfile;
  signer: ReturnType<typeof privateKeyPcashActionSigner>;
  account: { address: string; nullifierKeyCommitment: bigint; accountRuleSetCommitment: bigint; receiveKey: Uint8Array };
}

function actor(): Actor {
  const privateKey = new Uint8Array(randomBytes(32));
  const profile = derivePcashProfileFromPrivateKey(privateKey, NETWORK);
  const rules = defaultUserAccountRuleSet({ wallet: profile, network: NETWORK, secrets: profile.defaultUserRuleSecrets });
  return {
    profile,
    signer: privateKeyPcashActionSigner(privateKey),
    account: {
      address: addressHex(profile.address),
      nullifierKeyCommitment: profile.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment,
      receiveKey: profile.mlKemPublicKey,
    },
  };
}

function storeFor(sim: ChainSim, wallet: Actor): WalletStateStore {
  return walletStore(memoryWalletStoreBackend(), { address: wallet.profile.address, network: { chainId: CHAIN_ID, genesisHash: sim.genesisHash } });
}

function sync(sim: ChainSim, wallet: Actor, store: WalletStateStore, options: { anchorAtCurrentBoundary?: boolean } = {}) {
  return syncWallet({ node: sim.client(), wallet: wallet.profile, chainId: CHAIN_ID, store, ...options });
}

/** Publication that includes every transaction it is handed in a new block. */
function including(sim: ChainSim): DurableSubmissionAdapter<string, string> {
  return {
    mode: "l1",
    preflight: async () => "prepared",
    submit: async ({ transactionBytes }) => {
      sim.include(transactionBytes);
      return { accepted: true, queued: false, output: "accepted" };
    },
  };
}

function runtime(sim: ChainSim, wallet: Actor, store: WalletStateStore) {
  const submission = including(sim);
  return createWalletRuntime({
    node: sim.client(), chainId: CHAIN_ID, wallet: wallet.profile, signer: wallet.signer, store,
    provers: { privateValue: prover as never }, submission, userAccountCreationSubmission: submission,
    settlePollIntervalMs: 0, settlePollMaxAttempts: 3,
  });
}

/** A chain where `payer` holds a 10 PCASH note, and a direct send of `amount` from it to `payee`. */
async function directSend(amount: bigint, payee: Actor, options: { payeeRegistered?: boolean; memo?: string; includeSender?: boolean } = {}) {
  const sim = new ChainSim(CHAIN_ID);
  sim.servesFundingReads = true;
  const payer = actor();
  sim.addBlock({
    accounts: [payer.account, ...(options.payeeRegistered === true ? [payee.account] : [])],
    transactions: [{ outputs: [{ owner: payer.profile.address, receiveKey: payer.profile.mlKemPublicKey, amount: 10n }, null, null, null, null] }],
  });
  const payerStore = storeFor(sim, payer);
  await sync(sim, payer, payerStore);
  const to = addressHex(payee.profile.address);
  const records = [...options.memo === undefined ? [] : [memoSchema.encode(options.memo)],
    ...options.includeSender === true ? [claimedSenderSchema.encode(payer.profile.address)] : []];
  const result = await runtime(sim, payer, payerStore).transfer({
    to, amount, openFeeAmount: 0n, directSend: true, ...(records.length === 0 ? {} : { data: { recipients: [{ to, records }] } }),
  });
  await sync(sim, payer, payerStore);
  const [paid] = paidDirectSends(await payerStore.load(), CHAIN_ID);
  return { sim, payer, payerStore, result, opening: paid!.opening };
}

describe("direct-send opening", () => {
  const opening: DirectSendOpening = {
    chainId: CHAIN_ID, contentHash: toHex(new Uint8Array(randomBytes(32))).toLowerCase(), slot: 3,
    owner: 0xabcdn << 140n, amount: 12_345n, noteSecret: 0x5eedn,
  };

  it("is the same bytes in the link and in the sender-region record", () => {
    const encoded = encodeDirectSendOpening(opening);
    expect(encoded).toHaveLength(106);
    expect(decodeDirectSendOpening(encoded)).toEqual(opening);
    const link = formatDirectSendLink(opening, "https://pcash.example/receive#old");
    expect(link.startsWith("https://pcash.example/receive#")).toBe(true);
    expect(parseDirectSendLink(link)).toEqual(opening);
    expect(parseDirectSendLink(link.slice(link.indexOf("#") + 1))).toEqual(opening);
    const other = { ...opening, slot: 0 };
    const record = directSendOpeningsSchema.encode([opening, other]);
    expect(record.data).toEqual(Uint8Array.from([...encodeDirectSendOpening(other), ...encoded]));
    expect(directSendOpeningsSchema.decode(record.data)).toEqual([other, opening]);
  });

  it("rejects malformed openings and records", () => {
    const encoded = encodeDirectSendOpening(opening);
    expect(() => decodeDirectSendOpening(encoded.subarray(1))).toThrow("wrong length");
    expect(() => decodeDirectSendOpening(Uint8Array.from([2, ...encoded.subarray(1)]))).toThrow("version 2");
    const zero = Uint8Array.from(encoded);
    zero.fill(0, 58, 74);
    expect(() => decodeDirectSendOpening(zero)).toThrow("amount");
    const slot = Uint8Array.from(encoded);
    slot[37] = 32;
    expect(() => decodeDirectSendOpening(slot)).toThrow("slot");
    expect(() => directSendOpeningsSchema.encode([opening, opening])).toThrow("repeat");
    expect(() => directSendOpeningsSchema.decode(Uint8Array.from([...encoded, ...encoded]))).toThrow("ascending");
  });

  it("flags a direct send among the sender's openings", () => {
    const entries = [{ slot: 0, directSend: true as const, recipientAddress: opening.owner, assetId: 0n, amount: 5n, noteSecret: 7n },
      { slot: 2, recipientAddress: opening.owner, assetId: 0n, amount: 6n, noteSecret: 8n }];
    expect(sentOpeningsSchema.decode(sentOpeningsSchema.encode(entries).data)).toEqual(entries);
  });
});

describe("sending to an address with no PCASH account", () => {
  it("is refused unless the payment is a direct send", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const payer = actor();
    sim.addBlock({
      accounts: [payer.account],
      transactions: [{ outputs: [{ owner: payer.profile.address, receiveKey: payer.profile.mlKemPublicKey, amount: 10n }, null, null, null, null] }],
    });
    const store = storeFor(sim, payer);
    await sync(sim, payer, store);
    await expect(runtime(sim, payer, store).transfer({ to: addressHex(actor().profile.address), amount: 4n, openFeeAmount: 0n }))
      .rejects.toThrow("no published ML-KEM receive key");
    // A contract account's notes answer to its rules, so no link can deliver one.
    const contract = actor();
    sim.addBlock({ accounts: [{ ...contract.account, accountKind: 1, receiveKey: null }] });
    await sync(sim, payer, store);
    await expect(runtime(sim, payer, store).transfer({ to: contract.account.address, amount: 4n, openFeeAmount: 0n, directSend: true }))
      .rejects.toThrow("contract account");
  });

  it("pays a note under a secret only the payer's keys derive and rebuilds the link from the seed", async () => {
    const payee = actor();
    const { sim, payer, payerStore, result, opening } = await directSend(4n, payee);
    expect(result.settled).toBe(true);
    expect(opening).toMatchObject({ chainId: CHAIN_ID, contentHash: result.contentHash.toLowerCase(), slot: 0, owner: payee.profile.address, amount: 4n });
    expect(await inspectDirectSend(sim.client(), opening)).toMatchObject({ status: "landed" });
    expect((await payerStore.load())!.sentOutputs!.find((output) => output.slot === 0)).toMatchObject({ directSend: true, amount: "4" });

    // A device restored from the payer's seed copies the same link.
    const restored = storeFor(sim, payer);
    await sync(sim, payer, restored);
    expect(paidDirectSends(await restored.load(), CHAIN_ID)).toEqual([{ opening, included: true }]);
  });
});

describe("a direct send's memo", () => {
  it("reaches whoever holds the link, and the payer's seed", async () => {
    const payee = actor();
    const { sim, payer, result, opening } = await directSend(4n, payee, { memo: "Dinner, thanks!", includeSender: true });
    sim.finalityLag = 10n;
    const memo = toHex(new TextEncoder().encode("Dinner, thanks!"));
    const payerAddress = addressHex(payer.profile.address);
    // The receive page reads it before the payee has a wallet.
    expect(await inspectDirectSend(sim.client(), opening)).toMatchObject({ status: "landed", memo: "Dinner, thanks!", sender: payerAddress });

    const store = storeFor(sim, payee);
    await sync(sim, payee, store);
    await store.transaction((data) => (addDirectSendOpening(data!, opening), { data: data!, value: undefined }));
    const received = async () => (await store.load())!.notes.find((note) => BigInt(note.noteSecret) === opening.noteSecret);
    await sync(sim, payee, store);
    expect(await received()).toMatchObject({ memo, sender: payerAddress });
    // A scan that reaches the funding output with the opening already kept reads it too.
    sim.reorg(sim.head.number - 1n, [{ transactions: [{ outputs: [null, null, null, null, null] }] }]);
    sim.include(fromHex(result.transactionHex));
    await sync(sim, payee, store);
    expect(await received()).toMatchObject({ memo, sender: payerAddress });

    const restored = storeFor(sim, payer);
    expect((await sync(sim, payer, restored)).data.sentOutputs!.find((output) => output.slot === 0))
      .toMatchObject({ directSend: true, memo, senderIncluded: true });
  });
});

describe("receiving a direct send", () => {
  it("adds a passed output with its path, records it in setup, and a restore across pages finds it", async () => {
    const payee = actor();
    const { sim, opening } = await directSend(4n, payee);
    // The payee's wallet already synchronized past the funding output.
    const store = storeFor(sim, payee);
    await sync(sim, payee, store);
    await store.transaction((data) => {
      expect(addDirectSendOpening(data!, opening)).toBe(true);
      return { data: data!, value: undefined };
    });
    const imported = (await sync(sim, payee, store)).data;
    expect(receivedDirectSends(imported)).toEqual([{ opening, state: "received", saved: false }]);
    expect(spendableBalance(imported)).toBe(4n);
    const note = imported.notes.find((candidate) => BigInt(candidate.noteSecret) === opening.noteSecret)!;
    const leafIndex = BigInt(note.leafIndex!);
    const paths = await store.readChain((chain) => ({ root: chain!.requireAnchor().state.outputRoot, siblings: chain!.outputPaths([{ outputIndex: leafIndex }]).paths[0]!.siblings }));
    expect(rootFromIndex(directSendOutputCommitment(opening, leafIndex), leafIndex, paths.siblings)).toBe(paths.root);

    // Importing the same link again changes nothing.
    await store.transaction((data) => {
      expect(addDirectSendOpening(data!, opening)).toBe(false);
      return { data: data!, value: undefined };
    });
    expect((await sync(sim, payee, store)).data.notes.filter((candidate) => !candidate.pending)).toHaveLength(1);

    // Setup's mining action carries the encrypted record.
    const activation = await runtime(sim, payee, store).prepareAccountActivation({ authorizationMode: "direct", mine: true });
    sim.include(fromHex(activation.transactionHex), { accounts: [payee.account] });
    const setUp = (await sync(sim, payee, store)).data;
    expect(receivedDirectSends(setUp)).toEqual([{ opening, state: "received", saved: true }]);

    // Clearing storage and restoring from the seed finds the payment from that record.
    sim.pageSize = 5;
    const restored = (await sync(sim, payee, storeFor(sim, payee))).data;
    expect(receivedDirectSends(restored)).toEqual([{ opening, state: "received", saved: true }]);
    expect(spendableBalance(restored)).toBe(4n);
    expect(restored.notes.find((candidate) => BigInt(candidate.noteSecret) === opening.noteSecret)?.cursor)
      .toMatchObject({ kind: "ordinary", transactionId: note.cursor!.transactionId });
  });

  it("restores an already registered payee's receipt, first spend, and balance from the spend's record", async () => {
    const payee = actor();
    const { sim, payer, opening } = await directSend(10n, payee, { payeeRegistered: false });
    sim.addBlock({ accounts: [payee.account] });
    const store = storeFor(sim, payee);
    await sync(sim, payee, store);
    await store.transaction((data) => (addDirectSendOpening(data!, opening), { data: data!, value: undefined }));
    await sync(sim, payee, store);
    expect(directSendsToRecord(await store.load(), payee.profile.address)).toEqual([opening]);

    // The first payment that spends the note records its opening.
    const spend = await runtime(sim, payee, store).transfer({ to: addressHex(payer.profile.address), amount: 3n, openFeeAmount: 0n });
    expect(spend.settled).toBe(true);
    expect(receivedDirectSends((await sync(sim, payee, store)).data)).toEqual([{ opening, state: "spent", saved: true }]);

    sim.pageSize = 5;
    const restoredStore = storeFor(sim, payee);
    const restored = (await sync(sim, payee, restoredStore)).data;
    expect(receivedDirectSends(restored)).toEqual([{ opening, state: "spent", saved: true }]);
    expect(privateBalance(restored)).toBe(7n);
    const history = await new NativeActivityReader().read(restored, restoredStore, payee.profile);
    if (history.state !== "ready") throw new Error(`history unavailable: ${history.reason}`);
    expect(history.entries.map(({ direction, amount, contentHash }) => ({ direction, amount, contentHash })))
      .toEqual([{ direction: "spent", amount: 3n, contentHash: spend.contentHash.toLowerCase() }, { direction: "received", amount: 10n, contentHash: undefined }]);
  });

  it("adds an output older than the wallet's birthday, and a restore from there never revives the spent note", async () => {
    const payee = actor();
    const { sim, payer, opening } = await directSend(10n, payee);
    sim.addBlock({ accounts: [payee.account] });
    const store = storeFor(sim, payee);
    await sync(sim, payee, store, { anchorAtCurrentBoundary: true });
    // A second device born at the same block, before it knows the opening.
    const restored = storeFor(sim, payee);
    await sync(sim, payee, restored, { anchorAtCurrentBoundary: true });
    await store.transaction((data) => (addDirectSendOpening(data!, opening), { data: data!, value: undefined }));
    expect(spendableBalance((await sync(sim, payee, store)).data)).toBe(10n);
    sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }] });
    await runtime(sim, payee, store).transfer({ to: addressHex(payer.profile.address), amount: 6n, openFeeAmount: 0n });
    for (let index = 0; index < 4; index++) sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }] });

    // The record in the spend reveals the opening after the scan passed the funding output.
    sim.pageSize = 5;
    const data = (await sync(sim, payee, restored)).data;
    expect(receivedDirectSends(data)).toEqual([{ opening, state: "spent", saved: true }]);
    expect(privateBalance(data)).toBe(4n);
  });

  it("follows a reorganization that includes the same funding bytes at another leaf", async () => {
    const payee = actor();
    const { sim, opening, result } = await directSend(4n, payee);
    sim.finalityLag = 10n;
    const store = storeFor(sim, payee);
    await sync(sim, payee, store);
    await store.transaction((data) => (addDirectSendOpening(data!, opening), { data: data!, value: undefined }));
    const before = (await sync(sim, payee, store)).data.notes.find((note) => BigInt(note.noteSecret) === opening.noteSecret)!;

    const funding = sim.block(sim.head.number);
    expect(funding.outputs.some((output) => output.kind === "ordinary" && output.contentHash.toLowerCase() === result.contentHash.toLowerCase())).toBe(true);
    const entry = fromHex(result.transactionHex);
    sim.reorg(funding.number - 1n, [{ transactions: [{ outputs: [null, null, null, null, null] }] }]);
    sim.include(entry);
    const after = (await sync(sim, payee, store)).data;
    const moved = after.notes.filter((note) => BigInt(note.noteSecret) === opening.noteSecret);
    expect(moved).toHaveLength(1);
    expect(BigInt(moved[0]!.leafIndex!)).toBe(BigInt(before.leafIndex!) + 5n);
    expect(moved[0]!.commitment).not.toBe(before.commitment);
    expect(spendableBalance(after)).toBe(4n);
    const leafIndex = BigInt(moved[0]!.leafIndex!);
    const paths = await store.readChain((chain) => ({ root: chain!.requireAnchor().state.outputRoot, siblings: chain!.outputPaths([{ outputIndex: leafIndex }]).paths[0]!.siblings }));
    expect(rootFromIndex(directSendOutputCommitment(opening, leafIndex), leafIndex, paths.siblings)).toBe(paths.root);
  });

  it("keeps a note another device on the same seed spent spent when a wallet born after its record imports the link", async () => {
    const payee = actor();
    const { sim, payer, opening } = await directSend(10n, payee);
    const first = storeFor(sim, payee);
    await sync(sim, payee, first, { anchorAtCurrentBoundary: true });
    await first.transaction((data) => (addDirectSendOpening(data!, opening), { data: data!, value: undefined }));
    await sync(sim, payee, first);
    const activation = await runtime(sim, payee, first).prepareAccountActivation({ authorizationMode: "direct", mine: true });
    sim.include(fromHex(activation.transactionHex), { accounts: [payee.account] });
    expect(receivedDirectSends((await sync(sim, payee, first)).data)).toEqual([{ opening, state: "received", saved: true }]);
    // A second device is born after the final setup record, then the first spends with no record.
    const second = storeFor(sim, payee);
    await sync(sim, payee, second, { anchorAtCurrentBoundary: true });
    await runtime(sim, payee, first).transfer({ to: addressHex(payer.profile.address), amount: 6n, openFeeAmount: 0n });
    sim.pageSize = 5;
    await sync(sim, payee, second);
    await second.transaction((data) => (addDirectSendOpening(data!, opening), { data: data!, value: undefined }));
    const imported = (await sync(sim, payee, second)).data;
    expect(receivedDirectSends(imported)).toEqual([{ opening, state: "spent", saved: false }]);
    expect(privateBalance(imported)).toBe(4n);
  });

  it.each(["resume", "expired", "included"] as const)("reconciles retained funding after a late direct-send import older than the wallet birthday: %s", async mode => {
    const payee = actor();
    const { sim, payer, opening } = await directSend(10n, payee);
    sim.addBlock({ accounts: [payee.account] });
    const store = storeFor(sim, payee);
    await sync(sim, payee, store, { anchorAtCurrentBoundary: true });
    await store.transaction(data => (addDirectSendOpening(data!, opening), { data: data!, value: undefined }));
    const imported = (await sync(sim, payee, store)).data;
    const importedNote = imported.notes.find(note => BigInt(note.noteSecret) === opening.noteSecret)!;
    expect(await store.readChain(chain => BigInt(importedNote.leafIndex!) < chain!.birthday.outputCount)).toBe(true);
    const deadline = sim.head.envelope.header.timestamp + 60n;
    let transactionHex = "";
    await expect(runtime(sim, payee, store).transfer({
      to: addressHex(payer.profile.address), amount: 3n, openFeeAmount: 0n, validUntilTimestamp: deadline,
      beforeJournal: (_hash, hex) => { transactionHex = hex; throw new Error("interrupted after application checkpoint"); },
    })).rejects.toThrow("interrupted after application checkpoint");
    expect((await store.load())!.pendingNoteFundedTransfers).toBeUndefined();
    if (mode === "included") sim.include(fromHex(transactionHex));
    if (mode !== "resume") sim.addBlock({ timestamp: deadline + 1n });
    await sync(sim, payee, store);
    const node = new Proxy(sim.client(), { get(target, property) {
      if (property === "getReceipt" && mode === "included") return async () => [];
      if (property === "getBlockByHash") return async (hash: string) => {
        for (let number = sim.head.number; number >= 0n; number--) {
          const block = sim.block(number);
          if (BigInt(hash) === block.hash) return { timestamp: block.envelope.header.timestamp };
        }
        return null;
      };
      return Reflect.get(target, property, target);
    } }) as PcashNodeClient;
    const result = await resumeValueTransaction({ transactionHex, node, store, wallet: payee.profile,
      chainId: CHAIN_ID, submission: including(sim), synchronize: () => sync(sim, payee, store) });
    expect(result.state).toBe(mode === "resume" ? "accepted" : mode === "expired" ? "rebuildable" : "pending");
    if (mode === "resume") {
      const settled = (await sync(sim, payee, store)).data;
      expect(receivedDirectSends(settled)).toEqual([{ opening, state: "spent", saved: true }]);
      expect(privateBalance(settled)).toBe(7n);
    }
  });

  it("keeps one opening per output, with its earliest record", async () => {
    const payee = actor();
    const { sim, opening } = await directSend(4n, payee);
    const store = storeFor(sim, payee);
    const data = (await sync(sim, payee, store)).data;
    expect(addDirectSendOpening(data, opening, { leafIndex: "9", blockNumber: "3", blockHash: "0x03" })).toBe(true);
    // The earliest record stays: a later one can be reorganized away while the first remains.
    expect(addDirectSendOpening(data, opening, { leafIndex: "20", blockNumber: "5", blockHash: "0x05" })).toBe(false);
    expect(addDirectSendOpening(data, { ...opening, amount: 1n })).toBe(false);
    expect(data.directSendOpenings).toEqual([{ opening: toHex(encodeDirectSendOpening(opening)), record: { leafIndex: "9", blockNumber: "3", blockHash: "0x03" } }]);
  });

  it("keeps the path of a passed note whose spend a reorganization can still remove", async () => {
    const payee = actor();
    const { sim, payer, opening } = await directSend(10n, payee);
    sim.addBlock({ accounts: [payee.account] });
    sim.finalityLag = 10n;
    // A second device passes the funding output before it knows the opening.
    const second = storeFor(sim, payee);
    await sync(sim, payee, second);
    const first = storeFor(sim, payee);
    await sync(sim, payee, first);
    await first.transaction((data) => (addDirectSendOpening(data!, opening), { data: data!, value: undefined }));
    await sync(sim, payee, first);
    await runtime(sim, payee, first).transfer({ to: addressHex(payer.profile.address), amount: 3n, openFeeAmount: 0n });
    const spendBlock = sim.head.number;
    // The spend's record tells the second device the opening and the spend together.
    expect(receivedDirectSends((await sync(sim, payee, second)).data)).toEqual([{ opening, state: "spent", saved: false }]);

    sim.reorg(spendBlock - 1n, [{ transactions: [{ outputs: [null, null, null, null, null] }] }]);
    const data = (await sync(sim, payee, second)).data;
    expect(receivedDirectSends(data)).toEqual([{ opening, state: "received", saved: false }]);
    expect(spendableBalance(data)).toBe(10n);
    await runtime(sim, payee, second).transfer({ to: addressHex(payer.profile.address), amount: 3n, openFeeAmount: 0n });
    const spent = (await sync(sim, payee, second)).data;
    expect(receivedDirectSends(spent)).toEqual([{ opening, state: "spent", saved: false }]);
    expect(privateBalance(spent)).toBe(7n);
  });

  it("tells a link whose output holds another note from one not yet accepted", async () => {
    const payee = actor();
    const { sim, opening } = await directSend(4n, payee);
    expect(await inspectDirectSend(sim.client(), { ...opening, amount: 5n })).toEqual({ status: "invalid" });
    expect(await inspectDirectSend(sim.client(), { ...opening, slot: 7 })).toEqual({ status: "invalid" });
    expect(await inspectDirectSend(sim.client(), { ...opening, contentHash: toHex(new Uint8Array(32)).toLowerCase() })).toEqual({ status: "pending" });
    // A mismatched opening that reaches a wallet adds nothing.
    const store = storeFor(sim, payee);
    await sync(sim, payee, store);
    await store.transaction((data) => (addDirectSendOpening(data!, { ...opening, amount: 5n }), { data: data!, value: undefined }));
    const data = (await sync(sim, payee, store)).data;
    expect(receivedDirectSends(data)).toEqual([{ opening: { ...opening, amount: 5n }, state: "waiting", saved: false }]);
    expect(privateBalance(data)).toBe(0n);
  });

  it("records in setup every unsaved opening its sender region holds", async () => {
    const payee = actor();
    const sim = new ChainSim(CHAIN_ID);
    const store = storeFor(sim, payee);
    await sync(sim, payee, store);
    const openings = Array.from({ length: 30 }, (_, index): DirectSendOpening => ({
      chainId: CHAIN_ID, contentHash: toHex(new Uint8Array(randomBytes(32))).toLowerCase(), slot: 0,
      owner: payee.profile.address, amount: BigInt(index + 1), noteSecret: BigInt(index + 1),
    }));
    await store.transaction((data) => {
      for (const opening of openings) addDirectSendOpening(data!, opening);
      return { data: data!, value: undefined };
    });
    expect(directSendsToRecord(await store.load(), payee.profile.address)).toHaveLength(24);
    // Spends record only the openings they spend.
    expect(directSendsToRecord(await store.load(), payee.profile.address, [
      { owner: addressHex(payee.profile.address), noteSecret: "0x1d", amount: "29", assetId: "0x0" },
    ]).map((opening) => opening.amount)).toEqual([29n]);
  });
});
