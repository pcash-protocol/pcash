import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { TX_KIND_PRIVATE_VALUE } from "@pcash/sdk";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_NETWORK_CONFIG,
  emptyLadder, rootFromIndex, ownerCommitment, noteBodyCommitment, outputCommitment, randomFieldEntropy,
  type ContractResult, type PcashNodeClient,
} from "@pcash/sdk/browser";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import {
  MIN_CLAIM_WINDOW_SECONDS,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  reclaimConfigurationCommitment,
  type OfferTerms,
} from "../src/commitments.mts";
import { createOffer } from "../src/offer.mts";
import {
  publicationFromOffer,
  serializePublication,
  parsePublication,
  publicationTerms,
  offerKey,
  publicationContractAddress,
  type OfferPublication,
} from "../src/client/publication.ts";
import {
  PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
  configurePaymentRouterRuntimeCode,
  type PaymentRouterConfig,
} from "../src/client/paymentRouter.ts";
import { buildBuyCall, claimBatchStandIn, sendRouterCall } from "../src/client/buy.ts";
import { verifyOffer, verifyOfferForPayment } from "../src/client/verification.ts";
import { marketplacePublicationSourceConfigurationOpenings } from "../src/sourceVerification.ts";
import { addressHex, fieldToHex } from "@pcash/sdk/browser";
import { bytesToHex, hexToBytes, numberToHex, padHex, toFunctionSelector, type Hex } from "viem";
import { decodeContractBody, encodeContractBody, functionSelector, type ContractFunction } from "@pcash/sdk/protocol";
import { deriveVerifiedL2ContractMaterial } from "../src/client/verifiedContractMaterial.ts";

const CHAIN = 1346589512n;
const NETWORK = { ...DEFAULT_NETWORK_CONFIG, pcashChainId: CHAIN };
const SELLER_KEY = new Uint8Array(32).fill(7);
const EXPECTED_ROUTER = addressHex(sampleTerms().router);
const SNAPSHOT_BLOCK = 123n;
const SNAPSHOT_HASH = `0x${"00".repeat(31)}ab`;
const L1_ORIGIN_BLOCK = 456n;
const L1_ORIGIN_HASH = `0x${"bc".repeat(32)}`;
const GENESIS_L1_HASH = `0x${"11".repeat(32)}`;
const ROUTER_CONFIG: PaymentRouterConfig = {
  feeRecipient: "0x00000000000000000000000000000000000000fe",
  feeBps: 500,
};
const PAYMENT_HASH = `0x${"22".repeat(32)}` as const;
const GUARDIAN = "0x00000000000000000000000000000000000000bb";
const SNAPSHOT_BOUNDARY = {
  header: { number: SNAPSHOT_BLOCK },
  blockHash: 0xabn,
};

function paymentRouterArtifactPath(): string {
  return join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..", "l1-contracts", "out", "PaymentRouter.sol", "PaymentRouter.json",
  );
}

function rpcBlock(hash: string): Record<string, unknown> {
  const zeroHash = `0x${"00".repeat(32)}`;
  return {
    baseFeePerGas: "0x0",
    difficulty: "0x0",
    extraData: "0x",
    gasLimit: "0x0",
    gasUsed: "0x0",
    hash,
    logsBloom: `0x${"00".repeat(256)}`,
    miner: "0x0000000000000000000000000000000000000000",
    mixHash: zeroHash,
    nonce: "0x0000000000000000",
    number: "0x0",
    parentHash: zeroHash,
    receiptsRoot: zeroHash,
    sha3Uncles: zeroHash,
    size: "0x0",
    stateRoot: zeroHash,
    timestamp: "0x0",
    totalDifficulty: "0x0",
    transactions: [],
    transactionsRoot: zeroHash,
    uncles: [],
  };
}

async function withPaymentRouterRpc<T>(
  runtimeCode: Hex,
  run: (l1Url: string) => Promise<T>,
  options: {
    head?: () => bigint | null;
    onEstimate?: () => void;
    methods?: string[];
    /** The router's `paid` record for every payment key; zero by default. */
    paid?: Hex;
  } = {},
): Promise<T> {
  const feeRecipientSelector = toFunctionSelector("feeRecipient()");
  const feeBpsSelector = toFunctionSelector("feeBps()");
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as {
      id: number;
      method: string;
      params?: [{ data?: string; input?: string }];
    };
    options.methods?.push(message.method);
    let result: unknown;
    if (message.method === "eth_chainId") {
      result = numberToHex(NETWORK.l1ChainId);
    } else if (message.method === "eth_getBlockByNumber") {
      result = rpcBlock(GENESIS_L1_HASH);
    } else if (message.method === "eth_blockNumber") {
      const head = options.head ? options.head() : L1_ORIGIN_BLOCK + 1n;
      if (head === null) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "L1 head unavailable" } }));
        return;
      }
      result = numberToHex(head);
    } else if (message.method === "eth_estimateGas") {
      options.onEstimate?.();
      result = "0x11170";
    } else if (message.method === "eth_maxPriorityFeePerGas") {
      result = "0x1";
    } else if (message.method === "eth_getBalance") {
      result = numberToHex(10n ** 20n);
    } else if (message.method === "eth_getTransactionReceipt") {
      result = {
        transactionHash: PAYMENT_HASH, transactionIndex: "0x0", blockHash: L1_ORIGIN_HASH,
        blockNumber: numberToHex(L1_ORIGIN_BLOCK + 10n), from: GUARDIAN, to: EXPECTED_ROUTER,
        cumulativeGasUsed: "0x11170", gasUsed: "0x11170", effectiveGasPrice: "0x1",
        contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
      };
    } else if (message.method === "eth_getCode") {
      result = runtimeCode;
    } else if (message.method === "eth_call") {
      const input = message.params?.[0]?.data ?? message.params?.[0]?.input;
      if (input === feeRecipientSelector) {
        result = padHex(ROUTER_CONFIG.feeRecipient, { size: 32 });
      } else if (input === toFunctionSelector("deploymentBlock()")) {
        result = numberToHex(123n, { size: 32 });
      } else if (input === feeBpsSelector) {
        result = numberToHex(ROUTER_CONFIG.feeBps, { size: 32 });
      } else if (input?.startsWith(toFunctionSelector("paid(bytes32)"))) {
        result = options.paid ?? `0x${"00".repeat(32)}`;
      } else {
        throw new Error(`unexpected test eth_call input ${input}`);
      }
    } else {
      throw new Error(`unexpected test RPC method ${message.method}`);
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test RPC did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function sampleTerms(overrides: Partial<OfferTerms> = {}): OfferTerms {
  return {
    router: 0x00000000000000000000000000000000000000aan,
    seller: 0x00000000000000000000000000000000000000bbn,
    id: 0x0ffe1n,
    assetId: 0n,
    amount: 250_000_000_000_000_000n,
    ethPriceWei: 50_000_000_000_000_000n,
    deadlineT: 4_000_000_000n,
    ...overrides,
  };
}

// Build a publication. `vk` overrides let the substitute-implementation tests
// register claim() or reclaim() with an implementation that is not approved.
function buildPublication(
  overrides: Partial<OfferTerms> = {},
  vk: { claim?: bigint; reclaim?: bigint } = {},
): { pub: OfferPublication; terms: OfferTerms } {
  const wallet = derivePcashProfileFromPrivateKey(SELLER_KEY, NETWORK);
  const terms = sampleTerms(overrides);
  const offer = createOffer({
    network: NETWORK, terms, sellerWallet: wallet, l2ContractNkRoot: randomFieldEntropy(),
    claimApplicationVkHash: vk.claim ?? CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: vk.reclaim ?? RECLAIM_APPLICATION_VK_HASH,
  });
  return { pub: publicationFromOffer(offer), terms: offer.terms };
}

function withFunction(pub: OfferPublication, selector: number, changes: Partial<ContractFunction>): OfferPublication {
  const body = decodeContractBody(hexToBytes(pub.l2Contract.bodyHex as Hex));
  return {
    ...pub,
    l2Contract: {
      ...pub.l2Contract,
      bodyHex: bytesToHex(encodeContractBody({
        ...body,
        functions: body.functions.map((fn) => fn.selector === selector ? { ...fn, ...changes } : fn),
      })),
    },
  };
}

/** A node stub that reports the L2 smart contract as live with a matching function-set commitment. */
function liveNode(pub: OfferPublication): PcashNodeClient {
  return {
    async getWitnessSnapshot(this: PcashNodeClient, request: { contracts?: string[]; outputs?: unknown[] }) {
      const output = request.outputs ? await this.getOutputPath(0, 0n) : null;
      return {
        status: await this.status(),
        contracts: [await this.getContract(request.contracts![0]!)],
        outputs: output === null ? null : { ...output, paths: [{ outputIndex: 0n, siblings: output.siblings }] },
        nullifiers: output === null ? { statuses: [] } : await this.getCurrentNullifierStatuses([]),
        block: output === null ? null : await this.getBlock(SNAPSHOT_BLOCK),
      };
    },
    status: async () => ({
      pcashChainId: Number(NETWORK.pcashChainId),
      l1ChainId: NETWORK.l1ChainId,
      inboxAddress: `0x${NETWORK.inboxAddress.toString(16).padStart(40, "0")}`,
      acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE],
      genesisL1Block: 0n,
      genesisL1BlockHash: GENESIS_L1_HASH,
    }) as Awaited<ReturnType<PcashNodeClient["status"]>>,
    getContract: async (address: string): Promise<ContractResult | null> => {
      if (BigInt(address) !== BigInt(publicationContractAddress(pub))) {
        return { status: "notFound", address, authenticated: false };
      }
      return {
        status: "contract",
        address,
        accountProof: { boundary: SNAPSHOT_BOUNDARY },
        publishesNkRoot: false,
        nkRoot: fieldToHex(deriveVerifiedL2ContractMaterial(pub).nkRoot),
        functions: deriveVerifiedL2ContractMaterial(pub).body.functions.map((fn) => ({
          selector: fn.selector,
          applicationVkHash: fieldToHex(BigInt(fn.applicationVkHash)),
          configurationCommitment: fieldToHex(BigInt(fn.configurationCommitment)),
        })),
        transaction: pub.l2Contract.bodyHex,
        origin: {},
      } as unknown as ContractResult;
    },
  } as unknown as PcashNodeClient;
}

function fundedPublication() {
  const { pub } = buildPublication();
  const escrow = { leafIndex: 0, noteSecret: fieldToHex(0x44n), amount: pub.terms.amount };
  const funded = { ...pub, escrow };
  const owner = ownerCommitment(deriveVerifiedL2ContractMaterial(pub).address, BigInt(escrow.noteSecret));
  const leaf = outputCommitment(noteBodyCommitment(owner, 0n, BigInt(escrow.amount)), 0n);
  const siblings = emptyLadder(40).slice(0, 40);
  const root = rootFromIndex(leaf, 0n, siblings);
  const base = liveNode(pub) as unknown as Record<string, unknown>;
  const fundedNode = {
    ...base,
    getContract: liveNode(pub).getContract.bind(liveNode(pub)),
    getOutputPath: async () => ({
      leafIndex: 0n,
      root: fieldToHex(root),
      count: 1n,
      siblings: siblings.map(fieldToHex),
      boundary: SNAPSHOT_BOUNDARY,
    }),
    getBlock: async () => ({
      hash: SNAPSHOT_HASH,
      l1Origin: {
        blockNumber: L1_ORIGIN_BLOCK,
        blockHash: L1_ORIGIN_HASH,
        blockTimestamp: 1_700_000_000n,
        l1LogsRoot: `0x${"00".repeat(32)}`,
        l1LogCount: 0n,
      },
    }),
    getCurrentNullifierStatuses: async () => ({
      statuses: [{ nullifier: fieldToHex(0n), spent: false }],
      boundary: SNAPSHOT_BOUNDARY,
    }),
  } as unknown as PcashNodeClient;
  return { pub, escrow, funded, fundedNode, leaf };
}

describe("offer publication", () => {
  it("reconstructs the exact source configuration openings from a durable publication", () => {
    const { pub } = buildPublication();
    const openings = marketplacePublicationSourceConfigurationOpenings(pub, NETWORK);
    assert.equal(openings.length, 2);
    assert.deepEqual(openings.map((opening) => opening.selector), [0, 1]);
    assert.ok(openings.every((opening) => opening.address.toLowerCase() === publicationContractAddress(pub).toLowerCase()));
    assert.equal(openings[0]?.configurationCommitment.toLowerCase(), fieldToHex(deriveVerifiedL2ContractMaterial(pub).function(0).configurationCommitment).toLowerCase());
    assert.equal(openings[1]?.configurationCommitment.toLowerCase(), fieldToHex(deriveVerifiedL2ContractMaterial(pub).function(1).configurationCommitment).toLowerCase());
    assert.throws(
      () => marketplacePublicationSourceConfigurationOpenings(pub, { ...NETWORK, l1ChainId: NETWORK.l1ChainId + 1n }),
      /does not match the published contract body/,
    );
    assert.throws(
      () => marketplacePublicationSourceConfigurationOpenings({
        ...pub,
        l2Contract: { ...pub.l2Contract, claimConfigurationSalt: fieldToHex(1n) },
      }, NETWORK),
      /does not match the published contract body/,
    );
    assert.throws(
      () => marketplacePublicationSourceConfigurationOpenings({
        ...pub,
        terms: { ...pub.terms, amount: fieldToHex(BigInt(pub.terms.amount) + 1n) },
      }, NETWORK),
      /does not match the published contract body/,
    );
  });

  it("round-trips through serialize/parse and preserves terms", () => {
    const { pub, terms } = buildPublication();
    const parsed = parsePublication(serializePublication(pub));
    assert.deepEqual(publicationTerms(parsed), terms);
    assert.equal(publicationContractAddress(parsed), publicationContractAddress(pub));
    assert.equal(offerKey(parsed), offerKey(pub));
  });

  it("rejects malformed publications", () => {
    assert.throws(() => parsePublication("not json"), /valid JSON/);
    assert.throws(() => parsePublication(JSON.stringify({ version: 3 })), /version/);
    assert.throws(() => parsePublication(JSON.stringify({ version: 99 })), /unsupported publication version/);
    const { pub } = buildPublication();
    const missing = JSON.parse(serializePublication(pub));
    delete missing.l2Contract.bodyHex;
    assert.throws(() => parsePublication(JSON.stringify(missing)), /bodyHex/);

    const extraContractField = JSON.parse(serializePublication(pub));
    extraContractField.l2Contract.owner = fieldToHex(1n);
    assert.throws(() => parsePublication(JSON.stringify(extraContractField)), /unknown field/);

    for (const [label, mutate] of [
      ["publication", (value: any) => { value.unexpected = true; }],
      ["terms", (value: any) => { value.terms.unexpected = true; }],
      ["contract", (value: any) => { value.l2Contract.unexpected = true; }],
    ] as const) {
      const withUnknown = JSON.parse(serializePublication(pub));
      mutate(withUnknown);
      assert.throws(
        () => parsePublication(JSON.stringify(withUnknown)),
        /unknown field/,
        `${label} unknown field was accepted`,
      );
    }

    const missingConfigurationSalt = JSON.parse(serializePublication(pub));
    delete missingConfigurationSalt.l2Contract.claimConfigurationSalt;
    assert.throws(() => parsePublication(JSON.stringify(missingConfigurationSalt)), /ConfigurationSalt/);

    const decimalAlias = JSON.parse(serializePublication(pub));
    decimalAlias.terms.id = BigInt(decimalAlias.terms.id).toString();
    assert.throws(() => parsePublication(JSON.stringify(decimalAlias)), /canonical 32-byte field/);

    const uppercaseBytes = JSON.parse(serializePublication(pub));
    uppercaseBytes.l2Contract.bodyHex = "0xAA";
    assert.throws(() => parsePublication(JSON.stringify(uppercaseBytes)), /canonical byte-aligned hex/);
  });

  it("rejects offer creation and publications whose deadline cannot fit router calldata", () => {
    const wallet = derivePcashProfileFromPrivateKey(SELLER_KEY, NETWORK);
    assert.throws(() => createOffer({
      network: NETWORK,
      terms: sampleTerms({ deadlineT: 1n << 64n }),
      sellerWallet: wallet,
      l2ContractNkRoot: randomFieldEntropy(),
      claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
      reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
    }), /does not fit uint64/);

    const { pub } = buildPublication();
    const invalid = { ...pub, terms: { ...pub.terms, deadlineT: fieldToHex(1n << 64n) } };
    assert.throws(() => publicationTerms(invalid), /does not fit uint64/);
  });
});

describe("verifyOffer", () => {
  it("verifies a well-formed offer with bound terms and a live L2 smart contract", async () => {
    const { pub } = buildPublication();
    const v = await verifyOffer(liveNode(pub), pub, { expectedRouter: EXPECTED_ROUTER });
    assert.equal(v.l2ContractVerification, "verified");
    assert.equal(v.functionsBound, true);
    assert.equal(v.liveOnNode, true);
    assert.equal(v.escrow, "unfunded");
  });

  it("reports a missing escrow opening as a failed check instead of skipping silently", async () => {
    const { pub } = buildPublication();
    const v = await verifyOffer(liveNode(pub), pub, { expectedRouter: EXPECTED_ROUTER });
    assert.equal(v.escrow, "unfunded");
    assert.equal(v.safeToPay, false);
    assert.ok(v.checks.some((check) => /NOT/.test(check) && /escrow/.test(check)));
  });

  it("classifies a funded escrow that is absent from the current tree as opening-invalid", async () => {
    const { pub } = buildPublication();
    const funded: OfferPublication = {
      ...pub,
      escrow: { leafIndex: 0, noteSecret: fieldToHex(0x44n), amount: pub.terms.amount },
    };
    const node = {
      ...liveNode(pub) as unknown as Record<string, unknown>,
      getOutputPath: async () => null,
    } as unknown as PcashNodeClient;

    const verification = await verifyOffer(node, funded, { expectedRouter: EXPECTED_ROUTER });

    assert.equal(verification.escrow, "opening-invalid");
    assert.ok(verification.checks.some((check) => /escrow note is not in the node's commitment tree/.test(check)));
    assert.ok(!verification.checks.some((check) => /node checks unavailable/.test(check)));
  });

  it("requires the configured router", async () => {
    const { pub } = buildPublication();
    const wrongRouter = await verifyOffer(liveNode(pub), pub, { expectedRouter: addressHex(0x1234n) });
    assert.equal(wrongRouter.routerPinned, false);
    assert.equal(wrongRouter.safeToPay, false);
  });

  it("authenticates an exact, live, unspent escrow without authorizing payment", async () => {
    const { pub, escrow, funded, fundedNode, leaf } = fundedPublication();
    const v = await verifyOffer(fundedNode, funded, { expectedRouter: EXPECTED_ROUTER });
    assert.equal(v.escrow, "escrowed");
    assert.equal(v.safeToPay, false);
    assert.deepEqual(v.claimSnapshot?.anchor, { blockNumber: L1_ORIGIN_BLOCK, blockHash: L1_ORIGIN_HASH });

    const selected = await fundedNode.getWitnessSnapshot({
      contracts: [publicationContractAddress(pub)],
      outputs: [{ outputIndex: 0, outputCommitment: leaf }],
    });
    const advancingNode = {
      getWitnessSnapshot: async () => selected,
      status: async () => ({ ...await fundedNode.status(), latestBlock: SNAPSHOT_BLOCK + 1n }),
      getBlock: async () => { throw new Error("independent latest read"); },
      getContract: async () => { throw new Error("independent latest read"); },
      getOutputPath: async () => { throw new Error("independent latest read"); },
      getCurrentNullifierStatuses: async () => { throw new Error("independent latest read"); },
    } as unknown as PcashNodeClient;
    const advancing = await verifyOffer(advancingNode, funded, { expectedRouter: EXPECTED_ROUTER });
    assert.equal(advancing.escrow, "escrowed");
    assert.deepEqual(advancing.claimSnapshot?.anchor, v.claimSnapshot?.anchor);

    const routerArtifact = paymentRouterArtifactPath();
    if (existsSync(routerArtifact)) {
      const artifact = JSON.parse(readFileSync(routerArtifact, "utf8")) as { deployedBytecode: { object: Hex } };
      const runtimeCode = configurePaymentRouterRuntimeCode(artifact.deployedBytecode.object, ROUTER_CONFIG, GUARDIAN, 123n);
      const payable = await withPaymentRouterRpc(runtimeCode, (l1Url) => verifyOfferForPayment(advancingNode, funded, {
        expectedRouter: EXPECTED_ROUTER,
        expectedNetwork: NETWORK,
        l1Urls: [l1Url],
      }));
      assert.equal(payable.safeToPay, true);
      assert.deepEqual(payable.claimSnapshot?.anchor, v.claimSnapshot?.anchor);
    }

    // A shared router deployment cannot authorize payment without a fresh L1 head.
    const shared = await verifyOfferForPayment(advancingNode, funded, {
      expectedRouter: EXPECTED_ROUTER,
      expectedNetwork: NETWORK,
      l1Urls: ["http://127.0.0.1:1"],
      routerDeployment: { deploymentBlock: 123n, config: ROUTER_CONFIG, runtimeCodeHash: `0x${"00".repeat(32)}`, runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH },
    });
    assert.equal(shared.routerConfigVerified, true);
    assert.equal(shared.safeToPay, false);
    assert.ok(shared.checks.some(check => /node freshness unavailable/.test(check)));
    assert.deepEqual(shared.claimSnapshot?.anchor, v.claimSnapshot?.anchor);

    const spentNode = {
      ...fundedNode,
      getCurrentNullifierStatuses: async () => ({
        statuses: [{ nullifier: fieldToHex(0n), spent: true }],
        boundary: SNAPSHOT_BOUNDARY,
      }),
    } as unknown as PcashNodeClient;
    const spent = await verifyOffer(spentNode, funded, { expectedRouter: EXPECTED_ROUTER });
    assert.equal(spent.safeToPay, false);
    assert.equal(spent.claimSnapshot, null);

    const mismatched = { ...funded, escrow: { ...escrow, amount: fieldToHex(BigInt(escrow.amount) - 1n) } };
    const wrongAmount = await verifyOffer(fundedNode, mismatched, { expectedRouter: EXPECTED_ROUTER });
    assert.equal(wrongAmount.safeToPay, false);
  });

  it("marks the offer unverified when either advertised amount is tampered", async () => {
    const { pub } = buildPublication();
    for (const tampered of [
      { ...pub, terms: { ...pub.terms, amount: fieldToHex(999n) } },
      { ...pub, terms: { ...pub.terms, ethPriceWei: fieldToHex(999n) } },
    ] satisfies OfferPublication[]) {
      const v = await verifyOffer(liveNode(tampered), tampered, { expectedRouter: EXPECTED_ROUTER });
      assert.equal(v.l2ContractVerification, "unverified");
      assert.equal(v.functionsBound, false);
    }
  });

  it("rejects changed salts and wrong application VK hashes in the body", async () => {
    const { pub } = buildPublication();
    const tamperedPublications: OfferPublication[] = [
      { ...pub, l2Contract: { ...pub.l2Contract, claimConfigurationSalt: fieldToHex(1n) } },
      { ...pub, l2Contract: { ...pub.l2Contract, reclaimConfigurationSalt: fieldToHex(1n) } },
      withFunction(pub, 0, { applicationVkHash: 1n }),
      withFunction(pub, 1, { applicationVkHash: 1n }),
    ];
    for (const tampered of tamperedPublications) {
      const verification = await verifyOffer(liveNode(tampered), tampered, { expectedRouter: EXPECTED_ROUTER });
      assert.equal(verification.l2ContractVerification, "unverified");
      assert.equal(verification.safeToPay, false);
    }
  });

  it("rejects malformed and incomplete contract bodies", async () => {
    const { pub } = buildPublication();
    const body = decodeContractBody(hexToBytes(pub.l2Contract.bodyHex as Hex));
    const variants = [
      { ...pub, l2Contract: { ...pub.l2Contract, bodyHex: "0x00" } },
      { ...pub, l2Contract: { ...pub.l2Contract, bodyHex: bytesToHex(encodeContractBody({ ...body, functions: body.functions.slice(0, 1) })) } },
      { ...pub, l2Contract: { ...pub.l2Contract, bodyHex: bytesToHex(encodeContractBody({
        ...body,
        functions: [...body.functions, { ...body.functions[1]!, selector: functionSelector(2) }],
      })) } },
    ] satisfies OfferPublication[];
    for (const variant of variants) {
      const verification = await verifyOffer(liveNode(pub), variant, { expectedRouter: EXPECTED_ROUTER, expectedNetwork: NETWORK });
      assert.equal(verification.l2ContractVerification, "unverified");
      assert.equal(verification.safeToPay, false);
    }
  });

  it("rejects an unapproved claim() implementation", async () => {
    // A seller can publish an internally consistent Smart Contract with a
    // substitute implementation, but the pinned VK hash still rejects it.
    const { pub } = buildPublication({}, { claim: CLAIM_APPLICATION_VK_HASH + 1n });
    const v = await verifyOffer(liveNode(pub), pub, { expectedRouter: EXPECTED_ROUTER });
    assert.equal(v.l2ContractVerification, "unverified");
    assert.ok(v.checks.some((c) => /claim(?:\(\)| function) does not use the approved application/i.test(c)));
  });

  it("rejects an unapproved reclaim() implementation", async () => {
    // A plain-ECDSA (un-timelocked) reclaim would let the seller drain the escrow
    // before T; pinning the reclaim VK hash rejects it.
    const { pub } = buildPublication({}, { reclaim: RECLAIM_APPLICATION_VK_HASH + 1n });
    const v = await verifyOffer(liveNode(pub), pub, { expectedRouter: EXPECTED_ROUTER });
    assert.equal(v.l2ContractVerification, "unverified");
    assert.ok(v.checks.some((c) => /reclaim\(\) does NOT use the approved application/.test(c)));
  });

  it("rejects a reclaim() that binds an earlier deadline than claim()", async () => {
    // Each function authenticates only its own configuration. A seller who
    // installs reclaim() with an earlier T could reclaim right after a payment
    // the router accepted against the advertised T.
    const { pub, terms } = buildPublication();
    const tampered = withFunction(pub, 1, {
      configurationCommitment: reclaimConfigurationCommitment(
        BigInt(pub.l2Contract.reclaimConfigurationSalt),
        NETWORK,
        BigInt(pub.reclaimAuthority),
        terms.id,
        terms.deadlineT - 2n * MIN_CLAIM_WINDOW_SECONDS,
      ),
    });
    const v = await verifyOffer(liveNode(tampered), tampered, { expectedRouter: EXPECTED_ROUTER });
    assert.equal(v.l2ContractVerification, "unverified");
    assert.equal(v.functionsBound, false);
    assert.ok(v.checks.some((c) => /reclaim\(\) configuration does NOT bind the advertised T/.test(c)));
  });

  it("rejects an offer whose reclaim authorization binds a different network", async () => {
    const { pub } = buildPublication();
    const alternateNetwork = { ...NETWORK, l1ChainId: NETWORK.l1ChainId + 1n };
    const v = await verifyOffer(liveNode(pub), pub, {
      expectedRouter: EXPECTED_ROUTER,
      expectedNetwork: alternateNetwork,
    });
    assert.equal(v.l2ContractVerification, "unverified");
    assert.equal(v.functionsBound, false);
    assert.ok(v.checks.some((c) => /reclaim\(\) configuration does NOT bind/.test(c)));
  });

  it("reports the L2 smart contract as not live when the node has no account", async () => {
    const { pub } = buildPublication();
    const emptyNode = {
      ...liveNode(pub),
      getContract: async (address: string) => ({ status: "notFound", address, authenticated: false }),
    } as unknown as PcashNodeClient;
    const v = await verifyOffer(emptyNode, pub, { expectedRouter: EXPECTED_ROUTER, expectedNetwork: NETWORK });
    assert.equal(v.l2ContractVerification, "verified"); // client-side contract verification is independent of node liveness
    assert.equal(v.liveOnNode, false);
  });

  it("keeps liveOnNode null and escrow unknown when the node is unreachable", async () => {
    const { pub } = buildPublication();
    const withEscrow: OfferPublication = {
      ...pub,
      escrow: { leafIndex: 3, noteSecret: fieldToHex(0x1n), amount: pub.terms.amount },
    };
    const downNode = {
      getWitnessSnapshot: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as PcashNodeClient;
    const v = await verifyOffer(downNode, withEscrow, { expectedRouter: EXPECTED_ROUTER, expectedNetwork: NETWORK });
    assert.equal(v.liveOnNode, null);
    assert.equal(v.escrow, "unknown");
    assert.equal(v.l2ContractVerification, "verified");
  });

});

describe("verifyOfferForPayment", () => {
  it("preserves verified router configuration and its fee quote when the escrow output is absent", async (t) => {
    const artifactPath = paymentRouterArtifactPath();
    if (!existsSync(artifactPath)) {
      t.skip("l1-contracts not built; run forge build in marketplace/l1-contracts");
      return;
    }
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      deployedBytecode: { object: Hex };
    };
    const runtimeCode = configurePaymentRouterRuntimeCode(
      artifact.deployedBytecode.object,
      ROUTER_CONFIG,
      GUARDIAN,
      123n,
    );
    const { pub } = buildPublication();
    const funded: OfferPublication = {
      ...pub,
      escrow: { leafIndex: 0, noteSecret: fieldToHex(0x44n), amount: pub.terms.amount },
    };
    const base = liveNode(pub);
    let outputPathCalls = 0;
    const node = {
      ...base as unknown as Record<string, unknown>,
      status: async () => ({
        ...await base.status(),
        genesisL1Block: 0n,
        genesisL1BlockHash: GENESIS_L1_HASH,
        latestBlock: SNAPSHOT_BLOCK,
        latestBlockHash: SNAPSHOT_HASH,
      }),
      getOutputPath: async () => {
        outputPathCalls += 1;
        return null;
      },
      getCurrentNullifierStatuses: async () => {
        throw new Error("nullifier status must not be read after semantic output absence");
      },
    } as unknown as PcashNodeClient;

    const verification = await withPaymentRouterRpc(runtimeCode, (l1Url) =>
      verifyOfferForPayment(node, funded, {
        expectedRouter: EXPECTED_ROUTER,
        expectedNetwork: NETWORK,
        l1Urls: [l1Url],
      })
    );

    // One PCASH snapshot decides the payment.
    assert.equal(outputPathCalls, 1);
    assert.equal(verification.routerConfigVerified, true);
    assert.deepEqual(verification.feeQuote, {
      buyerGrossWei: BigInt(pub.terms.ethPriceWei),
      websiteFeeWei: 2_500_000_000_000_000n,
      sellerNetWei: 47_500_000_000_000_000n,
      ...ROUTER_CONFIG,
    });
    assert.equal(verification.escrow, "opening-invalid");
    assert.equal(verification.safeToPay, false);
    assert.ok(verification.checks.some((check) => /selected L1 RPC hosts the approved PaymentRouter/.test(check)));
    assert.ok(verification.checks.some((check) => /escrow note is not in the node's commitment tree/.test(check)));
    assert.ok(!verification.checks.some((check) => /does NOT host the approved PaymentRouter/.test(check)));
  });
});

describe("payment node freshness", () => {
  const sharedDeployment = {
    deploymentBlock: 123n,
    config: ROUTER_CONFIG,
    runtimeCodeHash: `0x${"00".repeat(32)}` as Hex,
    runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
  };

  for (const lag of [-1n, 0n, 5n, 6n]) {
    it(`decides payment from the snapshot origin at ${lag} blocks of lag, even with a newer status`, async () => {
      const { funded, fundedNode } = fundedPublication();
      const snapshot = await fundedNode.getWitnessSnapshot({ contracts: [publicationContractAddress(funded)], outputs: [] });
      const node = {
        getWitnessSnapshot: async () => snapshot,
        status: async () => ({ ...snapshot.status, latestL1BlockNumber: L1_ORIGIN_BLOCK + 100n }),
      } as unknown as PcashNodeClient;
      const verification = await withPaymentRouterRpc("0x", l1Url => verifyOfferForPayment(node, funded, {
        expectedRouter: EXPECTED_ROUTER, expectedNetwork: NETWORK, l1Urls: [l1Url], routerDeployment: sharedDeployment,
      }), { head: () => L1_ORIGIN_BLOCK + lag });
      assert.equal(verification.safeToPay, lag <= 5n);
      assert.deepEqual(verification.claimSnapshot?.anchor, { blockNumber: L1_ORIGIN_BLOCK, blockHash: L1_ORIGIN_HASH });
      assert.equal(verification.routerConfigVerified, true);
      assert.ok(verification.checks.some(check => lag <= 5n
        ? /within 5 blocks/.test(check)
        : /6 L1 blocks behind.*maximum allowed lag is 5 blocks/.test(check)));
    });
  }

  it("reports a listing the router already records as paid, so no claim is proved for it", async () => {
    const { funded, fundedNode } = fundedPublication();
    const verify = (paid?: Hex) => withPaymentRouterRpc("0x", l1Url => verifyOfferForPayment(fundedNode, funded, {
      expectedRouter: EXPECTED_ROUTER, expectedNetwork: NETWORK, l1Urls: [l1Url], routerDeployment: sharedDeployment,
    }), paid === undefined ? {} : { paid });
    const unpaid = await verify();
    assert.equal(unpaid.routerPaid, false);
    assert.equal(unpaid.safeToPay, true);
    const paid = await verify(`0x${"77".repeat(32)}`);
    assert.equal(paid.routerPaid, true);
    assert.equal(paid.safeToPay, false);
    assert.ok(paid.checks.includes("the router already records a payment for this listing"));
  });

  it("preserves the verified router and fee quote when the selected L1 head is unavailable", async () => {
    const { funded, fundedNode } = fundedPublication();
    const verification = await withPaymentRouterRpc("0x", l1Url => verifyOfferForPayment(fundedNode, funded, {
      expectedRouter: EXPECTED_ROUTER, expectedNetwork: NETWORK, l1Urls: [l1Url], routerDeployment: sharedDeployment,
    }), { head: () => null });
    assert.equal(verification.safeToPay, false);
    assert.equal(verification.routerConfigVerified, true);
    assert.equal(verification.feeQuote?.buyerGrossWei, BigInt(funded.terms.ethPriceWei));
    assert.ok(verification.checks.some(check => /node freshness unavailable.*L1 head unavailable/s.test(check)));
  });

  for (const scenario of ["stalled", "at limit", "caught up", "node unavailable", "L1 unavailable"] as const) {
    it(`refreshes node and L1 after estimation before broadcasting: ${scenario}`, async (t) => {
      const artifactPath = paymentRouterArtifactPath();
      if (!existsSync(artifactPath)) {
        t.skip("l1-contracts not built; run forge build in marketplace/l1-contracts");
        return;
      }
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { deployedBytecode: { object: Hex } };
      const runtimeCode = configurePaymentRouterRuntimeCode(artifact.deployedBytecode.object, ROUTER_CONFIG, GUARDIAN, 123n);
      const { funded, fundedNode } = fundedPublication();
      const profile = derivePcashProfileFromPrivateKey(SELLER_KEY, NETWORK);
      let estimated = false;
      let statusReads = 0;
      let finalHeadReads = 0;
      let broadcastRequested = false;
      let sent = false;
      let head = L1_ORIGIN_BLOCK + 1n;
      const node = {
        ...fundedNode,
        status: async () => {
          statusReads += 1;
          if (estimated && scenario === "node unavailable") throw new Error("node status unavailable");
          return {
            ...await fundedNode.status(),
            latestL1BlockNumber: estimated && scenario === "caught up" ? L1_ORIGIN_BLOCK + 1n : L1_ORIGIN_BLOCK,
          };
        },
      } as unknown as PcashNodeClient;
      const methods: string[] = [];
      await withPaymentRouterRpc(runtimeCode, async l1Url => {
        const verification = await verifyOfferForPayment(node, funded, {
          expectedRouter: EXPECTED_ROUTER, expectedNetwork: NETWORK, l1Urls: [l1Url],
        });
        assert.equal(verification.safeToPay, true);
        const call = buildBuyCall(funded, profile, {
          anchor: verification.claimSnapshot!.anchor, notAfter: 4_000_000_000n, batch: claimBatchStandIn(),
        });
        statusReads = 0;
        methods.length = 0;
        const payment = sendRouterCall(node, [l1Url], {
          address: GUARDIAN,
          chainId: async () => NETWORK.l1ChainId,
          sendTransaction: async transaction => {
            assert.equal(broadcastRequested, true);
            assert.equal(transaction.gas, 70_000n);
            sent = true;
            return PAYMENT_HASH;
          },
        }, call, {
          onBroadcastRequested: () => {
            assert.equal(estimated, true);
            assert.equal(statusReads, 2);
            assert.equal(finalHeadReads, 1);
            broadcastRequested = true;
          },
        });
        if (scenario === "at limit" || scenario === "caught up") {
          assert.deepEqual(await payment, { hash: PAYMENT_HASH, blockNumber: L1_ORIGIN_BLOCK + 10n, blockHash: L1_ORIGIN_HASH });
          assert.equal(sent, true);
        } else {
          await assert.rejects(payment, scenario === "stalled"
            ? /6 L1 blocks behind.*maximum allowed lag is 5 blocks/
            : scenario === "node unavailable" ? /node status unavailable/ : /L1 head unavailable/);
          assert.equal(broadcastRequested, false);
          assert.equal(sent, false);
        }
        assert.equal(statusReads, 2);
        if (scenario !== "node unavailable") {
          assert.ok(finalHeadReads >= 1);
          assert.ok(methods.lastIndexOf("eth_blockNumber") > methods.indexOf("eth_estimateGas"));
        }
      }, {
        methods,
        onEstimate: () => {
          estimated = true;
          head = L1_ORIGIN_BLOCK + (scenario === "at limit" ? 5n : 6n);
        },
        head: () => {
          if (estimated) finalHeadReads += 1;
          return estimated && scenario === "L1 unavailable" ? null : head;
        },
      });
    });
  }
});
