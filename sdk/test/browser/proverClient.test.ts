import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";

import type { WitnessMap } from "../../src/builders/index.ts";
import {
  type BrowserCircuitProfile,
  createBrowserProver,
  createBrowserProverSession,
  PROTOCOL_CIRCUIT_PROFILES,
  ProverAbortError,
} from "../../src/browser-prover/proverClient.ts";
import {
  fetchPinnedArtifact,
  requireArtifactDigest,
  type BrowserProverAssetSource,
} from "../../src/browser-prover/artifacts.ts";
import { CIRCUIT_URLS, type AssetActionProofRequest, type ChonkProofStep } from "../../src/browser-prover/requests.ts";
import { PRIVATE_VALUE_PROFILES } from "../../src/constants/index.ts";
import { PROVER_ARTIFACT_SHA256 } from "../../src/constants/proverArtifacts.ts";
import { PRIVATE_VALUE_PUBLIC_INPUTS } from "../../src/protocol/codec.ts";
import { CHONK_VK_LEN, VK_LEN } from "../../src/protocol/account.ts";
import { toHex } from "../../src/utils/hex.ts";
import type { WorkerRequest, WorkerResponse } from "../../src/browser-prover/proverWorker.ts";
import { circuitBundleDir } from "../circuitBundle.ts";

const EMPTY: WitnessMap = { rule_statement: ["0", "1", "2", "0"] };
const ASSET_SOURCE: BrowserProverAssetSource = {
  assetSetId: "test-assets",
  baseUrl: "https://assets.example/proving/test-assets/",
};
const browserProver = createBrowserProver(ASSET_SOURCE);
const PUBLIC_INPUTS = Array.from({ length: PRIVATE_VALUE_PUBLIC_INPUTS }, (_, index) => BigInt(100 + index));

class FakeWorker {
  static requests: WorkerRequest[] = [];
  static workers: FakeWorker[] = [];
  static autoRespond = true;
  static instances = 0;
  static terminations = 0;
  static validateArtifacts = false;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  constructor() {
    FakeWorker.instances += 1;
    FakeWorker.workers.push(this);
  }

  postMessage(request: WorkerRequest): void {
    FakeWorker.requests.push(request);
    if (!FakeWorker.autoRespond) return;
    queueMicrotask(() => void this.respond(request));
  }

  private async respond(request: WorkerRequest): Promise<void> {
    try {
      if (FakeWorker.validateArtifacts && request.kind === "chonk") {
        await Promise.all(request.steps.flatMap((step) => [
          fetchPinnedArtifact(step.circuitUrl, request.artifactDigests, request.assetSource),
          fetchPinnedArtifact(step.vkUrl, request.artifactDigests, request.assetSource),
        ]));
      }
      this.onmessage?.({ data: {
        type: "status",
        phase: "proving",
        message: "prove CHONK stack",
        elapsedMs: 5,
        step: "prove",
        scope: "stack",
        durationMs: 1234,
        wasmMemoryBytes: 5678,
      } } as MessageEvent<WorkerResponse>);
      if (request.kind === "setup") {
        this.onmessage?.({ data: { type: "setup-result" } } as MessageEvent<WorkerResponse>);
      } else if (request.kind === "chonk") {
        this.onmessage?.({ data: {
          type: "chonk-result",
          proof: Uint8Array.of(7),
        } } as MessageEvent<WorkerResponse>);
      }
    } catch (error) {
      this.onmessage?.({ data: {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      } } as MessageEvent<WorkerResponse>);
    }
  }

  terminate(): void {
    FakeWorker.terminations += 1;
  }
}

// Pinned protocol VKs must fetch as their real bundle bytes so the client's
// digest checks pass against the actual release pins; anything else gets the
// deterministic zero VK the application profiles below pin explicitly.
const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  const path = new URL(url, "https://assets.example").pathname.replace("/proving/test-assets", "");
  const vkMatch = /^\/chonk-vks\/(.+)\.vk$/.exec(path);
  if (vkMatch) {
    const bundleVk = join(circuitBundleDir(), "vks", `${vkMatch[1]}.chonk.vk`);
    if (existsSync(bundleVk)) return new Response(readFileSync(bundleVk));
  }
  return new Response(new Uint8Array((path.includes("_hiding_kernel") ? CHONK_VK_LEN : VK_LEN) * 32));
};

/** A profile for a circuit the release constants do not pin. */
const applicationProfile = (
  url: string,
  vkUrl = `/chonk-vks/${url.replace(/^\/prover\//, "").replace(/\.json$/, "")}.vk`,
): BrowserCircuitProfile => ({
  srsPoints: 2 ** 18,
  circuitSha256: toHex(sha256(new TextEncoder().encode(url))).slice(2),
  vkUrl,
  vkSha256: toHex(sha256(new Uint8Array(VK_LEN * 32))).slice(2),
});

async function withFakes(run: () => Promise<void>): Promise<void> {
  const priorWorker = globalThis.Worker;
  const priorFetch = globalThis.fetch;
  Object.assign(globalThis, { Worker: FakeWorker, fetch: fakeFetch });
  FakeWorker.requests = [];
  FakeWorker.workers = [];
  FakeWorker.autoRespond = true;
  FakeWorker.validateArtifacts = false;
  try {
    await run();
  } finally {
    FakeWorker.validateArtifacts = false;
    Object.assign(globalThis, { Worker: priorWorker, fetch: priorFetch });
  }
}

const transferRequest = (): AssetActionProofRequest => ({
  operation: "transfer",
  authorization: {
    circuitUrl: CIRCUIT_URLS.account_rule_asset_payment_ecdsa,
    witnessMap: EMPTY,
    label: "asset payment",
  },
  buildKernelWitnessMap: () => EMPTY,
  expectedPublicInputs: PUBLIC_INPUTS,
});

test("asset transfers submit one private CHONK stack", async () => {
  await withFakes(async () => {
    const seen: Array<{ step?: string; scope?: string; durationMs?: number; wasmMemoryBytes?: number }> = [];
    const result = await browserProver.proveAssetAction(transferRequest(), (status) => seen.push(status));
    assert.deepEqual(result.proof, Uint8Array.of(7));
    const request = FakeWorker.requests[0]!;
    assert.equal(request.kind, "chonk");
    assert.equal(request.profile.srsPoints, 2 ** 18);
    assert.deepEqual(request.assetSource, ASSET_SOURCE);
    if (request.kind !== "chonk") return;
    assert.deepEqual(request.steps.map((step) => step.circuitUrl), [
      CIRCUIT_URLS.account_rule_asset_payment_ecdsa,
      CIRCUIT_URLS.no_op_event_application,
      CIRCUIT_URLS.private_value_transfer_kernel,
      CIRCUIT_URLS.private_value_hiding_kernel,
    ]);
    assert.deepEqual(request.steps.map((step) => step.kind), ["app", "app", "kernel", "hiding"]);
    // The kernel verifies the no-op event application; the hiding kernel verifies the kernel.
    assert.ok("event_application_vk" in request.steps[2]!.witnessMap);
    assert.ok("kernel_vk" in request.steps[3]!.witnessMap);
    for (const url of [
      CIRCUIT_URLS.account_rule_asset_payment_ecdsa,
      CIRCUIT_URLS.no_op_event_application,
      CIRCUIT_URLS.private_value_transfer_kernel,
      CIRCUIT_URLS.private_value_hiding_kernel,
    ]) {
      assert.equal(request.artifactDigests[url], PROVER_ARTIFACT_SHA256[url]);
    }
    assert.ok(seen.some((status) => status.durationMs === 1234 && status.wasmMemoryBytes === 5678));
    assert.ok(seen.some((status) => status.scope === "stack"));
    assert.ok(seen.some((status) => status.step === "assemble"));
  });
});

for (const method of ["proveTransfer", "proveUserAccountUpdate", "proveSponsoredContractCreation"] as const) {
  test(`${method} selects the larger event's CRS and executes that event`, async () => {
    await withFakes(async () => {
      const eventUrl = "/prover/larger_event.json";
      const eventProfile = { ...applicationProfile(eventUrl), srsPoints: 2 ** 19 };
      const prover = createBrowserProver(ASSET_SOURCE, { [eventUrl]: eventProfile });
      const eventWitness = { claim: "0x123" };
      await prover[method]({
        authorizationWitnessMap: EMPTY,
        buildKernelWitnessMap: () => EMPTY,
        expectedPublicInputs: method === "proveTransfer" ? PUBLIC_INPUTS : [...PUBLIC_INPUTS, 999n],
        eventApplication: { circuitUrl: eventUrl, witnessMap: eventWitness, event: 3n, label: "larger event" },
      });
      const request = FakeWorker.requests[0]!;
      assert.equal(request.kind, "chonk");
      assert.equal(request.profile.srsPoints, 2 ** 19);
      if (request.kind !== "chonk") return;
      assert.equal(request.steps[1]!.circuitUrl, eventUrl);
      assert.deepEqual(request.steps[1]!.witnessMap, eventWitness);
      assert.equal(request.steps[1]!.vkUrl, eventProfile.vkUrl);
      assert.equal(request.steps.some(step => step.circuitUrl === CIRCUIT_URLS.no_op_event_application), false);
    });
  });
}

test("unfunded issuance folds registered authorization", async () => {
  await withFakes(async () => {
    const seen: Array<{ step?: string; circuit?: string }> = [];
    await browserProver.proveAssetAction({
      operation: "assetCreation",
      authorization: { circuitUrl: CIRCUIT_URLS.account_rule_asset_creation_ecdsa, witnessMap: EMPTY, label: "asset creation" },
      buildKernelWitnessMap: () => EMPTY,
      expectedPublicInputs: PUBLIC_INPUTS,
    }, (status) => seen.push(status));
    const request = FakeWorker.requests[0]!;
    assert.equal(request.kind, "chonk");
    assert.equal(request.profile.srsPoints, 2 ** 18);
    if (request.kind !== "chonk") return;
    assert.deepEqual(request.steps.map((step) => step.circuitUrl), [
      CIRCUIT_URLS.account_rule_asset_creation_ecdsa,
      CIRCUIT_URLS.no_op_event_application,
      CIRCUIT_URLS.private_value_asset_creation_kernel,
      CIRCUIT_URLS.private_value_hiding_kernel,
    ]);
    assert.deepEqual(request.steps.map((step) => step.kind), ["app", "app", "kernel", "hiding"]);
    assert.ok(seen.some((status) =>
      status.step === "assemble" && status.circuit === "private_value_asset_creation_kernel"));
  });
});

const L = PRIVATE_VALUE_PROFILES.L.shapeId;
const L_PUBLIC_INPUTS = Array.from({ length: PRIVATE_VALUE_PROFILES.L.publicInputs }, (_, index) => BigInt(100 + index));
const L_HIDING = CIRCUIT_URLS.private_value_large_hiding_kernel;

test("L profiles take their SRS from the circuit manifest", () => {
  assert.equal(PROTOCOL_CIRCUIT_PROFILES[CIRCUIT_URLS.account_rule_large_batch_transfer_ecdsa]!.srsPoints, 2 ** 20);
  assert.equal(PROTOCOL_CIRCUIT_PROFILES[CIRCUIT_URLS.private_value_large_transfer_kernel]!.srsPoints, 2 ** 18);
  assert.equal(PROTOCOL_CIRCUIT_PROFILES[CIRCUIT_URLS.account_rule_asset_creation_ecdsa]!.srsPoints, 2 ** 18);
});

test("an opted-in session folds the L transfer kernel and hiding kernel", async () => {
  await withFakes(async () => {
    const prover = createBrowserProverSession(
      { srsPoints: 2 ** 20, threads: 1, allowNativeOnlyCircuits: true },
      ASSET_SOURCE,
    );
    try {
      await prover.proveTransfer({
        shape: L,
        authorizationWitnessMap: EMPTY,
        buildKernelWitnessMap: () => EMPTY,
        expectedPublicInputs: L_PUBLIC_INPUTS,
      });
      const request = FakeWorker.requests[0]!;
      assert.equal(request.kind, "chonk");
      assert.equal(request.profile.allowNativeOnlyCircuits, true);
      if (request.kind !== "chonk") return;
      assert.deepEqual(request.steps.map((step) => step.circuitUrl), [
        CIRCUIT_URLS.account_rule_large_batch_transfer_ecdsa,
        CIRCUIT_URLS.no_op_event_application,
        CIRCUIT_URLS.private_value_large_transfer_kernel,
        L_HIDING,
      ]);
      const hidingKernel = request.steps[3]!.witnessMap as Record<string, unknown>;
      assert.equal(hidingKernel.nullifier31, "0x85");
      assert.equal(hidingKernel.output_body_commitment31, "0xa5");
      assert.equal(hidingKernel.delivery_commitment, "0xa6");
      assert.equal(hidingKernel.valid_until_timestamp, `0x${(100 + PRIVATE_VALUE_PROFILES.L.offsets.validUntil).toString(16)}`);

      await prover.proveAssetAction({ ...transferRequest(), shape: L, expectedPublicInputs: L_PUBLIC_INPUTS });
      await prover.proveAssetAction({
        operation: "sponsored-transfer",
        shape: L,
        primary: { circuitUrl: CIRCUIT_URLS.account_rule_large_batch_transfer_ecdsa, witnessMap: EMPTY, label: "primary" },
        feePayer: { circuitUrl: CIRCUIT_URLS.account_rule_large_contract_fee_sponsorship_ecdsa, witnessMap: EMPTY, label: "fee" },
        buildKernelWitnessMap: () => EMPTY,
        expectedPublicInputs: L_PUBLIC_INPUTS,
      });
      await prover.proveAssetAction({
        operation: "assetCreation",
        shape: L,
        authorization: { circuitUrl: CIRCUIT_URLS.account_rule_large_asset_creation_ecdsa, witnessMap: EMPTY, label: "asset creation" },
        buildKernelWitnessMap: () => EMPTY,
        expectedPublicInputs: L_PUBLIC_INPUTS,
      });
      assert.deepEqual(FakeWorker.requests.slice(1).map((entry) => entry.kind === "chonk" ? entry.steps.map((step) => step.circuitUrl) : []), [
        [CIRCUIT_URLS.account_rule_asset_payment_ecdsa, CIRCUIT_URLS.no_op_event_application, CIRCUIT_URLS.private_value_large_transfer_kernel, L_HIDING],
        [
          CIRCUIT_URLS.account_rule_large_batch_transfer_ecdsa,
          CIRCUIT_URLS.account_rule_large_contract_fee_sponsorship_ecdsa,
          CIRCUIT_URLS.no_op_event_application,
          CIRCUIT_URLS.private_value_large_sponsored_transfer_kernel,
          L_HIDING,
        ],
        [CIRCUIT_URLS.account_rule_large_asset_creation_ecdsa, CIRCUIT_URLS.no_op_event_application, CIRCUIT_URLS.private_value_large_asset_creation_kernel, L_HIDING],
      ]);
    } finally {
      prover.destroy();
    }
  });
});

test("native-only L circuits fail closed without the explicit opt-in", async () => {
  await withFakes(async () => {
    const request = {
      shape: L,
      authorizationWitnessMap: EMPTY,
      buildKernelWitnessMap: () => EMPTY,
      expectedPublicInputs: L_PUBLIC_INPUTS,
    };
    await assert.rejects(browserProver.proveTransfer(request), /requires native proving/);
    const prover = createBrowserProverSession({ srsPoints: 2 ** 20, threads: 1 }, ASSET_SOURCE);
    try {
      await assert.rejects(prover.proveTransfer(request), /requires native proving/);
      await assert.rejects(
        prover.proveAssetAction({ ...transferRequest(), shape: L, expectedPublicInputs: L_PUBLIC_INPUTS }),
        /requires native proving/,
      );
    } finally {
      prover.destroy();
    }
    assert.equal(FakeWorker.requests.length, 0);
  });
});

test("user account updates use the browser CHONK stack", async () => {
  await withFakes(async () => {
    const expectedPublicInputs = [1n, 2n, 3n];
    const result = await browserProver.proveUserAccountUpdate({
      authorizationWitnessMap: EMPTY,
      buildKernelWitnessMap: () => EMPTY,
      expectedPublicInputs,
    });
    assert.deepEqual(result.proof, Uint8Array.of(7));
    const request = FakeWorker.requests[0]!;
    assert.equal(request.kind, "chonk");
    if (request.kind !== "chonk") return;
    assert.deepEqual(request.steps.map((step) => step.circuitUrl), [
      CIRCUIT_URLS.account_rule_admin_ecdsa,
      CIRCUIT_URLS.no_op_event_application,
      CIRCUIT_URLS.user_account_update_kernel,
      CIRCUIT_URLS.user_account_update_hiding_kernel,
    ]);
    assert.deepEqual(request.steps.map((step) => step.kind), ["app", "app", "kernel", "hiding"]);
  });
});

test("an application supplies its own release profile", async () => {
  await withFakes(async () => {
    const applicationUrl = "/prover/application.json";
    const profile = applicationProfile(applicationUrl);
    await createBrowserProver(ASSET_SOURCE, { [applicationUrl]: profile }).proveChonk({
      steps: [
        { circuitUrl: applicationUrl, vkUrl: profile.vkUrl, kind: "app", witnessMap: EMPTY, label: "application" },
        { circuitUrl: CIRCUIT_URLS.no_op_event_application, vkUrl: PROTOCOL_CIRCUIT_PROFILES[CIRCUIT_URLS.no_op_event_application]!.vkUrl, kind: "app", witnessMap: EMPTY, label: "no-op event application" },
        { circuitUrl: CIRCUIT_URLS.private_value_transfer_kernel, vkUrl: PROTOCOL_CIRCUIT_PROFILES[CIRCUIT_URLS.private_value_transfer_kernel]!.vkUrl, kind: "kernel", witnessMap: EMPTY, label: "kernel" },
        { circuitUrl: CIRCUIT_URLS.private_value_hiding_kernel, vkUrl: PROTOCOL_CIRCUIT_PROFILES[CIRCUIT_URLS.private_value_hiding_kernel]!.vkUrl, kind: "hiding", witnessMap: EMPTY, label: "hiding kernel" },
      ],
      expectedPublicInputs: PUBLIC_INPUTS,
    });
    const request = FakeWorker.requests[0]!;
    assert.equal(request.profile.srsPoints, 2 ** 18);
    if (request.kind === "chonk") {
      assert.deepEqual(request.steps.map((step) => step.kind), ["app", "app", "kernel", "hiding"]);
    }
    assert.equal(request.artifactDigests[applicationUrl], profile.circuitSha256);
    assert.equal(
      request.artifactDigests[profile.vkUrl],
      profile.vkSha256,
    );
    assert.equal(
      request.artifactDigests[CIRCUIT_URLS.private_value_transfer_kernel],
      PROVER_ARTIFACT_SHA256[CIRCUIT_URLS.private_value_transfer_kernel],
    );
  });
});

test("generic CHONK validates explicitly profiled VK URLs", async () => {
  await withFakes(async () => {
    const encoder = new TextEncoder();
    const profiles: Record<string, BrowserCircuitProfile> = {};
    const served = new Map<string, Uint8Array>();
    const kinds = ["app", "kernel", "kernel", "hiding"] as const;
    const steps = kinds.map((kind, index): ChonkProofStep => {
      const circuitUrl = `/prover/custom-stack-${index}.json`;
      const vkUrl = `/custom-vks/stack-${index}.vk`;
      const circuit = encoder.encode(JSON.stringify({ bytecode: "", abi: { parameters: [], return_type: null } }));
      const vk = new Uint8Array(64).fill(index + 1);
      served.set(circuitUrl, circuit);
      served.set(vkUrl, vk);
      profiles[circuitUrl] = {
        srsPoints: 2 ** 18,
        circuitSha256: toHex(sha256(circuit)).slice(2),
        vkUrl,
        vkSha256: toHex(sha256(vk)).slice(2),
      };
      return { circuitUrl, vkUrl, kind, witnessMap: EMPTY, label: `custom ${index}` };
    });
    Object.assign(globalThis, {
      fetch: async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname.replace("/proving/test-assets", "");
        const bytes = served.get(path);
        return bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(Uint8Array.from(bytes));
      },
    });
    FakeWorker.validateArtifacts = true;
    const prover = createBrowserProver(ASSET_SOURCE, profiles);
    await prover.proveChonk({ steps, expectedPublicInputs: [] });

    served.get(steps[0]!.vkUrl)![0]! ^= 0x01;
    await assert.rejects(
      prover.proveChonk({ steps, expectedPublicInputs: [] }),
      /failed its pinned digest/,
    );
  });
});

test("generic CHONK rejects a VK URL outside its circuit profile", () => {
  const circuitUrl = "/prover/profile-mismatch.json";
  const profile = applicationProfile(circuitUrl, "/custom-vks/profiled.vk");
  assert.throws(
    () => createBrowserProver(ASSET_SOURCE, { [circuitUrl]: profile }).proveChonk({
      steps: [{
        circuitUrl,
        vkUrl: "/custom-vks/unprofiled.vk",
        kind: "app",
        witnessMap: EMPTY,
        label: "mismatched",
      }],
      expectedPublicInputs: [],
    }),
    /does not match the release profile/,
  );
});

test("CHONK VK cache is bound to the profile digest", async () => {
  await withFakes(async () => {
    const circuitUrl = "/prover/cache-binding.json";
    const vkUrl = "/custom-vks/cache-binding.vk";
    const firstVk = new Uint8Array(VK_LEN * 32).fill(1);
    const secondVk = new Uint8Array(VK_LEN * 32).fill(2);
    let servedVk = firstVk;
    let fetches = 0;
    Object.assign(globalThis, {
      fetch: async (input: string | URL | Request) => {
        if (new URL(String(input)).pathname.endsWith(vkUrl)) {
          fetches += 1;
          return new Response(servedVk);
        }
        return await fakeFetch(input);
      },
    });
    const profile = applicationProfile(circuitUrl, vkUrl);
    await createBrowserProver(ASSET_SOURCE, {
      [circuitUrl]: { ...profile, vkSha256: toHex(sha256(firstVk)).slice(2) },
    }).proveTransfer({
      authorizationCircuitUrl: circuitUrl,
      authorizationWitnessMap: EMPTY,
      buildKernelWitnessMap: () => EMPTY,
      expectedPublicInputs: PUBLIC_INPUTS,
    });

    servedVk = secondVk;
    await createBrowserProver(ASSET_SOURCE, {
      [circuitUrl]: { ...profile, vkSha256: toHex(sha256(secondVk)).slice(2) },
    }).proveTransfer({
      authorizationCircuitUrl: circuitUrl,
      authorizationWitnessMap: EMPTY,
      buildKernelWitnessMap: () => EMPTY,
      expectedPublicInputs: PUBLIC_INPUTS,
    });
    assert.equal(fetches, 2);
  });
});

test("failed CHONK VK loads are evicted from the cache", async () => {
  await withFakes(async () => {
    const circuitUrl = "/prover/cache-retry.json";
    const vkUrl = "/custom-vks/cache-retry.vk";
    const vk = new Uint8Array(VK_LEN * 32);
    let fetches = 0;
    Object.assign(globalThis, {
      fetch: async (input: string | URL | Request) => {
        if (new URL(String(input)).pathname.endsWith(vkUrl)) {
          fetches += 1;
          return fetches === 1 ? new Response(null, { status: 503 }) : new Response(vk);
        }
        return await fakeFetch(input);
      },
    });
    const profile = {
      ...applicationProfile(circuitUrl, vkUrl),
      vkSha256: toHex(sha256(vk)).slice(2),
    };
    const prover = createBrowserProver(ASSET_SOURCE, { [circuitUrl]: profile });
    const request = {
      authorizationCircuitUrl: circuitUrl,
      authorizationWitnessMap: EMPTY,
      buildKernelWitnessMap: () => EMPTY,
      expectedPublicInputs: PUBLIC_INPUTS,
    };
    await assert.rejects(prover.proveTransfer(request), /HTTP 503/);
    await prover.proveTransfer(request);
    assert.equal(fetches, 2);
  });
});

test("an unprofiled custom application requires an explicit prover session", async () => {
  assert.throws(
    () => browserProver.proveTransfer({
      authorizationCircuitUrl: "/prover/custom.json",
      authorizationWitnessMap: EMPTY,
      buildKernelWitnessMap: () => EMPTY,
      expectedPublicInputs: PUBLIC_INPUTS,
    }),
    /explicitly profiled prover session/,
  );
});

test("two-account fee payment folds both installed applications", async () => {
  await withFakes(async () => {
    const primaryUrl = "/prover/custom-primary.json";
    const seen: Array<{ step?: string; circuit?: string }> = [];
    await createBrowserProver(ASSET_SOURCE, { [primaryUrl]: applicationProfile(primaryUrl) }).proveAssetAction({
      operation: "sponsored-transfer",
      primary: { circuitUrl: primaryUrl, witnessMap: EMPTY, label: "primary" },
      feePayer: { circuitUrl: CIRCUIT_URLS.account_rule_contract_fee_sponsorship_ecdsa, witnessMap: EMPTY, label: "fee" },
      buildKernelWitnessMap: () => EMPTY,
      expectedPublicInputs: PUBLIC_INPUTS,
    }, (status) => seen.push(status));
    const request = FakeWorker.requests[0]!;
    assert.equal(request.kind, "chonk");
    assert.equal(request.profile.srsPoints, 2 ** 18);
    if (request.kind !== "chonk") return;
    assert.deepEqual(request.steps.map((step) => step.circuitUrl), [
      primaryUrl,
      CIRCUIT_URLS.account_rule_contract_fee_sponsorship_ecdsa,
      CIRCUIT_URLS.no_op_event_application,
      CIRCUIT_URLS.private_value_sponsored_transfer_kernel,
      CIRCUIT_URLS.private_value_hiding_kernel,
    ]);
    assert.ok(seen.some((status) =>
      status.step === "assemble" && status.circuit === "private_value_sponsored_transfer_kernel"));
  });
});

test("one-shot and warm sessions retain their requested lifetimes", async () => {
  await withFakes(async () => {
    FakeWorker.instances = 0;
    FakeWorker.terminations = 0;
    await browserProver.proveAssetAction(transferRequest());
    await browserProver.proveAssetAction(transferRequest());
    assert.equal(FakeWorker.instances, 2);
    assert.equal(FakeWorker.terminations, 2);

    assert.ok(FakeWorker.requests.every((request) => request.profile.reportWasmMemory === undefined));

    const prover = createBrowserProverSession(
      { srsPoints: 2 ** 20, threads: 1, reportWasmMemory: true },
      ASSET_SOURCE,
    );
    try {
      await prover.proveAssetAction(transferRequest());
      await prover.proveAssetAction(transferRequest());
      assert.equal(FakeWorker.instances, 3);
      assert.ok(FakeWorker.requests.slice(-2).every((request) =>
        request.profile.reuse && request.profile.reportWasmMemory === true));
    } finally {
      prover.destroy();
    }
    assert.equal(FakeWorker.terminations, 3);
  });
});

const CANCEL_CIRCUIT_URL = "/prover/cancel-test.json";
const CANCEL_VK_URL = "/chonk-vks/cancel-test.vk";

function cancelProver() {
  return createBrowserProver(ASSET_SOURCE, { [CANCEL_CIRCUIT_URL]: applicationProfile(CANCEL_CIRCUIT_URL) });
}

function cancelRequest(): { steps: ChonkProofStep[]; expectedPublicInputs: bigint[] } {
  return {
    steps: [{
      circuitUrl: CANCEL_CIRCUIT_URL,
      vkUrl: CANCEL_VK_URL,
      kind: "app",
      witnessMap: EMPTY,
      label: "cancel test",
    }],
    expectedPublicInputs: PUBLIC_INPUTS,
  };
}

test("a pre-aborted one-shot proof rejects without starting a worker", async () => {
  await withFakes(async () => {
    FakeWorker.instances = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      cancelProver().proveChonk(cancelRequest(), undefined, controller.signal),
      (cause) => cause instanceof ProverAbortError && cause.name === "AbortError",
    );
    assert.equal(FakeWorker.instances, 0);
  });
});

test("canceling a pending one-shot proof terminates it and a fresh proof still works", async () => {
  await withFakes(async () => {
    FakeWorker.terminations = 0;
    FakeWorker.autoRespond = false;
    const statuses: string[] = [];
    const controller = new AbortController();
    const prover = cancelProver();
    const pending = prover.proveChonk(
      cancelRequest(),
      (status) => statuses.push(status.message),
      controller.signal,
    );
    assert.equal(FakeWorker.requests.length, 1);
    const lateMessage = FakeWorker.workers[0]!.onmessage;
    controller.abort();
    await assert.rejects(
      pending,
      (cause) => cause instanceof ProverAbortError && cause.name === "AbortError",
    );
    assert.equal(FakeWorker.terminations, 1);

    lateMessage?.({ data: {
      type: "status",
      phase: "proving",
      message: "late status",
      elapsedMs: 50,
    } } as MessageEvent<WorkerResponse>);
    lateMessage?.({ data: {
      type: "chonk-result",
      proof: Uint8Array.of(99),
    } } as unknown as MessageEvent<WorkerResponse>);
    assert.deepEqual(statuses, []);

    FakeWorker.autoRespond = true;
    const fresh = await prover.proveChonk(cancelRequest());
    assert.deepEqual(fresh.proof, Uint8Array.of(7));
    assert.equal(FakeWorker.terminations, 2);
  });
});

test("canceling a warm proof replaces its worker and preserves the session", async () => {
  await withFakes(async () => {
    FakeWorker.instances = 0;
    FakeWorker.terminations = 0;
    FakeWorker.autoRespond = false;
    const controller = new AbortController();
    const prover = createBrowserProverSession({ srsPoints: 2 ** 20, threads: 1 }, ASSET_SOURCE);
    const pending = prover.proveAssetAction(transferRequest(), undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(FakeWorker.requests.length, 1);
    controller.abort();
    await assert.rejects(
      pending,
      (cause) => cause instanceof ProverAbortError && cause.name === "AbortError",
    );
    assert.equal(FakeWorker.terminations, 1);
    assert.equal(FakeWorker.instances, 2);

    FakeWorker.autoRespond = true;
    const result = await prover.proveAssetAction(transferRequest());
    assert.deepEqual(result.proof, Uint8Array.of(7));
    assert.equal(FakeWorker.instances, 2);
    prover.destroy();
    assert.equal(FakeWorker.terminations, 2);
  });
});

test("a crashed warm worker is replaced and the session keeps working", async () => {
  await withFakes(async () => {
    FakeWorker.instances = 0;
    FakeWorker.terminations = 0;
    FakeWorker.autoRespond = false;
    const prover = createBrowserProverSession({ srsPoints: 2 ** 20, threads: 1 }, ASSET_SOURCE);
    const pending = prover.proveAssetAction(transferRequest());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(FakeWorker.requests.length, 1);
    FakeWorker.workers[0]!.onerror?.({ message: "out of memory" } as ErrorEvent);
    await assert.rejects(pending, /out of memory/);
    assert.equal(FakeWorker.terminations, 1);
    assert.equal(FakeWorker.instances, 2);

    FakeWorker.autoRespond = true;
    const result = await prover.proveAssetAction(transferRequest());
    assert.deepEqual(result.proof, Uint8Array.of(7));
    prover.destroy();
  });
});

test("an unexpected worker message rejects the pending request instead of hanging", async () => {
  await withFakes(async () => {
    FakeWorker.instances = 0;
    FakeWorker.terminations = 0;
    FakeWorker.autoRespond = false;
    const prover = createBrowserProverSession({ srsPoints: 2 ** 20, threads: 1 }, ASSET_SOURCE);
    const pending = prover.setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    FakeWorker.workers[0]!.onmessage?.({ data: { type: "mystery" } } as unknown as MessageEvent<WorkerResponse>);
    await assert.rejects(pending, /mystery while setup-result was pending/);
    assert.equal(FakeWorker.instances, 2);
    prover.destroy();
  });
});

test("an application profile cannot replace a protocol circuit pin", () => {
  const protocolUrl = CIRCUIT_URLS.private_value_transfer_kernel;
  assert.throws(
    () => createBrowserProver(ASSET_SOURCE, {
      [protocolUrl]: { ...PROTOCOL_CIRCUIT_PROFILES[protocolUrl]!, circuitSha256: "00".repeat(32) },
    }),
    /conflicting release pins/,
  );
});

test("a pre-aborted warm proof preserves its idle worker", async () => {
  await withFakes(async () => {
    FakeWorker.instances = 0;
    FakeWorker.terminations = 0;
    const controller = new AbortController();
    controller.abort();
    const prover = createBrowserProverSession({ srsPoints: 2 ** 20, threads: 1 }, ASSET_SOURCE);
    await assert.rejects(
      prover.proveAssetAction(transferRequest(), undefined, controller.signal),
      (cause) => cause instanceof ProverAbortError && cause.name === "AbortError",
    );
    assert.equal(FakeWorker.instances, 1);
    assert.equal(FakeWorker.terminations, 0);

    const result = await prover.proveAssetAction(transferRequest());
    assert.deepEqual(result.proof, Uint8Array.of(7));
    assert.equal(FakeWorker.instances, 1);
    prover.destroy();
    assert.equal(FakeWorker.terminations, 1);
  });
});

test("requireArtifactDigest fails closed on unpinned and tampered artifacts", () => {
  const bytes = new Uint8Array(8).fill(0xab);
  const digest = toHex(sha256(bytes)).slice(2);
  const pins = { "/prover/circuit.json": digest };

  // Exact pinned bytes pass.
  requireArtifactDigest("/prover/circuit.json", bytes, pins);

  // No pin for the URL.
  assert.throws(
    () => requireArtifactDigest("/prover/other.json", bytes, pins),
    /not pinned/,
  );

  // Tampered bytes against the pin.
  const tampered = Uint8Array.from(bytes);
  tampered[0]! ^= 0x01;
  assert.throws(
    () => requireArtifactDigest("/prover/circuit.json", tampered, pins),
    /failed its pinned digest/,
  );
});
