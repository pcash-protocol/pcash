/** Maximum derivation lag allowed before sending an irreversible marketplace payment. */
export const MAX_PAYMENT_NODE_LAG_BLOCKS = 5n;

/** The connected node may have stopped deriving while the selected L1 keeps advancing. */
export function assertPaymentNodeFreshness(nodeL1BlockNumber: bigint, l1Head: bigint): void {
  const lag = l1Head - nodeL1BlockNumber;
  if (lag > MAX_PAYMENT_NODE_LAG_BLOCKS) {
    throw new Error(`PCASH node is ${lag} L1 blocks behind the selected L1 head; maximum allowed lag is ${MAX_PAYMENT_NODE_LAG_BLOCKS} blocks; wait for the node to catch up and verify the offer again`);
  }
}
