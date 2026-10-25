#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultNetwork, networks } from "./network_profile.mjs";
import { Config } from "../sdk/src/bcfg/index.ts";
import { Logger } from "../sdk/src/blgr/index.ts";

const logger = new Logger("info");
await logger.open();
// Operands come from the command line only, so an exported PCASH_CHAIN_ID can
// never prepare a second launch with the same ID; the L1 RPC is a setting.
const args = new Config("pcash");
args.load({ argv: true });
const OPTIONS = new Set(["chainid", "l1rpc", "inbox", "occupiedchainids", "output"]);
for (const key of Object.keys(args.args)) if (!OPTIONS.has(key)) throw new Error(`unknown option --${key}`);
if (args.argv.length > 0) throw new Error(`unexpected argument ${args.argv[0]}`);
const settings = new Config("pcash");
settings.load({ argv: true, env: true });
const pcashChainIdArg = args.str("chain-id");
const l1Rpc = settings.str("l1-rpc");
const inbox = args.str("inbox", defaultNetwork.inboxAddress);
const occupiedPcashChainIds = args.str("occupied-chain-ids", "");

if (!pcashChainIdArg || !l1Rpc) {
  throw new Error("Use --chain-id <unused PCASH ID> and configure PCASH_L1_RPC.");
}
const pcashChainId = BigInt(pcashChainIdArg);
if (pcashChainId <= 0n || pcashChainId >= (1n << 32n)) throw new Error("PCASH chain ID must fit nonzero uint32.");
const occupied = [...Object.values(networks).map((network) => network.pcashChainId), ...occupiedPcashChainIds.split(",").filter(Boolean)].map(BigInt);
if (occupied.includes(pcashChainId)) throw new Error("PCASH chain ID is already assigned in the known profiles; choose an unused ID.");

async function rpc(method, params = []) {
  const response = await fetch(l1Rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`L1 request failed (${response.status})`);
  const body = await response.json();
  if (body.error || body.result == null) throw new Error(`L1 ${method} failed`);
  return body.result;
}

const [l1ChainId, anchor] = await Promise.all([
  rpc("eth_chainId"), rpc("eth_getBlockByNumber", ["finalized", false]),
]);
if (BigInt(l1ChainId) === 0n || BigInt(inbox) === 0n || BigInt(anchor.hash) === 0n) {
  throw new Error("L1 chain ID, inbox and anchor hash must be nonzero.");
}
const fields = {
  PCASH_CHAIN_ID: pcashChainId, PCASH_L1_CHAIN_ID: BigInt(l1ChainId),
  PCASH_INBOX_ADDRESS: inbox, PCASH_GENESIS_L1_BLOCK: BigInt(anchor.number),
  PCASH_GENESIS_L1_BLOCK_HASH: anchor.hash,
};
const output = resolve(args.str("output", ".envrc.launch"));
await writeFile(output, Object.entries(fields).map(([key, value]) => `export ${key}=${value}\n`).join(""), { flag: "wx" });
logger.info(`Prepared ${output} from finalized L1 block ${fields.PCASH_GENESIS_L1_BLOCK}.`);
logger.info("Source the environment file before running just node. RPC credentials are not written to the file.");
