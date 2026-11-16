import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stringify } from "viem";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { eventually } from "../framework/eventually.ts";
import type { PcashCliActor } from "../actors/nodeCli.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { setupUserWallets } from "./setup.ts";

interface StreamTarget {
  blockNumber: string;
  blockHash: string;
}

interface NoteOutputPage {
  fromOutputIndex: string;
  target: { block: StreamTarget; outputCount: string };
  outputs: Array<{
    outputIndex: string;
    outputCommitment: string;
    outputData: string;
    transactionId: string;
    transactionType: string;
    outputSlot: string;
    origin: StreamTarget;
  }>;
  continuation: Record<string, unknown> | null;
  complete: boolean;
}

export async function runPersistenceScenario(fixture: ScenarioFixture): Promise<void> {
  const balances = await setupUserWallets(fixture, { actors: ["S", "R", "M"], accounts: ["R"], funded: ["S", "M"] });
  const actorS = fixture.actors.S!;
  const actorM = fixture.actors.M!;
  const s = await actorS.client();
  const payment = await s.send({ to: fixture.actors.R!.address, amount: balances.S! / 4n, openFeeAmount: 1n });
  await fixture.waitForAcceptedAcrossNodes(payment.contentHash, "pre-restart-payment-S-R");
  const before = await fixture.nodeB.cli.status<{
    latestBlock: string;
    latestBlockHash: string;
    finalizedL1BlockNumber: string;
  }>();
  if (BigInt(before.finalizedL1BlockNumber) < 1n) {
    throw new Error("persistence scenario produced no finalized checkpoint before restart");
  }
  const target = { blockNumber: before.latestBlock, blockHash: before.latestBlockHash };
  const digestBefore = await walletStreamDigest(fixture.nodeB.cli, target);
  const payoutRows = async () => {
    let page = await fixture.nodeB.client.getPayouts({ limit: 1000 });
    const records = [...page.records];
    while (page.nextCursor !== null) {
      page = await fixture.nodeB.client.getPayouts({ cursor: page.nextCursor, limit: 1000 });
      records.push(...page.records);
    }
    return stringify(records);
  };
  const payoutRowsBefore = await payoutRows();

  await fixture.restartNode("B");
  const restartLog = await readFile(fixture.local("B").process.logPath, "utf8");
  if (!restartLog.includes("resumed from persisted checkpoint (no cold resync)")) {
    throw new Error("node B restart did not report checkpoint resume");
  }
  if (restartLog.includes("cold start from genesis")) {
    throw new Error("node B restart fell back to cold sync");
  }
  await eventually(
    "node B to reconnect to node A after restart",
    () => fixture.nodeB.cli.mempool<{ peerCount: string }>(),
    (mempool) => BigInt(mempool.peerCount) > 0n,
    { timeoutMs: 60_000, cancellation: () => fixture.local("B").process.cancellationReason() },
  );
  const digestAfter = await walletStreamDigest(fixture.nodeB.cli, target);
  const payoutRowsAfter = await payoutRows();
  if (payoutRowsAfter !== payoutRowsBefore) throw new Error("payout discovery records changed across restart");
  if (digestAfter !== digestBefore) {
    throw new Error(`wallet stream changed across restart (${digestBefore} != ${digestAfter})`);
  }
  const full = await s.sync({ rescan: true });
  const incremental = await s.sync();
  if (full.startedAtOutputIndex !== 0n) throw new Error("full wallet scan did not start at output index zero");
  if (incremental.startedAtOutputIndex <= 0n) throw new Error("second wallet scan was not incremental");
  if (incremental.startedAtOutputIndex > incremental.nextOutputIndex) throw new Error("incremental wallet scan skipped outputs");

  const action = await (await actorM.client()).updateAccount({ openFeeAmount: 1n });
  await fixture.waitForAcceptedAcrossNodes(action.contentHash, "post-restart-account-M");
  fixture.artifacts.record("persistence-complete", {
    target,
    walletStreamDigest: digestAfter,
    fullScan: { from: full.startedAtOutputIndex, to: full.nextOutputIndex },
    incrementalScan: { from: incremental.startedAtOutputIndex, to: incremental.nextOutputIndex },
    postRestartContentHash: action.contentHash,
  });
}

export async function walletStreamDigest(cli: PcashCliActor, target: StreamTarget): Promise<string> {
  const hash = createHash("sha256");
  const outputIndexes = new Set<string>();
  let continuation: Record<string, unknown> | undefined;
  let priorContinuation: string | undefined;
  let outputs = 0;
  let targetOutputCount: string | undefined;
  for (;;) {
    const request: Record<string, unknown> = {
      fromOutputIndex: "0x0",
      target,
      // Pages hold whole transactions: one L transaction is the smallest limit
      // every page can meet, and still splits the stream into several pages.
      limits: { maxOutputs: `0x${PRIVATE_VALUE_PROFILES.L.outputs.toString(16)}`, maxBytes: "0x40000" },
      ...(continuation === undefined ? {} : { continuation }),
    };
    const page = await cli.outputs<NoteOutputPage>(request);
    if (
      page.target.block.blockNumber !== target.blockNumber
      || page.target.block.blockHash.toLowerCase() !== target.blockHash.toLowerCase()
    ) throw new Error("output stream changed its frozen target");
    targetOutputCount ??= page.target.outputCount;
    if (page.target.outputCount !== targetOutputCount) throw new Error("output count changed across pages");
    for (const output of page.outputs) {
      const outputIndex = BigInt(output.outputIndex).toString();
      if (outputIndexes.has(outputIndex)) throw new Error(`output stream repeated output ${outputIndex}`);
      outputIndexes.add(outputIndex);
      outputs += 1;
      hash.update(JSON.stringify(output));
    }
    if (page.complete) {
      if (page.continuation !== null) throw new Error("complete output page carried a continuation");
      break;
    }
    if (page.continuation === null) throw new Error("incomplete output page omitted its continuation");
    const key = JSON.stringify(page.continuation);
    if (key === priorContinuation) throw new Error("output continuation did not advance");
    priorContinuation = key;
    continuation = page.continuation;
  }
  return `${targetOutputCount}:${outputs}:${hash.digest("hex")}`;
}
