// Payment disclosures: one output of a payment, opened for anyone with a node.
// The payer runs its real transfer and synchronization paths against a
// simulated chain; proofs are stand-ins.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { memoSchema } from "@pcash/sdk/delivery";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { prepareUserAccountUpdate } from "@pcash/sdk/builders";
import { accountRuleEntryCommitment, buildAccountRuleSet, WIRE_PROOF_BYTES } from "@pcash/sdk/protocol";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { addressHex, fromHex, toHex } from "@pcash/sdk/utils";
import { feePaymentFixture } from "@pcash/test-support/protocol-fixtures";
import { NativeActivityReader } from "../../src/wallet/actions/nativeActivity.ts";
import { syncWallet } from "../../src/wallet/actions/syncWallet.ts";
import { createWalletRuntime } from "../../src/wallet/actions/walletRuntime.ts";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStoreBackend } from "../../src/wallet/memoryStoreBackend.ts";
import { inspectPaymentDisclosure, type PaymentDisclosure } from "../../src/wallet/paymentDisclosure.ts";
import { walletStore } from "../../src/wallet/store.ts";
import { deriveTestWallet } from "../testWallet.ts";
import { ChainSim } from "./chainFixture.ts";

const CHAIN_ID = 0x1ff6n;
const NETWORK = { pcashChainId: CHAIN_ID, l1ChainId: 11_155_111n, inboxAddress: `0x${"66".repeat(20)}` };
const prover = {
  proveAndEncode: async (build: { encodeTransaction(proof: Uint8Array): Uint8Array }) =>
    build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)),
};

function actor() {
  const privateKey = new Uint8Array(randomBytes(32));
  const profile = derivePcashProfileFromPrivateKey(privateKey, NETWORK);
  const rules = defaultUserAccountRuleSet({ wallet: profile, network: NETWORK, secrets: profile.defaultUserRuleSecrets });
  return {
    profile,
    signer: privateKeyPcashActionSigner(privateKey),
    account: {
      address: addressHex(profile.address), nullifierKeyCommitment: profile.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: profile.mlKemPublicKey,
    },
  };
}

/** A user-account update whose fee section pays the relayer a private relay fee of 3 PCASH. */
function relayFeeUpdate(relayer: { address: bigint; mlKemPublicKey: Uint8Array }) {
  const payer = deriveTestWallet({ mlKem: "deterministic" });
  const rule = { applicationVkHash: 7n, configurationCommitment: 9n, commitmentBlinder: 1n, entryIndex: 3 };
  const rules = buildAccountRuleSet([{
    entryIndex: rule.entryIndex,
    accountRuleEntryCommitment: accountRuleEntryCommitment(rule.applicationVkHash, rule.configurationCommitment, rule.commitmentBlinder),
  }]);
  const fixture = feePaymentFixture({ wallet: payer, inputAmount: 1_000n, noteSecret: 0xbeefn, accountRuleSetCommitment: rules.accountRuleSetCommitment });
  return prepareUserAccountUpdate({
    network: NETWORK,
    current: {
      address: payer.address, accountRevision: 1n, ruleSetCommitment: rules.accountRuleSetCommitment,
      receiveKey: { status: "available", mlKemPublicKey: payer.mlKemPublicKey! },
    },
    nkRoot: payer.nkRoot,
    proposed: { ruleSetCommitment: 0x123456n, receiveKey: { operation: "clear" } },
    recentPcashBlockHash: fixture.recentPcashBlockHash,
    validUntilTimestamp: 1_000_000n,
    snapshot: fixture.snapshot,
    fee: {
      openFeeAmount: 100n, inputs: fixture.inputs, receiveKey: payer.mlKemPublicKey!, dummyInputEntropy: 42n,
      privateRelayPayment: { recipientAddress: relayer.address, receiveKey: relayer.mlKemPublicKey, amount: 3n },
    },
    rule: { ...rule, siblings: rules.membership(rule.entryIndex).siblings },
  });
}

/** A chain where a payer paid 4 PCASH to a registered payee with a memo, and the disclosure the payer's activity offers for it. */
async function disclosedPayment() {
  const sim = new ChainSim(CHAIN_ID);
  sim.servesFundingReads = true;
  const payer = actor();
  const payee = actor();
  sim.addBlock({
    accounts: [payer.account, payee.account],
    transactions: [{ outputs: [{ owner: payer.profile.address, receiveKey: payer.profile.mlKemPublicKey, amount: 10n }, null, null, null, null] }],
  });
  const store = walletStore(memoryWalletStoreBackend(), { address: payer.profile.address, network: { chainId: CHAIN_ID, genesisHash: sim.genesisHash } });
  const sync = () => syncWallet({ node: sim.client(), wallet: payer.profile, chainId: CHAIN_ID, store });
  await sync();
  const submission = {
    mode: "l1" as const,
    preflight: async () => "prepared",
    submit: async ({ transactionBytes }: { transactionBytes: Uint8Array }) => {
      sim.include(transactionBytes);
      return { accepted: true, queued: false, output: "accepted" };
    },
  };
  const to = payee.account.address;
  const result = await createWalletRuntime({
    node: sim.client(), chainId: CHAIN_ID, wallet: payer.profile, signer: payer.signer, store,
    provers: { privateValue: prover as never }, submission, userAccountCreationSubmission: submission,
    settlePollIntervalMs: 0, settlePollMaxAttempts: 3,
  }).transfer({ to, amount: 4n, openFeeAmount: 0n, data: { recipients: [{ to, records: [memoSchema.encode("INV-7")] }] } });
  await sync();
  const activity = await new NativeActivityReader().read((await store.load())!, store, payer.profile);
  if (activity.state !== "ready") throw new Error(`activity unavailable: ${activity.reason}`);
  const disclosure = activity.entries.flatMap((entry) => entry.sent ?? []).find((output) => output.amount === 4n)?.disclosure;
  if (disclosure === undefined) throw new Error("the payer's activity offers no disclosure");
  return { sim, payee, result, disclosure };
}

describe("a payment disclosure", () => {
  it("opens the one payment for anyone with a node, and another key opens nothing", async () => {
    const { sim, payee, result, disclosure } = await disclosedPayment();
    expect(disclosure.contentHash).toBe(result.contentHash.toLowerCase());
    expect(await inspectPaymentDisclosure(sim.client(), disclosure)).toEqual({
      status: "landed", transactionId: expect.any(String), finalized: true,
      recipient: payee.account.address, assetId: 0n, amount: 4n, memo: "INV-7",
    });
    const otherKey: PaymentDisclosure = { ...disclosure, disclosureKey: toHex(new Uint8Array(randomBytes(32))) };
    expect(await inspectPaymentDisclosure(sim.client(), otherKey)).toEqual({ status: "invalid" });
    expect(await inspectPaymentDisclosure(sim.client(), { ...disclosure, slot: 4 })).toEqual({ status: "invalid" });
  });

  it("is the same in the payee's activity", async () => {
    const { sim, payee, disclosure } = await disclosedPayment();
    const store = walletStore(memoryWalletStoreBackend(), { address: payee.profile.address, network: { chainId: CHAIN_ID, genesisHash: sim.genesisHash } });
    await syncWallet({ node: sim.client(), wallet: payee.profile, chainId: CHAIN_ID, store });
    const activity = await new NativeActivityReader().read((await store.load())!, store, payee.profile);
    if (activity.state !== "ready") throw new Error(`activity unavailable: ${activity.reason}`);
    const received = activity.entries.flatMap((entry) => entry.messages ?? []).find((message) => message.amount === 4n);
    expect(received?.disclosure).toEqual(disclosure);
  });

  it("opens a relay fee a user-account update paid", async () => {
    const sim = new ChainSim(CHAIN_ID);
    sim.servesFundingReads = true;
    const relayer = actor();
    sim.addBlock({ accounts: [relayer.account] });
    sim.include(relayFeeUpdate(relayer.profile).encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)));
    const store = walletStore(memoryWalletStoreBackend(), { address: relayer.profile.address, network: { chainId: CHAIN_ID, genesisHash: sim.genesisHash } });
    await syncWallet({ node: sim.client(), wallet: relayer.profile, chainId: CHAIN_ID, store });
    const activity = await new NativeActivityReader().read((await store.load())!, store, relayer.profile);
    if (activity.state !== "ready") throw new Error(`activity unavailable: ${activity.reason}`);
    const fee = activity.entries.flatMap((entry) => entry.messages ?? []).find((message) => message.amount === 3n);
    if (fee?.disclosure === undefined) throw new Error("the relayer's activity offers no disclosure for its fee");
    expect(await inspectPaymentDisclosure(sim.client(), fee.disclosure)).toEqual({
      status: "landed", transactionId: expect.any(String), finalized: true,
      recipient: relayer.account.address, assetId: 0n, amount: 3n,
    });
  });

  it("is not final when a reorganization during verification moves it above the finality it read", async () => {
    const { sim, result, disclosure } = await disclosedPayment();
    sim.finalityLag = 2n;
    const included = sim.head.number;
    // After the verifier's first status or transaction read, the payment's block
    // is replaced and the same bytes land again later at the same leaf, with
    // finality now past the old height but short of the new one.
    const client = sim.client();
    let reorganized = false;
    const racing = new Proxy(client, {
      get: (target, property) => {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const answer = await (value as (...a: unknown[]) => unknown).apply(target, args);
          if (!reorganized && (property === "status" || property === "getTransaction")) {
            reorganized = true;
            sim.reorg(included - 1n, [{}, {}, {}]);
            sim.include(fromHex(result.transactionHex));
            sim.addBlock({});
            sim.addBlock({});
          }
          return answer;
        };
      },
    }) as PcashNodeClient;
    const shown = await inspectPaymentDisclosure(racing, disclosure);
    expect(reorganized).toBe(true);
    expect(sim.status().finalizedL1BlockNumber).toBeGreaterThanOrEqual(included);
    expect(shown).toMatchObject({ status: "landed", finalized: false, amount: 4n });
  });

  it.each([
    { contentHash: "0x11", slot: 0, disclosureKey: `0x${"11".repeat(32)}` },
    { contentHash: `0x${"11".repeat(32)}`, slot: 0, disclosureKey: "0x" },
    { contentHash: `0x${"11".repeat(32)}`, slot: -1, disclosureKey: `0x${"11".repeat(32)}` },
    { contentHash: `0x${"11".repeat(32)}`, slot: 1.5, disclosureKey: `0x${"11".repeat(32)}` },
  ])("refuses a malformed disclosure without asking the node: %o", async (disclosure) => {
    const unreachable = new Proxy({}, { get: () => () => { throw new Error("the node is not consulted"); } }) as unknown as PcashNodeClient;
    expect(await inspectPaymentDisclosure(unreachable, disclosure)).toEqual({ status: "invalid" });
  });
});
