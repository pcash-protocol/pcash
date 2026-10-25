// Node filesystem binding for the portable PGlite wallet database.

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { WalletDatabase, WalletStorageCipher } from "@pcash/sdk/wallet/database";
import { PGliteWalletDatabase } from "../pgliteDatabase.ts";
import { keyedResourcePool } from "@pcash/sdk/wallet";

export interface NodeWalletDatabaseOptions {
  cipher?: WalletStorageCipher;
}

/** Create `path` as a directory only the current user can read, or refuse one that is not. */
export function ensurePrivateDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} ${absolute} must be a directory`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} ${absolute} is not owned by the current user`);
  }
  chmodSync(absolute, 0o700);
  return absolute;
}

async function openClient(path: string): Promise<PGlite> {
  return PGlite.create(ensurePrivateDirectory(path, "wallet database directory"), { relaxedDurability: false });
}

/** Open one owned filesystem database. Share the returned handle across accounts. */
export async function openNodeWalletDatabase(path: string, options: NodeWalletDatabaseOptions = {}): Promise<WalletDatabase> {
  const client = await openClient(path);
  try { return await PGliteWalletDatabase.open(client, { ...options, ownsClient: true }); }
  catch (error) { await client.close(); throw error; }
}

/** Open an owned ephemeral database for tests and non-persistent Node hosts. */
export async function openMemoryWalletDatabase(): Promise<WalletDatabase> {
  return PGliteWalletDatabase.open(await PGlite.create("memory://"), { ownsClient: true });
}

const acquireSharedDatabase = keyedResourcePool<{ database: WalletDatabase; cipherId: string | undefined }>(
  ({ database }) => database.close(),
);

/** Acquire one process-wide filesystem PGlite connection for a data directory. */
export async function acquireNodeWalletDatabase(
  path: string,
  options: NodeWalletDatabaseOptions = {},
): Promise<{ database: WalletDatabase; release: () => Promise<void> }> {
  const absolute = resolve(path);
  const lease = await acquireSharedDatabase(absolute, async () => ({
    database: await openNodeWalletDatabase(absolute, options), cipherId: options.cipher?.id,
  }));
  if (lease.resource.cipherId !== options.cipher?.id) {
    await lease.release();
    throw new Error("wallet database is already open with a different vault or storage mode");
  }
  return { database: lease.resource.database, release: lease.release };
}
