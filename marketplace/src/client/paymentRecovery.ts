import { bytesToHex, decodeAbiParameters, encodeAbiParameters, hexToBytes, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { addressHex, decodeTransaction, fieldToHex, networkConfigFromStatus, type PcashNodeClient, type StatusResult } from "@pcash/sdk/browser";
import type { PcashProfile } from "@pcash/sdk/wallet";
import { RECLAIM_APPLICATION_VK_HASH, reclaimConfigurationCommitment } from "../commitments.mts";
import { deriveVerifiedOfferClaimMaterial } from "./verifiedContractMaterial.ts";
import { parsePublication, publicationContractAddress, publicationEscrowNote, type OfferPublication } from "./publication.ts";
import { purchaseCommitment } from "./buy.ts";
import { paymentKey, routerPaymentKey } from "./paymentRouter.ts";
import { MAX_ASSET_DEFINITION_BYTES } from "@pcash/sdk/protocol";
import { fullOutputCommitment } from "@pcash/sdk/browser";

export const PAYMENT_EVENT = parseAbiItem("event Payment(bytes32 indexed offerId,address indexed seller,address indexed payer,uint256 amount,bytes32 claimKeyCommitment,bytes recoveryData)");
export const PAYMENT_SCAN_PAGE_BLOCKS = 1_000n;
const RECOVERY_ABI = [
  { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "uint256" }, { type: "address" }, { type: "uint256" },
] as const;
/** The ten head words and the asset definition's length word. */
const RECOVERY_FIXED_BYTES = 11 * 32;

export function encodePaymentRecovery(pub: OfferPublication): Hex {
  if (pub.escrow === undefined) throw new Error("payment requires funded escrow");
  return encodeAbiParameters(RECOVERY_ABI, [publicationContractAddress(pub) as Address,
    BigInt(pub.l2Contract.claimConfigurationSalt), BigInt(pub.terms.assetId), BigInt(pub.terms.amount),
    BigInt(pub.escrow.noteSecret), BigInt(pub.escrow.leafIndex), (pub.assetDefinition ?? "0x") as Hex,
    BigInt(pub.l2Contract.reclaimConfigurationSalt), pub.reclaimAuthority as Address, BigInt(pub.terms.deadlineT)]);
}

/** A bounded payer-filtered scan. No cursor can hide a payment after a reorg. */
export async function* scanPayerPayments(client: Pick<PublicClient, "getLogs">, input: {
  router: Address; payer: Address; deploymentBlock: bigint; head: bigint; offerId?: Hex; seller?: Address;
}) {
  for (let fromBlock = input.deploymentBlock; fromBlock <= input.head; fromBlock += PAYMENT_SCAN_PAGE_BLOCKS) {
    const end = fromBlock + PAYMENT_SCAN_PAGE_BLOCKS - 1n;
    const logs = await client.getLogs({ address: input.router, event: PAYMENT_EVENT,
      args: { payer: input.payer, ...(input.offerId === undefined ? {} : { offerId: input.offerId }), ...(input.seller === undefined ? {} : { seller: input.seller }) },
      fromBlock, toBlock: end < input.head ? end : input.head, strict: true });
    for (const log of logs) yield log;
  }
}

/** One `Payment` log from `scanPayerPayments`. */
export interface ScannedPayment {
  args: { offerId: Hex; seller: Address; amount: bigint; claimKeyCommitment: Hex; recoveryData: Hex };
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
}

/**
 * One router payment within its Ethereum transaction. A contract wallet can pay several offers in one
 * transaction, and offers can share an id, so payments are told apart by the router's payment key.
 */
function paymentIdentity(transactionHash: string, router: string, key: Hex): string {
  return `${transactionHash.toLowerCase()}:${BigInt(router)}:${key.toLowerCase()}`;
}

export function scannedPaymentIdentity(router: Address, log: ScannedPayment): string {
  return paymentIdentity(log.transactionHash, router, paymentKey(log.args.offerId, log.args.seller, log.args.amount));
}

export function savedPaymentIdentity(transactionHash: string, publication: Pick<OfferPublication, "terms">): string {
  return paymentIdentity(transactionHash, publication.terms.router, routerPaymentKey(publication));
}

/**
 * Rebuild only from the buyer's actual payment, never from a seller's catalog.
 * The `Payment` log holds everything, so this works whatever account or contract called `buy`.
 */
export async function recoverPaymentPublication(input: {
  node: PcashNodeClient; client: Pick<PublicClient, "getBlock">; profile: PcashProfile; status: StatusResult;
  router: Address; log: ScannedPayment;
}): Promise<{ publication: OfferPublication; hash: Hex; blockNumber: bigint; blockHash: Hex; paidAt: number }> {
  const { client, log } = input;
  const { offerId, seller, amount: ethPriceWei, claimKeyCommitment: commitment, recoveryData } = log.args;
  if (recoveryData.length > 2 + 2 * (RECOVERY_FIXED_BYTES + Math.ceil(MAX_ASSET_DEFINITION_BYTES / 32) * 32)) throw new Error("payment recovery data exceeds its maximum size");
  const [address, claimSalt, assetId, amount, noteSecret, outputIndex, definition, reclaimSalt, authority, deadlineT] = decodeAbiParameters(RECOVERY_ABI, recoveryData);
  if (outputIndex > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("escrow output index exceeds the supported range");
  const contract = await input.node.getContract(address);
  if (contract.status !== "contract") throw new Error("payment escrow contract is unavailable");
  const creation = decodeTransaction(hexToBytes(contract.transaction as Hex));
  if (!("body" in creation)) throw new Error("escrow origin is not a contract creation");
  const publication = parsePublication(JSON.stringify({ version: 1, chainId: fieldToHex(BigInt(input.status.pcashChainId)),
    terms: { router: fieldToHex(BigInt(input.router)), seller: fieldToHex(BigInt(seller)), id: offerId,
      assetId: fieldToHex(assetId), amount: fieldToHex(amount), ethPriceWei: fieldToHex(ethPriceWei), deadlineT: fieldToHex(deadlineT) },
    l2Contract: { bodyHex: bytesToHex(creation.body), claimConfigurationSalt: fieldToHex(claimSalt), reclaimConfigurationSalt: fieldToHex(reclaimSalt) },
    reclaimAuthority: authority.toLowerCase(), ...(definition === "0x" ? {} : { assetDefinition: definition }),
    escrow: { leafIndex: Number(outputIndex), noteSecret: fieldToHex(noteSecret), amount: fieldToHex(amount) },
  }));
  const material = deriveVerifiedOfferClaimMaterial(publication);
  if (material.l2Contract.address !== BigInt(address)) throw new Error("recovery contract address mismatch");
  const reclaim = material.l2Contract.function(1);
  if (reclaim.applicationVkHash !== RECLAIM_APPLICATION_VK_HASH || reclaim.configurationCommitment !== reclaimConfigurationCommitment(reclaimSalt, networkConfigFromStatus(input.status), BigInt(authority), BigInt(offerId), deadlineT)) throw new Error("recovery reclaim configuration mismatch");
  if (purchaseCommitment(publication, input.profile).toLowerCase() !== commitment.toLowerCase()) throw new Error("payment belongs to another claim key");
  const note = publicationEscrowNote(publication, material.l2Contract);
  if (await input.node.getOutputPath(outputIndex, fullOutputCommitment(note, outputIndex)) === null) throw new Error("recovery escrow opening is unavailable");
  const block = await client.getBlock({ blockNumber: log.blockNumber });
  if (block.hash !== log.blockHash) throw new Error("payment is no longer canonical");
  return { publication, hash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash, paidAt: Number(block.timestamp * 1000n) };
}
