// Trial decryption for a browser wallet's scan on a pool of module workers
// (trialDecryptWorker.ts), so ML-KEM decapsulation runs on several cores and
// off the page's thread. Each call is cut into short runs that idle workers
// take in turn, so a slow core holds back only its own run; the answers are
// reassembled in envelope order.

import type { TrialDecrypt } from "../actions/scan.ts";
import type { TrialDecryptRequest, TrialDecryptResponse } from "./trialDecryptWorker.ts";

/** Envelopes per worker request: about 10 ms of decapsulation on a desktop core. */
const RUN_LENGTH = 32;
/** A page of outputs holds about twenty runs; more workers than this add memory, not speed. */
const MAX_WORKERS = 8;

export interface BrowserTrialDecryption {
  readonly trialDecrypt: TrialDecrypt;
  /** Terminate the workers. Calls still waiting, and any later call, fail. */
  destroy(): void;
}

interface Run {
  request: TrialDecryptRequest;
  resolve: (openings: TrialDecryptResponse) => void;
  reject: (error: Error) => void;
}

/** Workers start on first use, one for each core but the page's own, up to eight. */
export function createBrowserTrialDecryption(): BrowserTrialDecryption {
  const cores = navigator.hardwareConcurrency;
  const size = Number.isInteger(cores) && cores > 1 ? Math.min(MAX_WORKERS, cores - 1) : 1;
  const queue: Run[] = [];
  const idle: Worker[] = [];
  const busy = new Map<Worker, Run>();
  let closed = false;

  // A worker that did not load or crashed fails the runs waiting with it, rather than each starting another worker.
  const discard = (worker: Worker, error: Error): void => {
    worker.terminate();
    const index = idle.indexOf(worker);
    if (index !== -1) idle.splice(index, 1);
    busy.get(worker)?.reject(error);
    busy.delete(worker);
    for (const run of queue.splice(0)) run.reject(error);
  };

  const spawn = (): Worker => {
    const worker = new Worker(new URL("./trialDecryptWorker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<TrialDecryptResponse>) => {
      const run = busy.get(worker)!;
      busy.delete(worker);
      idle.push(worker);
      run.resolve(event.data);
      dispatch();
    };
    worker.onerror = (event) => {
      discard(worker, new Error(`trial decryption worker failed${event.message ? `: ${event.message}` : ""}`));
    };
    worker.onmessageerror = () => discard(worker, new Error("trial decryption worker sent an unreadable answer"));
    return worker;
  };

  const dispatch = (): void => {
    while (queue.length !== 0) {
      const worker = idle.pop() ?? (busy.size < size ? spawn() : undefined);
      if (worker === undefined) return;
      const run = queue.shift()!;
      busy.set(worker, run);
      worker.postMessage(run.request);
    }
  };

  return {
    trialDecrypt: (mlKemSecretKeys, envelopes) => {
      if (closed) return Promise.reject(new Error("trial decryption is closed"));
      const runs: Promise<TrialDecryptResponse>[] = [];
      for (let from = 0; from < envelopes.length; from += RUN_LENGTH) {
        const request = { mlKemSecretKeys, envelopes: envelopes.slice(from, from + RUN_LENGTH) };
        runs.push(new Promise((resolve, reject) => queue.push({ request, resolve, reject })));
      }
      dispatch();
      return Promise.all(runs).then((parts) => parts.flat());
    },
    destroy() {
      closed = true;
      const error = new Error("trial decryption is closed");
      for (const worker of [...idle, ...busy.keys()]) worker.terminate();
      for (const run of [...busy.values(), ...queue]) run.reject(error);
      idle.length = 0;
      busy.clear();
      queue.length = 0;
    },
  };
}
