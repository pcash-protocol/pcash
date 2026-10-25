import { transactionIdentity as submissionIdentity } from "@pcash/sdk/protocol";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { bytesToHex, keccak256, numberToHex } from "viem";
import { openNodeWallet } from "@pcash/wallet";
import {
  addressHex,
  DEFAULT_NETWORK_CONFIG,
  encodeContractAccountCreation,
  fieldToHex,
  privateKeyPcashActionSigner,
  type PcashNodeClient,
  type WalletProfileWithReceiveKeys,
} from "@pcash/sdk/browser";
import {
  derivePcashProfileFromPrivateKey,
  deterministicMlKemKeysFromApplicationSeed,
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
import { deriveTokenEscrowNoteSecret } from "../src/client/tokenEscrowFunding.ts";
import { testToken } from "./tokenFixtures.ts";
import {
  anchoredPrivateValueTransaction,
  sponsoredContractFunding,
  fixtureContractBody,
} from "./anchoredTransaction.ts";
import { ChainSim, noteTo, profileAccount, simNode } from "./walletChain.ts";

const FUNDING_ANCHOR = 0x5151n;
const L2_CONTRACT_ENTRY = encodeContractAccountCreation(
  DEFAULT_NETWORK_CONFIG.pcashChainId,
  fixtureContractBody(),
  sponsoredContractFunding(FUNDING_ANCHOR),
);
const L2_CONTRACT_CONTENT_HASH = keccak256(L2_CONTRACT_ENTRY);
const SPONSORED_L2_CONTRACT_ENTRY_HEX = bytesToHex(L2_CONTRACT_ENTRY);
const FUNDING_ENTRY_HEX = bytesToHex(anchoredPrivateValueTransaction(FUNDING_ANCHOR));
const FUNDING_CONTENT_HASH = keccak256(FUNDING_ENTRY_HEX);
const LATEST_TIMESTAMP = 10_000n;
const CHAIN_ID = DEFAULT_NETWORK_CONFIG.pcashChainId;
const FUNDING_LEAF = 42n;
const L1_HASH = `0x${"22".repeat(32)}`;
const CREATION_FEE = 3n;
const FUNDING_FEE = 1n;
const OPEN_FEES = { creationOpenFeeAmount: CREATION_FEE, fundingOpenFeeAmount: FUNDING_FEE };
const NO_OPEN_FEES = { creationOpenFeeAmount: 0n, fundingOpenFeeAmount: 0n };
const NODE_CAPABILITIES = { acceptedTransactionTypes: [0, 1, 2, 3], acceptedBatchVersions: [1] } as const;

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
    contentHash: kind === "contractAccount" ? L2_CONTRACT_CONTENT_HASH : FUNDING_CONTENT_HASH,
    transactionId: kind === "contractAccount" ? `0x${"e1".repeat(32)}` : `0x${"e2".repeat(32)}`,
    outcome: "succeeded",
    failureDetail: null,
    kind,
    fundingMode: kind === "contractAccount" ? "sponsored" : null,
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

function runtime(events: string[], recovered: SpendableNote[], fees = OPEN_FEES): PublishOfferRuntime {
  return {
    submitBuiltTransaction: async (entry) => {
      const isL2Contract = bytesToHex(entry) === bytesToHex(
        encodeContractAccountCreation(offer.chainId, offer.l2ContractBody, sponsoredContractFunding(FUNDING_ANCHOR)),
      );
      events.push(isL2Contract ? "submit L2 smart contract" : "submit funding");
      return { contentHash: isL2Contract ? L2_CONTRACT_CONTENT_HASH : FUNDING_CONTENT_HASH, receipt: null, queued: true };
    },
    runSponsoredContractCreationFlow: async (params) => {
      events.push("sponsor L2 smart contract");
      assert.equal(params.openFeeAmount, fees.creationOpenFeeAmount);
      assert.equal(params.contract.address, offer.l2ContractAddress);
      assert.equal(bytesToHex(params.contract.body), bytesToHex(offer.l2ContractBody));
      assert.equal(params.validUntilTimestamp, offer.terms.deadlineT - MIN_CLAIM_WINDOW_SECONDS - 1n);
      await params.onPreparedContentHash?.(L2_CONTRACT_CONTENT_HASH, SPONSORED_L2_CONTRACT_ENTRY_HEX);
      return {
        contentHash: L2_CONTRACT_CONTENT_HASH,
        transactionHex: SPONSORED_L2_CONTRACT_ENTRY_HEX,
        queued: true,
        settled: false,
        changeAmount: 0n,
      };
    },
    awaitAcceptedReceipt: async (_node, contentHash) => {
      events.push(`await ${contentHash}`);
      return contentHash === L2_CONTRACT_CONTENT_HASH ? receipt("contractAccount", null) : receipt("privateValue", FUNDING_LEAF);
    },
    preflightNoteFundedTransfer: async (params) => {
      events.push("preflight funding");
      assert.equal(params.wallet.network.chainId, CHAIN_ID);
      assert.equal(params.amount, offer.terms.amount);
      assert.equal(params.openFeeAmount, fees.creationOpenFeeAmount + fees.fundingOpenFeeAmount);
      assert.equal(params.issuanceOwnerCommitment, 0n);
      assert.equal(params.to, numberToHex(offer.l2ContractAddress, { size: 20 }));
      assert.equal(params.validUntilTimestamp, offer.terms.deadlineT - MIN_CLAIM_WINDOW_SECONDS - 1n);
      return { inputCount: 1, inputTotal: offer.terms.amount + fees.creationOpenFeeAmount + fees.fundingOpenFeeAmount };
    },
    runNoteFundedTransferFlow: async (params) => {
      events.push("fund escrow");
      assert.equal(params.wallet.network.chainId, CHAIN_ID);
      assert.equal(params.amount, offer.terms.amount);
      assert.equal(params.openFeeAmount, fees.fundingOpenFeeAmount);
      assert.equal(params.issuanceOwnerCommitment, 0n);
      assert.equal(params.validUntilTimestamp, offer.terms.deadlineT - MIN_CLAIM_WINDOW_SECONDS - 1n);
      assert.equal(params.to, numberToHex(offer.l2ContractAddress, { size: 20 }));
      await params.beforeSubmit?.();
      await params.onPreparedContentHash?.(FUNDING_CONTENT_HASH, FUNDING_ENTRY_HEX);
      return {
        contentHash: FUNDING_CONTENT_HASH,
        recipient: params.to,
        amount: params.amount,
        changeAmount: 1n,
        settled: false,
        queued: true,
      };
    },
    preflightTokenEscrowFunding: async () => { throw new Error("native offers do not fund a token escrow"); },
    runTokenEscrowFundingFlow: async () => { throw new Error("native offers do not fund a token escrow"); },
    recoverTokenEscrow: async () => { throw new Error("native offers do not recover a token escrow"); },
    scanWallet: async (_node, wallet, chainId, range) => {
      events.push("scan escrow");
      assert.equal(wallet.address, offer.l2ContractAddress);
      assert.equal(chainId, CHAIN_ID);
      assert.equal(range, undefined);
      return {
        scanned: recovered.length,
        decrypted: recovered.length,
        trialDecryptAttempts: recovered.length,
        recovered,
        sent: [],
        transactionRecords: [],
        receivedData: [],
      };
    },
  };
}

describe("publishOffer", () => {
  it("passes an application ceiling to selected sponsored creation for a multi-day offer", async () => {
    const events: string[] = [];
    const selected = runtime(events, []);
    const multiDayOffer = { ...offer, terms: { ...offer.terms, deadlineT: LATEST_TIMESTAMP + 3n * 86_400n } };
    selected.preflightNoteFundedTransfer = async () => ({ inputCount: 1, inputTotal: 1n });
    selected.runSponsoredContractCreationFlow = async (params) => {
      assert.equal(params.validUntilTimestamp, multiDayOffer.terms.deadlineT - MIN_CLAIM_WINDOW_SECONDS - 1n);
      assert.equal(params.validUntilMode, "ceiling");
      throw new Error("creation checked");
    };
    await assert.rejects(runPublish({
      offer: multiDayOffer, ...NO_OPEN_FEES, privateRelayFeeAmount: 1n,
      selectedRelayQuote: { recipient: 1n, requestQuote: async () => { throw new Error("stubbed publication must not quote"); } },
      readL1Timestamp: async () => LATEST_TIMESTAMP,
    }, selected), /creation checked/);
  });

  it("continues directly published registration and funding without relaying them again", async () => {
    const events: string[] = [];
    const direct = runtime(events, [recoveredNote()]);
    const creation = direct.runSponsoredContractCreationFlow;
    const funding = direct.runNoteFundedTransferFlow;
    direct.runSponsoredContractCreationFlow = async (params) => ({ ...await creation(params), queued: false });
    direct.runNoteFundedTransferFlow = async (params) => ({ ...await funding(params), queued: false });
    const opening = await runPublish({
      offer, ...OPEN_FEES, readL1Timestamp: async () => 1n,
      relay: async () => { throw new Error("already published to Ethereum"); },
    }, direct, node, async () => { events.push("scan seller change"); });
    assert.ok(opening);
    assert.deepEqual(events, [
      "preflight funding", "sponsor L2 smart contract", `await ${L2_CONTRACT_CONTENT_HASH}`,
      "scan seller change", "fund escrow", `await ${FUNDING_CONTENT_HASH}`, "scan escrow",
    ]);
  });

  it("resumes a saved registration by relaying it and then its funding in dependency order", async () => {
    const events: string[] = [];
    const result = await runPublish({
      offer, ...OPEN_FEES, readL1Timestamp: async () => 1n,
      resume: { l2ContractContentHash: L2_CONTRACT_CONTENT_HASH },
      relay: async (id) => { events.push(`relay ${id}`); },
    }, runtime(events, [recoveredNote()]));
    assert.ok(result);
    assert.deepEqual(events, [
      `relay ${L2_CONTRACT_CONTENT_HASH}`, `await ${L2_CONTRACT_CONTENT_HASH}`,
      "fund escrow", `relay ${FUNDING_CONTENT_HASH}`, `await ${FUNDING_CONTENT_HASH}`, "scan escrow",
    ]);
  });

  it("requires more than the minimum claim window on the selected L1", () => {
    assert.doesNotThrow(() => assertOfferPublicationWindow(MIN_CLAIM_WINDOW_SECONDS + 700n, 699n));
    assert.throws(() => assertOfferPublicationWindow(MIN_CLAIM_WINDOW_SECONDS + 700n, 700n), /deadline is too close/);
  });

  it("rejects a signerless wallet before submitting the contract account", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pcash-publish-watch-only-"));
    const wallet = await openNodeWallet({ dataDir, node, profile: sellerWallet });
    const events: string[] = [];
    try {
      await assert.rejects(publishOffer({
        wallet,
        offer,
        ...OPEN_FEES,
        readL1Timestamp: async () => 0n,
      }, runtime(events, [recoveredNote()])), /requires a spendable wallet/);
      assert.deepEqual(events, []);
    } finally {
      await wallet.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("sponsors the contract creation fee, checkpoints both tx ids, waits in dependency order, and returns the exact funding leaf", async () => {
    const events: string[] = [];
    const opening = await runPublish({
      offer,
      ...OPEN_FEES,
      readL1Timestamp: async () => 0n,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.fundingContentHash === undefined) {
          assert.equal(checkpoint.l2ContractTransactionHex, SPONSORED_L2_CONTRACT_ENTRY_HEX);
        } else {
          assert.equal(checkpoint.fundingTransactionHex, FUNDING_ENTRY_HEX);
        }
        events.push(checkpoint.fundingAcceptedBlock !== undefined
          ? "accepted funding"
          : checkpoint.fundingContentHash !== undefined
            ? "checkpoint funding"
            : checkpoint.l2ContractAcceptedBlock !== undefined
              ? "accepted L2 smart contract"
              : "checkpoint L2 smart contract");
      },
    }, runtime(events, [
      recoveredNote({ leafIndex: FUNDING_LEAF - 1n, noteSecret: 0xdefn }),
      recoveredNote(),
    ]), node, async () => { events.push("scan seller change"); });

    assert.deepEqual(events, [
      "preflight funding",
      "sponsor L2 smart contract",
      "checkpoint L2 smart contract",
      `await ${L2_CONTRACT_CONTENT_HASH}`,
      "accepted L2 smart contract",
      "scan seller change",
      "fund escrow",
      "checkpoint funding",
      `await ${FUNDING_CONTENT_HASH}`,
      "accepted funding",
      "scan escrow",
    ]);
    assert.deepEqual(opening, {
      leafIndex: Number(FUNDING_LEAF),
      noteSecret: fieldToHex(0xabcn),
      amount: fieldToHex(offer.terms.amount),
    });
  });

  it("funds a token offer with one asset send under the seller-derived escrow secret", async () => {
    const events: string[] = [];
    const token = testToken();
    const tokenOffer = { ...offer, terms: { ...offer.terms, assetId: token.assetId } };
    const noteSecret = deriveTokenEscrowNoteSecret({
      seller: sellerWallet, chainId: CHAIN_ID, offerId: tokenOffer.terms.id, contractAddress: tokenOffer.l2ContractAddress,
    });
    const tokens = runtime(events, []);
    tokens.preflightNoteFundedTransfer = async () => { throw new Error("token offers fund no native escrow"); };
    tokens.runNoteFundedTransferFlow = async () => { throw new Error("token offers fund no native escrow"); };
    tokens.scanWallet = async () => { throw new Error("a token escrow opens from its derived secret"); };
    tokens.preflightTokenEscrowFunding = async (params) => {
      events.push("preflight token funding");
      assert.equal(params.assetId, token.assetId);
      assert.equal(params.amount, tokenOffer.terms.amount);
      assert.equal(params.openFeeAmount, CREATION_FEE + FUNDING_FEE);
      assert.equal(params.validUntilTimestamp, tokenOffer.terms.deadlineT - MIN_CLAIM_WINDOW_SECONDS - 1n);
    };
    tokens.runTokenEscrowFundingFlow = async (params) => {
      events.push("fund token escrow");
      assert.equal(params.assetId, token.assetId);
      assert.equal(params.amount, tokenOffer.terms.amount);
      assert.equal(params.noteSecret, noteSecret);
      assert.equal(params.openFeeAmount, FUNDING_FEE);
      assert.equal(params.validUntilTimestamp, tokenOffer.terms.deadlineT - MIN_CLAIM_WINDOW_SECONDS - 1n);
      assert.equal(params.to, buildExtendedCode({
        chainId: CHAIN_ID, address: tokenOffer.l2ContractAddress, mlKemPublicKey: tokenOffer.l2ContractWallet.mlKemPublicKey,
      }));
      await params.beforeSubmit?.();
      await params.onPreparedContentHash?.(FUNDING_CONTENT_HASH, FUNDING_ENTRY_HEX);
      return { contentHash: FUNDING_CONTENT_HASH, queued: true };
    };
    tokens.recoverTokenEscrow = async (_node, receipt, note) => {
      events.push("recover token escrow");
      assert.equal(receipt.outputLeafStart, FUNDING_LEAF);
      assert.deepEqual(note, {
        owner: tokenOffer.l2ContractAddress, assetId: token.assetId, amount: tokenOffer.terms.amount, noteSecret,
      });
      return { leafIndex: Number(FUNDING_LEAF), noteSecret: fieldToHex(noteSecret), amount: fieldToHex(tokenOffer.terms.amount) };
    };
    const opening = await runPublish({
      offer: tokenOffer, ...OPEN_FEES, readL1Timestamp: async () => 0n,
      relay: async (id) => { events.push(`relay ${id}`); },
    }, tokens);
    assert.deepEqual(opening, {
      leafIndex: Number(FUNDING_LEAF), noteSecret: fieldToHex(noteSecret), amount: fieldToHex(tokenOffer.terms.amount),
    });
    assert.deepEqual(events, [
      "preflight token funding", "sponsor L2 smart contract", `relay ${L2_CONTRACT_CONTENT_HASH}`, `await ${L2_CONTRACT_CONTENT_HASH}`,
      "fund token escrow", `relay ${FUNDING_CONTENT_HASH}`, `await ${FUNDING_CONTENT_HASH}`, "recover token escrow",
    ]);
  });

  it("sponsors the creation even when no relayer fee is offered", async () => {
    const events: string[] = [];
    await runPublish({
      offer,
      ...NO_OPEN_FEES,
      readL1Timestamp: async () => 0n,
    }, runtime(events, [recoveredNote()], NO_OPEN_FEES));

    assert.deepEqual(events, [
      "preflight funding",
      "sponsor L2 smart contract",
      `await ${L2_CONTRACT_CONTENT_HASH}`,
      "fund escrow",
      `await ${FUNDING_CONTENT_HASH}`,
      "scan escrow",
    ]);
  });

  it("budgets the creation fee and the funding fee before publishing anything", async () => {
    // Publication pays two relayer fees: the creation pays its fee from the
    // seller's notes, then the funding transfer pays its own. A balance that
    // covers only one must be refused before the irreversible creation.
    const events: string[] = [];
    const budget = offer.terms.amount + CREATION_FEE;
    const runtimeWithBudget = (): PublishOfferRuntime => ({
      ...runtime(events, [recoveredNote()]),
      preflightNoteFundedTransfer: async (params) => {
        events.push("preflight funding");
        if (params.amount + (params.openFeeAmount ?? 0n) > budget) {
          throw new Error(`insufficient notes to cover ${params.amount + (params.openFeeAmount ?? 0n)}`);
        }
        return { inputCount: 1, inputTotal: budget };
      },
    });
    await assert.rejects(runPublish({
      offer,
      ...OPEN_FEES,
      readL1Timestamp: async () => 0n,
    }, runtimeWithBudget()), /insufficient notes/);
    assert.deepEqual(events, ["preflight funding"]);

    // Nothing was created: the seller keeps its balance instead of paying for
    // a contract it can never fund.
    assert.equal(events.includes("sponsor L2 smart contract"), false);
  });

  it("relays a pending registration before selecting funding inputs from its change", async () => {
    const events: string[] = [];
    await runPublish({
      offer,
      ...OPEN_FEES,
      readL1Timestamp: async () => 0n,
      resume: { l2ContractContentHash: L2_CONTRACT_CONTENT_HASH },
      relay: async (id) => { events.push(`relay ${id}`); },
    }, {
      ...runtime(events, [recoveredNote()]),
      preflightNoteFundedTransfer: async () => { throw new Error("registration still reserves the only note"); },
    }, node, async () => { events.push("sync change"); });
    assert.deepEqual(events, [
      `relay ${L2_CONTRACT_CONTENT_HASH}`, `await ${L2_CONTRACT_CONTENT_HASH}`, "sync change",
      "fund escrow", `relay ${FUNDING_CONTENT_HASH}`, `await ${FUNDING_CONTENT_HASH}`, "scan escrow",
    ]);
  });

  it("resumes from admitted L2 smart contract and funding ids without re-admitting", async () => {
    const events: string[] = [];
    await runPublish({
      offer,
      ...OPEN_FEES,
      readL1Timestamp: async () => 700n,
      resume: { l2ContractContentHash: L2_CONTRACT_CONTENT_HASH, fundingContentHash: FUNDING_CONTENT_HASH },
      onCheckpoint: (checkpoint) => { events.push(checkpoint.fundingContentHash ? "accepted funding" : "accepted L2 smart contract"); },
    }, runtime(events, [recoveredNote()]));

    assert.deepEqual(events, [
      `await ${L2_CONTRACT_CONTENT_HASH}`,
      "accepted L2 smart contract",
      `await ${FUNDING_CONTENT_HASH}`,
      "accepted funding",
      "scan escrow",
    ]);
  });

  it("re-admits exact persisted L2 smart contract and funding bytes when no accepted receipt exists", async () => {
    const events: string[] = [];
    const restoredNode = simNode(sellerChain, {
      getBlockByHash: async () => ({
        hash: numberToHex(FUNDING_ANCHOR, { size: 32 }),
        timestamp: sellerChain.status().latestBlockTimestamp - 1n,
      }),
    });
    await runPublish({
      offer,
      ...OPEN_FEES,
      readL1Timestamp: async () => 0n,
      resume: {
        l2ContractContentHash: L2_CONTRACT_CONTENT_HASH,
        l2ContractTransactionHex: bytesToHex(L2_CONTRACT_ENTRY),
        fundingContentHash: FUNDING_CONTENT_HASH,
        fundingTransactionHex: FUNDING_ENTRY_HEX,
      },
    }, runtime(events, [recoveredNote()]), restoredNode);

    assert.deepEqual(events, [
      "submit L2 smart contract",
      `await ${L2_CONTRACT_CONTENT_HASH}`,
      "submit funding",
      `await ${FUNDING_CONTENT_HASH}`,
      "scan escrow",
    ]);
  });

  it("rejects amount matches at other leaves and other amounts at the funding leaf", async () => {
    const events: string[] = [];
    await assert.rejects(
      runPublish({
        offer,
        ...OPEN_FEES,
        readL1Timestamp: async () => 700n,
        resume: { l2ContractContentHash: L2_CONTRACT_CONTENT_HASH, fundingContentHash: FUNDING_CONTENT_HASH },
      }, runtime(events, [
        recoveredNote({ leafIndex: FUNDING_LEAF - 1n }),
        recoveredNote({ amount: offer.terms.amount - 1n }),
      ])),
      /did not recover.*funding leaf 42/,
    );
  });

  it("does not create an L2 smart contract after the publication window closes", async () => {
    const events: string[] = [];
    await assert.rejects(
      runPublish({
        offer,
        ...OPEN_FEES,
        readL1Timestamp: async () => 700n,
        onCheckpoint: () => { events.push("unexpected checkpoint"); },
      }, runtime(events, [recoveredNote()])),
      /deadline is too close/,
    );
    assert.deepEqual(events, []);
  });

  it("does not create an L2 smart contract when the seller cannot fund the escrow", async () => {
    const events: string[] = [];
    const blockedRuntime = runtime(events, [recoveredNote()]);
    blockedRuntime.preflightNoteFundedTransfer = async () => {
      events.push("preflight funding");
      throw new Error("insufficient notes to cover 50");
    };
    await assert.rejects(
      runPublish({
        offer,
        ...OPEN_FEES,
        readL1Timestamp: async () => 0n,
        onCheckpoint: () => { events.push("unexpected checkpoint"); },
      }, blockedRuntime),
      /insufficient notes to cover 50/,
    );
    assert.deepEqual(events, ["preflight funding"]);
  });

  for (const fee of [offer.terms.amount, offer.terms.amount * 2n]) it(`funds the full escrow with an additional fee of ${fee}`, async () => {
    const events: string[] = [];
    await runPublish({
      offer,
      creationOpenFeeAmount: fee,
      fundingOpenFeeAmount: fee,
      readL1Timestamp: async () => 0n,
    }, runtime(events, [recoveredNote()], { creationOpenFeeAmount: fee, fundingOpenFeeAmount: fee }));
    assert.ok(events.includes("preflight funding"));
    assert.ok(events.includes("fund escrow"));
  });

  for (const step of ["creation", "funding"] as const) it(`rejects a negative ${step} fee before creating accounts`, async () => {
    const fees = { ...OPEN_FEES, [`${step}OpenFeeAmount`]: -1n };
    const events: string[] = [];
    await assert.rejects(
      runPublish({
        offer,
        ...fees,
        readL1Timestamp: async () => 0n,
        onCheckpoint: () => { events.push("unexpected checkpoint"); },
      }, runtime(events, [recoveredNote()])),
      /fee must be nonnegative/,
    );
    assert.deepEqual(events, []);
  });

  it("rechecks the deadline after proving and before journaling escrow funding", async () => {
    const events: string[] = [];
    const timestamps = [0n, 0n, 700n];
    await assert.rejects(
      runPublish({
        offer,
        ...OPEN_FEES,
        readL1Timestamp: async () => timestamps.shift() ?? 700n,
        onCheckpoint: (checkpoint) => {
          events.push(checkpoint.fundingContentHash === undefined ? "checkpoint L2 smart contract" : "checkpoint funding");
        },
      }, runtime(events, [recoveredNote()])),
      /deadline is too close/,
    );
    assert.deepEqual(events, [
      "preflight funding",
      "sponsor L2 smart contract",
      "checkpoint L2 smart contract",
      `await ${L2_CONTRACT_CONTENT_HASH}`,
      "checkpoint L2 smart contract",
      "fund escrow",
    ]);
  });

  it("does not restore dropped prepared transactions after the publication window closes", async () => {
    const events: string[] = [];
    // The simulated node has no receipt and no mempool entry for either transaction.
    const droppedNode = simNode(sellerChain);
    await assert.rejects(
      runPublish({
        offer,
        ...OPEN_FEES,
        readL1Timestamp: async () => 700n,
        resume: { l2ContractContentHash: L2_CONTRACT_CONTENT_HASH, l2ContractTransactionHex: bytesToHex(L2_CONTRACT_ENTRY) },
      }, runtime(events, [recoveredNote()]), droppedNode),
      /deadline is too close/,
    );
    assert.deepEqual(events, []);
  });

  it("distinguishes accepted publication receipts from finalized receipts", async () => {
    let finalizedL1BlockNumber = 89n;
    const finalityNode = {
      getReceipt: async () => [{
        contentHash: L2_CONTRACT_CONTENT_HASH,
        transactionId: `0x${"e1".repeat(32)}`,
        outcome: "succeeded",
        failureDetail: null,
        l1Sender: "0x0000000000000000000000000000000000000000",
        issuanceOwnerCommitment: null,
        settledOpenFeeAmount: 0n,
        settledIssuanceAmount: 0n,
        kind: "contractAccount",
        inclusion: {
          l1BlockNumber: 90n,
          l1BlockHash: L1_HASH,
          l1TransactionIndex: 0n,
          batchItemIndex: 0n,
        },
        outputLeafStart: null,
      }],
      status: async () => ({ ...NODE_CAPABILITIES, finalizedL1BlockNumber }),
    } as unknown as PcashNodeClient;

    assert.equal((await readOfferPublicationFinality(finalityNode, L2_CONTRACT_CONTENT_HASH, "contractAccount")).phase, "accepted");
    finalizedL1BlockNumber = 90n;
    assert.equal((await readOfferPublicationFinality(finalityNode, L2_CONTRACT_CONTENT_HASH, "contractAccount")).phase, "finalized");
  });
});

describe("Fast listing batches", () => {
  function fastRuntime(events: string[]) {
    const value = runtime(events, [recoveredNote()]);
    value.preflightNoteFundedTransfer = async (params) => {
      assert.equal(params.openFeeAmount, FUNDING_FEE);
      assert.notEqual(params.to, numberToHex(offer.l2ContractAddress, { size: 20 }));
      return { inputCount: 1, inputTotal: offer.terms.amount + FUNDING_FEE };
    };
    value.runSponsoredContractCreationFlow = async (params) => {
      assert.equal(params.openFeeAmount, 0n);
      assert.equal(params.submission?.prepareOnly, true);
      events.push("authorize creation");
      await params.onPreparedContentHash?.(L2_CONTRACT_CONTENT_HASH, SPONSORED_L2_CONTRACT_ENTRY_HEX);
      return { contentHash: L2_CONTRACT_CONTENT_HASH, transactionHex: SPONSORED_L2_CONTRACT_ENTRY_HEX, queued: false, settled: false, changeAmount: 0n };
    };
    value.runNoteFundedTransferFlow = async (params) => {
      assert.equal(params.submission?.prepareOnly, true);
      assert.equal(params.openFeeAmount, FUNDING_FEE);
      assert.notEqual(params.to, numberToHex(offer.l2ContractAddress, { size: 20 }));
      events.push("authorize funding");
      await params.onPreparedContentHash?.(FUNDING_CONTENT_HASH, FUNDING_ENTRY_HEX);
      return { contentHash: FUNDING_CONTENT_HASH, recipient: params.to, amount: params.amount, changeAmount: 1n, settled: false, queued: false };
    };
    return value;
  }
  const resume = { l2ContractContentHash: L2_CONTRACT_CONTENT_HASH, l2ContractTransactionHex: SPONSORED_L2_CONTRACT_ENTRY_HEX,
    fundingContentHash: FUNDING_CONTENT_HASH, fundingTransactionHex: FUNDING_ENTRY_HEX };
  function fastNode(accepted: string[] = []): PcashNodeClient {
    return simNode(sellerChain, { getReceipt: async ({ contentHash }: { contentHash: string }) => {
      if (!accepted.includes(contentHash)) return [];
      const parsed = receipt(contentHash === L2_CONTRACT_CONTENT_HASH ? "contractAccount" : "privateValue", contentHash === L2_CONTRACT_CONTENT_HASH ? null : 42n);
      return [{ ...parsed, contentHash, inclusion: { ...parsed.inclusion, l1BlockNumber: 90n, l1BlockHash: L1_HASH } }];
    } });
  }
  it("saves both authorizations before one ordered Ethereum submission", async () => {
    const events: string[] = [];
    const checkpoints: unknown[] = [];
    const result = await runPublish({ offer, ...OPEN_FEES, readL1Timestamp: async () => 0n,
      onCheckpoint: checkpoint => { checkpoints.push(checkpoint); },
      submission: { mode: "l1", preflight: async ({ transactionBytes: entry, additionalTransactions }) => {
        assert.equal(bytesToHex(entry), SPONSORED_L2_CONTRACT_ENTRY_HEX);
        assert.deepEqual(additionalTransactions?.map(entry => bytesToHex(entry)), [FUNDING_ENTRY_HEX]);
        assert.deepEqual(checkpoints[1], resume);
      }, submit: async () => {
        events.push("Ethereum approval");
        return { accepted: false, queued: false, output: undefined };
      } },
    }, fastRuntime(events), fastNode());
    assert.equal(result?.leafIndex, Number(FUNDING_LEAF));
    assert.deepEqual(events.slice(0, 3), ["authorize creation", "authorize funding", "Ethereum approval"]);
  });
  for (const accepted of [[], [L2_CONTRACT_CONTENT_HASH], [FUNDING_CONTENT_HASH], [L2_CONTRACT_CONTENT_HASH, FUNDING_CONTENT_HASH]]) {
    it(`resumes exact bytes with ${accepted.length} accepted batch items (${accepted[0] ?? "none"})`, async () => {
      const events: string[] = [];
      let submissions = 0;
      const missing = [L2_CONTRACT_CONTENT_HASH, FUNDING_CONTENT_HASH].filter(id => !accepted.includes(id));
      await runPublish({
        offer, ...OPEN_FEES, readL1Timestamp: async () => 0n, resume: {
          l2ContractContentHash: L2_CONTRACT_CONTENT_HASH, fundingContentHash: FUNDING_CONTENT_HASH,
          ...(accepted.includes(L2_CONTRACT_CONTENT_HASH) ? {} : { l2ContractTransactionHex: SPONSORED_L2_CONTRACT_ENTRY_HEX }),
          ...(accepted.includes(FUNDING_CONTENT_HASH) ? {} : { fundingTransactionHex: FUNDING_ENTRY_HEX }),
        },
        submission: {
          mode: "l1", preflight: async ({ additionalTransactions, transactionBytes }) => {
            const { contentHash } = submissionIdentity(transactionBytes);

            assert.equal(contentHash, missing[0]);
            assert.equal(additionalTransactions?.length, missing.length - 1);
          }, submit: async () => {
            submissions++;
            return { accepted: false, queued: false, output: undefined };
          }
        },
      }, fastRuntime(events), fastNode(accepted));
      assert.equal(submissions, missing.length ? 1 : 0);
      assert.ok(!events.some(event => event.startsWith("authorize")));
    });
  }
  it("finishes mempool publication when both finalized checkpoints have discarded their bytes", async () => {
    const events: string[] = [];
    const result = await runPublish({ offer, ...OPEN_FEES, readL1Timestamp: async () => 0n,
      resume: { l2ContractContentHash: L2_CONTRACT_CONTENT_HASH, fundingContentHash: FUNDING_CONTENT_HASH },
    }, runtime(events, [recoveredNote()]), fastNode([L2_CONTRACT_CONTENT_HASH, FUNDING_CONTENT_HASH]));
    assert.equal(result?.leafIndex, Number(FUNDING_LEAF));
    assert.ok(!events.includes("fund escrow"));
    assert.ok(!events.includes("sponsor L2 smart contract"));
  });
  it("waits for a known pending partial batch instead of sending it twice", async () => {
    await runPublish({ offer, ...OPEN_FEES, readL1Timestamp: async () => 0n, resume,
      submission: { mode: "l1", l1Recovery: async () => ({
        reconcile: async () => ({ latched: true, entries: [] }),
        show: async () => ({ latched: true, entries: [{ kind: "batch", transactionHash: L1_HASH, selected: [FUNDING_CONTENT_HASH] }] }),
      }) as never, preflight: async () => { assert.fail("must not prepare a duplicate batch"); },
      submit: async () => { assert.fail("must not request another approval"); } },
    }, fastRuntime([]), fastNode([L2_CONTRACT_CONTENT_HASH]));
  });
  it("retains both entries when the Ethereum wallet rejects so Continue needs no new PCASH authorizations", async () => {
    let saved: typeof resume | undefined;
    await assert.rejects(runPublish({ offer, ...OPEN_FEES, readL1Timestamp: async () => 0n,
      onCheckpoint: checkpoint => { saved = checkpoint as typeof resume; },
      submission: { mode: "l1", preflight: async () => undefined,
        submit: async () => { throw new Error("User rejected Ethereum approval"); } },
    }, fastRuntime([]), fastNode()), /rejected/);
    assert.deepEqual(saved, resume);
  });
});
