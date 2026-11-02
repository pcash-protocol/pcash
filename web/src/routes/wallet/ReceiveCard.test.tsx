import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => ({}) }));
import { ReceiveCard } from "./OwnerPanels.tsx";

const address = `0x${"ab".repeat(20)}`;

describe("receive card", () => {
  it("shares the profile link as text with a copy button and as a QR code, with no receive code", () => {
    vi.stubGlobal("location", { origin: "https://pcash.example" });
    const html = renderToStaticMarkup(<ReceiveCard address={address} />);
    vi.unstubAllGlobals();
    const link = `https://pcash.example/${address}`;
    expect(html.replace(/<\/?span>/g, "")).toContain(`>${link}</code>`);
    expect(html).toContain('aria-label="Copy profile link"');
    expect(html).toContain('aria-label="QR code of your profile link"');
    expect(html).not.toMatch(/receive code/i);
    expect(html).not.toContain("<textarea");
  });
});
