import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExplorerProvider, useExplorer } from "./ExplorerProvider.tsx";
import { NetworkProvider } from "../../lib/NetworkProvider.tsx";
import * as configuration from "./config.ts";
import { PageSkeleton } from "../../components/PageSkeleton.tsx";

const config = { rpcUrl: "http://localhost:8645", rpcDisplayUrl: "localhost", pcashChainId: 1 };

afterEach(() => vi.restoreAllMocks());

describe("site explorer scope", () => {
  it("reuses the enclosing session for route-level providers", () => {
    const resolve = vi.spyOn(configuration, "resolveNetworkExplorerConfig").mockReturnValue({ status: "valid", config });
    const observed: ReturnType<typeof useExplorer>[] = [];
    function Probe() {
      observed.push(useExplorer());
      return null;
    }
    renderToStaticMarkup(<NetworkProvider><MemoryRouter><ExplorerProvider>
      <Probe /><ExplorerProvider><Probe /></ExplorerProvider>
    </ExplorerProvider></MemoryRouter></NetworkProvider>);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toBe(observed[0]);
  });

  it("keeps separate app roots isolated by their configured node", () => {
    const resolve = vi.spyOn(configuration, "resolveNetworkExplorerConfig");
    const observed: ReturnType<typeof useExplorer>[] = [];
    function Probe() {
      observed.push(useExplorer());
      return null;
    }
    for (const pcashChainId of [1, 2]) {
      resolve.mockReturnValue({ status: "valid", config: { ...config, pcashChainId } });
      renderToStaticMarkup(<NetworkProvider><MemoryRouter><ExplorerProvider><Probe /></ExplorerProvider></MemoryRouter></NetworkProvider>);
    }
    expect(observed[0]).not.toBe(observed[1]);
    expect(observed.map(({ connection }) => connection.phase === "connecting" && connection.config.pcashChainId)).toEqual([1, 2]);
  });

  it("uses an accessible skeleton while the first page loads", () => {
    const html = renderToStaticMarkup(<PageSkeleton />);
    expect(html).toContain('aria-label="Loading page"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Checking node identity");
  });
});
