import {
  type BuildNativeTransferParams,
  defaultEcdsaRuleSet,
} from "@pcash/sdk/builders";
import {
  authorizePcashRequestWithPrivateKey,
  type PcashAuthorizationResolver,
} from "@pcash/sdk/eip712";
import {
  blockHash,
  type BlockHeaderCommitment,
  openBlockHeaderKey,
  openStateKey,
  type StateCommitment,
  stateRoot,
} from "@pcash/sdk/protocol";
import { type FieldNumberish, toField } from "@pcash/sdk/crypto";
import { fullOutputCommitment, nullifierKeyCommitment } from "@pcash/sdk/protocol";
import {
  BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
  BLOCK_HEADER_KEY_STATE_ROOT,
  MERKLE_DEPTH,
  OUTPUT_DATA_BYTES,
  STATE_KEY_OUTPUT_ROOT,
  STATE_KEY_ACCOUNT_STATE_ROOT,
} from "@pcash/sdk/constants";
import { accountStateCommitment } from "@pcash/sdk/protocol";
import {
  type DefaultUserRuleSecrets,
} from "@pcash/sdk/rules";
import { SparseMerkleTree } from "@pcash/sdk/crypto";

export const TEST_DEFAULT_RULE_SECRETS: DefaultUserRuleSecrets = {
  assetCreationCommitmentBlinder: 0x121n,
  paymentCommitmentBlinder: 0x102n,
  assetPaymentCommitmentBlinder: 0x104n,
  accountAdminCommitmentBlinder: 0x108n,
  assetBurnCommitmentBlinder: 0x106n,
  batchTransferCommitmentBlinder: 0x10en,
  largeBatchTransferCommitmentBlinder: 0x131n,
  largeAssetCreationCommitmentBlinder: 0x133n,
  largeContractFeeCommitmentBlinder: 0x135n,
  contractFeeCommitmentBlinder: 0x10an,
};

const TRANSFER_OUTPUT_DATA_0 = Uint8Array.from({ length: OUTPUT_DATA_BYTES }, (_, index) => index === 0 ? 1 : 7);
const TRANSFER_OUTPUT_DATA_1 = Uint8Array.from({ length: OUTPUT_DATA_BYTES }, (_, index) => index === 0 ? 1 : 8);

function localAuthorizationResolver(wallet: BuildNativeTransferParams["wallet"]):
  | PcashAuthorizationResolver
  | undefined {
  const privateKey = (wallet as { privKey?: Uint8Array }).privKey;
  return privateKey === undefined
    ? undefined
    : (request) => authorizePcashRequestWithPrivateKey(privateKey, request);
}

type SyntheticTransferParams = Omit<
  BuildNativeTransferParams,
  | "inputs"
  | "outputRoot"
  | "outputRootStateSiblings"
  | "accountStateRoot"
  | "accountSiblings"
  | "recentPcashBlockHash"
  | "stateRoot"
  | "stateRootHeaderSiblings"
  | "accountStateRootStateSiblings"
  | "accountRevision"
  | "receiveKeyHash"
> & {
  inputAmount: bigint;
  noteSecret: FieldNumberish;
  outputIndex?: number;
  accountRevision?: FieldNumberish;
  receiveKeyHash?: FieldNumberish;
};

/** Root of the wholly empty depth-40 output-commitment tree. */
export const EMPTY_OUTPUT_ROOT = new SparseMerkleTree(MERKLE_DEPTH).root;

function singleLeafOpening(index: number, leaf: bigint) {
  const tree = new SparseMerkleTree(MERKLE_DEPTH);
  tree.setLeaf(index, leaf);
  return tree.proof(index);
}

interface SyntheticRecentBlockParams {
  outputRoot: FieldNumberish;
  outputCount: number;
  issuedSoFar?: FieldNumberish;
  lagQ?: bigint;
  accountStateRoot: FieldNumberish;
  accountCount: number;
  parentHash?: FieldNumberish;
  blockNumber?: FieldNumberish;
  timestamp?: FieldNumberish;
  /** Supply a real L1 origin root to ground an L1-reading rule. */
  l1OriginRoot?: FieldNumberish;
}

export function syntheticRecentBlockFixture(params: SyntheticRecentBlockParams) {
  const parentHash = toField(params.parentHash ?? 0n, "parentHash");
  const number = toField(params.blockNumber ?? 1n, "blockNumber");
  const timestamp = toField(params.timestamp ?? 1n, "timestamp");
  const state: StateCommitment = {
    outputRoot: params.outputRoot,
    outputCount: params.outputCount,
    issuedSoFar: params.issuedSoFar ?? 0n,
    lagQ: params.lagQ ?? 0n,
    accountStateRoot: params.accountStateRoot,
    accountCount: params.accountCount,
    nullifierRoot: 0n,
    nullifierCount: 0n,
  };
  const committedStateRoot = stateRoot(state);
  const committedL1OriginRoot = toField(
    params.l1OriginRoot ?? EMPTY_OUTPUT_ROOT,
    "l1OriginRoot",
  );
  const outputRootOpening = openStateKey(state, STATE_KEY_OUTPUT_ROOT);
  const accountStateRootOpening = openStateKey(state, STATE_KEY_ACCOUNT_STATE_ROOT);
  const header: BlockHeaderCommitment = {
    parentHash,
    number,
    timestamp,
    transactionResultsRoot: 0n,
    stateRoot: committedStateRoot,
    l1OriginRoot: committedL1OriginRoot,
    historyRoot: EMPTY_OUTPUT_ROOT,
  };
  const headerOpening = openBlockHeaderKey(header, BLOCK_HEADER_KEY_STATE_ROOT);
  const l1OriginRootOpening = openBlockHeaderKey(
    header,
    BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
  );
  return {
    boundary: {
      state: {
        ...state,
        outputRoot: toField(state.outputRoot, "outputRoot"),
        outputCount: BigInt(params.outputCount),
        issuedSoFar: toField(state.issuedSoFar, "issuedSoFar"),
        lagQ: state.lagQ,
        accountStateRoot: toField(state.accountStateRoot, "accountStateRoot"),
        accountCount: BigInt(params.accountCount),
        nullifierRoot: toField(state.nullifierRoot, "nullifierRoot"),
        nullifierCount: toField(state.nullifierCount, "nullifierCount"),
      },
      header: {
        ...header,
        parentHash,
        number,
        timestamp,
        transactionResultsRoot: toField(header.transactionResultsRoot, "transactionResultsRoot"),
        stateRoot: committedStateRoot,
        l1OriginRoot: committedL1OriginRoot,
        historyRoot: EMPTY_OUTPUT_ROOT,
      },
      blockHash: blockHash(header),
    },
    recentPcashBlockHash: blockHash(header),
    stateRoot: committedStateRoot,
    l1OriginRoot: committedL1OriginRoot,
    l1OriginRootHeaderSiblings: l1OriginRootOpening.siblings,
    stateRootHeaderSiblings: headerOpening.siblings,
    outputRootStateSiblings: outputRootOpening.siblings,
    accountStateRootStateSiblings: accountStateRootOpening.siblings,
  };
}

export function syntheticRecentBlockOpenings(params: SyntheticRecentBlockParams) {
  const fixture = syntheticRecentBlockFixture(params);
  return {
    recentPcashBlockHash: fixture.recentPcashBlockHash,
    stateRoot: fixture.stateRoot,
    stateRootHeaderSiblings: fixture.stateRootHeaderSiblings,
    outputRootStateSiblings: fixture.outputRootStateSiblings,
    accountStateRootStateSiblings: fixture.accountStateRootStateSiblings,
  };
}

/** Supply coherent synthetic openings through the production live-opening API. */
export function withSyntheticTransferOpenings(
  params: SyntheticTransferParams,
): BuildNativeTransferParams {
  const outputIndex = params.outputIndex ?? 0;
  const accountIndex = params.accountIndex ?? 0;
  const defaultRuleSecrets = params.defaultRuleSecrets ?? TEST_DEFAULT_RULE_SECRETS;
  const accountRuleSetCommitment =
    params.accountRuleSetCommitment !== undefined
      ? toField(params.accountRuleSetCommitment, "accountRuleSetCommitment")
      : params.ruleSetCommitment !== undefined
        ? toField(params.ruleSetCommitment, "ruleSetCommitment")
        : defaultEcdsaRuleSet({
            wallet: params.wallet,
            secrets: defaultRuleSecrets,
          }).ruleSetCommitment;
  const spentCommitment = fullOutputCommitment(
    {
      owner: params.wallet.address,
      noteSecret: toField(params.noteSecret, "noteSecret"),
      assetId: 0n,
      amount: params.inputAmount,
    },
    outputIndex,
  );
  const accountRevision = params.accountRevision ?? 1n;
  const receiveKeyHash = params.receiveKeyHash ?? 0n;
  const account = accountStateCommitment(
    params.wallet.address,
    nullifierKeyCommitment(params.wallet.nkRoot),
    accountRuleSetCommitment,
    params.accountKind ?? 0n,
    accountRevision,
    receiveKeyHash,
  );
  const outputOpening = singleLeafOpening(outputIndex, spentCommitment);
  const accountOpening = singleLeafOpening(accountIndex, account);
  const recentBlock = syntheticRecentBlockOpenings({
    outputRoot: outputOpening.root,
    outputCount: outputIndex + 1,
    accountStateRoot: accountOpening.root,
    accountCount: accountIndex + 1,
  });
  const { inputAmount, noteSecret, ...rest } = params;
  return {
    ...rest,
    ...(params.ruleSetCommitment === undefined &&
    params.rule === undefined &&
    params.accountRuleSetCommitment === undefined
      ? { defaultRuleSecrets }
      : {}),
    inputs: [
      {
        amount: inputAmount,
        noteSecret,
        outputIndex,
        siblings: outputOpening.siblings,
      },
    ],
    outputRoot: outputOpening.root,
    accountStateRoot: accountOpening.root,
    accountSiblings: accountOpening.siblings,
    accountRevision,
    receiveKeyHash,
    ...recentBlock,
  };
}

/** Synthetic openings plus deterministic output data, confined to tests. */
export function transferFixture(params: SyntheticTransferParams): BuildNativeTransferParams {
  const resolver = localAuthorizationResolver(params.wallet);
  const outputData = params.outputData ?? [];
  return withSyntheticTransferOpenings({
    ...params,
    ...(params.authorization === undefined && params.authorizationResolver === undefined
      && resolver !== undefined
      ? { authorizationResolver: resolver }
      : {}),
    outputData: [
      outputData[0] ?? Uint8Array.from(TRANSFER_OUTPUT_DATA_0),
      outputData[1] ?? Uint8Array.from(TRANSFER_OUTPUT_DATA_1),
      outputData[2],
      outputData[3],
      outputData[4],
    ],
  });
}

/**
 * Openings for a fee payment: one native note owned by `wallet` in an otherwise
 * empty output tree, the wallet's account leaf in an otherwise empty account
 * tree, and a synthetic recent block committing both roots.
 */
export function feePaymentFixture(params: {
  wallet: { address: FieldNumberish; nkRoot: FieldNumberish };
  inputAmount: bigint;
  noteSecret: FieldNumberish;
  outputIndex?: number;
  accountIndex?: number;
  accountRuleSetCommitment: FieldNumberish;
  accountKind?: FieldNumberish;
  accountRevision?: FieldNumberish;
  receiveKeyHash?: FieldNumberish;
}) {
  const outputIndex = params.outputIndex ?? 0;
  const accountIndex = params.accountIndex ?? 0;
  const spentCommitment = fullOutputCommitment(
    {
      owner: params.wallet.address,
      noteSecret: toField(params.noteSecret, "noteSecret"),
      assetId: 0n,
      amount: params.inputAmount,
    },
    outputIndex,
  );
  const account = accountStateCommitment(
    params.wallet.address,
    nullifierKeyCommitment(params.wallet.nkRoot),
    params.accountRuleSetCommitment,
    params.accountKind ?? 0n,
    params.accountRevision ?? 1n,
    params.receiveKeyHash ?? 0n,
  );
  const outputOpening = singleLeafOpening(outputIndex, spentCommitment);
  const accountOpening = singleLeafOpening(accountIndex, account);
  const recentBlock = syntheticRecentBlockOpenings({
    outputRoot: outputOpening.root,
    outputCount: outputIndex + 1,
    accountStateRoot: accountOpening.root,
    accountCount: accountIndex + 1,
  });
  return {
    recentPcashBlockHash: recentBlock.recentPcashBlockHash,
    inputs: [
      {
        noteSecret: params.noteSecret,
        amount: params.inputAmount,
        leafIndex: outputIndex,
        siblings: outputOpening.siblings,
      },
    ],
    snapshot: {
      stateRoot: recentBlock.stateRoot,
      stateRootHeaderSiblings: recentBlock.stateRootHeaderSiblings,
      outputRoot: outputOpening.root,
      outputRootStateSiblings: recentBlock.outputRootStateSiblings,
      accountStateRoot: accountOpening.root,
      accountStateRootStateSiblings: recentBlock.accountStateRootStateSiblings,
    },
    accountIndex,
    accountSiblings: accountOpening.siblings,
  };
}
