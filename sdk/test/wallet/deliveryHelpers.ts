// Readers for the records a build delivered: each output's recipient region
// and the building wallet's sender region, opened from the build's arena.

import { PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "@pcash/sdk/constants";
import type { FieldNumberish } from "@pcash/sdk/crypto";
import {
  discloseOutput,
  openSenderRecords,
  trialOpenEnvelope,
  type ArenaTransactionType,
  type DisclosedOutput,
  type OutputArena,
  type SenderRecovery,
} from "@pcash/sdk/protocol";

interface BuiltSection {
  arena: Uint8Array;
  shape?: PrivateValueShape;
  outputData: readonly Uint8Array[];
  transaction: { inputs: readonly { nullifier: FieldNumberish }[] };
}

export function sectionOf(build: BuiltSection, chainId: bigint, transactionType: ArenaTransactionType = 0): OutputArena {
  return {
    arena: build.arena,
    shape: build.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId,
    context: { chainId, transactionType, nullifiers: build.transaction.inputs.map((input) => input.nullifier) },
  };
}

/** The note and records a receive key opens at one slot, or null when it opens nothing there. */
export function deliveredOutput(
  build: BuiltSection,
  chainId: bigint,
  mlKemSecretKey: Uint8Array,
  slot: number,
  transactionType: ArenaTransactionType = 0,
): DisclosedOutput | null {
  const opened = trialOpenEnvelope(mlKemSecretKey, build.outputData[slot]!);
  return opened === null ? null : discloseOutput({
    ...sectionOf(build, chainId, transactionType), sharedSecret: opened.sharedSecret, slot, outputData: build.outputData,
  });
}

export function senderRegionOf(
  build: BuiltSection,
  chainId: bigint,
  outgoingKey: Uint8Array,
  transactionType: ArenaTransactionType = 0,
): SenderRecovery | null {
  return openSenderRecords({ ...sectionOf(build, chainId, transactionType), outgoingKey });
}
