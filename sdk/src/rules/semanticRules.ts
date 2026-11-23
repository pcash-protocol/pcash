// Readable actions with separate public fees and issuance routes.

import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import type { FieldNumberish } from "../crypto/field.ts";
import { pcashBurnTypedData, type PcashTypedData, type PcashTypedValue } from "../eip712/eip712.ts";
import type { NativeBurn } from "../protocol/fee.ts";
import { type NetworkConfigLike, networkForChain } from "../protocol/network.ts";
import { batchTransferEip712TypeFor, mintEip712TypeFor, withBurnEip712Type } from "./semanticRuleTypes.ts";

export const ASSET_PAYMENT_EIP712_TYPE =
  "PcashAssetPayment(uint256 pcashChainId,uint256 assetId,address recipient,uint256 amount,uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 relayFeeAmount,uint256 relayFeeOwnerCommitment,uint256 accountCreationCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil)";
export const ASSET_PAYMENT_WITH_BURN_EIP712_TYPE = withBurnEip712Type(ASSET_PAYMENT_EIP712_TYPE);

export const ASSET_BURN_EIP712_TYPE =
  "PcashAssetBurn(uint256 pcashChainId,uint256 assetId,uint256 burnAmount,uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 relayFeeAmount,uint256 relayFeeOwnerCommitment,uint256 accountCreationCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil)";
export const ASSET_BURN_WITH_BURN_EIP712_TYPE = withBurnEip712Type(ASSET_BURN_EIP712_TYPE);

export function batchTransferEip712Type(shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId): string {
  return batchTransferEip712TypeFor(privateValueProfile(shape).outputs);
}
export const BATCH_TRANSFER_EIP712_TYPE = batchTransferEip712Type();
export function batchTransferWithBurnEip712Type(shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId): string {
  return withBurnEip712Type(batchTransferEip712Type(shape));
}
export const BATCH_TRANSFER_WITH_BURN_EIP712_TYPE = batchTransferWithBurnEip712Type();

export const CONTRACT_FEE_SPONSORSHIP_EIP712_TYPE =
  "PcashContractInteraction(uint256 pcashChainId,address sponsoredContract,uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 relayFeeAmount,uint256 relayFeeOwnerCommitment,uint256 accountCreationCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil)";
export const CONTRACT_FEE_SPONSORSHIP_WITH_BURN_EIP712_TYPE = withBurnEip712Type(CONTRACT_FEE_SPONSORSHIP_EIP712_TYPE);

/**
 * One signed output declaration; a zero recipient means "not externally
 * directed" — owner change, padding, or padding.
 */
export type { OutputDeclaration } from "./readableRules.ts";
import type { OutputDeclaration } from "./readableRules.ts";

export interface AssetPaymentMessage {
  pcashChainId: FieldNumberish;
  assetId: FieldNumberish;
  recipient: FieldNumberish;
  amount: FieldNumberish;
  openFeeAmount: FieldNumberish;
  issuanceRecipient: FieldNumberish;
  issuanceOwnerCommitment: FieldNumberish;
  relayFeeAmount: FieldNumberish;
  relayFeeOwnerCommitment: FieldNumberish;
  accountCreationCommitment: FieldNumberish;
  transactionContext: FieldNumberish;
  notBefore: FieldNumberish;
  validUntil: FieldNumberish;
}

export interface AssetBurnMessage {
  pcashChainId: FieldNumberish;
  assetId: FieldNumberish;
  burnAmount: FieldNumberish;
  openFeeAmount: FieldNumberish;
  issuanceRecipient: FieldNumberish;
  issuanceOwnerCommitment: FieldNumberish;
  relayFeeAmount: FieldNumberish;
  relayFeeOwnerCommitment: FieldNumberish;
  accountCreationCommitment: FieldNumberish;
  transactionContext: FieldNumberish;
  notBefore: FieldNumberish;
  validUntil: FieldNumberish;
}

export interface BatchTransferMessage {
  pcashChainId: FieldNumberish;
  assetId: FieldNumberish;
  assetBurnAmount: FieldNumberish;
  outputs: readonly OutputDeclaration[];
  openFeeAmount: FieldNumberish;
  issuanceRecipient: FieldNumberish;
  issuanceOwnerCommitment: FieldNumberish;
  relayFeeAmount: FieldNumberish;
  relayFeeOwnerCommitment: FieldNumberish;
  accountCreationCommitment: FieldNumberish;
  transactionContext: FieldNumberish;
  notBefore: FieldNumberish;
  validUntil: FieldNumberish;
}

export interface ContractFeeSponsorshipMessage {
  pcashChainId: FieldNumberish;
  /** The authenticated primary Contract Account this sponsor is paying for. */
  sponsoredContract: FieldNumberish;
  openFeeAmount: FieldNumberish;
  issuanceRecipient: FieldNumberish;
  issuanceOwnerCommitment: FieldNumberish;
  relayFeeAmount: FieldNumberish;
  relayFeeOwnerCommitment: FieldNumberish;
  accountCreationCommitment: FieldNumberish;
  transactionContext: FieldNumberish;
  notBefore: FieldNumberish;
  validUntil: FieldNumberish;
}

/** The out{i}Recipient/Amount/AssetId values of exactly one profile's output slots. */
function outputDeclarationValues(
  outputs: readonly OutputDeclaration[],
  shape: PrivateValueShape,
  mismatch: string,
): Record<string, PcashTypedValue> {
  if (outputs.length !== privateValueProfile(shape).outputs) throw new Error(mismatch);
  return Object.fromEntries(outputs.flatMap((output, i) => [
    [`out${i}Recipient`, output.recipient],
    [`out${i}Amount`, output.amount],
    [`out${i}AssetId`, output.assetId],
  ]));
}

// Each typed-data builder signs the base type with no burn and its `WithBurn`
// variant with one.

export function assetPaymentTypedData(
  network: NetworkConfigLike | undefined,
  message: AssetPaymentMessage,
  burn?: NativeBurn,
): PcashTypedData<"PcashAssetPayment" | "PcashAssetPaymentWithBurn"> {
  return pcashBurnTypedData(
    networkForChain(message.pcashChainId, network),
    ASSET_PAYMENT_EIP712_TYPE,
    ASSET_PAYMENT_WITH_BURN_EIP712_TYPE,
    { ...message },
    burn,
  );
}

export function assetBurnTypedData(
  network: NetworkConfigLike | undefined,
  message: AssetBurnMessage,
  burn?: NativeBurn,
): PcashTypedData<"PcashAssetBurn" | "PcashAssetBurnWithBurn"> {
  return pcashBurnTypedData(
    networkForChain(message.pcashChainId, network),
    ASSET_BURN_EIP712_TYPE,
    ASSET_BURN_WITH_BURN_EIP712_TYPE,
    { ...message },
    burn,
  );
}

export function batchTransferTypedData(
  network: NetworkConfigLike | undefined,
  message: BatchTransferMessage,
  shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId,
  burn?: NativeBurn,
): PcashTypedData<"PcashBatchTransfer" | "PcashBatchTransferWithBurn"> {
  const { outputs, ...fields } = message;
  return pcashBurnTypedData(
    networkForChain(message.pcashChainId, network),
    batchTransferEip712Type(shape),
    batchTransferWithBurnEip712Type(shape),
    {
      ...fields,
      ...outputDeclarationValues(
        outputs,
        shape,
        `a batch transfer declares exactly ${privateValueProfile(shape).outputs} output slots`,
      ),
    },
    burn,
  );
}

export function contractFeeSponsorshipTypedData(
  network: NetworkConfigLike | undefined,
  message: ContractFeeSponsorshipMessage,
  burn?: NativeBurn,
): PcashTypedData<"PcashContractInteraction" | "PcashContractInteractionWithBurn"> {
  return pcashBurnTypedData(
    networkForChain(message.pcashChainId, network),
    CONTRACT_FEE_SPONSORSHIP_EIP712_TYPE,
    CONTRACT_FEE_SPONSORSHIP_WITH_BURN_EIP712_TYPE,
    { ...message },
    burn,
  );
}

export function mintEip712Type(shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId): string {
  return mintEip712TypeFor(privateValueProfile(shape).outputs);
}
export const MINT_EIP712_TYPE = mintEip712Type();
export function mintWithBurnEip712Type(shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId): string {
  return withBurnEip712Type(mintEip712Type(shape));
}
export const MINT_WITH_BURN_EIP712_TYPE = mintWithBurnEip712Type();

export interface MintMessage {
  pcashChainId: FieldNumberish;
  assetId: FieldNumberish;
  /** Every asset output is declared here; only native outputs may be owner change. */
  outputs: readonly OutputDeclaration[];
  openFeeAmount: FieldNumberish;
  issuanceRecipient: FieldNumberish;
  issuanceOwnerCommitment: FieldNumberish;
  relayFeeAmount: FieldNumberish;
  relayFeeOwnerCommitment: FieldNumberish;
  accountCreationCommitment: FieldNumberish;
  transactionContext: FieldNumberish;
  notBefore: FieldNumberish;
  validUntil: FieldNumberish;
}

export function mintTypedData(
  network: NetworkConfigLike | undefined,
  message: MintMessage,
  shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId,
  burn?: NativeBurn,
): PcashTypedData<"PcashMint" | "PcashMintWithBurn"> {
  const { outputs, ...fields } = message;
  return pcashBurnTypedData(
    networkForChain(message.pcashChainId, network),
    mintEip712Type(shape),
    mintWithBurnEip712Type(shape),
    {
      ...fields,
      ...outputDeclarationValues(outputs, shape, "mint declarations must match the selected profile"),
    },
    burn,
  );
}
