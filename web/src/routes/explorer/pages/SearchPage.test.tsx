import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ value: undefined as unknown, error: undefined as string | undefined }));
vi.mock("../ExplorerProvider.tsx", () => ({ useReadyExplorer: () => ({ reader: {} }) }));
vi.mock("../ui.tsx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ui.tsx")>(),
  useRead: () => ({ value: state.value, error: state.error, reload: () => undefined }),
}));
import { SearchPage } from "./SearchPage.tsx";

const query = `0x${"ab".repeat(32)}`;
const render = () => renderToStaticMarkup(<MemoryRouter initialEntries={[`/search?q=${query}`]}><SearchPage /></MemoryRouter>);

describe("hash search", () => {
  it("says there are no results when every lookup answered and none matched", () => {
    state.value = [];
    state.error = undefined;
    expect(render()).toContain(`No results for ${query}`);
  });

  it("reports a failed lookup instead of an empty result", () => {
    state.value = undefined;
    state.error = "The network did not respond. Try again in a moment.";
    const html = render();
    expect(html).toContain("The network did not respond");
    expect(html).not.toContain("No results");
  });
});
