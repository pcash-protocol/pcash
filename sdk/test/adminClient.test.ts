// createAdminClient request/response shaping (offline) via an injected fetch.
// The operator publication is served by the admin listener, not the `pscan_*`
// one, so what matters here is the method name, the endpoint the request goes
// to, and that the registry status comes back parsed rather than raw.

import { describe, expect, it } from "vitest";
import { createAdminClient } from "../src/clients/adminClient.ts";
import type { SourceVerificationPublication } from "../src/clients/pscanClient.ts";
import { rpcFetch, rpcResult } from "./rpcFetch.ts";

const ADMIN_URL = "http://127.0.0.1:8647";

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
  genesisHash: `0x${"ab".padStart(64, "0")}`,
  sourceSubmissionStatus: "disabled",
  configurationOpeningSubmissionStatus: "ready",
  submittedImplementationCount: "0x2",
  error: null,
};

const PUBLICATION: SourceVerificationPublication = {
  manifest: { serviceName: "Smoke Operator" },
  attachments: { "claim/src/main.nr": "AAAA" },
};

/** A transport that answers one call and records what it was sent. */
function scriptedFetch(result: unknown) {
  const captured: { url: string; body: { method: string; params: unknown[] } }[] = [];
  const rpcOptions = rpcFetch((body, url) => {
    captured.push({ url, body });
    return rpcResult(body, result);
  });
  return { rpcOptions, captured };
}

describe("createAdminClient", () => {
  it("publishes through the admin namespace and parses the registry status", async () => {
    const { rpcOptions, captured } = scriptedFetch(INFO_READY);
    const info = await createAdminClient(ADMIN_URL, rpcOptions).publishSourceVerification(PUBLICATION);
    expect(captured[0]?.body.method).toBe("admin_publishSourceVerification");
    expect(captured[0]?.url).toBe(`${ADMIN_URL}/`);
    expect(captured[0]?.body.params).toEqual([PUBLICATION]);
    expect(info.status).toBe("ready");
    expect(info.writable).toBe(true);
    expect(info.implementationCount).toBe(2n);
  });

  it("surfaces a listener error with its code", async () => {
    const transport = rpcFetch((body) => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32033, message: "source-verification publication conflicts with stored material: label" },
    }), { status: 400 }));
    await expect(
      createAdminClient(ADMIN_URL, transport).publishSourceVerification(PUBLICATION),
    ).rejects.toThrow(/-32033/);
  });
});
