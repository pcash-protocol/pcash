import { describe, expect, it } from "vitest";
import { renderDocument } from "../longDocument.ts";
import { publicDocuments } from "../publicDocuments.ts";
import { documentSource } from "../sources.ts";
import { diagrams } from "./index.ts";
import * as moneyIssuanceDiagrams from "./moneyIssuanceDiagrams.tsx";
import * as paymentDiagrams from "./payment.tsx";
import * as systemApplicationDiagrams from "./systemApplicationDiagrams.tsx";
import * as systemAuthorizationDiagrams from "./systemAuthorizationDiagrams.tsx";
import * as systemDerivationDiagrams from "./systemDerivationDiagrams.tsx";
import * as systemStateDiagrams from "./systemStateDiagrams.tsx";

describe("diagram registry", () => {
  it("registers every diagram under its kebab-case name without a trailing Diagram", () => {
    const exported = Object.entries({
      ...moneyIssuanceDiagrams,
      ...paymentDiagrams,
      ...systemApplicationDiagrams,
      ...systemAuthorizationDiagrams,
      ...systemDerivationDiagrams,
      ...systemStateDiagrams,
    }).map(([name, component]) => [name.replace(/Diagram$/, "").replace(/(?<=.)[A-Z]/g, (letter) => `-${letter}`).toLowerCase(), component]);
    expect(diagrams).toEqual(Object.fromEntries(exported));
  });

  it("has every diagram a published document places", () => {
    for (const { file } of publicDocuments) {
      const source = documentSource(file);
      const placed = [...source.matchAll(/data-diagram="([^"]*)"/g)].map((match) => match[1]);
      const rendered = renderDocument(source, (href) => href).blocks.flatMap((block) => block.kind === "diagram" ? [block.slug] : []);
      expect(rendered, file).toEqual(placed);
      for (const slug of rendered) expect(Object.keys(diagrams), file).toContain(slug);
    }
  });
});
