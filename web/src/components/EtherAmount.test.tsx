import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EtherAmount, formatEtherAmount } from "./EtherAmount.tsx";
import { unitPriceWei } from "../routes/marketplace/listingPrice.ts";
import type { OfferPublication } from "@pcash/marketplace/app";

describe("EtherAmount", () => {
  it("renders wei at three decimals with the exact amount in hover text", () => {
    expect(formatEtherAmount(1_250_000_000_000_000n)).toBe("0.001 ETH");
    expect(formatEtherAmount(1_250_000_000_000_000n, "up")).toBe("0.002 ETH");
    expect(formatEtherAmount(42_345_000_000_000n)).toBe("0.000042 ETH");
    expect(formatEtherAmount(1n)).toBe("0.000000000000000001 ETH");
    const html = renderToStaticMarkup(<EtherAmount value={1_250_000_000_000_000n} />);
    expect(html).toContain(">0.001 ETH<");
    expect(html).toContain("Exact: 0.00125 ETH");
  });
  it("labels rounded per-unit prices as approximate, including sub-wei prices", () => {
    const price = unitPriceWei({ terms: { amount: (10n ** 25n).toString(), ethPriceWei: "1" } } as OfferPublication);
    const html = renderToStaticMarkup(<EtherAmount value={price.wei} approximate={price.approximate} />);
    expect(html).toContain(">0.000000000000000001 ETH<");
    expect(html).toContain('title="Approximate: 0.000000000000000001 ETH"');
    expect(html).toContain('aria-label="Approximately 0.000000000000000001 ETH"');
    expect(html).not.toContain("Exact:");
  });
  it("keeps divisible per-unit prices exact", () => {
    const price = unitPriceWei({ terms: { amount: (2n * 10n ** 18n).toString(), ethPriceWei: "2500000000000000" } } as OfferPublication);
    const html = renderToStaticMarkup(<EtherAmount value={price.wei} approximate={price.approximate} />);
    expect(html).toContain('title="Exact: 0.00125 ETH"');
    expect(html).toContain('aria-label="0.00125 ETH"');
    expect(html).not.toContain("Approximate");
  });
});
