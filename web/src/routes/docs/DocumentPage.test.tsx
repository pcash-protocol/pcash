// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { routeById } from "../routeManifest.ts";
import { DocumentPage } from "./DocumentPage.tsx";

let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove();
  vi.unstubAllGlobals();
});

const render = (source: string) => act(async () => root.render(<MemoryRouter>
  <DocumentPage route={routeById("whitepaper")} source={source} contentsDepth={2} resolveHref={(href) => href} />
</MemoryRouter>));
const toggle = () => [...element.querySelectorAll("button")].find((button) => button.textContent === "Hide code");
const hidden = () => element.querySelector("article")!.className !== "";

it("hides quoted code on request and remembers the choice", async () => {
  await render("# Title\n\nProse.\n\n```rust node/src/a.rs\nfn f() {}\n```\n");
  expect(hidden()).toBe(false);
  await act(async () => toggle()!.click());
  expect(toggle()!.getAttribute("aria-pressed")).toBe("true");
  expect(hidden()).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(element);
  await render("# Title\n\nProse.\n\n```rust node/src/a.rs\nfn f() {}\n```\n");
  expect(hidden()).toBe(true);
});

it("offers no toggle for a document without quoted code", async () => {
  await render("# Title\n\nProse.\n\n```ts\nconst x = 1;\n```\n");
  expect(toggle()).toBeUndefined();
});
