// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { PublicationProgress } from "./PublicationProgress.tsx";
import { PCASH_UNIT } from "../../components/pcashAmount.ts";
import type { MarketplaceProgress, OfferPublication } from "@pcash/marketplace/app";

const contentHash = `0x${"ab".repeat(32)}`;
const progress: MarketplaceProgress = { action: "publish", phase: "confirming", message: "Waiting for your listing creation to be confirmed.", elapsedMs: 0, publication: { step: "funding", contentHash } };
const publication = { terms: { assetId: "0", amount: "1000000000000000000", ethPriceWei: "1000000000000000", deadlineT: "2000000000" } } as OfferPublication;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); });
function setup() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  return { container, render: async (props: Parameters<typeof PublicationProgress>[0]) => act(async () => root.render(<MemoryRouter><PublicationProgress {...props} /></MemoryRouter>)) };
}

it("shows the listed terms while Ethereum confirms the listing posted from the user's wallet", async () => {
  const { container, render } = setup();
  await render({ progress: { ...progress, phase: "submitting" }, busy: true, pendingPublication: publication, onFinalize: vi.fn() });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Posting your listing to Ethereum. Gas is paid in ETH.");
  await render({ progress, busy: true, pendingPublication: publication, onFinalize: vi.fn() });
  expect(container.querySelector("h2")?.textContent).toBe("Creating your listing");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Waiting for Ethereum to confirm your listing…");
  expect(container.textContent).toContain("1 PCASH");
  expect(container.textContent).not.toContain("~");
  expect(container.querySelector('[aria-label="Listing inputs"]')?.textContent).toContain("Your Ethereum wallet");
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.querySelector("details")).toBeNull();
});

it("changes the human readable message as approvals and proof generation progress", async () => {
  const { container, render } = setup();
  const funding = { ...progress, phase: "proving" as const, publication: { step: "funding" as const } };
  await render({ progress: funding, busy: true, awaitingSignature: true });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Sign in your wallet to create and fund the listing. Signing is free.");
  await render({ progress: { ...funding, publication: { step: "funding" } }, busy: true, awaitingSignature: true });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Sign in your wallet to create and fund the listing. Signing is free.");
  await render({ progress: { ...funding, phase: "submitting" }, busy: true, confirmInWallet: true });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Confirm in your wallet");
  await render({ progress: funding, busy: true, proof: { phase: "proving", step: "crs", message: "CRS", elapsedMs: 0 } });
  expect(container.textContent).toContain("Loading proving data");
  expect(container.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
  await render({ progress: funding, busy: true, proof: { phase: "proving", step: "prove", message: "Proving", elapsedMs: 30_000 } });
  expect(container.textContent).toContain("Generating your proof");
  expect(container.querySelector('[aria-label="Transaction details"]')?.textContent).toContain("Proving");
  expect(container.querySelectorAll('[aria-label="Transaction details"]')).toHaveLength(1);
  expect(container.querySelector("details")).toBeNull();
});

it("offers one Continue after an interruption and shows transaction details", async () => {
  const { container, render } = setup();
  const resume = vi.fn();
  await render({ progress: { ...progress, phase: "error", message: "RPC unavailable" }, busy: false,
    pendingPublication: publication, onFinalize: resume });
  expect(container.querySelector('[role="status"]')?.textContent).toContain("progress is saved");
  expect(container.querySelector('[aria-label="Transaction details"]')?.textContent).toContain("RPC unavailable");
  expect(container.querySelector("details")).toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  await act(async () => container.querySelector("button")!.click());
  expect(resume).toHaveBeenCalledOnce();
});

it("says progress is saved only once a listing transaction exists", async () => {
  const { container, render } = setup();
  const failed = { ...progress, phase: "error" as const, message: "User rejected the request" };
  await render({ progress: { ...failed, publication: { step: "funding" } }, busy: false, onFinalize: vi.fn() });
  expect(container.querySelector("h2")?.textContent).toBe("Your listing was not created");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Nothing was submitted. You can change the listing and publish it again.");
  expect(container.textContent).not.toContain("Review Ethereum submission");
  expect(container.querySelectorAll("button")).toHaveLength(0);
  await render({ progress: failed, busy: false, onFinalize: vi.fn() });
  expect(container.querySelector("h2")?.textContent).toBe("Your listing needs attention");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Your progress is saved.");
});

it("shows completion only when publication finishes", async () => {
  const { container, render } = setup();
  await render({ progress: { ...progress, phase: "submitting", publication: { step: "catalog" } }, busy: true });
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Making your listing available");
  await render({ progress: { ...progress, phase: "done", publication: { step: "catalog" } }, busy: false, pendingPublication: publication });
  expect(container.textContent).toContain("Your listing is live");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("labels the listing link as a submission for the current stage", async () => {
  const { container, render } = setup();
  await render({ progress, busy: true });
  const link = () => container.querySelector<HTMLAnchorElement>(`a[href="/tx/${contentHash}"]`)!;
  expect(link().textContent).toBe("View listing submission");
  expect(container.textContent).not.toContain("View PCASH transaction");
  await render({ progress: { ...progress, publication: { step: "funding", contentHash } }, busy: true });
  expect(link().textContent).toBe("View listing submission");
});

it("repeats the listed terms only when no listing form shows them", async () => {
  const { container, render } = setup();
  await render({ progress, busy: false, pendingPublication: publication });
  expect(container.querySelector('[aria-label="Listing inputs"]')?.textContent).toContain("1 PCASH");
  await render({ progress, busy: false, pendingPublication: publication, inputs: { amount: 10n ** 18n, unit: PCASH_UNIT, price: 10n ** 15n } });
  expect(container.querySelector('[aria-label="Listing inputs"]')).toBeNull();
});
