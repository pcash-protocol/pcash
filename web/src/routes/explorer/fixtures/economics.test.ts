import { describe, expect, it } from "vitest";
import { fixtureBlockEconomics } from "./economics.ts";
import { fixtureWorld } from "./world.ts";

describe("fixture block economics", () => {
  it("buckets the recorded blocks with the node's alignment and reports the head", () => {
    const head = fixtureWorld.status.latestBlock;
    const single = fixtureBlockEconomics(fixtureWorld, { fromBlock: head - 3n, limit: 10 });
    expect(single.atBlockNumber).toBe(head);
    expect(single.records.map((record) => record.firstBlock)).toEqual([head - 3n, head - 2n, head - 1n, head]);
    expect(single.nextBlock).toBeNull();

    const bucketed = fixtureBlockEconomics(fixtureWorld, { fromBlock: 5n, bucket: 32, limit: 1 });
    expect(bucketed.records).toHaveLength(1);
    expect(bucketed.records[0]?.firstBlock).toBe(0n);
    expect(bucketed.records[0]?.lastBlock).toBe(31n);
    expect(bucketed.records[0]?.blocks).toBe(32n);
    expect(bucketed.nextBlock).toBe(32n);

    const qualifying = fixtureWorld.transactions.filter(({ summary }) => summary.kind === "privateValue" && summary.outcome === "succeeded");
    const whole = fixtureBlockEconomics(fixtureWorld, { bucket: 65_536 });
    expect(whole.records).toHaveLength(1);
    expect(whole.records[0]?.qualifyingActions).toBe(BigInt(qualifying.length));
    expect(whole.records[0]?.issuanceTotal).toBe([...fixtureWorld.blockPayouts.values()].reduce((total, record) => total + record.issuanceTotal, 0n));
    expect(whole.records[0]?.lastBlock).toBe(head);
  });

  it("continues a capped fixture economics page at its next bucket", () => {
    const capped = fixtureBlockEconomics(fixtureWorld, { bucket: 32 }, 40);
    expect(capped.records.map((record) => record.lastBlock)).toEqual([31n]);
    expect(capped.nextBlock).toBe(32n);
    const next = fixtureBlockEconomics(fixtureWorld, { fromBlock: capped.nextBlock!, bucket: 32 }, 40);
    expect(next.records[0]?.firstBlock).toBe(32n);
  });
});
