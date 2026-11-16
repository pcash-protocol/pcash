import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { formatPcashAmount } from "../../../components/pcashAmount.ts";
import { fixtureStatus } from "../fixtures/world.ts";

const explorer = vi.hoisted(() => ({ status: undefined as unknown }));
vi.mock("../ExplorerProvider.tsx", async () => {
  const { fixtureStatus } = await import("../fixtures/world.ts");
  return { useReadyExplorer: () => ({ status: explorer.status ?? fixtureStatus, reader: { dashboard: vi.fn() } }) };
});
vi.mock("../ui.tsx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ui.tsx")>(),
  useRead: () => ({ value: undefined, error: undefined }),
}));
import { ExplorerSyncBanner } from "../ExplorerRoute.tsx";
import { DashboardPage } from "./DashboardPage.tsx";

function banner(blocksBehind: bigint): string {
  const status = { ...fixtureStatus, observedL1BlockNumber: fixtureStatus.latestL1BlockNumber + blocksBehind };
  return renderToStaticMarkup(<ExplorerSyncBanner status={status} />);
}

describe("Explorer sync state", () => {
  it("says nothing while the node is within two L1 blocks of the head", () => {
    expect(banner(2n)).toBe("");
  });

  it("shows one banner when the explorer's data is behind", () => {
    expect(banner(3n)).toContain("Explorer data is 3 Ethereum blocks behind. Recent activity may be missing.");
  });

  it("keeps sync state and the latest-block metric off the overview", () => {
    const html = renderToStaticMarkup(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(html).not.toContain("Node sync");
    expect(html).not.toContain("Latest block<");
    expect(html).toContain("Transactions");
  });

  it("shows the base fee, the total burned, and supply as gross issuance minus burns", () => {
    const html = renderToStaticMarkup(<MemoryRouter><DashboardPage /></MemoryRouter>);
    const tile = (label: string) => html.slice(html.indexOf(`<span>${label}</span>`)).match(/^<span>[^<]*<\/span><strong>(?:<span[^>]*>)?([^<]*)/)?.[1];
    expect(fixtureStatus.burnedSoFar).not.toBeNull();
    expect(tile("Base fee")).toBe(formatPcashAmount(fixtureStatus.baseFee));
    expect(html).toContain("per state unit, next block");
    expect(tile("Burned")).toBe(formatPcashAmount(fixtureStatus.burnedSoFar!));
    expect(tile("Supply")).toBe(formatPcashAmount(fixtureStatus.issuedSoFar - fixtureStatus.burnedSoFar!));
    expect(html).toContain("Gross issued minus burned");
  });

  it("shows no burn or supply figure while the index has not caught up", () => {
    explorer.status = { ...fixtureStatus, burnedSoFar: null };
    const html = renderToStaticMarkup(<MemoryRouter><DashboardPage /></MemoryRouter>);
    explorer.status = undefined;
    expect(html).toContain("<span>Burned</span><strong>—</strong>");
    expect(html).toContain("<span>Supply</span><strong>—</strong>");
  });

  it("shows gross issuance in whole PCASH in the tile's figure, without a caption", () => {
    const html = renderToStaticMarkup(<MemoryRouter><DashboardPage /></MemoryRouter>);
    const tile = html.slice(html.indexOf("<span>Gross issued</span>"));
    expect(tile).toMatch(new RegExp(`^<span>Gross issued</span><strong><span[^>]*>${formatPcashAmount(fixtureStatus.issuedSoFar)}</span></strong></div>`));
  });
});
