// Read a built private-value section the way a wallet reads it from the
// output feed: the arena plus its context (chain, type 0, ordered nullifiers).

import type { PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { TX_KIND_PRIVATE_VALUE } from "../src/protocol/codec.ts";
import { trialOpenEnvelope } from "../src/protocol/envelope.ts";
import { discloseOutput, type DisclosedOutput, type OutputArena } from "../src/protocol/sectionDelivery.ts";
import type { PrivateValue } from "../src/protocol/transaction.ts";

export interface BuiltSection {
  pcashChainId: bigint;
  shape: PrivateValueShape;
  transaction: PrivateValue;
  outputData: readonly Uint8Array[];
  arena: Uint8Array;
}

export function sectionArena(build: BuiltSection): OutputArena {
  return {
    arena: build.arena,
    shape: build.shape,
    context: {
      chainId: build.pcashChainId,
      transactionType: TX_KIND_PRIVATE_VALUE,
      nullifiers: build.transaction.inputs.map((input) => input.nullifier),
    },
  };
}

/** Trial-decrypt one slot with a receive key and open its records; throws when the key does not open it. */
export function receiveOutput(build: BuiltSection, mlKemSecretKey: Uint8Array, slot: number): DisclosedOutput & { sharedSecret: Uint8Array } {
  const opened = trialOpenEnvelope(mlKemSecretKey, build.outputData[slot]!);
  if (opened === null) throw new Error(`output ${slot} does not open with this key`);
  const disclosed = discloseOutput({ ...sectionArena(build), sharedSecret: opened.sharedSecret, slot, outputData: build.outputData });
  if (disclosed === null) throw new Error(`output ${slot} is not a note for this section`);
  return { ...disclosed, sharedSecret: opened.sharedSecret };
}
