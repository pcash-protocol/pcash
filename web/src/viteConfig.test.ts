import { Config } from "@pcash/sdk/bcfg";
import { describe, expect, it } from "vitest";
import {
  assertProductionBrowserEnvironment,
  browserEnvironment,
  marketplaceBuildEnvironmentDiagnostics,
  VITE_FS_DENY,
  VITE_OPTIMIZE_DEPS_EXCLUDE,
  VITE_OPTIMIZE_DEPS_INCLUDE,
} from "../vite.config.ts";

function configured(env: Record<string, string>): Config {
  const config = new Config("pcash");
  config.load({ env });
  return config;
}

describe("Vite operator/browser environment boundary", () => {
  it("never publishes the operator L1 RPC as the browser endpoint", () => {
    const secret = "https://operator.example/rpc?api_key=do-not-publish";
    const browser = browserEnvironment(configured({ PCASH_L1_RPC: secret }));
    expect(browser.VITE_L1_RPC_URLS).toBeUndefined();
    expect(browser.VITE_L1_CHAIN_ID).toBeUndefined();
    expect(JSON.stringify(browser)).not.toContain(secret);
    expect(() => assertProductionBrowserEnvironment(browser)).toThrow(/PCASH_BROWSER_L1_RPC_URLS/);
  });

  it("publishes only the explicitly browser-safe L1 endpoint", () => {
    const browser = browserEnvironment(configured({
      PCASH_L1_RPC: "https://operator.example/private",
      PCASH_BROWSER_L1_RPC_URLS: "https://public.example/rpc",
      PCASH_L1_CHAIN_ID: "31337",
    }));
    expect(browser.VITE_L1_RPC_URLS).toBe("https://public.example/rpc");
    expect(browser.VITE_L1_CHAIN_ID).toBe("31337");
    expect(() => assertProductionBrowserEnvironment(browser)).not.toThrow();
  });

  it("publishes the Marketplace router address", () => {
    const address = `0x${"12".repeat(20)}`;
    const browser = browserEnvironment(configured({
      PCASH_PAYMENT_ROUTER_ADDRESS: address,
    }));
    expect(browser).toMatchObject({
      VITE_PAYMENT_ROUTER_ADDRESS: address,
    });
    expect(() => assertProductionBrowserEnvironment({
      ...browser,
      VITE_L1_RPC_URLS: "https://public.example/rpc",
      VITE_L1_CHAIN_ID: "11155111",
    })).not.toThrow();
  });

  it("publishes the ENS lookup endpoint", () => {
    expect(browserEnvironment(configured({ PCASH_ENS_RPC_URL: "https://ens.example/rpc" })).VITE_ENS_RPC_URL)
      .toBe("https://ens.example/rpc");
    expect(browserEnvironment(configured({})).VITE_ENS_RPC_URL).toBeUndefined();
  });

  it("allows an all-absent read-only Marketplace configuration", () => {
    expect(() => assertProductionBrowserEnvironment({
      VITE_L1_RPC_URLS: "https://public.example/rpc",
      VITE_L1_CHAIN_ID: "11155111",
    })).not.toThrow();
  });

  it("rejects an invalid Marketplace address", () => {
    expect(() => assertProductionBrowserEnvironment({
      VITE_L1_RPC_URLS: "https://public.example/rpc",
      VITE_L1_CHAIN_ID: "11155111",
      VITE_PAYMENT_ROUTER_ADDRESS: "0x1234",
    })).toThrow(/configuration is invalid/);
  });

  it("passes the explorer data mode through to the browser, normalised once", () => {
    expect(browserEnvironment(configured({ PCASH_MODE: "fixtures" })).VITE_PCASH_MODE).toBe("fixtures");
    // Downstream comparisons are exact and inlined by `define`, so whitespace
    // must be gone before serialization or the mode is half-applied.
    expect(browserEnvironment(configured({ PCASH_MODE: " fixtures " })).VITE_PCASH_MODE).toBe("fixtures");
    expect(browserEnvironment(configured({})).VITE_PCASH_MODE).toBeUndefined();
  });

  it("rejects an invalid browser L1 chain before producing a bundle", () => {
    const browser = browserEnvironment(configured({
      PCASH_BROWSER_L1_RPC_URLS: "https://public.example/rpc",
      PCASH_L1_CHAIN_ID: "1.5",
    }));
    expect(() => assertProductionBrowserEnvironment(browser)).toThrow(
      /PCASH_L1_CHAIN_ID must be a positive decimal integer/,
    );
  });

  it("keeps nested prover workers out of dependency optimization", () => {
    expect(VITE_OPTIMIZE_DEPS_EXCLUDE).toContain("@aztec-foundation/bb.js");
  });

  it("prebundles lazy Noir worker dependencies before a proof begins", () => {
    expect(VITE_OPTIMIZE_DEPS_INCLUDE).toEqual([
      "@noir-lang/acvm_js",
      "@noir-lang/noirc_abi",
    ]);
  });

  it("denies credentials and generated private artifacts from raw filesystem serving", () => {
    expect(VITE_FS_DENY).toEqual(expect.arrayContaining([
      ".env",
      ".env.*",
      "*.{crt,pem}",
      "**/.git/**",
      ".envrc",
      ".envrc.*",
      "**/.envrc",
      "**/.envrc.*",
      "**/.direnv/**",
      "**/.cache/**",
    ]));
  });
});


describe("Marketplace build environment diagnostics", () => {
  it("reports presence without disclosing values", () => {
    const diagnostics = marketplaceBuildEnvironmentDiagnostics(configured({
      PCASH_PAYMENT_ROUTER_ADDRESS: "deployment-private-value",
      PCASH_PAYMENT_ROUTER_FEE_BPS: "",
      PCASH_L1_KEY: "never-log-this",
    }));
    expect(diagnostics).toEqual([
      "[pcash build env] PCASH_PAYMENT_ROUTER_ADDRESS: set",
      "[pcash build env] PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: unset; not used by browser (fees are read from the router)",
      "[pcash build env] PCASH_PAYMENT_ROUTER_FEE_BPS: unset; not used by browser (fees are read from the router)",
    ]);
    expect(diagnostics.join("\n")).not.toMatch(/private-value|never-log-this/);
  });
});
