// Entry identity and mempool admission shared by every submitter.

import { describe, expect, it } from "vitest";
import { buildDirectReferenceUserAccountCreation, buildReferenceUserAccountCreation } from "../src/builders/index.ts";
import { admitTransaction, assertMempoolAdmissible, isAdmissionRefusal, PcashNodeRpcError, type StatusResult, type SubmitRawTransactionResult } from "../src/clients/index.ts";
import { PCASH_CHAIN_ID } from "../src/constants/index.ts";
import { encodeUserAccountCreation, transactionIdentity } from "../src/protocol/index.ts";
import { keccak256 } from "../src/utils/keccak.ts";
import { toHex } from "../src/utils/hex.ts";
import { TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet, testAuthorizationResolver } from "./testWallet.ts";

const wallet = deriveTestWallet();
const creation = { chainId: PCASH_CHAIN_ID, wallet, defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
  recentPcashBlockHash: 0x1234n, validUntilTimestamp: 987654n };
const directCreation = encodeUserAccountCreation(PCASH_CHAIN_ID, buildDirectReferenceUserAccountCreation(creation).body);
const signedCreation = encodeUserAccountCreation(PCASH_CHAIN_ID, buildReferenceUserAccountCreation({
  ...creation, authorizationResolver: testAuthorizationResolver(wallet),
}).body);

function status(acceptedTransactionTypes: number[] = [0, 1]): StatusResult {
  return { pcashChainId: Number(PCASH_CHAIN_ID), acceptedTransactionTypes } as unknown as StatusResult;
}

function admission(contentHash: string): SubmitRawTransactionResult {
  return {
    contentHash,
    statementId: `0x${"01".repeat(32)}`,
    stableId: `0x${"02".repeat(32)}`,
    status: "ready",
    headCheckedBlock: 1n,
    headCheckedBlockHash: `0x${"03".repeat(32)}`,
  };
}

describe("transactionIdentity", () => {
  it("names exact bytes by their keccak content hash", () => {
    expect(transactionIdentity(signedCreation)).toEqual({
      contentHash: toHex(keccak256(signedCreation)),
      transactionHex: toHex(signedCreation),
    });
  });
});

describe("assertMempoolAdmissible", () => {
  it("admits an accepted transaction type", () => {
    expect(() => assertMempoolAdmissible(status(), signedCreation)).not.toThrow();
  });

  it("refuses a transaction type the node does not accept", () => {
    expect(() => assertMempoolAdmissible(status([0]), signedCreation)).toThrow(/0x01 is not accepted/);
  });

  it("refuses a direct account creation, which only its owner can publish", () => {
    expect(() => assertMempoolAdmissible(status(), directCreation)).toThrow(/dedicated owner L1/);
  });
});

describe("admitTransaction", () => {
  it("submits the exact hex and returns the node's admission", async () => {
    const submitted: string[] = [];
    const { contentHash, transactionHex } = transactionIdentity(signedCreation);
    const node = {
      submitRawTransaction: async (hex: string) => {
        submitted.push(hex);
        return admission(contentHash.toUpperCase().replace("0X", "0x"));
      },
    };
    await expect(admitTransaction(node, signedCreation)).resolves.toMatchObject({ status: "ready" });
    expect(submitted).toEqual([transactionHex]);
  });

  it("rejects an admission of different content", async () => {
    const node = { submitRawTransaction: async () => admission(`0x${"ff".repeat(32)}`) };
    await expect(admitTransaction(node, signedCreation)).rejects.toThrow(/node admitted content 0xff/);
  });

  it("resubmits while the node's admission queue is full", async () => {
    const { contentHash } = transactionIdentity(signedCreation);
    let calls = 0;
    const node = {
      submitRawTransaction: async () => {
        calls += 1;
        if (calls < 3) throw busy();
        return admission(contentHash);
      },
    };
    await expect(admitTransaction(node, signedCreation)).resolves.toMatchObject({ contentHash });
    expect(calls).toBe(3);
  });

  it("stops resubmitting once the node stays busy past the retry window, and never retries other refusals", async () => {
    let calls = 0;
    const alwaysBusy = { submitRawTransaction: async (): Promise<SubmitRawTransactionResult> => { calls += 1; throw busy(); } };
    await expect(admitTransaction(alwaysBusy, signedCreation, 0)).rejects.toThrow(/admission queue is full/);
    expect(calls).toBe(1);

    for (const refusal of [
      new PcashNodeRpcError({ code: -32011, message: "invalid transaction: proof rejected" }, { method: "pcash_submitRawTransaction", url: "http://node" }),
      new PcashNodeRpcError({ code: -32017, message: "transaction is ineligible at the current state: NullifierAlreadySpent" }, { method: "pcash_submitRawTransaction", url: "http://node" }),
      new PcashNodeRpcError({ code: -32013, message: "verification unavailable: verifier timed out" }, { method: "pcash_submitRawTransaction", url: "http://node" }),
    ]) {
      calls = 0;
      const refusing = { submitRawTransaction: async (): Promise<SubmitRawTransactionResult> => { calls += 1; throw refusal; } };
      await expect(admitTransaction(refusing, signedCreation)).rejects.toBe(refusal);
      expect(calls).toBe(1);
    }
  });
});

describe("isAdmissionRefusal", () => {
  const nodeError = (code: number) => new PcashNodeRpcError({ code, message: "refused" }, { method: "pcash_submitRawTransaction", url: "http://node" });

  it("names the node's pre-insert refusals", () => {
    for (const code of [-32602, -32010, -32011, -32012, -32015, -32016, -32017]) expect(isAdmissionRefusal(nodeError(code))).toBe(true);
  });

  it("leaves failures that may follow an insert, and non-node errors, in doubt", () => {
    for (const code of [-32013, -32014, -32603, -32000]) expect(isAdmissionRefusal(nodeError(code))).toBe(false);
    expect(isAdmissionRefusal(new Error("connection reset"))).toBe(false);
  });
});

function busy(): PcashNodeRpcError {
  return new PcashNodeRpcError(
    { code: -32016, message: "node is busy: mempool admission queue is full" },
    { method: "pcash_submitRawTransaction", url: "http://node" },
  );
}
