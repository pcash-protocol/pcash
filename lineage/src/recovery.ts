import { scanFeed, scanOutputPages, type SpendableNote } from "@pcash/sdk/wallet/scanning";
import type { PcashNodeClient, OutputResult } from "@pcash/sdk/clients";
import type { ResultPosition } from "@pcash/sdk/clients";
import type { WalletProfile } from "@pcash/sdk/protocol";
import { deliveryCommitment, readRecord } from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { toField } from "@pcash/sdk/crypto";
import { handoffSchema, LineageStore, verifyHandoff, type Handoff } from "./handoff.ts";
import type { LineagePolicy } from "./policy.ts";

type ProofNode = Pick<PcashNodeClient, "getResultProof">;
export interface LineageRecoveryCandidate {
  blockNumber: bigint;
  position: ResultPosition;
  outputIndex: bigint;
  commitment: bigint;
  outputSlot: number;
  /** Every output-data item, the arena and the ordered nullifiers of the candidate's S section. */
  outputData: readonly Uint8Array[];
  arena: Uint8Array;
  nullifiers: readonly bigint[];
}
interface RecoveryContext {
  node: ProofNode;
  recentHash: bigint;
  policy: LineagePolicy;
  trustedVk: bigint;
  store: LineageStore;
}

async function retainVerified(context: RecoveryContext, candidate: LineageRecoveryCandidate, note: SpendableNote): Promise<Handoff | undefined> {
  const opening = readRecord(note.applicationRecords, handoffSchema);
  if (opening === undefined) return undefined;
  try {
    const proof = await context.node.getResultProof(context.recentHash, candidate.blockNumber, candidate.position);
    if (proof === null || proof.leaf.kind !== "transaction") return undefined;
    const handoff = verifyHandoff({ handoff: opening, outputSlot: note.outputIndex, proof, recentHash: context.recentHash, blockNumber: candidate.blockNumber, position: candidate.position, noteCommitment: note.outputCommitment, policy: context.policy, trustedVk: context.trustedVk });
    // The note's envelope is the candidate's slot item and its records come from
    // the candidate's arena, so the authenticated delivery commitment binds both
    // to the proved transaction.
    const committedDelivery = proof.leaf.statement?.words[PRIVATE_VALUE_PROFILES.S.offsets.deliveryCommitment];
    if (committedDelivery === undefined || toField(committedDelivery) !== deliveryCommitment(candidate.outputData, candidate.arena)) return undefined;
    context.store.record(note.outputCommitment, handoff);
    return handoff;
  } catch {
    // Missing, unavailable or invalid application evidence never changes wallet note validity.
    return undefined;
  }
}

/** Reuse wallet note recovery, then authenticate optional application metadata before retaining it. */
export async function recoverLineageOutput(params: RecoveryContext & {
  chainId: bigint | number;
  mlKemSecretKeys: readonly Uint8Array[];
  owners: readonly bigint[];
  candidate: LineageRecoveryCandidate;
}): Promise<Handoff | undefined> {
  const candidate = params.candidate;
  const report = await scanFeed({ chainId: params.chainId, mlKemSecretKeys: params.mlKemSecretKeys, owners: params.owners, feed: [{ kind: 0, shape: PRIVATE_VALUE_PROFILES.S.shapeId, outputIndex: candidate.outputSlot, leafIndex: candidate.outputIndex, outputCommitment: candidate.commitment, outputData: candidate.outputData[candidate.outputSlot]!, arena: { arena: candidate.arena, nullifiers: candidate.nullifiers } }] });
  const note = report.recovered[0];
  return note === undefined ? undefined : retainVerified(params, candidate, note);
}

/** Reconstruct application records from receive keys and the node; provider policy contents remain external inputs. */
export async function restoreLineageFromNode(params: {
  node: ProofNode & Pick<PcashNodeClient, "getOutputs" | "getTransaction">;
  target: { pcashNumber: bigint; pcashHash: string };
  chainId: bigint | number;
  wallet: Pick<WalletProfile, "address" | "mlKemSecretKey" | "nkRoot">;
  receiveSecretKeys?: readonly Uint8Array[];
  policy: LineagePolicy;
  trustedVk: bigint;
}): Promise<{ store: LineageStore; scanned: number; qualified: number }> {
  const store = new LineageStore();
  let qualified = 0;
  const keys = [...(params.receiveSecretKeys ?? []), ...(params.wallet.mlKemSecretKey === undefined ? [] : [params.wallet.mlKemSecretKey])];
  const context = { node: params.node, recentHash: BigInt(params.target.pcashHash), policy: params.policy, trustedVk: params.trustedVk, store };
  const report = await scanOutputPages({ node: params.node, fromOutputIndex: 0n, target: params.target, chainId: params.chainId, mlKemSecretKeys: keys, owners: [params.wallet.address], recoveryWallet: params.wallet,
    async onPage(report, outputs) {
      const ordinary = new Map<bigint, Extract<OutputResult, { kind: "ordinary" }>>();
      for (const output of outputs) if (output.kind === "ordinary") ordinary.set(output.outputIndex, output);
      const profile = PRIVATE_VALUE_PROFILES.S;
      for (const note of report.recovered) {
        const output = ordinary.get(note.leafIndex);
        if (output === undefined || output.transactionType !== 0 || output.privateValueShape !== profile.shapeId
          || !note.applicationRecords?.some(record => record.schema === handoffSchema.id)) continue;
        // Pages hold whole transactions: the slot-0 row carries the section's arena and nullifiers.
        const first = ordinary.get(output.outputIndex - BigInt(output.outputSlot))!;
        const outputData = Array.from({ length: profile.outputs }, (_, slot) => ordinary.get(first.outputIndex + BigInt(slot))!.outputData);
        try {
          const transaction = await params.node.getTransaction(output.transactionId);
          if (transaction === null) continue;
          const candidate: LineageRecoveryCandidate = { blockNumber: output.origin.pcashNumber, position: { pcashTransactionIndex: transaction.summary.pcashTransactionIndex }, outputIndex: output.outputIndex, outputSlot: output.outputSlot, commitment: note.outputCommitment, outputData, arena: first.arena!, nullifiers: first.nullifiers.map(BigInt) };
          if (await retainVerified(context, candidate, note) !== undefined) qualified++;
        } catch {
          // The ordinary wallet scan has already recovered the spendable note.
        }
      }
    },
  });
  return { store, scanned: report.scanned, qualified };
}
