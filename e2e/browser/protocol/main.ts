import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { BROWSER_PROVER_ASSET_SET_ID } from "@pcash/sdk/constants/prover-artifacts";
import { WIRE_PROOF_BYTES, decodeTransaction, privateValuePublicInputs, outputCommitment, DEFAULT_NETWORK_CONFIG } from "@pcash/sdk/protocol";
import { fromHex } from "@pcash/sdk/utils";
import { scanFeed } from "@pcash/sdk/wallet/scanning";
import {
  assetCovenantSuccessorConfigurationCommitment,
  authorizePcashRequestWithPrivateKey,
  buildAssetAction,
  buildNativeTransfer,
  computeCircuitVkHash,
  defaultUserAccountRuleSet,
  deriveWalletIdentity,
  assetSecretCommitment,
  fullOutputCommitment,
  generateMlKemKeyPair,
  MERKLE_DEPTH,
  nullifierKeyCommitment,
  openedAssetActionOutput,
  outOfBandAssetActionOutput,
  accountStateCommitment,
  receiveKeyHash,
  SparseMerkleTree,
  standardFungibleAssetId,
  sizeClassFiller,
} from "@pcash/sdk/browser";
import { buildAssetCovenantRuleWitness } from "@pcash/sdk/fixtures";
import {
  buildContractBody,
  buildContractFunctionSet,
  functionSelector,
} from "@pcash/sdk/protocol";
import {
  syntheticRecentBlockFixture,
  transferFixture,
} from "@pcash/test-support/protocol-fixtures";
import { createBrowserProverSession, normalizeProverThreads } from "@pcash/sdk/browser-prover";
import {
  CIRCUIT_URLS,
  type AssetActionProofRequest,
  type ProofResult,
} from "@pcash/sdk/browser-prover";

const LOCAL_ASSET_SOURCE = {
  assetSetId: BROWSER_PROVER_ASSET_SET_ID,
  baseUrl: new URL("/", window.location.href).href,
};

interface ProbeScenario {
  allDummyOnly?: boolean;
  threads?: number | "auto";
  covenantVkFields: string[];
  largeClaim: { transactionHex: string; receiveSecretKey: string; receivePublicKey: string };
}

interface ProbeResult {
  ok: boolean;
  elapsedMs: number;
  nativeElapsedMs?: number;
  assetElapsedMs?: number;
  assetScenarioElapsedMs?: Record<string, number>;
  proofBytes?: number;
  publicInputs?: number;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  deviceMemoryGiB?: number;
  phases: Array<{ message: string; elapsedMs: number }>;
  error?: string;
}

declare global {
  interface Window {
    __PCASH_ASSET_BROWSER_RESULT__?: ProbeResult;
    __PCASH_ASSET_BROWSER_STATUS__?: string;
  }
}

const resultElement = document.querySelector("#result")!;
const started = performance.now();
const phases: ProbeResult["phases"] = [];
const selector = functionSelector(0);
const pcashChainId = 0x1ff6n;
const covenantMaxNativeFeeAmount = 10n;
const probeProfile = {
  srsPoints: 524_288,
  threads: normalizeProverThreads("auto", navigator.hardwareConcurrency),
};

const nativeRuleSecrets = {
  paymentCommitmentBlinder: 0x202n,
  assetPaymentCommitmentBlinder: 0x204n,
  assetBurnCommitmentBlinder: 0x206n,
  batchTransferCommitmentBlinder: 0x208n,
  largeBatchTransferCommitmentBlinder: 0x131n,
  largeAssetCreationCommitmentBlinder: 0x133n,
  largeContractFeeCommitmentBlinder: 0x135n,
  accountAdminCommitmentBlinder: 0x20an,
  contractFeeCommitmentBlinder: 0x20cn,
  assetCreationCommitmentBlinder: 0x20en,
};

function authorizationAccount(params: {
  address: bigint;
  nkRoot: bigint;
  accountIndex: number;
  accountSiblings: readonly bigint[];
  accountRuleSetCommitment: bigint;
  accountKind: bigint;
  configurationCommitment: bigint;
  commitmentBlinder?: bigint;
  entryIndex: number;
  entrySiblings: readonly bigint[];
}) {
  return {
    address: params.address,
    nkRoot: params.nkRoot,
    accountIndex: params.accountIndex,
    accountSiblings: params.accountSiblings,
    accountRuleSetCommitment: params.accountRuleSetCommitment,
    accountKind: params.accountKind,
    accountRevision: 1n,
    receiveKeyHash: 0n,
    rule: {
      configurationCommitment: params.configurationCommitment,
      commitmentBlinder: params.commitmentBlinder ?? 0n,
      entryIndex: params.entryIndex,
      siblings: params.entrySiblings,
    },
  };
}

async function proveAssetScenario(
  label: string,
  request: AssetActionProofRequest,
): Promise<{ proofBytes: number; publicInputs: number; elapsedMs: number }> {
  const scenarioStarted = performance.now();
  const prover = createBrowserProverSession(probeProfile, LOCAL_ASSET_SOURCE);
  let result: ProofResult;
  try {
    result = await prover.proveAssetAction(request, (status) => {
      const elapsedMs = Math.round(performance.now() - started);
      const message = `${label}: ${status.message}`;
      phases.push({ message, elapsedMs });
      window.__PCASH_ASSET_BROWSER_STATUS__ = message;
      resultElement.textContent = JSON.stringify({ status: message, elapsedMs }, null, 2);
    });
  } finally {
    prover.destroy();
  }
  if (result.proof.length !== WIRE_PROOF_BYTES) {
    throw new Error(`${label} CHONK proof is ${result.proof.length} bytes`);
  }
  return {
    proofBytes: result.proof.length,
    publicInputs: request.expectedPublicInputs.length,
    elapsedMs: Math.round(performance.now() - scenarioStarted),
  };
}

async function run(): Promise<void> {
  const scenarioResponse = await fetch("/scenario.json");
  if (!scenarioResponse.ok) throw new Error("browser probe scenario is missing");
  const scenario = await scenarioResponse.json() as ProbeScenario;
  probeProfile.threads = normalizeProverThreads(scenario.threads ?? "auto", navigator.hardwareConcurrency);
  if (!crossOriginIsolated) throw new Error("browser context is not cross-origin isolated");

  const covenantVkHash = computeCircuitVkHash(scenario.covenantVkFields);
  const successorReceiveKey = generateMlKemKeyPair();
  const successorReceiveKeyHash = receiveKeyHash(successorReceiveKey.publicKey);
  const successorFunctions = [{
    selector,
    applicationVkHash: covenantVkHash,
    configurationCommitment: 0x303n,
  }];
  const successor = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: 0xb0b0b0n },
    mlKemPublicKey: successorReceiveKey.publicKey,
    functions: successorFunctions,
  });
  const covenantConfiguration = assetCovenantSuccessorConfigurationCommitment({
    maxNativeOpenFeeAmount: covenantMaxNativeFeeAmount,
    successorAddress: successor.address,
    successorNullifierKeyCommitment: successor.nullifierKeyCommitment,
    successorRuleSetCommitment: successor.functionSetCommitment,
    successorAccountRevision: 1n,
    successorReceiveKeyHash,
  });
  const ownerNkRoot = 0xa0a0a0n;
  const ownerFunctions = [{
    selector,
    applicationVkHash: covenantVkHash,
    configurationCommitment: covenantConfiguration,
  }];
  const owner = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: ownerNkRoot },
    functions: ownerFunctions,
  });
  const ownerFunction = buildContractFunctionSet(ownerFunctions).membership(selector);

  const nativePrivateKey = Uint8Array.from([
    0, 17, 34, 51, 68, 85, 102, 119,
    136, 153, 170, 187, 204, 221, 238, 255,
    0, 17, 34, 51, 68, 85, 102, 119,
    136, 153, 170, 187, 204, 221, 238, 255,
  ]);
  const nativeIdentity = deriveWalletIdentity(nativePrivateKey);
  const nativeWallet = { ...nativeIdentity, nkRoot: 0x707070n };
  const nativeRules = defaultUserAccountRuleSet({
    wallet: nativeWallet,
    secrets: nativeRuleSecrets,
  });
  const nativeRecipient = 0x1111222233334444555566667777888899990000n;
  const nativeTransfer = buildNativeTransfer(transferFixture({
    chainId: pcashChainId,
    wallet: nativeWallet,
    recipientAddress: nativeRecipient,
    inputAmount: 1_000n,
    paymentAmount: 900n,
    openFeeAmount: 10n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 0x404040n,
    validUntilTimestamp: 999_999n,
    noteSecret: 0x401n,
  }));
  const nativeStarted = performance.now();
  const nativeProver = createBrowserProverSession(probeProfile, LOCAL_ASSET_SOURCE);
  let nativeResult: ProofResult;
  try {
    nativeResult = await nativeProver.proveTransfer({
      authorizationWitnessMap: nativeTransfer.accountRuleWitnessMap!,
      buildKernelWitnessMap: nativeTransfer.buildKernelWitnessMap,
      expectedPublicInputs: nativeTransfer.publicInputs,
    }, (status) => {
      const elapsedMs = Math.round(performance.now() - started);
      phases.push({ message: `native: ${status.message}`, elapsedMs });
      window.__PCASH_ASSET_BROWSER_STATUS__ = `native: ${status.message}`;
    });
  } finally {
    nativeProver.destroy();
  }
  const nativeElapsedMs = Math.round(performance.now() - nativeStarted);
  if (nativeResult.proof.length !== WIRE_PROOF_BYTES) {
    throw new Error(`native CHONK proof is ${nativeResult.proof.length} bytes`);
  }

  const emptyAccounts = new SparseMerkleTree(MERKLE_DEPTH);
  const setupParams = transferFixture({ chainId: pcashChainId, wallet: nativeWallet,
    recipientAddress: nativeWallet.address,
    inputAmount: 1n, paymentAmount: 0n, openFeeAmount: 0n, issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 0x505050n, validUntilTimestamp: 999_999n, noteSecret: 0x501n });
  const setupMining = buildNativeTransfer({ ...setupParams, inputs: [],
    accountStateRoot: emptyAccounts.root, accountSiblings: emptyAccounts.proof(0).siblings,
    ...syntheticRecentBlockFixture({ outputRoot: BigInt(setupParams.outputRoot), outputCount: 1,
      accountStateRoot: emptyAccounts.root, accountCount: 0 }) });
  const setupAuthorization = authorizePcashRequestWithPrivateKey(nativePrivateKey, setupMining.authorizationRequest!);
  const setupProver = createBrowserProverSession(probeProfile, LOCAL_ASSET_SOURCE);
  try {
    const result = await setupProver.proveTransfer({
      authorizationWitnessMap: setupMining.authorizeAccountRule!(setupAuthorization).witnessMap,
      buildKernelWitnessMap: setupMining.buildKernelWitnessMap,
      expectedPublicInputs: setupMining.publicInputs,
    }, (status) => {
      phases.push({ message: `unregistered mining: ${status.message}`, elapsedMs: Math.round(performance.now() - started) });
      window.__PCASH_ASSET_BROWSER_STATUS__ = `unregistered mining: ${status.message}`;
    });
    if (result.proof.length !== WIRE_PROOF_BYTES) {
      throw new Error("unregistered mining proof has incorrect dimensions");
    }
  } finally { setupProver.destroy(); }

  if (scenario.allDummyOnly) {
    window.__PCASH_ASSET_BROWSER_RESULT__ = {
      ok: true, elapsedMs: Math.round(performance.now() - started), nativeElapsedMs,
      proofBytes: WIRE_PROOF_BYTES, publicInputs: setupMining.publicInputs.length,
      crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, phases,
    };
    resultElement.textContent = JSON.stringify(window.__PCASH_ASSET_BROWSER_RESULT__, null, 2);
    return;
  }

  // The entry is a real, natively proved L contract claim. Browser recovery
  // and the following S proof never fetch its L-only authorization stack.
  const large = decodeTransaction(fromHex(scenario.largeClaim.transactionHex));
  if (large.kind !== 0 || large.shape !== PRIVATE_VALUE_PROFILES.L.shapeId) throw new Error("native L fixture has the wrong shape");
  const largeInputs = privateValuePublicInputs(large);
  const largeProfile = PRIVATE_VALUE_PROFILES.L;
  const receiveIdentity = deriveWalletIdentity(new Uint8Array(32).fill(9));
  const receiveWallet = { ...receiveIdentity, nkRoot: 987n,
    mlKemPublicKey: fromHex(scenario.largeClaim.receivePublicKey),
    mlKemSecretKey: fromHex(scenario.largeClaim.receiveSecretKey) };
  const receivedTree = new SparseMerkleTree(MERKLE_DEPTH);
  const feed = large.outputData.map((delivery, slot) => {
    const commitment = outputCommitment(largeInputs[largeProfile.offsets.outputs + slot]!, slot);
    receivedTree.setLeaf(slot, commitment);
    return { kind: 0 as const, shape: large.shape, outputIndex: slot, leafIndex: BigInt(slot),
      outputCommitment: commitment, outputData: delivery };
  });
  const restored = await scanFeed({ chainId: largeInputs[0]!, mlKemSecretKeys: [receiveWallet.mlKemSecretKey],
    owners: [receiveWallet.address], feed });
  const received = restored.recovered[0];
  if (restored.recovered.length !== 1 || received?.outputIndex !== largeProfile.outputs - 1) {
    throw new Error("browser did not recover the last L output slot");
  }
  const receiveRules = defaultUserAccountRuleSet({ wallet: receiveWallet, secrets: nativeRuleSecrets });
  const receiveAccounts = new SparseMerkleTree(MERKLE_DEPTH);
  receiveAccounts.setLeaf(0, accountStateCommitment(receiveWallet.address, nullifierKeyCommitment(receiveWallet.nkRoot),
    receiveRules.accountRuleSetCommitment, 0n, 1n, 0n));
  const recentReceive = syntheticRecentBlockFixture({ outputRoot: receivedTree.root, outputCount: largeProfile.outputs,
    accountStateRoot: receiveAccounts.root, accountCount: 1 });
  const receiveRule = receiveRules.assetPaymentRule;
  const smallSpend = buildAssetAction({
    pcashChainId: largeInputs[0]!, assetId: received.assetId,
    snapshot: { recentPcashBlockHash: recentReceive.recentPcashBlockHash, stateRoot: recentReceive.stateRoot,
      stateRootHeaderSiblings: recentReceive.stateRootHeaderSiblings, outputRoot: receivedTree.root,
      outputRootStateSiblings: recentReceive.outputRootStateSiblings, accountStateRoot: receiveAccounts.root,
      accountStateRootStateSiblings: recentReceive.accountStateRootStateSiblings },
    owner: authorizationAccount({ address: receiveWallet.address, nkRoot: receiveWallet.nkRoot, accountIndex: 0,
      accountSiblings: receiveAccounts.proof(0).siblings, accountRuleSetCommitment: receiveRules.accountRuleSetCommitment,
      accountKind: 0n, configurationCommitment: receiveRule.configurationCommitment,
      commitmentBlinder: receiveRule.commitmentBlinder, entryIndex: receiveRule.entryIndex, entrySiblings: receiveRule.siblings }),
    inputs: Array.from({ length: PRIVATE_VALUE_PROFILES.S.inputs }, (_, slot) => slot === 0
      ? { kind: "asset" as const, amount: received.amount, noteSecret: received.noteSecret,
        leafIndex: Number(received.leafIndex), siblings: receivedTree.proof(Number(received.leafIndex)).siblings }
      : { kind: "dummy" as const }),
    outputs: Array.from({ length: PRIVATE_VALUE_PROFILES.S.outputs }, (_, slot) => slot === 0
      ? openedAssetActionOutput({ kind: "asset", pcashChainId: largeInputs[0]!, assetId: received.assetId, outputIndex: 0,
        amount: received.amount, recipientAddress: successor.address, recipientMlKemPublicKey: successorReceiveKey.publicKey,
        authenticatedRecipient: true })
      : { kind: "dummy" as const, dummySecret: BigInt(slot + 6000), amount: 0n, outputData: sizeClassFiller() }),
    openFeeAmount: 0n, issuanceOwnerCommitment: 0n, validUntilTimestamp: 999_999n,
  });
  const smallAuthorization = smallSpend.prepareOwnerAuthorization({ wallet: receiveWallet,
    network: DEFAULT_NETWORK_CONFIG });
  const signedSmall = smallAuthorization.authorize(authorizePcashRequestWithPrivateKey(receiveWallet.privKey, smallAuthorization.request));
  await proveAssetScenario("S spend of native-proved L late output", {
    operation: "transfer",
    authorization: { circuitUrl: "/prover/account_rule_asset_payment_ecdsa.json", witnessMap: signedSmall.witnessMap, label: "S asset payment" },
    buildKernelWitnessMap: smallSpend.buildKernelWitnessMap, expectedPublicInputs: smallSpend.publicInputs,
  });
  if (performance.getEntriesByType("resource").some(resource => /(?:large|shared_asset_claim).*\.(?:json|vk)/.test(resource.name))) {
    throw new Error("browser recovery fetched a native-only proving artifact");
  }

  const creatorSecret = 0x123456n;
  const totalSupply = 1_200n;
  const assetDescriptorFields = {
    metadataCommitment: 0x909090n,
    initialSupply: totalSupply,
    assetSecretCommitment: assetSecretCommitment(creatorSecret),
  };
  const assetDescriptor = {
    assetId: standardFungibleAssetId(assetDescriptorFields),
    ...assetDescriptorFields,
  };
  const assetId = assetDescriptor.assetId;

  const noteTree = new SparseMerkleTree(MERKLE_DEPTH);
  const assetSecrets = [0x501n, 0x502n, 0x503n, 0x504n] as const;
  assetSecrets.forEach((noteSecret, leafIndex) => {
    noteTree.setLeaf(leafIndex, fullOutputCommitment({
      owner: owner.address,
      noteSecret,
      assetId,
      amount: 300n,
    }, leafIndex));
  });
  const nativeNoteSecret = 0x505n;
  noteTree.setLeaf(4, fullOutputCommitment({
    owner: owner.address,
    noteSecret: nativeNoteSecret,
    assetId: 0n,
    amount: 100n,
  }, 4));
  const fundedAssetSecrets = [0x506n, 0x507n, 0x508n] as const;
  fundedAssetSecrets.forEach((noteSecret, offset) => {
    const leafIndex = 5 + offset;
    noteTree.setLeaf(leafIndex, fullOutputCommitment({
      owner: owner.address,
      noteSecret,
      assetId,
      amount: 300n,
    }, leafIndex));
  });

  const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountStateTree.setLeaf(0, owner.accountStateCommitment);
  accountStateTree.setLeaf(1, successor.accountStateCommitment);
  accountStateTree.setLeaf(2, accountStateCommitment(
    nativeWallet.address,
    nullifierKeyCommitment(nativeWallet.nkRoot),
    nativeRules.accountRuleSetCommitment,
    0n,
    1n,
    0n,
  ));
  const emptyRoot = new SparseMerkleTree(MERKLE_DEPTH).root;
  const recent = syntheticRecentBlockFixture({
    outputRoot: noteTree.root,
    outputCount: 8,
    issuedSoFar: 0n,
    lagQ: 0n,
    accountStateRoot: accountStateTree.root,
    accountCount: 3,
  });
  const snapshot = {
    recentPcashBlockHash: recent.recentPcashBlockHash,
    stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
    outputRoot: noteTree.root,
    outputRootStateSiblings: recent.outputRootStateSiblings,
    accountStateRoot: accountStateTree.root,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
  };
  const covenantOwnerAuthorization = authorizationAccount({
    address: owner.address,
    nkRoot: ownerNkRoot,
    accountIndex: 0,
    accountSiblings: accountStateTree.proof(0).siblings,
    accountRuleSetCommitment: owner.functionSetCommitment,
    accountKind: 1n,
    configurationCommitment: covenantConfiguration,
    entryIndex: selector,
    entrySiblings: ownerFunction.siblings,
  });
  const assetOutputSecrets = [0x601n, 0x602n, 0x603n, 0x604n] as const;
  const assetOutputAmounts = [200n, 200n, 200n, 600n] as const;
  const fundedAssetOutputAmounts = [200n, 200n, 200n, 300n] as const;
  const assetStarted = performance.now();
  const assetScenarioElapsedMs: Record<string, number> = {};

  const creationBuild = buildAssetAction({
    pcashChainId,
    snapshot,
    assetDescriptor,
    owner: authorizationAccount({address:nativeWallet.address,nkRoot:nativeWallet.nkRoot,accountIndex:2,accountSiblings:accountStateTree.proof(2).siblings,accountRuleSetCommitment:nativeRules.accountRuleSetCommitment,accountKind:0n,configurationCommitment:nativeRules.assetCreationRule.configurationCommitment,commitmentBlinder:nativeRules.assetCreationRule.commitmentBlinder,entryIndex:nativeRules.assetCreationRule.entryIndex,entrySiblings:nativeRules.assetCreationRule.siblings}),
    assetSecret: creatorSecret,
    inputs: [
      { kind: "creation-marker" },
      { kind: "dummy" },
      { kind: "dummy" },
      { kind: "dummy" },
    ],
    outputs: [
      openedAssetActionOutput({
        kind: "asset",
        pcashChainId,
        assetId: assetDescriptor.assetId,
        outputIndex: 0,
        recipientAddress: successor.address,
        recipientMlKemPublicKey: successorReceiveKey.publicKey,
        authenticatedRecipient: true,
        noteSecret: 0x610n,
        amount: totalSupply,
      }),
      { kind: "dummy", dummySecret: 0x611n, amount: 0n, outputData: sizeClassFiller() },
      { kind: "dummy", dummySecret: 0x612n, amount: 0n, outputData: sizeClassFiller() },
      { kind: "dummy", dummySecret: 0x613n, amount: 0n, outputData: sizeClassFiller() },
      { kind: "dummy", dummySecret: 0x614n, amount: 0n, outputData: sizeClassFiller() },
    ],
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 999_999n,
  });
  const creationAuthorization = creationBuild.prepareOwnerAuthorization({wallet:nativeWallet});
  const signedCreation = authorizePcashRequestWithPrivateKey(nativePrivateKey,creationAuthorization.request);
  const creationResult = await proveAssetScenario("registered zero-funded creation", {
    operation: "assetCreation",
    authorization: {circuitUrl:CIRCUIT_URLS.account_rule_asset_creation_ecdsa,witnessMap:creationAuthorization.authorize(signedCreation).witnessMap,label:"registered asset creation"},
    buildKernelWitnessMap: creationBuild.buildAssetCreationKernelWitnessMap,
    expectedPublicInputs: creationBuild.publicInputs,
  });
  assetScenarioElapsedMs.markerOnlyCreation = creationResult.elapsedMs;

  const assetOnlyBuild = buildAssetAction({
    pcashChainId,
    snapshot,
    assetId: assetDescriptor.assetId,
    owner: covenantOwnerAuthorization,
    inputs: [
      {
        kind: "asset",
        amount: 300n,
        noteSecret: assetSecrets[0],
        leafIndex: 0,
        siblings: noteTree.proof(0).siblings,
      },
      {
        kind: "asset",
        amount: 300n,
        noteSecret: assetSecrets[1],
        leafIndex: 1,
        siblings: noteTree.proof(1).siblings,
      },
      {
        kind: "asset",
        amount: 300n,
        noteSecret: assetSecrets[2],
        leafIndex: 2,
        siblings: noteTree.proof(2).siblings,
      },
      {
        kind: "asset",
        amount: 300n,
        noteSecret: assetSecrets[3],
        leafIndex: 3,
        siblings: noteTree.proof(3).siblings,
      },
    ],
    outputs: [
      outOfBandAssetActionOutput({ kind: "asset", recipientAddress: successor.address, noteSecret: assetOutputSecrets[0], amount: assetOutputAmounts[0], outputData: sizeClassFiller() }),
      outOfBandAssetActionOutput({ kind: "asset", recipientAddress: successor.address, noteSecret: assetOutputSecrets[1], amount: assetOutputAmounts[1], outputData: sizeClassFiller() }),
      outOfBandAssetActionOutput({ kind: "asset", recipientAddress: successor.address, noteSecret: assetOutputSecrets[2], amount: assetOutputAmounts[2], outputData: sizeClassFiller() }),
      outOfBandAssetActionOutput({ kind: "asset", recipientAddress: successor.address, noteSecret: assetOutputSecrets[3], amount: assetOutputAmounts[3], outputData: sizeClassFiller() }),
      { kind: "dummy", dummySecret: 0x615n, amount: 0n, outputData: sizeClassFiller() },
    ],
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 999_999n,
  });
  const assetOnlyCovenant = buildAssetCovenantRuleWitness({
    build: assetOnlyBuild,
    snapshot,
    pcashChainId,
    maxNativeOpenFeeAmount: covenantMaxNativeFeeAmount,
    successor: {
      address: successor.address,
      nullifierKeyCommitment: successor.nullifierKeyCommitment,
      ruleSetCommitment: successor.functionSetCommitment,
      accountRevision: 1n,
      receiveKeyHash: successorReceiveKeyHash,
      accountIndex: 1,
      accountSiblings: accountStateTree.proof(1).siblings,
    },
    outputs: [
      { assetId: assetOnlyBuild.assetId, amount: assetOutputAmounts[0], noteSecret: assetOutputSecrets[0] },
      { assetId: assetOnlyBuild.assetId, amount: assetOutputAmounts[1], noteSecret: assetOutputSecrets[1] },
      { assetId: assetOnlyBuild.assetId, amount: assetOutputAmounts[2], noteSecret: assetOutputSecrets[2] },
      { assetId: assetOnlyBuild.assetId, amount: assetOutputAmounts[3], noteSecret: assetOutputSecrets[3] },
      null,
    ],
  });
  const assetOnlyResult = await proveAssetScenario("asset-only transfer", {
    operation: "transfer",
    authorization: {
      circuitUrl: "/prover/account_rule_asset_covenant.json",
      witnessMap: assetOnlyCovenant.witnessMap,
      label: "contract asset covenant",
    },
    buildKernelWitnessMap: assetOnlyBuild.buildKernelWitnessMap,
    expectedPublicInputs: assetOnlyBuild.publicInputs,
  });
  assetScenarioElapsedMs.assetOnlyTransfer = assetOnlyResult.elapsedMs;

  const build = buildAssetAction({
    pcashChainId,
    snapshot,
    assetId: assetDescriptor.assetId,
    owner: covenantOwnerAuthorization,
    inputs: [
      {
        kind: "asset" as const,
        amount: 300n,
        noteSecret: fundedAssetSecrets[0],
        leafIndex: 5,
        siblings: noteTree.proof(5).siblings,
      },
      {
        kind: "asset" as const,
        amount: 300n,
        noteSecret: fundedAssetSecrets[1],
        leafIndex: 6,
        siblings: noteTree.proof(6).siblings,
      },
      {
        kind: "asset" as const,
        amount: 300n,
        noteSecret: fundedAssetSecrets[2],
        leafIndex: 7,
        siblings: noteTree.proof(7).siblings,
      },
      {
        kind: "native" as const,
        amount: 100n,
        noteSecret: nativeNoteSecret,
        leafIndex: 4,
        siblings: noteTree.proof(4).siblings,
      },
    ],
    outputs: [
      outOfBandAssetActionOutput({
        kind: "asset",
        recipientAddress: successor.address,
        noteSecret: assetOutputSecrets[0],
        amount: fundedAssetOutputAmounts[0],
        outputData: sizeClassFiller(),
      }),
      outOfBandAssetActionOutput({
        kind: "asset",
        recipientAddress: successor.address,
        noteSecret: assetOutputSecrets[1],
        amount: fundedAssetOutputAmounts[1],
        outputData: sizeClassFiller(),
      }),
      outOfBandAssetActionOutput({
        kind: "asset",
        recipientAddress: successor.address,
        noteSecret: assetOutputSecrets[2],
        amount: fundedAssetOutputAmounts[2],
        outputData: sizeClassFiller(),
      }),
      outOfBandAssetActionOutput({
        kind: "asset",
        recipientAddress: successor.address,
        noteSecret: assetOutputSecrets[3],
        amount: fundedAssetOutputAmounts[3],
        outputData: sizeClassFiller(),
      }),
      outOfBandAssetActionOutput({
        kind: "native",
        recipientAddress: successor.address,
        noteSecret: 0x605n,
        amount: 90n,
        outputData: sizeClassFiller(),
      }),
    ],
    openFeeAmount: 10n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 999_999n,
  });
  const fundedCovenant = buildAssetCovenantRuleWitness({
    build,
    snapshot,
    pcashChainId,
    maxNativeOpenFeeAmount: covenantMaxNativeFeeAmount,
    successor: {
      address: successor.address,
      nullifierKeyCommitment: successor.nullifierKeyCommitment,
      ruleSetCommitment: successor.functionSetCommitment,
      accountRevision: 1n,
      receiveKeyHash: successorReceiveKeyHash,
      accountIndex: 1,
      accountSiblings: accountStateTree.proof(1).siblings,
    },
    outputs: [
      { assetId: build.assetId, amount: fundedAssetOutputAmounts[0], noteSecret: assetOutputSecrets[0] },
      { assetId: build.assetId, amount: fundedAssetOutputAmounts[1], noteSecret: assetOutputSecrets[1] },
      { assetId: build.assetId, amount: fundedAssetOutputAmounts[2], noteSecret: assetOutputSecrets[2] },
      { assetId: build.assetId, amount: fundedAssetOutputAmounts[3], noteSecret: assetOutputSecrets[3] },
      { assetId: 0n, amount: 90n, noteSecret: 0x605n },
    ],
  });

  const request: AssetActionProofRequest = {
    operation: "transfer",
    authorization: {
      circuitUrl: "/prover/account_rule_asset_covenant.json",
      witnessMap: fundedCovenant.witnessMap,
      label: "fee-capable successor covenant",
    },
    buildKernelWitnessMap: build.buildKernelWitnessMap,
    expectedPublicInputs: build.publicInputs,
  };
  const fundedResult = await proveAssetScenario("fee-capable covenant transfer", request);
  assetScenarioElapsedMs.feeCapableCovenantTransfer = fundedResult.elapsedMs;
  const assetElapsedMs = Math.round(performance.now() - assetStarted);
  window.__PCASH_ASSET_BROWSER_RESULT__ = {
    ok: true,
    elapsedMs: Math.round(performance.now() - started),
    nativeElapsedMs,
    assetElapsedMs,
    assetScenarioElapsedMs,
    proofBytes: fundedResult.proofBytes,
    publicInputs: fundedResult.publicInputs,
    crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    ...(typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === "number"
      ? { deviceMemoryGiB: (navigator as Navigator & { deviceMemory: number }).deviceMemory }
      : {}),
    phases,
  };
  resultElement.textContent = JSON.stringify(window.__PCASH_ASSET_BROWSER_RESULT__, null, 2);
}

void run().catch((error) => {
  window.__PCASH_ASSET_BROWSER_RESULT__ = {
    ok: false,
    elapsedMs: Math.round(performance.now() - started),
    crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    phases,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
  resultElement.textContent = JSON.stringify(window.__PCASH_ASSET_BROWSER_RESULT__, null, 2);
});
