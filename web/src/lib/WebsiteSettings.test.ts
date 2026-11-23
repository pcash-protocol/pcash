// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { defaultPreferences, WebsiteSettingsStore, WEBSITE_SETTINGS_KEY } from "./WebsiteSettings.tsx";

beforeEach(() => localStorage.clear());
const MAINNET = defaultPreferences(1);
const create = () => new WebsiteSettingsStore(() => localStorage, MAINNET);
it("starts More private on Ethereum mainnet and Faster on a testnet, showing ENS names on both", () => {
  expect(defaultPreferences(1)).toEqual({ ensEnabled: true, defaultSubmissionMode: "slow" });
  expect(defaultPreferences(11155111)).toEqual({ ensEnabled: true, defaultSubmissionMode: "fast" });
});
it("starts at its defaults and persists each change", () => {
  const settings = create(); settings.restore();
  expect(settings.getSnapshot()).toEqual({ ensEnabled: true, defaultSubmissionMode: "slow" });
  expect(localStorage.getItem(WEBSITE_SETTINGS_KEY)).toBeNull();
  settings.setEnsEnabled(false);
  settings.setDefaultSubmissionMode("fast");
  const restored = create(); restored.restore();
  expect(restored.getSnapshot()).toEqual({ ensEnabled: false, defaultSubmissionMode: "fast" });
});
it.each(["bad json", "null", "[]", '{"ensEnabled":"yes","defaultSubmissionMode":"fast"}', '{"ensEnabled":false,"defaultSubmissionMode":"invalid"}'])("uses the defaults for invalid browser data: %s", (saved) => {
  localStorage.setItem(WEBSITE_SETTINGS_KEY, saved);
  const settings = create(); settings.restore();
  expect(settings.getSnapshot()).toEqual({ ensEnabled: true, defaultSubmissionMode: "slow" });
});
it("works for the current tab when storage is unavailable", () => {
  const settings = new WebsiteSettingsStore(() => { throw new Error("Storage disabled"); }, MAINNET);
  settings.restore(); settings.setEnsEnabled(false); settings.setDefaultSubmissionMode("fast");
  expect(settings.getSnapshot()).toEqual({ ensEnabled: false, defaultSubmissionMode: "fast" });
});
