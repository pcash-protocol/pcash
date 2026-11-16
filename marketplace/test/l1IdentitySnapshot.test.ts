import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import type { Address, Hex } from "viem";
import type { L1Signer } from "../src/client/l1Signer.ts";
import { recoverPayResult, sendRouterCall, type RouterCall } from "../src/client/buy.ts";
import type { OfferPublication } from "../src/client/publication.ts";
import { MarketplaceController } from "../src/client/session.ts";
import type { PcashNodeClient } from "@pcash/sdk/browser";
import type { PcashProfile } from "@pcash/sdk/wallet";

const FIRST_CHAIN_ID = 1n;
const SECOND_CHAIN_ID = 2n;
const GENESIS_HASH = `0x${"11".repeat(32)}` as Hex;
const ROUTER = "0x00000000000000000000000000000000000000aa" as Address;
const PAYER = "0x00000000000000000000000000000000000000bb" as Address;

function alternatingNodeStatus(): { node: PcashNodeClient; calls: () => number } {
  let callCount = 0;
  const node = {
    status: async () => {
      callCount += 1;
      return {
        pcashChainId: Number(FIRST_CHAIN_ID),
        l1ChainId: callCount === 1 ? FIRST_CHAIN_ID : SECOND_CHAIN_ID,
        genesisL1Block: 0n,
        genesisL1BlockHash: GENESIS_HASH,
      };
    },
  } as unknown as PcashNodeClient;
  return { node, calls: () => callCount };
}

function signerOnFirstChain(): { signer: L1Signer; broadcasts: () => number } {
  let broadcastCount = 0;
  const signer: L1Signer = {
    address: PAYER,
    chainId: async () => FIRST_CHAIN_ID,
    sendTransaction: async () => {
      broadcastCount += 1;
      return `0x${"22".repeat(32)}` as Hex;
    },
  };
  return { signer, broadcasts: () => broadcastCount };
}

async function withChainIdRpc<T>(chainId: bigint, run: (url: string) => Promise<T>): Promise<T> {
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as { id: number; method: string };
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
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test RPC did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("single L1 identity snapshot", () => {
  it("rejects payment before broadcast when a second node status would match another L1", async () => {
    await withChainIdRpc(SECOND_CHAIN_ID, async (l1Url) => {
      const status = alternatingNodeStatus();
      const wallet = signerOnFirstChain();
      const call: RouterCall = {
        functionName: "buy",
        to: ROUTER,
        data: "0x",
        value: 1n,
        anchor: { blockNumber: 0n, blockHash: GENESIS_HASH },
      };

      await assert.rejects(
        sendRouterCall(
          status.node,
          [l1Url],
          wallet.signer,
          call,
        ),
        /configured L1 RPC is chain 2, but the PCASH node follows L1 chain 1/,
      );
      assert.equal(status.calls(), 1);
      assert.equal(wallet.broadcasts(), 0);
    });
  });

  it("refuses an offer whose action status names another L1 than the configured RPC", async () => {
    await withChainIdRpc(FIRST_CHAIN_ID, async (l1Url) => {
      // The node answers fresh reads truthfully and fakes the L1 chain only in
      // the status the wallet action opens with, which the offer commits.
      const honest = {
        pcashChainId: Number(FIRST_CHAIN_ID), genesisHash: GENESIS_HASH, l1ChainId: FIRST_CHAIN_ID,
        inboxAddress: `0x${"00".repeat(17)}0ca511`, genesisL1Block: 0n, genesisL1BlockHash: GENESIS_HASH,
      };
      let freshReads = 0;
      const node = { status: async () => { freshReads += 1; return honest; } } as unknown as PcashNodeClient;
      const identity = {
        wallet: {
          address: PAYER,
          network: { chainId: FIRST_CHAIN_ID, genesisHash: GENESIS_HASH },
          execute: async (operation: (context: unknown) => unknown) => operation({
            node, profile: { address: BigInt(PAYER) }, status: { ...honest, l1ChainId: 999n }, spendable: () => true,
          }),
        },
        l1Signer: signerOnFirstChain().signer,
      } as never;
      const controller = new MarketplaceController({
        node, store: {} as never, l1RpcUrls: [l1Url], configuredRouter: { address: ROUTER }, identity,
      });

      await assert.rejects(
        controller.createAndPublish({
          assetId: 0n, amount: 1n, ethPriceWei: 1n, purchaseMinutes: 1n, fundingOpenFeeAmount: 0n,
        }),
        /configured L1 RPC is chain 1, but the PCASH node follows L1 chain 999/,
      );
      assert.equal(freshReads, 0);
    });
  });

  it("uses the same node status for payment recovery identity and history bounds", async () => {
    await withChainIdRpc(SECOND_CHAIN_ID, async (l1Url) => {
      const status = alternatingNodeStatus();
      const offer = { chainId: "0x1", terms: {} } as unknown as OfferPublication;

      await assert.rejects(
        recoverPayResult(
          status.node,
          [l1Url],
          { address: BigInt(PAYER) } as PcashProfile,
          offer,
          { payer: PAYER },
        ),
        /configured L1 RPC is chain 2, but the PCASH node follows L1 chain 1/,
      );
      assert.equal(status.calls(), 1);
    });
  });
});
