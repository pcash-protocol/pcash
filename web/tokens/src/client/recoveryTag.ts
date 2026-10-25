import { beBytes, bytesToBigInt, concatBytes } from "@pcash/sdk/utils";

const LINK_SET_TAG = 1;
const DROP_TAG = 2;
const LINK_SET_LENGTH = 1 + 32;
const DROP_LENGTH = 1 + 32 + 16 + 2 + 8 + 8;

export type TokenRecoveryTag =
  | { kind: "links"; nonce: bigint }
  | {
    kind: "drop";
    dropSeed: bigint;
    claimAmount: bigint;
    count: number;
    cutoffBlockNumber: bigint;
    claimEndTimestamp: bigint;
  };

export function linkSetRecoveryTag(nonce: bigint): Uint8Array {
  return concatBytes(Uint8Array.of(LINK_SET_TAG), beBytes(nonce, 32));
}

export function dropRecoveryTag(input: Omit<Extract<TokenRecoveryTag, { kind: "drop" }>, "kind">): Uint8Array {
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count >= 2 ** 16) throw new Error("drop recovery count must fit uint16");
  return concatBytes(
    Uint8Array.of(DROP_TAG),
    beBytes(input.dropSeed, 32),
    beBytes(input.claimAmount, 16),
    beBytes(input.count, 2),
    beBytes(input.cutoffBlockNumber, 8),
    beBytes(input.claimEndTimestamp, 8),
  );
}

export function parseTokenRecoveryTag(bytes: Uint8Array): TokenRecoveryTag {
  if (bytes[0] === LINK_SET_TAG && bytes.length === LINK_SET_LENGTH) {
    return { kind: "links", nonce: bytesToBigInt(bytes.subarray(1)) };
  }
  if (bytes[0] === DROP_TAG && bytes.length === DROP_LENGTH) {
    const count = Number(bytesToBigInt(bytes.subarray(49, 51)));
    if (count < 1) throw new Error("drop recovery count must be positive");
    return {
      kind: "drop",
      dropSeed: bytesToBigInt(bytes.subarray(1, 33)),
      claimAmount: bytesToBigInt(bytes.subarray(33, 49)),
      count,
      cutoffBlockNumber: bytesToBigInt(bytes.subarray(51, 59)),
      claimEndTimestamp: bytesToBigInt(bytes.subarray(59, 67)),
    };
  }
  throw new Error("unknown token recovery tag");
}
