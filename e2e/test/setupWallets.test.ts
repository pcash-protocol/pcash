import { describe, expect, it, vi } from "vitest";
import type { ScenarioFixture } from "../src/fixture/scenarioFixture.ts";
import { assertSystemPayoutRecovered } from "../src/scenarios/payouts.ts";
import { setupUserWallets } from "../src/scenarios/setup.ts";

vi.mock("../src/scenarios/payouts.ts", () => ({
  assertSystemPayoutRecovered: vi.fn(async () => ({ receipt: { settledIssuanceAmount: 7n }, payouts: [] })),
}));

function fixture(initialBalances: Record<string, bigint> = {}) {
  const balances: Record<string, bigint> = { S: 0n, M: 0n, ...initialBalances };
  const events: string[] = [];
  const actors: Record<string, unknown> = {};
  const createActor = (name: string) => ({
    name,
    address: name,
    wallet: { name },
    balance: async () => balances[name]!,
    client: async () => ({
      updateAccount: async ({ submission }: { submission: { mode: string } }) => {
        events.push(`register:${name}:${submission.mode}`);
        return { contentHash: `account-${name}` };
      },
      send: async (input: { to: string; amount: bigint; openFeeAmount: bigint; submission: { mode: string } }) => {
        events.push(`earn:${name}:${input.to}:${input.amount}:${input.openFeeAmount}:${input.submission.mode}`);
        balances[name] = 100n;
        return { contentHash: `earn-${name}` };
      },
    }),
  });
  const value = {
    actors,
    createActors: async (names: string[]) => { for (const name of names) actors[name] ??= createActor(name); },
    harness: { l1Batched: () => ({ mode: "l1" }) },
    waitForAcceptedAcrossNodes: async () => undefined,
    artifacts: { record: () => undefined },
    network: { pcashChainId: 9n },
    nodeA: { client: {
      getAccountProof: async () => ({ status: "notFound" }),
      status: async () => ({ latestBlockTimestamp: 100n }),
      getIssuanceQuote: async () => ({ rewardPossible: true, maxSingleActionReward: 100n, exhausted: false }),
    } },
  } as unknown as ScenarioFixture;
  return { value, events };
}

describe("scenario wallet funding", () => {
  it("registers on L1 and earns ordinary native notes without genesis funding", async () => {
    const test = fixture();
    expect(await setupUserWallets(test.value, { actors: ["S", "M"], accounts: [], funded: ["M", "S"] })).toEqual({ M: 100n, S: 100n });
    expect(test.events).toEqual(["register:M:l1", "register:S:l1", "earn:M:M:0:0:l1", "earn:S:S:0:0:l1"]);
    expect(vi.mocked(assertSystemPayoutRecovered).mock.calls.map(([call]) => [call.contentHash, call.sourceKind, call.recipient, call.chainId]))
      .toEqual([["earn-M", "designatedIssuance", { name: "M" }, 9n], ["earn-S", "designatedIssuance", { name: "S" }, 9n]]);
  });

  it("reuses existing native notes without another earning action", async () => {
    const test = fixture({ S: 40n, M: 12n });
    expect(await setupUserWallets(test.value, { actors: ["S", "M"], accounts: [], funded: ["S", "M"] })).toEqual({ S: 40n, M: 12n });
    expect(test.events).toEqual(["register:S:l1", "register:M:l1"]);
    expect(assertSystemPayoutRecovered).not.toHaveBeenCalled();
  });
});
