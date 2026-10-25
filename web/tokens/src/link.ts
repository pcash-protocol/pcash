// Bearer claim links. One published-root Contract Account per link batch holds
// one inventory note per link; a link key opens exactly one note, and that
// note's own nullifier makes the link one-shot.
//
// Everything about the contract derives from a contract seed the link carries,
// so a link is self-contained: the claimant rebuilds the exact body and address
// without a catalog. The seed also hides the configuration salt, so the
// contract body on Ethereum DA does not reveal which asset the links carry.

import { BN254_SCALAR_MODULUS, poseidon, toField, type FieldNumberish } from "@pcash/sdk/crypto";
import {
  assertAssetAmount,
  assetDefinitionAssetId,
  buildContractBody,
  decodeAssetDefinition,
  encodeAssetDefinition,
  fullOutputCommitment,
  noteNk,
  nullifier,
  ownerCommitment,
  type ArenaSender,
  type AssetDefinition,
  type ContractFunction,
} from "@pcash/sdk/protocol";
import { referenceConfigurationCommitment } from "@pcash/sdk/rules";
import { fm, privateValueMap, type AssetSnapshot } from "@pcash/sdk/builders";
import { bytesToBigInt, concatBytes, beBytes, field32, fromBase64Url, randomFieldEntropy, toBase64Url, toHex } from "@pcash/sdk/utils";
import {
  CLAIM_LINK_FUNCTION_SELECTOR,
  TOKENS_LINK_CONTRACT_DOMAIN,
  TOKENS_LINK_CONTRACT_SEED_DOMAIN,
  TOKENS_LINK_KEY_DOMAIN,
  TOKENS_LINK_NOTE_SECRET_DOMAIN,
  TOKENS_LINK_SET_DOMAIN,
} from "./constants.ts";
import { CLAIM_LINK_APPLICATION_VK_HASH } from "./applicationPins.ts";
import { TOKENS_CIRCUIT_PACKAGES, TOKENS_CIRCUITS } from "./circuits.ts";
import {
  buildTemplateAction,
  templateAssetOutput,
  templateContractAccount,
  type TemplateAction,
  type TemplateContract,
  type TemplateContractOpening,
  type TemplateNoteOpening,
  type TemplateRecipient,
  type TemplateRole,
  type TemplateActionSpec,
} from "./template.ts";
import type { FundedOutput } from "./witness.ts";

const LINK_VERSION = 1;
const AMOUNT_BYTES = 16;
const LINK_FIXED_BYTES = 1 + 32 + 32 + 1 + AMOUNT_BYTES + 32;

function nonzeroField(value: FieldNumberish, label: string): bigint {
  const field = toField(value, label);
  if (field === 0n) throw new Error(`${label} must be nonzero`);
  return field;
}

export interface ClaimLinkConfiguration {
  configurationSalt: bigint;
  assetId: bigint;
}

export function claimLinkConfigurationCommitment(configuration: ClaimLinkConfiguration): bigint {
  return referenceConfigurationCommitment(configuration.configurationSalt, [configuration.assetId]);
}

/** A claim-link contract and every value derived from its seed. */
export interface ClaimLinkContract extends TemplateContract {
  contractSeed: bigint;
  configuration: ClaimLinkConfiguration;
  configurationCommitment: bigint;
  /** Unsigned contract-account body for sponsored creation. */
  body: Uint8Array;
  accountStateCommitment: bigint;
}

export function claimLinkContract(params: { contractSeed: FieldNumberish; assetId: FieldNumberish }): ClaimLinkContract {
  const contractSeed = toField(params.contractSeed, "contractSeed");
  const configuration = {
    configurationSalt: poseidon([TOKENS_LINK_CONTRACT_DOMAIN, contractSeed, 0n]),
    assetId: nonzeroField(params.assetId, "assetId"),
  };
  const nkRoot = poseidon([TOKENS_LINK_CONTRACT_DOMAIN, contractSeed, 1n]);
  const configurationCommitment = claimLinkConfigurationCommitment(configuration);
  const functions: ContractFunction[] = [{
    selector: CLAIM_LINK_FUNCTION_SELECTOR,
    applicationVkHash: CLAIM_LINK_APPLICATION_VK_HASH,
    configurationCommitment,
  }];
  const built = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot }, functions });
  return {
    contractSeed,
    configuration,
    configurationCommitment,
    nkRoot,
    functions,
    body: built.body,
    address: built.address,
    functionSetCommitment: built.functionSetCommitment,
    accountStateCommitment: built.accountStateCommitment,
  };
}

/**
 * A link set's creator secret, re-derived from the creator's nullifier key root
 * and the set's stored nonce, so a stored set record holds no secret.
 */
export function claimLinkSetSecret(creatorNkRoot: FieldNumberish, nonce: FieldNumberish): bigint {
  return poseidon([TOKENS_LINK_SET_DOMAIN, toField(creatorNkRoot, "creatorNkRoot"), toField(nonce, "nonce")]);
}

/** The contract seed of a creator's link batch. */
export function claimLinkContractSeed(creatorSecret: FieldNumberish): bigint {
  return poseidon([TOKENS_LINK_CONTRACT_SEED_DOMAIN, toField(creatorSecret, "creatorSecret")]);
}

/** The creator regenerates every link key of a batch from its one secret. */
export function claimLinkKey(creatorSecret: FieldNumberish, index: number): bigint {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("link index must be a nonnegative integer");
  return poseidon([TOKENS_LINK_KEY_DOMAIN, toField(creatorSecret, "creatorSecret"), BigInt(index)]);
}

export function claimLinkNoteSecret(linkKey: FieldNumberish): bigint {
  return poseidon([TOKENS_LINK_NOTE_SECRET_DOMAIN, toField(linkKey, "linkKey")]);
}

/**
 * One funded link. The definition fixes the asset, and with it the contract.
 * The note is named by its funding output, whose leaf the claim reads from
 * the receipt.
 */
export interface ClaimLink {
  contractSeed: bigint;
  funding: FundedOutput;
  amount: bigint;
  linkKey: bigint;
  definition: AssetDefinition;
}

/** A link's note at a known leaf. */
export type ClaimLinkNoteRef = Pick<ClaimLink, "linkKey" | "amount"> & { leafIndex: number };

/**
 * `version(1) ‖ contractSeed(32) ‖ fundingContentHash(32) ‖ outputSlot(1) ‖ amount(16) ‖ linkKey(32) ‖ definition`.
 * The canonical definition encoding runs to the end of the link.
 */
export function encodeClaimLink(link: ClaimLink): Uint8Array {
  if (!Number.isInteger(link.funding.slot) || link.funding.slot < 0 || link.funding.slot > 0xff) throw new Error("link output slot must fit one byte");
  return concatBytes(
    Uint8Array.of(LINK_VERSION),
    field32(link.contractSeed),
    beBytes(BigInt(link.funding.contentHash), 32),
    Uint8Array.of(link.funding.slot),
    beBytes(link.amount, AMOUNT_BYTES),
    field32(link.linkKey),
    encodeAssetDefinition(link.definition),
  );
}

/** Strict parse of untrusted link bytes. */
export function decodeClaimLink(bytes: Uint8Array): ClaimLink {
  if (bytes.length <= LINK_FIXED_BYTES) throw new Error("claim link is truncated");
  if (bytes[0] !== LINK_VERSION) throw new Error("unsupported claim link version");
  let offset = 1;
  const take = (length: number): Uint8Array => bytes.subarray(offset, offset += length);
  const canonicalField = (label: string): bigint => {
    const value = bytesToBigInt(take(32));
    if (value >= BN254_SCALAR_MODULUS) throw new Error(`claim link ${label} is not a canonical field element`);
    return value;
  };
  const contractSeed = canonicalField("contract seed");
  const contentHash = toHex(take(32));
  const slot = take(1)[0]!;
  const amount = bytesToBigInt(take(AMOUNT_BYTES));
  if (amount === 0n) throw new Error("claim link amount must be nonzero");
  const linkKey = canonicalField("link key");
  return { contractSeed, funding: { contentHash, slot }, amount, linkKey, definition: decodeAssetDefinition(bytes.slice(offset)) };
}

/** The contract a link's seed and definition derive; a link names no address. */
export function claimLinkContractOf(link: Pick<ClaimLink, "contractSeed" | "definition">): ClaimLinkContract {
  return claimLinkContract({ contractSeed: link.contractSeed, assetId: assetDefinitionAssetId(link.definition) });
}

/** The claim page URL with the link in its fragment, which browsers never send to the server. */
export function formatClaimLinkUrl(link: ClaimLink, claimPageUrl: string): string {
  const hash = claimPageUrl.indexOf("#");
  return `${hash < 0 ? claimPageUrl : claimPageUrl.slice(0, hash)}#${toBase64Url(encodeClaimLink(link))}`;
}

/** Accepts a claim URL or its bare fragment. */
export function parseClaimLink(text: string): ClaimLink {
  const trimmed = text.trim();
  const hash = trimmed.indexOf("#");
  return decodeClaimLink(fromBase64Url(hash < 0 ? trimmed : trimmed.slice(hash + 1)));
}

/** The inventory note a link opens under its contract. */
export interface ClaimLinkNote {
  owner: bigint;
  noteSecret: bigint;
  amount: bigint;
  leafIndex: number;
  outputCommitment: bigint;
  nullifier: bigint;
}

export function claimLinkNote(contract: ClaimLinkContract, link: ClaimLinkNoteRef): ClaimLinkNote {
  const owner = contract.address;
  const noteSecret = claimLinkNoteSecret(link.linkKey);
  const outputCommitment = fullOutputCommitment(
    { owner, noteSecret, assetId: contract.configuration.assetId, amount: link.amount },
    link.leafIndex,
  );
  return {
    owner,
    noteSecret,
    amount: link.amount,
    leafIndex: link.leafIndex,
    outputCommitment,
    nullifier: nullifier(outputCommitment, noteNk(contract.nkRoot), noteSecret),
  };
}

/** Funding for one link: send `amount` of the asset to the contract under `noteSecret`. */
export interface ClaimLinkFunding {
  index: number;
  linkKey: bigint;
  noteSecret: bigint;
  amount: bigint;
}

/** The contract and per-link funding a creator's batch needs before any note lands. */
export function planClaimLinks(params: {
  creatorSecret: FieldNumberish;
  assetId: FieldNumberish;
  amounts: readonly bigint[];
  indexes?: readonly number[];
}): { contract: ClaimLinkContract; links: ClaimLinkFunding[] } {
  const contract = claimLinkContract({ contractSeed: claimLinkContractSeed(params.creatorSecret), assetId: params.assetId });
  const indexes = params.indexes ?? params.amounts.map((_, index) => index);
  if (indexes.length !== params.amounts.length || new Set(indexes).size !== indexes.length) throw new Error("link indexes must name each amount once");
  const links = params.amounts.map((amount, position) => {
    const index = indexes[position]!;
    assertAssetAmount(amount, `link ${index} amount`);
    const linkKey = claimLinkKey(params.creatorSecret, index);
    return { index, linkKey, noteSecret: claimLinkNoteSecret(linkKey), amount };
  });
  return { contract, links };
}

export interface ClaimLinkSpendParams {
  contract: ClaimLinkContract;
  pcashChainId: FieldNumberish;
  snapshot: AssetSnapshot;
  contractOpening: TemplateContractOpening;
  /** One note for a claim; up to four (three when sponsored) when the creator claims its unclaimed links. */
  notes: readonly (ClaimLinkNoteRef & Pick<TemplateNoteOpening, "siblings">)[];
  /** Receives the notes' whole value under a fresh secret. */
  recipient: TemplateRecipient;
  role: TemplateRole;
  notBeforeTimestamp?: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
  assetDefinition: AssetDefinition;
  dummyInputSeed?: FieldNumberish;
  /** The claiming wallet's sender region. */
  sender?: ArenaSender;
}

/**
 * Spend link notes to one recipient. Whoever holds a link claims it this way,
 * including the creator, who holds every link it made.
 */
export function buildClaimLinkSpend(params: ClaimLinkSpendParams): TemplateAction {
  return buildTemplateAction(claimLinkSpendSpec(params));
}

/** Shared contract-side terms for unsponsored and wallet-sponsored link spends. */
export function claimLinkSpendSpec(params: ClaimLinkSpendParams): TemplateActionSpec {
  const { contract } = params;
  const assetId = contract.configuration.assetId;
  const pcashChainId = toField(params.pcashChainId, "pcashChainId");
  const account = templateContractAccount(contract, CLAIM_LINK_FUNCTION_SELECTOR, params.contractOpening);
  const assetInputs = params.notes.map((link) => {
    const note = claimLinkNote(contract, link);
    return { noteSecret: note.noteSecret, amount: note.amount, leafIndex: note.leafIndex, siblings: link.siblings };
  });
  const total = assetInputs.reduce((sum, note) => sum + note.amount, 0n);
  const payoutSecret = randomFieldEntropy();
  return {
    pcashChainId,
    snapshot: params.snapshot,
    contract: account,
    assetId,
    assetInputs,
    assetOutputs: () => [templateAssetOutput({
      pcashChainId,
      assetId,
      slot: 0,
      amount: total,
      recipient: params.recipient,
      noteSecret: payoutSecret,
      assetDefinition: params.assetDefinition,
    })],
    role: params.role,
    ...(params.notBeforeTimestamp === undefined ? {} : { notBeforeTimestamp: params.notBeforeTimestamp }),
    validUntilTimestamp: params.validUntilTimestamp,
    ...(params.dummyInputSeed === undefined ? {} : { dummyInputSeed: params.dummyInputSeed }),
    ...(params.sender === undefined ? {} : { sender: params.sender }),
    application: (build, feePaid) => {
      const first = assetInputs[0]!;
      return {
        packageName: TOKENS_CIRCUIT_PACKAGES.claimLink,
        circuitUrl: TOKENS_CIRCUITS.claimLink,
        label: "claim-link function",
        witnessMap: {
          recent_pcash_block_hash: fm(build.recentPcashBlockHash),
    event_entry: fm(build.eventOpening.eventEntry),
          address: fm(contract.address),
          pcash_chain_id: fm(pcashChainId),
          fee_paid: feePaid,
          private_value: privateValueMap(build.transaction),
          configuration: {
            configuration_salt: fm(contract.configuration.configurationSalt),
            asset_id: fm(assetId),
          },
          asset_input: {
            slot: 0,
            owner_commitment: fm(ownerCommitment(contract.address, first.noteSecret)),
            amount: fm(first.amount),
            output_index: fm(first.leafIndex),
          },
        },
      };
    },
  };
}
