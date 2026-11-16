// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { WebsiteSettingsStore, WEBSITE_SETTINGS_KEY } from "./WebsiteSettings.tsx";

beforeEach(() => localStorage.clear());
const create = () => new WebsiteSettingsStore(() => localStorage);
it("shows ENS names and starts Slow by default, and persists each change", () => {
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
  const settings = new WebsiteSettingsStore(() => { throw new Error("Storage disabled"); });
  settings.restore(); settings.setEnsEnabled(false); settings.setDefaultSubmissionMode("fast");
  expect(settings.getSnapshot()).toEqual({ ensEnabled: false, defaultSubmissionMode: "fast" });
});
