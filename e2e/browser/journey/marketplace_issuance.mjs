import { nextBlockIssuanceQuote } from "@pcash/sdk/relay";

/** Read the head and quote the next slot, retrying if auto-relay advances first. */
export async function readJourneyIssuanceQuote(node) {
  return nextBlockIssuanceQuote(node, await node.status());
}
