import type { AccountCreationAttachment } from "../protocol/codec.ts";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import type { DesignatedIssuanceOpening } from "../protocol/payout.ts";
import {
  BLOCK_HEADER_KEY_STATE_ROOT,
  MERKLE_DEPTH,
  STATE_KEY_ACCOUNT_STATE_ROOT
} from "../constants/params.ts";
import type { FieldNumberish } from "../crypto/field.ts";
import { toField } from "../crypto/field.ts";
import { rootFromIndex } from "../crypto/merkle.ts";
import {
  createStandardFungibleAsset,
  fungibleMetadataCommitment,
  verifyAssetDescriptor,
  type CreatedStandardFungibleAsset,
  type FungibleMetadata,
  type StandardFungibleAssetDescriptor
} from "../protocol/asset.ts";
import { assetDefinitionFromCreated } from "../protocol/assetDefinition.ts";
import { verifyBlockHeaderPath, verifyStatePath } from "../protocol/block.ts";
import {
  verifyContract,
  type ContractBody,
  type VerifiedContractManifest,
} from "../protocol/contract.ts";
import type { ArenaSender } from "../protocol/sectionDelivery.ts";
import { nullifierKeyCommitment } from "../protocol/notes.ts";
import { requireLength } from "../utils/validate.ts";
import { buildAssetAction, type AssetActionBuild } from "./assetAction.ts";
import {
  openedAssetActionOutput,
  outOfBandAssetActionOutput,
  type AssetActionOutput,
  type AssetAccountAuthorization,
  type AssetSnapshot,
} from "./assetOutputs.ts";

export interface CustomDistributionContract {
  body: ContractBody;
  manifest: VerifiedContractManifest;
  assetFunctionName: string;
  accountIndex: number;
  accountSiblings: readonly FieldNumberish[];
  /** Required when the immutable contract does not publish nkRoot. */
  privateNkRoot?: FieldNumberish;
}

export interface ContractInventoryOpening {
  assetId: bigint;
  /** The distribution contract's address. */
  owner: bigint;
  noteSecret: bigint;
  amount: bigint;
  outputIndex: number;
}

export interface FixedSupplyCreationMaterial {
  descriptor: StandardFungibleAssetDescriptor;
  assetSecret: bigint;
  metadata: FungibleMetadata;
  inventoryOpenings: readonly ContractInventoryOpening[];
}

function verifyDistributionContract(
  snapshot: AssetSnapshot,
  contract: CustomDistributionContract,
): { address: bigint } {
  if (!verifyBlockHeaderPath(
    snapshot.recentPcashBlockHash,
    BLOCK_HEADER_KEY_STATE_ROOT,
    snapshot.stateRoot,
    snapshot.stateRootHeaderSiblings,
  )) {
    throw new Error("distribution contract snapshot state root is not authenticated by recentPcashBlockHash");
  }
  if (!verifyStatePath(
    snapshot.stateRoot,
    STATE_KEY_ACCOUNT_STATE_ROOT,
    snapshot.accountStateRoot,
    snapshot.accountStateRootStateSiblings,
  )) {
    throw new Error("distribution contract account root is not authenticated by stateRoot");
  }
  requireLength(contract.accountSiblings, MERKLE_DEPTH, "distribution contract account siblings");
  const verified = verifyContract(contract.body);
  if (rootFromIndex(verified.accountStateCommitment, contract.accountIndex, contract.accountSiblings) !== toField(snapshot.accountStateRoot)) {
    throw new Error("distribution contract is not live under the selected account root");
  }
  const manifestEntry = contract.manifest.functions.find(
    (entry) => entry.name === contract.assetFunctionName,
  );
  if (manifestEntry === undefined) throw new Error("verified contract manifest has no selected asset function");
  if (contract.manifest.functions.length !== contract.body.functions.length) {
    throw new Error("verified manifest does not cover the complete live contract function set");
  }
  for (const entry of contract.manifest.functions) {
    const exactFunction = contract.body.functions.find(
      (fn) => fn.selector === entry.selector
        && toField(fn.applicationVkHash) === entry.applicationVkHash
        && toField(fn.configurationCommitment) === toField(entry.function.configurationCommitment),
    );
    if (exactFunction === undefined) throw new Error("verified manifest does not match the live contract function set");
  }
  if (!contract.body.nullifierKey.publishesNkRoot) {
    if (contract.privateNkRoot === undefined) {
      throw new Error("private distribution contract requires recoverable nkRoot material");
    }
    if (nullifierKeyCommitment(contract.privateNkRoot) !== verified.nullifierKeyCommitment) {
      throw new Error("distribution contract nkRoot does not match its live account");
    }
  }
  return { address: verified.address };
}

export interface BuildFixedSupplyCreationToCustomContractParams {
  shape?: PrivateValueShape;
  pcashChainId: FieldNumberish;
  snapshot: AssetSnapshot;
  asset: CreatedStandardFungibleAsset;
  contract: CustomDistributionContract;
  inventory: readonly { noteSecret: FieldNumberish; amount: bigint; memo?: Uint8Array }[];
  owner: AssetAccountAuthorization;
  nativeInputs?: readonly {
    amount: bigint;
    noteSecret: FieldNumberish;
    leafIndex: number;
    siblings: readonly FieldNumberish[];
  }[];
  nativeOutputs?: readonly AssetActionOutput[];
  dummySecrets: readonly FieldNumberish[];
  openFeeAmount?: bigint;
  issuanceOwnerCommitment?: FieldNumberish;
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  validUntilTimestamp: FieldNumberish;
  notBeforeTimestamp?: FieldNumberish;
  /** The carrier context the delivering carrier must have; 0 = any delivery. Default 0. */
  carrierContextHash?: FieldNumberish;
  accountCreation?: AccountCreationAttachment;
  dummyInputSeed?: FieldNumberish;
  /** The creating wallet's sender region, which also records every inventory opening. */
  sender?: ArenaSender;
  /** A manifest identifies bytes, not spendability or economic behavior. */
  allowIrreversibleCustomContract: true;
  persistCreationMaterial: (material: FixedSupplyCreationMaterial) => Promise<void>;
}

/**
 * Irreversible asset creation to one structurally verified custom contract.
 * The SDK authenticates liveness and persists every opening, but cannot certify
 * that arbitrary contract logic can or will release the inventory.
 */
export async function buildFixedSupplyCreationToCustomContract(
  params: BuildFixedSupplyCreationToCustomContractParams,
): Promise<AssetActionBuild> {
  if (params.allowIrreversibleCustomContract !== true) {
    throw new Error("custom contract asset creation requires allowIrreversibleCustomContract=true");
  }
  const shape = params.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const profile = privateValueProfile(shape);
  verifyAssetDescriptor(params.asset.descriptor);
  if (fungibleMetadataCommitment(params.asset.metadata)
    !== toField(params.asset.descriptor.metadataCommitment)) {
    throw new Error("asset metadata opening does not match the descriptor");
  }
  if (params.inventory.length < 1 || params.inventory.length > profile.outputs) {
    throw new Error(`contract inventory must contain 1..${profile.outputs} asset notes`);
  }
  const nativeInputs = params.nativeInputs ?? [];
  if (nativeInputs.length >= profile.inputs) throw new Error(`asset creation has at most ${profile.inputs - 1} native inputs after its marker`);
  const nativeOutputs = params.nativeOutputs ?? [];
  if (nativeOutputs.some((output) => output.kind !== "native")) {
    throw new Error("distribution nativeOutputs must all be native");
  }
  if ((nativeInputs.length !== 0 || nativeOutputs.length !== 0 || (params.openFeeAmount ?? 0n) !== 0n)
    && params.owner === undefined) {
    throw new Error("native effects of asset creation require owner");
  }
  const paddingCount = profile.outputs - params.inventory.length - nativeOutputs.length;
  if (paddingCount < 0) throw new Error(`contract inventory and native outputs exceed ${profile.outputs} slots`);
  requireLength(params.dummySecrets, paddingCount, "distribution dummy secrets");
  const contract = verifyDistributionContract(params.snapshot, params.contract);
  const assetDefinition = assetDefinitionFromCreated(params.asset);
  const outputs: AssetActionOutput[] = [
    ...params.inventory.map((inventory, outputIndex) => params.contract.body.mlKemPublicKey === undefined
      ? outOfBandAssetActionOutput({
        kind: "asset",
        recipientAddress: contract.address,
        noteSecret: inventory.noteSecret,
        amount: inventory.amount,
      })
      : openedAssetActionOutput({
        kind: "asset",
        pcashChainId: params.pcashChainId,
        assetId: params.asset.descriptor.assetId,
        outputIndex,
        recipientAddress: contract.address,
        recipientMlKemPublicKey: params.contract.body.mlKemPublicKey,
        authenticatedRecipient: true,
        noteSecret: inventory.noteSecret,
        amount: inventory.amount,
        ...(inventory.memo === undefined ? {} : { memo: inventory.memo }),
        assetDefinition,
      })),
    ...nativeOutputs,
    ...params.dummySecrets.map((dummySecret) => ({
      kind: "dummy" as const,
      dummySecret,
      amount: 0n as const,
    })),
  ];
  const build = buildAssetAction({
    shape,
    pcashChainId: params.pcashChainId,
    snapshot: params.snapshot,
    assetDescriptor: params.asset.descriptor,
    assetSecret: params.asset.assetSecret,
    inputs: [
      { kind: "creation-marker" },
      ...nativeInputs.map((input) => ({ kind: "native" as const, ...input })),
      ...Array.from({ length: profile.inputs - 1 - nativeInputs.length }, () => ({ kind: "dummy" as const })),
    ],
    outputs,
    owner: params.owner,
    openFeeAmount: params.openFeeAmount ?? 0n,
    issuanceOwnerCommitment: params.issuanceOwnerCommitment ?? 0n,
    ...(params.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: params.designatedIssuanceOpening }),
    ...(params.notBeforeTimestamp === undefined ? {} : { notBeforeTimestamp: params.notBeforeTimestamp }),
    validUntilTimestamp: params.validUntilTimestamp,
    ...(params.carrierContextHash === undefined ? {} : { carrierContextHash: params.carrierContextHash }),
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    ...(params.dummyInputSeed === undefined ? {} : { dummyInputSeed: params.dummyInputSeed }),
    ...(params.sender === undefined ? {} : { sender: params.sender }),
    assetDefinition,
  });
  const openings = params.inventory.map((inventory, outputIndex) => ({
    assetId: build.assetId,
    owner: contract.address,
    noteSecret: toField(inventory.noteSecret, `inventory[${outputIndex}].noteSecret`),
    amount: inventory.amount,
    outputIndex,
  }));
  await params.persistCreationMaterial({
    descriptor: {
      assetId: build.assetId,
      metadataCommitment: toField(params.asset.descriptor.metadataCommitment, "metadataCommitment"),
      initialSupply: toField(params.asset.descriptor.initialSupply, "initialSupply"),
      assetSecretCommitment: toField(
        params.asset.descriptor.assetSecretCommitment,
        "assetSecretCommitment",
      ),
    },
    assetSecret: toField(params.asset.assetSecret, "assetSecret"),
    metadata: {
      ...params.asset.metadata,
      contentDigest: Uint8Array.from(params.asset.metadata.contentDigest),
    },
    inventoryOpenings: openings,
  });
  return build;
}

export type CreateFixedSupplyCreationToCustomContractParams = Omit<
  BuildFixedSupplyCreationToCustomContractParams,
  "asset"
> & {
  metadata: FungibleMetadata;
  initialSupply: FieldNumberish;
};

/** Generate fresh asset authority, persist it, and return one custom-contract asset creation. */
export async function createFixedSupplyCreationToCustomContract(
  params: CreateFixedSupplyCreationToCustomContractParams,
): Promise<{ asset: CreatedStandardFungibleAsset; build: AssetActionBuild }> {
  const asset = createStandardFungibleAsset({
    metadata: params.metadata,
    initialSupply: params.initialSupply,
  });
  const build = await buildFixedSupplyCreationToCustomContract({ ...params, asset });
  return { asset, build };
}
