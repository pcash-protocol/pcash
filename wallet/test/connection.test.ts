import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatedWalletToken, readWalletConnection, resolveWalletConnection, saveWalletConnection } from "../src/connection.ts";
import { parseCli } from "../src/cli/cli.ts";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "wallet-connection-")); directories.push(path); return path; }
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const url = "http://127.0.0.1:9854";

describe("local wallet connection configuration", () => {
  it("creates a private token, publishes only after saving, and reuses it on restart", () => {
    const root = directory(), dataDir = join(root, "wallet");
    const token = generatedWalletToken(dataDir);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(readWalletConnection(dataDir)).toBeUndefined();
    saveWalletConnection(dataDir, { url, token });
    expect(lstatSync(dataDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(dataDir, "connection.json")).mode & 0o777).toBe(0o600);
    expect(generatedWalletToken(dataDir)).toBe(token);
    expect(readWalletConnection(dataDir)).toEqual({ url, token });
    saveWalletConnection(dataDir, { url: "http://127.0.0.1:9855", token });
    expect(readWalletConnection(dataDir)?.url).toBe("http://127.0.0.1:9855");
  });

  it("discovers a custom data directory and binds its token to the exact endpoint", () => {
    const dataDir = directory();
    saveWalletConnection(dataDir, { url, token: "saved" });
    const cli = parseCli(["status"], { PCASH_WALLET_DATA_DIR: dataDir });
    expect(resolveWalletConnection(cli)).toEqual({ url, token: "saved" });
    expect(resolveWalletConnection({ ...cli, url: `${url}/`, explicitUrl: true })).toEqual({ url: `${url}/`, token: "saved" });
    for (const target of ["https://example.com", "http://127.0.0.1:9856", `${url}/other`, `${url}/?x=1`, `${url}/#x`, "http://localhost:9854"]) {
      expect(resolveWalletConnection({ ...cli, url: target, explicitUrl: true })).toEqual({ url: target });
    }
    expect(parseCli(["status", "--data-dir", dataDir], { PCASH_WALLET_DATA_DIR: "/ignored" }).dataDir).toBe(dataDir);
  });

  it("honors explicit credentials without persisting them or requiring discovery", () => {
    const dataDir = directory();
    saveWalletConnection(dataDir, { url, token: "saved" });
    const cli = parseCli(["status", "--wallet-token", "flag"], { PCASH_WALLET_DATA_DIR: dataDir, PCASH_WALLET_TOKEN: "env" });
    expect(resolveWalletConnection(cli)).toEqual({ url, token: "flag" });
    expect(readFileSync(join(dataDir, "connection.json"), "utf8")).not.toContain("flag");
    const explicit = parseCli(["status", "--wallet-url", "http://other.test", "--wallet-token", "explicit"], { PCASH_WALLET_DATA_DIR: join(dataDir, "absent") });
    expect(resolveWalletConnection(explicit)).toEqual({ url: "http://other.test", token: "explicit" });
    expect(existsSync(join(dataDir, "absent"))).toBe(false);
  });

  it("does not create state when discovery finds nothing", () => {
    const dataDir = join(directory(), "absent");
    expect(resolveWalletConnection({ dataDir, url, explicitUrl: false })).toEqual({ url });
    expect(existsSync(dataDir)).toBe(false);
  });

  it("rejects symlink directories and files and readable-by-others configuration", () => {
    const root = directory(), dataDir = join(root, "wallet");
    generatedWalletToken(dataDir);
    const link = join(root, "link");
    symlinkSync(dataDir, link);
    expect(() => readWalletConnection(link)).toThrow(/symlink/);
    const outside = join(root, "outside");
    writeFileSync(outside, JSON.stringify({ url, token: "secret" }), { mode: 0o600 });
    symlinkSync(outside, join(dataDir, "connection.json"));
    expect(() => readWalletConnection(dataDir)).toThrow();
    expect(() => saveWalletConnection(dataDir, { url, token: "replacement" })).toThrow();
    expect(readFileSync(outside, "utf8")).not.toContain("replacement");
    rmSync(join(dataDir, "connection.json"));
    saveWalletConnection(dataDir, { url, token: "secret" });
    chmodSync(join(dataDir, "connection.json"), 0o644);
    expect(() => readWalletConnection(dataDir)).toThrow(/private/);
    chmodSync(join(dataDir, "connection.json"), 0o600);
    chmodSync(dataDir, 0o755);
    expect(() => readWalletConnection(dataDir)).toThrow(/private/);
  });

  it("rejects foreign ownership and nonlocal configuration endpoints", () => {
    const dataDir = directory();
    saveWalletConnection(dataDir, { url, token: "saved" });
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      const original = process.getuid;
      process.getuid = () => uid + 1;
      try { expect(() => readWalletConnection(dataDir)).toThrow(/owned by the current user/); }
      finally { process.getuid = original; }
    }
    writeFileSync(join(dataDir, "connection.json"), JSON.stringify({ url: "https://external.test", token: "secret" }));
    expect(() => readWalletConnection(dataDir)).toThrow(/loopback/);
  });
  it("does not expose credentials in malformed configuration diagnostics", () => {
    const dataDir = directory();
    writeFileSync(join(dataDir, "connection.json"), 'broken {"token":"secret-never-print"}', { mode: 0o600 });
    expect(() => readWalletConnection(dataDir)).toThrow(/invalid wallet connection configuration/);
    try { readWalletConnection(dataDir); } catch (error) { expect(String(error)).not.toContain("secret-never-print"); }
  });
});
