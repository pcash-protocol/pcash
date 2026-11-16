/// <reference lib="webworker" />
// One worker of a browser wallet's trial-decryption pool (trialDecryption.ts).
// Each request is a run of envelopes and the receive keys to try; the answer
// is one opening or null per envelope, in the run's order.

import { trialOpenEnvelopeWithKeys, type TrialOpening } from "../../protocol/envelope.ts";

export interface TrialDecryptRequest {
  mlKemSecretKeys: readonly Uint8Array[];
  envelopes: readonly Uint8Array[];
}

export type TrialDecryptResponse = (TrialOpening | null)[];

self.onmessage = (event: MessageEvent<TrialDecryptRequest>) => {
  const { mlKemSecretKeys, envelopes } = event.data;
  const response: TrialDecryptResponse = envelopes.map((envelope) => trialOpenEnvelopeWithKeys(mlKemSecretKeys, envelope));
  self.postMessage(response);
};
