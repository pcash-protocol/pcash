import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  forgeDeploymentArgs,
  forgeDeploymentEnvironment,
  forgeDeploymentRecord,
  forgeSourceVerificationArgs,
  forgeSourceVerificationEnvironment,
  paymentRouterConstructorArgs,
  parsePaymentRouterEnvironment,
  paymentRouterOperatorConfig,
  vercelPaymentRouterVariables,
} from "../src/tooling/paymentRouterOperator.mts";

const ADDRESS = "0x00000000000000000000000000000000000000AA";
const RECIPIENT = "0x00000000000000000000000000000000000000fe";
const GUARDIAN = "0x00000000000000000000000000000000000006A4";
const HASH = `0x${"12".repeat(32)}`;

function environment(overrides: Record<string, string> = {}) {
  return {
    PCASH_L1_RPC: "https://sepolia.example",
    PCASH_L1_CHAIN_ID: "11155111",
    PCASH_PAYMENT_ROUTER_GUARDIAN: GUARDIAN,
    PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: RECIPIENT,
    PCASH_PAYMENT_ROUTER_FEE_BPS: "500",
    PCASH_L1_MAX_FEE_PER_GAS: "10000000000",
    PCASH_PAYMENT_ROUTER_ADDRESS: "",
    ...overrides,
  };
}

function environmentFile(overrides: Record<string, string> = {}) {
  return Object.entries(environment(overrides)).map(([key, value]) => `export ${key}=${value}`).join("\n");
}

describe("PaymentRouter operator workflow", () => {
  it("uses one selected funded-key file despite conflicting inherited networks", () => {
    const inherited = Object.fromEntries([
      "PCASH_L1_CHAIN_ID", "PCASH_L1_RPC", "PCASH_L1_KEY", "PCASH_PAYMENT_ROUTER_ADDRESS",
    ].map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      PCASH_L1_CHAIN_ID: "1",
      PCASH_L1_RPC: "https://mainnet.example",
      PCASH_L1_KEY: `0x${"22".repeat(32)}`,
      PCASH_PAYMENT_ROUTER_ADDRESS: ADDRESS,
    });
    try {
      const parsed = parsePaymentRouterEnvironment(environmentFile({ PCASH_L1_KEY: `0x${"11".repeat(32)}` }));
      const config = paymentRouterOperatorConfig(parsed);
      assert.equal(config.address, undefined);
      assert.equal(config.l1ChainId, 11_155_111);
      assert.equal(config.rpcUrl, "https://sepolia.example");
      assert.equal(config.deployerKey, `0x${"11".repeat(32)}`);
      const child = forgeDeploymentEnvironment(config);
      assert.equal(child.PCASH_L1_KEY, `0x${"11".repeat(32)}`);
      assert.equal(child.PCASH_L1_RPC, undefined);
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects typos, duplicate keys, and missing explicit address", () => {
    assert.throws(
      () => parsePaymentRouterEnvironment(`${environmentFile()}\nexport PCASH_PAYMENT_ROUTER_ADDRES=${ADDRESS}`),
      /Unknown.*PCASH_PAYMENT_ROUTER_ADDRES/,
    );
    assert.throws(
      () => parsePaymentRouterEnvironment(`${environmentFile()}\nexport PCASH_L1_CHAIN_ID=1`),
      /Duplicate.*PCASH_L1_CHAIN_ID/,
    );
    assert.throws(
      () => parsePaymentRouterEnvironment(environmentFile().replace(/^export PCASH_PAYMENT_ROUTER_ADDRESS=.*$/m, "export PCASH_PAYMENT_ROUTER_ADDRESS")),
      /Invalid PaymentRouter environment assignment/,
    );
    assert.throws(
      () => parsePaymentRouterEnvironment(environmentFile().replace(/^export PCASH_L1_CHAIN_ID=/m, "PCASH_L1_CHAIN_ID=")),
      /Invalid PaymentRouter environment assignment.*expected export KEY=value/,
    );
    assert.throws(
      () => parsePaymentRouterEnvironment(environmentFile().replace(/^export PCASH_PAYMENT_ROUTER_ADDRESS=.*$/m, "")),
      /missing PCASH_PAYMENT_ROUTER_ADDRESS/,
    );
  });

  it("takes an explicit file instead of inherited router settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "pcash-router-file-test-"));
    const file = join(directory, "router.env");
    writeFileSync(file, environmentFile({ PCASH_L1_CHAIN_ID: "0" }));
    const result = spawnSync("bash", [
      join(import.meta.dirname, "../../scripts/payment-router.sh"),
      "--envrc", file, "verify",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PCASH_L1_CHAIN_ID: "11155111",
        PCASH_PAYMENT_ROUTER_ADDRESS: ADDRESS,
        PCASH_PAYMENT_ROUTER_ENV_FILE: "/nonexistent/other.env",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PCASH_L1_CHAIN_ID must be a positive safe integer/);
  });

  it("accepts a reusable configured L1 without a deployer key", () => {
    const config = paymentRouterOperatorConfig(environment({ PCASH_PAYMENT_ROUTER_ADDRESS: ADDRESS }));
    assert.equal(config.address, ADDRESS);
    assert.equal(config.l1ChainId, 11_155_111);
    assert.equal(config.guardian, GUARDIAN);
    assert.equal(config.routerConfig, undefined);
    assert.equal(config.deployerKey, undefined);
    assert.equal(config.maxFeePerGas, 10_000_000_000n);
    const verifyOnly = paymentRouterOperatorConfig(environment({
      PCASH_PAYMENT_ROUTER_ADDRESS: ADDRESS,
      PCASH_L1_MAX_FEE_PER_GAS: "",
    }));
    assert.equal(verifyOnly.maxFeePerGas, undefined);
    const addressOnly = paymentRouterOperatorConfig(environment({
      PCASH_PAYMENT_ROUTER_ADDRESS: ADDRESS,
      PCASH_PAYMENT_ROUTER_GUARDIAN: "",
      PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: "",
      PCASH_PAYMENT_ROUTER_FEE_BPS: "",
    }));
    assert.equal(addressOnly.address, ADDRESS);
    assert.equal(addressOnly.guardian, undefined);
    const minimal = paymentRouterOperatorConfig(parsePaymentRouterEnvironment([
      "export PCASH_L1_RPC=https://sepolia.example",
      "export PCASH_L1_CHAIN_ID=11155111",
      `export PCASH_PAYMENT_ROUTER_ADDRESS=${ADDRESS}`,
    ].join("\n")));
    assert.equal(minimal.address, ADDRESS);
    assert.equal(minimal.routerConfig, undefined);
  });

  it("accepts another L1 and rejects malformed router settings", () => {
    assert.equal(paymentRouterOperatorConfig(environment({ PCASH_L1_CHAIN_ID: "1" })).l1ChainId, 1);
    assert.throws(() => paymentRouterOperatorConfig(environment({ PCASH_L1_CHAIN_ID: "" })), /PCASH_L1_CHAIN_ID is required/);
    assert.throws(() => paymentRouterOperatorConfig(environment({ PCASH_L1_CHAIN_ID: "9007199254740992" })), /positive safe integer/);
    assert.throws(() => paymentRouterOperatorConfig(environment({ PCASH_PAYMENT_ROUTER_GUARDIAN: "" })), /GUARDIAN is required/);
    assert.throws(
      () => paymentRouterOperatorConfig(environment({ PCASH_PAYMENT_ROUTER_GUARDIAN: "0x0000000000000000000000000000000000000000" })),
      /nonzero 20-byte/,
    );
    assert.throws(() => paymentRouterOperatorConfig(environment({ PCASH_PAYMENT_ROUTER_FEE_BPS: "10000" })), /fee BPS/i);
    assert.throws(() => paymentRouterOperatorConfig(environment({ PCASH_L1_MAX_FEE_PER_GAS: "0" })), /positive integer/);
  });

  it("extracts the single PaymentRouter creation and its receipt", () => {
    assert.deepEqual(forgeDeploymentRecord({
      transactions: [{ transactionType: "CREATE", contractName: "PaymentRouter", contractAddress: ADDRESS, hash: HASH }],
      receipts: [{ transactionHash: HASH, blockNumber: "0x2a" }],
    }), { address: ADDRESS, transactionHash: HASH, blockNumber: "42" });
    assert.throws(() => forgeDeploymentRecord({ transactions: [] }), /0 PaymentRouter creations/);
  });

  it("passes the selected RPC explicitly to Foundry broadcast", () => {
    const config = paymentRouterOperatorConfig(environment({ PCASH_L1_KEY: `0x${"11".repeat(32)}` }));
    const args = forgeDeploymentArgs(config);
    assert.deepEqual(args.slice(args.indexOf("--rpc-url"), args.indexOf("--rpc-url") + 2), [
      "--rpc-url",
      "https://sepolia.example",
    ]);
    assert.ok(args.includes("--broadcast"));
    const child = forgeDeploymentEnvironment(config, {
      PATH: "/usr/bin",
      HOME: "/tmp/operator",
      PCASH_PAYMENT_ROUTER_ADDRESS: ADDRESS,
      PCASH_L1_KEY: `0x${"22".repeat(32)}`,
      FOUNDRY_PROFILE: "unexpected",
    });
    assert.equal(child.PCASH_L1_KEY, `0x${"11".repeat(32)}`);
    assert.equal(child.PCASH_PAYMENT_ROUTER_ADDRESS, undefined);
    assert.equal(child.FOUNDRY_PROFILE, undefined);
  });

  it("keeps Etherscan verification separate from deployment and excludes the deployer key", () => {
    const deployConfig = paymentRouterOperatorConfig(environment({
      PCASH_L1_KEY: `0x${"11".repeat(32)}`,
      PCASH_ETHERSCAN_API_KEY: "explorer-key",
    }));
    assert.equal(forgeDeploymentEnvironment(deployConfig).ETHERSCAN_API_KEY, undefined);
    const config = paymentRouterOperatorConfig(environment({
      PCASH_PAYMENT_ROUTER_ADDRESS: ADDRESS,
      PCASH_ETHERSCAN_API_KEY: "explorer-key",
    }));
    const constructorArgs = paymentRouterConstructorArgs(RECIPIENT, 500, GUARDIAN);
    const word = (value: string) => value.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    assert.equal(constructorArgs.toLowerCase(), `0x${word(RECIPIENT)}${word("0x1f4")}${word(GUARDIAN)}`);
    const args = forgeSourceVerificationArgs(config, ADDRESS, constructorArgs);
    assert.deepEqual(args, [
      "verify-contract",
      "--root", join(import.meta.dirname, "../l1-contracts"),
      "--chain", "11155111",
      "--verifier", "etherscan",
      "--watch",
      "--constructor-args", constructorArgs,
      ADDRESS,
      "src/PaymentRouter.sol:PaymentRouter",
    ]);
    assert.ok(!args.includes("--broadcast"));
    assert.ok(!args.includes("explorer-key"));
    const child = forgeSourceVerificationEnvironment(config, {
      PATH: "/usr/bin",
      HOME: "/tmp/operator",
      PCASH_L1_KEY: `0x${"22".repeat(32)}`,
      ETHERSCAN_API_KEY: "wrong-key",
      FOUNDRY_PROFILE: "unexpected",
    });
    assert.equal(child.ETHERSCAN_API_KEY, "explorer-key");
    assert.equal(child.ETH_RPC_URL, "https://sepolia.example");
    assert.equal(child.PCASH_L1_KEY, undefined);
    assert.equal(child.FOUNDRY_PROFILE, undefined);
  });

  it("requires a selected router and Etherscan key for source verification", () => {
    const directory = mkdtempSync(join(tmpdir(), "pcash-router-source-test-"));
    const file = join(directory, "router.env");
    writeFileSync(file, environmentFile({ PCASH_ETHERSCAN_API_KEY: "explorer-key" }));
    const withoutAddress = spawnSync("bash", [
      join(import.meta.dirname, "../../scripts/payment-router.sh"),
      "--envrc", file,
      "verify-source",
    ], { encoding: "utf8" });
    assert.equal(withoutAddress.status, 1);
    assert.match(withoutAddress.stderr, /PCASH_PAYMENT_ROUTER_ADDRESS is required for verify-source/);
    writeFileSync(file, environmentFile({ PCASH_PAYMENT_ROUTER_ADDRESS: ADDRESS }));
    const withoutKey = spawnSync("bash", [
      join(import.meta.dirname, "../../scripts/payment-router.sh"),
      "--envrc", file,
      "verify-source",
    ], { encoding: "utf8" });
    assert.equal(withoutKey.status, 1);
    assert.match(withoutKey.stderr, /PCASH_ETHERSCAN_API_KEY is required for verify-source/);
    const config = paymentRouterOperatorConfig(environment({ PCASH_PAYMENT_ROUTER_ADDRESS: ADDRESS }));
    assert.throws(() => forgeSourceVerificationEnvironment(config), /PCASH_ETHERSCAN_API_KEY is required/);
  });

  it("prints only the router address for Vercel", () => {
    assert.equal(vercelPaymentRouterVariables(ADDRESS), `PCASH_PAYMENT_ROUTER_ADDRESS=${ADDRESS}`);
  });
});
