// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { StatusResult } from "@pcash/sdk/clients";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExplorerProvider, useExplorer, type FollowedStatus } from "./ExplorerProvider.tsx";
import { NetworkProvider } from "../../lib/NetworkProvider.tsx";
import * as configuration from "./config.ts";

const config = { rpcUrl: "http://localhost:8645", rpcDisplayUrl: "localhost", pcashChainId: 1 };
let root: Root;
let observed: ReturnType<typeof useExplorer>;
function Probe() { observed = useExplorer(); return null; }
async function render(followedStatus?: FollowedStatus) {
  await act(async () => root.render(<NetworkProvider><MemoryRouter><ExplorerProvider followedStatus={followedStatus}><Probe /></ExplorerProvider></MemoryRouter></NetworkProvider>));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(configuration, "resolveNetworkExplorerConfig").mockReturnValue({ status: "valid", config });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reads the node status the signed-in wallet already follows instead of polling it", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const status = { pcashChainId: 1, latestBlock: 7n, latestBlockHash: `0x${"07".repeat(32)}` } as unknown as StatusResult;
  await render({ status, observedAt: Date.now() });
  expect(observed.connection.phase).toBe("ready");
  expect(observed.connection.phase === "ready" && observed.connection.status).toBe(status);
  const next = { ...status, latestBlock: 8n } as StatusResult;
  await render({ status: next, observedAt: Date.now() });
  expect(observed.connection.phase === "ready" && observed.connection.status).toBe(next);
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects a followed status from a different chain", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await render({ status: { pcashChainId: 2 } as unknown as StatusResult, observedAt: Date.now() });
  expect(observed.connection.phase).toBe("mismatch");
});
