import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { DEFAULT_NETWORK_CONFIG, type StatusResult } from "@pcash/sdk/browser";
import {
  assertNodeL1Identity,
  assertPaymentRouterCode,
  assertPaymentRouterDeployment,
  configurePaymentRouterRuntimeCode,
  normalizePaymentRouterConfig,
  quotePaymentRouterFee,
  PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
  type PaymentRouterConfig,
} from "../src/client/paymentRouter.ts";

const ROUTER = "0x00000000000000000000000000000000000000aa" as Address;
const GUARDIAN = "0x00000000000000000000000000000000000000bb" as Address;
const GENESIS_HASH = `0x${"11".repeat(32)}`;
const ROUTER_CONFIG: PaymentRouterConfig = {
  feeRecipient: "0x00000000000000000000000000000000000000fe",
  feeBps: 500,
};

function artifactPath(): string {
  return join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..", "l1-contracts", "out", "PaymentRouter.sol", "PaymentRouter.json",
  );
}

function status(overrides: Partial<Pick<StatusResult, "l1ChainId" | "genesisL1Block" | "genesisL1BlockHash">> = {}) {
  return {
    l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId,
    genesisL1Block: 7n,
    genesisL1BlockHash: GENESIS_HASH,
    ...overrides,
  };
}

function l1Client(chainId: number, genesisHash: string) {
  return {
    getChainId: async () => chainId,
    getBlock: async () => ({ hash: genesisHash }),
  } as unknown as Pick<PublicClient, "getChainId" | "getBlock">;
}

describe("PaymentRouter deployment verification", () => {
  it("pins the runtime code hash of the checked-in contract source", (t) => {
    const artifact = artifactPath();
    if (!existsSync(artifact)) {
      if (process.env.PCASH_REQUIRE_L1_ARTIFACTS === "1") {
        throw new Error(
          "PCASH_REQUIRE_L1_ARTIFACTS=1 but l1-contracts/out is missing, so the runtime code hash pin was never checked; run forge build in marketplace/l1-contracts",
        );
      }
      t.skip("l1-contracts not built; run forge build in marketplace/l1-contracts");
      return;
    }
    const runtime = JSON.parse(readFileSync(artifact, "utf8")).deployedBytecode.object as Hex;
    assert.equal(
      keccak256(runtime),
      PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
      "PaymentRouter.sol changed: re-pin PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH and redeploy configured routers",
    );
  });

  it("rejects an address with no runtime code", () => {
    assert.throws(() => assertPaymentRouterCode(ROUTER, "0x", ROUTER_CONFIG), /has no contract code/);
  });

  it("requires the exact approved runtime template and immutable fee configuration", (t) => {
    const artifact = artifactPath();
    if (!existsSync(artifact)) {
      t.skip("l1-contracts not built; run forge build in marketplace/l1-contracts");
      return;
    }
    const runtimeTemplate = JSON.parse(readFileSync(artifact, "utf8")).deployedBytecode.object as Hex;
    const approvedCode = configurePaymentRouterRuntimeCode(runtimeTemplate, ROUTER_CONFIG, GUARDIAN, 123n);
    assert.doesNotThrow(() => assertPaymentRouterCode(ROUTER, approvedCode, ROUTER_CONFIG));
    assert.throws(
      () => assertPaymentRouterCode(ROUTER, approvedCode, { ...ROUTER_CONFIG, feeBps: 501 }),
      /does not embed the expected fee BPS/,
    );
    const mutated = `${approvedCode.slice(0, -2)}${approvedCode.endsWith("00") ? "01" : "00"}` as Hex;
    assert.throws(() => assertPaymentRouterCode(ROUTER, mutated, ROUTER_CONFIG), /runtime template hash.*expected/);
  });

  it("accepts deployment-specific guardian and block while pinning fees", (t) => {
    const artifact = artifactPath();
    if (!existsSync(artifact)) {
      t.skip("l1-contracts not built; run forge build in marketplace/l1-contracts");
      return;
    }
    const runtimeTemplate = JSON.parse(readFileSync(artifact, "utf8")).deployedBytecode.object as Hex;
    const otherGuardian = "0x00000000000000000000000000000000000000cc" as Address;
    const code = configurePaymentRouterRuntimeCode(runtimeTemplate, ROUTER_CONFIG, GUARDIAN, 123n);
    const otherCode = configurePaymentRouterRuntimeCode(runtimeTemplate, ROUTER_CONFIG, otherGuardian, 456n);
    assert.notEqual(code, otherCode);
    assert.doesNotThrow(() => assertPaymentRouterCode(ROUTER, code, ROUTER_CONFIG));
    assert.doesNotThrow(() => assertPaymentRouterCode(ROUTER, otherCode, ROUTER_CONFIG));
    assert.throws(
      () => assertPaymentRouterCode(ROUTER, otherCode, { ...ROUTER_CONFIG, feeRecipient: otherGuardian }),
      /does not embed the expected fee recipient/,
    );
  });

  it("reads fee terms and the deployment block from a verified router", async (t) => {
    const artifact = artifactPath();
    if (!existsSync(artifact)) {
      t.skip("l1-contracts not built; run forge build in marketplace/l1-contracts");
      return;
    }
    const runtimeTemplate = JSON.parse(readFileSync(artifact, "utf8")).deployedBytecode.object as Hex;
    const deployedConfig = { feeRecipient: GUARDIAN, feeBps: 250 };
    const code = configurePaymentRouterRuntimeCode(runtimeTemplate, deployedConfig, GUARDIAN, 123n);
    const client = {
      getCode: async () => code,
      readContract: async ({ functionName }: { functionName: string }) => functionName === "feeRecipient"
        ? deployedConfig.feeRecipient : functionName === "deploymentBlock" ? 123n : deployedConfig.feeBps,
    } as unknown as Pick<PublicClient, "getCode" | "readContract">;
    const verified = await assertPaymentRouterDeployment(client, ROUTER);
    assert.deepEqual(verified.config, normalizePaymentRouterConfig(deployedConfig));
    assert.equal(verified.deploymentBlock, 123n);
    assert.equal(verified.runtimeCodeHash, keccak256(code));
    const inconsistentClient = {
      ...client,
      readContract: async ({ functionName }: { functionName: string }) => functionName === "feeRecipient"
        ? ROUTER_CONFIG.feeRecipient : functionName === "deploymentBlock" ? 123n : deployedConfig.feeBps,
    } as unknown as Pick<PublicClient, "getCode" | "readContract">;
    await assert.rejects(assertPaymentRouterDeployment(inconsistentClient, ROUTER), /does not embed the expected fee recipient/);
  });

  it("normalizes the required configuration and quotes the contract's floor rounding", () => {
    const config = normalizePaymentRouterConfig(ROUTER_CONFIG);
    assert.equal(config.feeBps, 500);
    assert.deepEqual(quotePaymentRouterFee(19n, config), {
      buyerGrossWei: 19n,
      websiteFeeWei: 0n,
      sellerNetWei: 19n,
      ...config,
    });
    assert.equal(quotePaymentRouterFee(20n, config).websiteFeeWei, 1n);
    assert.throws(
      () => normalizePaymentRouterConfig({ feeRecipient: ROUTER_CONFIG.feeRecipient, feeBps: 0 }),
      /between 1 and 9999/,
    );
    assert.throws(
      () => normalizePaymentRouterConfig({ feeRecipient: ROUTER_CONFIG.feeRecipient, feeBps: 10_000 }),
      /between 1 and 9999/,
    );
  });

  it("binds the selected RPC to both the node's L1 chain and genesis anchor", async () => {
    const chainId = Number(DEFAULT_NETWORK_CONFIG.l1ChainId);
    assert.equal(await assertNodeL1Identity(l1Client(chainId, GENESIS_HASH), status()), chainId);
    await assert.rejects(
      assertNodeL1Identity(l1Client(chainId, `0x${"22".repeat(32)}`), status()),
      /does not match.*genesis anchor/,
    );
    await assert.rejects(
      assertNodeL1Identity(l1Client(chainId, GENESIS_HASH), status({
        l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId + 1n,
      })),
      /node follows L1 chain/,
    );
  });
});
