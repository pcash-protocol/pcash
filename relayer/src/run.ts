import { openNodeWallet, openMemoryNodeWallet } from "@pcash/wallet";
import { derivePcashProfileFromPrivateKey, type Wallet } from "@pcash/sdk/wallet";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { networkConfigFromStatus } from "@pcash/sdk/protocol";
import { fromHexSized } from "@pcash/sdk/utils";
import { stringify } from "viem";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PcashNodeClient } from "@pcash/sdk/clients";
import {
  FileRelayJournal,
  MemoryRelayJournal,
  PrivateKeyRelaySubmitter,
} from "@pcash/sdk/node";
import { Relayer } from "@pcash/sdk/relay";
import { Logger } from "@pcash/sdk/blgr";
import { parseRelayerArgs, USAGE, type RelayerCliOptions } from "./args.ts";
import {
  RawBatchInputError,
  rawBatchExitCode,
  readRawTransactionBatch,
  submitRawTransactionBatch,
} from "./exactBatch.ts";
import { serveRelayer } from "./service.ts";

export const DEV_MODE_WARNING = `
================================================================================
= WARNING: PCASH RELAYER DEVELOPMENT MODE IS ON                              =
= ANVIL ACCOUNT 1 IS THE DEFAULT SIGNER; THE RELAY JOURNAL IS IN MEMORY.     =
= ALL RELAYER SERVICE STATE WILL BE LOST ON EXIT.                            =
================================================================================`;

export const DEV_ANVIL_RELAYER_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export function resolveRelayerPrivateKey(key: string | undefined, dev: boolean): string {
  const value = key?.trim() || (dev ? DEV_ANVIL_RELAYER_PRIVATE_KEY : undefined);
  if (!value) throw new Error("no relayer signing key: set PCASH_RELAYER_L1_KEY");
  const body = value.trim().replace(/^0[xX]/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(body)) throw new Error("relayer signing key must be 32-byte hex");
  return `0x${body}`;
}

export async function runRelayerCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let options: RelayerCliOptions;
  try { options = parseRelayerArgs(argv, env); } catch (error) {
    const logger = new Logger("info");
    await logger.open();
    logger.error(`pcash-relayer: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const logger = new Logger({ level: options.logLevel, filename: options.logFile });
  await logger.open();
  try {
    return await runCommand(options, logger);
  } finally {
    await logger.close();
  }
}

async function runCommand(options: RelayerCliOptions, logger: Logger): Promise<number> {
  if (options.command.kind === "help") { logger.raw(USAGE); return 0; }
  if (options.command.kind === "version") { logger.raw("pcash-relayer 0.0.0"); return 0; }
  if (options.dev) logger.warning(DEV_MODE_WARNING);
  const journal = options.dev
    ? new MemoryRelayJournal()
    : new FileRelayJournal(options.journalPath);
  if (options.command.kind === "journal-show") {
    logger.raw(JSON.stringify(await journal.read(), null, 2));
    return 0;
  }

  let rawBatchTransactions: string[] | undefined;
  if (options.command.kind === "submit-batch") {
    try {
      rawBatchTransactions = await readRawTransactionBatch(options.command.inputPath);
    } catch (error) {
      logger.error(`pcash-relayer: ${(error as Error).message}`);
      return 2;
    }
  }

  let privateKey: string;
  try { privateKey = resolveRelayerPrivateKey(options.l1Key, options.dev); } catch (error) {
    logger.error(`pcash-relayer: ${(error as Error).message}`);
    return 2;
  }
  const privateKeyBytes = fromHexSized(privateKey, 32, "relayer key");
  if (!options.dev) mkdirSync(dirname(options.journalPath), { recursive: true, mode: 0o700 });
  const node = new PcashNodeClient(options.rpcUrl);
  const submitter = new PrivateKeyRelaySubmitter({
    privateKey,
    rpcUrl: options.l1Rpc,
    node,
    journal,
    receiptTimeoutMs: options.receiptTimeoutMs,
    ...(options.receiptPollMs === undefined ? {} : { receiptPollMs: options.receiptPollMs }),
    observationTimeoutMs: options.observationTimeoutMs,
    observationPollMs: options.observationPollMs,
    ...(options.maxFeePerGas === undefined ? {} : { maxFeePerGas: options.maxFeePerGas }),
    ...(options.gasLimit === undefined ? {} : { gasLimit: options.gasLimit }),
  });
  const payoutRecipient = (status: Awaited<ReturnType<PcashNodeClient["status"]>>) => derivePcashProfileFromPrivateKey(privateKeyBytes, networkConfigFromStatus(status));
  const relayer = new Relayer({
    node,
    payoutRecipient: async (status) => payoutRecipient(status),
    submitterFor: () => submitter,
    maxPages: options.maxPages,
    nodeRpcTimeoutMs: options.nodeRpcTimeoutMs,
    minValuePerByte: options.minValuePerByte,
    minPrivateFee: options.selectedMinPrivateFee,
    sponsorUnpaid: options.sponsorUnpaid,
    issuanceHaircutBps: options.issuanceHaircutBps,
    maxTransactions: options.maxTransactions,
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
  });
  let feeWallet: Wallet | undefined;
  try {
    if (options.command.kind === "submit-batch") {
      let result: Awaited<ReturnType<typeof submitRawTransactionBatch>>;
      try {
        result = await submitRawTransactionBatch({
          transactions: rawBatchTransactions!, payoutRecipient, node, submitter,
          daMode: options.daMode, maxBatchBytes: options.maxBatchBytes, maxTransactions: options.maxTransactions,
        });
      } catch (error) {
        if (!(error instanceof RawBatchInputError)) throw error;
        logger.error(`pcash-relayer: ${error.message}`);
        return 2;
      }
      logger.raw(stringify(result, null, 2));
      return rawBatchExitCode(result);
    }
    if (options.command.kind === "relay") {
      const result = await relayer.relay({
        contentHashes: options.command.contentHashes,
        daMode: options.daMode,
        maxBatchBytes: options.maxBatchBytes,
      });
      if (result.txHash !== undefined) {
        logger.raw(`relayed ${result.selectedContentHashes.length} transactions in ${result.txHash}`);
      } else {
        logger.raw(`no relay submitted; considered ${result.considered} transactions, ${result.rejected.length} rejected`);
        for (const rejected of result.rejected) logger.raw(`  rejected ${rejected.contentHash}: ${rejected.reason}`);
      }
      return 0;
    }
    const status = await node.status();
    const profile = payoutRecipient(status);
    const walletOptions = { node, profile };
    feeWallet = options.dev ? await openMemoryNodeWallet(walletOptions) : await openNodeWallet({ ...walletOptions, dataDir: join(dirname(options.journalPath), "fee-wallet") });
    const observeFees = async () => {
      await feeWallet!.sync();
      const funds = await feeWallet!.nativeFunds();
      return { owner: feeWallet!.address, balance: funds.private.toString(), spendable: funds.spendablePrivate.toString(),
        noteCount: (await feeWallet!.notes({ assetId: 0n, status: "spendable" })).length,
        blockNumber: funds.pcashNumber.toString(), blockHash: funds.pcashHash };
    };
    if (options.command.kind === "wallet-status") {
      logger.raw(JSON.stringify(await observeFees(), null, 2)); return 0;
    }
    if (options.command.kind === "serve") {
      await serveRelayer({ options, relayer, submitter, journal, observeFees, logger: logger.context("relayer"),
        selected: { node, profile,
          signer: privateKeyPcashActionSigner(privateKeyBytes),
          minPrivateFee: options.selectedMinPrivateFee, minValuePerByte: options.minValuePerByte,
          maxQuoteLifetimeSeconds: options.selectedMaxQuoteLifetimeSeconds } });
      return 0;
    }
    const exhaustive: never = options.command;
    return exhaustive;
  } catch (error) {
    logger.error(`pcash-relayer: ${(error as Error).message}`);
    return 1;
  } finally {
    await feeWallet?.close();
  }
}
