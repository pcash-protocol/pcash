// Separate OS process for the shared-file journal regression tests.
import { custom } from "viem";
import { FileRelayJournal } from "../src/node/relayJournal.ts";
import { PrivateKeyRelaySubmitter } from "../src/node/privateKeyRelaySubmitter.ts";

const journal = new FileRelayJournal(process.argv[2]!);
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextId = 0;
const submitter = new PrivateKeyRelaySubmitter({
  privateKey: `0x${"11".repeat(32)}`, rpcUrl: "http://unused", journal,
  node: {
    getReceipt: async () => [],
    status: async () => { throw new Error("not needed for pending recovery"); },
    getInboxDeliveryBatch: async (hash) => ({ l1TransactionHash: hash }) as never,
  },
  transport: custom({
    request({ method, params }) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        process.send!({ event: "rpc", id, method, params });
      });
    },
  }, { retryCount: 0 }),
});

process.on("message", (message: { command?: string; id?: number; result?: unknown; error?: string }) => {
  if (message.id !== undefined) {
    const operation = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error === undefined) operation.resolve(message.result);
    else operation.reject(new Error(message.error));
    return;
  }
  process.send!({ event: "starting" });
  const operation = message.command === "hold"
    ? journal.runExclusive(async () => {
      process.send!({ event: "locked" });
      await new Promise(() => {});
    })
    : submitter.assertAvailable();
  void operation.then(
    () => process.send!({ event: "done" }),
    (error: Error) => process.send!({ event: "done", error: error.name, message: error.message }),
  );
});
process.send!({ event: "ready" });
