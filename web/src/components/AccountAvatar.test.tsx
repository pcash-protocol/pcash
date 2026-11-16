// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { blo } from "blo";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountAvatar } from "./AccountAvatar.tsx";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const AVATAR = "https://euc.li/alice.eth";
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove();
  vi.unstubAllGlobals();
});
const image = () => element.querySelector("img")!;

it("requests an ENS avatar with CORS and falls back to the address icon when it fails", async () => {
  await act(async () => root.render(<AccountAvatar address={ADDRESS} avatar={AVATAR} />));
  expect(image().getAttribute("src")).toBe(AVATAR);
  expect(image().crossOrigin).toBe("anonymous");
  await act(async () => image().dispatchEvent(new Event("error")));
  expect(image().getAttribute("src")).toBe(blo(ADDRESS));
  expect(image().hasAttribute("crossorigin")).toBe(false);
});
