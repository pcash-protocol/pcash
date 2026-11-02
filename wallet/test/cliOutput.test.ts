import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCli } from "../src/cli/cli.ts";
import { renderResult } from "../src/cli/output.ts";
import { runWalletCli } from "../src/cli/run.ts";
import { selectServedWallet } from "../src/service/serve.ts";

const tx = `0x${"ab".repeat(32)}`;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const cli = (args: string[]) => parseCli(args, {});

function capture() {
  let stdout = "", stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => { stderr += String(chunk); return true; });
  return { stdout: () => stdout, stderr: () => stderr };
}
const connection = ["--wallet-url", "http://127.0.0.1:8745", "--wallet-token", "test"];

describe("human-readable wallet results", () => {
  it("shows balances with exact integer amounts and clear units", () => {
    const output = renderResult(cli(["balance"]), { balances: [
      { assetId: "0", private: "10000000000000000000001", spendable: "7" },
      { assetId: "12", private: "9", spendable: "8" },
    ] });
    expect(output).toContain("Spendable (atomic units)");
    expect(output).toContain("Private (atomic units)");
    expect(output).toContain("10000000000000000000001");
    expect(output).toContain("PCASH");
    expect(output).not.toContain("{");
  });

  it("prints a complete receive code without decoration", () => {
    expect(renderResult(cli(["receive"]), { extendedCode: "pcash:complete-code" })).toBe("pcash:complete-code");
  });

  it("reports observed finality, never merely the requested wait mode", () => {
    const request = cli(["send", "--to", "code", "--amount", "10", "--wait", "finalized"]);
    expect(renderResult(request, { accepted: true, contentHash: tx, submit: { path: "l1" } })).toMatch(/^Accepted\n/);
    expect(renderResult(request, { accepted: true, contentHash: tx, submit: { path: "l1", finalized: true } })).toMatch(/^Finalized\n/);
    expect(renderResult(request, { queued: true, contentHash: tx, path: "mempool" })).toContain("Queued; acceptance has not been observed");
    expect(renderResult(request, { queued: true, contentHash: tx })).toContain(tx);
  });

  it("provides explicit funding and account instructions after onboarding", () => {
    const output = renderResult(cli(["wallet", "create"]), {
      address: "0xwallet", ethereumFundingAddress: "0xgas", l1ChainId: "1", pcashChainId: "2",
    });
    expect(output).toContain("Ethereum funding address: 0xgas");
    expect(output).toContain("L1 chain ID: 1");
    expect(output).toContain("ETH pays Ethereum publication costs");
    expect(output).toContain("pcash-wallet-cli account ensure --wallet 0xwallet");
  });

  it("gives Tor-mode onboarding with no Ethereum funding step", () => {
    const output = renderResult(cli(["wallet", "create"]), {
      address: "0xwallet", networkPrivacy: "tor", l1ChainId: "1", pcashChainId: "2",
    });
    expect(output).toContain("through Tor");
    expect(output).not.toContain("Ethereum funding address");
    expect(output).not.toContain("--l1-rpc");
    expect(output).toContain("pcash-wallet-cli account ensure --wallet 0xwallet");
    expect(output).not.toContain("Service gas account");
    expect(renderResult(cli(["wallet", "create"]), {
      address: "0xwallet", networkPrivacy: "tor", serviceGasAddress: "0xgas", l1ChainId: "1", pcashChainId: "2",
    })).toMatch(/Service gas account \(publishes to L1 only when asked\): 0xgas\nIts L1 transactions are public and linked/);
  });

  it("lists candidates when wallet selection is ambiguous", () => {
    expect(() => selectServedWallet(new Map(), undefined)).toThrow("pcash-wallet-cli wallet create");
    const wallets = new Map([["0xfirst", {}], ["0xsecond", {}]]);
    expect(() => selectServedWallet(wallets, undefined)).toThrow("0xfirst, 0xsecond");
    expect(() => selectServedWallet(wallets, undefined)).toThrow("--wallet <address>");
  });
});

describe("CLI process output", () => {
  it("keeps successful JSON alone on stdout", async () => {
    const io = capture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ address: "0xabc", balances: [] }))));
    expect(await runWalletCli(["balance", ...connection, "--json"])).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual({ address: "0xabc", balances: [] });
    expect(io.stderr()).toBe("");
  });

  it("prints structured usage errors to stderr with exit code 2", async () => {
    const io = capture();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await runWalletCli(["send", "--json"])).toBe(2);
    expect(JSON.parse(io.stderr())).toEqual({ error: "send requires --to" });
    expect(io.stdout()).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves uncertain content hashes in JSON errors and never retries", async () => {
    const io = capture();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "submission observation failed", contentHash: tx }), { status: 502 }));
    vi.stubGlobal("fetch", fetch);
    expect(await runWalletCli(["send", "--to", "code", "--amount", "1", ...connection, "--json"])).toBe(1);
    expect(JSON.parse(io.stderr())).toMatchObject({ error: "submission observation failed", contentHash: tx, status: 502, hint: expect.stringContaining("before retrying") });
    expect(io.stdout()).toBe("");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("explains unreachable services and wrong credentials", async () => {
    const io = capture();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await runWalletCli(["status", ...connection])).toBe(1);
    expect(io.stderr()).toContain("Start pcash-wallet");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })));
    expect(await runWalletCli(["status", ...connection])).toBe(1);
    expect(io.stderr()).toContain("same PCASH_WALLET_TOKEN");
  });

  it("resolves nested help without requiring operands or making a request", async () => {
    const io = capture();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await runWalletCli(["help", "asset", "send"])).toBe(0);
    expect(io.stdout()).toContain("Usage: pcash-wallet-cli asset send");
    expect(io.stdout()).toContain("--asset-id");
    expect(io.stdout()).not.toContain("--seed-file");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { tty: true, json: false, progress: true },
    { tty: true, json: true, progress: false },
    { tty: false, json: false, progress: false },
  ])("only shows elapsed time for interactive text requests ($tty/$json)", async ({ tty, json, progress }) => {
    const io = capture();
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: tty, configurable: true });
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    try {
      const running = runWalletCli(["wallet", "list", ...connection, ...(json ? ["--json"] : [])]);
      await vi.advanceTimersByTimeAsync(4000);
      expect(io.stderr().includes("4s elapsed")).toBe(progress);
      expect(io.stdout()).toBe("");
      finish(new Response("[]"));
      expect(await running).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      if (!progress) expect(io.stderr()).toBe("");
    } finally {
      vi.useRealTimers();
      if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY); else Reflect.deleteProperty(process.stdin, "isTTY");
      if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY); else Reflect.deleteProperty(process.stderr, "isTTY");
    }
  });
});
