// Browser wiring for direct L1 self-publication: the injected wallet signs and
// sends, and the SDK's IndexedDB journal makes the broadcast durable. The
// adapter itself is the shared one in ../submission.ts.

import {
  Eip1193RelaySubmitter,
  IndexedDbRelayJournal,
  RelayJournalRecoveryManager,
  browserRelayJournalKey,
  browserRelayOperationQueue,
} from "@pcash/sdk/relay";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import {
  custom,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { createL1SubmissionAdapter, type L1SubmissionAdapter } from "../submission.ts";

export interface BrowserL1Options {
  payoutRecipient: { address: bigint; nkRoot: bigint };
  node: PcashNodeClient;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  includeMempool?: boolean;
}

/** Direct injected-wallet submission with the SDK's durable broadcast journal. */
export function createBrowserL1SubmissionAdapter(options: BrowserL1Options): L1SubmissionAdapter {
  const l1Rpc = options.publicClient.transport.url ?? "http://injected-wallet.invalid";
  const transport = () => custom({ request: (request) => options.publicClient.request(request as never) });
  const journal = (status: StatusResult) => new IndexedDbRelayJournal({ accountKey: browserRelayJournalKey(status, options.account) });
  return createL1SubmissionAdapter({
    node: options.node,
    payoutRecipient: () => options.payoutRecipient,
    daMode: "calldata",
    l1Sender: options.account,
    ...(options.includeMempool === undefined ? {} : { includeMempool: options.includeMempool }),
    submitterFor(status, { onJournaled, onBroadcast } = {}) {
      const durableJournal = journal(status);
      return new Eip1193RelaySubmitter({
        node: options.node, address: options.account,
        rpcUrl: l1Rpc,
        transport: transport(),
        // Never retried by the client's transport: a second eth_sendTransaction can post the batch twice.
        provider: { request: (request) => options.walletClient.request(request as never, { retryCount: 0 }) },
        journal: onJournaled === undefined ? durableJournal : {
          read: () => durableJournal.read(),
          create: async entry => {
            await durableJournal.create(entry);
            if (entry.kind === "batch") await onJournaled(structuredClone(entry));
          },
          replace: entry => durableJournal.replace(entry),
          clear: id => durableJournal.clear(id),
          archive: id => durableJournal.archive(id),
        },
        runExclusive: browserRelayOperationQueue(options.account),
        ...(onBroadcast === undefined ? {} : { onBroadcast }),
      });
    },
    async recovery() {
      return new RelayJournalRecoveryManager({
        journal: journal(await options.node.status()),
        node: options.node,
        l1Rpc,
        transportFor: transport,
        runExclusive: browserRelayOperationQueue(options.account),
      });
    },
  });
}
