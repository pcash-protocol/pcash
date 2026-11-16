import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, stringToBytes, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CARRIER_KIND_EVENT,
  carrierContextHash,
  encodeBatch,
  posterPayoutOpening,
  transactionIdentity,
} from "@pcash/sdk/protocol";
import type { L1DeliveryBatchResult, ReceiptResult } from "@pcash/sdk/clients";
import { randomFieldEntropy } from "@pcash/sdk/utils";
import type { WalletProfile } from "@pcash/sdk/wallet";
import { buildLatestUserTransfer, listSpendableNotes, proveDefaultTransfer } from "../actors/sdk.ts";
import { eventually } from "../framework/eventually.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { setupUserWallets } from "./setup.ts";

const BATCH_POSTER_ABI = parseAbi(["function post(bytes batch)"]);

/** Compile the contract wallet with the repository's forge and deploy it; the deployer owns it. */
async function deployBatchPoster(fixture: ScenarioFixture, ownerKey: Hex): Promise<Address> {
  const output = execFileSync("forge", [
    "inspect", "--root", join(fixture.repoRoot, "e2e/l1-contracts"), "src/BatchPoster.sol:BatchPoster", "bytecode",
  ], { encoding: "utf8" });
  const bytecode = output.trim().split("\n").at(-1)?.trim();
  if (bytecode === undefined || !/^0x[0-9a-f]+$/i.test(bytecode)) throw new Error("forge printed no BatchPoster creation bytecode");
  const wallet = createWalletClient({ account: privateKeyToAccount(ownerKey), transport: http(fixture.backend.rpcUrl) });
  const hash = await wallet.deployContract({ abi: BATCH_POSTER_ABI, bytecode: bytecode as Hex, chain: null });
  const receipt = await createPublicClient({ transport: http(fixture.backend.rpcUrl) }).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || receipt.contractAddress == null) throw new Error("BatchPoster deployment failed");
  return receipt.contractAddress;
}

interface ContractCarried {
  l1TransactionHash: Hex;
  carrier: L1DeliveryBatchResult;
  receipt: ReceiptResult;
}

/**
 * Frame one transaction as a batch naming `poster`, have the contract emit it,
 * and read the node's manifest and the transaction's result: one event carrier
 * from the contract, with an empty context, holding the transaction.
 */
async function postThroughContract(
  fixture: ScenarioFixture,
  ownerKey: Hex,
  contract: Address,
  entry: Uint8Array,
  poster: Pick<WalletProfile, "address" | "nkRoot">,
): Promise<ContractCarried> {
  const node = fixture.nodeA.client;
  const opening = posterPayoutOpening(poster.address, poster.nkRoot, randomFieldEntropy());
  const batch = encodeBatch([entry], opening.ownerCommitment, opening.context);
  const owner = privateKeyToAccount(ownerKey);
  const wallet = createWalletClient({ account: owner, transport: http(fixture.backend.rpcUrl) });
  const hash = await wallet.writeContract({ address: contract, abi: BATCH_POSTER_ABI, functionName: "post", args: [toHex(batch)], chain: null });
  const sent = await createPublicClient({ transport: http(fixture.backend.rpcUrl) }).waitForTransactionReceipt({ hash });
  if (sent.status !== "success") throw new Error(`BatchPoster post ${hash} reverted`);
  const carriers = await eventually(
    `the node to record the carrier of ${hash}`,
    () => node.getL1DeliveryBatches(hash),
    (found) => found.length > 0,
    { timeoutMs: 120_000, intervalMs: 500 },
  );
  const carrier = carriers[0]!;
  const item = carrier.items[0];
  if (
    carriers.length !== 1
    || carrier.carrierType !== "event"
    || carrier.emitter?.toLowerCase() !== contract.toLowerCase()
    || carrier.context !== "0x"
    || carrier.logIndex === null
    || carrier.l1Sender.toLowerCase() !== owner.address.toLowerCase()
    || carrier.exclusionReason !== null
    || carrier.items.length !== 1
    || item?.exclusionReason !== null
    || item.contentHash.toLowerCase() !== transactionIdentity(entry).contentHash.toLowerCase()
  ) {
    throw new Error(`Ethereum transaction ${hash} is not one admitted event carrier from ${contract}: ${JSON.stringify(carriers, (_key, value) => typeof value === "bigint" ? value.toString() : value)}`);
  }
  const [receipt] = await eventually(
    `the result of the transaction carried by ${hash}`,
    () => node.getReceipt({ inclusionId: {
      l1BlockHash: carrier.l1BlockHash,
      l1TransactionIndex: carrier.l1TransactionIndex,
      batchItemIndex: item.batchItemIndex,
    } }),
    (receipts) => receipts.length === 1,
    { timeoutMs: 60_000, intervalMs: 500 },
  );
  return { l1TransactionHash: hash, carrier, receipt: receipt! };
}

/**
 * A contract wallet posts PCASH transactions as its own `PcashBatch` events:
 * an ordinary transfer, which requires no carrier context, executes as it would
 * through the Inbox, and a transfer requiring another carrier context fails
 * through the same contract and consumes nothing.
 */
export async function runContractPostingScenario(fixture: ScenarioFixture): Promise<void> {
  await setupUserWallets(fixture, { actors: ["S", "R"], accounts: ["R"], funded: ["S"] });
  const { S, R } = fixture.actors;
  if (S === undefined || R === undefined) throw new Error("contract posting actors are missing");
  const node = fixture.nodeA.client;
  // S owns the contract wallet and sends every Ethereum transaction it posts.
  await fixture.fundL1Gas(S.address, 4);
  const contract = await deployBatchPoster(fixture, S.privateKey);
  fixture.artifacts.record("contract-posting-deployed", { contract, owner: S.address });

  const [note] = await listSpendableNotes(node, S.wallet, fixture.network.pcashChainId);
  if (note === undefined) throw new Error("S has no spendable note");
  const amount = note.amount / 4n;
  const transfer = async (required: bigint, label: string) => proveDefaultTransfer(await buildLatestUserTransfer({
    node,
    network: fixture.network,
    wallet: S.wallet,
    inputNotes: [note],
    recipientAddress: R.wallet.address,
    recipientReceiveKey: R.wallet.mlKemPublicKey!,
    amount,
    openFeeAmount: 0n,
    carrierContextHash: required,
    defaultRuleSecrets: S.wallet.defaultUserRuleSecrets,
    signer: S.signer,
  }), label);
  const recipientBefore = await R.balance();

  // Delivery from this contract with other context bytes: the contract's empty context does not match.
  const required = carrierContextHash(CARRIER_KIND_EVENT, contract, stringToBytes("another context"));
  const carried = carrierContextHash(CARRIER_KIND_EVENT, contract, new Uint8Array());
  const bound = await transfer(required, "carrier-bound transfer");
  const mismatched = await postThroughContract(fixture, S.privateKey, contract, bound, S.wallet);
  const detail = mismatched.receipt.failureDetail;
  if (
    mismatched.receipt.outcome !== "carrierContextMismatch"
    || detail?.type !== "carrierContextMismatch"
    || BigInt(detail.required) !== required
    || BigInt(detail.carrier) !== carried
  ) {
    throw new Error(`the carrier-bound transfer received ${mismatched.receipt.outcome} (${JSON.stringify(detail)}), expected carrierContextMismatch`);
  }
  if (mismatched.receipt.outputLeafStart !== null || mismatched.receipt.settledOpenFeeAmount !== 0n || mismatched.receipt.settledIssuanceAmount !== 0n) {
    throw new Error("the mismatched transfer appended outputs or settled a fee or issuance");
  }
  const spendable = async () => (await listSpendableNotes(node, S.wallet, fixture.network.pcashChainId))
    .some((candidate) => candidate.leafIndex === note.leafIndex);
  if (!await spendable()) throw new Error("the mismatched transfer consumed its input note");

  // The same note, now in an ordinary transfer that accepts any delivery.
  const ordinary = await transfer(0n, "ordinary transfer");
  const accepted = await postThroughContract(fixture, S.privateKey, contract, ordinary, S.wallet);
  if (accepted.receipt.outcome !== "succeeded" || accepted.receipt.kind !== "privateValue") {
    throw new Error(`the ordinary transfer through the contract received ${accepted.receipt.outcome}`);
  }
  if (await spendable()) throw new Error("the ordinary transfer did not spend its input note");
  const recipientAfter = await R.balance();
  if (recipientAfter - recipientBefore !== amount) {
    throw new Error(`R received ${recipientAfter - recipientBefore}, expected ${amount}`);
  }
  fixture.artifacts.record("contract-posting-complete", {
    contract,
    mismatched: { l1TransactionHash: mismatched.l1TransactionHash, logIndex: mismatched.carrier.logIndex, outcome: mismatched.receipt.outcome },
    accepted: { l1TransactionHash: accepted.l1TransactionHash, logIndex: accepted.carrier.logIndex, contentHash: accepted.receipt.contentHash },
  });
}
