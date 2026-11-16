import assert from "node:assert/strict";
import { createWalletClient, http, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildUnfundedContractCreation } from "@pcash/sdk/builders";
import type { PcashNodeClient, ReceiptResult, StatusResult } from "@pcash/sdk/clients";
import type { PcashActionSigner } from "@pcash/sdk/eip712";
import {
  ACCOUNT_WEIGHT,
  encodeBatch,
  functionSelector,
  MAX_WAIVED_BASE_FEE,
  quoteNetworkFee,
  TARGET_UNITS_PER_BLOCK,
  transactionIdentity,
} from "@pcash/sdk/protocol";
import { addressHex, fromHex } from "@pcash/sdk/utils";
import { createWalletProvers } from "@pcash/sdk/wallet/node";
import { openNodeWallet } from "@pcash/wallet";
import { withAnvilMiningPaused } from "../backends/anvil.ts";
import { l1Rpc } from "../backends/rpc.ts";
import { eventually } from "../framework/eventually.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { setupUserWallets } from "./setup.ts";

// Two carriers of 1,000 standalone contract creations per L1 block: 4,000
// state units against a 1,200-unit target, so the excess grows 2,800 a block
// and the base fee turns positive after about 16 blocks.
const CREATIONS_PER_CARRIER = 1_000;
const CARRIERS_PER_BLOCK = 2;
const PAYMENT_UNITS = 4n;
const ACTIVATION_UNITS = 4n + ACCOUNT_WEIGHT;

/** Standalone creations of distinct contracts, valid against the node's current tip. */
function contractCreations(fixture: ScenarioFixture, status: StatusResult, count: number): Uint8Array[] {
  return Array.from({ length: count }, () => buildUnfundedContractCreation({
    pcashChainId: fixture.network.pcashChainId,
    contract: {
      nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: fixture.randomField() },
      functions: [{ selector: functionSelector(0), applicationVkHash: 0n, configurationCommitment: 0n }],
    },
    recentPcashBlockHash: BigInt(status.latestBlockHash),
    validUntilTimestamp: status.latestBlockTimestamp + 1_800n,
  }).transactionBytes);
}

/**
 * An Inbox sender that posts raw batches, so items that the SDK's posting
 * paths refuse for an unpaid protocol fee still reach the node.
 */
async function rawInboxSender(fixture: ScenarioFixture): Promise<(items: readonly Uint8Array[]) => Promise<Hex>> {
  const account = privateKeyToAccount(generatePrivateKey());
  await l1Rpc(fixture.backend.rpcUrl, "anvil_setBalance", [account.address, "0x56bc75e2d63100000"]);
  const wallet = createWalletClient({ account, transport: http(fixture.backend.rpcUrl) });
  const inbox = addressHex(fixture.network.inboxAddress) as Hex;
  let nonce = Number(BigInt(await l1Rpc<string>(fixture.backend.rpcUrl, "eth_getTransactionCount", [account.address, "pending"])));
  return (items) => wallet.sendTransaction({ to: inbox, data: toHex(encodeBatch(items, 0n, 0n)), nonce: nonce++, chain: null });
}

async function pendingL1Transactions(fixture: ScenarioFixture): Promise<number> {
  const pool = await l1Rpc<{ pending: string }>(fixture.backend.rpcUrl, "txpool_status");
  return Number(BigInt(pool.pending));
}

/** Mine one block and wait for the node to derive it. */
async function mineBlock(fixture: ScenarioFixture): Promise<StatusResult> {
  await fixture.backend.mine!(1);
  await fixture.waitForNodesAtL1Head();
  return fixture.nodeA.client.status();
}

async function receiptOf(node: PcashNodeClient, entry: Uint8Array, label: string): Promise<ReceiptResult> {
  const { contentHash } = transactionIdentity(entry);
  const [receipt] = await eventually(`the receipt of ${label}`, () => node.getReceipt({ contentHash }),
    (found) => found.length === 1, { timeoutMs: 60_000, intervalMs: 250 });
  return receipt!;
}

function assertFeeTooLow(receipt: ReceiptResult, status: StatusResult, units: bigint, label: string): void {
  assert.equal(receipt.outcome, "protocolFeeTooLow", label);
  const detail = receipt.failureDetail;
  if (detail?.type !== "protocolFeeTooLow") throw new Error(`${label} has no protocol fee detail`);
  assert.equal(detail.baseFee, status.baseFee, `${label} base fee`);
  assert.equal(detail.units, units, `${label} units`);
  assert.equal(detail.requiredFee, status.baseFee * units, `${label} required fee`);
  assert.equal(detail.nativeBurnAmount, 0n, `${label} burn`);
}

/** Records the primary type of every message the signer authorizes. */
function recordingSigner(signer: PcashActionSigner, primaryTypes: string[]): PcashActionSigner {
  return {
    address: signer.address,
    async signTypedData(request) {
      primaryTypes.push(request.typedData.primaryType);
      return signer.signTypedData(request);
    },
  };
}

/**
 * The launch trigger of #936: free account creations flood the chain until the
 * base fee turns positive. Their Ethereum data cannot lift it past
 * MAX_WAIVED_BASE_FEE, so the fee stays waived: standalone creations fail and
 * count nothing, while every transaction with a private-value section succeeds
 * without a burn, including all-padding setup mining that attaches a creation
 * and a payment that signs the base message. The fee then decays back to zero.
 * Burning past the waiver takes sustained use by transactions with proofs; the
 * unit and node tests cover it. L1 mining is paused while the fee is positive,
 * so the proving time of the payment does not race the decay.
 */
export async function runProtocolFeeScenario(fixture: ScenarioFixture): Promise<void> {
  if (!fixture.backend.mine) throw new Error("the protocol fee scenario requires a controllable local L1");
  await setupUserWallets(fixture, { actors: ["S", "R", "N", "M"], accounts: ["R"], funded: ["S"] });
  const { S, R, N, M } = fixture.actors;
  if (!S || !R || !N || !M) throw new Error("protocol fee actors are missing");
  const node = fixture.nodeA.client;
  assert.equal((await node.status()).baseFee, 0n, "the scenario starts at a zero base fee");

  // N prepares setup mining with its account attached while the fee is zero;
  // it is posted once the fee is positive.
  const activation = fromHex((await (await N.client()).prepareAccountActivation({ mine: true })).transactionHex);
  const send = await rawInboxSender(fixture);

  const primaryTypes: string[] = [];
  await S.close();
  const payer = await openNodeWallet({
    dataDir: S.walletDatabasePath, node, profile: S.wallet, signer: recordingSigner(S.signer, primaryTypes),
    provers: createWalletProvers("native"), submission: fixture.harness.l1(S.wallet), ...fixture.harness.walletSettleWait(),
  });
  try {
    await payer.sync();
    await withAnvilMiningPaused(fixture.backend.rpcUrl, async () => {
      // Every creation succeeds while the fee is zero and counts ACCOUNT_WEIGHT units.
      let status = await node.status();
      for (let round = 0; status.baseFee === 0n; round += 1) {
        if (round === 40) throw new Error(`the base fee is still zero at excess ${status.feeExcess}`);
        const creations = contractCreations(fixture, status, CREATIONS_PER_CARRIER * CARRIERS_PER_BLOCK);
        for (let carrier = 0; carrier < CARRIERS_PER_BLOCK; carrier += 1) {
          await send(creations.slice(carrier * CREATIONS_PER_CARRIER, (carrier + 1) * CREATIONS_PER_CARRIER));
        }
        const before = status.feeExcess;
        status = await mineBlock(fixture);
        assert.equal(status.feeExcess, before + ACCOUNT_WEIGHT * BigInt(creations.length) - TARGET_UNITS_PER_BLOCK,
          `flood block ${round} counts every creation`);
      }
      const positive = status;
      fixture.artifacts.record("protocol-fee-positive", { feeExcess: positive.feeExcess, baseFee: positive.baseFee });
      assert.ok(positive.baseFee <= MAX_WAIVED_BASE_FEE, `the flood's base fee ${positive.baseFee} is waived`);
      assert.equal(quoteNetworkFee(positive.feeExcess, ACTIVATION_UNITS), 0n, "the waived fee quotes nothing");

      // A newcomer can still prepare unfunded setup mining.
      await (await M.client()).prepareAccountActivation({ mine: true });

      // One block carries a standalone creation, N's setup mining, and S's payment.
      const [creation] = contractCreations(fixture, positive, 1);
      await send([creation!]);
      await send([activation]);
      const payment = payer.send({ to: R.address, amount: 1n, openFeeAmount: 0n });
      await eventually("the payment's carrier to reach the L1 pool", () => pendingL1Transactions(fixture),
        (pending) => pending >= 3, { timeoutMs: 300_000, intervalMs: 250 });
      const included = await mineBlock(fixture);
      const paid = await payment;
      assert.equal(paid.accepted, true, "the payment succeeds at a waived fee");
      assert.equal(primaryTypes.at(-1), "PcashPayment", "the wallet signs the base message");

      // The waiver covers only transactions with a private-value section.
      assertFeeTooLow(await receiptOf(node, creation!, "standalone creation"), positive, ACCOUNT_WEIGHT, "standalone creation");
      assert.equal((await receiptOf(node, activation, "setup mining")).outcome, "succeeded", "setup mining succeeds at a waived fee");
      assert.equal((await node.getAccountProof(N.address)).status, "present", "setup mining creates the account");

      const [receipt] = await node.getReceipt({ contentHash: paid.contentHash });
      if (receipt === undefined || receipt.outcome !== "succeeded") throw new Error("the payment has no successful receipt");
      assert.equal(receipt.settledNativeBurnAmount, 0n, "the payment burns nothing");
      // The payment and the setup count; the failed creation adds nothing.
      assert.equal(included.feeExcess, positive.feeExcess + PAYMENT_UNITS + ACTIVATION_UNITS - TARGET_UNITS_PER_BLOCK);
      const [economics] = (await eventually("the payment block's economics",
        () => node.getBlockEconomics({ fromBlock: included.latestBlock, limit: 1 }),
        (page) => page.records.some((record) => record.lastBlock === included.latestBlock),
        { timeoutMs: 60_000, intervalMs: 250 })).records;
      assert.equal(economics!.burnTotal, 0n);
      assert.equal(economics!.usedUnits, PAYMENT_UNITS + ACTIVATION_UNITS);

      // With no further use the excess falls by the target every block until the base fee is zero.
      status = included;
      while (status.baseFee !== 0n) {
        const before = status.feeExcess;
        status = await mineBlock(fixture);
        assert.equal(status.feeExcess, before > TARGET_UNITS_PER_BLOCK ? before - TARGET_UNITS_PER_BLOCK : 0n);
      }
      fixture.artifacts.record("protocol-fee-decayed", { feeExcess: status.feeExcess });
    });

    // Back at a zero base fee: standalone creations succeed again.
    const again = await payer.send({ to: R.address, amount: 1n, openFeeAmount: 0n });
    assert.equal(again.accepted, true);
    assert.equal(primaryTypes.at(-1), "PcashPayment");
    const [againReceipt] = await node.getReceipt({ contentHash: again.contentHash });
    assert.equal(againReceipt?.settledNativeBurnAmount, 0n);
    const [creation] = contractCreations(fixture, await node.status(), 1);
    await send([creation!]);
    assert.equal((await receiptOf(node, creation!, "creation at a zero fee")).outcome, "succeeded");
    fixture.artifacts.record("protocol-fee-complete", { payment: again.contentHash });
  } finally {
    await payer.close();
  }
}
