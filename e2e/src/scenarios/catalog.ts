import type { NetworkMode } from "../fixture/scenarioFixture.ts";

export interface ScenarioCatalogEntry {
  name: string;
  description: string;
  /** Needs nodes the harness launched: chain controls, restarts, a second peer, or admin access. */
  local?: true;
  /** Nodes a local run launches; a live run attaches to one. */
  nodeCount?: 1 | 2;
  /** Omitted from a run that names no scenarios. */
  default?: false;
  sourceVerification?: true;
}

export const SCENARIO_CATALOG: readonly ScenarioCatalogEntry[] = [
  { name: "board", description: "anonymous public posts, proof-bound content, independent rebuild, restart and reorg without catalog", local: true, nodeCount: 2 },
  { name: "lineage", description: "private event lineage across separate actor stores and an authenticated Ethereum policy root", local: true, nodeCount: 1 },
  {
    name: "core",
    description: "empty-native onboarding, seed restoration, zero and paid payments in one block, default-fee relay, unregistered receipt, account update",
  },
  { name: "assets", description: "private creation, native-fee transfer, merge, burn, and re-creation refusal" },
  {
    name: "marketplace",
    description: "publication, catalog, a buy that pays and claims in one Ethereum transaction, a failed carried claim finished by a restored wallet through retry, and timed reclaim",
  },
  {
    name: "token-airdrop",
    description: "token creation, L airdrop with delivered definitions, zero-PCASH self-published forward, burn, and seed restore",
    local: true,
    nodeCount: 1,
  },
  {
    name: "token-claims",
    description: "claim links and an eligibility drop through the token application: create, claim, refuse, reload, and reclaim",
    local: true,
    nodeCount: 1,
  },
  {
    name: "token-market",
    description: "token listings: a created token listed for ETH, bought and claimed with no PCASH, and an unsold listing reclaimed with a PCASH fee",
    local: true,
    nodeCount: 1,
  },
  {
    name: "contract-posting",
    description: "a contract wallet posts an ordinary transfer as its own PcashBatch event; a transfer requiring another carrier context fails through it and consumes nothing",
    local: true,
    nodeCount: 1,
  },
  {
    name: "selected-relay",
    description: "a public-mempool action with an authenticated private relay fee output and a separate issuance commitment",
    nodeCount: 1,
  },
  {
    name: "private-value-profiles",
    description: "native L blob distribution, durable consolidation, seed restore and S spending",
    nodeCount: 1,
  },
  {
    name: "registration-mining",
    description: "combined setup, unregistered mining, independent outcomes, replay and recovered reward spending",
    nodeCount: 1,
  },
  {
    name: "seed-wallet",
    description: "production CLI onboarding with a scripted terminal, service registration, real website-profile payment, native-proof spending, restart and phrase-only recovery",
    local: true,
    nodeCount: 1,
  },
  {
    name: "reorg",
    description: "L calldata rollback, exact-proof reinclusion, rolled-back system payouts and S spending",
    local: true,
  },
  {
    name: "issuance-boundary",
    description: "empty-genesis issuance, continued issuance after a year, and spending recovered rewards",
    local: true,
    nodeCount: 1,
  },
  {
    name: "p2p",
    description: "P2P identity and peers, gossiped relays over calldata and blobs, and relay-journal recovery",
    local: true,
  },
  {
    name: "persistence",
    description: "checkpoint resume, stream identity, incremental scan, reconnection, and post-restart action",
    local: true,
  },
  {
    name: "source-verification",
    description: "generic source publication, configuration openings, Explorer RPCs, export, and reproduction",
    local: true,
    sourceVerification: true,
  },
  {
    name: "seed",
    description: "complete Explorer fixture with canonical, skipped, Marketplace, source, and pending state",
    nodeCount: 1,
    default: false,
    sourceVerification: true,
  },
  {
    name: "traffic",
    description: "long-running mixed payments, batched carriers, asset lifecycles, and marketplace trades",
    nodeCount: 1,
    default: false,
  },
];

/** The named scenarios, or every default one this mode can run. */
export function selectCatalogScenarios(names: readonly string[], mode: NetworkMode = "local"): ScenarioCatalogEntry[] {
  if (names.length === 0) {
    return SCENARIO_CATALOG.filter((scenario) => scenario.default !== false && (mode === "local" || scenario.local !== true));
  }
  const selected = names.map((name) => {
    const found = SCENARIO_CATALOG.find((scenario) => scenario.name === name);
    if (found === undefined) throw new Error(`unknown E2E scenario ${name}; choose ${SCENARIO_CATALOG.map((item) => item.name).join(", ")}`);
    if (mode === "live" && found.local === true) throw new Error(`scenario ${name} needs a local network and cannot run live`);
    return found;
  });
  return [...new Map(selected.map((scenario) => [scenario.name, scenario])).values()];
}
