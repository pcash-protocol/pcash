import {
  createPscanClient,
  type PscanClient,
  type StatusResult,
  type SubmitContractConfigurationOpeningsResult,
} from "@pcash/sdk/clients";
import {
  marketplacePublicationSourceConfigurationOpenings,
  type OfferPublication,
  type StoredOffer,
} from "@pcash/marketplace/app";

export const MARKETPLACE_PSCAN_TIMEOUT_MS = 5_000;

export function marketplacePscanClient(
  url: string | undefined,
  timeoutMs = MARKETPLACE_PSCAN_TIMEOUT_MS,
): PscanClient | undefined {
  const value = url?.trim();
  return value === undefined || value === "" ? undefined : createPscanClient(value, { timeoutMs });
}

/** Only a funded listing successfully published to the public catalog may disclose its configuration opening. */
export function isPublicCreatedOffer(offer: StoredOffer): boolean {
  return offer.source === "created"
    && offer.pub.escrow !== undefined
    && offer.publish?.catalogPublishedAt !== undefined
    && offer.publish.catalogPublicationId !== undefined;
}

export type MarketplaceSourcePublication =
  | { status: "pending-verification" }
  | { status: "published"; result: SubmitContractConfigurationOpeningsResult };

export async function publishMarketplaceSourceOpenings(
  pscan: PscanClient,
  publication: OfferPublication,
  readStatus: () => Promise<StatusResult>,
): Promise<MarketplaceSourcePublication> {
  // Pair the write with the RPC status that governs it. Pscan is configured
  // independently of the node, and a cached status can describe a history the
  // node has already left, which would let this land on the registry for a
  // different chain than the catalog was read from.
  const [info, status] = await Promise.all([pscan.sourceVerificationInfo(), readStatus()]);
  if (
    info.status !== "ready"
    || info.configurationOpeningSubmissionStatus !== "ready"
    || info.pcashChainId !== status.pcashChainId
    || info.genesisHash?.toLowerCase() !== status.genesisHash.toLowerCase()
  ) {
    throw new Error("Pscan is not a writable source registry for the connected PCASH network");
  }
  const values = marketplacePublicationSourceConfigurationOpenings(publication, {
    pcashChainId: BigInt(status.pcashChainId),
    l1ChainId: status.l1ChainId,
    inboxAddress: BigInt(status.inboxAddress),
  });
  const contractAddress = values[0]!.address;
  const source = await pscan.getContractSource(contractAddress);
  if (source?.verificationStatus !== "verified") return { status: "pending-verification" };

  const result = await pscan.submitContractConfigurationOpenings({
    contractAddress,
    openings: values.map(({ address: _address, ...opening }) => opening),
  });
  return { status: "published", result };
}
