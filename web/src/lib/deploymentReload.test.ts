import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { holdDeploymentReload, reloadForCurrentDeployment } from "./deploymentReload.ts";

const reload = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  reload.mockReset();
  vi.stubGlobal("location", { reload });
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reloads once for a missing chunk, then leaves an immediate repeat to the error page", () => {
  reloadForCurrentDeployment();
  expect(reload).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(9_999);
  reloadForCurrentDeployment();
  expect(reload).toHaveBeenCalledOnce();
});

it("reloads again for a later deployment", () => {
  reloadForCurrentDeployment();
  vi.advanceTimersByTime(10_000);
  reloadForCurrentDeployment();
  expect(reload).toHaveBeenCalledTimes(2);
});

it("does not reload when it cannot remember the previous reload", () => {
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new DOMException("blocked", "SecurityError"); } });
  reloadForCurrentDeployment();
  expect(reload).not.toHaveBeenCalled();
});

it("leaves a missing chunk to the error page while a proof is in flight", () => {
  holdDeploymentReload(true);
  reloadForCurrentDeployment();
  holdDeploymentReload(false);
  expect(reload).not.toHaveBeenCalled();
});
