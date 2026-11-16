import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { derivePcashProfileFromPrivateKey, deriveSeedWalletIdentity, validateWalletMnemonic } from "@pcash/sdk/wallet";
import { parseServeArgs, startWalletServer } from "@pcash/wallet";
import { receiveKeyHash } from "@pcash/sdk/protocol";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { parseJsonOutput, runSuccessfulCommand } from "../framework/command.ts";
import { eventually } from "../framework/eventually.ts";
import { logger } from "../framework/logger.ts";
import { setupUserWallets } from "./setup.ts";

interface WalletImportResult { address: string }
type WalletServer = Awaited<ReturnType<typeof startWalletServer>>;
interface WalletActionResult { contentHash: string; accepted: boolean; path: string }
interface WalletScanResult { wallet: { balance: string } }
interface ReceiveCode { address: string; extendedCode: string }
interface OnboardingTerminal {
  interactive: boolean;
  write(text: string): void;
  readSecret(question: string): Promise<string>;
}
interface OnboardingClient {
  assertSeedImportAvailable(): void;
  importMnemonic(mnemonic: string): Promise<unknown>;
}

/** Load the installed CLI implementation without adding a public testing API. */
async function onboardingModules() {
  const packageUrl = import.meta.resolve("@pcash/wallet/package.json");
  const [parser, transport, onboarding] = await Promise.all([
    import(new URL("dist/cli/cli.js", packageUrl).href) as Promise<{ parseCli(argv: readonly string[], env: NodeJS.ProcessEnv): unknown }>,
    import(new URL("dist/cli/client.js", packageUrl).href) as Promise<{ WalletHttpClient: new (url: string, token: string) => OnboardingClient }>,
    import(new URL("dist/cli/onboarding.js", packageUrl).href) as Promise<{
      onboardWallet(cli: unknown, client: OnboardingClient, terminal: OnboardingTerminal): Promise<unknown>;
    }>,
  ]);
  return { ...parser, ...transport, ...onboarding,
    executable: fileURLToPath(new URL("dist/cli/bin.js", packageUrl)) };
}

/** Real service, native proofs and local L1 acceptance; only terminal responses are scripted. */
export async function runSeedWalletScenario(fixture: ScenarioFixture): Promise<void> {
  assert.ok(fixture.backend.anvil, "seed-wallet requires the local Anvil stack");
  const cli = await onboardingModules();
  const log = logger.context("seed-wallet");
  const token = randomBytes(32).toString("hex");
  const originalPassword = randomBytes(32).toString("hex");
  const restoredPassword = randomBytes(32).toString("hex");
  const originalDirectory = fixture.artifacts.path("seed-wallet-original");
  const restoredDirectory = fixture.artifacts.path("seed-wallet-restored");
  let service: WalletServer | undefined;
  let mnemonic = "";

  const start = async (dataDir: string, password: string, withL1: boolean) => {
    service = await startWalletServer(parseServeArgs([
      "--listen", "127.0.0.1:0", "--rpc-url", fixture.nodeA.rpcUrl,
      "--data-dir", dataDir, "--prover", "native", "--scan-interval-ms", "250",
      ...(withL1 ? ["--l1-rpc", fixture.backend.rpcUrl] : []),
    ], { PCASH_WALLET_TOKEN: token, PCASH_WALLET_PASSWORD: password }), log);
  };
  const stop = async () => {
    const running = service;
    service = undefined;
    await running?.close();
  };
  const runCli = async <T>(args: readonly string[]): Promise<T> => {
    assert.ok(service, "wallet service is not running");
    const result = await runSuccessfulCommand(process.execPath, [cli.executable, ...args, "--json"], {
      cwd: fixture.repoRoot,
      env: { ...process.env, PCASH_WALLET_URL: service.url, PCASH_WALLET_TOKEN: token },
      timeoutMs: 20 * 60_000,
    });
    return parseJsonOutput<T>(result);
  };
  const waitBalance = async (amount: bigint, label: string) => eventually(
    label,
    async () => BigInt((await runCli<WalletScanResult>(["sync"])).wallet.balance),
    (balance) => balance === amount,
    { timeoutMs: 3 * 60_000, intervalMs: 500 },
  );
  const send = async (to: string, amount: bigint, label: string) => {
    log.info(`${label}: generating a native proof and submitting through the mempool`);
    fixture.harness.startAutoRelay();
    try {
      const result = await runCli<WalletActionResult>(["send", "--to", to, "--amount", amount.toString(), "--fee", "1"]);
      assert.equal(result.accepted, true, `${label} was not accepted`);
      assert.equal(result.path, "mempool", `${label} did not use the default mempool route`);
      const accepted = await fixture.waitForAcceptedAcrossNodes(result.contentHash, label);
      assert.equal(accepted.nodeA.kind, "privateValue");
      return result.contentHash;
    } finally {
      await fixture.harness.stopAutoRelay();
    }
  };

  try {
    log.info("creating a seed wallet through production CLI onboarding with a scripted terminal");
    await start(originalDirectory, originalPassword, true);
    const words = new Map<number, string>();
    const challenges: number[] = [];
    const created = await cli.onboardWallet(cli.parseCli(["wallet", "create"], {}), new cli.WalletHttpClient(service!.url, token), {
      interactive: true,
      write(text) {
        for (const match of text.matchAll(/^(\d+)\. ([a-z]+)$/gm)) words.set(Number(match[1]), match[2]!);
      },
      async readSecret(question) {
        const match = /^Enter recovery word #(\d+): $/.exec(question);
        assert.ok(match, "CLI creation requested an unexpected prompt");
        const position = Number(match[1]);
        const word = words.get(position);
        assert.ok(word, "CLI challenged a word it did not display");
        challenges.push(position);
        return word;
      },
    }) as WalletImportResult;
    assert.equal(words.size, 24);
    assert.equal(challenges.length, 3);
    assert.equal(new Set(challenges).size, 3);
    mnemonic = Array.from({ length: 24 }, (_, index) => words.get(index + 1)!).join(" ");
    words.clear();
    assert.ok(validateWalletMnemonic(mnemonic), "CLI did not generate a valid recovery phrase");
    const identity = deriveSeedWalletIdentity(mnemonic, fixture.network);
    try {
      assert.equal(created.address, `0x${identity.profile.address.toString(16).padStart(40, "0")}`);
      const ethereumDerived = derivePcashProfileFromPrivateKey(identity.privateKey, fixture.network);
      assert.notEqual(receiveKeyHash(identity.profile.mlKemPublicKey), receiveKeyHash(ethereumDerived.mlKemPublicKey),
        "seed-wallet delivery key came from the Ethereum signing key");
    } finally {
      identity.privateKey.fill(0);
    }

    log.info("funding the wallet's Ethereum address and registering with only --l1-rpc configured");
    await fixture.fundL1Gas(created.address, 2);
    const registration = await runCli<WalletActionResult>(["account", "ensure"]);
    assert.equal(registration.accepted, true);
    assert.equal(registration.path, "l1");
    const registered = await fixture.waitForAcceptedAcrossNodes(registration.contentHash, "seed-wallet-registration");
    const registrationTransaction = await fixture.nodeA.client.getTransaction(registered.nodeA.transactionId);
    assert.equal(registrationTransaction?.summary.l1Sender.toLowerCase(), created.address,
      "registration did not use the seed wallet's funded Ethereum account");
    const account = await fixture.nodeA.client.getAccountProof(created.address);
    assert.equal(account.status, "present");
    if (account.status !== "present") throw new Error("registered seed account is unavailable");
    assert.equal(BigInt(account.account.receiveKeyHash), receiveKeyHash(identity.profile.mlKemPublicKey));
    const code = await runCli<ReceiveCode>(["receive"]);
    assert.equal(code.address, created.address);

    const initial = await setupUserWallets(fixture, { actors: ["website"], accounts: ["website"], funded: ["website"] });
    const website = fixture.actors.website!;
    assert.equal(website.wallet.recoveryContract, "ethereum-signature-derived");
    const receivedAmount = 100n;
    const firstSpend = 23n;
    const restoredSpend = 11n;
    assert.ok(initial.website! > receivedAmount + 1n, "website actor did not earn enough PCASH");
    log.info("receiving a proved payment from an Ethereum-signature-derived website profile");
    const received = await (await website.client()).send({ to: code.extendedCode, amount: receivedAmount, openFeeAmount: 1n });
    await fixture.waitForAcceptedAcrossNodes(received.contentHash, "website-to-seed-wallet");
    await waitBalance(receivedAmount, "seed wallet to scan its incoming payment");

    const spent = await send(website.address, firstSpend, "seed-wallet-spend");
    const remaining = receivedAmount - firstSpend - 1n;
    await waitBalance(remaining, "seed wallet to scan its change");
    log.info("restarting the encrypted service without any L1 configuration");
    await stop();
    await start(originalDirectory, originalPassword, false);
    assert.equal((await runCli<ReceiveCode>(["receive"])).extendedCode, code.extendedCode);
    await waitBalance(remaining, "restarted seed wallet to recover its inventory");
    await stop();

    log.info("restoring only the recovery phrase into a new directory with a different password");
    await start(restoredDirectory, restoredPassword, false);
    const restored = await cli.onboardWallet(cli.parseCli(["wallet", "import"], {}), new cli.WalletHttpClient(service!.url, token), {
      interactive: true,
      write() { throw new Error("recovery unexpectedly displayed secret material"); },
      async readSecret(question) {
        assert.equal(question, "Enter your 24-word recovery phrase: ");
        return mnemonic;
      },
    }) as WalletImportResult;
    assert.equal(restored.address, created.address);
    assert.equal((await runCli<ReceiveCode>(["receive"])).extendedCode, code.extendedCode);
    await waitBalance(remaining, "phrase-only restore to recover unspent change");
    const spentAfterRestore = await send(website.address, restoredSpend, "seed-wallet-restored-spend");
    await waitBalance(remaining - restoredSpend - 1n, "restored wallet to settle its new change");
    await eventually("website wallet to receive both seed-wallet payments", () => website.balance(),
      (balance) => balance === initial.website! - receivedAmount - 1n + firstSpend + restoredSpend,
      { timeoutMs: 3 * 60_000, intervalMs: 500 });
    fixture.artifacts.record("seed-wallet-complete", {
      onboarding: "production CLI onboarding with a scripted terminal; three random-word confirmations",
      operations: "installed CLI account/code/scan/transfer against the persistent wallet HTTP service",
      proofBackend: "native",
      websiteProfile: "ethereum-signature-derived",
      address: created.address,
      registration: registration.contentHash,
      incomingPayment: received.contentHash,
      outgoingPayment: spent,
      restoredPayment: spentAfterRestore,
      restartedWithoutL1Configuration: true,
      phraseOnlyRestoreIntoNewDirectory: true,
      restoredWithDifferentPassword: true,
      finalBalance: remaining - restoredSpend - 1n,
    });
  } finally {
    mnemonic = "";
    await fixture.harness.stopAutoRelay();
    await stop();
  }
}
