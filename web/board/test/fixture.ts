import { buildArena, encodePrivateValueTransaction, WIRE_PROOF_BYTES, DEFAULT_NETWORK_CONFIG } from "@pcash/sdk/protocol";
import { OUTPUT_DATA_BYTES, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import type { DataRecord } from "@pcash/sdk/delivery";
import { encodePost, boardId } from "../src/codec.ts";

export const network = { chainId: BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId), genesisHash: "0x" + "11".repeat(32) };
export const board = boardId("general");
const OUTPUTS = 5;

/** A private-value transaction whose arena publishes `records`. */
export function publishingTransaction(records: readonly DataRecord[]): Uint8Array {
  const publicInputs = Array<bigint>(PRIVATE_VALUE_PROFILES.S.publicInputs).fill(1n);
  publicInputs[0] = network.chainId;
  const arena = buildArena({ shape: 0, context: { chainId: network.chainId, transactionType: 0, nullifiers: [1n, 1n, 1n, 1n] }, recipients: [], public: records }).arena;
  return encodePrivateValueTransaction({ publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: Array.from({ length: OUTPUTS }, () => new Uint8Array(OUTPUT_DATA_BYTES)), arena });
}

/** A post and the transaction that publishes it. */
export function fixture(text = "hello", nonce = "0x" + "22".repeat(32)) {
  const encoded = encodePost(network, { board, text, nonce });
  return { ...encoded, bytes: publishingTransaction([encoded.record]) };
}
