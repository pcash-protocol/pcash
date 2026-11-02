import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCli } from "../src/cli/cli.ts";
import { WalletHttpClient } from "../src/cli/client.ts";
import { onboardWallet, readWalletSeedFile, type WalletOnboardingTerminal } from "../src/cli/onboarding.ts";
import { validateWalletMnemonic } from "@pcash/sdk/wallet";

const MNEMONIC = `${"abandon ".repeat(23)}art`;

afterEach(() => vi.unstubAllGlobals());

function localClient() {
  return {
    preflightOnboarding: vi.fn(async () => undefined),
    importMnemonic: vi.fn(async (_mnemonic: string) => ({ address: "0x1234" })),
  };
}

function terminal(readSecret: WalletOnboardingTerminal["readSecret"], interactive = true): WalletOnboardingTerminal {
  return { interactive, write: vi.fn(), readSecret };
}

describe("seed wallet onboarding", () => {
  it("imports a newly generated phrase only after confirming three distinct word positions", async () => {
    const client = localClient();
    let display = "";
    let confirmed = "";
    const positions: number[] = [];
    const io = terminal(async (question) => {
      expect(client.importMnemonic).not.toHaveBeenCalled();
      const words = [...display.matchAll(/^\d+\. (\w+)$/gm)].map((match) => match[1]!);
      confirmed = words.join(" ");
      expect(validateWalletMnemonic(confirmed)).toBe(true);
      const match = /^Enter recovery word #(\d+): $/.exec(question);
      expect(match).not.toBeNull();
      const position = Number(match![1]);
      expect(position).toBeGreaterThanOrEqual(1);
      expect(position).toBeLessThanOrEqual(24);
      positions.push(position);
      return ` ${words[position - 1]!.toUpperCase()} `;
    });
    io.write = (value) => { display += value; };
    const result = await onboardWallet(parseCli(["wallet", "create"], {}), client, io);
    expect(client.importMnemonic.mock.calls).toEqual([[confirmed]]);
    expect(positions).toHaveLength(3);
    expect(new Set(positions).size).toBe(3);
    expect(result).toEqual({ address: "0x1234" });
    expect(JSON.stringify(result)).not.toContain(confirmed);
  });

  it("retries the same backup position without generating another phrase", async () => {
    const client = localClient();
    let display = "";
    let attempts = 0;
    const positions: number[] = [];
    const io = terminal(async question => {
      const position = Number(/#(\d+):/.exec(question)![1]);
      positions.push(position);
      const words = [...display.matchAll(/^\d+\. (\w+)$/gm)].map(match => match[1]!);
      return attempts++ === 0 ? "notaword" : words[position - 1]!;
    });
    io.write = value => { display += value; };
    await onboardWallet(parseCli(["wallet", "create"], {}), client, io);
    expect(positions).toHaveLength(4);
    expect(positions[0]).toBe(positions[1]);
    expect(display.match(/1\. /g)).toHaveLength(3); // word positions 1, 11 and 21, displayed once
    expect(client.importMnemonic).toHaveBeenCalledOnce();
  });

  it("cancels without importing and preflights before displaying any words", async () => {
    const client = localClient();
    const io = terminal(async () => { throw new Error("secret input canceled"); });
    await expect(onboardWallet(parseCli(["wallet", "create"], {}), client, io)).rejects.toThrow("canceled");
    expect(client.preflightOnboarding).toHaveBeenCalledOnce();
    expect(client.importMnemonic).not.toHaveBeenCalled();
  });

  it.each(["create", "import"])("does not request secrets when %s preflight fails", async subcommand => {
    const client = localClient();
    client.preflightOnboarding.mockRejectedValue(new Error("unauthorized"));
    const io = terminal(vi.fn());
    await expect(onboardWallet(parseCli(["wallet", subcommand], {}), client, io)).rejects.toThrow("unauthorized");
    expect(io.write).not.toHaveBeenCalled();
    expect(io.readSecret).not.toHaveBeenCalled();
    expect(client.importMnemonic).not.toHaveBeenCalled();
  });

  it("does not expose a generated phrase to redirected output", async () => {
    const client = localClient();
    const io = terminal(vi.fn(), false);
    await expect(onboardWallet(parseCli(["wallet", "create", "--json"], {}), client, io))
      .rejects.toThrow("interactive terminal");
    expect(io.write).not.toHaveBeenCalled();
    expect(io.readSecret).not.toHaveBeenCalled();
    expect(client.importMnemonic).not.toHaveBeenCalled();
  });

  it("normalizes a hidden recovery input without echoing it", async () => {
    const client = localClient();
    const io = terminal(async () => `  ${MNEMONIC.toUpperCase().replaceAll(" ", "\n")}  `);
    await onboardWallet(parseCli(["wallet", "import"], {}), client, io);
    expect(client.importMnemonic.mock.calls).toEqual([[MNEMONIC]]);
    expect(io.write).not.toHaveBeenCalled();
  });

  it("rejects invalid recovery input without sending or printing it", async () => {
    const client = localClient();
    const io = terminal(async () => "private invalid recovery input");
    await expect(onboardWallet(parseCli(["wallet", "import"], {}), client, io))
      .rejects.toThrow("valid 24-word English BIP-39 mnemonic");
    expect(client.importMnemonic).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });

  it("reads a private seed file locally for noninteractive recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pcash-wallet-onboarding-"));
    const path = join(directory, "seed.txt");
    await writeFile(path, `${MNEMONIC}\n`, { mode: 0o600 });
    const client = localClient();
    const io = terminal(vi.fn(), false);
    await onboardWallet(parseCli(["wallet", "import", "--seed-file", path], {}), client, io);
    expect(client.importMnemonic.mock.calls).toEqual([[MNEMONIC]]);
    expect(io.write).not.toHaveBeenCalled();
    expect(io.readSecret).not.toHaveBeenCalled();
  });

  it("rejects readable-by-others and symlink seed files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pcash-wallet-onboarding-"));
    const exposed = join(directory, "exposed.txt");
    await writeFile(exposed, MNEMONIC, { mode: 0o644 });
    await expect(readWalletSeedFile(exposed)).rejects.toThrow("private");
    const privateFile = join(directory, "private.txt");
    await writeFile(privateFile, MNEMONIC, { mode: 0o600 });
    const link = join(directory, "link.txt");
    await symlink(privateFile, link);
    await expect(readWalletSeedFile(link)).rejects.toThrow();
  });

  it("does not accept piped recovery material without an explicit private file", async () => {
    const client = localClient();
    const io = terminal(vi.fn(), false);
    await expect(onboardWallet(parseCli(["wallet", "import"], {}), client, io))
      .rejects.toThrow("--seed-file");
    expect(client.importMnemonic).not.toHaveBeenCalled();
  });
});

describe("seed import transport", () => {
  it("refuses nonlocal and unauthenticated endpoints before asking for secrets", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const url of ["http://wallet.test", "http://localhost.evil.test", "http://127.0.0.1@example.test", "file:///seed", "http://127.0.0.1/?redirect=remote"]) {
      const io = terminal(vi.fn());
      await expect(onboardWallet(parseCli(["wallet", "create"], {}), new WalletHttpClient(url, "token"), io))
        .rejects.toThrow("loopback");
      expect(io.write).not.toHaveBeenCalled();
      expect(io.readSecret).not.toHaveBeenCalled();
    }
    await expect(new WalletHttpClient("http://127.0.0.1:8745").importMnemonic(MNEMONIC))
      .rejects.toThrow("PCASH_WALLET_TOKEN");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the phrase to the authenticated local service without following redirects", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ address: "0x1234" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await new WalletHttpClient("http://127.0.0.1:8745", "token").importMnemonic(MNEMONIC);
    expect(fetch.mock.calls).toEqual([["http://127.0.0.1:8745/wallets/import", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
      redirect: "error",
      body: JSON.stringify({ mnemonic: MNEMONIC }),
    }]]);
  });
});
