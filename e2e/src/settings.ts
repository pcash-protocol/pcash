import { Config } from "@pcash/sdk/bcfg";

/**
 * The E2E package's settings: `PCASH_E2E_<NAME>` reads as `<name>`. A run never
 * picks up the shared names a checkout's `.envrc` sets for its own node, wallet,
 * or relayer.
 */
export function e2eSettings(env: NodeJS.ProcessEnv = process.env): Config {
  const settings = new Config("pcash-e2e");
  settings.load({ env });
  return settings;
}

/**
 * The circuit bundle `scripts/circuits/bundle.mjs exec` injects for every
 * consumer. It is an input the wrapper provides, not an E2E setting.
 */
export function circuitBundle(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const config = new Config("pcash");
  config.load({ env });
  return config.str("circuit-bundle") ?? undefined;
}
