// The EIP-712 type strings whose fields depend on a private-value profile's
// output count. The SDK's typed-data builders and the circuit wrapper generator
// (scripts/circuits/profiles.mjs) both read them here, so this module imports
// nothing, generated constants included.

const outputFields = (outputs: number): string =>
  Array.from({ length: outputs }, (_, i) => `address out${i}Recipient,uint256 out${i}Amount,uint256 out${i}AssetId`).join(",");

const AUTHORIZATION_FIELDS =
  ",uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 relayFeeAmount,uint256 relayFeeOwnerCommitment,uint256 accountCreationCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil)";

/**
 * The `WithBurn` variant of a value message type: `<Primary>WithBurn`, with the
 * network fee and the voluntary burn right after the open fee. A message signs
 * the variant exactly when its native burn is positive.
 */
export function withBurnEip712Type(type: string): string {
  const fee = /[(,]uint256 openFeeAmount,/.exec(type);
  const open = type.indexOf("(");
  if (fee === null || open < 0) throw new Error(`${type} has no openFeeAmount field`);
  const end = fee.index + fee[0].length;
  return `${type.slice(0, open)}WithBurn${type.slice(open, end)}uint256 networkFeeAmount,uint256 voluntaryBurnAmount,${type.slice(end)}`;
}

export function batchTransferEip712TypeFor(outputs: number): string {
  return "PcashBatchTransfer(uint256 pcashChainId,uint256 assetId,uint256 assetBurnAmount,"
    + outputFields(outputs) + AUTHORIZATION_FIELDS;
}

export function assetCreationEip712TypeFor(outputs: number): string {
  return "PcashAssetCreation(uint256 pcashChainId,uint256 assetId,uint256 metadataCommitment,uint256 initialSupply,uint256 assetSecretCommitment,"
    + outputFields(outputs) + AUTHORIZATION_FIELDS;
}
