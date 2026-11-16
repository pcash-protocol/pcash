// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProofProgress } from "./ProofProgress.tsx";

let root: Root;
let element: HTMLDivElement;
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
const bar = () => element.querySelector('[role="progressbar"]')!;

const finalize = { phase: "proving", message: "prove chonk-finalize", elapsedMs: 0, step: "prove", scope: "stack", operation: "finalize", circuitCount: 4 } as const;

it("moves without a position until the prover reports a stage", async () => {
  await act(async () => root.render(<ProofProgress />));
  expect(bar().hasAttribute("aria-valuenow")).toBe(false);
  expect(element.textContent).toContain("Generating your proof on this device.");
});

it("fills by stage and estimates the time left once this device has measured every operation", async () => {
  await act(async () => root.render(<ProofProgress proof={finalize} />));
  expect(Number(bar().getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  expect(element.textContent).toContain("Finishing the proof.");
  expect(element.textContent).not.toContain("left");

  localStorage.setItem("pcash:proof-timings", JSON.stringify({
    load: 100, execute: 500, fold: 1_000, "start:4": 200, "finalize:4": 8_000, "compress:4": 1_000,
  }));
  await act(async () => root.render(<ProofProgress proof={{ ...finalize }} />));
  expect(element.textContent).toMatch(/About \d+ seconds left/);
});
