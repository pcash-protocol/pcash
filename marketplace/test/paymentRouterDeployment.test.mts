import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  getAddress,
  getContractAddress,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  configurePaymentRouterRuntimeCode,
  PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
  type PaymentRouterConfig,
} from "../src/client/paymentRouter.ts";
import {
  deployPaymentRouter,
  loadPaymentRouterArtifact,
  paymentRouterArtifactPath,
  paymentRouterCreationCode,
  resolvePaymentRouter,
  type PaymentRouterArtifact,
  type PaymentRouterDeploymentPlan,
  type PaymentRouterDeploymentRequest,
} from "../src/tooling/paymentRouterDeployment.mts";

const L1_CHAIN_ID = 11_155_111;
const OTHER_L1_CHAIN_ID = 1;
const DEPLOYER_ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const DEPLOYER = DEPLOYER_ACCOUNT.address;
const NONCE = 7;
const ROUTER = getContractAddress({ from: DEPLOYER, nonce: BigInt(NONCE) });
const OTHER_ROUTER = "0x00000000000000000000000000000000000000AA" as Address;
const ROUTER_CONFIG: PaymentRouterConfig = {
  feeRecipient: "0x00000000000000000000000000000000000000fe",
  feeBps: 500,
};
const NORMALIZED_ROUTER_CONFIG: PaymentRouterConfig = {
  ...ROUTER_CONFIG,
  feeRecipient: getAddress(ROUTER_CONFIG.feeRecipient),
};
const OTHER_ROUTER_CONFIG: PaymentRouterConfig = {
  feeRecipient: "0x00000000000000000000000000000000000000fd",
  feeBps: 500,
};

function deployedCode(
  artifact: PaymentRouterArtifact,
  config: PaymentRouterConfig = ROUTER_CONFIG,
): Hex {
  return configurePaymentRouterRuntimeCode(artifact.runtimeBytecode, config, DEPLOYER, 91n);
}

type RouterClient = Pick<
  PublicClient,
  | "estimateGas"
  | "getChainId"
  | "getCode"
  | "getTransaction"
  | "getTransactionCount"
  | "getTransactionReceipt"
  | "readContract"
  | "waitForTransactionReceipt"
>;

async function cachePath(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "pcash-payment-router-")), "deployments.json");
}

async function builtArtifact(t: TestContext): Promise<PaymentRouterArtifact | undefined> {
  const artifactPath = paymentRouterArtifactPath();
  if (!existsSync(artifactPath)) {
    t.skip("l1-contracts not built; run forge build in marketplace/l1-contracts");
    return undefined;
  }
  return loadPaymentRouterArtifact(artifactPath);
}

function client(options: {
  l1ChainId?: number;
  code?: Hex | ((address: Address) => Hex);
  receipt?: { status: "success" | "reverted"; contractAddress?: Address | null; blockNumber: bigint };
  reconciledReceipt?: { status: "success" | "reverted"; contractAddress?: Address | null; blockNumber: bigint; transactionHash: Hex } | null;
  transaction?: {
    from: Address;
    nonce: number;
    to: Address | null;
    input: Hex;
  } | null;
  latestNonce?: number;
  pendingNonce?: number;
  onWait?: (hash: Hex) => void | Promise<void>;
  onEstimate?: (request: { account: Address; data: Hex }) => void;
  reportedConfig?: PaymentRouterConfig;
} = {}): RouterClient {
  const reportedConfig = options.reportedConfig ?? ROUTER_CONFIG;
  return {
    estimateGas: async (request: { account: Address; data: Hex }) => {
      options.onEstimate?.(request);
      return 123n;
    },
    getChainId: async () => options.l1ChainId ?? L1_CHAIN_ID,
    getCode: async ({ address }: { address: Address }) => typeof options.code === "function"
      ? options.code(address)
      : (options.code ?? "0x"),
    getTransactionCount: async ({ blockTag }: { blockTag?: string }) => blockTag === "pending"
      ? (options.pendingNonce ?? NONCE)
      : (options.latestNonce ?? NONCE),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (options.reconciledReceipt === undefined || options.reconciledReceipt === null) {
        throw new TransactionReceiptNotFoundError({ hash });
      }
      return options.reconciledReceipt;
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (options.transaction === undefined || options.transaction === null) {
        throw new TransactionNotFoundError({ hash });
      }
      return options.transaction;
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "feeRecipient") return reportedConfig.feeRecipient;
      if (functionName === "deploymentBlock") return 91n;
      if (functionName === "feeBps") return reportedConfig.feeBps;
      throw new Error(`unexpected contract read ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      await options.onWait?.(hash);
      return {
        status: options.receipt?.status ?? "success",
        contractAddress: options.receipt?.contractAddress === undefined ? ROUTER : options.receipt.contractAddress,
        blockNumber: options.receipt?.blockNumber ?? 91n,
        transactionHash: hash,
      };
    },
  } as unknown as RouterClient;
}

async function leaveSignedPending(artifact: PaymentRouterArtifact, destination: string): Promise<TransactionSerialized> {
  let signed: TransactionSerialized | undefined;
  await assert.rejects(
    deployPaymentRouter({
      client: client(),
      cachePath: destination,
      deployer: DEPLOYER,
      routerConfig: ROUTER_CONFIG,
      artifact,
      maxFeePerGas: 9n,
      maxPriorityFeePerGas: 2n,
      ...deploymentCallbacks({
        broadcast: async (serializedTransaction) => {
          signed = serializedTransaction;
          throw new Error("simulated interruption before broadcast");
        },
      }),
    }),
    /simulated interruption/,
  );
  assert.ok(signed !== undefined);
  return signed;
}

function deploymentCallbacks(overrides: {
  sign?: (request: PaymentRouterDeploymentRequest) => Promise<TransactionSerialized>;
  broadcast?: (serializedTransaction: TransactionSerialized) => Promise<Hex>;
} = {}) {
  return {
    sign: overrides.sign ?? (async (request: PaymentRouterDeploymentRequest) => DEPLOYER_ACCOUNT.signTransaction({
      chainId: L1_CHAIN_ID,
      type: "eip1559",
      nonce: request.nonce,
      gas: request.gas,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      data: request.bytecode,
    }) as Promise<TransactionSerialized>),
    broadcast: overrides.broadcast ?? (async (serializedTransaction: TransactionSerialized) => keccak256(serializedTransaction)),
  };
}

describe("PaymentRouter resolution", () => {
  it("uses an explicit address only after exact runtime verification", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const ready = await resolvePaymentRouter({
      client: client({ code: deployedCode(artifact) }),
      cachePath: await cachePath(),
      explicitAddress: ROUTER,
      expectedL1ChainId: L1_CHAIN_ID,
    });
    assert.deepEqual(ready, {
      kind: "ready",
      source: "explicit",
      l1ChainId: L1_CHAIN_ID,
      address: ROUTER,
      routerConfig: NORMALIZED_ROUTER_CONFIG,
      runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
      runtimeCodeHash: keccak256(deployedCode(artifact)),
    });
  });

  it("accepts the explicit router's embedded fees and rejects inconsistent code", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const otherFeeRecipient = await resolvePaymentRouter({
        client: client({
          code: deployedCode(artifact, OTHER_ROUTER_CONFIG),
          reportedConfig: OTHER_ROUTER_CONFIG,
        }),
        cachePath: await cachePath(),
        explicitAddress: ROUTER,
        expectedL1ChainId: L1_CHAIN_ID,
      });
    assert.equal(otherFeeRecipient.kind, "ready");
    if (otherFeeRecipient.kind === "ready") assert.equal(otherFeeRecipient.routerConfig.feeRecipient, getAddress(OTHER_ROUTER_CONFIG.feeRecipient));
    const otherFeeBps = await resolvePaymentRouter({
        client: client({
          code: deployedCode(artifact, { ...ROUTER_CONFIG, feeBps: 501 }),
          reportedConfig: { ...ROUTER_CONFIG, feeBps: 501 },
        }),
        cachePath: await cachePath(),
        explicitAddress: ROUTER,
        expectedL1ChainId: L1_CHAIN_ID,
      });
    assert.equal(otherFeeBps.kind, "ready");
    if (otherFeeBps.kind === "ready") assert.equal(otherFeeBps.routerConfig.feeBps, 501);
    await assert.rejects(
      resolvePaymentRouter({
        client: client({ code: deployedCode(artifact), reportedConfig: OTHER_ROUTER_CONFIG }),
        cachePath: await cachePath(),
        explicitAddress: ROUTER,
        expectedL1ChainId: L1_CHAIN_ID,
        routerConfig: ROUTER_CONFIG,
      }),
      /does not embed the expected fee recipient/,
    );
  });

  it("rejects an explicit address with no contract code", async () => {
    await assert.rejects(
      resolvePaymentRouter({
        client: client(),
        cachePath: await cachePath(),
        explicitAddress: ROUTER,
        routerConfig: ROUTER_CONFIG,
      }),
      /has no contract code/,
    );
  });

  it("rejects a selected RPC on the wrong chain before reading addresses", async () => {
    await assert.rejects(
      resolvePaymentRouter({
        client: client({ l1ChainId: OTHER_L1_CHAIN_ID }),
        cachePath: await cachePath(),
        expectedL1ChainId: L1_CHAIN_ID,
        routerConfig: ROUTER_CONFIG,
      }),
      /chain 1, expected chain 11155111/,
    );
  });
});

describe("PaymentRouter deployment and cache", () => {
  it("reports the estimated plan, deploys, verifies, and atomically records a chain/hash-keyed address", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    let observedPlan: PaymentRouterDeploymentPlan | undefined;
    let submittedRequest: PaymentRouterDeploymentRequest | undefined;
    let estimateRequest: { account: Address; data: Hex } | undefined;
    const ready = await deployPaymentRouter({
      client: client({ code: deployedCode(artifact), onEstimate: (request) => { estimateRequest = request; } }),
      cachePath: destination,
      deployer: DEPLOYER,
      routerConfig: ROUTER_CONFIG,
      artifact,
      expectedL1ChainId: L1_CHAIN_ID,
      maxFeePerGas: 9n,
      maxPriorityFeePerGas: 2n,
      onPlan: (plan) => { observedPlan = plan; },
      ...deploymentCallbacks({
        sign: async (request) => {
          submittedRequest = request;
          return DEPLOYER_ACCOUNT.signTransaction({
            chainId: L1_CHAIN_ID,
            type: "eip1559",
            nonce: request.nonce,
            gas: request.gas,
            maxFeePerGas: request.maxFeePerGas,
            maxPriorityFeePerGas: request.maxPriorityFeePerGas,
            data: request.bytecode,
          }) as Promise<TransactionSerialized>;
        },
      }),
    });

    assert.deepEqual(estimateRequest, {
      account: DEPLOYER,
      data: paymentRouterCreationCode(artifact, ROUTER_CONFIG, DEPLOYER),
    });
    assert.equal(submittedRequest?.bytecode, estimateRequest?.data);
    assert.equal(observedPlan?.gas, 123n);
    assert.equal(observedPlan?.maximumCostWei, 1_107n);
    assert.equal(observedPlan?.l1ChainId, L1_CHAIN_ID);
    assert.equal(observedPlan?.expectedRuntimeTemplateHash, PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH);
    assert.deepEqual(observedPlan?.routerConfig, NORMALIZED_ROUTER_CONFIG);
    assert.notEqual(submittedRequest?.bytecode, artifact.bytecode);
    assert.deepEqual(submittedRequest?.routerConfig, observedPlan?.routerConfig);
    const runtimeCodeHash = keccak256(deployedCode(artifact));
    const normalizedConfig = observedPlan!.routerConfig;
    assert.deepEqual(ready, {
      kind: "ready",
      source: "deployed",
      l1ChainId: L1_CHAIN_ID,
      address: ROUTER,
      routerConfig: normalizedConfig,
      runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
      runtimeCodeHash,
      deployment: {
        l1ChainId: String(L1_CHAIN_ID),
        runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
        runtimeCodeHash,
        ...normalizedConfig,
        address: ROUTER,
        deployer: DEPLOYER,
        deploymentNonce: String(NONCE),
        deploymentTxHash: ready.deployment?.deploymentTxHash,
        deploymentBlock: "91",
      },
    });

    const cached = JSON.parse(await readFile(destination, "utf8")) as {
      deployments: Record<string, { address: Address }>;
    };
    const cacheKey = `${L1_CHAIN_ID}:${PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH}:${ROUTER_CONFIG.feeRecipient}:${ROUTER_CONFIG.feeBps}`;
    assert.equal(cached.deployments[cacheKey]?.address, ROUTER);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.deepEqual(
      await resolvePaymentRouter({
        client: client({ code: deployedCode(artifact) }),
        cachePath: destination,
        routerConfig: ROUTER_CONFIG,
      }),
      { ...ready, source: "cache" },
    );
    assert.equal(
      (await resolvePaymentRouter({
        client: client({ l1ChainId: OTHER_L1_CHAIN_ID, code: deployedCode(artifact) }),
        cachePath: destination,
        routerConfig: ROUTER_CONFIG,
      })).kind,
      "deployment-required",
    );
  });

  it("treats cached records with a mismatched runtime binding or deployed code as stale", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    const key = `${L1_CHAIN_ID}:${PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH}:${ROUTER_CONFIG.feeRecipient}:${ROUTER_CONFIG.feeBps}`;
    const record = {
      l1ChainId: String(L1_CHAIN_ID),
      runtimeTemplateHash: `0x${"33".repeat(32)}`,
      runtimeCodeHash: `0x${"33".repeat(32)}`,
      ...ROUTER_CONFIG,
      address: ROUTER,
      deploymentTxHash: `0x${"22".repeat(32)}`,
      deploymentBlock: "91",
      deployer: DEPLOYER,
      deploymentNonce: String(NONCE),
    };
    await writeFile(destination, `${JSON.stringify({ version: 1, deployments: { [key]: record } })}\n`);
    const wrongBinding = await resolvePaymentRouter({
      client: client({ code: deployedCode(artifact) }),
      cachePath: destination,
      routerConfig: ROUTER_CONFIG,
    });
    assert.equal(wrongBinding.kind, "deployment-required");
    if (wrongBinding.kind !== "deployment-required") return;
    assert.match(wrongBinding.reason, /not bound/);

    record.runtimeTemplateHash = PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH;
    record.runtimeCodeHash = keccak256(deployedCode(artifact));
    await writeFile(destination, `${JSON.stringify({ version: 1, deployments: { [key]: record } })}\n`);
    const wrongCode = await resolvePaymentRouter({ client: client(), cachePath: destination, routerConfig: ROUTER_CONFIG });
    assert.equal(wrongCode.kind, "deployment-required");
    if (wrongCode.kind !== "deployment-required") return;
    assert.match(wrongCode.reason, /is stale:.*has no contract code/);
  });

  it("rejects an invalid deployment fee cap before reporting a plan or signing", async () => {
    let planned = false;
    let submitted = false;
    await assert.rejects(
      deployPaymentRouter({
        client: client(),
        cachePath: await cachePath(),
        deployer: DEPLOYER,
        routerConfig: ROUTER_CONFIG,
        maxFeePerGas: 9n,
        maxPriorityFeePerGas: 10n,
        onPlan: () => { planned = true; },
        sign: async () => {
          submitted = true;
          throw new Error("unexpected sign");
        },
        broadcast: async () => { throw new Error("unexpected broadcast"); },
      }),
      /must be between zero and maxFeePerGas/,
    );
    assert.equal(planned, false);
    assert.equal(submitted, false);
  });

  it("refuses an artifact whose declared runtime hash is not the pinned router", async () => {
    const wrongRuntime = "0x6001600055" as Hex;
    let planned = false;
    await assert.rejects(
      deployPaymentRouter({
        client: client(),
        cachePath: await cachePath(),
        deployer: DEPLOYER,
        routerConfig: ROUTER_CONFIG,
        artifact: {
          abi: [],
          bytecode: "0x60" as Hex,
          runtimeBytecode: wrongRuntime,
          runtimeTemplateHash: keccak256(wrongRuntime),
        },
        maxFeePerGas: 9n,
        maxPriorityFeePerGas: 2n,
        onPlan: () => { planned = true; },
        sign: async () => { throw new Error("unexpected sign"); },
        broadcast: async () => { throw new Error("unexpected broadcast"); },
      }),
      /refusing to deploy.*runtime template hash/,
    );
    assert.equal(planned, false);
  });

  it("atomically records the exact signed transaction before broadcasting", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    const serializedTransaction = await leaveSignedPending(artifact, destination);
    const cached = JSON.parse(await readFile(destination, "utf8")) as {
      pendingDeployments: Record<string, {
        nonce: string;
        expectedAddress: Address;
        deploymentTxHash: Hex;
        serializedTransaction: TransactionSerialized;
      }>;
    };
    const pending = Object.values(cached.pendingDeployments)[0];
    assert.ok(pending !== undefined);
    assert.equal(pending.nonce, String(NONCE));
    assert.equal(pending.expectedAddress, ROUTER);
    assert.equal(pending.deploymentTxHash, keccak256(serializedTransaction));
    assert.equal(pending.serializedTransaction, serializedTransaction);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
  });

  it("reconciles a mined pending deployment and verifies its code without broadcasting again", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    const serializedTransaction = await leaveSignedPending(artifact, destination);
    const deploymentTxHash = keccak256(serializedTransaction);
    const ready = await resolvePaymentRouter({
      client: client({
        code: deployedCode(artifact),
        reconciledReceipt: {
          status: "success",
          contractAddress: ROUTER,
          blockNumber: 92n,
          transactionHash: deploymentTxHash,
        },
      }),
      cachePath: destination,
      routerConfig: ROUTER_CONFIG,
    });
    assert.equal(ready.kind, "ready");
    if (ready.kind !== "ready") return;
    assert.equal(ready.address, ROUTER);
    assert.equal(ready.deployment?.deploymentTxHash, deploymentTxHash);
    const cached = JSON.parse(await readFile(destination, "utf8")) as { pendingDeployments: Record<string, unknown> };
    assert.deepEqual(cached.pendingDeployments, {});
  });

  it("fails closed while the exact deployment transaction remains pending", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    const serializedTransaction = await leaveSignedPending(artifact, destination);
    let broadcasted = false;
    await assert.rejects(
      deployPaymentRouter({
        client: client({
          transaction: {
            from: DEPLOYER,
            nonce: NONCE,
            to: null,
            input: paymentRouterCreationCode(artifact, ROUTER_CONFIG, DEPLOYER),
          },
        }),
        cachePath: destination,
        routerConfig: ROUTER_CONFIG,
        deployer: DEPLOYER,
        artifact,
        maxFeePerGas: 9n,
        maxPriorityFeePerGas: 2n,
        ...deploymentCallbacks({
          broadcast: async () => {
            broadcasted = true;
            return keccak256(serializedTransaction);
          },
        }),
      }),
      /is still pending; refusing another deployment/,
    );
    assert.equal(broadcasted, false);
  });

  it("uses an explicit address even when a local deployment is unresolved", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    await leaveSignedPending(artifact, destination);
    const ready = await resolvePaymentRouter({
        client: client({ code: (address) => address === OTHER_ROUTER ? deployedCode(artifact) : "0x" }),
        cachePath: destination,
        explicitAddress: OTHER_ROUTER,
      });
    assert.equal(ready.kind, "ready");
    if (ready.kind === "ready") assert.equal(ready.address, OTHER_ROUTER);
  });

  it("does not ignore an unresolved deployment after the pinned runtime changes", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    await leaveSignedPending(artifact, destination);
    const cached = JSON.parse(await readFile(destination, "utf8")) as {
      version: 1;
      deployments: Record<string, unknown>;
      pendingDeployments: Record<string, { runtimeTemplateHash: Hex; feeRecipient: Address; feeBps: number }>;
    };
    const [key, pending] = Object.entries(cached.pendingDeployments)[0]!;
    delete cached.pendingDeployments[key];
    const oldRuntimeHash = `0x${"44".repeat(32)}` as Hex;
    pending.runtimeTemplateHash = oldRuntimeHash;
    cached.pendingDeployments[
      `${L1_CHAIN_ID}:${oldRuntimeHash}:${pending.feeRecipient.toLowerCase()}:${pending.feeBps}:${DEPLOYER.toLowerCase()}`
    ] = pending;
    await writeFile(destination, `${JSON.stringify(cached, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(
      resolvePaymentRouter({ client: client(), cachePath: destination, routerConfig: ROUTER_CONFIG }),
      /targets a different runtime; reconcile it before deploying the current router/,
    );
  });

  it("rebroadcasts the identical signed transaction when it is absent and its nonce is unused", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    const serializedTransaction = await leaveSignedPending(artifact, destination);
    let broadcasted: TransactionSerialized | undefined;
    const ready = await deployPaymentRouter({
      client: client({ code: () => broadcasted === undefined ? "0x" : deployedCode(artifact) }),
      cachePath: destination,
      deployer: DEPLOYER,
      routerConfig: ROUTER_CONFIG,
      artifact,
      maxFeePerGas: 9n,
      maxPriorityFeePerGas: 2n,
      onPlan: () => { throw new Error("recovered transaction must not be planned again"); },
      ...deploymentCallbacks({
        sign: async () => { throw new Error("recovered transaction must not be signed again"); },
        broadcast: async (value) => {
          broadcasted = value;
          return keccak256(value);
        },
      }),
    });
    assert.equal(broadcasted, serializedTransaction);
    assert.equal(ready.address, ROUTER);
  });

  it("refuses to rebroadcast a saved transaction for different creation code", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    await leaveSignedPending(artifact, destination);
    let broadcasted = false;
    await assert.rejects(
      deployPaymentRouter({
        client: client(),
        cachePath: destination,
        deployer: DEPLOYER,
        routerConfig: ROUTER_CONFIG,
        artifact: { ...artifact, bytecode: "0x6001" },
        maxFeePerGas: 9n,
        maxPriorityFeePerGas: 2n,
        onPlan: () => { throw new Error("recovered transaction must not be planned again"); },
        ...deploymentCallbacks({
          sign: async () => { throw new Error("recovered transaction must not be signed again"); },
          broadcast: async (value) => {
            broadcasted = true;
            return keccak256(value);
          },
        }),
      }),
      /does not contain the current PaymentRouter creation code/,
    );
    assert.equal(broadcasted, false);
  });

  it("clears a reverted terminal attempt but does not redeploy in the same run", async (t) => {
    const artifact = await builtArtifact(t);
    if (artifact === undefined) return;
    const destination = await cachePath();
    const serializedTransaction = await leaveSignedPending(artifact, destination);
    await assert.rejects(
      resolvePaymentRouter({
        client: client({
          reconciledReceipt: {
            status: "reverted",
            contractAddress: null,
            blockNumber: 93n,
            transactionHash: keccak256(serializedTransaction),
          },
        }),
        cachePath: destination,
        routerConfig: ROUTER_CONFIG,
      }),
      /reverted;.*cleared, rerun/,
    );
    const cached = JSON.parse(await readFile(destination, "utf8")) as { pendingDeployments: Record<string, unknown> };
    assert.deepEqual(cached.pendingDeployments, {});
    assert.equal((await resolvePaymentRouter({
      client: client(),
      cachePath: destination,
      routerConfig: ROUTER_CONFIG,
    })).kind, "deployment-required");
  });
});
