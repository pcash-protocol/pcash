import { BATCH_HEADER_BYTES, ITEM_LENGTH_PREFIX_BYTES, MAX_BROWSER_RELAY_BATCH_BYTES, MAX_RELAY_CONTENT_HASHES } from "@pcash/sdk/relay";

/** Reserve the carrier header and every item's length prefix. */
export function purchaseBatches<T>(items: readonly T[], byteSize: (item: T) => number): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = BATCH_HEADER_BYTES;
  for (const item of items) {
    const size = BigInt(byteSize(item)) + ITEM_LENGTH_PREFIX_BYTES;
    if (batch.length && (bytes + size > MAX_BROWSER_RELAY_BATCH_BYTES || batch.length === MAX_RELAY_CONTENT_HASHES)) {
      batches.push(batch);
      batch = [];
      bytes = BATCH_HEADER_BYTES;
    }
    batch.push(item);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
