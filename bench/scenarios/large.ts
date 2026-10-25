import {
  ACCOUNT_KIND_USER,
  MERKLE_DEPTH,
  PRIVATE_VALUE_PROFILES,
  SparseMerkleTree,
  accountStateCommitment,
  authorizePcashRequestWithPrivateKey,
  buildAssetAction,
  buildNativeTransfer,
  defaultUserAccountRuleSet,
  deriveWalletIdentity,
  assetSecretCommitment,
  fullOutputCommitment,
  generateMlKemKeyPair,
  nullifierKeyCommitment,
  openedAssetActionOutput,
  ownerChangeAssetActionOutput,
  standardFungibleAssetId,
} from "@pcash/sdk/browser";
import { CIRCUIT_URLS } from "@pcash/sdk/browser-prover";
import {
  syntheticRecentBlockFixture,
  withSyntheticTransferOpenings,
} from "@pcash/test-support/protocol-fixtures";
import { hexToBytes } from "viem";
import {
  authorizationAccount,
  NO_OP_EVENT_APPLICATION,
  nativeRuleSecrets,
  pcashChainId,
  type PerformanceScenario,
} from "./common.ts";

const L = PRIVATE_VALUE_PROFILES.L;
const CIRCUITS = [
  "account_rule_large_batch_transfer_ecdsa",
  NO_OP_EVENT_APPLICATION,
  "private_value_large_transfer_kernel",
  "private_value_large_hiding_kernel",
] as const;
const RECIPIENTS = L.outputs - 1;
const RECIPIENT_AMOUNT = 1_000n;
const ASSET_NOTES = [10_000n, 10_000n, 10_000n, 10_000n];

const senderPrivateKey = hexToBytes("0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809");

/** One sender with asset notes and 31 recipients with their own receive keys. */
function largeState() {
  const sender = {
    ...deriveWalletIdentity(senderPrivateKey),
    nkRoot: 0x1a1a1an,
    mlKemPublicKey: generateMlKemKeyPair().publicKey,
  };
  const rules = defaultUserAccountRuleSet({ wallet: sender, secrets: nativeRuleSecrets });
  const recipients = Array.from({ length: RECIPIENTS }, (_, index) => {
    const address = 0x1a00000000000000000000000000000000000000n + BigInt(index + 1);
    return { address, receiveKey: generateMlKemKeyPair().publicKey };
  });

  const descriptorFields = {
    metadataCommitment: 0x1a3e7an,
    initialSupply: 1_000_000n,
    assetSecretCommitment: assetSecretCommitment(0x1a155en),
  };
  const assetId = standardFungibleAssetId(descriptorFields);
  const outputTree = new SparseMerkleTree(MERKLE_DEPTH);
  const assetNotes = ASSET_NOTES.map((amount, leafIndex) => {
    const noteSecret = 0x1a0100n + BigInt(leafIndex);
    outputTree.setLeaf(leafIndex, fullOutputCommitment({ owner: sender.address, noteSecret, assetId, amount }, leafIndex));
    return { amount, noteSecret, leafIndex };
  });
  const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountStateTree.setLeaf(0, accountStateCommitment(
    sender.address,
    nullifierKeyCommitment(sender.nkRoot),
    rules.accountRuleSetCommitment,
    ACCOUNT_KIND_USER,
    1n,
    0n,
  ));
  const recent = syntheticRecentBlockFixture({
    outputRoot: outputTree.root,
    outputCount: assetNotes.length,
    accountStateRoot: accountStateTree.root,
    accountCount: 1,
  });
  const rule = rules.largeBatchTransferRule;
  return {
    sender,
    recipients,
    assetId,
    assetNotes,
    outputTree,
    rule,
    owner: authorizationAccount({
      address: sender.address,
      nkRoot: sender.nkRoot,
      accountIndex: 0,
      accountSiblings: accountStateTree.proof(0).siblings,
      accountRuleSetCommitment: rules.accountRuleSetCommitment,
      accountKind: ACCOUNT_KIND_USER,
      configurationCommitment: rule.configurationCommitment,
      commitmentBlinder: rule.commitmentBlinder,
      entryIndex: rule.entryIndex,
      entrySiblings: rule.siblings,
    }),
    snapshot: {
      recentPcashBlockHash: recent.recentPcashBlockHash,
      stateRoot: recent.stateRoot,
      stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
      outputRoot: outputTree.root,
      outputRootStateSiblings: recent.outputRootStateSiblings,
      accountStateRoot: accountStateTree.root,
      accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
    },
  };
}

/**
 * Both L scenarios fold the large batch-transfer rule and the L kernel stack.
 * The reference wallet proves those circuits only natively; the rule needs the
 * 2^20 SRS.
 */
export function largeScenarios(): PerformanceScenario[] {
  let shared: ReturnType<typeof largeState> | undefined;
  const state = () => shared ??= largeState();
  return [
    {
      id: "largeAssetBatchTransfer",
      label: "L asset airdrop",
      description: `One person sends a custom asset from ${ASSET_NOTES.length} notes to ${RECIPIENTS} recipients plus change: all ${L.outputs} output slots of one L action, signed under the large batch-transfer rule.`,
      circuits: CIRCUITS,
      async prepare() {
        const s = state();
        const change = ASSET_NOTES.reduce((sum, amount) => sum + amount, 0n) - RECIPIENT_AMOUNT * BigInt(RECIPIENTS);
        const build = buildAssetAction({
          shape: L.shapeId,
          pcashChainId,
          snapshot: s.snapshot,
          assetId: s.assetId,
          owner: s.owner,
          inputs: [
            ...s.assetNotes.map((note) => ({ kind: "asset" as const, ...note, siblings: s.outputTree.proof(note.leafIndex).siblings })),
            ...Array.from({ length: L.inputs - s.assetNotes.length }, () => ({ kind: "dummy" as const })),
          ],
          outputs: [
            ...s.recipients.map((recipient, outputIndex) => openedAssetActionOutput({
              kind: "asset",
              pcashChainId,
              assetId: s.assetId,
              outputIndex,
              recipientAddress: recipient.address,
              recipientMlKemPublicKey: recipient.receiveKey,
              authenticatedRecipient: true,
              amount: RECIPIENT_AMOUNT,
            })),
            ownerChangeAssetActionOutput({
              kind: "asset",
              pcashChainId,
              assetId: s.assetId,
              amount: change,
              receiveKey: s.sender.mlKemPublicKey,
            }),
          ],
          openFeeAmount: 0n,
          issuanceOwnerCommitment: 0n,
          validUntilTimestamp: 999_999n,
        });
        const prepared = build.prepareOwnerAuthorization({ wallet: s.sender });
        const witness = prepared.authorize(authorizePcashRequestWithPrivateKey(senderPrivateKey, prepared.request));
        return {
          assetId: s.assetId,
          privateValueCommitment: build.privateValueCommitment,
          run: (prover, onStatus) => prover.proveAssetAction({
            operation: "transfer",
            shape: L.shapeId,
            authorization: {
              circuitUrl: CIRCUIT_URLS[prepared.authorizationCircuit],
              witnessMap: witness.witnessMap,
              label: "large batch-transfer authorization",
            },
            buildKernelWitnessMap: build.buildKernelWitnessMap,
            expectedPublicInputs: build.publicInputs,
          }, onStatus),
        };
      },
    },
    {
      id: "largeNativeBatchTransfer",
      label: "L native batch transfer",
      description: `One private note pays ${RECIPIENTS} recipients, change, and the fee in one L action, signed under the large batch-transfer rule.`,
      circuits: CIRCUITS,
      async prepare() {
        const { sender, recipients } = state();
        const [first, ...rest] = recipients;
        const build = buildNativeTransfer(withSyntheticTransferOpenings({
          shape: L.shapeId,
          chainId: pcashChainId,
          wallet: sender,
          authorizationResolver: (request) => authorizePcashRequestWithPrivateKey(senderPrivateKey, request),
          recipientAddress: first!.address,
          recipientReceiveKey: first!.receiveKey,
          additionalOutputs: rest.map((recipient) => ({
            address: recipient.address,
            amount: RECIPIENT_AMOUNT,
            receiveKey: recipient.receiveKey,
          })),
          inputAmount: 100_000n,
          noteSecret: 0x1a0200n,
          paymentAmount: RECIPIENT_AMOUNT,
          openFeeAmount: 10n,
          issuanceOwnerCommitment: 0n,
          dummyInputEntropy: 0x1a0300n,
          validUntilTimestamp: 999_999n,
        }));
        return {
          privateValueCommitment: build.privateValueCommitment,
          run: (prover, onStatus) => prover.proveTransfer({
            shape: build.shape,
            authorizationWitnessMap: build.accountRuleWitnessMap!,
            buildKernelWitnessMap: build.buildKernelWitnessMap,
            expectedPublicInputs: build.publicInputs,
            authorizationCircuitUrl: CIRCUIT_URLS[build.authorizationCircuit],
            authorizationLabel: "large batch-transfer authorization",
          }, onStatus),
        };
      },
    },
  ];
}
