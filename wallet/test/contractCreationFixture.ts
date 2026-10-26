import { OUTPUT_DATA_BYTES, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { WIRE_PROOF_BYTES, deliveryCommitment, encodePrivateValueTransaction, accountCreationAttachmentCommitment } from "@pcash/sdk/protocol";

export function contractCreationFixture(chainId: number, fee = 0n): Uint8Array {
  const empty = new Uint8Array(OUTPUT_DATA_BYTES);
  empty[0] = 1;
  const outputData = [empty, empty, empty, empty, empty];
  const arena = new Uint8Array(PRIVATE_VALUE_PROFILES.S.arenaBytes);
  const accountCreation = { kind: "contract" as const, body: new Uint8Array(35) };
  return encodePrivateValueTransaction({
    accountCreation,
    publicInputs: [BigInt(chainId), ...Array(10).fill(0n), deliveryCommitment(outputData, arena), fee, 0n, 0n, 100n, 0n, 0n, accountCreationAttachmentCommitment(accountCreation, chainId)],
    proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena,
  });
}
