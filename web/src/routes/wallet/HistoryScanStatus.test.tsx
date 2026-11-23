import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletHistoryState } from "../../lib/WalletProvider.tsx";

const state = vi.hoisted(() => ({ wallet: {} as Record<string, unknown> }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
import { MiningBalance } from "./MiningBalance.tsx";

const render = (history: WalletHistoryState) => {
  state.wallet.history = history;
  return renderToStaticMarkup(<MiningBalance testId="balance" />);
};

beforeEach(() => {
  state.wallet = { profile: {}, funds: { total: 10n ** 18n }, syncState: { state: "idle" }, busy: false };
});

describe("earlier payments under the balance", () => {
  it("shows nothing once the history is scanned", () => {
    const html = render({ pending: false });
    expect(html).toContain("<span>Your balance</span>");
    expect(html).not.toContain("earlier payments");
  });

  it.each([
    ["before the first page", undefined],
    ["with nothing to scan", { scanned: 0n, total: 0n }],
  ])("shows the search without a percentage %s", (_name, outputs) => {
    const html = render({ pending: true, ...(outputs === undefined ? {} : { outputs }) });
    expect(html).toContain("<p>Searching for earlier payments…</p>");
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain("aria-valuenow");
  });

  it("shows how much of the history has been scanned", () => {
    const html = render({ pending: true, outputs: { scanned: 12_380n, total: 23_541n } });
    expect(html).toContain("<span>Estimated balance</span>");
    expect(html).toContain("<p>Searching for earlier payments… 52%</p>");
    expect(html).toContain('aria-valuenow="52"');
  });

  it("shows a failed attempt in place of the progress", () => {
    const html = render({ pending: true, outputs: { scanned: 1n, total: 2n }, error: "The network did not respond. Try again in a moment." });
    expect(html).toContain("<p>Searching for earlier payments failed. The network did not respond. Try again in a moment.</p>");
    expect(html).not.toContain("%");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("<button");
  });

  it("leaves a failed sync to its own message and retry", () => {
    state.wallet.syncState = { state: "error", error: "The network did not respond. Try again in a moment." };
    const html = render({ pending: true });
    expect(html).toContain("Retry checking payments");
    expect(html).not.toContain("earlier payments");
  });
});
