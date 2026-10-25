// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurablePreBroadcastError } from "@pcash/sdk/wallet";

const ADDRESS = `0x${"12".repeat(20)}`;
const TX = `0x${"ab".repeat(32)}`;
const HASH = `0x${"cd".repeat(32)}`;
const state = vi.hoisted(() => ({ wallet: {} as Record<string, unknown> }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
import { readTokenActivity, tokenActivityKey } from "../../lib/tokenActivity.ts";
import { useTokenTransaction, type TokenPublication } from "./useTokenTransaction.ts";

// The store keeps an in-memory copy beside localStorage, so each test reads its own network's key.
let chainId = 0n;
let KEY = "";
const ACTIVITY = { kind: "token-sent" as const, amount: 5n, unit: { decimals: 0, symbol: "T" }, to: ADDRESS };
let run!: ReturnType<typeof useTokenTransaction>["run"];
function Harness() { run = useTokenTransaction().run; return null; }
let element: HTMLDivElement;
let root: Root;
const entries = () => readTokenActivity(KEY);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const status = { pcashChainId: ++chainId, l1ChainId: 1n, genesisHash: "0xgenesis" };
  KEY = tokenActivityKey(status, ADDRESS);
  state.wallet = {
    status, snapshot: { address: ADDRESS, pendingContentHashes: [] }, node: {},
    selfPublication: { mode: "l1", preflight: vi.fn(), submit: vi.fn() },
    runAction: (action: () => Promise<unknown>) => action(),
    assertFasterGas: async () => undefined,
  };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

type SubmitContext = { onL1Submitted?: (hash: string) => Promise<void> };
function submitWith(submit: (context: SubmitContext) => Promise<unknown>) {
  (state.wallet.selfPublication as { submit: ReturnType<typeof vi.fn> }).submit.mockImplementation(submit);
}

/** Runs one Fast action that ends as `end` says. */
async function fastRun(end: (publication: TokenPublication) => Promise<{ contentHash: string; accepted: boolean }>) {
  let outcome: Awaited<ReturnType<typeof run>> | undefined;
  await act(async () => { outcome = await run({ mode: "fast", openFeeAmount: 0n }, end, ACTIVITY); });
  return outcome!;
}

describe("token activity records", () => {
  it("records the action once its bytes are journaled, and marks it submitted when Ethereum returns a hash", async () => {
    submitWith(async (context) => { await context.onL1Submitted?.(HASH); return { l1Hash: HASH }; });
    let seenAtPrepared: ReturnType<typeof entries> = [];
    let seenAtHash: ReturnType<typeof entries> = [];
    const outcome = await fastRun(async (publication) => {
      await publication.onPrepared!(TX, "0x00");
      seenAtPrepared = entries();
      await publication.submission!.submit({ transactionBytes: new Uint8Array(), status: {} as never, retry: false, prepared: undefined,
        onL1Submitted: async () => { seenAtHash = entries(); } });
      return { contentHash: TX, accepted: false };
    });
    expect(outcome.state).toBe("sent");
    expect(seenAtPrepared).toEqual([expect.objectContaining({ kind: "token-sent", contentHash: TX, amount: 5n, awaitingSubmission: true })]);
    expect(seenAtHash).toEqual([expect.objectContaining({ contentHash: TX })]);
    expect(seenAtHash[0]!.awaitingSubmission).toBeUndefined();
    expect(entries()).toEqual(seenAtHash);
  });

  it("keeps an action whose tab closes while Ethereum includes it", async () => {
    submitWith(async (context) => { await context.onL1Submitted?.(HASH); return new Promise(() => undefined); });
    await act(async () => {
      void run({ mode: "fast", openFeeAmount: 0n }, async (publication) => {
        await publication.onPrepared!(TX, "0x00");
        return publication.submission!.submit({ transactionBytes: new Uint8Array(), status: {} as never, retry: false, prepared: undefined }) as never;
      }, ACTIVITY);
    });
    expect(entries()).toEqual([expect.objectContaining({ contentHash: TX })]);
    expect(entries()[0]!.awaitingSubmission).toBeUndefined();
  });

  it("removes the record when the action is refused before anything left this browser", async () => {
    const outcome = await fastRun(async (publication) => {
      await publication.onPrepared!(TX, "0x00");
      throw new DurablePreBroadcastError(new Error("User rejected the request."));
    });
    expect(outcome.state).toBe("failed");
    expect(entries()).toEqual([]);
  });

  it("keeps an ambiguous submission, still awaiting its answer", async () => {
    const outcome = await fastRun(async (publication) => {
      await publication.onPrepared!(TX, "0x00");
      throw new Error("connection lost");
    });
    expect(outcome).toEqual({ state: "unknown", contentHash: TX });
    expect(entries()).toEqual([expect.objectContaining({ contentHash: TX, awaitingSubmission: true })]);
  });

  it("marks a Slow action submitted once the mempool accepts it, and leaves a retried entry in place when it is refused", async () => {
    await act(async () => { await run({ mode: "slow", openFeeAmount: 1n }, async (publication) => {
      await publication.onPrepared!(TX, "0x00");
      return { contentHash: TX, accepted: false };
    }, ACTIVITY); });
    expect(entries()).toEqual([expect.objectContaining({ contentHash: TX })]);
    expect(entries()[0]!.awaitingSubmission).toBeUndefined();
    const recordedAt = entries()[0]!.at;
    await act(async () => { await run({ mode: "slow", openFeeAmount: 1n }, async (publication) => {
      await publication.onPrepared!(TX, "0x00");
      throw new DurablePreBroadcastError(new Error("node refused"));
    }, ACTIVITY); });
    expect(entries()).toEqual([expect.objectContaining({ contentHash: TX, at: recordedAt })]);
  });
});
