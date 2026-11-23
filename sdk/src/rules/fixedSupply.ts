// The standard fixed-supply mint rule: its configuration, the asset it
// creates, and the witness of `mint_rule_fixed_supply`. The asset is minted
// once, in full, by whoever holds the secret behind the configured commitment:
// its one mint marker is keyed by the secret. One VK serves both profiles.

import { FIXED_SUPPLY_RULE_VK_HASH } from "../constants/rulePins.ts";
import { PRIVATE_VALUE_PROFILES } from "../constants/privateValueProfiles.ts";
import { REFERENCE_FIXED_SUPPLY_CONFIGURATION_DOMAIN, REFERENCE_FIXED_SUPPLY_SECRET_DOMAIN } from "../constants/referenceRuleConstants.ts";
import { BN254_SCALAR_MODULUS, toField, type FieldNumberish } from "../crypto/field.ts";
import { domainTag, poseidon } from "../crypto/poseidon2.ts";
import { assertAssetAmount, mintMarker, type AssetDescriptor, type FungibleMetadata } from "../protocol/asset.ts";
import {
  assetDefinitionDescriptor,
  findAssetDefinition,
  type AssetDefinition,
  type PortableMintRule,
  type PortableTransferRule,
} from "../protocol/assetDefinition.ts";
import { SlotClass } from "../protocol/transaction.ts";
import { compositePrivateValueMap, fm, type WitnessMap } from "../protocol/witness.ts";
import { beBytes, bytesToBigInt, concatBytes, field32, randomFieldEntropy } from "../utils/bytes.ts";
import { U128_LIMIT } from "../utils/validate.ts";
import { paddedOutputMap, requireMintRuleConfiguration, type MintWitnessInputs } from "./mintWitness.ts";

export const FIXED_SUPPLY_RULE_CIRCUIT = "mint_rule_fixed_supply";

const SUPPLY_BYTES = 17;
/** The configuration opening: the supply (17 bytes) and the secret commitment (32 bytes). */
export const FIXED_SUPPLY_CONFIGURATION_BYTES = SUPPLY_BYTES + 32;
/** The largest fixed supply one mint can carry: every profile L output maximal. */
export const MAX_FIXED_SUPPLY = BigInt(PRIVATE_VALUE_PROFILES.L.outputs) * (U128_LIMIT - 1n);
/**
 * Domain of the salt search seed derived from a fixed-supply asset's secret.
 * Wallet-local: no circuit computes it.
 */
const INSTANCE_SALT_SEED_DOMAIN = domainTag("wallet.instance_salt_seed");

export interface FixedSupplyConfiguration {
  supply: bigint;
  secretCommitment: bigint;
}

function checkedSupply(supply: bigint): bigint {
  if (supply < 0n || supply > MAX_FIXED_SUPPLY) throw new Error("supply exceeds what one mint can carry");
  return supply;
}

export function fixedSupplySecretCommitment(secret: FieldNumberish): bigint {
  return poseidon([REFERENCE_FIXED_SUPPLY_SECRET_DOMAIN, toField(secret, "secret")]);
}

export function fixedSupplyConfigurationCommitment(configuration: FixedSupplyConfiguration): bigint {
  return poseidon([
    REFERENCE_FIXED_SUPPLY_CONFIGURATION_DOMAIN,
    checkedSupply(configuration.supply),
    toField(configuration.secretCommitment, "secretCommitment"),
  ]);
}

export function encodeFixedSupplyConfiguration(configuration: FixedSupplyConfiguration): Uint8Array {
  return concatBytes(beBytes(checkedSupply(configuration.supply), SUPPLY_BYTES), field32(configuration.secretCommitment));
}

/** The configuration a canonical opening encodes, or undefined. */
export function decodeFixedSupplyConfiguration(bytes: Uint8Array): FixedSupplyConfiguration | undefined {
  if (bytes.length !== FIXED_SUPPLY_CONFIGURATION_BYTES) return undefined;
  const supply = bytesToBigInt(bytes.subarray(0, SUPPLY_BYTES));
  const secretCommitment = bytesToBigInt(bytes.subarray(SUPPLY_BYTES));
  if (supply > MAX_FIXED_SUPPLY || secretCommitment >= BN254_SCALAR_MODULUS) return undefined;
  return { supply, secretCommitment };
}

/** The mint rule of an asset minted once, in full, under `configuration`. */
export function fixedSupplyMintRule(configuration: FixedSupplyConfiguration): PortableMintRule {
  return {
    sVkHash: FIXED_SUPPLY_RULE_VK_HASH,
    lVkHash: FIXED_SUPPLY_RULE_VK_HASH,
    configurationCommitment: fixedSupplyConfigurationCommitment(configuration),
    configuration: encodeFixedSupplyConfiguration(configuration),
  };
}

/** A fixed-supply asset and the secret that mints it. */
export interface CreatedFixedSupplyAsset {
  definition: AssetDefinition;
  descriptor: AssetDescriptor;
  secret: bigint;
}

/**
 * Deterministic construction for vectors, recovery, and reproducible
 * derivation. A one-way hash of the secret seeds the salt search, so the same
 * secret derives the same asset and the published salt does not reveal it.
 */
export function deriveFixedSupplyAsset(args: {
  metadata: FungibleMetadata;
  supply: bigint;
  secret: FieldNumberish;
  instanceSalt?: FieldNumberish;
  transferRule?: PortableTransferRule;
}): CreatedFixedSupplyAsset {
  const secret = toField(args.secret, "secret");
  const definition = findAssetDefinition({
    mintRule: fixedSupplyMintRule({ supply: args.supply, secretCommitment: fixedSupplySecretCommitment(secret) }),
    ...(args.transferRule === undefined ? {} : { transferRule: args.transferRule }),
    metadata: args.metadata,
  }, args.instanceSalt ?? poseidon([INSTANCE_SALT_SEED_DOMAIN, secret]));
  return { definition, descriptor: assetDefinitionDescriptor(definition), secret };
}

/** Create a fresh fixed-supply asset and the secret that mints it, with CSPRNG entropy. */
export function createFixedSupplyAsset(args: {
  metadata: FungibleMetadata;
  supply: bigint;
  transferRule?: PortableTransferRule;
}): CreatedFixedSupplyAsset {
  return deriveFixedSupplyAsset({ ...args, secret: randomFieldEntropy() });
}

/**
 * The witness of `mint_rule_fixed_supply`. The mint carries exactly one mint
 * marker, whose replay ID is the secret, and its asset outputs total the supply.
 */
export function fixedSupplyMintWitness(params: {
  mint: MintWitnessInputs;
  configuration: FixedSupplyConfiguration;
  secret: FieldNumberish;
}): WitnessMap {
  const { mint, configuration } = params;
  requireMintRuleConfiguration(mint, fixedSupplyConfigurationCommitment(configuration));
  const secret = toField(params.secret, "secret");
  if (fixedSupplySecretCommitment(secret) !== toField(configuration.secretCommitment, "secretCommitment")) {
    throw new Error("the secret does not open the asset's secret commitment");
  }
  const marker = mintMarker(mint.assetId, secret);
  const markers = mint.transaction.inputs.filter((input) => input.slotClass === SlotClass.MINT);
  if (markers.length !== 1 || markers[0]!.nullifier !== marker) {
    throw new Error("a fixed-supply mint carries exactly one mint marker, keyed by its secret");
  }
  let total = 0n;
  mint.transaction.outputs.forEach((output, slot) => {
    if (output.slotClass !== SlotClass.ASSET) return;
    assertAssetAmount(mint.outputAmounts[slot]!, `outputs[${slot}].amount`);
    total += mint.outputAmounts[slot]!;
  });
  if (total !== configuration.supply) throw new Error("a fixed-supply mint's asset outputs must total its supply");
  return {
    pcash_chain_id: fm(mint.pcashChainId),
    recent_pcash_block_hash: fm(mint.recentPcashBlockHash),
    asset_id: fm(mint.assetId),
    account_address: fm(mint.address),
    event_entry: fm(mint.eventOpening.eventEntry),
    configuration: {
      supply: fm(configuration.supply),
      secret_commitment: fm(configuration.secretCommitment),
    },
    secret: fm(secret),
    shape: mint.shape,
    private_value: compositePrivateValueMap(mint.transaction, mint.shape),
    ...paddedOutputMap(mint),
  };
}
