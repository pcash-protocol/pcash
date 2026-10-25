import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { privateKeyPcashActionSigner, verifySelectedRelayQuote } from "@pcash/sdk/eip712";
import type { SelectedRelayQuote } from "@pcash/sdk/eip712";
import { DEFAULT_NETWORK_CONFIG, networkConfigFromStatus } from "@pcash/sdk/protocol";
import { fromHexSized } from "@pcash/sdk/utils";
import { PcashNodeClient, type StatusResult } from "@pcash/sdk/clients";
import { HttpRequestError } from "viem";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { selectedRelayHandler, type SelectedRelayServiceConfig } from "../src/selectedService.ts";

const privateKey = `0x${"01".repeat(32)}`;
const signer = privateKeyPcashActionSigner(fromHexSized(privateKey, 32));
const profile = derivePcashProfileFromPrivateKey(fromHexSized(privateKey, 32), DEFAULT_NETWORK_CONFIG);
const status = {
  pcashChainId: Number(DEFAULT_NETWORK_CONFIG.pcashChainId),
  l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId,
  inboxAddress: `0x${DEFAULT_NETWORK_CONFIG.inboxAddress.toString(16).padStart(40, "0")}`,
  latestBlockTimestamp: 100n,
} as StatusResult;
let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function serve(overrides: Partial<SelectedRelayServiceConfig> = {}) {
  const handler = selectedRelayHandler({
    node: { status: async () => status } as PcashNodeClient,
    profile, signer, minPrivateFee: 100n, minValuePerByte: 1n,
    maxQuoteLifetimeSeconds: 3_600n,
    ...overrides,
  });
  server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not listen");
  return `http://127.0.0.1:${address.port}`;
}

it("advertises signed quote terms and rejects underpriced or overlong quotes", async () => {
  const url = await serve();
  const info = await fetch(`${url}/selected/info`);
  expect(info.headers.get("access-control-allow-origin")).toBe("*");
  expect(await info.json()).toEqual({
    recipient: profile.address.toString(), maxQuoteLifetimeSeconds: "3600",
  });
  const request = {
    pcashChainId: status.pcashChainId.toString(), recipient: profile.address.toString(),
    privateFeeAmount: "100", transactionContext: "22", quoteBinding: "33",
    maxTransactionBytes: "100", validUntilTimestamp: "200", issuanceEligible: true,
  };
  const post = (body: unknown) => fetch(`${url}/selected/quote`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await post({ ...request, privateFeeAmount: "99" })).status).toBe(400);
  expect((await post({ ...request, maxTransactionBytes: "101" })).status).toBe(400);
  expect((await post({ ...request, validUntilTimestamp: "3701" })).status).toBe(400);
  const accepted = await post(request);
  expect(accepted.status).toBe(200);
  const quote = await accepted.json() as SelectedRelayQuote;
  expect(verifySelectedRelayQuote(networkConfigFromStatus(status), quote, {
    recipient: profile.address, pcashChainId: status.pcashChainId, privateFeeAmount: 100n,
    transactionContext: 22n, quoteBinding: 33n, maxTransactionBytes: 100n,
    nowTimestamp: 100n,
  }).privateFeeAmount).toBe(100n);
});

it("returns 503 when the quote node is unavailable", async () => {
  const url = await serve({ node: { status: async () => { throw new Error("offline"); } } });
  const response = await fetch(`${url}/selected/quote`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
});

it("keeps a credentialed node URL out of quote failures", async () => {
  const nodeUrl = "https://node.example/rpc/SECRETKEY?apikey=SECRET2";
  const quote = (url: string) => fetch(`${url}/selected/quote`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pcashChainId: status.pcashChainId.toString(), recipient: profile.address.toString(),
      privateFeeAmount: "100", transactionContext: "22", quoteBinding: "33",
      maxTransactionBytes: "100", validUntilTimestamp: "200",
    }),
  });

  const unreachable = new PcashNodeClient(nodeUrl, { fetchFn: async () => { throw new TypeError("fetch failed"); } });
  const offline = await quote(await serve({ node: unreachable }));
  expect(offline.status).toBe(503);
  expect(await offline.text()).not.toMatch(/SECRETKEY|SECRET2/);
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;

  // A signer behind an RPC endpoint fails with viem's URL-bearing error.
  const remoteSigner = { address: signer.address, signTypedData: async () => { throw new HttpRequestError({ url: nodeUrl, details: "fetch failed" }); } };
  const failed = await quote(await serve({ signer: remoteSigner }));
  expect(failed.status).toBe(400);
  const text = await failed.text();
  expect(JSON.parse(text)).toEqual({ error: "HTTP request failed." });
  expect(text).not.toMatch(/SECRETKEY|SECRET2/);
});
