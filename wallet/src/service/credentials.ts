import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ML_KEM_768_SECRET_KEY_LENGTH,
  type MlKemKeyPair,
} from "@pcash/sdk/protocol";
import { ML_KEM_768_PUBLIC_KEY_LENGTH } from "@pcash/sdk/constants";
import { fixedHex, fromHexSized, toHex } from "@pcash/sdk/utils";
import { createWalletVault, unlockWalletVault, type UnlockedWalletVault } from "@pcash/sdk/wallet/node";
import { normalizeWalletMnemonic, validateWalletMnemonic } from "@pcash/sdk/wallet";

export function readSecureFile(path: string, label: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular, non-symlink file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} ${path} is accessible by group/other; chmod 600 ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} ${path} is not owned by the current user`);
  }
  return readFileSync(path, "utf8");
}

export function writeSecureFile(path: string, body: string, options: { exclusive?: boolean } = {}): boolean {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(
    dir,
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (options.exclusive) {
      try {
        // Publish complete bytes without replacing another initializer's vault.
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    } else {
      renameSync(temporary, path);
    }
    let directoryFd: number | undefined;
    try {
      directoryFd = openSync(dir, "r");
      fsyncSync(directoryFd);
    } finally {
      if (directoryFd !== undefined) closeSync(directoryFd);
    }
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function jsonObject(path: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(readSecureFile(path, label)) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function privateKeyFromFile(path: string, label: string): Uint8Array {
  const privateKey = jsonObject(path, label).privateKey;
  if (typeof privateKey !== "string") throw new Error(`${label} must contain a string privateKey field`);
  return fromHexSized(privateKey, 32, "privateKey");
}

export function parsePrivateKeyFile(path: string): Uint8Array {
  return privateKeyFromFile(path, "wallet credential file");
}

export function parseReceiveKeyFile(path: string): MlKemKeyPair {
  const parsed = jsonObject(path, "receive-key file");
  return {
    publicKey: fromHexSized(
      String(parsed.mlKemPublicKey ?? ""),
      ML_KEM_768_PUBLIC_KEY_LENGTH,
      "mlKemPublicKey",
    ),
    secretKey: fromHexSized(
      String(parsed.mlKemSecretKey ?? ""),
      ML_KEM_768_SECRET_KEY_LENGTH,
      "mlKemSecretKey",
    ),
  };
}

export interface StoredWallet {
  address: string;
  mnemonic: string;
}

export interface Keystore {
  wallets: StoredWallet[];
}

function parseKeystore(value: unknown): Keystore {
  if (value === null || typeof value !== "object" || !Array.isArray((value as Keystore).wallets)) {
    throw new Error("wallet vault must contain a wallet list");
  }
  const addresses = new Set<string>();
  const wallets = (value as Keystore).wallets.map((wallet, index) => {
    if (wallet === null || typeof wallet !== "object" || typeof wallet.address !== "string"
      || typeof wallet.mnemonic !== "string" || !validateWalletMnemonic(wallet.mnemonic)) {
      throw new Error(`wallet vault entry ${index} must contain an address and a valid recovery phrase`);
    }
    const address = fixedHex(wallet.address, 20, "wallet address");
    if (addresses.has(address)) throw new Error(`wallet vault contains duplicate wallet ${address}`);
    addresses.add(address);
    return { address, mnemonic: normalizeWalletMnemonic(wallet.mnemonic) };
  });
  return { wallets };
}

export function keystorePath(dataDir: string): string {
  return join(dataDir, "keystore.json");
}

export function inventoryPath(dataDir: string): string {
  return join(dataDir, "wallet.pglite");
}

function keystoreHandle(path: string, store: Keystore, vault: UnlockedWalletVault) {
  return {
    store,
    save: () => { writeSecureFile(path, `${JSON.stringify(vault.seal(store))}\n`); },
    storageCipher: vault.storageCipher,
    close: () => vault.close(),
  };
}

/** Unlock the server-local vault before opening any persistent wallet state. */
export async function openKeystore(dataDir: string, password: string) {
  const path = keystorePath(dataDir);
  let document: unknown;
  try {
    document = JSON.parse(readSecureFile(path, "wallet vault")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (document === undefined) {
    const store: Keystore = { wallets: [] };
    const created = await createWalletVault(password, store);
    try {
      if (writeSecureFile(path, `${JSON.stringify(created.document)}\n`, { exclusive: true })) {
        return keystoreHandle(path, store, created.vault);
      }
    } catch (error) {
      created.vault.close();
      throw error;
    }
    created.vault.close();
    document = JSON.parse(readSecureFile(path, "wallet vault")) as unknown;
  }
  const opened = await unlockWalletVault(password, document);
  try {
    return keystoreHandle(path, parseKeystore(opened.payload), opened.vault);
  } catch (error) {
    opened.vault.close();
    throw error;
  }
}

export function parseL1KeyFile(path: string): string {
  return toHex(privateKeyFromFile(path, "L1 key file"));
}
