// The EIP-712 type strings whose fields depend on a private-value profile's
// output count. The SDK's typed-data builders and the circuit wrapper generator
// (scripts/circuits/profiles.mjs) both read them here, so this module imports
// nothing, generated constants included.

const outputFields = (outputs: number): string =>
  Array.from({ length: outputs }, (_, i) => `address out${i}Recipient,uint256 out${i}Amount,uint256 out${i}AssetId`).join(",");

const AUTHORIZATION_FIELDS =
  ",uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 relayFeeAmount,uint256 relayFeeOwnerCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil)";

export function batchTransferEip712TypeFor(outputs: number): string {
  return "PcashBatchTransfer(uint256 pcashChainId,uint256 assetId,uint256 assetBurnAmount,"
    + outputFields(outputs) + AUTHORIZATION_FIELDS;
}

export function assetCreationEip712TypeFor(outputs: number): string {
  return "PcashAssetCreation(uint256 pcashChainId,uint256 assetId,uint256 metadataCommitment,uint256 initialSupply,uint256 assetSecretCommitment,"
    + outputFields(outputs) + AUTHORIZATION_FIELDS;
}
