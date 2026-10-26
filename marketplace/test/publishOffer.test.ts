import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { bytesToHex, keccak256, numberToHex } from "viem";
import { openNodeWallet } from "@pcash/wallet";
import {
  addressHex,
  WIRE_PROOF_BYTES,
  DEFAULT_NETWORK_CONFIG,
  fieldToHex,
  privateKeyPcashActionSigner,
  type PcashNodeClient,
  type WalletProfileWithReceiveKeys,
} from "@pcash/sdk/browser";
import {
  derivePcashProfileFromPrivateKey,
  deterministicMlKemKeysFromApplicationSeed,
  walletAction,
  type DurableSubmissionAdapter,
  type PcashProfile,
} from "@pcash/sdk/wallet";
import type { SpendableNote } from "@pcash/sdk/wallet/scanning";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import type { ReceiptResult } from "@pcash/sdk/browser";
import {
  assertOfferPublicationWindow,
  publishOffer,
  readOfferPublicationFinality,
  type PublishableOffer,
  type PublishOfferParams,
  type PublishOfferRuntime,
} from "../src/client/publishOffer.ts";
import { MIN_CLAIM_WINDOW_SECONDS } from "../src/commitments.mts";
import { deriveTokenEscrowNoteSecret, runTokenEscrowFundingFlow } from "../src/client/tokenEscrowFunding.ts";
import { runNoteFundedTransferFlow } from "../src/client/noteFundedTransfer.ts";
import { testToken } from "./tokenFixtures.ts";
import {
  anchoredPrivateValueTransaction,
  fixtureContractBody,
} from "./anchoredTransaction.ts";
import { ChainSim, noteTo, profileAccount, simNode } from "./walletChain.ts";

const FUNDING_ANCHOR = 0x5151n;
const FUNDING_ENTRY_HEX = bytesToHex(anchoredPrivateValueTransaction(FUNDING_ANCHOR, 1n, 1n, 0n, 0n, { kind: "contract", body: fixtureContractBody() }));
const FUNDING_CONTENT_HASH = keccak256(FUNDING_ENTRY_HEX);
const CHAIN_ID = DEFAULT_NETWORK_CONFIG.pcashChainId;
const FUNDING_LEAF = 42n;
const FUNDING_FEE = 1n;
const OPEN_FEES = { fundingOpenFeeAmount: FUNDING_FEE };
const NO_OPEN_FEES = { fundingOpenFeeAmount: 0n };

const SELLER_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const sellerWallet = derivePcashProfileFromPrivateKey(SELLER_PRIVATE_KEY, DEFAULT_NETWORK_CONFIG);
const sellerSigner = privateKeyPcashActionSigner(SELLER_PRIVATE_KEY);

function offerFor(seller: PcashProfile): PublishableOffer {
  const l2ContractNkRoot = 88n;
  const l2ContractAddress = 0x1234n;
  const receive = deterministicMlKemKeysFromApplicationSeed(
    seller.applicationSeed,
    l2ContractNkRoot,
  );
  const l2ContractWallet: WalletProfileWithReceiveKeys = {
    pubX: new Uint8Array(32),
    pubY: new Uint8Array(32),
    address: l2ContractAddress,
    nkRoot: l2ContractNkRoot,
    mlKemPublicKey: receive.publicKey,
    mlKemSecretKey: receive.secretKey,
  };
  return {
    terms: {
      router: 1n,
      seller: 2n,
      id: 3n,
      assetId: 0n,
      amount: 50n,
      ethPriceWei: 60n,
      // Publication closes at L1 timestamp 700.
      deadlineT: MIN_CLAIM_WINDOW_SECONDS + 700n,
    },
    chainId: CHAIN_ID,
    l2ContractNkRoot,
    l2ContractAddress,
    l2ContractBody: fixtureContractBody(),
    reclaimAuthority: seller.address,
    l2ContractWallet,
  };
}

const offer = offerFor(sellerWallet);
const sellerChain = new ChainSim(CHAIN_ID, {
  l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId,
  inboxAddress: addressHex(DEFAULT_NETWORK_CONFIG.inboxAddress),
});
sellerChain.addBlock({
  accounts: [profileAccount(sellerChain, sellerWallet)],
  transactions: [{ outputs: [noteTo(sellerWallet, 1_000n), null, null, null, null] }],
});
const node = simNode(sellerChain);

async function runPublish(
  params: Omit<PublishOfferParams, "wallet">,
  runtime: PublishOfferRuntime,
  walletNode: PcashNodeClient = node,
  sync: () => Promise<void> = async () => {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "pcash-publish-offer-"));
  const wallet = await openNodeWallet({
    dataDir,
    node: walletNode,
    profile: sellerWallet,
    signer: sellerSigner,
  });
  mock.method(wallet, "sync", sync);
  try {
    return await publishOffer({ ...params, wallet }, runtime);
  } finally {
    await wallet.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function receipt(kind: ReceiptResult["kind"], outputLeafStart: bigint | null): ReceiptResult {
  return {
    contentHash: FUNDING_CONTENT_HASH,
    transactionId: kind === "contractAccount" ? `0x${"e1".repeat(32)}` : `0x${"e2".repeat(32)}`,
    outcome: "succeeded",
    failureDetail: null,
    kind,
    accountCreation: 1,
    l1Sender: "0x0000000000000000000000000000000000000000",
    issuanceOwnerCommitment: null,
    settledOpenFeeAmount: 0n,
    settledIssuanceAmount: 0n,
    inclusion: { l1BlockNumber: kind === "contractAccount" ? 90n : 99n, l1BlockHash: `0x${"33".repeat(32)}`, l1TransactionIndex: 0n, l1TransactionHash: `0x${"44".repeat(32)}`, batchItemIndex: 0n },
    outputLeafStart,
    outputsAdded: 0n,
    nullifiers: null,
    account: null,
  };
}

function recoveredNote(overrides: Partial<SpendableNote> = {}): SpendableNote {
  return {
    chainId: CHAIN_ID,
    leafIndex: FUNDING_LEAF,
    outputIndex: 0,
    assetId: 0n,
    owner: offer.l2ContractAddress,
    noteSecret: 0xabcn,
    amount: offer.terms.amount,
    noteBodyCommitment: 14n,
    outputCommitment: 15n,
    memo: new Uint8Array(0),
    ...overrides,
  };
}

function runtime(events: string[], recovered: SpendableNote[] = [recoveredNote()], fee = FUNDING_FEE): PublishOfferRuntime {
  const to = buildExtendedCode({ chainId: offer.chainId, address: offer.l2ContractAddress, mlKemPublicKey: offer.l2ContractWallet.mlKemPublicKey });
  return {
    resumeValueTransaction: async (_wallet, intent) => {
      assert.equal(intent.transactionHex, FUNDING_ENTRY_HEX);
      events.push("resume");
      return { state: "pending", contentHash: FUNDING_CONTENT_HASH, queued: intent.submission?.mode !== "l1" };
    },
    awaitAcceptedReceipt: async (_node, contentHash) => {
      assert.equal(contentHash, FUNDING_CONTENT_HASH);
      events.push("accepted");
      return receipt("privateValue", FUNDING_LEAF);
    },
    preflightNoteFundedTransfer: async (params) => {
      events.push("preflight");
      assert.equal(params.amount, offer.terms.amount);
      assert.equal(params.openFeeAmount, fee);
      assert.equal(params.to, to);
      assert.deepEqual(params.accountCreation, { kind: "contract", body: offer.l2ContractBody });
      return { inputCount: 1, inputTotal: offer.terms.amount + fee };
    },
    runNoteFundedTransferFlow: async (params) => {
      events.push("fund");
      assert.equal(params.openFeeAmount, fee);
      assert.equal(params.to, to);
      assert.equal(params.validUntilTimestamp, offer.terms.deadlineT - MIN_CLAIM_WINDOW_SECONDS - 1n);
      assert.deepEqual(params.accountCreation, { kind: "contract", body: offer.l2ContractBody });
      const status = await node.status();
      const prepared = params.submission?.mode === "l1" ? await params.submission.preflight({ transactionBytes: Uint8Array.from(Buffer.from(FUNDING_ENTRY_HEX.slice(2), "hex")), status, retry: false }) : undefined;
      await params.beforeSubmit?.(FUNDING_CONTENT_HASH, FUNDING_ENTRY_HEX);
      await params.onPreparedContentHash?.(FUNDING_CONTENT_HASH, FUNDING_ENTRY_HEX);
      if (params.submission?.mode === "l1") await params.submission.submit({ transactionBytes: Uint8Array.from(Buffer.from(FUNDING_ENTRY_HEX.slice(2), "hex")), status, retry: false, prepared });
      return { contentHash: FUNDING_CONTENT_HASH, recipient: params.to, amount: params.amount, changeAmount: 1n, settled: false, queued: params.submission?.mode !== "l1" };
    },
    preflightTokenEscrowFunding: async () => { throw new Error("unexpected token preflight"); },
    runTokenEscrowFundingFlow: async () => { throw new Error("unexpected token funding"); },
    recoverTokenEscrow: async () => { throw new Error("unexpected token recovery"); },
    scanWallet: async (_node, wallet, chainId) => {
      events.push("recover");
      assert.equal(wallet.address, offer.l2ContractAddress);
      assert.equal(chainId, CHAIN_ID);
      return { scanned: recovered.length, decrypted: recovered.length, trialDecryptAttempts: recovered.length,
        recovered, sent: [], transactionRecords: [], receivedData: [] };
    },
  };
}

const params = { offer, ...OPEN_FEES, readL1Timestamp: async () => 0n };
const resume = { fundingContentHash: FUNDING_CONTENT_HASH, fundingTransactionHex: FUNDING_ENTRY_HEX };
function flowNode(accepted = false, retained = false): PcashNodeClient {
  return simNode(sellerChain, {
    getReceipt: async () => accepted ? [receipt("privateValue", FUNDING_LEAF)] : [],
    getMempoolTransaction: async () => retained ? { contentHash: FUNDING_CONTENT_HASH, status: "ready" } : null,
    getBlockByHash: async () => ({ hash: numberToHex(FUNDING_ANCHOR, { size: 32 }), timestamp: (await node.status()).latestBlockTimestamp }),
  });
}

describe("atomic listing publication", () => {
  it("preflights one fee, checkpoints one transaction, and waits for one outcome", async () => {
    const events: string[] = [];
    const checkpoints: unknown[] = [];
    const result = await runPublish({ ...params, relay: async hash => { assert.equal(hash, FUNDING_CONTENT_HASH); events.push("relay"); },
      onCheckpoint: checkpoint => { checkpoints.push(checkpoint); events.push("checkpoint"); } }, runtime(events));
    assert.deepEqual(events, ["preflight", "fund", "checkpoint", "relay", "accepted", "checkpoint", "recover"]);
    assert.deepEqual(checkpoints[0], resume);
    assert.deepEqual(result, { leafIndex: Number(FUNDING_LEAF), noteSecret: fieldToHex(0xabcn), amount: fieldToHex(offer.terms.amount) });
    assert.equal((checkpoints[1] as { fundingAcceptedBlock: string }).fundingAcceptedBlock, "99");
  });
  it("refuses insufficient value before preparing a transaction", async () => {
    const events: string[] = []; const run = runtime(events);
    run.preflightNoteFundedTransfer = async () => { throw new Error("insufficient notes"); };
    await assert.rejects(runPublish(params, run), /insufficient notes/);
    assert.deepEqual(events, []);
  });
  it("checks the publication window before proving and again before journaling", async () => {
    for (const expiresAfterPreparation of [false, true]) {
      let reads = 0; const events: string[] = [];
      await assert.rejects(runPublish({ ...params, readL1Timestamp: async () => ++reads === 1 && expiresAfterPreparation ? 0n : 700n }, runtime(events)), /deadline is too close/);
      assert.deepEqual(events, expiresAfterPreparation ? ["preflight", "fund"] : []);
    }
  });
  it("refuses a wallet that cannot recover this escrow before preparing value", async () => {
    const events: string[] = [];
    await assert.rejects(runPublish({ ...params, offer: { ...offer, reclaimAuthority: sellerWallet.address + 1n } }, runtime(events)), /reclaim authority/);
    assert.deepEqual(events, []);
  });
  it("does not submit when the durable checkpoint fails", async () => {
    const events: string[] = [];
    await assert.rejects(runPublish({ ...params, onCheckpoint: async () => { throw new Error("storage offline"); } }, runtime(events)), /storage offline/);
    assert.deepEqual(events, ["preflight", "fund"]);
  });
  it("re-admits the same saved bytes without another proof or fee selection", async () => {
    const events: string[] = [];
    await runPublish({ ...params, resume }, runtime(events), flowNode());
    assert.deepEqual(events, ["resume", "accepted", "recover"]);
  });
  for (const accepted of [false, true]) it(`delegates retained or accepted resume without preparing another payment (accepted: ${accepted})`, async () => {
    const events: string[] = []; const run = runtime(events);
    run.resumeValueTransaction = async (_wallet, intent) => {
      assert.equal(intent.transactionHex, FUNDING_ENTRY_HEX);
      events.push("resume");
      return { state: accepted ? "accepted" : "pending", contentHash: FUNDING_CONTENT_HASH, queued: !accepted };
    };
    await runPublish({ ...params, resume }, run, flowNode(accepted, !accepted));
    assert.deepEqual(events, ["resume", "accepted", "recover"]);
  });
  it("can finish a finalized checkpoint whose exact bytes were released", async () => {
    const events: string[] = [];
    await runPublish({ ...params, resume: { fundingContentHash: FUNDING_CONTENT_HASH } }, runtime(events), flowNode(true));
    assert.deepEqual(events, ["accepted", "recover"]);
  });
  it("restores a missing listing checkpoint when the wallet recognizes an existing action", async () => {
    const checkpoints: unknown[] = []; const run = runtime([]);
    run.runNoteFundedTransferFlow = async request => {
      await request.onPreparedContentHash?.(FUNDING_CONTENT_HASH, FUNDING_ENTRY_HEX);
      return { contentHash: FUNDING_CONTENT_HASH, recipient: request.to, amount: request.amount, changeAmount: 1n, settled: true, queued: false };
    };
    await runPublish({ ...params, onCheckpoint: value => { checkpoints.push(value); } }, run, flowNode(true));
    assert.deepEqual(checkpoints[0], resume);
    assert.equal((checkpoints[1] as { fundingTransactionHex: string }).fundingTransactionHex, FUNDING_ENTRY_HEX);
  });
  it("checks the accepted receipt kind and recovers only its exact output", async () => {
    const run = runtime([]); run.awaitAcceptedReceipt = async () => receipt("contractAccount", null);
    await assert.rejects(runPublish(params, run), /expected privateValue/);
    for (const wrong of [{ leafIndex: FUNDING_LEAF + 1n }, { amount: 1n }, { outputIndex: 1 }, { owner: 1n }, { assetId: 1n }]) {
      await assert.rejects(runPublish(params, runtime([], [recoveredNote(wrong)])), /did not recover/);
    }
  });
  it("passes one selected-relay fee and quote to preflight and funding", async () => {
    const events: string[] = []; const run = runtime(events, undefined, 0n);
    const quote = {} as NonNullable<PublishOfferParams["selectedRelayQuote"]>;
    const preflight = run.preflightNoteFundedTransfer;
    const funding = run.runNoteFundedTransferFlow;
    run.preflightNoteFundedTransfer = async request => { assert.equal(request.privateRelayFeeAmount, 7n); assert.equal(request.selectedRelayQuote, quote); return preflight(request); };
    run.runNoteFundedTransferFlow = async request => { assert.equal(request.privateRelayFeeAmount, 7n); assert.equal(request.selectedRelayQuote, quote); return funding(request); };
    await runPublish({ ...params, ...NO_OPEN_FEES, privateRelayFeeAmount: 7n, selectedRelayQuote: quote }, run);
    await assert.rejects(runPublish({ ...params, privateRelayFeeAmount: 7n }, runtime([])), /authenticated relayer/);
  });
  it("funds a token escrow with the same attachment and a recoverable secret", async () => {
    const token = testToken(); const tokenOffer = { ...offer, terms: { ...offer.terms, assetId: token.assetId } };
    const expectedSecret = deriveTokenEscrowNoteSecret({ seller: sellerWallet, chainId: offer.chainId, offerId: offer.terms.id, contractAddress: offer.l2ContractAddress });
    const events: string[] = []; const run = runtime(events);
    run.preflightTokenEscrowFunding = async request => { events.push("preflight token"); assert.equal(request.openFeeAmount, FUNDING_FEE); assert.deepEqual(request.accountCreation, { kind: "contract", body: offer.l2ContractBody }); };
    run.runTokenEscrowFundingFlow = async request => { events.push("fund token"); assert.equal(request.noteSecret, expectedSecret); assert.deepEqual(request.accountCreation, { kind: "contract", body: offer.l2ContractBody }); await request.beforeSubmit?.(FUNDING_CONTENT_HASH, FUNDING_ENTRY_HEX); await request.onPreparedContentHash?.(FUNDING_CONTENT_HASH, FUNDING_ENTRY_HEX); return { contentHash: FUNDING_CONTENT_HASH, queued: true }; };
    run.recoverTokenEscrow = async (_node, accepted, note) => { events.push("recover token"); assert.equal(accepted.outputLeafStart, FUNDING_LEAF); assert.equal(note.noteSecret, expectedSecret); return { leafIndex: Number(FUNDING_LEAF), noteSecret: fieldToHex(expectedSecret), amount: fieldToHex(note.amount) }; };
    await runPublish({ ...params, offer: tokenOffer }, run);
    assert.deepEqual(events, ["preflight token", "fund token", "accepted", "recover token"]);
  });
});

describe("direct listing publication", () => {
  it("uses the real adapter and checkpoints before one Ethereum submission", async () => {
    const events: string[] = []; let checkpoint: unknown;
    const run = runtime(events); const fund = run.runNoteFundedTransferFlow;
    run.runNoteFundedTransferFlow = async request => { assert.equal(request.submission?.prepareOnly, undefined); return fund(request); };
    await runPublish({ ...params, onCheckpoint: value => { checkpoint = value; }, submission: {
      mode: "l1", preflight: async request => { assert.equal(bytesToHex(request.transactionBytes), FUNDING_ENTRY_HEX); assert.equal(request.additionalTransactions, undefined); },
      submit: async () => { assert.deepEqual(checkpoint, resume); events.push("Ethereum approval"); return { accepted: false, queued: false, output: undefined }; },
    } }, run, flowNode());
    assert.deepEqual(events, ["preflight", "fund", "Ethereum approval", "accepted", "recover"]);
  });

  it("checks the publication window again after checkpointing and before Ethereum submission", async () => {
    let reads = 0; let saved: unknown; let submitted = false;
    await assert.rejects(runPublish({ ...params,
      readL1Timestamp: async () => ++reads < 3 ? 0n : 700n,
      onCheckpoint: value => { saved = value; },
      submission: { mode: "l1", preflight: async () => undefined,
        submit: async () => { submitted = true; return { accepted: false, queued: false, output: null }; } },
    }, runtime([]), flowNode()), /deadline is too close/);
    assert.deepEqual(saved, resume);
    assert.equal(submitted, false);
  });

  it("stops publication if the active listing changes after its checkpoint", async () => {
    let active = true; let submitted = false;
    await assert.rejects(runPublish({ ...params,
      assertActive: () => { if (!active) throw new Error("listing changed"); },
      onCheckpoint: () => { active = false; },
      submission: { mode: "l1", preflight: async () => undefined,
        submit: async () => { submitted = true; return { accepted: false, queued: false, output: null }; } },
    }, runtime([]), flowNode()), /listing changed/);
    assert.equal(submitted, false);
  });

  for (const accepted of [false, true]) it(`delegates exact transaction resume (accepted: ${accepted})`, async () => {
    const events: string[] = []; const run = runtime(events);
    run.resumeValueTransaction = async (_wallet, intent) => {
      events.push("resume");
      assert.equal(intent.transactionHex, FUNDING_ENTRY_HEX);
      assert.equal(intent.submission?.mode, "l1");
      return { state: accepted ? "accepted" : "pending", contentHash: FUNDING_CONTENT_HASH };
    };
    await runPublish({ ...params, resume, submission: { mode: "l1", preflight: async () => { assert.fail("application preflight"); }, submit: async () => { assert.fail("application submission"); } } }, run, flowNode(accepted));
    assert.deepEqual(events, ["resume", "accepted", "recover"]);
  });

  it("waits for an in-flight wallet result without a second preflight or submission", async () => {
    const run = runtime([]);
    run.resumeValueTransaction = async () => ({ state: "pending", contentHash: FUNDING_CONTENT_HASH, queued: false });
    await runPublish({ ...params, resume, submission: { mode: "l1", preflight: async () => { assert.fail("duplicate preflight"); }, submit: async () => { assert.fail("duplicate submission"); } } }, run, flowNode());
  });

  it("retains a rejected approval's exact checkpoint and resumes it without proving again", async () => {
    let saved: unknown;
    const run = runtime([]);
    const submission: DurableSubmissionAdapter = { mode: "l1", preflight: async () => undefined,
      submit: async () => { throw new Error("approval rejected"); } };
    await assert.rejects(runPublish({ ...params, onCheckpoint: value => { saved = value; }, submission }, run, flowNode()), /approval rejected/);
    assert.deepEqual(saved, resume);
    run.runNoteFundedTransferFlow = async () => { assert.fail("must resume the saved bytes"); };
    run.resumeValueTransaction = async (_wallet, intent) => {
      assert.equal(intent.transactionHex, resume.fundingTransactionHex);
      return { state: "accepted", contentHash: FUNDING_CONTENT_HASH };
    };
    await runPublish({ ...params, resume: saved as typeof resume, submission }, run, flowNode(true));
  });

  it("surfaces the wallet's blocked reason without a new proof", async () => {
    const events: string[] = []; const run = runtime(events);
    run.resumeValueTransaction = async () => ({ state: "blocked", contentHash: FUNDING_CONTENT_HASH, message: "wait for finalized expiry" });
    await assert.rejects(runPublish({ ...params, resume }, run, flowNode()), /wait for finalized expiry/);
    assert.deepEqual(events, []);
  });

  it("clears the application checkpoint only after the wallet permits a rebuild", async () => {
    const events: string[] = []; const run = runtime(events);
    run.resumeValueTransaction = async () => { events.push("resume"); return { state: "rebuildable", contentHash: FUNDING_CONTENT_HASH }; };
    await runPublish({ ...params, resume, onFundingRebuild: hash => { assert.equal(hash, FUNDING_CONTENT_HASH); events.push("reset checkpoint"); } }, run, flowNode());
    assert.deepEqual(events, ["resume", "reset checkpoint", "preflight", "fund", "accepted", "recover"]);
    run.runNoteFundedTransferFlow = async () => { assert.fail("checkpoint race must stop rebuilding"); };
    await assert.rejects(runPublish({ ...params, resume, onFundingRebuild: () => { throw new Error("checkpoint changed"); } }, run, flowNode()), /checkpoint changed/);
  });
});

it("keeps a strict claim window and distinguishes accepted from finalized funding", async () => {
  assert.throws(() => assertOfferPublicationWindow(700n + MIN_CLAIM_WINDOW_SECONDS, 700n), /deadline is too close/);
  assert.doesNotThrow(() => assertOfferPublicationWindow(701n + MIN_CLAIM_WINDOW_SECONDS, 700n));
  for (const finalized of [98n, 99n]) {
    const current = simNode(sellerChain, { getReceipt: async () => [receipt("privateValue", FUNDING_LEAF)], status: async () => ({ finalizedL1BlockNumber: finalized }) });
    assert.equal((await readOfferPublicationFinality(current, FUNDING_CONTENT_HASH)).phase, finalized === 99n ? "finalized" : "accepted");
  }
});

for (const token of [false, true]) for (const persistCheckpoint of [false, true]) it(`checkpoints ${token ? "token" : "native"} funding before the preflight RPC sees proof bytes (checkpoint succeeds: ${persistCheckpoint})`, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pcash-publication-preflight-"));
  const chain = new ChainSim(CHAIN_ID, { l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId, inboxAddress: addressHex(DEFAULT_NETWORK_CONFIG.inboxAddress) });
  const asset = testToken();
  chain.addBlock({ accounts: [profileAccount(chain, sellerWallet)], transactions: [{
    outputs: [noteTo(sellerWallet, 1_000n), token ? { ...noteTo(sellerWallet, 1_000n), assetId: asset.assetId } : null, null, null, null],
  }] });
  const walletNode = simNode(chain, { getBlockByHash: async (hash: string) => BigInt(hash) === chain.head.hash
    ? { hash, timestamp: chain.head.envelope.header.timestamp } : null });
  const actualOffer = { ...offer, terms: { ...offer.terms, assetId: token ? asset.assetId : 0n,
    deadlineT: chain.head.envelope.header.timestamp + MIN_CLAIM_WINDOW_SECONDS + 1_000n } };
  let proofs = 0; let preflights = 0; let failPreflight = true;
  const checkpoints: { contentHash: string; transactionHex: string }[] = [];
  const submitted: Uint8Array[] = [];
  const submission: DurableSubmissionAdapter = {
    mode: "l1",
    preflight: async ({ transactionBytes }) => {
      preflights++;
      assert.equal(checkpoints.length, 1, "checkpoint must precede external gas estimation");
      assert.equal(bytesToHex(transactionBytes), checkpoints[0]!.transactionHex);
      if (failPreflight) throw new Error("gas estimation failed after receiving the proof");
      return null;
    },
    submit: async ({ transactionBytes }) => { submitted.push(transactionBytes); return { accepted: false, queued: false, output: null }; },
  };
  const provers: NonNullable<Parameters<typeof openNodeWallet>[0]["provers"]> = {
    privateValue: { proveAndEncode: async build => { proofs++; return build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)); } },
    assetAction: { shapes: [0], proveAndEncode: async build => { proofs++; return build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)); } },
  };
  const first = await openNodeWallet({ dataDir, node: walletNode, profile: sellerWallet, signer: sellerSigner, provers });
  const run = runtime([]);
  run.runNoteFundedTransferFlow = runNoteFundedTransferFlow;
  run.runTokenEscrowFundingFlow = runTokenEscrowFundingFlow;
  run.preflightTokenEscrowFunding = async () => {};
  run.preflightNoteFundedTransfer = async () => ({ inputCount: 1, inputTotal: 1_000n });
  try {
    await first.sync();
    if (token) await first.importAssetDefinition(asset.definition);
    await assert.rejects(publishOffer({ wallet: first, offer: actualOffer, fundingOpenFeeAmount: 0n, submission,
      readL1Timestamp: async () => chain.head.envelope.header.timestamp,
      onCheckpoint: checkpoint => {
        if (!persistCheckpoint) throw new Error("checkpoint storage failed");
        checkpoints.push({ contentHash: checkpoint.fundingContentHash, transactionHex: checkpoint.fundingTransactionHex! });
      },
    }, run), persistCheckpoint ? /gas estimation failed/ : /checkpoint storage failed/);
    const stored = await first.execute(walletAction("test:preflight-exposure", ({ store }) => store.load()));
    assert.equal(stored?.pendingNoteFundedTransfers?.length ?? 0, 0);
    assert.equal(stored?.pendingAssetActions?.length ?? 0, 0);
    assert.equal(stored?.mempoolOutbox?.length ?? 0, 0);
  } finally { await first.close(); }
  assert.equal(proofs, 1);
  assert.equal(preflights, persistCheckpoint ? 1 : 0);
  assert.equal(submitted.length, 0);
  if (!persistCheckpoint) return;
  failPreflight = false;
  const reopened = await openNodeWallet({ dataDir, node: walletNode, profile: sellerWallet, signer: sellerSigner,
    provers: { privateValue: { proveAndEncode: async () => { throw new Error("must not reprove"); } },
      assetAction: { shapes: [0], proveAndEncode: async () => { throw new Error("must not reprove"); } } } });
  try {
    const resumed = await reopened.resumeValueTransaction({ transactionHex: checkpoints[0]!.transactionHex, submission });
    assert.equal(resumed.state, "pending");
    assert.equal(resumed.contentHash, checkpoints[0]!.contentHash);
  } finally { await reopened.close(); }
  assert.equal(proofs, 1);
  assert.equal(preflights, 2);
  assert.equal(submitted.length, 1);
  assert.equal(bytesToHex(submitted[0]!), checkpoints[0]!.transactionHex);
});
