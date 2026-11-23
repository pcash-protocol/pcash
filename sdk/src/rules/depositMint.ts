// The standard deposit-mint rule: its configuration (one Ethereum vault), the
// asset it creates, the vault's `Deposit` log, the recipient commitment and
// replay ID a deposit carries, deposit codes, and the witness of
// `mint_rule_deposit_mint`. Each deposit mints once, its amount, on the chain
// and asset its recipient commitment names, to the PCASH address it opens to;
// only a holder of the opening can prove the mint, and any account may submit
// and pay for it. The rule has an S verification key only: a deposit mints one
// note.

import { DEPOSIT_MINT_RULE_VK_HASH } from "../constants/rulePins.ts";
import {
  REFERENCE_DEPOSIT_MINT_CONFIGURATION_DOMAIN,
  REFERENCE_DEPOSIT_RECIPIENT_DOMAIN,
  REFERENCE_DEPOSIT_REPLAY_DOMAIN,
  REFERENCE_DEPOSIT_SALT_DOMAIN,
} from "../constants/referenceRuleConstants.ts";
import { BN254_SCALAR_MODULUS, toAddressField, toField, type FieldNumberish } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { mintMarker, type AssetDescriptor, type FungibleMetadata } from "../protocol/asset.ts";
import {
  assetDefinitionDescriptor,
  findAssetDefinition,
  type AssetDefinition,
  type PortableMintRule,
  type PortableTransferRule,
} from "../protocol/assetDefinition.ts";
import { l1LogGroundingWitnessMap, type L1LogGrounding, type L1LogInput } from "../protocol/l1Logs.ts";
import { ownerCommitment } from "../protocol/notes.ts";
import { SlotClass } from "../protocol/transaction.ts";
import { fm, privateValueMap, type WitnessMap } from "../protocol/witness.ts";
import { beBytes, bytesEqual, bytesToBigInt, concatBytes, field32, fromBase64Url, toBase64Url, utf8 } from "../utils/bytes.ts";
import { keccak256 } from "../utils/keccak.ts";
import { U128_LIMIT, U160_LIMIT, U32_LIMIT, U64_LIMIT, uintBelow } from "../utils/validate.ts";
import { requireMintRuleConfiguration, type MintWitnessInputs } from "./mintWitness.ts";

export const DEPOSIT_MINT_RULE_CIRCUIT = "mint_rule_deposit_mint";

/** The configuration opening: the vault's 20-byte address. */
export const DEPOSIT_MINT_CONFIGURATION_BYTES = 20;

/** topic0 of `Deposit(address indexed depositor, bytes32 recipientCommitment, bytes32 nonce, uint256 amount)`. */
export const DEPOSIT_TOPIC0 = keccak256(utf8("Deposit(address,bytes32,bytes32,uint256)"));

export interface DepositMintConfiguration {
  vault: bigint;
}

export function depositMintConfigurationCommitment(configuration: DepositMintConfiguration): bigint {
  return poseidon([REFERENCE_DEPOSIT_MINT_CONFIGURATION_DOMAIN, toAddressField(configuration.vault, "vault")]);
}

export function encodeDepositMintConfiguration(configuration: DepositMintConfiguration): Uint8Array {
  return beBytes(toAddressField(configuration.vault, "vault"), DEPOSIT_MINT_CONFIGURATION_BYTES);
}

/** The configuration a canonical opening encodes, or undefined. */
export function decodeDepositMintConfiguration(bytes: Uint8Array): DepositMintConfiguration | undefined {
  if (bytes.length !== DEPOSIT_MINT_CONFIGURATION_BYTES) return undefined;
  return { vault: bytesToBigInt(bytes) };
}

/** The mint rule of an asset minted once per deposit to `configuration.vault`. */
export function depositMintRule(configuration: DepositMintConfiguration): PortableMintRule {
  return {
    sVkHash: DEPOSIT_MINT_RULE_VK_HASH,
    lVkHash: 0n,
    configurationCommitment: depositMintConfigurationCommitment(configuration),
    configuration: encodeDepositMintConfiguration(configuration),
  };
}

/** Create an asset minted once per deposit to `vault`. */
export function createDepositMintAsset(args: {
  metadata: FungibleMetadata;
  vault: FieldNumberish;
  transferRule?: PortableTransferRule;
  startSalt?: FieldNumberish;
}): { definition: AssetDefinition; descriptor: AssetDescriptor } {
  const definition = findAssetDefinition({
    mintRule: depositMintRule({ vault: toAddressField(args.vault, "vault") }),
    ...(args.transferRule === undefined ? {} : { transferRule: args.transferRule }),
    metadata: args.metadata,
  }, args.startSalt);
  return { definition, descriptor: assetDefinitionDescriptor(definition) };
}

/**
 * The commitment a deposit carries to the PCASH chain, asset and address it
 * mints to. A deposit mints only the asset and chain it names, however many
 * assets name the same vault.
 */
export function recipientCommitment(
  pcashChainId: FieldNumberish,
  assetId: FieldNumberish,
  address: FieldNumberish,
  salt: FieldNumberish,
): bigint {
  return poseidon([
    REFERENCE_DEPOSIT_RECIPIENT_DOMAIN,
    uintBelow(pcashChainId, U32_LIMIT, "pcashChainId"),
    toField(assetId, "assetId"),
    toAddressField(address, "address"),
    toField(salt, "salt"),
  ]);
}

/**
 * Whether a log's recipient commitment word opens to the chain, asset,
 * `address` and `salt`. The rule recomposes the word from its halves in the
 * field, so a word at or above the modulus opens as its residue.
 */
export function opensRecipientCommitment(
  word: bigint,
  pcashChainId: FieldNumberish,
  assetId: FieldNumberish,
  address: FieldNumberish,
  salt: FieldNumberish,
): boolean {
  return word % BN254_SCALAR_MODULUS === recipientCommitment(pcashChainId, assetId, address, salt);
}

/**
 * The replay ID of the deposit at a log position: its marker is
 * `mintMarker(assetId, replayId)`. `logLeafIndex` is the log's index among its
 * Ethereum block's logs, the `logIndex` `eth_getLogs` returns, and its leaf
 * index in the block's normalized log tree.
 */
export function depositReplayId(l1BlockNumber: bigint | number, logLeafIndex: bigint | number, salt: FieldNumberish): bigint {
  return poseidon([
    REFERENCE_DEPOSIT_REPLAY_DOMAIN,
    uintBelow(l1BlockNumber, U64_LIMIT, "l1BlockNumber"),
    uintBelow(logLeafIndex, U64_LIMIT, "logLeafIndex"),
    toField(salt, "salt"),
  ]);
}

/**
 * The salt of a wallet's recipient commitment for one deposit code. It is
 * derived from the account's nk root and the code's public nonce, so the wallet
 * finds its deposits from Ethereum alone.
 */
export function depositSalt(
  nkRoot: FieldNumberish,
  pcashChainId: FieldNumberish,
  vault: FieldNumberish,
  nonce: FieldNumberish,
): bigint {
  return poseidon([
    REFERENCE_DEPOSIT_SALT_DOMAIN,
    toField(nkRoot, "nkRoot"),
    uintBelow(pcashChainId, U32_LIMIT, "pcashChainId"),
    toAddressField(vault, "vault"),
    toField(nonce, "nonce"),
  ]);
}

/** What a vault's `Deposit` log carries. The recipient commitment and nonce are the log's 32-byte words. */
export interface DepositEvent {
  depositor: bigint;
  recipientCommitment: bigint;
  nonce: bigint;
  amount: bigint;
}

/** Decodes a `Deposit` log; rejects any other topic layout, data length, or an amount of 2^128 or more. */
export function decodeDepositLog(log: Pick<L1LogInput, "topics" | "data">): DepositEvent {
  if (log.topics.length !== 2 || !bytesEqual(log.topics[0]!, DEPOSIT_TOPIC0) || log.topics[1]!.length !== 32) {
    throw new Error("not a vault Deposit log");
  }
  const depositor = bytesToBigInt(log.topics[1]!);
  if (depositor >= U160_LIMIT) throw new Error("Deposit depositor must be an address");
  if (log.data.length !== 96) throw new Error("Deposit data must be 96 bytes");
  const amount = bytesToBigInt(log.data.subarray(64, 96));
  if (amount >= U128_LIMIT) throw new Error("Deposit amount must be below 2^128");
  return {
    depositor,
    recipientCommitment: bytesToBigInt(log.data.subarray(0, 32)),
    nonce: bytesToBigInt(log.data.subarray(32, 64)),
    amount,
  };
}

/** The log `vault` emits for `deposit` at a position, as Ethereum holds it. */
export function depositLog(params: DepositEvent & {
  vault: FieldNumberish;
  transactionIndex: bigint | number;
  logIndex: bigint | number;
}): L1LogInput {
  return {
    transactionIndex: params.transactionIndex,
    logIndex: params.logIndex,
    emitter: toAddressField(params.vault, "vault"),
    topics: [DEPOSIT_TOPIC0, field32(params.depositor)],
    data: concatBytes(field32(params.recipientCommitment), field32(params.nonce), field32(params.amount)),
  };
}

/** The text before a deposit code's base64url body. */
export const DEPOSIT_CODE_PREFIX = "pdep:";
const DEPOSIT_CODE_BODY_BYTES = 4 + 20 + 32 + 32;
const DEPOSIT_CODE_CHECKSUM_BYTES = 4;

/**
 * What a depositor needs to deposit to one wallet: the recipient commitment and
 * nonce it passes to the vault. The chain and vault keep a code from being used
 * against another vault.
 */
export interface DepositCode {
  pcashChainId: bigint;
  vault: bigint;
  recipientCommitment: bigint;
  nonce: bigint;
}

/**
 * Refuses the words the vault refuses: a recipient commitment of zero or at or
 * above the field modulus, or a nonce at or above it.
 */
function requireDepositWords(code: Pick<DepositCode, "recipientCommitment" | "nonce">): void {
  if (code.recipientCommitment === 0n) throw new Error("the deposit code's recipient commitment is zero");
  toField(code.recipientCommitment, "the deposit code's recipient commitment");
  toField(code.nonce, "the deposit code's nonce");
}

/** `pdep:` and the base64url of chain ID (4 bytes), vault (20), commitment (32), nonce (32), and a 4-byte keccak checksum. */
export function encodeDepositCode(code: DepositCode): string {
  requireDepositWords(code);
  const body = concatBytes(
    beBytes(uintBelow(code.pcashChainId, U32_LIMIT, "pcashChainId"), 4),
    beBytes(toAddressField(code.vault, "vault"), 20),
    field32(code.recipientCommitment),
    field32(code.nonce),
  );
  return DEPOSIT_CODE_PREFIX + toBase64Url(concatBytes(body, keccak256(body).subarray(0, DEPOSIT_CODE_CHECKSUM_BYTES)));
}

/**
 * The code `text` carries, refused unless its checksum holds, it names
 * `expected`'s chain and vault, and the vault accepts its words.
 */
export function decodeDepositCode(text: string, expected: { pcashChainId: FieldNumberish; vault: FieldNumberish }): DepositCode {
  const trimmed = text.trim();
  if (!trimmed.startsWith(DEPOSIT_CODE_PREFIX)) throw new Error(`a deposit code starts with ${DEPOSIT_CODE_PREFIX}`);
  const bytes = fromBase64Url(trimmed.slice(DEPOSIT_CODE_PREFIX.length));
  if (bytes.length !== DEPOSIT_CODE_BODY_BYTES + DEPOSIT_CODE_CHECKSUM_BYTES) throw new Error("deposit code has wrong length");
  const body = bytes.subarray(0, DEPOSIT_CODE_BODY_BYTES);
  if (!bytesEqual(keccak256(body).subarray(0, DEPOSIT_CODE_CHECKSUM_BYTES), bytes.subarray(DEPOSIT_CODE_BODY_BYTES))) {
    throw new Error("deposit code checksum mismatch");
  }
  const code = {
    pcashChainId: bytesToBigInt(body.subarray(0, 4)),
    vault: bytesToBigInt(body.subarray(4, 24)),
    recipientCommitment: bytesToBigInt(body.subarray(24, 56)),
    nonce: bytesToBigInt(body.subarray(56, 88)),
  };
  if (code.pcashChainId !== uintBelow(expected.pcashChainId, U32_LIMIT, "pcashChainId")) {
    throw new Error("the deposit code is for another PCASH chain");
  }
  if (code.vault !== toAddressField(expected.vault, "vault")) throw new Error("the deposit code is for another vault");
  requireDepositWords(code);
  return code;
}

function halves(word: bigint): { high: string; low: string } {
  return { high: fm(word >> 128n), low: fm(word & (U128_LIMIT - 1n)) };
}

/**
 * The witness of `mint_rule_deposit_mint` for the deposit `log` of the
 * configured vault, opened by `opening` under the mint's recent block. It
 * refuses what the rule would: a log from another emitter or of another
 * layout, a recipient commitment that does not open to the mint's chain and
 * asset, `recipientAddress` and `salt`, any mint marker but the deposit's one,
 * and any asset output but one of the deposited amount to `recipientAddress`
 * under `noteSecret`.
 */
export function depositMintWitness(params: {
  mint: MintWitnessInputs;
  configuration: DepositMintConfiguration;
  log: Pick<L1LogInput, "emitter" | "topics" | "data">;
  opening: L1LogGrounding;
  recipientAddress: FieldNumberish;
  salt: FieldNumberish;
  noteSecret: FieldNumberish;
}): WitnessMap {
  const { mint, opening } = params;
  const vault = toAddressField(params.configuration.vault, "vault");
  requireMintRuleConfiguration(mint, depositMintConfigurationCommitment({ vault }));
  if (toField(params.log.emitter, "emitter") !== vault) throw new Error("the deposit log is not from the asset's vault");
  const deposit = decodeDepositLog(params.log);
  const recipient = toAddressField(params.recipientAddress, "recipientAddress");
  const salt = toField(params.salt, "salt");
  const noteSecret = toField(params.noteSecret, "noteSecret");
  if (!opensRecipientCommitment(deposit.recipientCommitment, mint.pcashChainId, mint.assetId, recipient, salt)) {
    throw new Error("the deposit's recipient commitment does not open to the chain, asset, recipient and salt");
  }
  const marker = mintMarker(mint.assetId, depositReplayId(opening.l1BlockNumber, opening.logLeafIndex, salt));
  const markers = mint.transaction.inputs.filter((input) => input.slotClass === SlotClass.MINT);
  if (markers.length !== 1 || markers[0]!.nullifier !== marker) {
    throw new Error("a deposit mint carries exactly one mint marker, keyed by the deposit's replay ID");
  }
  const assetSlots = mint.transaction.outputs.flatMap((output, slot) => output.slotClass === SlotClass.ASSET ? [slot] : []);
  if (assetSlots.length !== 1) throw new Error("a deposit mint carries exactly one asset output");
  const slot = assetSlots[0]!;
  if (mint.outputAmounts[slot] !== deposit.amount) throw new Error("a deposit mint's asset output must be the deposited amount");
  if (mint.outputOwnerCommitments[slot] !== ownerCommitment(recipient, noteSecret)) {
    throw new Error("a deposit mint's asset output must go to the deposit's recipient");
  }
  const depositor = halves(deposit.depositor);
  const committed = halves(deposit.recipientCommitment);
  const nonce = halves(deposit.nonce);
  return {
    pcash_chain_id: fm(mint.pcashChainId),
    recent_pcash_block_hash: fm(mint.recentPcashBlockHash),
    asset_id: fm(mint.assetId),
    account_address: fm(mint.address),
    event_entry: fm(mint.eventOpening.eventEntry),
    vault: fm(vault),
    deposit: {
      depositor_high: depositor.high,
      depositor_low: depositor.low,
      recipient_commitment_high: committed.high,
      recipient_commitment_low: committed.low,
      nonce_high: nonce.high,
      nonce_low: nonce.low,
      amount: fm(deposit.amount),
      log: l1LogGroundingWitnessMap(opening),
    },
    recipient_address: fm(recipient),
    salt: fm(salt),
    note_secret: fm(noteSecret),
    private_value: privateValueMap(mint.transaction),
  };
}
