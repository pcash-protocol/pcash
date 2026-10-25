import type { EventOptions } from "../protocol/events.ts";
import type { DesignatedIssuanceOpening } from "../protocol/payout.ts";
import { U32_LIMIT, U64_LIMIT, U160_LIMIT, uintBelow } from "../utils/validate.ts";
import {
  createPcashAuthorizationRequest,
  requirePcashAuthorization,
  requestPcashAuthorization,
  type PcashActionSigner,
  type PcashAuthorizationRequest,
  type VerifiedPcashAuthorization,
} from "../eip712/authorization.ts";
import type { ChonkVkArtifacts } from "../protocol/account.ts";
import { fieldArrayMap, fm, privateValueMap, ruleStatementMap, type WitnessMap } from "../protocol/witness.ts";
import {
  encodeProposedAccountFields,
  encodeUserAccountUpdate,
  type ProposedAccountFields,
  type UserAccountReceiveKeyUpdate,
} from "../protocol/codec.ts";
import {
  accountUpdateTypedData,
} from "../eip712/eip712.ts";
import { type FieldNumberish, toField } from "../crypto/field.ts";
import { nullifierKeyCommitment } from "../protocol/notes.ts";
import { rootFromIndex } from "../crypto/merkle.ts";
import { type NetworkConfigLike, resolveNetworkConfig } from "../protocol/network.ts";
import {
  ML_KEM_768_PUBLIC_KEY_LENGTH,
  ACCOUNT_KIND_USER,
  ACCOUNT_RULE_SET_DEPTH,
  BLOCK_HEADER_TREE_DEPTH,
  STATE_TREE_DEPTH,
} from "../constants/params.ts";
import {
  accountStateCommitment,
  accountRuleEntryCommitment,
  accountUpdateCommitment as deriveAccountUpdateCommitment,
  receiveKeyHash,
} from "../protocol/account.ts";
import {
  accountUpdateActionCommitment,
  authorizationCommitment,
  ruleStatement,
} from "../protocol/statement.ts";
import { ecdsaRuleConfigurationCommitment } from "../rules/referenceRules.ts";
import { vkWitnessMap } from "./witnessMaps.ts";
import { configurationMap, signatureMap } from "../rules/semanticWitnesses.ts";
import { requireLength } from "../utils/validate.ts";
import {
  buildNativeFeePayment,
  type FeePaymentNoteInput,
  type NativeFeePaymentBuild,
} from "./feePayment.ts";
import { TX_KIND_USER_ACCOUNT_UPDATE, type PrivateValueOutputDataOverrides } from "../protocol/codec.ts";
import type { ArenaSender } from "../protocol/sectionDelivery.ts";

function receiveKeyHashFromMaterial(key: Uint8Array, label: string): bigint {
  if (key.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new Error(`${label} must be ${ML_KEM_768_PUBLIC_KEY_LENGTH} bytes`);
  }
  return receiveKeyHash(key);
}

export type CurrentUserAccountReceiveKey =
  | { status: "absent" }
  | { status: "available"; mlKemPublicKey: Uint8Array }
  /** The account's committed receive-key digest (`receiveKeyHash`). */
  | { status: "unavailable"; receiveKeyHash: FieldNumberish };


export interface UserAccountState {
  address: FieldNumberish;
  accountRevision: FieldNumberish;
  ruleSetCommitment: FieldNumberish;
  receiveKey: CurrentUserAccountReceiveKey;
}

export interface ProposedUserAccountState {
  ruleSetCommitment: FieldNumberish;
  receiveKey: UserAccountReceiveKeyUpdate;
}

export interface AccountAdministrationRuleWitness {
  applicationVkHash: FieldNumberish;
  configurationCommitment: FieldNumberish;
  commitmentBlinder: FieldNumberish;
  entryIndex: number;
  siblings: readonly FieldNumberish[];
}

/** The reference admin rule is owner-only: its signer is the account's own address. */
export interface ReadableAccountAdministrationProfile {
  signerAddress: FieldNumberish;
}

/**
 * The recent block's output root and its opening under the block header; the
 * kernel derives the state root between them.
 */
export interface UserAccountUpdateSnapshot {
  stateRootHeaderSiblings: readonly FieldNumberish[];
  outputRoot: FieldNumberish;
  outputRootStateSiblings: readonly FieldNumberish[];
}

/** The fee the account pays from its own native notes; omitted means a zero fee. */
export interface UserAccountUpdateFee {
  openFeeAmount: FieldNumberish;
  privateRelayPayment?: { recipientAddress: FieldNumberish; receiveKey: Uint8Array; amount: FieldNumberish };
  issuanceOwnerCommitment?: FieldNumberish;
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  notBeforeTimestamp?: FieldNumberish;
  inputs: readonly FeePaymentNoteInput[];
  /** Encrypts the change note to the account; without it the change slot carries filler. */
  receiveKey?: Uint8Array;
  dummyInputEntropy?: FieldNumberish;
  dummyOutputEntropy?: readonly FieldNumberish[];
  outputData?: PrivateValueOutputDataOverrides;
  /** A prior build's arena, reused with its output data to rebuild the same fee section. */
  arena?: Uint8Array;
}

export interface BuildUserAccountUpdateParams extends EventOptions {
  network: NetworkConfigLike;
  current: UserAccountState;
  /** The account's nullifier-key root; the kernel derives the commitment and spends the notes. */
  nkRoot: FieldNumberish;
  proposed: ProposedUserAccountState;
  recentPcashBlockHash: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
  /** The carrier context the delivering carrier must have; 0 = any delivery. Default 0. */
  carrierContextHash?: FieldNumberish;
  snapshot: UserAccountUpdateSnapshot;
  fee?: UserAccountUpdateFee;
  /** The account's sender region in the fee section. */
  sender?: ArenaSender;
  rule: AccountAdministrationRuleWitness;
  readableEcdsa?: ReadableAccountAdministrationProfile;
  authorization?: VerifiedPcashAuthorization;
}

export interface UserAccountUpdateBuild {
  /** The private-value words, then the account update commitment. */
  publicInputs: readonly bigint[];
  proposedAccountFields: Uint8Array;
  accountUpdateCommitment: bigint;
  /** The action the installed rule approves: the update bound to its fee payment on this chain. */
  actionCommitment: bigint;
  payment: NativeFeePaymentBuild;
  authorizationRequest?: PcashAuthorizationRequest;
  readableEcdsaWitnessMap?: WitnessMap;
  authorizeReadableEcdsa?: (authorization: VerifiedPcashAuthorization) => {
    witnessMap: WitnessMap;
  };
  buildKernelWitnessMap(authorizationVk: ChonkVkArtifacts): WitnessMap;
  encodeTransaction(proof: Uint8Array): Uint8Array;
}

export function prepareUserAccountUpdate(
  params: BuildUserAccountUpdateParams,
): UserAccountUpdateBuild {
  const network = resolveNetworkConfig(params.network);
  const address = uintBelow(params.current.address, U160_LIMIT, "address");
  const nkRoot = toField(params.nkRoot, "nkRoot");
  const p = nullifierKeyCommitment(nkRoot);
  const currentAccountRevision = uintBelow(params.current.accountRevision, U32_LIMIT, "currentAccountRevision");
  if (currentAccountRevision + 1n >= U32_LIMIT) {
    throw new Error("currentAccountRevision cannot be incremented");
  }
  const newAccountRevision = currentAccountRevision + 1n;
  const currentRuleSetCommitment = toField(params.current.ruleSetCommitment, "currentRuleSetCommitment");
  const newRuleSetCommitment = toField(params.proposed.ruleSetCommitment, "newRuleSetCommitment");
  const recentPcashBlockHash = toField(params.recentPcashBlockHash, "recentPcashBlockHash");
  if (recentPcashBlockHash === 0n) throw new Error("recentPcashBlockHash must be nonzero");
  const validUntilTimestamp = uintBelow(params.validUntilTimestamp, U64_LIMIT, "validUntilTimestamp");
  requireLength(params.snapshot.stateRootHeaderSiblings, BLOCK_HEADER_TREE_DEPTH, "state-root header siblings");
  requireLength(params.snapshot.outputRootStateSiblings, STATE_TREE_DEPTH, "output-root state siblings");
  const currentReceive = params.current.receiveKey.status === "absent"
    ? 0n
    : params.current.receiveKey.status === "available"
      ? receiveKeyHashFromMaterial(params.current.receiveKey.mlKemPublicKey, "current mlKemPublicKey")
      : toField(params.current.receiveKey.receiveKeyHash, "current receiveKeyHash");
  let newReceive: bigint;
  if (params.proposed.receiveKey.operation === "keep") {
    newReceive = currentReceive;
  } else if (params.proposed.receiveKey.operation === "clear") {
    if (currentReceive === 0n) {
      throw new Error("CLEAR is noncanonical when the current receive key is absent; use KEEP");
    }
    newReceive = 0n;
  } else {
    newReceive = receiveKeyHashFromMaterial(params.proposed.receiveKey.mlKemPublicKey, "new mlKemPublicKey");
    if (newReceive === currentReceive) {
      throw new Error("REPLACE is noncanonical when the receive-key hash is unchanged; use KEEP");
    }
  }
  if (params.rule.siblings.length !== ACCOUNT_RULE_SET_DEPTH) {
    throw new Error(`account administration siblings must have length ${ACCOUNT_RULE_SET_DEPTH}`);
  }
  if (!Number.isSafeInteger(params.rule.entryIndex) || params.rule.entryIndex < 0 || params.rule.entryIndex >= 256) {
    throw new Error("account administration entryIndex must be an integer below 256");
  }
  const applicationVkHash = toField(params.rule.applicationVkHash, "applicationVkHash");
  const configurationCommitment = toField(params.rule.configurationCommitment, "configurationCommitment");
  const commitmentBlinder = toField(params.rule.commitmentBlinder, "commitmentBlinder");
  const ruleSiblings = params.rule.siblings.map((value) => toField(value, "accountRuleSibling"));
  const entry = accountRuleEntryCommitment(
    applicationVkHash,
    configurationCommitment,
    commitmentBlinder,
  );
  if (rootFromIndex(entry, params.rule.entryIndex, ruleSiblings) !== currentRuleSetCommitment) {
    throw new Error("account administration rule does not open under currentRuleSetCommitment");
  }

  // The fee payment: the account's own notes, or an all-dummy zero-fee section.
  const fee = params.fee;
  const payment = buildNativeFeePayment({
    transactionType: TX_KIND_USER_ACCOUNT_UPDATE,
    ...(params.sender === undefined ? {} : { sender: params.sender }),
    ...(params.preparedEvent === undefined ? {} : { preparedEvent: params.preparedEvent }),
    ...(params.eventSalt === undefined ? {} : { eventSalt: params.eventSalt }),
    pcashChainId: network.pcashChainId,
    recentPcashBlockHash,
    payer: {
      address,
      nkRoot,
      ...(fee?.receiveKey !== undefined ? { receiveKey: fee.receiveKey } : {}),
    },
    inputs: fee?.inputs ?? [],
    openFeeAmount: fee?.openFeeAmount ?? 0n,
    ...(fee?.privateRelayPayment === undefined ? {} : { privateRelayPayment: fee.privateRelayPayment }),
    issuanceOwnerCommitment: fee?.issuanceOwnerCommitment ?? 0n,
    ...(fee?.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: fee.designatedIssuanceOpening }),
    notBeforeTimestamp: fee?.notBeforeTimestamp ?? 0n,
    validUntilTimestamp,
    ...(params.carrierContextHash === undefined ? {} : { carrierContextHash: params.carrierContextHash }),
    ...(fee?.dummyInputEntropy !== undefined ? { dummyInputEntropy: fee.dummyInputEntropy } : {}),
    ...(fee?.dummyOutputEntropy !== undefined ? { dummyOutputEntropy: fee.dummyOutputEntropy } : {}),
    ...(fee?.outputData !== undefined ? { outputData: fee.outputData } : {}),
    ...(fee?.arena !== undefined ? { arena: fee.arena } : {}),
  });
  const transaction = payment.transaction;

  const currentAccountStateCommitment = accountStateCommitment(
    address,
    p,
    currentRuleSetCommitment,
    ACCOUNT_KIND_USER,
    currentAccountRevision,
    currentReceive,
  );
  const newAccountStateCommitment = accountStateCommitment(
    address,
    p,
    newRuleSetCommitment,
    ACCOUNT_KIND_USER,
    newAccountRevision,
    newReceive,
  );
  const updateCommitment = deriveAccountUpdateCommitment({
    currentAccountStateCommitment,
    newAccountStateCommitment,
  });
  const actionCommitment = accountUpdateActionCommitment(
    network.pcashChainId,
    payment.privateValueCommitment,
    updateCommitment,
  );
  const proposedFields: ProposedAccountFields = {
    address,
    newRuleSetCommitment,
    receiveKey: params.proposed.receiveKey,
  };
  const proposedAccountFields = encodeProposedAccountFields(proposedFields);

  const nativeChangeAmount = payment.change?.amount ?? 0n;

  const updateMessage = {
    pcashChainId: network.pcashChainId,
    account: address,
    currentAccountRevision,
    nullifierKeyCommitment: p,
    currentRuleSetCommitment,
    currentReceiveKeyHash: currentReceive,
    newRuleSetCommitment,
    newReceiveKeyHash: newReceive,
    openFeeAmount: toField(transaction.global.openFeeAmount),
    relayFeeAmount: payment.relayPayment?.amount ?? 0n,
    relayFeeOwnerCommitment: payment.relayPayment?.ownerCommitment ?? 0n,
    transactionContext: payment.transactionContext,
    notBefore: toField(transaction.global.notBeforeTimestamp),
    validUntil: toField(transaction.global.validUntilTimestamp),
  };

  let authorizationRequest: PcashAuthorizationRequest | undefined;
  let authorizeReadableEcdsa: UserAccountUpdateBuild["authorizeReadableEcdsa"];
  if (params.readableEcdsa !== undefined) {
    const signerAddress = uintBelow(params.readableEcdsa.signerAddress, U160_LIMIT, "signerAddress");
    if (signerAddress !== address) {
      throw new Error("the readable administration rule's signer must be the account itself");
    }
    if (ecdsaRuleConfigurationCommitment(network, p) !== configurationCommitment) {
      throw new Error("readable administration configuration does not match the installed rule");
    }
    authorizationRequest = createPcashAuthorizationRequest({
      kind: "account-update",
      authorizingAddress: signerAddress,
      typedData: accountUpdateTypedData(network, updateMessage),
    });
    authorizeReadableEcdsa = (authorization) => {
      const signature = requirePcashAuthorization(authorizationRequest!, authorization);
      const witnessMap: WitnessMap = {
        pcash_chain_id: fm(network.pcashChainId),
        recent_pcash_block_hash: fm(recentPcashBlockHash),
        event_entry: fm(payment.eventOpening.eventEntry),
        configuration: configurationMap(network),
        ...signatureMap(signature),
        relay_fee_amount: fm(payment.relayPayment?.amount ?? 0n),
        relay_fee_owner_commitment: fm(payment.relayPayment?.ownerCommitment ?? 0n),
        current_account_revision: fm(currentAccountRevision),
        nk_root: fm(nkRoot),
        current_rule_set_commitment: fm(currentRuleSetCommitment),
        current_receive_key_hash: fm(currentReceive),
        new_rule_set_commitment: fm(newRuleSetCommitment),
        new_receive_key_hash: fm(newReceive),
        native_change_amount: fm(nativeChangeAmount),
        private_value: privateValueMap(transaction),
      };
      return { witnessMap };
    };
  }

  const statement = ruleStatement(
    authorizationCommitment(address, configurationCommitment),
    actionCommitment,
    recentPcashBlockHash,
    payment.eventOpening.eventEntry,
  );

  const kernelBase = {
    pcash_chain_id: fm(network.pcashChainId),
    recent_pcash_block_hash: fm(recentPcashBlockHash),
    block_header_state_siblings: fieldArrayMap(params.snapshot.stateRootHeaderSiblings),
    output_root: fm(params.snapshot.outputRoot),
    state_output_siblings: fieldArrayMap(params.snapshot.outputRootStateSiblings),
    address: fm(address),
    nk_root: fm(nkRoot),
    current_account_revision: fm(currentAccountRevision),
    current_receive_key_hash: fm(currentReceive),
    new_account_state_commitment: fm(newAccountStateCommitment),
    configuration_commitment: fm(configurationCommitment),
    commitment_blinder: fm(commitmentBlinder),
    account_rule_witness: {
      entry_index: params.rule.entryIndex,
      siblings: fieldArrayMap(ruleSiblings),
    },
    ...payment.kernelWitnessMap(),
  };
  const buildKernelWitnessMap = (authorizationVk: ChonkVkArtifacts): WitnessMap => {
    const authorizationVkMap = vkWitnessMap(
      authorizationVk,
      "account update authorization",
      applicationVkHash,
    );
    return {
      ...kernelBase,
      rule_statement: ruleStatementMap(statement),
      authorization_vk: authorizationVkMap,
    };
  };

  const publicInputs = [...payment.publicInputs, updateCommitment];
  const base: UserAccountUpdateBuild = {
    publicInputs,
    proposedAccountFields,
    accountUpdateCommitment: updateCommitment,
    actionCommitment,
    payment,
    buildKernelWitnessMap,
    encodeTransaction: (proof) => encodeUserAccountUpdate({
      pcashChainId: network.pcashChainId,
      proposedAccountFields: proposedFields,
      accountUpdateCommitment: updateCommitment,
      section: {
        publicInputs: payment.publicInputs,
        proof,
        outputData: payment.outputData,
        arena: payment.arena,
      },
    }),
  };
  if (authorizationRequest !== undefined && authorizeReadableEcdsa !== undefined) {
    const readable = params.authorization === undefined
      ? undefined
      : authorizeReadableEcdsa(params.authorization);
    return {
      ...base,
      authorizationRequest,
      authorizeReadableEcdsa,
      ...(readable === undefined ? {} : {
        readableEcdsaWitnessMap: readable.witnessMap,
      }),
    };
  }
  return base;
}

export async function proveAndEncodeUserAccountUpdate(
  build: UserAccountUpdateBuild,
  authorizationVk: ChonkVkArtifacts,
  proveUpdate: (input: {
    witnessMap: WitnessMap;
    expectedPublicInputs: readonly bigint[];
  }) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const proof = await proveUpdate({
    witnessMap: build.buildKernelWitnessMap(authorizationVk),
    expectedPublicInputs: build.publicInputs,
  });
  return build.encodeTransaction(proof);
}

export async function authorizeUserAccountUpdate(
  build: UserAccountUpdateBuild,
  signer: PcashActionSigner,
): Promise<UserAccountUpdateBuild> {
  if (build.authorizationRequest === undefined || build.authorizeReadableEcdsa === undefined) {
    throw new Error("user account update was not prepared with a readable ECDSA profile");
  }
  const readable = build.authorizeReadableEcdsa(
    await requestPcashAuthorization(signer, build.authorizationRequest),
  );
  return {
    ...build,
    readableEcdsaWitnessMap: readable.witnessMap,
  };
}
