// A deposit mint over a synthetic recent block whose L1 origin tree holds one
// Ethereum block with the vault's `Deposit` log. An ordinary user account, the
// deposit's recipient, approves the mint with its readable mint rule, pays the
// open fee from one native note, and takes the deposited amount. The asset
// carries the standard deny list as its transfer rule, as a reserve-backed
// asset does.

import {
  buildAssetAction,
  openedAssetActionOutput,
  type AssetActionInput,
  type AssetActionOutput,
} from "@pcash/sdk/builders";
import { PRIVATE_VALUE_PROFILES, privateValueProfile } from "@pcash/sdk/constants";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import { authorizePcashRequestWithPrivateKey } from "@pcash/sdk/eip712";
import {
  accountRuleEntryCommitment,
  accountStateCommitment,
  buildAccountRuleSet,
  DEFAULT_NETWORK_CONFIG,
  fullOutputCommitment,
  l1OriginLeaf,
  normalizeL1Logs,
  nullifierKeyCommitment,
  sizeClassFiller,
  type L1LogGrounding,
} from "@pcash/sdk/protocol";
import {
  createDepositMintAsset,
  DEPOSIT_MINT_RULE_CIRCUIT,
  defaultUserAccountRuleSet,
  depositLog,
  depositMintWitness,
  depositReplayId,
  depositSalt,
  ecdsaRuleConfigurationCommitment,
  recipientCommitment,
  senderDenyListTransferRule,
} from "@pcash/sdk/rules";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS } from "./protocolFixtures.ts";
import { deriveTestWallet } from "./testWallet.ts";

export const DEPOSIT_VAULT = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
export const DEPOSITOR = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n;
export const DEPOSIT_AMOUNT = 25_000_000n;
export const DEPOSIT_NONCE = 0x0123456789abcdef0123456789abcdeffedcba9876543210fedcba9876543210n;
const L1_BLOCK = 100n;
const L1_BLOCK_TIMESTAMP = 1_700_000_000n;
const TRANSACTION_INDEX = 5;
const LOG_INDEX = 2;
/** Logs before the deposit in its block, per transaction: transactions 0, 2, 3 and 4, then transaction 5's first two. */
const EARLIER_LOGS: readonly (readonly [transactionIndex: number, count: number])[] = [[0, 3], [2, 2], [3, 1], [4, 1], [5, LOG_INDEX]];

export function depositMintFixture(params: {
  /** The recipient's readable mint rule; the release pin unless given. */
  authorizationVkHash?: bigint;
  validUntilTimestamp?: bigint;
} = {}) {
  const shape = PRIVATE_VALUE_PROFILES.S.shapeId;
  const profile = privateValueProfile(shape);
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const recipient = deriveTestWallet({ mlKem: "deterministic" });
  const { definition, descriptor } = createDepositMintAsset({
    metadata: { name: "Deposit Dollar", symbol: "DUSD", decimals: 6, contentDigest: new Uint8Array(32) },
    vault: DEPOSIT_VAULT,
    transferRule: senderDenyListTransferRule({
      contractAddress: 0xde41n, listId: Uint8Array.from({ length: 32 }, (_, i) => i + 1), maxDelta: 7_200n,
    }),
    startSalt: 0n,
  });
  const assetId = descriptor.assetId;

  const salt = depositSalt(recipient.nkRoot, chainId, DEPOSIT_VAULT, DEPOSIT_NONCE);
  const log = depositLog({
    vault: DEPOSIT_VAULT, depositor: DEPOSITOR, recipientCommitment: recipientCommitment(chainId, assetId, recipient.address, salt),
    nonce: DEPOSIT_NONCE, amount: DEPOSIT_AMOUNT, transactionIndex: TRANSACTION_INDEX, logIndex: LOG_INDEX,
  });
  const earlier = EARLIER_LOGS.flatMap(([transactionIndex, count]) => Array.from({ length: count }, (_, logIndex) => ({
    transactionIndex, logIndex, emitter: 0x1000n + BigInt(transactionIndex), topics: [new Uint8Array(32)], data: new Uint8Array(),
  })));
  // The deposit's index among its block's logs, its leaf index in the block's normalized log tree.
  const logLeafIndex = earlier.length;
  const logs = normalizeL1Logs([...earlier, log]);
  const l1BlockHash = Uint8Array.from({ length: 32 }, (_, i) => 0xb0 + i);
  const l1Origin = new SparseMerkleTree(40);
  l1Origin.setLeaf(0, l1OriginLeaf({ blockNumber: L1_BLOCK, blockHash: l1BlockHash, timestamp: L1_BLOCK_TIMESTAMP,
    logsRoot: logs.root, logCount: logs.logs.length }));

  const mintRule = defaultUserAccountRuleSet({ wallet: recipient, secrets: TEST_DEFAULT_RULE_SECRETS }).mintRule;
  const ruleConfiguration = ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(recipient.nkRoot));
  const rules = buildAccountRuleSet([{ entryIndex: mintRule.entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
    params.authorizationVkHash ?? mintRule.applicationVkHash, ruleConfiguration, mintRule.commitmentBlinder,
  ) }]);
  const accounts = new SparseMerkleTree(40);
  accounts.setLeaf(0, accountStateCommitment(recipient.address, nullifierKeyCommitment(recipient.nkRoot),
    rules.accountRuleSetCommitment, 0n, 1n, 0n));
  const outputs = new SparseMerkleTree(40);
  outputs.setLeaf(0, fullOutputCommitment({ owner: recipient.address, noteSecret: 446n, assetId: 0n, amount: 5n }, 0));
  const recent = syntheticRecentBlockFixture({ outputRoot: outputs.root, outputCount: 1, issuedSoFar: 5n, lagQ: 100n,
    accountStateRoot: accounts.root, accountCount: 1, l1OriginRoot: l1Origin.root, timestamp: L1_BLOCK_TIMESTAMP + 60n });
  const snapshot = {
    recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
    outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
  };
  const opening: L1LogGrounding = {
    l1OriginRoot: l1Origin.root,
    l1OriginRootSiblings: recent.l1OriginRootHeaderSiblings,
    l1BlockNumber: L1_BLOCK,
    l1BlockHash,
    l1BlockTimestamp: L1_BLOCK_TIMESTAMP,
    l1OriginIndex: 0,
    l1OriginSiblings: l1Origin.proof(0).siblings,
    logsRoot: logs.root,
    logCount: logs.logs.length,
    logLeafIndex,
    logSiblings: logs.proof(logLeafIndex),
    transactionIndex: TRANSACTION_INDEX,
    logIndex: LOG_INDEX,
  };

  const noteSecret = 888n;
  const inputSlots: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  inputSlots[0] = { kind: "mint-marker", replayId: depositReplayId(L1_BLOCK, logLeafIndex, salt) };
  inputSlots[1] = { kind: "native", noteSecret: 446n, amount: 5n, leafIndex: 0, siblings: outputs.proof(0).siblings };
  const outputSlots: AssetActionOutput[] = Array.from({ length: profile.outputs }, (_, index) => ({
    kind: "dummy", dummySecret: BigInt(600 + index), amount: 0n, outputData: sizeClassFiller(),
  }));
  outputSlots[0] = openedAssetActionOutput({ kind: "asset", pcashChainId: chainId, assetId, outputIndex: 0, noteSecret,
    amount: DEPOSIT_AMOUNT, recipientAddress: recipient.address, recipientMlKemPublicKey: recipient.mlKemPublicKey!,
    authenticatedRecipient: true });
  const build = buildAssetAction({
    shape, pcashChainId: chainId, snapshot, mint: { descriptor },
    owner: {
      address: recipient.address, nkRoot: recipient.nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n, receiveKeyHash: 0n,
      rule: { configurationCommitment: ruleConfiguration, commitmentBlinder: mintRule.commitmentBlinder,
        entryIndex: mintRule.entryIndex, siblings: rules.membership(mintRule.entryIndex).siblings },
    },
    inputs: inputSlots, outputs: outputSlots, openFeeAmount: 5n, issuanceOwnerCommitment: 0n,
    validUntilTimestamp: params.validUntilTimestamp ?? L1_BLOCK_TIMESTAMP + 1_800n, dummyInputSeed: 902n,
  });
  const prepared = build.prepareOwnerAuthorization({ wallet: recipient });
  const signed = prepared.authorize(authorizePcashRequestWithPrivateKey(recipient.privKey, prepared.request));
  const witnessMap = depositMintWitness({
    mint: build, configuration: { vault: DEPOSIT_VAULT }, log, opening, recipientAddress: recipient.address, salt, noteSecret,
  });
  return { build, definition, descriptor, recipient, salt, log, opening, noteSecret, prepared, signed,
    mintRule: { packageName: DEPOSIT_MINT_RULE_CIRCUIT, witnessMap } };
}
