import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Config } from "@pcash/sdk/bcfg";
import { Logger } from "@pcash/sdk/blgr";
import {
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
} from "../commitments.mts";
import {
  MARKETPLACE_CLAIM_SOURCE_PROFILE,
  MARKETPLACE_ESCROW_PRESENTATION,
  MARKETPLACE_RECLAIM_SOURCE_PROFILE,
  marketplaceSourceConfigurationOpenings,
} from "../sourceVerification.ts";

/** Application-owned inputs consumed by the generic repository source-verification builder. */
export const sourceVerificationDefinition = {
  presentation: MARKETPLACE_ESCROW_PRESENTATION,
  implementations: [
    {
      id: "marketplace-escrow-claim",
      implementationLabel: MARKETPLACE_CLAIM_SOURCE_PROFILE.implementationLabel,
      packageRoot: "marketplace/l2-contracts/escrow/claim",
      packageName: "claim",
      expectedApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    },
    {
      id: "marketplace-escrow-reclaim",
      implementationLabel: MARKETPLACE_RECLAIM_SOURCE_PROFILE.implementationLabel,
      packageRoot: "marketplace/l2-contracts/escrow/reclaim",
      packageName: "reclaim",
      expectedApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
    },
  ],
  configurationBindings: [
    {
      applicationVkHash: MARKETPLACE_ESCROW_PRESENTATION.functions[0].applicationVkHash,
      configurationProfile: MARKETPLACE_CLAIM_SOURCE_PROFILE,
    },
    {
      applicationVkHash: MARKETPLACE_ESCROW_PRESENTATION.functions[1].applicationVkHash,
      configurationProfile: MARKETPLACE_RECLAIM_SOURCE_PROFILE,
    },
  ],
} as const;

const OPENINGS_FLAGS = [
  "out", "address", "router", "claim-seller", "reclaim-authority",
  "claim-configuration-salt", "reclaim-configuration-salt", "offer-id",
  "asset-id", "amount", "eth-price-wei", "deadline-t",
  "pcash-chain-id", "l1-chain-id", "inbox-address",
];

function required(config: Config, name: string): string {
  const value = config.str(name);
  if (value === null) throw new Error(`--${name} is required`);
  return value;
}

export function writeMarketplaceSourceOpenings(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const input = new Config("pcash");
  input.load({ argv: ["node", "sourceVerification", ...argv], env });
  const known = new Set(OPENINGS_FLAGS.map((name) => name.replace(/-/g, "")));
  for (const key of Object.keys(input.args)) if (!known.has(key)) throw new Error(`unknown option --${key}`);
  if (input.argv.length !== 1 || input.argv[0] !== "openings") {
    throw new Error("usage: sourceVerification openings --out <json-file> --address <uint160> ...");
  }
  const network = {
    pcashChainId: required(input, "pcash-chain-id"),
    l1ChainId: required(input, "l1-chain-id"),
    inboxAddress: required(input, "inbox-address"),
  };
  const openings = marketplaceSourceConfigurationOpenings({
    address: required(input, "address"),
    reclaimAuthority: required(input, "reclaim-authority"),
    claimConfigurationSalt: required(input, "claim-configuration-salt"),
    reclaimConfigurationSalt: required(input, "reclaim-configuration-salt"),
    terms: {
      router: BigInt(required(input, "router")),
      seller: BigInt(required(input, "claim-seller")),
      id: BigInt(required(input, "offer-id")),
      assetId: BigInt(required(input, "asset-id")),
      amount: BigInt(required(input, "amount")),
      ethPriceWei: BigInt(required(input, "eth-price-wei")),
      deadlineT: BigInt(required(input, "deadline-t")),
    },
    network,
  });
  const output = resolve(required(input, "out"));
  writeFileSync(output, `${JSON.stringify(openings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const logger = new Logger("info");
  await logger.open();
  try {
    logger.info(`wrote ${writeMarketplaceSourceOpenings()}`);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
