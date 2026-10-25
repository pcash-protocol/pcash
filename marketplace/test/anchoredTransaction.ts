import {
  buildContractBody,
  WIRE_PROOF_BYTES,
  DEFAULT_NETWORK_CONFIG,
  encodePrivateValueTransaction,
  functionSelector,
  deliveryCommitment,
  OUTPUT_DATA_BYTES,
  PRIVATE_VALUE_PROFILES,
  type PrivateValueOutputData,
} from "@pcash/sdk/browser";

const EMPTY_OUTPUT_DATA: PrivateValueOutputData = Array.from({ length: 5 }, () => new Uint8Array(OUTPUT_DATA_BYTES).fill(1));
const EMPTY_ARENA = new Uint8Array(PRIVATE_VALUE_PROFILES.S.arenaBytes);
const EMPTY_DELIVERY = deliveryCommitment(EMPTY_OUTPUT_DATA, EMPTY_ARENA);

/** A minimal decodable contract body for creation fixtures. */
export function fixtureContractBody(nkRoot = 0x77n): Uint8Array {
  return buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot },
    functions: [{
      selector: functionSelector(0),
      applicationVkHash: 0x1234n,
      configurationCommitment: 0x5678n,
    }],
  }).body;
}

/** Sponsored contract-creation funding: the sponsor's fee section, anchored to one block. */
export function sponsoredContractFunding(recentPcashBlockHash: bigint, salt = 1n, fee = 1n) {
  return {
    mode: "sponsored",
    section: {
      publicInputs: [
        DEFAULT_NETWORK_CONFIG.pcashChainId,
        recentPcashBlockHash,
        salt, salt + 1n, salt + 2n, salt + 3n,
        1n, 2n, 3n, 4n, 5n,
        EMPTY_DELIVERY,
        fee, 0n, 0n, 1n, 0n, 0n,
      ],
      proof: new Uint8Array(WIRE_PROOF_BYTES),
      outputData: EMPTY_OUTPUT_DATA,
      arena: EMPTY_ARENA,
    },
  } as const;
}

/** A claim-key commitment for buyer records in tests. */
export const BUY_COMMITMENT = `0x${"c1".repeat(32)}` as const;

/**
 * A node's `getTransactionByNullifier` result for an escrow spend included in
 * Ethereum block `l1BlockNumber` by a transaction that required
 * `carrierContextHash`.
 */
export function escrowSpenderResult(contentHash: string, l1BlockNumber: bigint, carrierContextHash: bigint, timestamp = 1n) {
  return {
    summary: { contentHash, timestamp, inclusion: { l1BlockNumber } },
    rawTransaction: `0x${Buffer.from(anchoredPrivateValueTransaction(1n, 1n, 1n, 0n, carrierContextHash)).toString("hex")}`,
  };
}

/** A structurally valid private-value transaction proved against one recentPcashBlockHash; `salt` distinguishes transactions. */
export function anchoredPrivateValueTransaction(
  recentPcashBlockHash: bigint,
  salt = 1n,
  fee = 1n,
  issuanceOwnerCommitment = 0n,
  carrierContextHash = 0n,
): Uint8Array {
  return encodePrivateValueTransaction({
    publicInputs: [
      DEFAULT_NETWORK_CONFIG.pcashChainId,
      recentPcashBlockHash,
      salt,
      salt + 1n,
      salt + 2n,
      salt + 3n,
      1n,
      2n,
      3n,
      4n,
      5n,
      EMPTY_DELIVERY,
      fee,
      issuanceOwnerCommitment,
      0n,
      1n,
      carrierContextHash,
      0n,
    ],
    proof: new Uint8Array(WIRE_PROOF_BYTES),
    outputData: EMPTY_OUTPUT_DATA,
    arena: EMPTY_ARENA,
  });
}
