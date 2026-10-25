import assert from "node:assert/strict";
import test from "node:test";
import { bytes32Hex, addressHex } from "@pcash/sdk/utils";
import { awaitIncluded, resumeTemplateAction, submitSponsoredTemplate, type TemplateRun } from "../src/client/action.ts";
import { TokensError } from "../src/client/errors.ts";
import { withWallet, type TokensRuntime } from "../src/client/runtime.ts";

test("claim retry rejects a different recipient before resubmitting saved bytes", async () => {
  const nullifier = 0x123n;
  const original = 0x456n;
  let statusReads = 0;
  const run = {
    ctx: {
      store: { load: async () => ({ pendingAssetActions: [{
        claimLinkRecipient: addressHex(original),
        inputs: [{ nullifier: bytes32Hex(nullifier) }],
      }] }) },
      node: { status: async () => { statusReads++; throw new Error("reached submission"); } },
    },
    submission: {},
  } as unknown as TemplateRun;

  await assert.rejects(resumeTemplateAction(run, [nullifier], 0x789n), (error: unknown) =>
    error instanceof TokensError && error.code === "claim-recipient-mismatch");
  assert.equal(statusReads, 0);

  await assert.rejects(resumeTemplateAction(run, [nullifier], original), /reached submission/);
  assert.equal(statusReads, 1);
});

test("claim retry refuses a pending action without a saved claim recipient", async () => {
  const run = {
    ctx: { store: { load: async () => ({ pendingAssetActions: [{ inputs: [{ nullifier: bytes32Hex(1n) }] }] }) } },
  } as unknown as TemplateRun;
  await assert.rejects(resumeTemplateAction(run, [1n], 2n), (error: unknown) =>
    error instanceof TokensError && error.code === "claim-recipient-mismatch");
});

test("template inclusion uses application polling instead of the browser wallet's one-attempt settlement", async () => {
  let reads = 0;
  const run = {
    ctx: {
      node: { getReceipt: async () => { reads++; return []; } },
      settlePollIntervalMs: 0,
      settlePollMaxAttempts: 1,
    },
    pollIntervalMs: 0,
    pollMaxAttempts: 3,
  } as unknown as TemplateRun;
  await assert.rejects(awaitIncluded(run, { contentHash: bytes32Hex(4n), accepted: false, queued: true, role: "transfer" }),
    /timed out waiting for the pcash receipt/);
  assert.equal(reads, 3);
});

test("a token action's onPrepared reaches its template run and its sponsored submission", async () => {
  const onPrepared = () => undefined;
  let run: TemplateRun | undefined;
  let intent: { onPrepared?: unknown } | undefined;
  const rt = {
    submission: { mode: "mempool" },
    pollIntervalMs: 0,
    pollMaxAttempts: 1,
    wallet: {
      execute: async (action: (context: unknown) => unknown) => action({}),
      sponsorContractAction: async (value: { onPrepared?: unknown }) => { intent = value; return { contentHash: bytes32Hex(1n), accepted: true }; },
    },
  } as unknown as TokensRuntime;
  await withWallet(rt, "probe", { onPrepared }, async (value) => { run = value; });
  assert.equal(run?.onPrepared, onPrepared);
  await submitSponsoredTemplate(rt, {} as never, { onPrepared });
  assert.equal(intent?.onPrepared, onPrepared);
});
