import { describe, expect, it } from "vitest";
import type { AssetActionBuild } from "@pcash/sdk/builders";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { PrivateValueShape } from "@pcash/sdk/constants";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import type { MintRuleApplication } from "@pcash/sdk/prover";
import { fullOutputCommitment, WIRE_PROOF_BYTES, type AssetDefinition } from "@pcash/sdk/protocol";
import { ACCOUNT_MINT_RULE_CIRCUIT, createAccountMintAsset, defaultUserAccountRuleSet, senderDenyListTransferRule } from "@pcash/sdk/rules";
import { addressHex, bytes32Hex } from "@pcash/sdk/utils";
import { runAccountMintClient } from "../../src/wallet/actions/mintClient.ts";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import type { WalletFileData } from "../../src/wallet/noteStore.ts";
import { storedReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { anchoredChain } from "./chainFixture.ts";
import { testStatus } from "./statusFixture.ts";

const network = { pcashChainId: 8182n, l1ChainId: 11155111n, inboxAddress: `0x${"66".repeat(20)}` };
const key = new Uint8Array(32).fill(23);
const wallet = derivePcashProfileFromPrivateKey(key, network);
const signer = privateKeyPcashActionSigner(key);
const genesisHash = `0x${"11".repeat(32)}`;
/** The longest standard restricted definition a wallet mints: account minting, a sender deny list, the longest name and symbol. */
const longest = createAccountMintAsset({
  metadata: { name: "N".repeat(64), symbol: "S".repeat(12), decimals: 18, contentDigest: new Uint8Array(32).fill(9) },
  accountAddress: wallet.address,
  transferRule: senderDenyListTransferRule({ contractAddress: 0x5678n, listId: new Uint8Array(32).fill(3), maxDelta: 86_400n }),
}).definition;

/** A minting wallet holding native notes of these amounts. */
function fixture(shapes: readonly PrivateValueShape[], natives: readonly bigint[]) {
  const data: WalletFileData = {
    address: addressHex(wallet.address), network: { chainId: network.pcashChainId.toString(), genesisHash },
    receiveKeys: [storedReceiveKeyPair({ publicKey: wallet.mlKemPublicKey, secretKey: wallet.mlKemSecretKey })],
    notes: natives.map((amount, index) => ({
      leafIndex: String(index), outputIndex: 0, assetId: bytes32Hex(0n), amount: amount.toString(), owner: addressHex(wallet.address),
      noteSecret: bytes32Hex(BigInt(index + 100)), spent: false, pending: false,
      commitment: bytes32Hex(fullOutputCommitment({ owner: wallet.address, noteSecret: BigInt(index + 100), amount, assetId: 0n }, index)),
    })),
  };
  const rules = defaultUserAccountRuleSet({ wallet, network, secrets: wallet.defaultUserRuleSecrets });
  const store = memoryWalletStateStore(data, anchoredChain({
    outputs: data.notes.map((note) => ({ leaf: BigInt(note.commitment!), mark: true })),
    accounts: [{ address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: wallet.mlKemPublicKey }],
  }).records);
  const status = testStatus({ pcashChainId: Number(network.pcashChainId), genesisHash, l1ChainId: network.l1ChainId, inboxAddress: network.inboxAddress });
  const node = {
    status: async () => status,
    getWitnessSnapshot: async (query: { nullifiers: string[] }) =>
      ({ status, nullifiers: { statuses: query.nullifiers.map((nullifier) => ({ nullifier, spent: false })) } }),
    getReceipt: async () => [], getMempoolTransaction: async () => null,
  } as unknown as PcashNodeClient;
  const builds: AssetActionBuild[] = [];
  const mintRules: MintRuleApplication[] = [];
  let signatures = 0;
  const mint = (definition: AssetDefinition, recipients: number, openFeeAmount: bigint) => runAccountMintClient({
    node, store, wallet, chainId: network.pcashChainId, definition, replayIds: [0x77n], openFeeAmount,
    outputs: Array.from({ length: recipients }, (_, index) => ({ to: addressHex(wallet.address), amount: BigInt(index + 1) })),
    signer: { address: signer.address, signTypedData: async (request) => { signatures++; return signer.signTypedData(request); } },
    prover: { shapes, proveAndEncode: async (build, _authorization, mintRule) => {
      builds.push(build);
      mintRules.push(mintRule);
      return build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
    } },
    submission: { mode: "mempool", preflight: async () => null, submit: async () => ({ accepted: false, queued: true, output: null }) },
    settlePollMaxAttempts: 1, settlePollIntervalMs: 0,
  });
  return { mint, builds, mintRules, store, signatures: () => signatures };
}

describe("account mint profile", () => {
  it("mints in L what S cannot hold, and refuses before signing when the prover proves only S", async () => {
    // Beside the marker S has three native slots; the fee of 4 needs all four notes of 1.
    const natives = [1n, 1n, 1n, 1n];
    const large = fixture([0, 1], natives);
    await large.mint(longest, 4, 4n);
    expect(large.builds.map((build) => build.shape)).toEqual([1]);
    expect(large.mintRules.map((mintRule) => mintRule.packageName)).toEqual([ACCOUNT_MINT_RULE_CIRCUIT]);

    const small = fixture([0], natives);
    await expect(small.mint(longest, 4, 4n)).rejects.toThrow("insufficient notes to cover 4: most spendable in one transfer is 3 (best 3 of 4 notes");
    expect(small.signatures()).toBe(0);
    expect(small.builds).toEqual([]);
    expect(small.store.snapshot()?.pendingAssetActions ?? []).toEqual([]);
  });
});
