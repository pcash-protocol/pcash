import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { useNativeActivity } from "../../lib/useNativeActivity.ts";
type WalletNativeActivity = NonNullable<ReturnType<typeof useNativeActivity>["activity"]>;

const state = vi.hoisted(() => {
  const address = `0x${"12".repeat(20)}`;
  const status = { pcashChainId: 1n, l1ChainId: 1n, genesisHash: "0xgenesis", latestBlockHash: "head-a", finalizedBlock: 0n, inboxAddress: `0x${"34".repeat(20)}` };
  const wallet = { nativeActivity: vi.fn() };
  return { address, status, wallet, context: {
    wallet, connectedAccount: address, profile: { address: BigInt(address) } as { address: bigint } | undefined,
    snapshot: { address, syncedThrough: { pcashHash: "head-a", pcashNumber: 1n } },
    funds: { total: 5n * 10n ** 18n }, status, phase: "ready", busy: false,
    syncState: { state: "idle" }, paymentActivity: [], awaitingConfirmation: new Map(), accountRecord: "present",
    paymentStage: { state: "idle" },
  } };
});
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.context, errorMessage: (cause: unknown) => String(cause) }));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ ethereumConfig: {}, l1ChainId: 1 }) }));
vi.mock("../../components/NetworkContext.tsx", () => ({ useNetwork: () => ({ network: { l1ChainId: 1, pcashChainId: 1 } }) }));
import { MiningBalance } from "./MiningBalance.tsx";
import { OwnerPanelsProvider } from "./OwnerPanels.tsx";
import { Activity } from "./Activity.tsx";

function recovered(head: string, amount: bigint): WalletNativeActivity {
  return { state: "ready", pcashHash: head, pcashNumber: head === "head-a" ? 1n : 2n,
    entries: amount === 0n ? [] : [{ transactionId: `0x${"56".repeat(32)}`, direction: "received", amount, blockNumber: 1n, blockHash: "head-a", timestamp: 100n, payout: null, commitments: [] }] };
}
function render(client: QueryClient) {
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/${state.address}`]}><OwnerPanelsProvider><MiningBalance testId="wallet-sidebar-balance" /><Activity compact /></OwnerPanelsProvider></MemoryRouter></QueryClientProvider>);
}

// QueryObserver completes real cache refreshes; SSR exercises the actual hook and page consumers without running effects.
describe("owner history refresh failure", () => {
  it.each([5n * 10n ** 18n, 0n])("marks cached history stale after a failed refresh and clears the notice on recovery (%s)", async (amount) => {
    state.context.snapshot = { address: state.address, syncedThrough: { pcashHash: "head-a", pcashNumber: 1n } };
    state.context.funds = { total: 5n * 10n ** 18n };
    state.wallet.nativeActivity.mockReset().mockResolvedValue(recovered("head-a", amount));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(client);
    const query = client.getQueryCache().getAll().find((entry) => entry.queryKey[0] === "native-activity")!;
    const observer = new QueryObserver(client, { ...query.options, queryKey: query.queryKey });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(render(client)).toContain('data-history-state="ready"');
      state.context.snapshot = { address: state.address, syncedThrough: { pcashHash: "head-b", pcashNumber: 2n } };
      state.context.funds = { total: 3n * 10n ** 18n };
      state.wallet.nativeActivity.mockRejectedValue(new Error("history RPC offline"));
      const failed = await observer.refetch();
      expect(failed.isError).toBe(true);
      expect(failed.data).toEqual(recovered("head-a", amount));
      const html = render(client);
      expect(html).toContain('data-history-state="stale"');
      expect(html).toContain('data-history-current="false"');
      expect(html).toContain("Payment history couldn’t refresh. Showing last known payment history.");
      expect(html).toContain("Retry history");
      expect(html).toMatch(/data-testid="wallet-sidebar-balance"[^>]*><span[^>]*aria-label="3 PCASH"/);
      expect(html).not.toContain("No activity yet");
      if (amount !== 0n) expect(html).toMatch(/data-activity-kind="received".*Received <span[^>]*aria-label="5 PCASH"/);
      state.wallet.nativeActivity.mockResolvedValue(recovered("head-b", amount));
      await observer.refetch();
      const restored = render(client);
      expect(restored).toContain('data-history-state="ready"');
      expect(restored).toContain('data-history-current="true"');
      expect(restored).not.toContain("Retry history");
      expect(restored).not.toContain("Showing last known");
    } finally { unsubscribe(); client.clear(); }
  });
});


describe("locked owner balance", () => {
  it.each(["present", "absent"])("keeps a locked %s account balance private", (accountRecord) => {
    const previous = { profile: state.context.profile, phase: state.context.phase, accountRecord: state.context.accountRecord };
    const client = new QueryClient();
    state.context.profile = undefined;
    state.context.phase = "sign-in-required";
    state.context.accountRecord = accountRecord;
    try {
      const html = render(client);
      expect(html).toMatch(/data-testid="wallet-sidebar-balance"[^>]*>—<\/output>/);
      expect(html).not.toContain("5 PCASH");
      expect(html).not.toContain("Public minimum");
    } finally { Object.assign(state.context, previous); client.clear(); }
  });
});
