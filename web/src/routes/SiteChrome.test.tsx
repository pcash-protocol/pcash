import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ todos: 0, l1ChainId: 11155111, l1Name: "Sepolia" }));
vi.mock("../components/NetworkContext.tsx", () => ({ useNetwork: () => ({ network: { l1ChainId: state.l1ChainId, name: state.l1Name } }) }));
vi.mock("./wallet/activity.ts", () => ({ useWalletActivity: () => ({ unsafeToLeave: false }), useLeaveGuard: () => undefined }));
vi.mock("../components/AccountWidget.tsx", () => ({ AccountWidget: () => null }));
vi.mock("./marketplace/MarketplaceProvider.tsx", () => ({ useMarketplaceTodoCount: () => state.todos }));
import { SiteChrome } from "./SiteChrome.tsx";

const chrome = (pathname = "/") => renderToStaticMarkup(<MemoryRouter initialEntries={[pathname]}><SiteChrome /></MemoryRouter>);
const link = (path: string) => new RegExp(`<a[^>]*href="${path}"[^>]*>(.*?)</a>`).exec(chrome())![1]!.replace(/<[^>]+>/g, "");
const marketplaceLink = () => /<a[^>]*href="\/marketplace"[^>]*>(.*?)<\/a>/.exec(chrome())![1];

it("counts the marketplace trades that wait on the signed-in owner beside the Marketplace link", () => {
  state.todos = 0;
  expect(marketplaceLink()).not.toContain('<span class="nav-badge">');
  state.todos = 2;
  expect(marketplaceLink()).toContain('<span class="nav-badge">');
  expect(marketplaceLink()!.replace(/<[^>]+>/g, "")).toBe("Marketplace, 2 waiting on you");
});

it("does not mark released products as alpha", () => {
  state.todos = 0;
  expect(link("/marketplace")).toBe("Marketplace");
  expect(link("/tokens")).toBe("Tokens");
  expect(link("/explorer")).toBe("Explorer");
  for (const pathname of ["/marketplace", "/marketplace/listing/1", "/tokens", "/tokens/new", "/token/abc", "/claim", `/drop/0x${"ab".repeat(20)}`]) {
    expect(chrome(pathname)).not.toContain("subject to change at any time");
  }
});

it("marks every page as testnet unless the L1 is Ethereum mainnet", () => {
  expect(chrome().replace(/<[^>]+>/g, "")).toContain("Testnet. This site runs on Sepolia, and its PCASH has no value. Mainnet is coming soon.");
  state.l1ChainId = 1;
  state.l1Name = "Ethereum";
  expect(chrome()).not.toContain("testnet-banner");
  state.l1ChainId = 11155111;
  state.l1Name = "Sepolia";
});
