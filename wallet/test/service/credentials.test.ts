import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openKeystore,
  parsePrivateKeyFile,
  writeSecureFile,
} from "../../src/service/credentials.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pcash-wallet-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("wallet credentials", () => {
  it("requires a 32-byte private key", () => {
    const path = join(temporaryDirectory(), "key.json");
    writeFileSync(path, JSON.stringify({ privateKey: `0x${"11".repeat(31)}` }), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(() => parsePrivateKeyFile(path)).toThrow(/32-byte/);
  });

  it("atomically replaces a symlink instead of following it", () => {
    const directory = temporaryDirectory();
    const target = join(directory, "target");
    const path = join(directory, "keystore.json");
    writeFileSync(target, "do not replace", { mode: 0o600 });
    symlinkSync(target, path);

    writeSecureFile(path, "new keystore");

    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("new keystore");
    expect(readFileSync(target, "utf8")).toBe("do not replace");
  });

  it("rejects the plaintext keystore format", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "keystore.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      wallets: [{ address: "0x1234", privateKey: "0x12" }],
    }), { mode: 0o600 });
    chmodSync(path, 0o600);
    await expect(openKeystore(directory, "test password")).rejects.toThrow(/unsupported wallet vault format/);
  });
});
