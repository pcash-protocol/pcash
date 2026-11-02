import { memoSchema } from "@pcash/sdk/delivery";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hashTypedData, recoverAddress } from "viem";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { accountCreationTypedData, privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import {
  decodeTransaction,
  encodePrivateValueTransaction,
  generateMlKemKeyPair,
  noteBodyCommitment,
  ownerCommitment,
  receiveKeyHash,
  WIRE_PROOF_BYTES,
} from "@pcash/sdk/protocol";
import { addressHex, bytesToBigInt, concatBytes, toHex, utf8 } from "@pcash/sdk/utils";
import { fieldToHex } from "@pcash/sdk/crypto";
import { type Wallet } from "@pcash/sdk/wallet";
import type { DurableSubmissionAdapter } from "@pcash/sdk/wallet";
import { openNodeWallet } from "../src/node/walletClient.ts";
import { deriveSeedWalletIdentity } from "@pcash/sdk/wallet";
import { inventoryPath, openKeystore } from "../src/service/credentials.ts";
import { ChainSim } from "./chainFixture.ts";
import { createWalletRuntime } from "@pcash/sdk/wallet/testing";
import { memoryWalletStateStore } from "@pcash/sdk/wallet/testing";
import { emptyWalletState } from "@pcash/sdk/wallet/testing";

const MNEMONIC = `${"abandon ".repeat(23)}art`;
const NETWORK = {
  pcashChainId: 123456n,
  l1ChainId: 11155111n,
  inboxAddress: "0x1111111111111111111111111111111111111111",
};
const BOB = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MEMO = "seed-vault-recovery payment to Bob";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** The fixture supplies canonical state and bypasses proof verification only. */
function recoveryNode(sim: ChainSim): PcashNodeClient {
  const node = sim.client();
  node.status = async () => ({ ...sim.status(), acceptedTransactionTypes: [0, 1, 2, 3] });
  node.getBlock = async (number) => ({ hash: fieldToHex(sim.block(BigInt(number)).hash), timestamp: sim.block(BigInt(number)).envelope.header.timestamp } as Awaited<ReturnType<PcashNodeClient["getBlock"]>>);
  return node;
}

async function openSeedWallet(
  directory: string,
  password: string,
  node: PcashNodeClient,
  submission: DurableSubmissionAdapter<null, null>,
) {
  const keystore = await openKeystore(directory, password);
  const identity = deriveSeedWalletIdentity(MNEMONIC, NETWORK);
  if (keystore.store.wallets.length === 0) {
    keystore.store.wallets.push({ address: addressHex(identity.profile.address), mnemonic: MNEMONIC });
    keystore.save();
  }
  const stored = keystore.store.wallets[0]!;
  const restored = deriveSeedWalletIdentity(stored.mnemonic, NETWORK);
  const wallet = await openNodeWallet({
    dataDir: inventoryPath(directory),
    storageCipher: keystore.storageCipher,
    node,
    profile: restored.profile,
    signer: privateKeyPcashActionSigner(restored.privateKey),
    submission,
    settlePollIntervalMs: 0,
    settlePollMaxAttempts: 2,
    provers: { privateValue: { proveAndEncode: async (build) => build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)) } },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await wallet.close();
    keystore.close();
  };
  cleanups.push(close);
  return { wallet, close, identity: restored };
}

async function expectRecoveredHistory(wallet: Wallet) {
  expect(await wallet.balances()).toEqual([{ assetId: 0n, private: 90n, spendable: 90n }]);
  expect((await wallet.notes()).map((note) => [note.amount, note.status])).toEqual([
    [100n, "spent"], [74n, "spendable"], [7n, "spendable"], [2n, "spendable"], [7n, "spendable"],
  ]);
  const activity = await wallet.nativeActivity();
  expect(activity.state).toBe("ready");
  if (activity.state !== "ready") throw new Error("fixture history is unavailable");
  expect(activity.entries.flatMap((entry) => entry.sent ?? [])).toEqual([{
    recipientAddress: BigInt(BOB), amount: 25n, memo: utf8(MEMO), senderIncluded: false,
  }]);
  expect(activity.entries.filter((entry) => entry.payout !== null).map((entry) => entry.payout)).toEqual([
    { openFeeAmount: 2n, issuanceAmount: 7n },
    { openFeeAmount: 0n, issuanceAmount: 7n },
  ]);
}

it("registers with the seed signer and restores payments, sent records, change and payouts into a new encrypted vault", async () => {
  const root = mkdtempSync(join(tmpdir(), "pcash-seed-recovery-"));
  const firstDirectory = join(root, "first");
  const restoredDirectory = join(root, "restored");
  const sim = new ChainSim(NETWORK.pcashChainId, NETWORK);
  // One whole transaction per output page: records, sender regions and their
  // arenas arrive with the page that holds their transaction.
  sim.pageSize = 5;
  const node = recoveryNode(sim);
  const bobKeys = generateMlKemKeyPair(new Uint8Array(64).fill(0x55));
  const submittedKinds: number[] = [];
  const submission: DurableSubmissionAdapter<null, null> = {
    mode: "mempool",
    preflight: async () => null,
    submit: async ({ transactionBytes }) => {
      const action = decodeTransaction(transactionBytes);
      submittedKinds.push(action.kind);
      const decoded = action.kind === 0 && action.accountCreation?.kind === "user" ? decodeTransaction(action.accountCreation.transactionBytes) : action;
      if (decoded.kind === 1) {
        expect(decoded.authorization.kind).toBe("signed");
        if (decoded.authorization.kind !== "signed" || decoded.mlKemPublicKey === null) {
          throw new Error("fixture requires a signed creation with a receive key");
        }
        const typed = accountCreationTypedData(NETWORK, {
          pcashChainId: NETWORK.pcashChainId,
          nullifierKeyCommitment: bytesToBigInt(decoded.nullifierKeyCommitment),
          ruleSetCommitment: bytesToBigInt(decoded.ruleSetCommitment),
          receiveKeyHash: receiveKeyHash(decoded.mlKemPublicKey),
          recentPcashBlockHash: bytesToBigInt(decoded.recentPcashBlockHash),
          validUntilTimestamp: decoded.validUntilTimestamp,
        });
        const signer = await recoverAddress({
          hash: hashTypedData(typed as never),
          signature: toHex(concatBytes(decoded.authorization.sigR, decoded.authorization.sigS,
            Uint8Array.of(decoded.authorization.yParity + 27))) as `0x${string}`,
        });
        expect(signer.toLowerCase()).toBe("0xf278cf59f82edcf871d630f28ecc8056f25c1cdb");
        sim.include(transactionBytes, { accounts: [
          { address: signer, nullifierKeyCommitment: bytesToBigInt(decoded.nullifierKeyCommitment),
            accountRuleSetCommitment: bytesToBigInt(decoded.ruleSetCommitment), receiveKey: decoded.mlKemPublicKey },
          { address: BOB, nullifierKeyCommitment: 7n, accountRuleSetCommitment: 9n, receiveKey: bobKeys.publicKey },
        ] });
      } else {
        expect(decoded.kind).toBe(0);
        sim.include(transactionBytes);
      }
      return { accepted: true, queued: false, output: null };
    },
  };
  const first = await openSeedWallet(firstDirectory, "first test vault password", node, submission);
  await first.wallet.prepareAccountActivation();
  await expect(first.wallet.submitAccountActivation()).resolves.toMatchObject({ accepted: true });
  await first.wallet.sync();
  expect(await first.wallet.defaultAccountReady()).toBe(true);

  sim.addBlock({ transactions: [{ outputs: [{
    owner: first.identity.profile.address, receiveKey: first.identity.profile.mlKemPublicKey,
    amount: 100n, noteSecret: 0x12345n,
  }] }] });
  await first.wallet.sync();
  expect(await first.wallet.balances()).toEqual([{ assetId: 0n, private: 100n, spendable: 100n }]);
  await expect(first.wallet.send({ to: BOB, amount: 25n, openFeeAmount: 1n, data: { recipients: [{ to: BOB, records: [memoSchema.encode(MEMO)] }] } }))
    .resolves.toMatchObject({ accepted: true });

  // Frozen openings for this mnemonic/network, independent of the scanner's current derivation.
  const payouts = [
    { sourceKind: "designatedIssuance", component: "issuance", amount: 7n, context: 777n,
      secret: 0x25539c006c304f972cc5bd820882ddf4ac1574fa322b0ea3cc87aacd222c9e43n },
    { sourceKind: "posterPayout", component: "openFee", amount: 2n, context: 888n,
      secret: 0x0bcc08c9843d7e72b0f7075527292c353ff93f287bb07c4c36e974e72946636bn },
    { sourceKind: "posterPayout", component: "issuance", amount: 7n, context: 888n,
      secret: 0x0bcc08c9843d7e72b0f7075527292c353ff93f287bb07c4c36e974e72946636bn },
  ] as const;
  // Settlement emits separate notes in one block, sharing the poster context.
  const block = sim.addBlock({ transactions: [{ outputs: payouts.map((payout) => ({
    body: noteBodyCommitment(ownerCommitment(first.identity.profile.address, payout.secret), 0n, payout.amount),
    outputData: new Uint8Array(),
  })) }] });
  for (const [index, payout] of payouts.entries()) {
    const owner = ownerCommitment(first.identity.profile.address, payout.secret);
    const output = block.outputs[index]!;
    block.outputs[index] = {
      kind: "system", outputIndex: output.outputIndex, outputCommitment: output.outputCommitment, origin: output.origin,
      payout: {
        transactionId: payout.sourceKind === "posterPayout" ? null : fieldToHex(0x777n),
        source: payout.sourceKind === "posterPayout"
          ? { kind: payout.sourceKind, l1TransactionIndices: [0n] }
          : { kind: payout.sourceKind, l1TransactionIndex: 0n, batchItemIndex: 0n },
        component: payout.component, amount: payout.amount,
        ownerCommitment: owner, outputIndex: output.outputIndex, contexts: [payout.context],
      },
    };
  }
  await first.wallet.sync();
  await expectRecoveredHistory(first.wallet);
  expect(submittedKinds).toEqual([0, 0]);
  await first.close();

  const sensitiveBytes = [
    Buffer.from(MNEMONIC), Buffer.from(MEMO), Buffer.from(first.identity.privateKey),
    Buffer.from(toHex(first.identity.privateKey)), Buffer.from(first.identity.profile.mlKemSecretKey),
    Buffer.from(toHex(first.identity.profile.mlKemSecretKey)),
  ];
  for (const path of filesUnder(firstDirectory)) {
    const contents = readFileSync(path);
    for (const secret of sensitiveBytes) expect(contents.includes(secret), path).toBe(false);
  }
  const reopened = await openSeedWallet(firstDirectory, "first test vault password", node, submission);
  await expectRecoveredHistory(reopened.wallet);
  await reopened.close();

  // The fresh directory receives only the recovery phrase and a different local password.
  const restored = await openSeedWallet(restoredDirectory, "replacement vault password", node, submission);
  await restored.wallet.sync({ rescan: true });
  expect(await restored.wallet.defaultAccountReady()).toBe(true);
  await expectRecoveredHistory(restored.wallet);
  expect(await restored.wallet.receiveKeys()).toHaveLength(1);
}, 60_000);

it("rejects seed receive-key creation, import, replacement and clearing before reading or changing state", async () => {
  const identity = deriveSeedWalletIdentity(MNEMONIC, NETWORK);
  const sim = new ChainSim(NETWORK.pcashChainId, NETWORK);
  const initial = emptyWalletState({
    address: identity.profile.address,
    network: { chainId: NETWORK.pcashChainId, genesisHash: sim.genesisHash },
  });
  const store = memoryWalletStateStore(initial);
  const reads = vi.spyOn(store, "load");
  const chainReads = vi.spyOn(store, "readChain");
  const saves = vi.spyOn(store, "save");
  const transactions = vi.spyOn(store, "transaction");
  const status = vi.fn(async () => { throw new Error("unexpected node read"); });
  const signTypedData = vi.fn(async () => { throw new Error("unexpected signing request"); });
  const proveAndEncode = vi.fn(async () => { throw new Error("unexpected proof request"); });
  const runtime = createWalletRuntime({
    node: { status } as unknown as PcashNodeClient,
    chainId: NETWORK.pcashChainId,
    wallet: identity.profile,
    signer: { address: identity.profile.address, signTypedData },
    store,
    provers: { privateValue: { proveAndEncode }, userAccountUpdate: { proveAndEncode } },
  });
  const pair = generateMlKemKeyPair(new Uint8Array(64).fill(0x66));
  await expect(runtime.createReceiveKey()).rejects.toThrow("rotation is not supported");
  await expect(runtime.importReceiveKey(pair)).rejects.toThrow("do not import receive keys");
  for (const receiveKey of [
    { operation: "clear" },
    { operation: "replace", keyPair: pair },
  ] as const) {
    await expect(runtime.account({ receiveKey })).rejects.toThrow("changing it is not supported");
    await expect(runtime.prepareAccountActivation({ receiveKey })).rejects.toThrow("changing it is not supported");
  }
  for (const spy of [reads, chainReads, saves, transactions, status, signTypedData, proveAndEncode]) {
    expect(spy).not.toHaveBeenCalled();
  }
  expect(await store.load()).toEqual(initial);
});
