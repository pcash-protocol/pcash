import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { createWalletClient, custom, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import {
  isDefinitelyNotBroadcastL1Error,
  L1SignerPreflightError,
  privateKeyL1Signer,
  viemL1Signer,
} from "../src/client/l1Signer.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const OTHER_ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const TO = "0x3333333333333333333333333333333333333333" as Address;
const TX_HASH = `0x${"44".repeat(32)}` as Hex;
const PRIVATE_KEY = `0x${"11".repeat(32)}` as Hex;

async function withChainIdRpc<T>(chainId: bigint, run: (url: string, methods: string[]) => Promise<T>): Promise<T> {
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as { id: number; method: string };
    methods.push(message.method);
    response.setHeader("content-type", "application/json");
    if (message.method === "eth_chainId") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: `0x${chainId.toString(16)}` }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `unexpected test RPC method ${message.method}` },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("test RPC did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${bound.port}`, methods);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

class MutableProvider {
  chainId = 11155111n;
  account: Address | null = ACCOUNT;
  sends: Array<Record<string, unknown>> = [];

  async request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown> {
    switch (args.method) {
      case "eth_chainId":
        return `0x${this.chainId.toString(16)}`;
      case "eth_accounts":
        return this.account === null ? [] : [this.account];
      case "eth_sendTransaction": {
        const tx = (args.params as readonly unknown[])[0] as Record<string, unknown>;
        this.sends.push(tx);
        return TX_HASH;
      }
      default:
        throw new Error(`unexpected provider method ${args.method}`);
    }
  }
}

describe("viem L1 signer", () => {
  it("binds the final provider send to the requested chain and account", async () => {
    const provider = new MutableProvider();
    const signer = viemL1Signer(createWalletClient({ chain: sepolia, transport: custom(provider) }), ACCOUNT);
    const hash = await signer.sendTransaction({
      chainId: 11155111n,
      to: TO,
      data: "0x1234",
      value: 9n,
      maxFeePerGas: 30n,
      maxPriorityFeePerGas: 2n,
    });

    assert.equal(hash, TX_HASH);
    assert.deepEqual(provider.sends, [{
      from: ACCOUNT,
      to: TO,
      data: "0x1234",
      value: "0x9",
      maxFeePerGas: "0x1e",
      maxPriorityFeePerGas: "0x2",
    }]);
  });

  it("rejects chain or account drift after an earlier identity read", async () => {
    const provider = new MutableProvider();
    const signer = viemL1Signer(createWalletClient({ chain: sepolia, transport: custom(provider) }), ACCOUNT);
    assert.equal(await signer.chainId(), 11155111n);

    provider.chainId = 1n;
    let chainFailure: unknown;
    try {
      await signer.sendTransaction({ chainId: 11155111n, to: TO });
    } catch (cause) {
      chainFailure = cause;
    }
    assert.ok(chainFailure instanceof L1SignerPreflightError);
    assert.match(chainFailure.message, /wallet changed to chain 1, expected chain 11155111/);
    assert.equal(isDefinitelyNotBroadcastL1Error(chainFailure), true);
    provider.chainId = 11155111n;
    provider.account = OTHER_ACCOUNT;
    let accountFailure: unknown;
    try {
      await signer.sendTransaction({ chainId: 11155111n, to: TO });
    } catch (cause) {
      accountFailure = cause;
    }
    assert.ok(accountFailure instanceof L1SignerPreflightError);
    assert.match(accountFailure.message, /wallet changed account/);
    assert.equal(isDefinitelyNotBroadcastL1Error(accountFailure), true);
    assert.equal(provider.sends.length, 0);
  });

  it("does not classify an untyped provider failure as definitely not broadcast", () => {
    assert.equal(isDefinitelyNotBroadcastL1Error(new Error("provider disconnected")), false);
    assert.equal(isDefinitelyNotBroadcastL1Error({ cause: { code: 4001 } }), true);
  });
});

describe("private-key L1 signer", () => {
  it("types an RPC chain drift check as definitely not broadcast", async () => {
    await withChainIdRpc(1n, async (l1Url, methods) => {
      const signer = privateKeyL1Signer(PRIVATE_KEY, l1Url);
      let failure: unknown;
      try {
        await signer.sendTransaction({ chainId: 2n, to: TO });
      } catch (cause) {
        failure = cause;
      }
      assert.ok(failure instanceof L1SignerPreflightError);
      assert.match(failure.message, /RPC changed to chain 1, expected chain 2/);
      assert.equal(isDefinitelyNotBroadcastL1Error(failure), true);
      assert.deepEqual(methods, ["eth_chainId"]);
    });
  });
});
