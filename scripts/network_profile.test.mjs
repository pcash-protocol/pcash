import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultNetwork, networks } from "./network_profile.mjs";
import {
  NETWORKS, DEFAULT_NETWORK, PCASH_CHAIN_ID, L1_CHAIN_ID, INBOX_ADDRESS,
} from "../sdk/src/constants/networkProfile.ts";

test("named networks use the vanity batch inbox", () => {
  assert.deepEqual(networks.mainnet, {
    profile: "pcash-mainnet", pcashChainId: "231", l1ChainId: "1",
    inboxAddress: "0x00000000000000000000000000000000000CA511",
  });
  assert.deepEqual(networks.testnet, {
    profile: "pcash-sepolia", pcashChainId: "23100", l1ChainId: "11155111",
    inboxAddress: "0x00000000000000000000000000000000000CA511",
  });
  assert.equal(defaultNetwork, networks.testnet);
});

test("generated TypeScript presets expose the assigned identities and testnet defaults", () => {
  assert.deepEqual(NETWORKS, {
    mainnet: {
      pcashChainId: 231n, l1ChainId: 1n,
      inboxAddress: 0x00000000000000000000000000000000000CA511n,
    },
    testnet: {
      pcashChainId: 23100n, l1ChainId: 11155111n,
      inboxAddress: 0x00000000000000000000000000000000000CA511n,
    },
  });
  assert.equal(DEFAULT_NETWORK, NETWORKS.testnet);
  assert.equal(PCASH_CHAIN_ID, 23100n);
  assert.equal(L1_CHAIN_ID, 11155111n);
  assert.equal(INBOX_ADDRESS, 0x00000000000000000000000000000000000CA511n);
});

test("launch preparation reserves both public network IDs before querying L1", () => {
  for (const chainId of ["231", "23100"]) {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./prepare_launch.mjs", import.meta.url)),
      "--chain-id", chainId, "--l1-rpc", "http://127.0.0.1:1",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PCASH chain ID is already assigned/);
  }
});
