import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureIds, fixtureStatus } from "../fixtures/world.ts";
import { createFixtureReader } from "../fixtures/reader.ts";
import { relayDeploymentKey, relayHistoryKey, saveRelayHistory } from "../../../shared/relayHistory.ts";
import { addressPath } from "../paths.ts";

const state = vi.hoisted(() => ({ value: undefined as unknown, error: undefined as string | undefined, options: {} as { pollMs?: number } }));
vi.mock("../ExplorerProvider.tsx", async () => {
  const { fixtureStatus } = await import("../fixtures/world.ts");
  return { useReadyExplorer: () => ({ status: fixtureStatus, reader: {} }) };
});
vi.mock("../ui.tsx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ui.tsx")>(),
  useRead: (_load: unknown, _dependencies: unknown, options: { pollMs?: number }) => { state.options = options; return { ...state, reload: () => undefined }; },
}));
import { BatchPage, batchReason, loadBatchView } from "./BatchPage.tsx";

function render(id: string) {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[`/batch/${id}`]}><Routes>
    <Route path="/batch/:hash" element={<BatchPage />} />
  </Routes></MemoryRouter>);
}

afterEach(() => { vi.unstubAllGlobals(); state.error = undefined; state.value = undefined; });

describe("batch details", () => {
  it("tracks a known local hash before the node has its manifest without calling unknown hashes pending", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const network = relayDeploymentKey({ ...fixtureStatus, genesisHash: fixtureStatus.genesisHash.toUpperCase(), inboxAddress: fixtureStatus.inboxAddress.toUpperCase() });
    const id = fixtureIds.batches.allExcluded;
    saveRelayHistory(relayHistoryKey(network, "alice"), [{ id: "local", at: 0, contentHashes: [], txHash: id, status: "pending" }]);
    state.value = { batches: [], outcome: null };
    expect(render(id)).toContain("Waiting for the batch");
    expect(state.options.pollMs).toBe(5_000);
    expect(render(`0x${"ff".repeat(32)}`)).toContain("Batch not found");
    expect(render(`0x${"ff".repeat(32)}`)).not.toContain("Waiting for the batch");
  });

  it("keeps the batch and table visible during a failed refresh", async () => {
    const id = fixtureIds.batches.allExcluded;
    state.value = await loadBatchView(createFixtureReader(), id, fixtureStatus.genesisL1Block);
    state.error = "node offline";
    const html = render(id);
    expect(html).toContain("Update delayed.");
    expect(html).toContain("Carrier");
    expect(html).toContain("Block index");
    expect(html).toContain("Raw batch details");
    state.error = undefined;
    expect(render(id)).not.toContain("Update delayed.");
  });

  it("shows every carrier of the Ethereum transaction, with an event's emitter, log, and context", async () => {
    const id = fixtureIds.batches.allAdmitted;
    const view = await loadBatchView(createFixtureReader(), id, fixtureStatus.genesisL1Block);
    const inbox = view.batches[0]!;
    const emitter = `0x${"7e".repeat(20)}`;
    const event = {
      ...inbox,
      carrierType: "event" as const,
      logIndex: 3n,
      emitter,
      context: "0xc017e0",
      blobVersionedHashes: [],
      items: inbox.items.map((item, index) => ({ ...item, batchItemIndex: BigInt(inbox.items.length + index) })),
    };
    const malformed = { ...event, logIndex: 4n, context: null, exclusionReason: "invalidCarrierEncoding" as const, items: [] };
    state.value = { ...view, batches: [inbox, event, malformed] };
    const html = render(id);
    expect(html).toContain("Inbox calldata");
    expect(html).toContain("Carrier event, log 3");
    expect(html).toContain("Carrier event, log 4");
    expect(html).toContain(`href="${addressPath(emitter)}"`);
    expect(html).toContain("0xc017e0");
    expect(html).toContain("Not decoded");
    expect(html).toContain("Invalid carrier encoding");
    expect(html).toContain(`>${inbox.items.length}</td>`);
  });

  it("renders protocol exclusion codes as readable labels", () => {
    expect(batchReason("itemTooLarge")).toBe("Item too large");
    expect(batchReason("wrongChainId")).toBe("Wrong chain ID");
    expect(batchReason("directModeOutsideInbox")).toBe("Direct mode outside inbox");
  });
});
