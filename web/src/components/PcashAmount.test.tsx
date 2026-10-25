import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PcashAmount } from "./PcashAmount.tsx";
import { withLeadingZero } from "./pcashAmount.ts";

describe("PcashAmount", () => {
  it("renders whole PCASH with exact hover and accessible text", () => {
    const html = renderToStaticMarkup(<PcashAmount value={1_025_817_898_339_018_425n} />);
    expect(html).toContain(">1 PCASH<");
    expect(html).toContain("title=\"Exact: 1.025817898339018425 PCASH\"");
    expect(html).toContain("aria-label=\"1.025817898339018425 PCASH\"");
  });

  it("renders a nonzero amount below one PCASH as <1 PCASH with its exact value on hover", () => {
    const html = renderToStaticMarkup(<PcashAmount value={250_000_000_000_000_000n} />);
    expect(html).toContain(">&lt;1 PCASH<");
    expect(html).toContain("title=\"Exact: 0.25 PCASH\"");
  });
});

describe("withLeadingZero", () => {
  it("fills the omitted leading zero of a decimal amount", () => {
    expect(withLeadingZero(".5")).toBe("0.5");
    expect(withLeadingZero(".")).toBe("0.");
    expect(withLeadingZero("1.5")).toBe("1.5");
    expect(withLeadingZero("")).toBe("");
  });
});
