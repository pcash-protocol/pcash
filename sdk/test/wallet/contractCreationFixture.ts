import { encodeContractAccountCreation } from "@pcash/sdk/protocol";

export function contractCreationFixture(chainId: number): Uint8Array {
  return encodeContractAccountCreation(chainId, new Uint8Array(35), {
    recentPcashBlockHash: 1n, validUntilTimestamp: 100n,
  });
}
