// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HelpTip, Tooltip } from "./Tooltip.tsx";

let element: HTMLDivElement;
let root: Root;
/** Escape presses that reached an enclosing element's handler. A dialog also needs the default action left alone to close. */
let outerEscapes: number;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  outerEscapes = 0;
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await act(async () => root.render(<div onKeyDown={(event) => { if (event.key === "Escape") outerEscapes += 1; }}>
    <HelpTip label="About speeds" tip="Speed help" />
    <Tooltip tip="Name help">{(id) => <button type="button" aria-describedby={id}>Names</button>}</Tooltip>
  </div>));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

const help = () => element.querySelector<HTMLButtonElement>('button[aria-label="About speeds"]')!;
const tipOf = (control: HTMLElement) => document.getElementById(control.getAttribute("aria-describedby")!)!;
const names = () => [...element.querySelectorAll("button")].find((node) => node.textContent === "Names")!;
const pointer = (type: "pointerover" | "pointerout") => act(async () => {
  help().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", relatedTarget: type === "pointerout" ? document.body : null }));
});
async function escape(target: HTMLElement): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

it("takes Escape for an open help tip so an enclosing dialog stays open, and passes it on once closed", async () => {
  await act(async () => help().click());
  expect(tipOf(help()).hidden).toBe(false);
  const first = await escape(help());
  expect(tipOf(help()).hidden).toBe(true);
  expect(first.defaultPrevented).toBe(true);
  expect(outerEscapes).toBe(0);
  const second = await escape(help());
  expect(second.defaultPrevented).toBe(false);
  expect(outerEscapes).toBe(1);
});

it("closes a hovered help tip on the click that unpins it until the pointer leaves and re-enters", async () => {
  await pointer("pointerover");
  expect(tipOf(help()).hidden).toBe(false);
  await act(async () => help().click());
  expect(tipOf(help()).hidden).toBe(false);
  await act(async () => help().click());
  expect(tipOf(help()).hidden).toBe(true);
  expect(help().getAttribute("aria-expanded")).toBe("false");
  await pointer("pointerout");
  expect(tipOf(help()).hidden).toBe(true);
  await pointer("pointerover");
  expect(tipOf(help()).hidden).toBe(false);
});

it("takes Escape for an open focus tooltip and passes it on once closed", async () => {
  await act(async () => names().focus());
  expect(tipOf(names()).hidden).toBe(false);
  const first = await escape(names());
  expect(tipOf(names()).hidden).toBe(true);
  expect(first.defaultPrevented).toBe(true);
  expect(outerEscapes).toBe(0);
  const second = await escape(names());
  expect(second.defaultPrevented).toBe(false);
  expect(outerEscapes).toBe(1);
});
