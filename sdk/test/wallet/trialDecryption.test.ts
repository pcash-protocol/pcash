// The browser wallet's trial decryption against the in-process path. The pool
// and its worker are the built modules the web app bundles; node:worker_threads
// stands in for the page's Worker, so the envelopes are opened on real threads.

import { Worker as NodeWorker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodePayload,
  encryptEnvelope,
  generateMlKemKeyPair,
  noteBodyCommitment,
  outputCommitment,
  ownerCommitment,
  sizeClassFiller,
  trialOpenEnvelopeWithKeys,
} from "@pcash/sdk/protocol";
import { createBrowserTrialDecryption } from "@pcash/sdk/wallet/web";
import { scanFeed, type ScanFeedItem } from "../../src/wallet/actions/scan.ts";

const chainId = 0x1ff6n;

// Gives the worker module the `self` of a dedicated worker, then loads it.
const THREAD_BOOTSTRAP = new URL(`data:text/javascript,${encodeURIComponent(`
import { parentPort, workerData } from "node:worker_threads";
globalThis.self = globalThis;
globalThis.postMessage = (message) => parentPort.postMessage(message);
Object.defineProperty(globalThis, "onmessage", { set: (handler) => parentPort.on("message", (data) => handler({ data })) });
await import(workerData.url);
`)}`);

class ThreadWorker {
  static started = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly #thread: NodeWorker;

  constructor(url: URL, options: { type?: string }) {
    expect(options.type).toBe("module");
    ThreadWorker.started += 1;
    this.#thread = new NodeWorker(THREAD_BOOTSTRAP, { workerData: { url: url.href } });
    this.#thread.on("message", (data) => this.onmessage?.({ data }));
    this.#thread.on("error", (error: Error) => this.onerror?.({ message: error.message }));
  }

  postMessage(message: unknown): void {
    this.#thread.postMessage(message);
  }

  terminate(): void {
    void this.#thread.terminate();
  }
}

class UnloadableWorker {
  onmessage: (() => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() {
    setTimeout(() => this.onerror?.({ message: "module did not load" }));
  }

  postMessage(): void {}
  terminate(): void {}
}

const priorWorker = globalThis.Worker;
beforeEach(() => {
  ThreadWorker.started = 0;
});
afterEach(() => {
  Object.assign(globalThis, { Worker: priorWorker });
});

describe("browser trial decryption", () => {
  const owner = 0x1234567890abcdef1234567890abcdef12345678n;
  const primary = generateMlKemKeyPair(new Uint8Array(64).fill(0x31));
  const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(0x52));
  const stranger = generateMlKemKeyPair(new Uint8Array(64).fill(0x73));
  const secretKeys = [primary.secretKey, rotated.secretKey];

  // Payments to either key, filler, another wallet's payments, a damaged
  // envelope, and a slot outside its profile, which is never trial-decrypted.
  const feed: ScanFeedItem[] = Array.from({ length: 300 }, (_, index) => {
    const leafIndex = BigInt(index);
    const noteSecret = 0xc0ffee00n + leafIndex;
    const amount = 1000n + leafIndex;
    const leaf = outputCommitment(noteBodyCommitment(ownerCommitment(owner, noteSecret), 0n, amount), leafIndex);
    const payload = encodePayload({ chainId, amount, owner, noteSecret, outputIndex: 0 });
    const outputData = [
      () => encryptEnvelope(primary.publicKey, payload),
      () => encryptEnvelope(rotated.publicKey, payload),
      () => sizeClassFiller(),
      () => encryptEnvelope(stranger.publicKey, payload),
      () => {
        const damaged = encryptEnvelope(primary.publicKey, payload);
        damaged[damaged.length - 1]! ^= 1;
        return damaged;
      },
    ][index % 5]!();
    return { outputData, kind: 0, shape: 0, outputIndex: index === 7 ? 9 : 0, leafIndex, outputCommitment: leaf };
  });

  it("opens every envelope on worker threads exactly as in-process, in feed order", async () => {
    Object.assign(globalThis, { Worker: ThreadWorker });
    const trialDecryption = createBrowserTrialDecryption();
    try {
      const params = { chainId, mlKemSecretKeys: secretKeys, owners: [owner], feed };
      const inProcess = await scanFeed(params);
      const onWorkers = await scanFeed({ ...params, trialDecrypt: trialDecryption.trialDecrypt });
      expect(onWorkers).toEqual(inProcess);
      expect(inProcess.recovered).toHaveLength(120);

      const envelopes = feed.map((item) => (item as Extract<ScanFeedItem, { outputData: Uint8Array }>).outputData);
      expect(await trialDecryption.trialDecrypt(secretKeys, envelopes))
        .toEqual(envelopes.map((envelope) => trialOpenEnvelopeWithKeys(secretKeys, envelope)));
      expect(ThreadWorker.started).toBeGreaterThan(1);
      expect(ThreadWorker.started).toBeLessThanOrEqual(8);
    } finally {
      trialDecryption.destroy();
    }
  });

  it("fails the scan's call when a worker cannot load", async () => {
    Object.assign(globalThis, { Worker: UnloadableWorker });
    const trialDecryption = createBrowserTrialDecryption();
    await expect(scanFeed({ chainId, mlKemSecretKeys: secretKeys, owners: [owner], feed, trialDecrypt: trialDecryption.trialDecrypt }))
      .rejects.toThrow("trial decryption worker failed: module did not load");
    trialDecryption.destroy();
    await expect(trialDecryption.trialDecrypt(secretKeys, [])).rejects.toThrow("trial decryption is closed");
  });
});
