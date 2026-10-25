import { PcashNodeClient } from "@pcash/sdk/clients";
import { encodeBatch, networkConfigFromStatus, posterPayoutOpening } from "@pcash/sdk/protocol";
import { fromHex, randomFieldEntropy, toHex } from "@pcash/sdk/utils";
import { browserRelayJournalKey, IndexedDbRelayJournal, type RelayBatchJournalEntry } from "@pcash/sdk/relay";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { browserWalletDatabaseName, openBrowserWallet } from "@pcash/sdk/wallet/web";

const PRIVATE_KEY = Uint8Array.from({ length: 32 }, () => 1);

export async function seedRelayJournal(rpcUrl: string, entry: RelayBatchJournalEntry) {
  const { status } = await context(rpcUrl);
  const journal = new IndexedDbRelayJournal({ accountKey: browserRelayJournalKey(status, entry.relayerAddress) });
  await journal.create(entry);
}

export async function seedQueuedAccountActivation(name: string, rpcUrl: string, journalEntry: RelayBatchJournalEntry) {
  const { node, profile, status } = await context(rpcUrl);
  const wallet = await openBrowserWallet({ name: browserWalletDatabaseName(name, status), node, profile });
  try {
    await wallet.clearAccountActivation();
    const pending = await wallet.prepareAccountActivation({ authorizationMode: "direct", validUntilTimestamp: status.latestBlockTimestamp + 1n });
    const poster = posterPayoutOpening(profile.address, profile.nkRoot, randomFieldEntropy());
    const batch = toHex(encodeBatch([fromHex(pending.transactionHex)], poster.ownerCommitment, poster.context));
    await seedRelayJournal(rpcUrl, {
      ...journalEntry, selected: [pending.contentHash], batch,
    });
    return { ...pending, batch };
  } finally {
    await wallet.close();
  }
}

export async function replaceAccountActivation(name: string, rpcUrl: string, prepare: boolean) {
  const { node, profile, status } = await context(rpcUrl);
  const wallet = await openBrowserWallet({ name: browserWalletDatabaseName(name, status), node, profile });
  try {
    await wallet.clearAccountActivation();
    if (prepare) return (await wallet.prepareAccountActivation({
      authorizationMode: "direct", validUntilTimestamp: status.latestBlockTimestamp + 3_600n,
    })).contentHash;
    return null;
  } finally {
    await wallet.close();
  }
}

async function context(rpcUrl: string) {
  const node = new PcashNodeClient(rpcUrl);
  const status = await node.status();
  const profile = derivePcashProfileFromPrivateKey(PRIVATE_KEY, networkConfigFromStatus(status));
  return { node, profile, status };
}

export async function seedWalletCursor(name: string, rpcUrl: string) {
  const { node, profile, status } = await context(rpcUrl);
  const wallet = await openBrowserWallet({ name: browserWalletDatabaseName(name, status), node, profile });
  try {
    await wallet.sync();
    return { syncedThrough: (await wallet.snapshot()).syncedThrough?.pcashNumber.toString() ?? null };
  } finally {
    await wallet.close();
  }
}

export async function reopenAndSyncWallet(name: string, rpcUrl: string) {
  const { node, profile, status } = await context(rpcUrl);
  const wallet = await openBrowserWallet({ name: browserWalletDatabaseName(name, status), node, profile });
  try {
    const before = await wallet.snapshot();
    await wallet.sync();
    const after = await wallet.snapshot();
    return {
      before: before.syncedThrough?.pcashNumber.toString() ?? null,
      after: after.syncedThrough?.pcashNumber.toString() ?? null,
    };
  } finally {
    await wallet.close();
  }
}
