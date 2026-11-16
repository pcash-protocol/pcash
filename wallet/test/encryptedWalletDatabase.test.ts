import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WALLET_DATABASE_STATE_STORE, walletDatabaseKey } from "@pcash/sdk/wallet/database";
import { openNodeWalletDatabase } from "../src/node/walletDatabase.ts";
import { createWalletVault, unlockWalletVault, type UnlockedWalletVault, type WalletVaultDocument } from "@pcash/sdk/wallet/node";
import { PGliteWalletDatabase, pgliteWalletStoreBackend } from "../src/pgliteDatabase.ts";
import { emptyWalletState } from "@pcash/sdk/wallet/testing";
import { type WalletStoreIdentity } from "@pcash/sdk/wallet/database";

const IDENTITY: WalletStoreIdentity = { address: 0xabcn, network: { chainId: 8191n, genesisHash: `0x${"11".repeat(32)}` } };
const NOTE_SECRET = "0x1746ab9176886f253b109ac7892344ef164cad903b59c948ec5a279dd4213fa7";
const WATCHED_NULLIFIER = "0x2867ca037627fe9201acbfd8920223451289cdce999122226789dcba065551124";
const RECOVERY_PHRASE = "example mnemonic contents for encrypted storage regression";
const PASSWORD = "encrypted database test password";
let document: WalletVaultDocument;
let vault: UnlockedWalletVault;

beforeAll(async () => { ({ document, vault } = await createWalletVault(PASSWORD, { wallets: [{ mnemonic: RECOVERY_PHRASE }] })); });
afterAll(() => vault?.close());

function data() {
  const result = emptyWalletState(IDENTITY);
  result.notes.push({
    leafIndex: "345", outputIndex: 0, assetId: "0", amount: "572936584910287643",
    owner: "0xabc", noteSecret: NOTE_SECRET, commitment: `0x${"ab".repeat(32)}`, spent: false, pending: false,
  });
  return result;
}

function assertNoPlaintext(directory: string, needles: readonly string[]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) assertNoPlaintext(path, needles);
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      for (const needle of needles) expect(bytes.includes(Buffer.from(needle)), `${entry.name} contains plaintext wallet data`).toBe(false);
    }
  }
}

describe("encrypted wallet database", () => {
  it("persists no plaintext notes or watched records, including WAL, and reopens with the vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pcash-encrypted-wallet-"));
    const path = join(directory, "wallet.pglite");
    writeFileSync(join(directory, "keystore.json"), JSON.stringify(document), { mode: 0o600 });
    const client = await PGlite.create(path, { relaxedDurability: false });
    const database = await PGliteWalletDatabase.open(client, { ownsClient: true, cipher: vault.storageCipher });
    const store = database[WALLET_DATABASE_STATE_STORE](IDENTITY);
    const backend = pgliteWalletStoreBackend(client, walletDatabaseKey(IDENTITY), vault.storageCipher);
    const original = data();
    try {
      await backend.transaction(() => ({ data: original, value: undefined }), {
        replace: false, writes: new Map([[`nullifier:${WATCHED_NULLIFIER}`, { transactionId: "private-wallet-transaction-selection" }]]),
      });
      expect(await store.load()).toEqual(original);
      const stored = await client.query<{ state: unknown }>("SELECT state FROM pcash_wallet_state");
      expect(JSON.stringify(stored.rows)).not.toContain(NOTE_SECRET);
      expect(await backend.readChain([`nullifier:${WATCHED_NULLIFIER}`])).toEqual(
        new Map([[`nullifier:${WATCHED_NULLIFIER}`, { transactionId: "private-wallet-transaction-selection" }]]),
      );
    } finally { await database.close(); }
    assertNoPlaintext(directory, [NOTE_SECRET, NOTE_SECRET.slice(2), original.notes[0]!.amount, WATCHED_NULLIFIER, RECOVERY_PHRASE, "private-wallet-transaction-selection"]);

    const restored = await unlockWalletVault(PASSWORD, JSON.parse(readFileSync(join(directory, "keystore.json"), "utf8")));
    const reopened = await openNodeWalletDatabase(path, { cipher: restored.vault.storageCipher });
    try { expect(await reopened[WALLET_DATABASE_STATE_STORE](IDENTITY).load()).toEqual(original); }
    finally { await reopened.close(); restored.vault.close(); }
    await expect(openNodeWalletDatabase(path)).rejects.toThrow("different vault or storage mode");
  });

  it("rejects swapped rows and modified revisions instead of accepting another wallet's data", async () => {
    const client = await PGlite.create("memory://");
    const database = await PGliteWalletDatabase.open(client, { cipher: vault.storageCipher });
    const first = database[WALLET_DATABASE_STATE_STORE](IDENTITY);
    const second = database[WALLET_DATABASE_STATE_STORE]({ ...IDENTITY, address: 0xdefn });
    try {
      await first.save(data());
      await second.save(emptyWalletState({ ...IDENTITY, address: 0xdefn }));
      const rows = await client.query<{ wallet_key: string; state: unknown }>("SELECT wallet_key, state FROM pcash_wallet_state ORDER BY wallet_key");
      await client.query("UPDATE pcash_wallet_state SET state = $1::jsonb WHERE wallet_key = $2", [JSON.stringify(rows.rows[1]!.state), rows.rows[0]!.wallet_key]);
      const results = await Promise.allSettled([first.load(), second.load()]);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      await client.query("UPDATE pcash_wallet_state SET revision = revision + 1");
      await expect(first.load()).rejects.toThrow("wallet authentication failed");
      await expect(second.load()).rejects.toThrow("wallet authentication failed");
    } finally { await database.close(); await client.close(); }
  });

  it("encrypts chain record identifiers, preserves deletion, and rejects a different vault", async () => {
    const client = await PGlite.create("memory://");
    const database = await PGliteWalletDatabase.open(client, { cipher: vault.storageCipher });
    const backend = pgliteWalletStoreBackend(client, walletDatabaseKey(IDENTITY), vault.storageCipher);
    try {
      await backend.transaction(() => ({ data: data(), value: undefined }), {
        replace: false, writes: new Map([["meta", { notes: [NOTE_SECRET] }], [`nullifier:${WATCHED_NULLIFIER}`, { position: 4 }]]),
      });
      const stored = await client.query("SELECT * FROM pcash_wallet_chain");
      expect(JSON.stringify(stored.rows)).not.toContain(WATCHED_NULLIFIER);
      expect(JSON.stringify(stored.rows)).not.toContain(NOTE_SECRET);
      expect((await backend.readChain()).size).toBe(2);
      await backend.transaction(() => ({ data: data(), value: undefined }), {
        replace: false, writes: new Map([[`nullifier:${WATCHED_NULLIFIER}`, null]]),
      });
      expect(await backend.readChain()).toEqual(new Map([["meta", { notes: [NOTE_SECRET] }]]));
      await expect(PGliteWalletDatabase.open(client, { cipher: { ...vault.storageCipher, id: "another-vault" } }))
        .rejects.toThrow("different vault");
    } finally { await database.close(); await client.close(); }
  });
});
