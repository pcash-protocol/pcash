// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton.tsx";

let root: Root;
let element: HTMLDivElement;
const writeText = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  writeText.mockReset().mockResolvedValue(undefined);
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
const button = () => element.querySelector("button")!;
const status = () => element.querySelector('[role="status"]')!.textContent;

const icon = () => button().querySelector("path")!.getAttribute("d");
const CHECK = "M20 6 9 17l-5-5";

it("confirms a copy with a check icon, then returns to the copy icon", async () => {
  await act(async () => root.render(<CopyButton value="0xabc" label="Copy hash" />));
  expect(button().getAttribute("aria-label")).toBe("Copy hash");
  expect(button().title).toBe("Copy hash");
  expect(button().textContent).toBe("");
  expect(icon()).not.toBe(CHECK);
  await act(async () => button().click());
  expect(writeText).toHaveBeenCalledWith("0xabc");
  expect(icon()).toBe(CHECK);
  expect(status()).toBe("Copied");
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(icon()).not.toBe(CHECK);
  expect(status()).toBe("");
});

it("shows its label as text when asked, named by that text", async () => {
  await act(async () => root.render(<CopyButton value="link" label="Copy link" showLabel />));
  expect(button().textContent).toBe("Copy link");
  expect(button().hasAttribute("aria-label")).toBe(false);
});

it("keeps the icon style when a caller adds a class, and uses only the caller's class for a labelled button", async () => {
  await act(async () => root.render(<CopyButton value="x" label="Copy" />));
  const iconClasses = button().className.split(" ");
  await act(async () => root.render(<CopyButton value="x" label="Copy" className="extra" />));
  expect(button().className.split(" ")).toEqual([...iconClasses, "extra"]);
  await act(async () => root.render(<CopyButton value="x" label="Copy" className="button" showLabel />));
  expect(button().className.split(" ")).toEqual([iconClasses[0], "button"]);
});

it("reports a blocked clipboard", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const onFailed = vi.fn();
  await act(async () => root.render(<CopyButton value="link" label="Copy link" onFailed={onFailed} />));
  await act(async () => button().click());
  expect(button().dataset.copyState).toBe("failed");
  expect(button().title).toContain("copy it manually");
  expect(status()).toBe("Copy failed");
  expect(onFailed).toHaveBeenCalledOnce();
});

it("clears its reset timer on unmount", async () => {
  await act(async () => root.render(<CopyButton value="x" label="Copy" />));
  await act(async () => button().click());
  await act(async () => root.render(<></>));
  expect(vi.getTimerCount()).toBe(0);
});

it("fetches the text on click when given a loader", async () => {
  const load = vi.fn().mockResolvedValue("fetched");
  await act(async () => root.render(<CopyButton load={load} label="Copy" />));
  expect(button().disabled).toBe(false);
  expect(load).not.toHaveBeenCalled();
  await act(async () => button().click());
  expect(load).toHaveBeenCalledOnce();
  expect(writeText).toHaveBeenCalledWith("fetched");
  expect(status()).toBe("Copied");
});

it("starts a pending clipboard item inside the click where the browser has one", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  class Item { constructor(readonly items: Record<string, Promise<Blob>>) {} }
  vi.stubGlobal("ClipboardItem", Item);
  vi.stubGlobal("navigator", { clipboard: { writeText, write } });
  let release!: (text: string) => void;
  await act(async () => root.render(<CopyButton load={() => new Promise((resolve) => { release = resolve; })} label="Copy" />));
  await act(async () => button().click());
  expect(write).toHaveBeenCalledOnce();
  release("later");
  const [item] = write.mock.calls[0]![0] as Item[];
  expect(await (await item!.items["text/plain"]!).text()).toBe("later");
  expect(writeText).not.toHaveBeenCalled();
});

it("reports a failed load", async () => {
  await act(async () => root.render(<CopyButton load={() => Promise.reject(new Error("offline"))} label="Copy" />));
  await act(async () => button().click());
  expect(status()).toBe("Copy failed");
  expect(writeText).not.toHaveBeenCalled();
});

it("is disabled without a value", async () => {
  await act(async () => root.render(<CopyButton value={undefined} label="Copy" />));
  expect(button().disabled).toBe(true);
});
