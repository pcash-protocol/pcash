// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletBulkJob } from "@pcash/sdk/wallet";
import { WebsiteSettingsContext, WebsiteSettingsStore } from "../../lib/WebsiteSettings.tsx";

const ASSET_ID = 0xabcn;
const A = `0x${"11".repeat(20)}`;
const B = `0x${"22".repeat(20)}`;
const C = `0x${"33".repeat(20)}`;
const state = vi.hoisted(() => ({ wallet: {} as Record<string, any>, resolveName: vi.fn() }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
vi.mock("../../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: undefined, inputs: undefined }) }));
vi.mock("../../names/useEthereumName.ts", () => ({ useEthereumNameResolver: () => ({ resolveName: state.resolveName }) }));
const receipts = vi.hoisted(() => ({ accepted: new Set<string>() }));
vi.mock("@pcash/sdk/clients", async (original) => ({
  ...await original<object>(),
  pollReceipt: async (_node: unknown, contentHash: string) => receipts.accepted.has(contentHash) ? { outcome: "succeeded" } : null,
}));
import { distributionProgress, recipientsPerProof, TokenDistribute, unpaidRecipients } from "./TokenDistribute.tsx";

const UNIT = { decimals: 2, symbol: "HBR" };

function job(overrides: Partial<WalletBulkJob> = {}): WalletBulkJob {
  return {
    jobId: "job-1", kind: "payment", assetId: ASSET_ID, maxTransactions: 3, targetNotes: 4, shape: 0,
    openFeeAmounts: { 0: 0n, 1: 0n }, recovery: null,
    recipients: [{ to: A, amount: 100n }, { to: B, amount: 200n }, { to: C, amount: 300n }],
    chunks: [], ...overrides,
  };
}
const chunk = (firstRecipient: number, recipientCount: number, outcome: WalletBulkJob["chunks"][number]["outcome"], contentHash: string) =>
  ({ shape: 0 as const, firstRecipient, recipientCount, contentHash, outcome, inclusion: null });

describe("distribution progress", () => {
  it("counts paid, submitted and unpaid recipients by chunk outcome", () => {
    const current = job({ chunks: [chunk(0, 1, "succeeded", "0x1"), chunk(1, 1, "expired", "0x2")] });
    expect(distributionProgress(current)).toEqual({ assigned: 2, paid: 1, submitted: 0, failed: 1, state: "needs-review" });
    expect(unpaidRecipients(current)).toEqual([{ to: B, amount: 200n }, { to: C, amount: 300n }]);
    expect(distributionProgress(job({ chunks: [chunk(0, 3, "succeeded", "0x1")] })).state).toBe("complete");
  });

  it("counts a chunk the chain accepted as paid before it is final", () => {
    const current = job({ chunks: [chunk(0, 3, "unresolved", "0xAB")] });
    expect(distributionProgress(current).state).toBe("in-progress");
    expect(distributionProgress(current, new Set(["0xab"]))).toEqual({ assigned: 3, paid: 3, submitted: 0, failed: 0, state: "complete" });
  });

  it("explains how many recipients one browser proof pays", () => {
    expect(recipientsPerProof({ mode: "slow", openFeeAmount: 0n })).toBe(4);
    expect(recipientsPerProof({ mode: "slow", openFeeAmount: 1n })).toBe(3);
    expect(recipientsPerProof({ mode: "fast", openFeeAmount: 0n })).toBe(4);
  });
});

let element: HTMLDivElement;
let root: Root;
let jobs: WalletBulkJob[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  jobs = [];
  receipts.accepted.clear();
  state.resolveName.mockReset();
  state.wallet = {
    phase: "ready", busy: false, status: { pcashChainId: 1n }, funds: { spendablePrivate: 0n }, snapshot: { pendingContentHashes: [] },
    node: {}, runAction: (action: () => Promise<unknown>) => action(),
    wallet: {
      bulkJobs: vi.fn(async () => structuredClone(jobs)),
      bulkRecoveries: vi.fn(async () => []),
      startBulkJob: vi.fn(async (intent: { recipients: WalletBulkJob["recipients"] }) => {
        const started = job({ recipients: intent.recipients });
        jobs = [started];
        return started;
      }),
      runBulkJobStep: vi.fn(),
      hasReceiveKey: vi.fn(async () => true),
    },
  };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

const render = () => act(async () => root.render(<WebsiteSettingsContext.Provider value={new WebsiteSettingsStore(() => localStorage)}>
  <MemoryRouter><TokenDistribute assetId={ASSET_ID} unit={UNIT} spendable={1_000n} /></MemoryRouter></WebsiteSettingsContext.Provider>));
const text = () => element.textContent ?? "";
const button = (label: string) => [...element.querySelectorAll("button")].find((node) => node.textContent === label)!;
async function list(value: string) {
  const textarea = element.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openFee(value: string) {
  const field = [...element.querySelectorAll("label")].find((node) => node.textContent?.startsWith("Relayer fee"))!.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("distributing a token", () => {
  it("reports every bad line and an overdrawn total before anything is approved", async () => {
    state.resolveName.mockResolvedValue(null);
    await render();
    await openFee("0");
    await list([`${A}, 1`, "nobody.eth, 2", `${B}, 1.001`, `0x1234, 1`, `${C}, 8.99`].join("\n"));
    await act(async () => button("Check list").click());
    const problems = [...element.querySelectorAll('[aria-label="Problems with the list"] li')].map((item) => item.textContent);
    expect(problems[0]).toBe("Line 2: nobody.eth does not resolve to an Ethereum address.");
    expect(problems[1]).toBe("Line 3: Amount can have at most 2 decimal places");
    expect(problems[2]).toBe("Line 4: An Ethereum address is 0x followed by 40 hex characters.");
    expect(problems).toHaveLength(3);
    expect(state.wallet.wallet.startBulkJob).not.toHaveBeenCalled();
    await list([`${A}, 6`, `${B}, 5`].join("\n"));
    await act(async () => button("Check list").click());
    expect(text()).toContain("The list totals 11 HBR, more than the 10 HBR you have available.");
  });

  it("approves S chunks at a zero open fee, then proves them one after another until paid", async () => {
    state.resolveName.mockResolvedValue({ address: C });
    state.wallet.wallet.runBulkJobStep.mockImplementation(async (intent: { chunkIndex?: number; onPrepared(): void }) => {
      if (intent.chunkIndex === 0) {
        intent.onPrepared();
        jobs[0]!.chunks.push(chunk(0, 3, "unresolved", "0xchunk"));
        return { state: "submitted", jobId: "job-1", chunkIndex: 0, result: { contentHash: "0xchunk" } };
      }
      jobs[0]!.chunks[0]!.outcome = "succeeded";
      return { state: "complete", jobId: "job-1" };
    });
    await render();
    await openFee("0");
    await list([`${A}, 1`, `${B}, 2`, "carol.eth, 3"].join("\n"));
    await act(async () => button("Check list").click());
    const rows = Object.fromEntries([...element.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    expect(rows).toMatchObject({ Recipients: "3", Total: "6 HBR", Proofs: "About 1, up to 4 recipients each" });
    await act(async () => button("Start distribution").click());
    expect(state.wallet.wallet.startBulkJob).toHaveBeenCalledWith({
      kind: "payment", assetId: ASSET_ID, openFeeAmount: 0n, maxTransactions: 3, shape: 0,
      recipients: [{ to: A, amount: 100n }, { to: B, amount: 200n }, { to: C, amount: 300n }],
      recovery: { appTag: Uint8Array.of(0) },
    });
    expect((state.wallet.wallet.runBulkJobStep.mock.calls as [{ chunkIndex?: number }][]).map(([intent]) => intent.chunkIndex)).toEqual([0, 1]);
    expect(text()).toContain("Every recipient is paid.");
    expect(text()).toContain("3 paid");
    expect(text()).toContain("Complete");
  });

  it("requires the original list and explicitly resumes one recovered distribution", async () => {
    state.wallet.wallet.hasReceiveKey.mockImplementation(async (address: string) => address !== A);
    state.wallet.wallet.bulkRecoveries.mockResolvedValue([{
      recoveryJobId: `0x${"44".repeat(32)}`, appTag: Uint8Array.of(0), manifestDigest: `0x${"55".repeat(32)}`,
      assetId: ASSET_ID, recipientCount: 3, paidOriginalIndexes: [0], chunks: [], known: false,
      observedAtTimestamp: 10n, observedThroughTimestamp: 1_811n, resumeAfterTimestamp: 1_810n,
    }]);
    state.wallet.wallet.startBulkJob.mockImplementation(async (intent: { recipients: WalletBulkJob["recipients"] }) => {
      const started = job({ recipients: intent.recipients.slice(1), recovery: {
        recoveryJobId: `0x${"44".repeat(32)}`, appTag: Uint8Array.of(0), manifestDigest: `0x${"55".repeat(32)}`,
        originalRecipientCount: 3, originalIndexes: [1, 2], invalidated: false, supersededByJobId: null,
      } });
      jobs = [started];
      return started;
    });
    state.wallet.wallet.runBulkJobStep.mockResolvedValue({ state: "complete", jobId: "job-1" });
    await render();
    expect(text()).toContain("Recovered distribution to 3 recipients");
    await act(async () => button("Resume with original list").click());
    expect(text()).toContain("Paste the complete original recipient list");
    await list([`${A}, 6`, `${B}, 2`, `${C}, 3`].join("\n"));
    await act(async () => button("Check list").click());
    expect(text()).toContain("Remaining total5 HBR");
    await act(async () => button("Cancel recovery").click());
    expect(button("Start distribution")).toBeUndefined();
    await act(async () => button("Resume with original list").click());
    await act(async () => button("Check list").click());
    await act(async () => button("Resume distribution").click());
    expect(state.wallet.wallet.startBulkJob).toHaveBeenCalledWith(expect.objectContaining({
      recipients: [{ to: A, amount: 600n }, { to: B, amount: 200n }, { to: C, amount: 300n }],
      recovery: { appTag: Uint8Array.of(0), resumeRecoveryJobId: `0x${"44".repeat(32)}` },
    }));
  });

  it("names each line whose address has not set up PCASH, and offers no start", async () => {
    state.resolveName.mockResolvedValue({ address: C });
    state.wallet.wallet.hasReceiveKey.mockImplementation(async (address: string) => address === A);
    await render();
    await list([`${A}, 1`, `${B}, 2`, "carol.eth, 3"].join("\n"));
    await act(async () => button("Check list").click());
    const problems = [...element.querySelectorAll('[aria-label="Problems with the list"] li')].map((item) => item.textContent);
    expect(problems).toEqual([
      "Line 2: This address hasn't set up PCASH, so it can't receive a private payment yet.",
      "Line 3: This address hasn't set up PCASH, so it can't receive a private payment yet.",
    ]);
    expect(state.wallet.wallet.hasReceiveKey).toHaveBeenCalledWith(C);
    expect(button("Start distribution")).toBeUndefined();
  });

  it("keeps the list in place and locked while it is paid, then clears it", async () => {
    let release!: () => void;
    state.wallet.wallet.runBulkJobStep.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      jobs[0]!.chunks.push(chunk(0, 1, "succeeded", "0xchunk"));
      return { state: "complete", jobId: "job-1" };
    });
    await render();
    await list(`${A}, 1`);
    await act(async () => button("Check list").click());
    await act(async () => button("Start distribution").click());
    const textarea = element.querySelector("textarea")!;
    expect(textarea.value).toBe(`${A}, 1`);
    expect(textarea.disabled).toBe(true);
    expect(button("Start distribution")).toBeUndefined();
    await act(async () => release());
    expect(text()).toContain("Every recipient is paid.");
    expect(textarea.value).toBe("");
    expect(textarea.disabled).toBe(false);
  });

  it("keeps the checked list editable with its values when the distribution cannot start", async () => {
    state.wallet.wallet.startBulkJob.mockRejectedValueOnce(new Error("User rejected the request."));
    await render();
    await list(`${A}, 1`);
    await act(async () => button("Check list").click());
    await act(async () => button("Start distribution").click());
    expect(text()).toContain("User rejected the request.");
    const textarea = element.querySelector("textarea")!;
    expect(textarea.value).toBe(`${A}, 1`);
    expect(textarea.disabled).toBe(false);
    expect(button("Start distribution").disabled).toBe(false);
  });

  it("keeps a started list editable after a failed payment, without starting it a second time", async () => {
    state.wallet.wallet.runBulkJobStep.mockRejectedValue(new Error("Proof generation failed."));
    await render();
    await list(`${A}, 1`);
    await act(async () => button("Check list").click());
    await act(async () => button("Start distribution").click());
    expect(text()).toContain("Proof generation failed.");
    const textarea = element.querySelector("textarea")!;
    expect(textarea.value).toBe(`${A}, 1`);
    expect(textarea.disabled).toBe(false);
    await act(async () => button("Check list").click());
    expect(text()).toContain("The distribution below already pays this list. Continue it there, or change the list to start another.");
    expect(button("Start distribution")).toBeUndefined();
    await list(`${A}, 2`);
    await act(async () => button("Check list").click());
    expect(button("Start distribution")).toBeDefined();
    expect(state.wallet.wallet.startBulkJob).toHaveBeenCalledTimes(1);
  });

  it("finishes once every payment is accepted, without waiting for finality", async () => {
    state.resolveName.mockResolvedValue({ address: C });
    state.wallet.wallet.runBulkJobStep.mockImplementation(async (intent: { chunkIndex?: number; onPrepared(): void }) => {
      if (intent.chunkIndex === 0) {
        intent.onPrepared();
        jobs[0]!.chunks.push(chunk(0, 3, "unresolved", "0xchunk"));
        receipts.accepted.add("0xchunk");
        return { state: "submitted", jobId: "job-1", chunkIndex: 0, result: { contentHash: "0xchunk", accepted: true } };
      }
      return { state: "waiting-for-confirmation", jobId: "job-1" };
    });
    await render();
    await openFee("0");
    await list([`${A}, 1`, `${B}, 2`, "carol.eth, 3"].join("\n"));
    await act(async () => button("Check list").click());
    await act(async () => button("Start distribution").click());
    expect(text()).toContain("Every recipient is paid.");
    expect(text()).toContain("3 paid · 0 submitted");
    expect(text()).toContain("Complete");
    expect(jobs[0]!.chunks[0]!.outcome).toBe("unresolved");
  });

  it("stops on an unconfirmed chunk and resubmits its exact bytes on Continue", async () => {
    jobs = [job({ recipients: [{ to: A, amount: 100n }] })];
    state.wallet.wallet.runBulkJobStep.mockImplementationOnce(async (intent: { onPrepared(): void }) => {
      intent.onPrepared();
      jobs[0]!.chunks.push(chunk(0, 1, "unresolved", "0xchunk"));
      throw new Error("mempool connection reset");
    }).mockImplementationOnce(async () => {
      receipts.accepted.add("0xchunk");
      return { state: "submitted", jobId: "job-1", chunkIndex: 0, result: { contentHash: "0xchunk", accepted: true } };
    }).mockImplementation(async () => ({ state: "waiting-for-confirmation", jobId: "job-1" }));
    await render();
    await act(async () => button("Continue").click());
    expect(text()).toContain("We couldn’t confirm whether the last payment reached the network. Continue submits it again.");
    await act(async () => button("Continue").click());
    const indexes = (state.wallet.wallet.runBulkJobStep.mock.calls as [{ chunkIndex?: number }][]).map(([intent]) => intent.chunkIndex);
    expect(indexes.slice(0, 2)).toEqual([0, 0]);
    expect(text()).toContain("Every recipient is paid.");
  });

  it("runs one step when Continue is clicked again before the run starts", async () => {
    jobs = [job({ recipients: [{ to: A, amount: 100n }] })];
    await render();
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => { release = resolve; });
    state.wallet.wallet.bulkJobs.mockImplementation(async () => { await loaded; return structuredClone(jobs); });
    state.wallet.wallet.runBulkJobStep.mockImplementation(async () => ({ state: "limit-reached", jobId: "job-1" }));
    const resume = button("Continue");
    await act(async () => { resume.click(); resume.click(); });
    expect(text()).toContain("Checking this distribution…");
    await act(async () => release());
    expect(state.wallet.wallet.runBulkJobStep).toHaveBeenCalledTimes(1);
  });

  it("resubmits a saved payment that never reached the network after a reload", async () => {
    jobs = [job({ recipients: [{ to: A, amount: 100n }], chunks: [chunk(0, 1, "unresolved", "0xsaved")] })];
    state.wallet.wallet.runBulkJobStep.mockImplementationOnce(async () => {
      receipts.accepted.add("0xsaved");
      return { state: "submitted", jobId: "job-1", chunkIndex: 0, result: { contentHash: "0xsaved", accepted: true } };
    }).mockImplementation(async () => ({ state: "waiting-for-confirmation", jobId: "job-1" }));
    await render();
    await act(async () => button("Continue").click());
    expect((state.wallet.wallet.runBulkJobStep.mock.calls as [{ chunkIndex?: number }][])[0]![0].chunkIndex).toBe(0);
    expect(text()).toContain("Every recipient is paid.");
  });

  it("resubmits the saved payment behind one the chain accepted but has not finalized", async () => {
    jobs = [job({ chunks: [chunk(0, 2, "unresolved", "0xfirst"), chunk(2, 1, "unresolved", "0xsecond")] })];
    receipts.accepted.add("0xfirst");
    state.wallet.wallet.runBulkJobStep.mockImplementationOnce(async () => {
      receipts.accepted.add("0xsecond");
      return { state: "submitted", jobId: "job-1", chunkIndex: 1, result: { contentHash: "0xsecond", accepted: true } };
    }).mockImplementation(async () => ({ state: "waiting-for-confirmation", jobId: "job-1" }));
    await render();
    await act(async () => button("Continue").click());
    expect((state.wallet.wallet.runBulkJobStep.mock.calls as [{ chunkIndex?: number }][])[0]![0].chunkIndex).toBe(1);
    expect(text()).toContain("Every recipient is paid.");
  });

  it("pre-fills the default fee only if the wallet can pay it for every proof, and checks the fee for the whole list", async () => {
    const PCASH = 10n ** 18n;
    const recipients = (count: number) => Array.from({ length: count }, (_, index) => `0x${(index + 1).toString(16).padStart(2, "0").repeat(20)}, 1`).join("\n");
    const feeField = () => [...element.querySelectorAll("label")].find((node) => node.textContent?.startsWith("Relayer fee"))!.querySelector("input")!;
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    await render();
    expect(feeField().value).toBe("1");
    // Two fee-paying proofs of three recipients each: 2 PCASH covers the default.
    await list(recipients(6));
    expect(feeField().value).toBe("1");
    // A seventh recipient needs a third proof, which the wallet cannot pay.
    await list(recipients(7));
    expect(feeField().value).toBe("0");
    await openFee("1");
    const missing = "This relayer fee is paid in PCASH: 1 PCASH for each of 3 proofs, 3 PCASH in all. Your wallet has 2 PCASH available.";
    expect(text()).toContain(missing);
    await act(async () => button("Check list").click());
    expect([...element.querySelectorAll('[aria-label="Problems with the list"] li')].map((item) => item.textContent)[0]).toContain(missing);
    expect(button("Start distribution")).toBeUndefined();
  });

  it("offers the unpaid recipients of an expired chunk as a new list", async () => {
    jobs = [job({ chunks: [chunk(0, 1, "succeeded", "0x1"), chunk(1, 2, "expired", "0x2")], recovery: {
      recoveryJobId: `0x${"66".repeat(32)}`, appTag: Uint8Array.of(0), manifestDigest: `0x${"77".repeat(32)}`,
      originalRecipientCount: 3, originalIndexes: [0, 1, 2], invalidated: false, supersededByJobId: null,
    } })];
    state.wallet.wallet.runBulkJobStep.mockResolvedValue({ state: "complete", jobId: "job-1" });
    await render();
    expect(text()).toContain("Needs review");
    await act(async () => button("Distribute to unpaid recipients").click());
    expect(element.querySelector("textarea")!.value).toBe(`${B}, 2\n${C}, 3`);
    expect(text()).toContain("They stay part of that distribution, so no one is paid twice.");
    await act(async () => button("Check list").click());
    await act(async () => button("Cancel retry").click());
    expect(button("Start distribution")).toBeUndefined();
    await act(async () => button("Distribute to unpaid recipients").click());
    await act(async () => button("Check list").click());
    await act(async () => button("Retry unpaid recipients").click());
    expect(state.wallet.wallet.startBulkJob).toHaveBeenCalledWith(expect.objectContaining({
      recipients: [{ to: B, amount: 200n }, { to: C, amount: 300n }],
      recovery: { appTag: Uint8Array.of(0), continueLocalJobId: "job-1" },
    }));
  });
});
