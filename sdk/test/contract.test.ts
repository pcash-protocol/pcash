// PCASH contract accounts: content-address derivation, body
// encode/decode round trips, and verifyContract accept/reject cases.

import { randomArena } from "../src/protocol/transfer.ts";
import { describe, expect, it } from "vitest";
import { poseidon } from "../src/crypto/poseidon2.ts";
import { CONTRACT_ADDRESS_DOMAIN } from "../src/constants/domainTags.ts";
import {
  BLOCK_HEADER_KEY_STATE_ROOT,
  MERKLE_DEPTH,
  ACCOUNT_KIND_CONTRACT,
  STATE_KEY_OUTPUT_ROOT,
  STATE_KEY_ACCOUNT_STATE_ROOT,
} from "../src/constants/params.ts";
import { VK_LEN, computeCircuitVkHash, accountStateCommitment, receiveKeyHash } from "../src/protocol/account.ts";
import { fullOutputCommitment, nullifierKeyCommitment } from "../src/protocol/notes.ts";
import { rootFromIndex } from "../src/crypto/merkle.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { blockHash, openBlockHeaderKey, openStateKey, stateRoot } from "../src/protocol/block.ts";
import { buildNativeTransfer, type ChonkVkArtifacts } from "../src/builders/index.ts";
import { CONTRACT_MAX_BODY_BYTES, type PrivateValueOutputDataOverrides } from "../src/protocol/codec.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import type { WalletProfile } from "../src/protocol/types.ts";
import {
  buildContractBody,
  buildContractFunctionSet,
  contractAddress,
  decodeContractBody,
  encodeContractBody,
  functionSelector,
  PUBLISHES_NK_ROOT_FALSE,
  PUBLISHES_NK_ROOT_TRUE,
  resolveContractFunction,
  verifyContract,
  verifyContractManifest,
  type ContractFunction,
  type ContractManifest,
} from "../src/protocol/contract.ts";
import {
  buildContractFunctionCall,
  contractFunctionAuthorization,
} from "../src/builders/contractCall.ts";

const chainId = 0x1ff6n;
const fixedOutputData = (): PrivateValueOutputDataOverrides => [
  sizeClassFiller(),
  sizeClassFiller(),
  sizeClassFiller(),
  sizeClassFiller(),
  sizeClassFiller(),
];

/** Two functions at strictly increasing selectors. */
const functions: ContractFunction[] = [
  {
    selector: functionSelector(0),
    applicationVkHash: 0x111n,
    configurationCommitment: 0xaaan,
  },
  {
    selector: functionSelector(4),
    applicationVkHash: 0x222n,
    configurationCommitment: 0xbbbn,
  },
];

const manifest: ContractManifest = {
  schemaVersion: 1,
  contract: "Escrow",
  functions: [
    {
      name: "claim",
      selector: functionSelector(0),
      applicationVkHash: 0x111n,
      arguments: [{ name: "payment", type: "EthereumReceipt", visibility: "private" }],
      configuration: [{ name: "seller", type: "EthereumAddress" }],
    },
    {
      name: "reclaim",
      selector: functionSelector(4),
      applicationVkHash: 0x222n,
      arguments: [{ name: "recipient", type: "PcashAddress", visibility: "public" }],
      configuration: [{ name: "deadline", type: "u64" }],
    },
  ],
};

describe("smart contract address derivation", () => {
  it("commits the nullifier disclosure profile in the address", () => {
    const p = 0x1234n;
    const functionSet = buildContractFunctionSet(functions).functionSetCommitment;
    const privatePreimage = poseidon([
      CONTRACT_ADDRESS_DOMAIN,
      p,
      functionSet,
      0n,
      PUBLISHES_NK_ROOT_FALSE,
    ]);
    const privateAddress = contractAddress(
      p,
      functionSet,
      0n,
      PUBLISHES_NK_ROOT_FALSE,
    );
    const publishedAddress = contractAddress(
      p,
      functionSet,
      0n,
      PUBLISHES_NK_ROOT_TRUE,
    );
    expect(privateAddress).toBe(privatePreimage & ((1n << 160n) - 1n));
    expect(publishedAddress).not.toBe(privateAddress);
  });

  it("rejects unknown nullifier disclosure profiles", () => {
    const functionSet = buildContractFunctionSet(functions).functionSetCommitment;
    expect(() => contractAddress(0x1234n, functionSet, 0n, 2)).toThrow(
      /publishesNkRoot must be 0 or 1/,
    );
  });

  it("binds the same receive-key hash in the address and the account leaf", () => {
    const key = Uint8Array.from({ length: 1184 }, (_, i) => i & 0xff);
    const nullifierKey = { publishesNkRoot: true, nkRoot: 0x99n } as const;
    const keyless = buildContractBody({ nullifierKey, functions });
    const keyed = buildContractBody({ nullifierKey, mlKemPublicKey: key, functions });
    const keyHash = receiveKeyHash(key);
    expect(keyless.receiveKeyHash).toBe(0n);
    expect(keyed.receiveKeyHash).toBe(keyHash);
    expect(keyed.address).toBe(contractAddress(
      keyed.nullifierKeyCommitment,
      keyed.functionSetCommitment,
      keyHash,
      PUBLISHES_NK_ROOT_TRUE,
    ));
    expect(keyed.address).not.toBe(keyless.address);
    expect(keyed.accountStateCommitment).toBe(accountStateCommitment(
      keyed.address,
      keyed.nullifierKeyCommitment,
      keyed.functionSetCommitment,
      ACCOUNT_KIND_CONTRACT,
      1n,
      keyHash,
    ));
  });
});

describe("smart contract function sets", () => {
  it("constructs selector membership openings without exposing user-rule primitives", () => {
    const set = buildContractFunctionSet(functions);

    for (const entry of functions) {
      const opening = set.membership(entry.selector);
      expect(opening.selector).toBe(entry.selector);
      expect(opening.siblings).toHaveLength(8);
      expect(
        rootFromIndex(opening.functionCommitment, opening.selector, opening.siblings),
      ).toBe(set.functionSetCommitment);
    }
  });

  it("rejects duplicate and unregistered selectors", () => {
    expect(() => buildContractFunctionSet([functions[0]!, functions[0]!])).toThrow(
      /duplicate smart contract function selector 0/,
    );
    const set = buildContractFunctionSet(functions);
    expect(() => set.membership(functionSelector(1))).toThrow(/selector 1 is not registered/);
  });
});

describe("smart contract body build / encode / decode", () => {
  it("round-trips every committed function field", () => {
    const build = buildContractBody({
      nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n },
      functions,
    });
    const decoded = decodeContractBody(build.body);
    expect(decoded.functions).toEqual(functions);
    expect(encodeContractBody(decoded)).toEqual(build.body);
    expect(verifyContract(decoded).address).toBe(build.address);
  });

  it("builds a body whose address and account state commitment are the derived content address", () => {
    const build = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n }, functions });
    const p = nullifierKeyCommitment(0x99n);
    expect(build.nullifierKeyCommitment).toBe(p);
    const functionSet = buildContractFunctionSet(functions).functionSetCommitment;
    expect(build.functionSetCommitment).toBe(functionSet);
    expect(build.address).toBe(
      contractAddress(p, functionSet, 0n, PUBLISHES_NK_ROOT_TRUE),
    );
    expect(build.accountStateCommitment).toBe(
      accountStateCommitment(
        build.address,
        p,
        functionSet,
        ACCOUNT_KIND_CONTRACT,
        1n,
        0n,
      ),
    );
  });

  it("uses 65-byte type-3 function entries after the tagged nullifier-key field", () => {
    const build = buildContractBody({ nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 0x1234n }, functions });
    expect(build.body).toHaveLength(35 + 2 * 65);
    expect(build.body[0]).toBe(PUBLISHES_NK_ROOT_FALSE);
    expect(build.body[33]).toBe(0); // receive-key mode: absent
    expect(build.body[34]).toBe(2); // functionCount
    expect(build.body[35]).toBe(0); // first selector
    expect(build.body[35 + 65]).toBe(4); // second selector

    const keyed = buildContractBody({
      nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 0x1234n },
      mlKemPublicKey: new Uint8Array(1184).fill(7),
      functions,
    });
    expect(keyed.body).toHaveLength(35 + 1184 + 2 * 65);
    expect(keyed.body[33]).toBe(1); // receive-key mode: present, then exactly 1,184 key bytes
    expect(keyed.body[34 + 1184]).toBe(2); // functionCount
  });

  it("rejects selector bytes outside their sets when decoding a body", () => {
    const { body } = buildContractBody({ nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 0x1234n }, functions });
    const flag = body.slice();
    flag[0] = 2;
    expect(() => decodeContractBody(flag)).toThrow(/publishesNkRoot must be 0 or 1/);
    const mode = body.slice();
    mode[33] = 2;
    expect(() => decodeContractBody(mode)).toThrow(/receive-key mode must be 0 or 1/);
    const present = body.slice();
    present[33] = 1;
    expect(() => decodeContractBody(present)).toThrow(/unexpected end|trailing/);
  });

  it("round-trips through encode/decode including receive key and nkRoot", () => {
    const key = Uint8Array.from({ length: 1184 }, (_, i) => (i * 7) & 0xff);
    const build = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n }, mlKemPublicKey: key, functions });
    const decoded = decodeContractBody(build.body);
    const verified = verifyContract(decoded);
    expect(verified.nullifierKeyCommitment).toBe(build.nullifierKeyCommitment);
    expect(verified.functionSetCommitment).toBe(build.functionSetCommitment);
    expect(decoded.nullifierKey).toEqual({ publishesNkRoot: true, nkRoot: 0x99n });
    expect(decoded.mlKemPublicKey).toEqual(key);
    expect(decoded.functions).toEqual(functions);
    // Re-encoding the decoded body is byte-identical.
    expect(encodeContractBody(decoded)).toEqual(build.body);
  });

  it("encodes the exact maximum body with both optional fields and 255 functions", () => {
    const key = Uint8Array.from({ length: 1184 }, (_, i) => i & 0xff);
    const maxFunctions: ContractFunction[] = Array.from({ length: 255 }, (_, selector) => ({
      selector: functionSelector(selector),
      applicationVkHash: BigInt(selector + 1),
      configurationCommitment: BigInt(selector + 2),
      commitmentBlinder: BigInt(selector + 3),
    }));
    const build = buildContractBody({
      nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n },
      mlKemPublicKey: key,
      functions: maxFunctions,
    });
    expect(build.body).toHaveLength(CONTRACT_MAX_BODY_BYTES);
    expect(decodeContractBody(build.body).functions).toHaveLength(255);
  });

  it("gives private-root and published-root bodies different identities", () => {
    const nkRoot = 0x99n;
    const p = nullifierKeyCommitment(nkRoot);
    const privateBuild = buildContractBody({
      nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: p },
      functions,
    });
    const publishedBuild = buildContractBody({
      nullifierKey: { publishesNkRoot: true, nkRoot },
      functions,
    });
    expect(privateBuild.nullifierKeyCommitment).toBe(publishedBuild.nullifierKeyCommitment);
    expect(privateBuild.functionSetCommitment).toBe(publishedBuild.functionSetCommitment);
    expect(privateBuild.address).not.toBe(publishedBuild.address);
    expect(privateBuild.accountStateCommitment).not.toBe(publishedBuild.accountStateCommitment);
  });

  it("builds a published zero nkRoot and its commitment-only equivalent", () => {
    const zeroRootP = nullifierKeyCommitment(0n);
    const published = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 0n }, functions });
    const committed = buildContractBody({ nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: zeroRootP }, functions });
    expect(published.nullifierKeyCommitment).toBe(zeroRootP);
    expect(committed.nullifierKeyCommitment).toBe(zeroRootP);
    expect(committed.address).not.toBe(published.address);
  });
});

describe("verifyContract (acceptance rules)", () => {
  it("accepts a well-formed smart contract and returns the derived address + leaf", () => {
    const build = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n }, functions });
    const v = verifyContract(decodeContractBody(build.body));
    expect(v.address).toBe(build.address);
    expect(v.accountStateCommitment).toBe(build.accountStateCommitment);
  });

  it("derives functionSetCommitment from the function list, so it cannot disagree", () => {
    const build = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n }, functions });
    const body = decodeContractBody(build.body);
    // The body never serializes the root, so a disagreeing value is not
    // representable; changing a function changes the derived root instead.
    expect(verifyContract(body).functionSetCommitment).toBe(buildContractFunctionSet(functions).functionSetCommitment);
    const mutated = {
      ...body,
      functions: [{ ...body.functions[0]!, configurationCommitment: 0xdeadn }, body.functions[1]!],
    };
    expect(verifyContract(mutated).functionSetCommitment).not.toBe(verifyContract(body).functionSetCommitment);
  });

  it("rejects non-increasing function selectors", () => {
    const build = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n }, functions });
    const body = decodeContractBody(build.body);
    body.functions = [body.functions[1]!, body.functions[0]!];
    expect(() => verifyContract(body)).toThrow(/strictly increasing/);
  });

  it("derives the commitment from a published nkRoot, so the two cannot disagree", () => {
    const build = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n }, functions });
    const body = decodeContractBody(build.body);
    expect(verifyContract(body).nullifierKeyCommitment).toBe(nullifierKeyCommitment(0x99n));
    const other = { ...body, nullifierKey: { publishesNkRoot: true as const, nkRoot: 0x9an } };
    expect(verifyContract(other).nullifierKeyCommitment).toBe(nullifierKeyCommitment(0x9an));
  });

  it("accepts a published zero nkRoot and its commitment-only equivalent", () => {
    const zeroRootP = nullifierKeyCommitment(0n);
    const build = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n }, functions });
    const withRoot = decodeContractBody(build.body);
    withRoot.nullifierKey = { publishesNkRoot: true, nkRoot: 0n };
    expect(verifyContract(withRoot).nullifierKeyCommitment).toBe(zeroRootP);

    const commitmentOnly = decodeContractBody(
      buildContractBody({
        nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 0x1234n },
        functions,
      }).body,
    );
    commitmentOnly.nullifierKey = { publishesNkRoot: false, nullifierKeyCommitment: zeroRootP };
    expect(verifyContract(commitmentOnly).nullifierKeyCommitment).toBe(zeroRootP);
  });

  it("accepts P == 0, a commitment with no known opening", () => {
    const build = buildContractBody({ nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 0x1234n }, functions });
    const body = decodeContractBody(build.body);
    body.nullifierKey = { publishesNkRoot: false, nullifierKeyCommitment: 0n };
    const verified = verifyContract(body);
    expect(verified.nullifierKeyCommitment).toBe(0n);
    expect(verified.address).not.toBe(build.address);
  });

  it("requires at least one function", () => {
    expect(() => buildContractBody({ nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 0x1234n }, functions: [] })).toThrow(/at least one/);
  });

  it("requires selectors to fit in one unsigned byte", () => {
    expect(() => functionSelector(-1)).toThrow(/0 to 255/);
    expect(() => functionSelector(256)).toThrow(/0 to 255/);
    expect(() => functionSelector(1.5)).toThrow(/0 to 255/);
  });
});

describe("buildContractFunctionCall", () => {
  const nkRoot = 0x99n;
  const contractBuild = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot },
    functions,
  });
  const contract = decodeContractBody(contractBuild.body);
    const inputAmount = 1_000n;
  const noteSecret = 0xabcden;
  const outputIndex = 3;
  const accountIndex = 5;
  const noteTree = new SparseMerkleTree(MERKLE_DEPTH);
  noteTree.setLeaf(
    outputIndex,
    fullOutputCommitment(
      { owner: contractBuild.address, noteSecret, assetId: 0n, amount: inputAmount },
      outputIndex,
    ),
  );
  const noteOpening = noteTree.proof(outputIndex);
  const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountStateTree.setLeaf(accountIndex, contractBuild.accountStateCommitment);
  const accountOpening = accountStateTree.proof(accountIndex);
  const state = {
    outputRoot: noteOpening.root,
    outputCount: 1n,
    issuedSoFar: 0n,
    lagQ: 100n * 10n ** 18n * 2n ** 64n,
    accountStateRoot: accountOpening.root,
    accountCount: 1n,
    nullifierRoot: 0n,
    nullifierCount: 0n,
  };
  const committedStateRoot = stateRoot(state);
  const noteStateOpening = openStateKey(state, STATE_KEY_OUTPUT_ROOT);
  const accountStateOpening = openStateKey(state, STATE_KEY_ACCOUNT_STATE_ROOT);
  const header = {
    parentHash: 1n,
    number: 1n,
    timestamp: 1n,
    transactionResultsRoot: 0n,
    stateRoot: committedStateRoot,
    l1OriginRoot: 1n,
    historyRoot: 1n,
  };
  const headerOpening = openBlockHeaderKey(header, BLOCK_HEADER_KEY_STATE_ROOT);
  const transferParams = {
    chainId,
    recipientAddress: 0x1234567890123456789012345678901234567890n,
    paymentAmount: 600n,
    inputs: [
      { amount: inputAmount, noteSecret, leafIndex: outputIndex, siblings: noteOpening.siblings },
    ],
    outputRoot: noteOpening.root,
    outputRootStateSiblings: noteStateOpening.siblings,
    recentPcashBlockHash: blockHash(header),
    stateRoot: committedStateRoot,
    stateRootHeaderSiblings: headerOpening.siblings,
    accountStateRootStateSiblings: accountStateOpening.siblings,
    openFeeAmount: 10n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 42n,
    validUntilTimestamp: 9_999_999n,
    accountIndex,
    accountStateRoot: accountOpening.root,
    accountSiblings: accountOpening.siblings,
    outputEntropies: [0x11n, 0x12n, 0x13n, 0x14n, 0x15n],
    outputData: fixedOutputData(),
    arena: randomArena(0),

  } as const;

  it("derives the contract identity and matches the low-level transfer adapter", () => {
    const call = buildContractFunctionCall({
      eventSalt: 703n,
      ...transferParams,
      contract,
      selector: functionSelector(0),
    });
    const functionSet = buildContractFunctionSet(contract.functions);
    const membership = functionSet.membership(functionSelector(0));
    const syntheticContractWallet: WalletProfile = {
      pubX: new Uint8Array(32),
      pubY: new Uint8Array(32),
      address: contractBuild.address,
      nkRoot,
    };
    const lowLevel = buildNativeTransfer({
      eventSalt: 703n,
      ...transferParams,
      wallet: syntheticContractWallet,
      accountKind: ACCOUNT_KIND_CONTRACT,
      accountRevision: 1n,
      receiveKeyHash: 0n,
      accountRuleSetCommitment: functionSet.functionSetCommitment,
      accountRule: {
        configurationCommitment: functions[0]!.configurationCommitment,
        commitmentBlinder: 0n,
        entryIndex: functionSelector(0),
        siblings: membership.siblings,
      },
      publicNkRoot: true,
    });

    expect(call.contractAddress).toBe(contractBuild.address);
    expect(call.function).toEqual(functions[0]);
    expect(call.membership).toEqual(membership);
    expect(call.publicInputs).toEqual(lowLevel.publicInputs);
    expect(call.transaction).toEqual(lowLevel.transaction);
    expect(call.privateValueCommitment).toBe(lowLevel.privateValueCommitment);
    expect(call.scenario).toEqual(lowLevel.scenario);
    expect("ruleSetCommitment" in call).toBe(false);
    expect("authDataCommitment" in call).toBe(false);
    expect("accountRuleSetCommitment" in call).toBe(false);
    expect("configurationCommitment" in call).toBe(false);

    const child: ChonkVkArtifacts = {
      vkFields: Array.from({ length: VK_LEN }, (_, i) => `0x${BigInt(i + 1).toString(16)}`),
      vkHash: `0x${computeCircuitVkHash(Array.from({ length: VK_LEN }, (_, i) => BigInt(i + 1))).toString(16)}`,
    };
    expect(call.buildKernelWitnessMap(child)).toEqual(lowLevel.buildKernelWitnessMap(child));
  });

  it("opens the same account leaf and function entry for asset-action kernels", () => {
    const authorization = contractFunctionAuthorization({
      contract, selector: functionSelector(4), accountIndex, accountSiblings: accountOpening.siblings,
    });
    expect(authorization.address).toBe(contractBuild.address);
    expect(authorization.accountKind).toBe(ACCOUNT_KIND_CONTRACT);
    expect(authorization.receiveKeyHash).toBe(0n);
    expect(authorization.rule).toMatchObject({ configurationCommitment: 0xbbbn, commitmentBlinder: 0n, entryIndex: 4 });
    expect(rootFromIndex(accountStateCommitment(
      BigInt(authorization.address),
      nullifierKeyCommitment(authorization.nkRoot),
      authorization.accountRuleSetCommitment,
      ACCOUNT_KIND_CONTRACT,
      authorization.accountRevision,
      0n,
    ), accountIndex, accountOpening.siblings)).toBe(accountOpening.root);
    expect(() => contractFunctionAuthorization({
      contract, selector: functionSelector(1), accountIndex, accountSiblings: accountOpening.siblings,
    })).toThrow(/selector 1 is not registered/);
  });

  it("rejects unknown selectors before building the transfer", () => {
    expect(() =>
      buildContractFunctionCall({
        ...transferParams,
        contract,
        selector: functionSelector(1),
      }),
    ).toThrow(/selector 1 is not registered/);
  });

  it("requires and verifies an explicit nkRoot for a commitment-only body", () => {
    const pOnlyContract = {
      ...contract,
      nullifierKey: {
        publishesNkRoot: false as const,
        nullifierKeyCommitment: contractBuild.nullifierKeyCommitment,
      },
    };
    const privateVerification = verifyContract(pOnlyContract);
    const privateAddress = contractAddress(
      privateVerification.nullifierKeyCommitment,
      privateVerification.functionSetCommitment,
      0n,
      PUBLISHES_NK_ROOT_FALSE,
    );
    const privateAccountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
    privateAccountStateTree.setLeaf(accountIndex, accountStateCommitment(
      privateAddress,
      privateVerification.nullifierKeyCommitment,
      privateVerification.functionSetCommitment,
      ACCOUNT_KIND_CONTRACT,
      1n,
      0n,
    ));
    const privateAccountOpening = privateAccountStateTree.proof(accountIndex);
    const privateNoteTree = new SparseMerkleTree(MERKLE_DEPTH);
    privateNoteTree.setLeaf(
      outputIndex,
      fullOutputCommitment(
        { owner: privateAddress, noteSecret, assetId: 0n, amount: inputAmount },
        outputIndex,
      ),
    );
    const privateNoteOpening = privateNoteTree.proof(outputIndex);
    const privateState = {
      ...state,
      outputRoot: privateNoteOpening.root,
      accountStateRoot: privateAccountOpening.root,
    };
    const privateStateRoot = stateRoot(privateState);
    const privateHeader = { ...header, stateRoot: privateStateRoot };
    const privateTransferParams = {
      ...transferParams,
      inputs: [{ amount: inputAmount, noteSecret, leafIndex: outputIndex, siblings: privateNoteOpening.siblings }],
      outputRoot: privateNoteOpening.root,
      outputRootStateSiblings: openStateKey(privateState, STATE_KEY_OUTPUT_ROOT).siblings,
      accountStateRoot: privateAccountOpening.root,
      accountSiblings: privateAccountOpening.siblings,
      stateRoot: privateStateRoot,
      accountStateRootStateSiblings: openStateKey(privateState, STATE_KEY_ACCOUNT_STATE_ROOT).siblings,
      recentPcashBlockHash: blockHash(privateHeader),
      stateRootHeaderSiblings: openBlockHeaderKey(privateHeader, BLOCK_HEADER_KEY_STATE_ROOT).siblings,
    };
    expect(() =>
      buildContractFunctionCall({
        ...privateTransferParams,
        contract: pOnlyContract,
        selector: functionSelector(0),
      }),
    ).toThrow(/commitment-only smart contract requires nkRoot/);
    expect(() =>
      buildContractFunctionCall({
        ...privateTransferParams,
        contract: pOnlyContract,
        selector: functionSelector(0),
        nkRoot: nkRoot + 1n,
      }),
    ).toThrow(/nkRoot does not bind to its nullifierKeyCommitment/);
    expect(
      buildContractFunctionCall({
        ...privateTransferParams,
        contract: pOnlyContract,
        selector: functionSelector(0),
        nkRoot,
      }).contractAddress,
    ).toBe(privateAddress);
    expect(privateAddress).not.toBe(contractBuild.address);
  });
});

describe("smart contract manifests", () => {
  const body = decodeContractBody(buildContractBody({ nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 0x1234n }, functions }).body);

  it("binds every named function to its selector and implementation", () => {
    const verified = verifyContractManifest(body, manifest);
    expect(verified.contract).toBe("Escrow");
    expect(verified.functions.map((entry) => entry.name)).toEqual(["claim", "reclaim"]);
    expect(resolveContractFunction(verified, "claim").function).toEqual(functions[0]);
    expect(resolveContractFunction(verified, functionSelector(4)).name).toBe("reclaim");
    expect(resolveContractFunction(verified, "claim").arguments?.[0]?.name).toBe("payment");
  });

  it("rejects duplicate names and selectors", () => {
    expect(() =>
      verifyContractManifest(body, {
        ...manifest,
        functions: [manifest.functions[0]!, { ...manifest.functions[1]!, name: "claim" }],
      }),
    ).toThrow(/duplicate function name/);
    expect(() =>
      verifyContractManifest(body, {
        ...manifest,
        functions: [
          manifest.functions[0]!,
          { ...manifest.functions[1]!, selector: functionSelector(0) },
        ],
      }),
    ).toThrow(/duplicate function selector/);
  });

  it("rejects missing, extra, or mismatched functions", () => {
    expect(() =>
      verifyContractManifest(body, { ...manifest, functions: manifest.functions.slice(0, 1) }),
    ).toThrow(/every function exactly once/);
    expect(() =>
      verifyContractManifest(body, {
        ...manifest,
        functions: [
          manifest.functions[0]!,
          { ...manifest.functions[1]!, selector: functionSelector(5) },
        ],
      }),
    ).toThrow(/selector 5 is not in/);
    expect(() =>
      verifyContractManifest(body, {
        ...manifest,
        functions: [
          { ...manifest.functions[0]!, applicationVkHash: 0x999n },
          manifest.functions[1]!,
        ],
      }),
    ).toThrow(/applicationVkHash does not match/);
  });

  it("rejects unknown function resolution", () => {
    const verified = verifyContractManifest(body, manifest);
    expect(() => resolveContractFunction(verified, "cancel")).toThrow(/not in the manifest/);
  });
});
