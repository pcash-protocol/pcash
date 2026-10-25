import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import { useState } from "react";
import { ElapsedTime } from "./ElapsedTime.tsx";
import { ProgressIndicator, proofProgressMessage } from "./ProgressIndicator.tsx";
import { useProofCompletion } from "./useProofCompletion.ts";

/** Shared by private payments and marketplace transactions, alongside their reviewed inputs. */
export function ProofProgress({ proof, awaitingSignature = false, label = "Generating your proof", detail, startedAt }: {
  proof?: ProveStatus | undefined;
  /** When the work began; defaults to when this progress first rendered. */
  startedAt?: number | undefined;
  awaitingSignature?: boolean | undefined;
  label?: string;
  /** Shown until the prover reports a stage, which then names itself. */
  detail?: string | undefined;
}) {
  const [mountedAt] = useState(Date.now);
  const completion = useProofCompletion(awaitingSignature ? undefined : proof);
  const title = awaitingSignature ? "Approve in your wallet" : label;
  const message = awaitingSignature ? "Approve the free signature in your wallet to continue."
    : completion === undefined ? detail ?? proofProgressMessage(proof) : proofProgressMessage(proof);
  const remaining = completion?.remainingMs === undefined ? undefined : Math.max(1, Math.ceil(completion.remainingMs / 1_000));
  return <div>
    <div className="proof-progress" role="status" aria-live="polite"><strong>{title}</strong><span>{message}</span></div>
    <p className="proof-elapsed">
      <ElapsedTime startedAt={startedAt ?? mountedAt} />
      {remaining !== undefined && <span> · About {remaining} {remaining === 1 ? "second" : "seconds"} left</span>}
    </p>
    <ProgressIndicator label={title} detail={message} value={completion?.fraction} />
  </div>;
}
