import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  address: `0x${"12".repeat(20)}`,
  connectedAccount: undefined as string | undefined,
  signedIn: false,
  cachedHistory: vi.fn(),
  account: vi.fn(), nativeActivity: vi.fn(), contract: vi.fn(),
}));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => ({ accountRecord: "present", connectedAccount: state.connectedAccount, phase: "ready", profile: state.signedIn ? { address: BigInt(state.address) } : undefined, funds: { total: 123n * 10n ** 18n } }) }));
vi.mock("../../lib/useCachedAccountHistory.ts", () => ({ useCachedAccountHistory: state.cachedHistory }));
vi.mock("../../lib/useNativeActivity.ts", () => ({ useNativeActivity: state.nativeActivity }));
vi.mock("../../names/useEthereumName.ts", () => ({ useEthereumNameResolver: () => undefined, useEthereumName: () => undefined, useEthereumIdentity: () => ({}), useNameAddress: () => ({ state: "unresolved" }) }));
vi.mock("../explorer/ExplorerProvider.tsx", () => ({
  ExplorerProvider: ({ children }: { children: ReactNode }) => children,
  useExplorer: () => ({ connection: { phase: "ready" } }),
  useReadyExplorer: () => ({ status: { pcashChainId: 1n, latestBlockHash: "head", inboxAddress: `0x${"34".repeat(20)}` }, reader: {
    accountSnapshot: (address: string) => ({ account: state.account(address), headHash: "head" }),
    accountHistory: () => ({ items: [], nextCursor: null }),
  } }),
}));
vi.mock("../explorer/ui.tsx", async (original) => ({
  ...await original<typeof import("../explorer/ui.tsx")>(),
  useRead: (read: () => unknown) => {
    try { return { value: read() }; }
    catch (error) { return { error: String(error) }; }
  },
}));
vi.mock("../wallet/OwnerPanels.tsx", async (original) => ({
  ...await original<typeof import("../wallet/OwnerPanels.tsx")>(),
  OwnerPanelsProvider: ({ children }: { children: ReactNode }) => children,
  AccountSetupPanels: () => null, AccountStatusNotices: () => null,
  SendPanel: () => null,
}));
vi.mock("../wallet/Activity.tsx", () => ({ Activity: () => <section id="activity">Owner activity</section> }));
vi.mock("../explorer/ContractView.tsx", () => ({ ContractView: (props: { address: string; activity: ReactNode }) => {
  state.contract(props);
  return <section data-testid="contract-view">Contract identity {props.address}</section>;
} }));
import AddressRoute from "./AddressRoute.tsx";

function render() {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[`/${state.address}`]}><AddressRoute /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.connectedAccount = undefined;
  state.signedIn = false;
  state.account.mockReturnValue({ accountKind: 1, accountRevision: 1n, material: { status: "unavailable" } });
  state.nativeActivity.mockReturnValue({});
  state.cachedHistory.mockReturnValue({ phase: "locked" });
});

describe("contract address routing", () => {
  it("routes contracts directly to their identity without user balances or account history", () => {
    const html = render();
    expect(state.account).toHaveBeenCalledWith(state.address);
    expect(state.contract).toHaveBeenCalledWith(expect.objectContaining({ address: state.address, activity: expect.anything() }));
    expect(html).toContain('data-testid="contract-view"');
    expect(state.nativeActivity).not.toHaveBeenCalled();
    expect(state.cachedHistory).not.toHaveBeenCalled();
    expect(html).not.toContain('aria-label="PCASH balance"');
    expect(html).not.toContain('aria-label="Account sections"');
    expect(html).not.toContain("hasn&#x27;t set up PCASH yet");
    expect(html).not.toContain("#send");
  });

  it("keeps the user account page for user records", () => {
    state.account.mockReturnValue({ accountKind: 0, accountRevision: 1n, receiveKeyHash: `0x${"11".repeat(32)}`, material: { status: "unavailable" } });
    const html = render();
    expect(state.contract).not.toHaveBeenCalled();
    expect(html).toContain("Account history");
  });

  it.each([false, true])("keeps uncached payments private when connected as the owner: %s", (connected) => {
    state.connectedAccount = connected ? state.address : undefined;
    state.account.mockReturnValue({ accountKind: 0, accountRevision: 1n, receiveKeyHash: `0x${"00".repeat(32)}`, material: { status: "notPresent" } });
    const html = render();
    expect(html).toMatch(/<p[^>]*>Balance<\/p>/);
    expect(html).toMatch(/data-testid="wallet-balance"[^>]*><span[^>]*aria-label="Private"[^>]*>\*\*\*\*\*<\/span>/);
    expect(html).not.toContain("Receive privately");
    expect(html).toContain("Account registered");
    expect(html).toContain("This address hasn&#x27;t set up PCASH yet.");
    expect(html).not.toContain("#send");
    expect(html).not.toContain(">Receive</button>");
    expect(html).not.toContain("123 PCASH");
    expect(html).not.toContain("Your account");
    expect(html).not.toContain('data-testid="account-setup"');
    expect(html).not.toContain('data-payment-direction');
    expect(state.nativeActivity).not.toHaveBeenCalled();
  });

  it("offers visitors Send, and the owner Receive", () => {
    state.account.mockReturnValue({ accountKind: 0, accountRevision: 1n, receiveKeyHash: `0x${"11".repeat(32)}`, material: { status: "available", mlKem768PublicKey: "0x00" } });
    const visitor = render();
    expect(visitor).toContain(">Send</button>");
    expect(visitor).not.toContain(">Receive</button>");
    expect(visitor).not.toMatch(/receive code/i);
    state.connectedAccount = state.address.toUpperCase().replace("0X", "0x");
    const owner = render();
    expect(owner).toContain(">Receive</button>");
    expect(owner).not.toContain(">Send</button>");
  });

  it("recognizes a returning owner from the saved sign-in without a connection", () => {
    state.account.mockReturnValue({ accountKind: 0, accountRevision: 1n, receiveKeyHash: `0x${"11".repeat(32)}`, material: { status: "available", mlKem768PublicKey: "0x00" } });
    state.cachedHistory.mockReturnValue({ phase: "ready", checking: false, failed: false, funds: { total: 7n * 10n ** 18n } });
    const html = render();
    expect(html).toContain(">Receive</button>");
    expect(html).not.toContain(">Send</button>");
  });

  it("offers Send to a registered account while the index has not caught up with its receive key", () => {
    state.account.mockReturnValue({ accountKind: 0, accountRevision: 1n, receiveKeyHash: `0x${"11".repeat(32)}`, material: { status: "unavailable", lifecycle: "catchingUp" } });
    const html = render();
    expect(html).toContain(">Send</button>");
    expect(html).not.toContain("hasn&#x27;t set up PCASH yet");
  });

  it("offers the connected owner of an unregistered address setup instead of a notice about themselves", () => {
    state.account.mockReturnValue(null);
    state.connectedAccount = state.address;
    expect(render()).toContain(">Set up PCASH</button>");
    state.connectedAccount = undefined;
    expect(render()).toContain("This address hasn&#x27;t set up PCASH yet.");
  });

  it("keeps address identity on account lookup failure without guessing a user account", () => {
    state.account.mockImplementation(() => { throw new Error("Account lookup unavailable"); });
    const html = render();
    expect(html).toContain(state.address);
    expect(html).toContain("Account lookup unavailable");
    expect(state.contract).not.toHaveBeenCalled();
    expect(state.nativeActivity).not.toHaveBeenCalled();
  });
});

describe("user account page", () => {
  beforeEach(() => {
    state.account.mockReturnValue({ accountKind: 0, accountRevision: 1n, receiveKeyHash: `0x${"11".repeat(32)}`, material: { status: "unavailable" } });
  });

  it.each([
    ["a visitor", undefined, false],
    ["the connected owner before sign-in", `0x${"12".repeat(20)}`, false],
  ])("shows %s the public account history and keeps private data private", (_, connectedAccount, signedIn) => {
    state.connectedAccount = connectedAccount;
    state.signedIn = signedIn;
    const html = render();
    expect(html).toContain("Account history");
    expect(html).toContain("No account events on this page.");
    expect(html).not.toContain("Owner activity");
    expect(html).not.toContain('aria-label="Account sections"');
    expect(html).toMatch(/data-testid="wallet-balance"[^>]*><span[^>]*aria-label="Private"[^>]*>\*\*\*\*\*<\/span>/);
    expect(html).toContain("Account registered");
    expect(html).not.toContain("123 PCASH");
    expect(html.includes("Sign in to see your activity.")).toBe(connectedAccount !== undefined);
  });

  it("shows the signed-in owner one Activity feed instead of the public history", () => {
    state.connectedAccount = state.address;
    state.signedIn = true;
    const html = render();
    expect(html).toContain("Owner activity");
    expect(html).not.toContain("No account events on this page.");
    expect(html).not.toContain("Sign in to see your activity.");
  });

  it("keeps a cached balance without listing private payments to a visitor", () => {
    state.cachedHistory.mockReturnValue({ phase: "ready", checking: false, failed: false, funds: { total: 7n * 10n ** 18n } });
    const html = render();
    expect(state.cachedHistory).toHaveBeenCalledWith(state.address);
    expect(html).toContain("7 PCASH");
    expect(html).toContain("Account history");
    expect(html).not.toContain("Owner activity");
  });
});
