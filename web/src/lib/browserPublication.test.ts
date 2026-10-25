import { describe, expect, it, vi } from "vitest";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { deliveryCommitment, encodeUserAccountUpdate, isUnpaidTransaction, randomArena, WIRE_PROOF_BYTES, sizeClassFiller, TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_UPDATE } from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { keccak256, toHex } from "@pcash/sdk/utils";
import * as walletWeb from "@pcash/sdk/wallet/web";
import type { PublicClient, WalletClient } from "viem";
import { browserPublication } from "./browserPublication.ts";

const CHAIN_ID = 1_346_589_512;
const status = { pcashChainId: CHAIN_ID, genesisHash: `0x${"88".repeat(32)}`, inboxAddress: `0x${"50".repeat(20)}`, l1ChainId: 11_155_111n,
  acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_UPDATE] } as StatusResult;

/** A zero-fee user-account update: account operations earn no issuance, so no mempool publisher is paid for it. */
function unpaidEntry(): Uint8Array {
  const { offsets } = PRIVATE_VALUE_PROFILES.S;
  const outputData = Array.from({ length: PRIVATE_VALUE_PROFILES.S.outputs }, () => sizeClassFiller());
  const arena = randomArena(PRIVATE_VALUE_PROFILES.S.shapeId);
  const publicInputs = Array<bigint>(PRIVATE_VALUE_PROFILES.S.publicInputs).fill(0n);
  publicInputs[offsets.chainId] = BigInt(CHAIN_ID);
  publicInputs[offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  publicInputs[offsets.openFeeAmount] = 0n;
  publicInputs[offsets.validUntil] = 100n;
  return encodeUserAccountUpdate({
    pcashChainId: CHAIN_ID,
    proposedAccountFields: { address: 1n, newRuleSetCommitment: 1n, receiveKey: { operation: "keep" } },
    accountUpdateCommitment: 1n,
    section: { publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena },
  });
}

describe("browser publication paths", () => {
  it("never hands an unpaid entry on the default path to Ethereum", async () => {
    const entry = unpaidEntry();
    expect(isUnpaidTransaction(entry)).toBe(true);
    const contentHash = toHex(keccak256(entry));
    const node = {
      status: vi.fn(async () => status),
      submitRawTransaction: vi.fn(async () => ({ contentHash })),
    } as unknown as PcashNodeClient;
    const ethereum = vi.fn(async () => { throw new Error("the default path must not reach Ethereum"); });
    const { submission, selfPublication } = browserPublication(walletWeb, {
      node,
      publicClient: { request: ethereum, transport: { url: "http://l1.invalid" } } as unknown as PublicClient,
      walletClient: { request: ethereum } as unknown as WalletClient,
      account: `0x${"12".repeat(20)}`,
      payoutRecipient: { address: 1n, nkRoot: 2n },
    });
    expect(submission.mode).toBe("mempool");
    expect(submission.preflightL1Budget).toBeUndefined();
    const prepared = await submission.preflight({ transactionBytes: entry, status, retry: false });
    await submission.submit({ transactionBytes: entry, status, retry: false, prepared });
    expect(node.submitRawTransaction).toHaveBeenCalledWith(toHex(entry));
    expect(ethereum).not.toHaveBeenCalled();
    expect(selfPublication.mode).toBe("l1");
  });
});
