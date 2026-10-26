import { DEFAULT_EVENT_ENTRY } from "../protocol/events.ts";
// Readable payment and full-transaction signing rules.

import { fm, privateValueMap } from "../protocol/witness.ts";
import { networkForChain } from "../protocol/network.ts";
import {
  requireWalletAuthorization,
  type VerifiedPcashAuthorization,
} from "../eip712/authorization.ts";
import { type FieldNumberish } from "../crypto/field.ts";
import { pcashTypedData, type PcashTypedData } from "../eip712/eip712.ts";
import type { NetworkConfigLike } from "../protocol/network.ts";
import { configurationMap, signatureMap } from "./semanticWitnesses.ts";
import type { PrivateValue } from "../protocol/transaction.ts";
import type { WalletProfile } from "../protocol/types.ts";

export const PAYMENT_EIP712_TYPE =
  "PcashPayment(uint256 pcashChainId,address recipient,uint256 amount,uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 relayFeeAmount,uint256 relayFeeOwnerCommitment,uint256 accountCreationCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil)";

/** The full-transaction fixture's message. It has no relay terms: every real output is a declared output. */
export const TRANSACTION_DETAIL_EIP712_TYPE =
  "PcashTransactionDetail(uint256 pcashChainId,address authorizingAddress,uint256 spentAssetId,uint256 spentAssetAmount,uint256 assetBurnAmount," +
  [0, 1, 2, 3, 4]
    .map(
      (i) =>
        `address out${i}Recipient,uint256 out${i}Amount,uint256 out${i}AssetId`,
    )
    .join(",") +
  ",uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 accountCreationCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil,uint256 privateValueCommitment)";

/** The payment message in display order. All parties are Ethereum addresses. */
export interface PaymentMessage {
  pcashChainId: FieldNumberish;
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

/** One signed output declaration of the full-transaction rule; all-zero = undeclared. */
export interface OutputDeclaration {
  recipient: FieldNumberish;
  amount: FieldNumberish;
  assetId: FieldNumberish;
}

/**
 * EIP-712 typed-data payload for an external signer (eth_signTypedData_v4)
 * displaying the payment message.
 */
export function paymentTypedData(
  network: NetworkConfigLike,
  message: PaymentMessage,
): PcashTypedData<"PcashPayment"> {
  return pcashTypedData(networkForChain(message.pcashChainId, network), PAYMENT_EIP712_TYPE, { ...message });
}

// --- Witness assembly -------------------------------------------------------

export interface PaymentRuleWitnessParams {
  network?: NetworkConfigLike;
  wallet: WalletProfile;
  authorization: VerifiedPcashAuthorization;
  recentPcashBlockHash: FieldNumberish;
  eventEntry?: FieldNumberish;
  nkRoot: FieldNumberish;
  message: PaymentMessage;
  /** Owner change in slot 1, the payment rule's one change slot; zero for none. */
  nativeChangeAmount: FieldNumberish;
  transaction: PrivateValue;
  issuanceNoteSecret: FieldNumberish;
  recipientNoteSecret: FieldNumberish;
}

/** Witness map for the payment rule (account_rule_payment_ecdsa). */
export function buildPaymentRuleWitness(params: PaymentRuleWitnessParams): {
  witnessMap: Record<string, unknown>;
} {
  const network = networkForChain(params.message.pcashChainId, params.network);
  const signature = params.authorization;
  requireWalletAuthorization(params.wallet, signature, "payment");
  const witnessMap = {
    pcash_chain_id: fm(params.message.pcashChainId),
    recent_pcash_block_hash: fm(params.recentPcashBlockHash),
    event_entry: fm(params.eventEntry ?? DEFAULT_EVENT_ENTRY),
    configuration: configurationMap(network),
    nk_root: fm(params.nkRoot),
    recipient: fm(params.message.recipient),
    amount: fm(params.message.amount),
    relay_fee_amount: fm(params.message.relayFeeAmount),
    relay_fee_owner_commitment: fm(params.message.relayFeeOwnerCommitment),
    native_change_amount: fm(params.nativeChangeAmount),
    recipient_note_secret: fm(params.recipientNoteSecret),
    private_value: privateValueMap(params.transaction),
    issuance_recipient: fm(params.message.issuanceRecipient),
    issuance_note_secret: fm(params.issuanceNoteSecret),
    ...signatureMap(signature),
  };
  return { witnessMap };
}
