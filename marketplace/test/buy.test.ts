import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytesToHex, createPublicClient, custom, decodeFunctionData, hexToBytes, type Hex } from "viem";
import { buildContractBody, functionSelector } from "@pcash/sdk/protocol";
import {
  BN254_SCALAR_MODULUS,
  DEFAULT_NETWORK_CONFIG,
  fullOutputCommitment,
  generateMlKemKeyPair,
} from "@pcash/sdk/browser";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { claimKeyCommitment, toBytes32 } from "../src/commitments.mts";
import {
  assertPaymentRecoveryHead,
  assertRouterCallBudget,
  buildBuyCall,
  buildRetryCall,
  buyNotAfter,
  checkPaymentBalance,
  CLAIM_BATCH_BYTES,
  claimBatchStandIn,
  derivePurchaseSecrets,
  estimateRouterCallsGas,
  InsufficientPaymentBalanceError,
  isPaymentConfirmationPending,
  PaymentTransactionCancelledError,
  PaymentTransactionRevertedError,
  purchaseCommitment,
  purchaseEscrowOutputCommitment,
  replacementPayResult,
  selectRecoverablePayment,
  submitRouterCallWithCallbacks,
  successfulPayResult,
  waitForHistoricalPaymentAnchor,
  type CarriedClaim,
} from "../src/client/buy.ts";
import { encodePaymentRecovery } from "../src/client/paymentRecovery.ts";
import { PAYMENT_ROUTER_ABI } from "../src/client/paymentRouter.ts";
import { addressHex } from "@pcash/sdk/browser";
import type { OfferPublication } from "../src/client/publication.ts";

const ROUTER = 0x00000000000000000000000000000000000000aan;
const OFFER_ID = 0x0ffe1n;
const ETH_PRICE_WEI = 50_000_000_000_000_000n;
const PCASH_AMOUNT = 250_000_000_000_000_000n;
const DEADLINE_T = 4_000_000_000n;
const ANCHOR = { blockNumber: 123n, blockHash: `0x${"ab".repeat(32)}` as const };
const NOT_AFTER = 1_700_003_540n;
const BATCH = `0x${"5a".repeat(70)}` as Hex;
const CARRIED: CarriedClaim = { anchor: ANCHOR, notAfter: NOT_AFTER, batch: BATCH };

const contract = buildContractBody({
  nullifierKey: { publishesNkRoot: true, nkRoot: 0x1234n },
  mlKemPublicKey: generateMlKemKeyPair().publicKey,
  functions: [
    { selector: functionSelector(0), applicationVkHash: 1n, configurationCommitment: 1n },
    { selector: functionSelector(1), applicationVkHash: 1n, configurationCommitment: 1n },
  ],
});
const pub = {
  reclaimAuthority: addressHex(0xbbn),
  terms: { router: addressHex(ROUTER), seller: addressHex(0xbbn), id: `0x${OFFER_ID.toString(16)}`, assetId: "0x0", amount: `0x${PCASH_AMOUNT.toString(16)}`, ethPriceWei: `0x${ETH_PRICE_WEI.toString(16)}`, deadlineT: `0x${DEADLINE_T.toString(16)}` },
  chainId: "0x1234",
  l2Contract: { bodyHex: bytesToHex(contract.body), claimConfigurationSalt: "0x1", reclaimConfigurationSalt: "0x1" },
  escrow: { leafIndex: 7, noteSecret: "0x89", amount: `0x${PCASH_AMOUNT.toString(16)}` },
} as unknown as OfferPublication;
const wallet = derivePcashProfileFromPrivateKey(
  new Uint8Array(32).fill(0x11),
  DEFAULT_NETWORK_CONFIG,
);

describe("router calls", () => {
  it("buy() pays the gross price and carries the claim batch under its snapshot anchor and notAfter", () => {
    const call = buildBuyCall(pub, wallet, CARRIED);
    assert.equal(call.functionName, "buy");
    assert.equal(call.to.toLowerCase(), addressHex(ROUTER));
    assert.equal(call.value, ETH_PRICE_WEI);
    assert.deepEqual(call.anchor, ANCHOR);
    const decoded = decodeFunctionData({ abi: PAYMENT_ROUTER_ABI, data: call.data });
    assert.equal(decoded.functionName, "buy");
    assert.deepEqual(decoded.args, [
      toBytes32(OFFER_ID), addressHex(0xbbn), purchaseCommitment(pub, wallet),
      ANCHOR.blockNumber, ANCHOR.blockHash, NOT_AFTER, encodePaymentRecovery(pub), BATCH,
    ]);
  });

  it("buy() executes no later than 24 hours before T", () => {
    const cutoff = DEADLINE_T - 86_400n;
    assert.equal(buyNotAfter(pub, cutoff - 1n), cutoff - 1n);
    assert.equal(buyNotAfter(pub, cutoff + 1n), cutoff);
    const call = buildBuyCall(pub, wallet, { ...CARRIED, notAfter: DEADLINE_T });
    assert.equal(decodeFunctionData({ abi: PAYMENT_ROUTER_ABI, data: call.data }).args[5], cutoff);
  });

  it("retry() carries a fresh batch for the recorded payment and pays nothing", () => {
    const call = buildRetryCall(pub, "0x01");
    assert.equal(call.functionName, "retry");
    assert.equal(call.value, 0n);
    assert.equal(call.to.toLowerCase(), addressHex(ROUTER));
    const decoded = decodeFunctionData({ abi: PAYMENT_ROUTER_ABI, data: call.data });
    assert.equal(decoded.functionName, "retry");
    assert.deepEqual(decoded.args, [toBytes32(OFFER_ID), addressHex(0xbbn), ETH_PRICE_WEI, "0x01"]);
  });

  it("binds the claim key and exact funded escrow, with no purchase-time route or entropy", () => {
    const secrets = derivePurchaseSecrets(pub, wallet);
    const escrowOutputCommitment = fullOutputCommitment({
      owner: contract.address, noteSecret: 0x89n, assetId: 0n, amount: PCASH_AMOUNT,
    }, 7);
    assert.equal(purchaseEscrowOutputCommitment(pub), escrowOutputCommitment);
    assert.equal(purchaseCommitment(pub, wallet), toBytes32(claimKeyCommitment(
      secrets.claimKey, escrowOutputCommitment,
    )));
  });

  it("produces a different commitment for a different offer id or another funded note", () => {
    const a = purchaseCommitment(pub, wallet);
    const otherOffer = { ...pub, terms: { ...pub.terms, id: "0x0ffe2" } } as OfferPublication;
    const otherNote = { ...pub, escrow: { ...pub.escrow!, noteSecret: "0x8a" } } as OfferPublication;
    assert.notEqual(purchaseCommitment(otherOffer, wallet), a);
    assert.notEqual(purchaseCommitment(otherNote, wallet), a);
  });

  it("prices a call before the claim is proved with a stand-in of the claim batch's exact size", () => {
    assert.equal(hexToBytes(claimBatchStandIn()).length, CLAIM_BATCH_BYTES);
    assert.ok(hexToBytes(claimBatchStandIn()).every((byte) => byte === 255));
  });

});

describe("wallet-recoverable purchase secrets", () => {
  it("re-derives the same nonzero claim key", () => {
    const first = derivePurchaseSecrets(pub, wallet);
    const restored = derivePurchaseSecrets(pub, wallet);
    assert.deepEqual(restored, first);
    assert.ok(first.claimKey > 0n && first.claimKey < BN254_SCALAR_MODULUS);
  });

  it("binds the claim key to the wallet and immutable listing identity", () => {
    const original = derivePurchaseSecrets(pub, wallet);
    const otherWallet = derivePurchaseSecrets(
      pub,
      derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(0x12), DEFAULT_NETWORK_CONFIG),
    );
    const otherOffer = derivePurchaseSecrets({
      ...pub,
      terms: { ...pub.terms, id: "0x0ffe2" },
    }, wallet);
    assert.notDeepEqual(otherWallet, original);
    assert.notDeepEqual(otherOffer, original);
  });
});

describe("payment recovery", () => {
  const payer = addressHex(0xccn);
  const hash = `0x${"12".repeat(32)}` as const;
  const commitment = purchaseCommitment(pub, wallet);
  const exact = {
    payer,
    amount: ETH_PRICE_WEI,
    claimKeyCommitment: commitment,
    transactionHash: hash,
    blockNumber: 99n,
  };

  it("restores the canonical payment belonging to the restored wallet", () => {
    assert.deepEqual(selectRecoverablePayment(pub, commitment, [exact]), exact);
  });

  it("refuses to treat a lagging L1 view as proof that a confirmed payment is absent", () => {
    assert.doesNotThrow(() => assertPaymentRecoveryHead(100n, 100n));
    assert.throws(() => assertPaymentRecoveryHead(99n, 100n), /behind confirmed payment block/);
  });

  it("recovers payment by a distinct payer but blocks a different claim key", () => {
    assert.deepEqual(selectRecoverablePayment(pub, commitment, [{ ...exact, payer: addressHex(0xddn) }]).payer, addressHex(0xddn));
    assert.throws(
      () => selectRecoverablePayment(pub, `0x${"34".repeat(32)}`, [exact]),
      /different claim key/,
    );
  });

  it("blocks another payment when the router's record cannot be reconciled to a canonical event", () => {
    assert.throws(
      () => selectRecoverablePayment(pub, commitment, []),
      /canonical Payment event could not be recovered/,
    );
  });
});

describe("payment receipt handling", () => {
  const hash = `0x${"12".repeat(32)}` as const;

  const blockHash = `0x${"9a".repeat(32)}` as const;

  it("returns only successful payments", () => {
    assert.deepEqual(successfulPayResult(hash, { status: "success", blockNumber: 9n, blockHash }, "buy"), {
      hash,
      blockNumber: 9n,
      blockHash,
    });
  });

  it("rejects a reverted one-shot race instead of recording it as paid", () => {
    assert.throws(
      () => successfulPayResult(hash, { status: "reverted", blockNumber: 9n, blockHash }, "buy"),
      /: buy transaction .* reverted$/,
    );
  });

  it("names the router call that reverted", () => {
    assert.throws(
      () => successfulPayResult(hash, { status: "reverted", blockNumber: 9n, blockHash }, "retry"),
      (error: Error) => error instanceof PaymentTransactionRevertedError && error.message === `retry transaction ${hash} reverted`,
    );
  });

  it("keeps a checkpointed payment resumable until its block is recorded", () => {
    assert.equal(isPaymentConfirmationPending({ txHash: hash }), true);
    assert.equal(isPaymentConfirmationPending({ txHash: hash, blockNumber: "9" }), false);
    assert.equal(isPaymentConfirmationPending(undefined), false);
  });

  it("tracks the mined replacement hash and distinguishes cancellation", () => {
    const replacement = `0x${"34".repeat(32)}` as const;
    assert.deepEqual(replacementPayResult(hash, {
      status: "success",
      blockNumber: 10n,
      blockHash,
      transactionHash: replacement,
    }, "buy", "repriced"), {
      hash: replacement,
      blockNumber: 10n,
      blockHash,
      originalHash: hash,
      replacementReason: "repriced",
    });
    assert.throws(
      () => replacementPayResult(hash, {
        status: "success",
        blockNumber: 11n,
        blockHash,
        transactionHash: replacement,
      }, "retry", "cancelled"),
      (error: Error) => error instanceof PaymentTransactionCancelledError && error.message === `retry transaction ${hash} was cancelled by ${replacement}`,
    );
  });
});

describe("payment broadcast lifecycle", () => {
  const hash = `0x${"56".repeat(32)}` as const;
  const call = { to: addressHex(ROUTER), data: "0x1234" as const, value: ETH_PRICE_WEI, gas: 71_058n };

  it("durably marks broadcast requested before invoking the signer, then checkpoints the hash", async () => {
    const events: string[] = [];
    const observed = await submitRouterCallWithCallbacks({
      address: call.to,
      chainId: async () => 1n,
      sendTransaction: async (tx: unknown) => {
        events.push("signer");
        assert.deepEqual(tx, { chainId: 1n, ...call });
        return hash;
      },
    }, 1n, call, {
      onBroadcastRequested: async () => { events.push("broadcast-requested"); },
      onSent: async (sentHash: Hex) => {
        events.push("hash-checkpointed");
        assert.equal(sentHash, hash);
      },
      onDefinitelyRejected: async () => { events.push("definitely-rejected"); },
    });

    assert.equal(observed, hash);
    assert.deepEqual(events, ["broadcast-requested", "signer", "hash-checkpointed"]);
  });

  it("keeps the broadcast attempt ambiguous when the hash checkpoint fails", async () => {
    const events: string[] = [];
    await assert.rejects(
      submitRouterCallWithCallbacks({
        address: call.to,
        chainId: async () => 1n,
        sendTransaction: async () => {
          events.push("signer");
          return hash;
        },
      }, 1n, call, {
        onBroadcastRequested: async () => { events.push("broadcast-requested"); },
        onSent: async () => {
          events.push("hash-checkpoint-failed");
          throw new Error("IndexedDB unavailable");
        },
        onDefinitelyRejected: async () => { events.push("definitely-rejected"); },
      }),
      /IndexedDB unavailable/,
    );
    assert.deepEqual(events, ["broadcast-requested", "signer", "hash-checkpoint-failed"]);
  });

  it("clears broadcast-requested state after a nested EIP-1193 user rejection", async () => {
    const events: string[] = [];
    const rejection = new Error("wallet request failed", {
      cause: Object.assign(new Error("User rejected the request"), { code: 4001 }),
    });
    await assert.rejects(
      submitRouterCallWithCallbacks({
        address: call.to,
        chainId: async () => 1n,
        sendTransaction: async () => {
          events.push("signer");
          throw rejection;
        },
      }, 1n, call, {
        onBroadcastRequested: async () => { events.push("broadcast-requested"); },
        onDefinitelyRejected: async (cause: unknown) => {
          events.push("definitely-rejected");
          assert.equal(cause, rejection);
        },
      }),
      (cause) => cause === rejection,
    );
    assert.deepEqual(events, ["broadcast-requested", "signer", "definitely-rejected"]);
  });

  it("does not clear broadcast-requested state after an ambiguous signer error", async () => {
    const events: string[] = [];
    const ambiguous = new Error("provider disconnected before returning a hash");
    await assert.rejects(
      submitRouterCallWithCallbacks({
        address: call.to,
        chainId: async () => 1n,
        sendTransaction: async () => {
          events.push("signer");
          throw ambiguous;
        },
      }, 1n, call, {
        onBroadcastRequested: async () => { events.push("broadcast-requested"); },
        onDefinitelyRejected: async () => { events.push("definitely-rejected"); },
      }),
      (cause) => cause === ambiguous,
    );
    assert.deepEqual(events, ["broadcast-requested", "signer"]);
  });
});

describe("payment anchor readiness", () => {
  it("waits until the verified block is historical without waiting for finality", async () => {
    const heads = [123n, 123n, 124n];
    let reads = 0;
    const head = await waitForHistoricalPaymentAnchor({
      getBlockNumber: async () => heads[reads++] ?? 124n,
    }, 123n, { pollIntervalMs: 0, maxAttempts: 3 });
    assert.equal(head, 124n);
    assert.equal(reads, 3);
  });

  it("requires a fresh proof once the router can no longer read the claim's anchor", async () => {
    await assert.rejects(
      waitForHistoricalPaymentAnchor({ getBlockNumber: async () => 379n }, 123n, { pollIntervalMs: 0 }),
      /snapshot anchor expired before the router call; prove the claim again/,
    );
  });

  it("fails if the latest head never advances", async () => {
    await assert.rejects(
      waitForHistoricalPaymentAnchor({ getBlockNumber: async () => 123n }, 123n, {
        pollIntervalMs: 0,
        maxAttempts: 2,
      }),
      /head did not advance beyond the payment anchor/,
    );
  });

  it("quotes buy calls only once the newest anchor is historical", async () => {
    const calls = [
      buildBuyCall(pub, wallet, { ...CARRIED, anchor: { ...ANCHOR, blockNumber: 122n } }),
      buildBuyCall(pub, wallet, CARRIED),
    ];
    const heads = [123n, 124n];
    let head = 0n;
    const client = {
      getBlockNumber: async () => { head = heads.shift() ?? head; return head; },
      // The router reverts with InvalidAnchor unless the anchor is below block.number.
      estimateGas: async ({ data }: { data: string }) => {
        const call = calls.find(candidate => candidate.data === data)!;
        if (call.anchor.blockNumber >= head) throw new Error("execution reverted");
        return 70_000n;
      },
    } as unknown as Parameters<typeof estimateRouterCallsGas>[0];
    assert.deepEqual(await estimateRouterCallsGas(client, addressHex(wallet.address), calls, { pollIntervalMs: 0 }), [70_000n, 70_000n]);
    assert.equal(head, 124n);
  });

  it("reports the exact principal shortfall without estimating gas", async () => {
    const paymentWei = 2n * ETH_PRICE_WEI;
    const client = {
      getBalance: async () => paymentWei - 1n,
    } as unknown as Parameters<typeof checkPaymentBalance>[0];
    await assert.rejects(
      checkPaymentBalance(client, addressHex(wallet.address), paymentWei),
      (error: Error) => error instanceof InsufficientPaymentBalanceError
        && error.balanceWei === paymentWei - 1n
        && error.paymentWei === paymentWei,
    );
  });

  it("names the router error when a buy estimate reverts", async () => {
    const client = createPublicClient({
      transport: custom({
        async request({ method }) {
          if (method === "eth_blockNumber") return "0x7c";
          // NotAfterPassed(), as a node returns it for a call that executes too late.
          if (method === "eth_estimateGas") throw { code: 3, message: "execution reverted", data: "0xcbd989e8" };
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    await assert.rejects(
      estimateRouterCallsGas(client, addressHex(wallet.address), [buildBuyCall(pub, wallet, CARRIED)], { pollIntervalMs: 0 }),
      /The contract function "buy" reverted\.\s+Error: NotAfterPassed\(\)/,
    );
  });
});

it("requires the price and the call's gas before buying, and only gas before retrying", async () => {
  const call = buildBuyCall(pub, wallet, CARRIED);
  const gasCost = 100n;
  let balance = call.value + gasCost - 1n;
  let estimates = 0;
  const client = {
    estimateGas: async () => { estimates++; return 10n; },
    estimateFeesPerGas: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
    getBalance: async () => balance,
  } as unknown as Parameters<typeof assertRouterCallBudget>[0];
  await assert.rejects(assertRouterCallBudget(client, addressHex(wallet.address), call), /not enough ETH for the payment and its gas/);
  assert.equal(estimates, 1);
  balance += 1n;
  assert.equal(await assertRouterCallBudget(client, addressHex(wallet.address), call), 10n);
  assert.equal(estimates, 2);
  balance = call.value - 1n;
  await assert.rejects(
    assertRouterCallBudget(client, addressHex(wallet.address), call),
    (error: Error) => error instanceof InsufficientPaymentBalanceError,
  );
  assert.equal(estimates, 2);
  balance = gasCost - 1n;
  await assert.rejects(assertRouterCallBudget(client, addressHex(wallet.address), buildRetryCall(pub, BATCH)), /not enough ETH for the retry's gas/);
  assert.equal(estimates, 3);
});
