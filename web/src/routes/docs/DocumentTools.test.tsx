// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bundlePath, evaluateBundle } from "./bundles.ts";
import { CopyBundleForLlm } from "./DocumentTools.tsx";

let root: Root;
let element: HTMLDivElement;
const writeText = vi.fn();
const fetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  writeText.mockReset().mockResolvedValue(undefined);
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove();
  vi.unstubAllGlobals();
});

it("copies the bundle text the site serves", async () => {
  fetch.mockResolvedValue(new Response("served bundle"));
  await act(async () => root.render(<CopyBundleForLlm bundle={evaluateBundle} />));
  const button = element.querySelector("button")!;
  expect(button.textContent).toBe("Copy for LLM");
  await act(async () => button.click());
  expect(fetch).toHaveBeenCalledWith(bundlePath(evaluateBundle));
  expect(writeText).toHaveBeenCalledWith("served bundle");
});

it("reports a bundle the site does not serve", async () => {
  fetch.mockResolvedValue(new Response("missing", { status: 404 }));
  await act(async () => root.render(<CopyBundleForLlm bundle={evaluateBundle} />));
  await act(async () => element.querySelector("button")!.click());
  expect(element.querySelector('[role="status"]')!.textContent).toBe("Copy failed");
  expect(writeText).not.toHaveBeenCalled();
});
