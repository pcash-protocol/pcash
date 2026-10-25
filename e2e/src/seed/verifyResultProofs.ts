import { verifyResultProof, verifySuccessfulTransactionStatement, type PcashNodeClient, type SystemPayoutResult } from "@pcash/sdk/clients";
import { decodeTransactionForChain } from "@pcash/sdk/protocol";
import { fromHex } from "@pcash/sdk/utils";
import assert from "node:assert/strict";
import type { RichSeedResult } from "./richSeed.ts";

/** Exercise the node/SDK commitment boundary using admitted bytes and authenticated semantics. */
export async function verifySeedResultProofs(node: PcashNodeClient, seed: RichSeedResult): Promise<void> {
  const status = await node.status();
  const recent = BigInt(status.latestBlockHash);
  const required = new Set(["S", "L", "update", "sponsored", "signed", "unfunded", "failed", "designatedIssuance", "posterOpenFee", "posterIssuance"]);
  const numbers = new Set(seed.waves.flatMap((wave) => wave.carriers.map((carrier) => carrier.l1BlockNumber - seed.network.genesisL1Block)));
  const representatives = new Map(seed.canonicalEntries.filter(entry => entry.transactionId !== null).map(entry => [entry.l1BlockHash, entry.transactionId!]));
  for (const transactionId of representatives.values()) {
    const transaction = await node.getTransaction(transactionId);
    if (transaction === null) throw new Error(`missing seeded transaction ${transactionId}`);
    numbers.add(transaction.summary.block.blockNumber);
  }
  for (const number of numbers) {
    const block = await node.getBlock(number, true);
    if (block?.transactionBytes == null) throw new Error(`missing full seeded block ${number}`);
    for (const [index, raw] of block.transactionBytes.entries()) {
      const proof = await node.getResultProof(recent, number, { pcashTransactionIndex: BigInt(index) });
      if (proof?.leaf.kind !== "transaction") throw new Error("missing seeded transaction result proof");
      const bytes = fromHex(raw);
      const tx = decodeTransactionForChain(bytes, seed.network.pcashChainId);
      if (proof.leaf.outcome !== 0) {
        required.delete("failed");
        continue;
      }
      // Direct creations need carrier sender evidence; the seed's signed creations are self-contained.
      if (tx.kind === 1 && tx.authorization.kind === "direct") continue;
      verifySuccessfulTransactionStatement(proof, bytes, seed.network, { recentHash: recent, blockNumber: number, pcashTransactionIndex: BigInt(index) });
      if (tx.kind === 0) required.delete(tx.shape === 0 ? "S" : "L");
      else if (tx.kind === 3) {
        const substituted = bytes.slice();
        substituted[5] = substituted[5]! ^ 1;
        assert.throws(() => verifySuccessfulTransactionStatement(proof, substituted, seed.network, { recentHash: recent, blockNumber: number, pcashTransactionIndex: BigInt(index) }));
        required.delete("update");
      }
      else if (tx.kind === 1) required.delete("signed");
      else required.delete(tx.funding.mode);
    }
    const payouts = await node.getBlockPayouts({ blockNumber: number, blockHash: block.hash });
    if (payouts === null) throw new Error("missing seeded payouts");
    for (let index = 0n; index < BigInt(payouts.payouts.length); index++) {
      const proof = await node.getResultProof(recent, number, { payoutIndex: index });
      if (proof === null) throw new Error("missing seeded payout result proof");
      if (proof.leaf.kind !== "payout") throw new Error("wrong seeded payout result kind");
      verifyResultProof(proof, recent, number, { payoutIndex: index });
      const record: SystemPayoutResult = payouts.payouts[Number(index)]!;
      const openFeeAmount = BigInt(proof.leaf.openFeeAmount);
      const issuanceAmount = BigInt(proof.leaf.issuanceAmount);
      if (record.component === "openFee") {
        assert.equal(openFeeAmount, record.amount);
        assert.equal(issuanceAmount, 0n);
      } else {
        assert.equal(openFeeAmount, 0n);
        assert.equal(issuanceAmount, record.amount);
      }
      required.delete(record.source.kind === "designatedIssuance"
        ? "designatedIssuance"
        : record.component === "openFee" ? "posterOpenFee" : "posterIssuance");
    }
  }
  if (required.size > 0) throw new Error(`seeded result proof coverage missing: ${[...required].join(", ")}`);
}
