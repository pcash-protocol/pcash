import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWalletVault, unlockWalletVault, type UnlockedWalletVault, type WalletVaultDocument } from "../../src/wallet/node/vault.ts";

const PASSWORD = "local wallet test password";
const PAYLOAD = { wallets: [{ address: "0x1234", mnemonic: "a recovery phrase held only in encrypted storage" }] };
let document: WalletVaultDocument;
let vault: UnlockedWalletVault;

beforeAll(async () => { ({ document, vault } = await createWalletVault(PASSWORD, PAYLOAD)); });
afterAll(() => vault?.close());

describe("wallet vault", () => {
  it("restores a password-encrypted payload and the same database key", async () => {
    expect(JSON.stringify(document)).not.toContain(PAYLOAD.wallets[0]!.mnemonic);
    const unlocked = await unlockWalletVault(PASSWORD, JSON.parse(JSON.stringify(document)));
    try {
      expect(unlocked.payload).toEqual(PAYLOAD);
      expect(unlocked.vault.storageCipher.id).toBe(vault.storageCipher.id);
      const ciphertext = vault.storageCipher.encode({ note: "private opening" }, "wallet-a");
      expect(unlocked.vault.storageCipher.decode(ciphertext, "wallet-a")).toEqual({ note: "private opening" });
    } finally { unlocked.vault.close(); }
  });

  it("authenticates the password and both encrypted vault sections", async () => {
    await expect(unlockWalletVault("incorrect password", document)).rejects.toThrow("wallet authentication failed");
    for (const section of ["wrappedKey", "payload"] as const) {
      const modified = structuredClone(document);
      modified[section].tag = `${modified[section].tag[0] === "0" ? "1" : "0"}${modified[section].tag.slice(1)}`;
      await expect(unlockWalletVault(PASSWORD, modified)).rejects.toThrow("wallet authentication failed");
    }
  });

  it("rejects external KDF cost changes and plaintext keystores before deriving a key", async () => {
    await expect(unlockWalletVault(PASSWORD, { ...document, kdf: { ...document.kdf, memoryKiB: 2 ** 31 } }))
      .rejects.toThrow("unsupported wallet vault KDF parameters");
    await expect(unlockWalletVault(PASSWORD, { version: 1, wallets: [] })).rejects.toThrow("unsupported wallet vault format");
    await expect(createWalletVault("", PAYLOAD)).rejects.toThrow("password must not be empty");
  });

  it("binds encrypted values to their record context and uses fresh nonces", () => {
    const first = vault.storageCipher.encode(PAYLOAD, "wallet-one");
    const second = vault.storageCipher.encode(PAYLOAD, "wallet-one");
    expect(first).not.toEqual(second);
    expect(() => vault.storageCipher.decode(first, "wallet-two")).toThrow("wallet authentication failed");
    expect(vault.storageCipher.index("wallet-one")).not.toBe(vault.storageCipher.index("wallet-two"));
    expect(vault.seal(PAYLOAD).payload).not.toEqual(vault.seal(PAYLOAD).payload);
  });

  it("cannot encrypt, decrypt, or derive indexes after closing", async () => {
    const unlocked = await unlockWalletVault(PASSWORD, document);
    const encrypted = unlocked.vault.storageCipher.encode(PAYLOAD, "record");
    unlocked.vault.close();
    expect(() => unlocked.vault.seal(PAYLOAD)).toThrow("locked");
    expect(() => unlocked.vault.storageCipher.encode(PAYLOAD, "record")).toThrow("locked");
    expect(() => unlocked.vault.storageCipher.decode(encrypted, "record")).toThrow("locked");
    expect(() => unlocked.vault.storageCipher.index("record")).toThrow("locked");
  });
});
