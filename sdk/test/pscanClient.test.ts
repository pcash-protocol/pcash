// createPscanClient request/response shaping (offline) via an injected fetch.
// Verifies the `pscan_*` method names, the envelope wire form, strict result
// parsing against genuinely verifiable contract payloads, and the
// verification-summary diagnosis without a live listener.

import { describe, expect, it } from "vitest";
import {
  type CurrentBoundaryEnvelopeRpc,
  computeBlockHash,
  computeStateRoot,
  type PcashBlockHeader,
  type StateComponents,
} from "../src/protocol/boundary.ts";
import {
  blockHeaderTree,
  transactionResultsRoot,
  stateTree,
} from "../src/protocol/block.ts";
import { BLOCK_HEADER_KEY_STATE_ROOT, STATE_KEY_ACCOUNT_STATE_ROOT } from "../src/constants/params.ts";
import { buildContractBody, functionSelector } from "../src/protocol/contract.ts";
import { WIRE_PROOF_BYTES, encodeContractAccountCreation, type ContractFundingMode } from "../src/protocol/codec.ts";
import { deliveryCommitment } from "../src/protocol/transfer.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { ENVELOPE_VERSION } from "../src/protocol/envelope.ts";
import { OUTPUT_DATA_BYTES } from "../src/constants/params.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import {
  createPscanClient,
  type ContractConfigurationOpeningSubmission,
  type SubmittedSourceEnvelope,
} from "../src/clients/pscanClient.ts";
import { rpcFetch, rpcResult } from "./rpcFetch.ts";
import { PcashNodeClient } from "../src/clients/nodeClient.ts";

interface Captured {
  url: string;
  body: { jsonrpc: string; id: number; method: string; params: unknown[] };
}

/** A transport that answers every call from a scripted queue. */
/** The fee section carried by sponsored contract creation. */
function contractCreationSection() {
  const item = new Uint8Array(OUTPUT_DATA_BYTES);
  item[0] = ENVELOPE_VERSION;
  const outputData = [item, item, item, item, item] as const;
  const arena = new Uint8Array(PRIVATE_VALUE_PROFILES.S.arenaBytes);
  return {
    publicInputs: [
      0x50435348n,
      0x4321n,
      1n, 2n, 3n, 4n,
      5n, 6n, 7n, 8n, 9n,
      deliveryCommitment(outputData, arena),
      0n, 0n, 0n,
      1_900_000_000n, 0n, 0n,
    ],
    proof: new Uint8Array(WIRE_PROOF_BYTES),
    outputData,
    arena,
  };
}

function scriptedFetch(responses: unknown[]) {
  const captured: Captured[] = [];
  const queue = [...responses];
  const rpcOptions = rpcFetch((body, url) => {
    captured.push({ url, body });
    return rpcResult(body, queue.shift());
  });
  return { rpcOptions, captured };
}

function bytes32(fill: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => fill);
}
function hex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function quantity(value: bigint | number): string {
  return `0x${value.toString(16)}`;
}
function fieldHex(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
function fields(values: readonly bigint[]): string[] {
  return values.map((value) => fieldHex(value));
}

const VK_A = 0xa1n;
const VK_B = 0xb2n;
const CONFIG_A = 0xc3n;
const CONFIG_B = 0xd4n;

/**
 * A fully self-consistent `status:"contract"` payload: the account proof
 * verifies, the origin transaction decodes to a matching contract body, and
 * the returned function material matches the decoded body — exactly what the
 * shared `parseContractResult` demands before anything is labeled verified.
 */
function contractPayload(funding: ContractFundingMode = "sponsored"): { payload: Record<string, unknown>; address: string } {
  const build = buildContractBody({
    nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 44n },
    functions: [
      { selector: functionSelector(0x01), applicationVkHash: VK_A, configurationCommitment: CONFIG_A },
      { selector: functionSelector(0x02), applicationVkHash: VK_B, configurationCommitment: CONFIG_B },
    ],
  });
  const address = `0x${build.address.toString(16).padStart(40, "0")}`;

  const accountStateTree = new SparseMerkleTree(40);
  accountStateTree.setLeaf(0, build.accountStateCommitment);
  const state: StateComponents = {
    outputRoot: 11n,
    outputCount: 1n,
    issuedSoFar: 0n,
    lagQ: 0n,
    accountStateRoot: accountStateTree.root,
    accountCount: 1n,
    nullifierRoot: 0x55n,
    nullifierCount: 3n,
  };
  const header: PcashBlockHeader = {
    parentHash: 0x502n,
    number: 2n,
    timestamp: 1_000n,
    transactionResultsRoot: transactionResultsRoot([], []),
    stateRoot: computeStateRoot(state),
    l1OriginRoot: 33n,
    historyRoot: 44n,
  };
  const blockHash = computeBlockHash(header);
  const headerTree = blockHeaderTree(header);
  const stateTreeCommitted = stateTree(state);
  const boundary: CurrentBoundaryEnvelopeRpc = {
    state: {
      outputRoot: fieldHex(state.outputRoot),
      outputCount: quantity(state.outputCount),
      issuedSoFar: "0x0",
      lagQ: state.lagQ.toString(),
      accountStateRoot: fieldHex(state.accountStateRoot),
      accountCount: quantity(state.accountCount),
      nullifierRoot: fieldHex(state.nullifierRoot),
      nullifierCount: quantity(state.nullifierCount),
    },
    header: {
      parentHash: fieldHex(header.parentHash),
      number: quantity(header.number),
      timestamp: quantity(header.timestamp),
      transactionResultsRoot: fieldHex(header.transactionResultsRoot),
      stateRoot: fieldHex(header.stateRoot),
      l1OriginRoot: fieldHex(header.l1OriginRoot),
      historyRoot: fieldHex(header.historyRoot),
    },
    blockHash: fieldHex(blockHash),
  };
  const accountProof = {
    status: "present",
    account: {
      address,
      index: "0x0",
      accountRevision: "0x1",
      accountKind: "0x1",
      nullifierKeyCommitment: fieldHex(build.nullifierKeyCommitment),
      accountRuleSetCommitment: fieldHex(build.functionSetCommitment),
      receiveKeyHash: hex(new Uint8Array(32)),
      material: { status: "notPresent" },
    },
    accountStateRoot: fieldHex(accountStateTree.root),
    accountSiblings: fields(accountStateTree.proof(0).siblings),
    accountCount: "0x1",
    stateRootHeaderSiblings: fields(headerTree.proof(BLOCK_HEADER_KEY_STATE_ROOT).siblings),
    accountStateRootStateSiblings: fields(stateTreeCommitted.proof(STATE_KEY_ACCOUNT_STATE_ROOT).siblings),
    boundary,
  };
  return {
    address,
    payload: {
      status: "contract",
      address,
      accountProof,
      transaction: hex(encodeContractAccountCreation(0x50435348n, build.body, funding === "unfunded"
        ? { mode: "unfunded", recentPcashBlockHash: 0x4321n, validUntilTimestamp: 1_900_000_000n }
        : { mode: "sponsored", section: contractCreationSection() })),
      functions: [
        { selector: "0x1", applicationVkHash: fieldHex(VK_A), configurationCommitment: fieldHex(CONFIG_A) },
        { selector: "0x2", applicationVkHash: fieldHex(VK_B), configurationCommitment: fieldHex(CONFIG_B) },
      ],
      origin: {
        l1BlockNumber: "0x64",
        l1BlockHash: hex(bytes32(0x90)),
        l1TransactionIndex: "0x0",
        batchItemIndex: "0x0",
      },
    },
  };
}

function implementationSummary(vkHash: bigint): Record<string, unknown> {
  const zero = fieldHex(1n);
  return {
    verificationStatus: "verified",
    verificationAuthority: "public_submission",
    verificationMethod: "submitted_bundle",
    applicationVkHash: fieldHex(vkHash),
    implementationLabel: "escrow.claim",
    packageRoot: "escrow/claim",
    packageName: "claim",
    sourceBundleDigest: zero,
    compilerArtifactSha256: zero,
    decodedAcirSha256: zero,
    noirProvingAbiSha256: zero,
    verificationKeySha256: zero,
    verificationKeyFieldCount: "0x97",
    toolchain: {
      releaseManifestSha256: zero,
      producerPlatform: "darwin-arm64",
      nargo: { version: "1.0.0", noircCommit: "abc123", archiveSha256: zero },
      barretenberg: { version: "0.0.0-test", verifierTarget: "chonk", archiveSha256: zero },
      crs: { bn254G1Sha256: zero, bn254G2Sha256: zero },
    },
  };
}

function presentation(): Record<string, unknown> {
  return {
    verificationAuthority: "public_submission",
    verificationMethod: "submitted_bundle",
    profile: {
      schemaVersion: "0x1",
      publisherLabel: "Fixture publisher",
      contractName: "Fixed price escrow",
      contractDescription: "Exchanges a configured PCASH amount for an Ethereum payment.",
      functions: [
        {
          selector: "0x1",
          applicationVkHash: fieldHex(VK_A),
          name: "claim",
          summary: "Claims the escrow after proving payment.",
          configurationFields: [{
            position: "0x0",
            name: "seller",
            label: "Seller",
            description: "Ethereum payment recipient.",
            displayFormat: "ethereum-address",
            overviewOrder: "0x0",
          }],
          proofGroups: [{
            title: "Payment proof",
            description: "Private payment facts checked by claim.",
            items: [{ abiParameter: "payment", description: "Matching Ethereum payment." }],
          }],
        },
        {
          selector: "0x2",
          applicationVkHash: fieldHex(VK_B),
          name: "reclaim",
          summary: "Returns the escrow after expiry.",
          configurationFields: [],
          proofGroups: [{
            title: "Seller authorization",
            description: "Private authorization checked by reclaim.",
            items: [{ abiParameter: "signature", description: "Seller authorization." }],
          }],
        },
      ],
    },
  };
}

const INFO_READY = {
  status: "ready",
  writable: true,
  verificationAuthority: "node_operator",
  verificationMethod: "node_registry",
  manifestSchemaVersion: "0x1",
  serviceName: "Smoke Operator",
  implementationCount: "0x2",
  configurationOpeningCount: "0x4",
  invalidConfigurationOpeningCount: "0x0",
  pcashChainId: "0x50435348",
  genesisHash: fieldHex(0xabn),
  sourceSubmissionStatus: "disabled",
  configurationOpeningSubmissionStatus: "ready",
  submittedImplementationCount: "0x2",
  error: null,
};

describe("createPscanClient", () => {
  it.each(["sponsored", "unfunded"] as const)("returns authenticated contract fields for %s creation", (funding) => {
    const { address, payload } = contractPayload(funding);
    const parser = new PcashNodeClient("http://n");
    const parsed = parser.parseContractResult({
      ...payload,
      publishesNkRoot: true,
      nkRoot: fieldHex(123n),
      functions: [{ selector: "0xff", applicationVkHash: fieldHex(999n), configurationCommitment: fieldHex(999n) }],
    }, address);
    expect(parsed.status).toBe("contract");
    if (parsed.status === "contract") {
      expect(parsed.publishesNkRoot).toBe(false);
      expect(parsed.nkRoot).toBeNull();
      expect(parsed.functions.map((fn) => fn.selector)).toEqual([1, 2]);
    }
  });

  it("speaks the pscan_ namespace and parses channel-aware info without pinning writable", async () => {
    const { rpcOptions, captured } = scriptedFetch([INFO_READY]);
    const client = createPscanClient("http://127.0.0.1:8648", rpcOptions);
    const info = await client.sourceVerificationInfo();
    expect(captured[0]?.body.method).toBe("pscan_sourceVerificationInfo");
    expect(captured[0]?.url).toBe("http://127.0.0.1:8648/");
    expect(info.status).toBe("ready");
    // writable is served data, not an invariant: expose it, never assert it.
    expect(info.writable).toBe(true);
    expect(info.pcashChainId).toBe(0x50435348);
    expect(info.genesisHash).toBe(fieldHex(0xabn));
    expect(info.sourceSubmissionStatus).toBe("disabled");
    expect(info.configurationOpeningSubmissionStatus).toBe("ready");
    expect(info.submittedImplementationCount).toBe(2n);
    expect(info.implementationCount).toBe(2n);
    expect(info.serviceName).toBe("Smoke Operator");
    expect(info.error).toBeNull();
  });

  it("surfaces listener errors with their code and matchable kind", async () => {
    const transport = rpcFetch((body) => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32043, message: "source submissions are disabled on this listener", data: { kind: "disabled" } },
    }), { status: 403 }));
    const client = createPscanClient("http://127.0.0.1:8648", transport);
    await expect(client.sourceVerificationInfo()).rejects.toThrow(/-32043 \(disabled\)/);
  });

  it("checks the HTTP status and the JSON-RPC envelope strictly", async () => {
    const respond = (ok: boolean, body: string) => createPscanClient(
      "http://127.0.0.1:8648",
      rpcFetch(() => new Response(body, { status: ok ? 200 : 502 })),
    );
    await expect(respond(true, JSON.stringify({ jsonrpc: "2.0", id: 1, error: null, result: INFO_READY }))
      .sourceVerificationInfo()).resolves.toMatchObject({ status: "ready" });
    await expect(respond(false, JSON.stringify({ jsonrpc: "2.0", id: 1, result: INFO_READY }))
      .sourceVerificationInfo()).rejects.toMatchObject({ status: 502 });
    await expect(respond(true, JSON.stringify({ jsonrpc: "2.0", id: 1 }))
      .getContractSource(`0x${"11".repeat(20)}`)).rejects.toThrow(/result is required/);
    await expect(respond(true, "null").getContractSource(`0x${"11".repeat(20)}`)).rejects.toThrow(/must be an object/);
  });

  it.each(["sponsored", "unfunded"] as const)("parses a verified contract source view for %s creation", async (funding) => {
    const { address, payload } = contractPayload(funding);
    const view = {
      address,
      verificationStatus: "verified",
      contract: payload,
      implementations: [implementationSummary(VK_A)],
      configurationOpenings: [{
        selector: "0x1",
        status: "verified",
        scheme: "poseidon-explicit-domain-positional-v1",
        domain: "pcash.marketplace.offer.v1",
        values: [{ position: "0x0", value: fieldHex(7n), name: "seller", type: "address" }],
        expectedConfigurationCommitment: fieldHex(CONFIG_A),
        computedConfigurationCommitment: fieldHex(CONFIG_A),
        error: null,
      }],
      presentation: presentation(),
    };
    const { rpcOptions, captured } = scriptedFetch([view]);
    const client = createPscanClient("http://127.0.0.1:8648", rpcOptions);
    const parsed = await client.getContractSource(address);
    expect(captured[0]?.body.method).toBe("pscan_getContractSource");
    expect(captured[0]?.body.params).toEqual([address]);
    expect(parsed?.verificationStatus).toBe("verified");
    expect(parsed?.contract.status).toBe("contract");
    expect(parsed?.contract.functions.map((fn) => fn.selector)).toEqual([1, 2]);
    expect(parsed?.implementations[0]?.implementationLabel).toBe("escrow.claim");
    expect(parsed?.implementations[0]?.verificationAuthority).toBe("public_submission");
    expect(parsed?.configurationOpenings[0]?.selector).toBe(1n);
    expect(parsed?.configurationOpenings[0]?.values[0]?.name).toBe("seller");
    expect(parsed?.presentation?.profile.contractName).toBe("Fixed price escrow");
    expect(parsed?.presentation?.profile.functions[0]?.configurationFields[0]?.overviewOrder).toBe(0n);
  });

  it("requires presentation metadata to match the authenticated ordered function shape", async () => {
    const { address, payload } = contractPayload();
    const base = {
      address,
      verificationStatus: "verified",
      contract: payload,
      implementations: [implementationSummary(VK_A), implementationSummary(VK_B)],
      configurationOpenings: [],
    };
    const missing = scriptedFetch([{ ...base, presentation: null }]);
    await expect(createPscanClient("http://x", missing.rpcOptions).getContractSource(address))
      .rejects.toThrow(/presentation must be present/);

    const mismatchedPresentation = presentation();
    (mismatchedPresentation.profile as { functions: { applicationVkHash: string }[] })
      .functions[1]!.applicationVkHash = fieldHex(0x999n);
    const mismatched = scriptedFetch([{ ...base, presentation: mismatchedPresentation }]);
    await expect(createPscanClient("http://x", mismatched.rpcOptions).getContractSource(address))
      .rejects.toThrow(/authenticated contract shape/);
  });

  it("rejects presentation display formats unknown to the read-side wire contract", async () => {
    const { address, payload } = contractPayload();
    const invalidPresentation = presentation();
    (invalidPresentation.profile as {
      functions: { configurationFields: { displayFormat: string }[] }[];
    }).functions[0]!.configurationFields[0]!.displayFormat = "future-format";
    const transport = scriptedFetch([{
      address,
      verificationStatus: "verified",
      contract: payload,
      implementations: [implementationSummary(VK_A), implementationSummary(VK_B)],
      configurationOpenings: [],
      presentation: invalidPresentation,
    }]);
    await expect(createPscanClient("http://x", transport.rpcOptions).getContractSource(address))
      .rejects.toThrow(/displayFormat must be one of/);
  });

  it("answers null for an unknown address and refuses a substituted one", async () => {
    const { rpcOptions } = scriptedFetch([null]);
    const client = createPscanClient("http://127.0.0.1:8648", rpcOptions);
    await expect(client.getContractSource(`0x${"ab".repeat(20)}`)).resolves.toBeNull();

    const { address, payload } = contractPayload();
    const other = `0x${"cd".repeat(20)}`;
    const swapped = scriptedFetch([{ ...payload, address }]);
    await expect(createPscanClient("http://x", swapped.rpcOptions)
      .getContractSource(other)).rejects.toThrow(/different contract address/);
  });

  it("refuses a view whose embedded contract no longer verifies", async () => {
    const { address, payload } = contractPayload();
    const tampered = JSON.parse(JSON.stringify(payload));
    tampered.accountProof.account.accountRuleSetCommitment = fieldHex(0x99n);
    const { rpcOptions } = scriptedFetch([{
      address,
      verificationStatus: "verified",
      contract: tampered,
      implementations: [],
      configurationOpenings: [],
      presentation: presentation(),
    }]);
    const client = createPscanClient("http://127.0.0.1:8648", rpcOptions);
    await expect(client.getContractSource(address)).rejects.toThrow();
  });

  it("submits an envelope and reports per-implementation origin", async () => {
    const { address } = contractPayload();
    const result = {
      contentId: fieldHex(0xcddcdn),
      deduplicated: false,
      reproducedImplementations: "0x2",
      configurationOpeningCount: "0x2",
      implementations: [
        {
          applicationVkHash: fieldHex(VK_A),
          verificationAuthority: "public_submission",
          verificationMethod: "submitted_bundle",
        },
        {
          applicationVkHash: fieldHex(VK_B),
          verificationAuthority: "public_submission",
          verificationMethod: "submitted_bundle",
        },
      ],
    };
    const { rpcOptions, captured } = scriptedFetch([result, { ...result, deduplicated: true, reproducedImplementations: "0x0" }]);
    const client = createPscanClient("http://127.0.0.1:8648", rpcOptions);
    const envelope: SubmittedSourceEnvelope = {
      contractAddresses: [address],
      publication: {
        manifest: { schemaVersion: 1 },
        attachments: { "claim/src/main.nr": Buffer.from("fn main() {}").toString("base64") },
      },
    };
    const submitted = await client.submitContractSource(envelope);
    expect(captured[0]?.body.method).toBe("pscan_submitContractSource");
    expect(captured[0]?.body.params).toEqual([envelope]);
    expect(submitted.deduplicated).toBe(false);
    expect(submitted.reproducedImplementations).toBe(2n);
    expect(submitted.contentId).toBe(fieldHex(0xcddcdn));
    expect(submitted.implementations[0]?.applicationVkHash).toBe(fieldHex(VK_A));

    const resubmitted = await client.submitContractSource(envelope);
    expect(resubmitted.deduplicated).toBe(true);
    expect(resubmitted.reproducedImplementations).toBe(0n);

    await expect(client.submitContractSource({
      contractAddresses: ["0x1234"],
      publication: envelope.publication,
    })).rejects.toThrow(/contractAddresses must name at least one contract|contractAddresses must be 20-byte hex/);
  });

  it("submits a strict complete contract-opening payload without source material", async () => {
    const { address } = contractPayload();
    const result = {
      contractAddress: address,
      contentId: fieldHex(0xcddcdn),
      configurationOpeningCount: "0x2",
      deduplicated: false,
    };
    const transport = scriptedFetch([result]);
    const client = createPscanClient("http://127.0.0.1:8648", transport.rpcOptions);
    const submission: ContractConfigurationOpeningSubmission = {
      contractAddress: address,
      openings: [
        {
          selector: 1,
          applicationVkHash: fieldHex(VK_A),
          configurationCommitment: fieldHex(CONFIG_A),
          domain: fieldHex(7n),
          values: [fieldHex(8n)],
        },
        {
          selector: 2,
          applicationVkHash: fieldHex(VK_B),
          configurationCommitment: fieldHex(CONFIG_B),
          domain: fieldHex(7n),
          values: [fieldHex(9n)],
        },
      ],
    };
    const accepted = await client.submitContractConfigurationOpenings(submission);
    expect(transport.captured[0]?.body.method).toBe("pscan_submitContractConfigurationOpenings");
    expect(transport.captured[0]?.body.params).toEqual([{
      contractAddress: address,
      openings: [
        { ...submission.openings[0], selector: "0x1" },
        { ...submission.openings[1], selector: "0x2" },
      ],
    }]);
    expect((transport.captured[0]?.body.params[0] as Record<string, unknown>).publication).toBeUndefined();
    expect(accepted).toEqual({
      contractAddress: address,
      contentId: fieldHex(0xcddcdn),
      configurationOpeningCount: 2n,
      deduplicated: false,
    });
  });

  it("rejects malformed, duplicate, and unknown opening submission input before RPC", async () => {
    const { address } = contractPayload();
    const opening = {
      selector: 1,
      applicationVkHash: fieldHex(VK_A),
      configurationCommitment: fieldHex(CONFIG_A),
      domain: fieldHex(7n),
      values: [fieldHex(8n)],
    };
    const client = createPscanClient("http://127.0.0.1:8648", scriptedFetch([]).rpcOptions);
    await expect(client.submitContractConfigurationOpenings({
      contractAddress: address,
      openings: [{ ...opening, surprise: true }],
    } as never)).rejects.toThrow(/unknown field surprise/);
    await expect(client.submitContractConfigurationOpenings({
      contractAddress: address,
      openings: [opening, opening],
    })).rejects.toThrow(/duplicate selector/);
    await expect(client.submitContractConfigurationOpenings({
      contractAddress: address,
      openings: [{ ...opening, values: [`0x${"ff".repeat(32)}`] }],
    })).rejects.toThrow(/canonical BN254 field/);
    await expect(client.submitContractConfigurationOpenings({
      contractAddress: address,
      openings: [],
      publication: {},
    } as never)).rejects.toThrow(/unknown field publication/);
  });

  it("strictly parses the configuration-opening acceptance result", async () => {
    const { address } = contractPayload();
    const submission: ContractConfigurationOpeningSubmission = {
      contractAddress: address,
      openings: [{
        selector: 1,
        applicationVkHash: fieldHex(VK_A),
        configurationCommitment: fieldHex(CONFIG_A),
        domain: fieldHex(7n),
        values: [fieldHex(8n)],
      }],
    };
    const unknown = scriptedFetch([{
      contractAddress: address,
      contentId: fieldHex(1n),
      configurationOpeningCount: "0x1",
      deduplicated: false,
      verificationAuthority: "public_submission",
    }]);
    await expect(createPscanClient("http://x", unknown.rpcOptions)
      .submitContractConfigurationOpenings(submission)).rejects.toThrow(/unknown field verificationAuthority/);

    const mismatched = scriptedFetch([{
      contractAddress: `0x${"cd".repeat(20)}`,
      contentId: fieldHex(1n),
      configurationOpeningCount: "0x1",
      deduplicated: false,
    }]);
    await expect(createPscanClient("http://x", mismatched.rpcOptions)
      .submitContractConfigurationOpenings(submission)).rejects.toThrow(/different contract address/);
  });

  it("summarizes which selectors are missing from the registry", async () => {
    const address = `0x${"ab".repeat(20)}`;
    const parsedView = {
      address,
      verificationStatus: "not_verified",
      contract: {
        status: "contract",
        address,
        authenticated: true,
        functions: [
          { selector: 1, applicationVkHash: fieldHex(VK_A) },
          { selector: 2, applicationVkHash: fieldHex(VK_B) },
        ],
      },
    };
    const present = {
      implementation: implementationSummary(VK_A),
      sourceFiles: [{ path: "claim/src/main.nr", length: "0x10", sha256: fieldHex(2n) }],
      noirProvingAbi: { parameters: [], return_type: null },
    };
    // Point-query order after the stubbed view: first selector present, second absent.
    const { rpcOptions, captured } = scriptedFetch([present, null]);
    const client = createPscanClient("http://127.0.0.1:8648", rpcOptions);
    Object.assign(client, { getContractSource: async () => parsedView });
    // The summary must not depend on being called as a method.
    const { contractVerificationSummary } = client;
    const summary = await contractVerificationSummary(address);
    expect(summary.address).toBe(address);
    expect(summary.verified).toBe(false);
    expect(summary.functions[0]).toEqual({
      selector: 1,
      name: "escrow.claim",
      applicationVkHash: fieldHex(VK_A),
      inRegistry: true,
    });
    expect(summary.functions[1]).toEqual({
      selector: 2,
      applicationVkHash: fieldHex(VK_B),
      inRegistry: false,
    });
    expect(captured[0]?.body.method).toBe("pscan_getImplementationSource");
    expect(captured[1]?.body.method).toBe("pscan_getImplementationSource");
  });
});
