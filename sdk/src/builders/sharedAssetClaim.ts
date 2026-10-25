import { REFERENCE_ASSET_CONFIGURATION_DOMAIN } from "../constants/referenceRuleConstants.ts";
import { PRIVATE_VALUE_MAX_OUTPUTS } from "../constants/privateValueProfiles.ts";
import { toAddressField, toField, type FieldNumberish } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { assertAssetAggregate } from "../protocol/asset.ts";
import { compositePrivateValueMap, fieldArrayMap, fm, type WitnessMap } from "../protocol/witness.ts";
import type { AssetActionBuild } from "./assetAction.ts";

export const SHARED_ASSET_CLAIM_CIRCUIT = "account_rule_shared_asset_claim";

// The claim's sub-tags under REFERENCE_ASSET_CONFIGURATION_DOMAIN; the asset covenant uses 3.
const SHARED_ASSET_CLAIM_CONFIGURATION_TAG = 4n;
const SHARED_ASSET_CLAIM_SECRET_TAG = 5n;
const SHARED_ASSET_CLAIM_REPLAY_TAG = 6n;

export interface SharedAssetClaimConfiguration {
  assetId: FieldNumberish;
  recipient: FieldNumberish;
  amount: bigint;
  maximumFee: bigint;
  secretCommitment: FieldNumberish;
}

function claimSecret(secret: FieldNumberish): bigint {
  return toField(secret, "claim secret");
}

export function sharedAssetClaimSecretCommitment(secret: FieldNumberish): bigint {
  return poseidon([REFERENCE_ASSET_CONFIGURATION_DOMAIN, SHARED_ASSET_CLAIM_SECRET_TAG, claimSecret(secret)]);
}

/** Does not include the shape, funding notes, or transaction role. */
export function sharedAssetClaimReplayId(secret: FieldNumberish): bigint {
  return poseidon([REFERENCE_ASSET_CONFIGURATION_DOMAIN, SHARED_ASSET_CLAIM_REPLAY_TAG, claimSecret(secret)]);
}

export function sharedAssetClaimConfigurationCommitment(config: SharedAssetClaimConfiguration): bigint {
  assertAssetAggregate(config.amount, "claim amount");
  const asset = toField(config.assetId);
  const recipient = toAddressField(config.recipient);
  const secret = toField(config.secretCommitment);
  if (asset === 0n || config.amount === 0n) throw new Error("claim asset and amount must be nonzero");
  if (config.maximumFee < 0n || config.maximumFee >= 1n << 128n) throw new Error("claim fee must fit uint128");
  return poseidon([REFERENCE_ASSET_CONFIGURATION_DOMAIN, SHARED_ASSET_CLAIM_CONFIGURATION_TAG, asset, recipient, config.amount, config.maximumFee, secret]);
}

/** One composite authorization for both profiles; it always requires native proving. */
export function buildSharedAssetClaimWitness(params: {
  build: AssetActionBuild;
  configuration: SharedAssetClaimConfiguration;
  claimSecret: FieldNumberish;
  selectedEntryCommitment: FieldNumberish;
  feePaid?: boolean;
  /** Only ASSET positions have openings; native sponsor change and padding are null. */
  outputs: readonly ({ amount: bigint; noteSecret: FieldNumberish } | null)[];
}): WitnessMap {
  const { build, configuration: config } = params;
  if (params.outputs.length !== build.transaction.outputs.length) throw new Error("claim openings must cover the selected profile");
  const pad = PRIVATE_VALUE_MAX_OUTPUTS - params.outputs.length;
  return {
    pcash_chain_id: fm(build.pcashChainId),
    recent_pcash_block_hash: fm(build.recentPcashBlockHash),
    event_entry: fm(build.eventOpening.eventEntry),
    address: fm(build.address),
    shape: build.shape,
    private_value: compositePrivateValueMap(build.transaction, build.shape),
    configuration: {
      asset_id: fm(config.assetId), recipient: fm(config.recipient), amount: fm(config.amount),
      maximum_fee: fm(config.maximumFee), secret_commitment: fm(config.secretCommitment),
    },
    claim_secret: fm(claimSecret(params.claimSecret)),
    selected_entry_commitment: fm(params.selectedEntryCommitment),
    fee_paid: params.feePaid === true,
    output_amounts: fieldArrayMap([...params.outputs.map(output => output?.amount ?? 0n), ...Array<bigint>(pad).fill(0n)]),
    output_note_secrets: fieldArrayMap([...params.outputs.map(output => output?.noteSecret ?? 0n), ...Array<bigint>(pad).fill(0n)]),
  };
}
