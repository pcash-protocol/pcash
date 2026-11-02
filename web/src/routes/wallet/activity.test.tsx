// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GetActivityProvider, useGetActivity } from "../../lib/GetActivity.tsx";
import { useWalletActivity } from "./activity.ts";
const wallet = vi.hoisted(() => ({ busy: true, paymentStage: { state: "idle" } }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => wallet }));
vi.mock("./OwnerPanels.tsx", () => ({ useWalletPanel: () => ({ unseenOutcome: false }) }));
let root: Root;
let element: HTMLDivElement;
let activity: ReturnType<typeof useWalletActivity>;
let setGet: ReturnType<typeof useGetActivity>["setActivity"];
function Probe() { activity = useWalletActivity(); setGet = useGetActivity().setActivity; return null; }
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await act(async () => root.render(<GetActivityProvider><Probe /></GetActivityProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
it("does not label unrelated busy wallet work as mining", () => {
  expect(activity.mining).toBe(false);
  expect(activity.unsafeToLeave).toBe(false);
});
it("tracks publication separately from work that would be lost on reload", async () => {
  await act(async () => setGet({ working: true, unsafeToLeave: true }));
  expect(activity.mining).toBe(true);
  expect(activity.unsafeToLeave).toBe(true);
  await act(async () => setGet({ working: true, unsafeToLeave: false }));
  expect(activity.mining).toBe(true);
  expect(activity.unsafeToLeave).toBe(false);
  await act(async () => setGet({ working: false, unsafeToLeave: false }));
  expect(activity.mining).toBe(false);
});
