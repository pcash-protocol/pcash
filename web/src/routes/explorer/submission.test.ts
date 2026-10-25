import { describe, expect, it, vi } from "vitest";
import { createFixtureReader } from "./fixtures/reader.ts";
import { fixtureWorld } from "./fixtures/world.ts";

vi.mock("./fixtures/world.ts", async (original) => {
  const recorded = await original<typeof import("./fixtures/world.ts")>();
  const entry = recorded.fixtureWorld.transactions[0]!;
  return {
    ...recorded,
    fixtureWorld: {
      ...recorded.fixtureWorld,
      transactions: Array.from({ length: 31 }, (_, index) => ({
        ...entry,
        summary: {
          ...entry.summary,
          transactionId: `0x${index.toString(16).padStart(64, "0")}`,
          pcashTransactionIndex: BigInt(index),
          outcome: index === 0 ? "succeeded" : "nullifierAlreadySpent",
        },
      })),
    },
  };
});

describe("submission pagination", () => {
  it("reaches an original success after more than one page of failed replays", async () => {
    const reader = createFixtureReader();
    const hash = fixtureWorld.transactions[0]!.summary.contentHash;
    const first = await reader.submission(hash);
    expect(first.items).toHaveLength(25);
    expect(first.items.every((item) => item.outcome === "nullifierAlreadySpent")).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await reader.submission(hash, first.nextCursor!);
    expect(second.items).toHaveLength(6);
    expect(second.items.at(-1)?.outcome).toBe("succeeded");
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.transactionId)).size).toBe(31);
  });
});
