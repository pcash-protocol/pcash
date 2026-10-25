import type { Cli } from "./cli.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown): string => value === undefined || value === null ? "—" : String(value);
const label = (key: string): string => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase());
const shell = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function balances(value: unknown): string {
  const rows = Array.isArray(value) ? value : [];
  if (rows.length === 0) return "No balances. Amounts are atomic units.";
  const cells = [["Asset", "Private (atomic units)", "Spendable (atomic units)"], ...rows.map(item => {
    const row = object(item);
    return [row.assetId === "0" || row.assetId === 0n || row.assetId === 0 ? "PCASH" : text(row.assetId), text(row.private), text(row.spendable)];
  })];
  const widths = cells[0]!.map((_, index) => Math.max(...cells.map(row => row[index]!.length)));
  return cells.map(row => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd()).join("\n");
}

/** Advanced results remain readable without imposing a second response schema. */
function details(value: unknown, indent = ""): string {
  if (Array.isArray(value)) return value.length ? value.map(item => `${indent}- ${details(item, indent + "  ").trimStart()}`).join("\n") : `${indent}None`;
  if (value === null || typeof value !== "object") return indent + text(value);
  return Object.entries(value).map(([key, item]) => item !== null && typeof item === "object"
    ? `${indent}${label(key)}:\n${details(item, indent + "  ")}`
    : `${indent}${label(key)}: ${text(item)}`).join("\n");
}

export function renderResult(cli: Cli, value: unknown): string {
  const result = object(value);
  if (cli.command === "receive") return text(result.extendedCode);
  if (cli.command === "balance") return balances(result.balances);
  if (cli.command === "status") {
    const scan = object(result.scan), network = object(result.network);
    return [
      `Wallet: ${text(result.address)}`,
      `PCASH chain: ${text(network.chainId)}`,
      `Genesis: ${text(network.genesisHash)}`,
      `Sync: ${scan.caughtUp === true ? "caught up" : "catching up"} (wallet ${text(object(scan.syncedThrough).pcashNumber)}, node ${text(object(scan.nodeTip).pcashNumber)})`,
      `Finalized through: ${text(object(result.finalizedThrough).pcashNumber)}`,
      `Pending actions: ${text(result.pendingActionCount)}`,
      "", balances(result.balances),
    ].join("\n");
  }
  if (cli.command === "wallet") {
    if (cli.subcommand === "list") {
      const wallets = value as { address: string }[];
      return wallets.length ? ["Loaded wallets:", ...wallets.map(wallet => `  ${wallet.address}`), ...(wallets.length > 1 ? ["Select one with --wallet <address>."] : [])].join("\n")
        : "No wallets loaded. Run pcash-wallet-cli wallet create or pcash-wallet-cli wallet import.";
    }
    const connection = ` --wallet-url ${shell(cli.url)} --data-dir ${shell(cli.dataDir)}`;
    return [
      `Wallet ready locally: ${text(result.address)}`,
      `Ethereum funding address: ${text(result.ethereumFundingAddress)}`,
      `L1 chain ID: ${text(result.l1ChainId)}`,
      `PCASH chain ID: ${text(result.pcashChainId)}`,
      "ETH pays Ethereum publication costs. PCASH is the private payment asset.",
      "To register or update this account, fund the Ethereum address if needed, then run:",
      `  pcash-wallet-cli account ensure --wallet ${text(result.address)}${connection}`,
      "Registration requires the server's --l1-rpc. For an arranged sponsor, explicitly use --submit mempool.",
    ].join("\n");
  }
  if (cli.command === "sync") return `Synchronized through block ${text(object(result.syncedThrough).pcashNumber)}.\nRecovered notes: ${text(result.recoveredCount)}\nSpendable PCASH (atomic units): ${text(object(result.wallet).spendable)}`;
  if (cli.command === "send" || cli.command === "account" || (cli.command === "asset" && ["create", "send", "burn"].includes(cli.subcommand!))) {
    const submission = object(result.submit), receipt = object(submission.pcashReceipt ?? result.receipt);
    const outcome = result.accepted === true ? (submission.finalized === true ? "Finalized" : "Accepted")
      : result.queued === true ? "Queued; acceptance has not been observed" : text(result.state ?? "Completed; acceptance has not been reported");
    return [
      outcome,
      `Publication: ${text(result.path ?? submission.path)}`,
      ...["contentHash", "transactionId", "l1TxHash", "assetId"].flatMap(key => {
        const found = result[key] ?? submission[key] ?? receipt[key];
        return found === undefined ? [] : [`${label(key)}: ${text(found)}`];
      }),
      ...(cli.command === "send" ? [`Amount (atomic units): ${cli.amount}`, ...(cli.fee === undefined ? [] : [`Requested public fee (atomic units): ${cli.fee}`])] : []),
      ...(cli.command === "account" && result.accepted === true ? ["Next: pcash-wallet-cli receive (use the same connection and --wallet options)."] : []),
    ].join("\n");
  }
  return details(value);
}
