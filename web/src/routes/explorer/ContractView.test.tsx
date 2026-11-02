import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContractSourceView } from "@pcash/sdk/clients";
import { describe, expect, it, vi } from "vitest";
import { fixtureIds, fixtureWorld } from "./fixtures/world.ts";

const state = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => state.index < state.values.length
    ? [state.values[state.index++], () => {}]
    : react.useState(initial) };
});
vi.mock("react-router-dom", () => ({ Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a> }));
vi.mock("./ExplorerProvider.tsx", () => ({ useReadyExplorer: () => ({ reader: {} }) }));
import { shortHex } from "./format.ts";
import { ContractView } from "./ContractView.tsx";

const verified = fixtureWorld.contractSources.get(fixtureIds.contracts.verified[0]!.toLowerCase())!;
const unverified = fixtureWorld.contractSources.get(fixtureIds.contracts.unverified.toLowerCase())!;

function render(view: ContractSourceView | undefined, options: { tab?: string; error?: string; sourceError?: string } = {}) {
  state.index = 0;
  state.values = [view, fixtureWorld.implementations, false, undefined, options.tab ?? "overview", options.error, options.sourceError, undefined, 0];
  return renderToStaticMarkup(<ContractView address={view?.address ?? verified.address} activity={<p>Recorded account activity</p>} />);
}

function expectOneNavigation(html: string) {
  expect(html.match(/<nav\b/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Contract sections"');
  expect(html).toContain("Source &amp; verification");
}

describe("contract account presentation", () => {
  it("leads with verified identity, purpose, committed terms and installed behavior", () => {
    const html = render(verified);
    expect(html).toContain(`<h1>${verified.presentation!.profile.contractName}</h1>`);
    expect(html).toContain(verified.presentation!.profile.contractDescription);
    expect(html).toContain("Source verified · exact match");
    expect(html).toContain("Parameters match commitments");
    expect(html).toContain("Contract terms");
    expect(html).toContain(">0.001 ETH<");
    expect(html).toContain("<dt>Configured amount</dt><dd>1000</dd>");
    expect(html).toContain("What this contract allows");
    expect(html.match(/Inspect function/g)).toHaveLength(verified.contract.functions.length);
    expectOneNavigation(html);
  });

  it("shows installed functions without claiming unverified source is verified", () => {
    const html = render(unverified);
    expect(html).toContain("Source not verified");
    expect(html).toContain(unverified.address);
    expect(html).toContain("What this contract allows");
    expect(html).not.toContain("Source verified · exact match");
    expect(html).not.toContain("Source matches implementation");
    expectOneNavigation(html);
  });

  it("keeps the contract address and navigation available when source lookup fails", () => {
    const html = render(undefined, { error: "Source service unavailable" });
    expect(html).toContain(shortHex(verified.address));
    expect(html).toContain("Source unavailable");
    expect(html).toContain("Retry source lookup");
    expect(html).not.toContain("Source not verified");
    expectOneNavigation(html);
    expect(render(undefined, { error: "Source service unavailable", tab: "activity" })).toContain("Recorded account activity");
  });

  it("shows parameters and proof inputs openly above the source, without nested navigation", () => {
    const html = render(verified, { tab: "source" });
    expectOneNavigation(html);
    expect(html).toContain('aria-label="Select function"');
    expect(html).not.toContain("<summary>Parameters</summary>");
    expect(html).not.toContain("<summary>Proof inputs</summary>");
    const parameters = html.indexOf("<h3>Parameters</h3>");
    const proofInputs = html.indexOf("<h3>Proof inputs</h3>");
    expect(parameters).toBeGreaterThan(-1);
    expect(proofInputs).toBeGreaterThan(parameters);
    expect(html.indexOf("Loading complete source")).toBeGreaterThan(proofInputs);
    expect(html).toContain("Authenticated snapshot");
  });

  it("retains verified identity and terms when an implementation source read fails", () => {
    const html = render(verified, { sourceError: "Some implementation sources could not be loaded." });
    expect(html).toContain(`<h1>${verified.presentation!.profile.contractName}</h1>`);
    expect(html).toContain("Contract terms");
    const source = render(verified, { tab: "source", sourceError: "Some implementation sources could not be loaded." });
    expect(source).toContain("Some implementation sources could not be loaded.");
    expect(source).toContain(">Retry</button>");
  });
});
