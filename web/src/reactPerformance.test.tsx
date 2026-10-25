// @vitest-environment jsdom
import { act, Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

// jsdom omits the browser APIs that enable React's development performance
// tracks. Exercise that path: wallet and proof props contain BigInt arrays.
const timing = vi.hoisted(() => {
  const measure = vi.fn();
  Object.defineProperty(performance, "measure", { configurable: true, value: measure });
  console.timeStamp = vi.fn();
  return { measure };
});

function ListingView({ proof, onRefresh }: {
  proof: { publicInputs: bigint[] } | undefined;
  onRefresh: () => void;
}) {
  return <button onClick={onRefresh}>Refresh {proof?.publicInputs[0]?.toString() ?? "pending"}</button>;
}

function ListingHarness() {
  const [revision, setRevision] = useState(0);
  return <ListingView proof={revision === 0 ? undefined : { publicInputs: [BigInt(revision), 2n] }}
    onRefresh={() => setRevision(value => value + 1)} />;
}

it("keeps rendering and accepting clicks after BigInt proof props change with performance tracks enabled", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Profiler id="listing" onRender={() => {}}><ListingHarness /></Profiler>));
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("Refresh 1");
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("Refresh 2");
    expect(timing.measure.mock.calls.some(([name]) => String(name).includes("ListingView"))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
