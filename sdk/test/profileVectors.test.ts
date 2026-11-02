import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { privateValueCommitment } from "../src/protocol/transaction.ts";
import { deliveryCommitmentFromHashes } from "../src/protocol/transfer.ts";
import { noteSecret, noteSecretSeed } from "../src/protocol/notes.ts";
import { issuancePayoutOpening, payoutTransactionContext } from "../src/protocol/payout.ts";
const vectors = JSON.parse(readFileSync(new URL("../../vectors/protocol_vectors.json", import.meta.url), "utf8"));

describe("independently generated S/L commitment and recovery vectors", () => {
  for (const vector of vectors.privateValueProfiles) {
    it(`matches shape ${vector.shape}, including its last output position`, () => {
      expect(deliveryCommitmentFromHashes(vector.delivery.outputDataHashes.map(BigInt), BigInt(vector.delivery.arenaHash)))
        .toBe(BigInt(vector.privateValue.global.deliveryCommitment));
      expect(privateValueCommitment(vector.privateValue, vector.shape)).toBe(BigInt(vector.privateValueCommitment));
      expect(payoutTransactionContext(vectors.chainId, vector.nullifiers, vector.shape)).toBe(BigInt(vector.transactionContext));
      expect(issuancePayoutOpening(vectors.payouts.owner, vectors.payouts.nkRoot, vectors.chainId,
        vector.nullifiers, vector.shape).noteSecret).toBe(BigInt(vector.issuanceSecret));
      expect(noteSecret(noteSecretSeed(vectors.outputNoteSecret.noteNk), vector.nullifiers,
        vector.outputIndex, vector.outputEntropy, vector.shape)).toBe(BigInt(vector.outputNoteSecret));
    });
  }
});
