// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTokensApp } from "./useTokensApp.ts";

vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => ({}) }));

let root: Root;
let element: HTMLDivElement;
let tokens: ReturnType<typeof useTokensApp>;
function Probe() {
  tokens = useTokensApp();
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("keeps a claim proof's measurement that arrives together with the next update", async () => {
  await act(async () => root.render(<Probe />));
  const finalized = { phase: "proving", message: "prove chonk-finalize", elapsedMs: 0, step: "prove", scope: "stack", operation: "finalize", circuitCount: 4, durationMs: 8_000 } as const;
  await act(async () => {
    tokens.onProgress({ phase: "proving", message: finalized.message, proof: finalized });
    tokens.onProgress({ phase: "submitting", message: "Submitting the claim…" });
  });
  expect(tokens.progress?.phase).toBe("submitting");
  expect(JSON.parse(localStorage.getItem("pcash:proof-timings")!)).toEqual({ "finalize:4": 8_000 });
});
