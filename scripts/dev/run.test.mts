import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import {
  assertBrowserL1Identity,
  createLaunchPlan as buildLaunchPlan,
  anvilChainId,
  parseDevService,
  parseDevOptions,
  prepareWebMarketplace,
  prepareMarketplaceSource,
  usesLocalAnvil,
  waitForJsonRpc,
} from "./run.mts";
import * as paymentRouterTooling from "../../marketplace/src/tooling/paymentRouterSetup.mts";
import { PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH } from "../../marketplace/src/client/paymentRouter.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const GENESIS_HASH = `0x${"12".repeat(32)}`;
const NODE_STATUS = { pcashChainId: "23100", l1ChainId: "31337", genesisHash: GENESIS_HASH, genesisL1Block: "0", genesisL1BlockHash: GENESIS_HASH };
const createLaunchPlan: typeof buildLaunchPlan = (service, env, context) => buildLaunchPlan(service, env, {
  nodeStatus: NODE_STATUS, ...context,
});

test("the development command surface is explicit", () => {
  assert.equal(parseDevService("wallet"), "wallet");
  assert.throws(() => parseDevService("all"), /expects anvil, node, wallet, relayer, or web/);
  assert.equal(usesLocalAnvil({}), true);
  assert.equal(usesLocalAnvil({ PCASH_L1_RPC: "https://execution.example" }), false);
});

test("anvil is restricted to an explicit loopback port", () => {
  const plan = createLaunchPlan("anvil", {});
  assert.deepEqual(plan.args.slice(0, 3), ["--port", "8545", "--chain-id"]);
  assert.ok(Number(plan.args[3]) >= 0x4000_0000);
  assert.ok(Number(plan.args[3]) < 0x8000_0000);
  assert.equal(plan.args.includes("--silent"), false);
  assert.throws(
    () => createLaunchPlan("anvil", { PCASH_ANVIL_RPC_URL: "https://ethereum.example" }),
    /explicit loopback URL with a port/,
  );
});

test("the local node plan resolves the shared development defaults", () => {
  const plan = createLaunchPlan("node", {}, { genesisHash: GENESIS_HASH, l1ChainId: "0x7a69" });
  assert.equal(plan.env.PCASH_L1_RPC, "http://127.0.0.1:8545");
  assert.equal(plan.env.PCASH_BEACON_API, "http://127.0.0.1:8545");
  assert.equal(plan.env.PCASH_L1_CHAIN_ID, "31337");
  assert.equal(plan.env.PCASH_GENESIS_L1_BLOCK, "0");
  assert.equal(plan.env.PCASH_GENESIS_L1_BLOCK_HASH, GENESIS_HASH);
  assert.equal(plan.env.PCASH_DATA_DIR, join(REPO_ROOT, `.cache/pcash/dev/anvil/31337-${GENESIS_HASH.slice(2)}/node`));
  assert.equal(plan.env.PCASH_METRICS_ADDR, "127.0.0.1:9465");
  assert.equal(plan.env.PCASH_NODE_DEV, "true");
  assert.equal(plan.env.PCASH_PBOARD, "true");
  assert.equal(plan.env.PCASH_ENABLE_SOURCE_SUBMISSIONS, "true");
  assert.equal(plan.env.PCASH_ENABLE_CONFIGURATION_OPENING_SUBMISSIONS, "true");
  assert.equal(plan.env.PCASH_PROVER_ASSETS_BASE_URL, "http://127.0.0.1:5173/");
  assert.equal(
    plan.env.PCASH_PROVER_ASSETS_MANIFEST,
    join(REPO_ROOT, "assets/browser-prover-release.json"),
  );
  assert.deepEqual(plan.args.slice(-6), [
    "cargo", "run", "-p", "pcash-node", "--bin", "pcash-node",
  ]);
  const release = createLaunchPlan("node", { PCASH_NODE_PROFILE: "release" }, { genesisHash: GENESIS_HASH, l1ChainId: "0x7a69" });
  assert.equal(release.args.includes("--release"), true);
});

test("the Sepolia node plan requires its external chain identity", () => {
  const base = {
    PCASH_L1_CHAIN_ID: "11155111",
    PCASH_L1_RPC: "https://execution.example",
    PCASH_BEACON_API: "https://beacon.example",
  };
  assert.throws(() => createLaunchPlan("node", base), /PCASH_GENESIS_L1_BLOCK is required/);
  const plan = createLaunchPlan("node", {
    ...base,
    PCASH_GENESIS_L1_BLOCK: "123",
    PCASH_GENESIS_L1_BLOCK_HASH: GENESIS_HASH,
  });
  assert.equal(plan.args.includes("--release"), false);
  assert.equal(plan.args.includes("--dev"), false);
});

test("a named network node plan supplies no identity of its own", () => {
  const base = {
    PCASH_NETWORK: "testnet",
    PCASH_L1_RPC: "https://execution.example",
    PCASH_BEACON_API: "https://beacon.example",
  };
  const plan = createLaunchPlan("node", base, { l1ChainId: "0xaa36a7" });
  assert.equal(plan.env.PCASH_NETWORK, "testnet");
  for (const key of [
    "PCASH_CHAIN_ID",
    "PCASH_L1_CHAIN_ID",
    "PCASH_INBOX_ADDRESS",
    "PCASH_GENESIS_L1_BLOCK",
    "PCASH_GENESIS_L1_BLOCK_HASH",
  ]) {
    assert.equal(plan.env[key], undefined, key);
  }
  assert.match(plan.env.PCASH_DATA_DIR!, /\.cache\/pcash\/testnet-node$/);
  assert.throws(
    () => createLaunchPlan("node", { PCASH_NETWORK: "testnet" }, { genesisHash: GENESIS_HASH, l1ChainId: "0x7a69" }),
    /PCASH_NETWORK names a public network/,
  );
});

test("wallet and relayer plans wire the shared endpoints into each service namespace", () => {
  const wallet = createLaunchPlan("wallet", {});
  const relayer = createLaunchPlan("relayer", {});
  assert.equal(wallet.command, "npm");
  assert.deepEqual(wallet.args, [
    "run", "pcash-wallet", "--workspace", "@pcash/wallet", "--", "serve",
  ]);
  assert.equal(relayer.command, "npm");
  assert.deepEqual(relayer.args, [
    "run", "pcash-relayer", "--workspace", "@pcash/relayer", "--", "serve",
  ]);
  assert.equal(wallet.env.PCASH_WALLET_RPC_URL, "http://127.0.0.1:8645");
  assert.equal(wallet.env.PCASH_WALLET_L1_RPC, "http://127.0.0.1:8545");
  assert.equal(relayer.env.PCASH_RELAYER_RPC_URL, "http://127.0.0.1:8645");
  assert.equal(relayer.env.PCASH_RELAYER_L1_RPC, "http://127.0.0.1:8545");
  const shared = { PCASH_RPC_URL: "http://node.test", PCASH_L1_RPC: "https://l1.example" };
  assert.equal(createLaunchPlan("wallet", shared).env.PCASH_WALLET_RPC_URL, "http://node.test");
  assert.equal(createLaunchPlan("relayer", shared).env.PCASH_RELAYER_L1_RPC, "https://l1.example");
  assert.equal(
    createLaunchPlan("relayer", { ...shared, PCASH_RELAYER_L1_RPC: "https://relayer-l1.example" }).env.PCASH_RELAYER_L1_RPC,
    "https://relayer-l1.example",
  );
  assert.equal(wallet.env.PCASH_WALLET_LISTEN, "127.0.0.1:8745");
  assert.equal(wallet.env.PCASH_WALLET_METRICS_ADDR, "127.0.0.1:9470");
  assert.equal(wallet.env.PCASH_WALLET_DEV, "true");
  assert.equal(relayer.env.PCASH_RELAYER_HTTP_ADDR, "127.0.0.1:9464");
  assert.equal(relayer.env.PCASH_RELAYER_DEV, "true");
  assert.equal(relayer.env.PCASH_RELAYER_SPONSOR_UNPAID, "false");
  assert.match(relayer.env.PCASH_RELAYER_JOURNAL_PATH ?? "", /\.cache\/pcash\/dev\/31337-[0-9a-f]+\/relayer\/journal\.json$/);
  assert.equal(relayer.env.PCASH_RELAYER_L1_KEY, undefined);
  assert.equal(
    createLaunchPlan("relayer", { PCASH_RELAYER_L1_KEY: `0x${"ab".repeat(32)}` }).env.PCASH_RELAYER_L1_KEY,
    `0x${"ab".repeat(32)}`,
  );

  const sepoliaEnv = { PCASH_L1_RPC: "https://l1.example" };
  assert.equal(createLaunchPlan("wallet", sepoliaEnv).args.includes("--dev"), false);
  assert.equal(createLaunchPlan("relayer", sepoliaEnv).args.includes("--dev"), false);
});

test("local wallet delivery uses calldata and preserves explicit carrier choices", () => {
  assert.equal(createLaunchPlan("wallet", {}).env.PCASH_WALLET_DA_MODE, "calldata");
  assert.equal(createLaunchPlan("wallet", { PCASH_L1_RPC: "https://l1.example" }).env.PCASH_WALLET_DA_MODE, "auto");
  for (const mode of ["auto", "calldata", "blobs"]) {
    assert.equal(createLaunchPlan("wallet", { PCASH_WALLET_DA_MODE: mode }).env.PCASH_WALLET_DA_MODE, mode);
  }
});

test("each service preserves explicit dev settings on either backend", () => {
  for (const backend of ["anvil", "sepolia"]) {
    for (const service of ["node", "wallet", "relayer"] as const) {
      const variable = `PCASH_${service.toUpperCase()}_DEV`;
      for (const setting of [undefined, "true", "false"]) {
        const plan = createLaunchPlan(service, {
          ...(backend === "sepolia" ? { PCASH_L1_RPC: "https://l1.example" } : {}),
          PCASH_L1_CHAIN_ID: "11155111",
          PCASH_BEACON_API: "https://beacon.example",
          PCASH_GENESIS_L1_BLOCK: "0",
          PCASH_GENESIS_L1_BLOCK_HASH: GENESIS_HASH,
          ...(setting === undefined ? {} : { [variable]: setting }),
        }, { genesisHash: GENESIS_HASH, l1ChainId: "0x7a69" });
        assert.equal(plan.env[variable], setting ?? (backend === "anvil" ? "true" : "false"));
        assert.equal(plan.args.includes("--dev"), false);
      }
    }
  }
});

test("web plans derive chain identity from the running node and protect browser RPC configuration", () => {
  const context = {
    nodeStatus: {
      genesisHash: GENESIS_HASH,
      pcashChainId: "7",
      l1ChainId: "8",
      genesisL1Block: "12",
      genesisL1BlockHash: GENESIS_HASH,
    },
  };
  const plan = createLaunchPlan("web", {}, context);
  assert.equal(plan.env.PCASH_CHAIN_ID, "7");
  assert.equal(plan.env.PCASH_L1_CHAIN_ID, "8");
  assert.equal(plan.env.PCASH_GENESIS_HASH, GENESIS_HASH);
  assert.equal(plan.env.PCASH_BROWSER_L1_RPC_URLS, "http://127.0.0.1:8545");
  const fallbacks = "https://first.example/rpc,https://second.example/rpc";
  assert.equal(createLaunchPlan("web", { PCASH_BROWSER_L1_RPC_URLS: fallbacks }, context).env.PCASH_BROWSER_L1_RPC_URLS, fallbacks);
  assert.throws(
    () => createLaunchPlan("web", { PCASH_ANVIL_RPC_URL: "https://private.example:8545" }, context),
    /safe to expose to browsers/,
  );
});

test("web plans convert node RPC hex quantities to decimal browser chain IDs", () => {
  const plan = createLaunchPlan("web", {
    PCASH_CHAIN_ID: "1",
    PCASH_L1_CHAIN_ID: "1",
  }, {
    nodeStatus: {
      genesisHash: GENESIS_HASH,
      pcashChainId: "0x5a3c",
      l1ChainId: "0x7a69",
      genesisL1Block: "0x0",
      genesisL1BlockHash: GENESIS_HASH,
    },
  });
  assert.equal(plan.env.PCASH_CHAIN_ID, "23100");
  assert.equal(plan.env.PCASH_L1_CHAIN_ID, "31337");
});

test("RPC readiness retries temporary failures and rejects permanent responses immediately", async () => {
  let temporaryCalls = 0;
  const temporaryFetch: typeof fetch = async () => {
    temporaryCalls += 1;
    return temporaryCalls === 1
      ? new Response("unavailable", { status: 503 })
      : Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
  };
  assert.equal(await waitForJsonRpc("http://rpc.example", "eth_chainId", [], {
    fetch: temporaryFetch,
    timeoutMs: 100,
    intervalMs: 1,
  }), "0x1");
  assert.equal(temporaryCalls, 2);

  let permanentCalls = 0;
  const permanentFetch: typeof fetch = async () => {
    permanentCalls += 1;
    return new Response("unauthorized", { status: 401 });
  };
  await assert.rejects(
    waitForJsonRpc("http://rpc.example", "eth_chainId", [], { fetch: permanentFetch }),
    /HTTP 401/,
  );
  assert.equal(permanentCalls, 1);

  let protocolCalls = 0;
  const protocolFetch: typeof fetch = async () => {
    protocolCalls += 1;
    return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
  };
  await assert.rejects(
    waitForJsonRpc("http://rpc.example", "pcash_status", [], { fetch: protocolFetch }),
    /method not found/,
  );
  assert.equal(protocolCalls, 1);
});

test("RPC readiness has an overall deadline for retryable connection failures", async () => {
  const refusal = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  const fetchImpl: typeof fetch = async () => { throw new TypeError("fetch failed", { cause: refusal }); };
  await assert.rejects(
    waitForJsonRpc("http://rpc.example", "eth_chainId", [], {
      fetch: fetchImpl,
      timeoutMs: 10,
      requestTimeoutMs: 5,
      intervalMs: 1,
    }),
    /timed out after 10ms.*ECONNREFUSED|timed out after 10ms.*fetch failed/,
  );
});

test("RPC readiness bounds requests whose server never responds", async () => {
  const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  await assert.rejects(
    waitForJsonRpc("http://rpc.example", "eth_chainId", [], {
      fetch: hangingFetch,
      timeoutMs: 30,
      requestTimeoutMs: 10,
      intervalMs: 1,
    }),
    /timed out after 30ms.*timed out|timed out after 30ms.*aborted/i,
  );
});

test("browser L1 identity matches both the node's chain and genesis anchor", async () => {
  const status = {
    genesisHash: GENESIS_HASH,
    pcashChainId: "7",
    l1ChainId: "11155111",
    genesisL1Block: "12",
    genesisL1BlockHash: GENESIS_HASH,
  };
  const matchingFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (request.method === "eth_chainId") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" });
    }
    assert.deepEqual(request.params, ["0xc", false]);
    return Response.json({ jsonrpc: "2.0", id: 1, result: { hash: GENESIS_HASH } });
  };
  await assert.doesNotReject(assertBrowserL1Identity("http://browser-rpc.example", status, {
    fetch: matchingFetch,
  }));

  const wrongChainFetch: typeof fetch = async () =>
    Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
  await assert.rejects(
    assertBrowserL1Identity("http://browser-rpc.example", status, { fetch: wrongChainFetch }),
    /does not match node L1 chain/,
  );
  const wrongAnchorFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: request.method === "eth_chainId" ? "0xaa36a7" : { hash: `0x${"34".repeat(32)}` },
    });
  };
  await assert.rejects(
    assertBrowserL1Identity("http://browser-rpc.example", status, { fetch: wrongAnchorFetch }),
    /does not match node anchor/,
  );
});


test("a configured RPC is used directly and its reported chain supplies the default identity", () => {
  const plan = createLaunchPlan("node", {
    PCASH_L1_RPC: "https://execution.example",
    PCASH_BEACON_API: "https://beacon.example",
    PCASH_GENESIS_L1_BLOCK: "123",
    PCASH_GENESIS_L1_BLOCK_HASH: GENESIS_HASH,
    PCASH_DATA_DIR: "/tmp/pcash-custom-data",
  }, { l1ChainId: "0x1" });
  assert.equal(plan.env.PCASH_L1_RPC, "https://execution.example");
  assert.equal(plan.env.PCASH_L1_CHAIN_ID, "1");
  assert.equal(plan.env.PCASH_GENESIS_L1_BLOCK, "123");
  assert.equal(plan.env.PCASH_DATA_DIR, "/tmp/pcash-custom-data");
  assert.equal(plan.env.PCASH_NODE_DEV, "false");
});


test("the local node uses the connected Anvil chain ID", () => {
  const plan = createLaunchPlan("node", {}, { genesisHash: GENESIS_HASH, l1ChainId: "0x7a6a" });
  assert.equal(plan.env.PCASH_L1_CHAIN_ID, "31338");
  const env = { PCASH_ANVIL_CHAIN_ID: "31339" };
  const anvil = createLaunchPlan("anvil", env);
  const node = createLaunchPlan("node", env, { genesisHash: GENESIS_HASH, l1ChainId: "0x7a69" });
  assert.equal(anvil.args[anvil.args.indexOf("--chain-id") + 1], "31339");
  assert.equal(node.env.PCASH_L1_CHAIN_ID, "31337");
});


test("web options accept independent marketplace and fresh flags", () => {
  assert.deepEqual(parseDevOptions("web", [], {}), { marketplace: false, fresh: false });
  assert.deepEqual(parseDevOptions("web", ["--web-fresh"], {}), { marketplace: false, fresh: true });
  assert.deepEqual(parseDevOptions("web", ["--web-fresh", "--marketplace"], {}), { marketplace: true, fresh: true });
  assert.deepEqual(parseDevOptions("web", ["--marketplace", "--web-fresh=false"], {}), { marketplace: true, fresh: false });
  assert.deepEqual(parseDevOptions("web", [], { PCASH_MARKETPLACE: "true", PCASH_WEB_FRESH: "true" }), { marketplace: true, fresh: true });
  assert.throws(() => parseDevOptions("node", ["--web-fresh"], {}), /web accepts/);
  assert.throws(() => parseDevOptions("web", ["--web-fresh=yes"], {}), /web-fresh must be a boolean/);
  assert.throws(() => parseDevOptions("web", ["--unknown"], {}), /web accepts/);
  assert.throws(() => parseDevOptions("web", ["fresh=true"], {}), /web accepts/);
});

test("marketplace setup forwards only the selected router address to Vite", async () => {
  const address = `0x${"12".repeat(20)}` as const;
  const feeRecipient = `0x${"34".repeat(20)}` as const;
  const tooling: Parameters<typeof prepareWebMarketplace>[2] = {
    LOCAL_PAYMENT_ROUTER_CONFIG: { feeRecipient: "0x0000000000000000000000000000000000000fee", feeBps: 500 },
    LOCAL_PAYMENT_ROUTER_KEY: `0x${"11".repeat(32)}`,
    localPaymentRouterCacheRoot: (_, root) => join(root!, "marketplace"),
    setupPaymentRouter: async (options) => {
      assert.equal(options.rpcUrl, "http://127.0.0.1:9545");
      assert.equal(options.cacheRoot, "/dev-root/marketplace");
      assert.equal(options.l1ChainId, 31337n);
      assert.equal(options.explicitAddress, address);
      assert.equal(options.privateKey, tooling!.LOCAL_PAYMENT_ROUTER_KEY);
      assert.equal(options.routerConfig, undefined);
      return {
        kind: "ready", source: "explicit", l1ChainId: 31337, address,
        routerConfig: { feeRecipient, feeBps: 250 },
        runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH, runtimeCodeHash: "0x",
      };
    },
  };
  const env = {
    PCASH_DEV_ROOT: "/dev-root", PCASH_ANVIL_RPC_URL: "http://127.0.0.1:9545",
    PCASH_L1_CHAIN_ID: "31337", PCASH_PAYMENT_ROUTER_ADDRESS: address,
    PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: feeRecipient, PCASH_PAYMENT_ROUTER_FEE_BPS: "250",
  };
  const prepared = await prepareWebMarketplace(env, true, tooling);
  assert.notEqual(prepared, env);
  assert.equal(prepared.PCASH_PAYMENT_ROUTER_ADDRESS, address);
  assert.equal(prepared.PCASH_PAYMENT_ROUTER_FEE_RECIPIENT, undefined);
  assert.equal(prepared.PCASH_PAYMENT_ROUTER_FEE_BPS, undefined);
});

test("local marketplace setup forwards the real tooling's router defaults", async () => {
  const address = `0x${"12".repeat(20)}` as const;
  let forwarded: unknown;
  const tooling: Parameters<typeof prepareWebMarketplace>[2] = {
    ...paymentRouterTooling,
    setupPaymentRouter: async (options) => {
      forwarded = options.routerConfig;
      return {
        kind: "ready", source: "deployed", l1ChainId: 31337, address,
        routerConfig: { feeRecipient: options.routerConfig.feeRecipient as `0x${string}`, feeBps: options.routerConfig.feeBps ?? 0 },
        runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH, runtimeCodeHash: "0x",
      };
    },
  };
  const env = await prepareWebMarketplace({ PCASH_L1_CHAIN_ID: "31337" }, true, tooling);
  const defaults = paymentRouterTooling.LOCAL_PAYMENT_ROUTER_CONFIG;
  // Both sides read the real tooling, so a rename there must fail here rather than compare undefined values.
  assert.match(defaults.feeRecipient, /^0x[0-9a-fA-F]{40}$/);
  assert.deepEqual(forwarded, { feeRecipient: defaults.feeRecipient, feeBps: defaults.feeBps });
  assert.equal(env.PCASH_PAYMENT_ROUTER_ADDRESS, address);
  assert.equal(env.PCASH_PAYMENT_ROUTER_FEE_RECIPIENT, undefined);
});

test("external networks require an explicit router address", async () => {
  await assert.rejects(prepareWebMarketplace({ PCASH_L1_RPC: "https://execution.example" }, false), /automatic deployment is local-Anvil only/);
  await assert.rejects(prepareWebMarketplace({ PCASH_ANVIL_RPC_URL: "https://execution.example" }, true), /loopback Anvil/);
});


test("local marketplace defaults and external explicit addresses choose the right deployment authority", async () => {
  const address = `0x${"12".repeat(20)}` as const;
  for (const local of [true, false]) {
    const l1ChainId = local ? 31337 : 11155111;
    const tooling: Parameters<typeof prepareWebMarketplace>[2] = {
      LOCAL_PAYMENT_ROUTER_CONFIG: { feeRecipient: "0x0000000000000000000000000000000000000fee", feeBps: 500 },
      LOCAL_PAYMENT_ROUTER_KEY: `0x${"11".repeat(32)}`,
      localPaymentRouterCacheRoot: () => "/local-cache",
      setupPaymentRouter: async (options) => {
        assert.equal(options.l1ChainId, BigInt(l1ChainId));
        assert.equal(options.privateKey, local ? tooling!.LOCAL_PAYMENT_ROUTER_KEY : undefined);
        assert.equal(options.explicitAddress, local ? undefined : address);
        assert.deepEqual(options.routerConfig, local ? tooling!.LOCAL_PAYMENT_ROUTER_CONFIG : undefined);
        return {
          kind: "ready", source: local ? "deployed" : "explicit", l1ChainId, address,
          routerConfig: { feeRecipient: address, feeBps: 100 },
          runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH, runtimeCodeHash: "0x",
        };
      },
    };
    const env = await prepareWebMarketplace({
      PCASH_L1_CHAIN_ID: String(l1ChainId),
      ...(local ? {} : {
        PCASH_L1_RPC: "https://execution.example", PCASH_PAYMENT_ROUTER_ADDRESS: address,
      }),
    }, local, tooling);
    assert.equal(env.PCASH_PAYMENT_ROUTER_ADDRESS, address);
    assert.equal(env.PCASH_PAYMENT_ROUTER_FEE_RECIPIENT, undefined);
    assert.equal(env.PCASH_PAYMENT_ROUTER_FEE_BPS, undefined);
  }
});


test("local marketplace startup builds and publishes escrow source and preserves its scratch directory", async () => {
  const calls: string[][] = [];
  const env = { PCASH_ADMIN_ADDR: "127.0.0.1:9647", PCASH_TOOL_ROOT: "/tools" };
  await prepareMarketplaceSource(env, true, async (command, args, passedEnv) => {
    assert.equal(command, process.execPath);
    assert.equal(passedEnv, env);
    calls.push([...args]);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]![1], "build");
  assert.equal(calls[0]![3], "marketplace/src/tooling/sourceVerification.mts");
  const bundle = calls[0]![5]!;
  assert.deepEqual(calls[1]!.slice(1), ["publish", "--bundle", bundle, "--admin-url", "http://127.0.0.1:9647"]);
  assert.equal(existsSync(dirname(bundle)), true);
});

test("source-registration failures stop startup and preserve temporary output", async () => {
  for (const failedStep of ["build", "publish"]) {
    let bundle = "";
    await assert.rejects(prepareMarketplaceSource({}, true, async (_command, args) => {
      if (args[1] === "build") bundle = args[5]!;
      if (args[1] === failedStep) throw new Error(`${failedStep} failed`);
    }), new RegExp(`${failedStep} failed`));
    assert.equal(existsSync(dirname(bundle)), true);
  }
});

test("automatic source registration does not publish to external operators", async () => {
  let calls = 0;
  const run = async () => { calls++; };
  await prepareMarketplaceSource({}, false, run);
  assert.equal(calls, 0);
  await assert.rejects(prepareMarketplaceSource({ PCASH_ADMIN_ADDR: "operator.example:8647" }, true, run), /loopback/);
  assert.equal(calls, 0);
});


test("Anvil accepts fixed IDs and uses zero only as the random selector", () => {
  assert.equal(anvilChainId("31337"), "31337");
  assert.deepEqual(parseDevOptions("anvil", ["--anvil-chain-id=0"], {}), { marketplace: false, fresh: false, chainId: "0" });
  const ids = new Set(Array.from({ length: 10 }, () => anvilChainId("0")));
  assert.ok(ids.size > 1);
  for (const id of ["-1", "1.5", "0x10", "9007199254740992"]) {
    assert.throws(() => parseDevOptions("anvil", [`--anvil-chain-id=${id}`], {}), /nonnegative safe integer/);
  }
  for (const id of ["-1", "1.5", "0x10", "", "9007199254740992"]) {
    assert.throws(() => anvilChainId(id), /nonnegative safe integer/);
  }
});

test("fresh Anvil identities get separate node, wallet and relayer state", () => {
  const first = createLaunchPlan("node", {}, { l1ChainId: "12345", genesisHash: GENESIS_HASH });
  for (const context of [
    { l1ChainId: "12346", genesisHash: GENESIS_HASH },
    { l1ChainId: "12345", genesisHash: `0x${"34".repeat(32)}` },
  ]) {
    const next = createLaunchPlan("node", { PCASH_L1_CHAIN_ID: "11155111", PCASH_ANVIL_CHAIN_ID: "0" }, context);
    assert.equal(next.env.PCASH_L1_CHAIN_ID, context.l1ChainId);
    assert.notEqual(next.env.PCASH_DATA_DIR, first.env.PCASH_DATA_DIR);
    for (const service of ["wallet", "relayer"] as const) {
      const before = createLaunchPlan(service, {}, { nodeStatus: { ...NODE_STATUS, l1ChainId: "12345" } });
      const after = createLaunchPlan(service, {}, { nodeStatus: { ...NODE_STATUS, ...context } });
      const variable = service === "wallet" ? "PCASH_WALLET_DATA_DIR" : "PCASH_RELAYER_JOURNAL_PATH";
      assert.notEqual(after.env[variable], before.env[variable]);
    }
  }
});
