import { lstatSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openNodeWalletDatabase } from "../../src/node/walletDatabase.ts";
import { inventoryPath, openKeystore, writeSecureFile } from "../../src/service/credentials.ts";

const PASSWORD = "vault race regression password";
const WALLET = {
  address: "0xf278cf59f82edcf871d630f28ecc8056f25c1cdb",
  mnemonic: `${"abandon ".repeat(23)}art`,
};

it("publishes a complete private file without replacing an existing one", () => {
  const directory = mkdtempSync(join(tmpdir(), "vault-exclusive-test-"));
  const path = join(directory, "vault.json");
  expect(writeSecureFile(path, "first", { exclusive: true })).toBe(true);
  expect(writeSecureFile(path, "second", { exclusive: true })).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("first");
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  writeSecureFile(path, "saved normally");
  expect(readFileSync(path, "utf8")).toBe("saved normally");
});

it("competing initializers return the persisted cipher and preserve the winner's saved wallets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vault-race-test-"));
  const opened: Awaited<ReturnType<typeof openKeystore>>[] = [];
  let database: ReturnType<typeof openNodeWalletDatabase> | undefined;
  const initialize = async () => {
    const vault = await openKeystore(directory, PASSWORD);
    opened.push(vault);
    if (opened.length === 1) {
      vault.store.wallets.push(WALLET);
      vault.save();
      database = openNodeWalletDatabase(inventoryPath(directory), { cipher: vault.storageCipher });
    }
    return vault;
  };
  try {
    const [first, second] = await Promise.all([initialize(), initialize()]);
    expect(first.storageCipher.id).toBe(second.storageCipher.id);
    expect(first.store.wallets).toEqual([WALLET]);
    expect(second.store.wallets).toEqual([WALLET]);
    await (await database!).close();
    database = undefined;
    const restored = await openKeystore(directory, PASSWORD);
    opened.push(restored);
    expect(restored.storageCipher.id).toBe(first.storageCipher.id);
    expect(restored.store.wallets).toEqual([WALLET]);
    database = openNodeWalletDatabase(inventoryPath(directory), { cipher: restored.storageCipher });
    await expect(database).resolves.toBeDefined();
  } finally {
    if (database !== undefined) await (await database).close();
    for (const vault of opened) vault.close();
  }
}, 30_000);

it("a losing initializer with another password cannot overwrite the winning vault", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vault-password-race-test-"));
  const passwords = [PASSWORD, "different vault password"];
  const results = await Promise.allSettled(passwords.map(password => openKeystore(directory, password)));
  const winner = results.findIndex(result => result.status === "fulfilled");
  const opened: Awaited<ReturnType<typeof openKeystore>>[] = [];
  try {
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ message: expect.stringMatching(/authentication failed/) }) }),
    ]);
    const result = results[winner]!;
    if (result.status !== "fulfilled") throw new Error("no initializer succeeded");
    opened.push(result.value);
    const restored = await openKeystore(directory, passwords[winner]!);
    opened.push(restored);
    expect(restored.storageCipher.id).toBe(result.value.storageCipher.id);
  } finally {
    for (const result of results) if (result.status === "fulfilled") result.value.close();
    for (const vault of opened) vault.close();
  }
}, 30_000);
