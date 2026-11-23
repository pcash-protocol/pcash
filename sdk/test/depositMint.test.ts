// The deposit-mint rule's configuration, recognition, deposit log, deposit
// codes and salts, and the refusals of its witness builder. The rule's circuit
// is executed with the mint kernel in restrictedKernel.test.ts.

import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";
import { buildAssetAction, type AssetActionBuild } from "../src/builders/assetAction.ts";
import { openedAssetActionOutput, type AssetActionInput, type AssetActionOutput } from "../src/builders/assetOutputs.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { DEPOSIT_MINT_RULE_VK_HASH } from "../src/constants/rulePins.ts";
import { BN254_SCALAR_MODULUS, fieldToHex } from "../src/crypto/field.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { accountRuleEntryCommitment, accountStateCommitment, buildAccountRuleSet } from "../src/protocol/account.ts";
import type { PortableMintRule } from "../src/protocol/assetDefinition.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { normalizedL1LogLeaf } from "../src/protocol/l1Logs.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { fullOutputCommitment, nullifierKeyCommitment } from "../src/protocol/notes.ts";
import { ACCOUNT_MINT_RULE_VK_HASH } from "../src/constants/rulePins.ts";
import {
  createDepositMintAsset,
  decodeDepositCode,
  decodeDepositLog,
  decodeDepositMintConfiguration,
  DEPOSIT_CODE_PREFIX,
  DEPOSIT_TOPIC0,
  depositLog,
  depositMintConfigurationCommitment,
  depositMintRule,
  depositMintWitness,
  depositReplayId,
  depositSalt,
  encodeDepositCode,
  recipientCommitment,
} from "../src/rules/depositMint.ts";
import { mintRuleLabel, namesStandardMintRule, recognizeMintRule } from "../src/rules/mintRules.ts";
import { defaultUserAccountRuleSet, ecdsaRuleConfigurationCommitment } from "../src/rules/referenceRules.ts";
import { beBytes, concatBytes, fromBase64Url, toBase64Url } from "../src/utils/bytes.ts";
import { keccak256 } from "../src/utils/keccak.ts";
import { toHex } from "../src/utils/hex.ts";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { depositMintFixture } from "@pcash/test-support/deposit-mint-fixtures";
import { deriveTestWallet } from "./testWallet.ts";

const VAULT = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
const DEPOSITOR = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n;
const RECIPIENT = 0x2000000000000000000000000000000000000002n;
const SALT = 0x5a175a175a17n;
const NONCE = 0x0123456789abcdef0123456789abcdeffedcba9876543210fedcba9876543210n;
const AMOUNT = 25_000_000n;
const CHAIN_ID = 8182n;
// The circuit test's chain and asset.
const KAT_CHAIN = 7n;
const KAT_ASSET = 0x1000000000000000000000000000000000000000000000000000000000000abcn;

// Frozen in the circuit's test_formulas_match_the_sdk
// (circuits/rules/deposit_mint/src/main.nr): the commitment to (KAT_CHAIN,
// KAT_ASSET, RECIPIENT, SALT), the replay ID at block 100, leaf 9, and the log
// leaf at transaction 5, log 2.
const KAT = {
  configurationCommitment: 0x06b24a08cbfb721b7ccd71c0805827fd569c9fb2d8ccc449a5dc6e31a7f85966n,
  recipientCommitment: 0x0f5c1561fce3763c7ae4953554d2821ea9c79431f923ea92b9a155ea1624350en,
  replayId: 0x2d9331bd5d257f4c2bf113e8c1d8c4da60c693afbadeb1540e285bb979766ffbn,
  logLeaf: 0x0bf98494c808c146f56dfe018766bacebabe0a5608e76973ebe43ad929443569n,
};
// Frozen here: a wallet finds its deposits again only while these stay the same.
const SALT_KAT = 0x1006ff400fc77e39903a58c6a3ed8301af0b668919e52191fbe6bbc8d251c533n;
const CODE_KAT = "pdep:AAAf9l-9sjFWeK_ss2fwMtk_ZC9kGAqjH0AjhjTmgbtAzoFkKkW_lgfhs068oqRGnHRakJGdObwBI0VniavN7wEjRWeJq83v_ty6mHZUMhD-3LqYdlQyEN0X-sg";

const deposit = { depositor: DEPOSITOR, recipientCommitment: KAT.recipientCommitment, nonce: NONCE, amount: AMOUNT };

describe("deposit-mint configuration and recognition", () => {
  const rule = depositMintRule({ vault: VAULT });

  it("opens the configuration as the vault's 20-byte address under an S key only", () => {
    expect(rule.configuration).toEqual(beBytes(VAULT, 20));
    expect(decodeDepositMintConfiguration(rule.configuration)).toEqual({ vault: VAULT });
    expect(rule.configurationCommitment).toBe(KAT.configurationCommitment);
    expect(depositMintConfigurationCommitment({ vault: VAULT })).toBe(KAT.configurationCommitment);
    expect(rule.sVkHash).toBe(DEPOSIT_MINT_RULE_VK_HASH);
    expect(rule.lVkHash).toBe(0n);
    expect(() => depositMintRule({ vault: 1n << 160n })).toThrow(/vault/);
  });

  it("recognizes and labels the rule", () => {
    expect(recognizeMintRule(rule)).toEqual({ kind: "deposit-mint", configuration: { vault: VAULT } });
    expect(mintRuleLabel(rule)).toBe("minted once per deposit to vault 0x5fbdb2315678afecb367f032d93f642f64180aa3");
    expect(namesStandardMintRule(rule)).toBe(true);
    const { definition, descriptor } = createDepositMintAsset({ metadata: { name: "D", symbol: "D", decimals: 6, contentDigest: new Uint8Array(32) },
      vault: VAULT, startSalt: 0n });
    expect(recognizeMintRule(definition.mintRule)).toEqual({ kind: "deposit-mint", configuration: { vault: VAULT } });
    expect(descriptor.mintRule).toEqual({ sVkHash: DEPOSIT_MINT_RULE_VK_HASH, lVkHash: 0n, configurationCommitment: KAT.configurationCommitment });
  });

  it.each<[string, PortableMintRule]>([
    ["a changed vault byte", { ...rule, configuration: Uint8Array.from(rule.configuration, (byte, i) => i === 19 ? byte ^ 1 : byte) }],
    ["an opening one byte longer", { ...rule, configuration: concatBytes(Uint8Array.of(0), rule.configuration) }],
  ])("treats the deposit-mint keys with %s as custom", (_name, changed) => {
    expect(recognizeMintRule(changed)).toEqual({ kind: "custom" });
    expect(mintRuleLabel(changed)).toBe("custom mint rule");
    expect(namesStandardMintRule(changed)).toBe(true);
  });

  it.each<[string, PortableMintRule]>([
    ["the deposit-mint key for both profiles", { ...rule, lVkHash: DEPOSIT_MINT_RULE_VK_HASH }],
    ["the deposit-mint key as the L key", { ...rule, sVkHash: 0n, lVkHash: DEPOSIT_MINT_RULE_VK_HASH }],
    ["the account-mint keys", { ...rule, sVkHash: ACCOUNT_MINT_RULE_VK_HASH, lVkHash: ACCOUNT_MINT_RULE_VK_HASH }],
  ])("treats a vault configuration under %s as custom", (_name, changed) => {
    expect(recognizeMintRule(changed)).toEqual({ kind: "custom" });
  });
});

describe("deposit formulas", () => {
  it("matches the circuit's recipient commitment, replay ID and log leaf", () => {
    expect(recipientCommitment(KAT_CHAIN, KAT_ASSET, RECIPIENT, SALT)).toBe(KAT.recipientCommitment);
    expect(depositReplayId(100, 9, SALT)).toBe(KAT.replayId);
    const log = depositLog({ ...deposit, vault: VAULT, transactionIndex: 5, logIndex: 2 });
    expect(normalizedL1LogLeaf(log)).toBe(KAT.logLeaf);
  });

  it("commits to the chain and the asset", () => {
    const commitments = [
      recipientCommitment(KAT_CHAIN + 1n, KAT_ASSET, RECIPIENT, SALT),
      recipientCommitment(KAT_CHAIN, KAT_ASSET + 1n, RECIPIENT, SALT),
      recipientCommitment(KAT_CHAIN, KAT_ASSET, RECIPIENT + 1n, SALT),
      recipientCommitment(KAT_CHAIN, KAT_ASSET, RECIPIENT, SALT + 1n),
    ];
    expect(new Set([KAT.recipientCommitment, ...commitments]).size).toBe(5);
  });

  it("lays the log out as the vault's event: topics [topic0, depositor] and abi.encode(commitment, nonce, amount)", () => {
    expect(toHex(DEPOSIT_TOPIC0)).toBe("0x6d06ca7726c7d8bc263bc28d3b225203f440dc69a5650bc9ce8bdf6a5687cce3");
    const log = depositLog({ ...deposit, vault: VAULT, transactionIndex: 5, logIndex: 2 });
    expect(log.topics).toEqual([DEPOSIT_TOPIC0, beBytes(DEPOSITOR, 32)]);
    expect(toHex(log.data)).toBe(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [fieldToHex(KAT.recipientCommitment), `0x${NONCE.toString(16).padStart(64, "0")}`, AMOUNT]));
    expect(decodeDepositLog(log)).toEqual(deposit);
  });

  it("refuses another event layout and an amount of 2^128", () => {
    const log = depositLog({ ...deposit, vault: VAULT, transactionIndex: 5, logIndex: 2 });
    expect(() => decodeDepositLog({ ...log, topics: [new Uint8Array(32), log.topics[1]!] })).toThrow("not a vault Deposit log");
    expect(() => decodeDepositLog({ ...log, topics: [DEPOSIT_TOPIC0] })).toThrow("not a vault Deposit log");
    expect(() => decodeDepositLog({ ...log, data: log.data.subarray(0, 64) })).toThrow("Deposit data must be 96 bytes");
    expect(() => decodeDepositLog({ ...log, topics: [DEPOSIT_TOPIC0, new Uint8Array(32).fill(0xff)] })).toThrow(/depositor/);
    const large = depositLog({ ...deposit, amount: 1n << 128n, vault: VAULT, transactionIndex: 5, logIndex: 2 });
    expect(() => decodeDepositLog(large)).toThrow("Deposit amount must be below 2^128");
  });

  it("derives the salt from the nk root, chain, vault and nonce", () => {
    expect(depositSalt(0x77n, CHAIN_ID, VAULT, NONCE)).toBe(SALT_KAT);
    const others = [
      depositSalt(0x78n, CHAIN_ID, VAULT, NONCE),
      depositSalt(0x77n, CHAIN_ID + 1n, VAULT, NONCE),
      depositSalt(0x77n, CHAIN_ID, VAULT + 1n, NONCE),
      depositSalt(0x77n, CHAIN_ID, VAULT, NONCE + 1n),
    ];
    expect(new Set([SALT_KAT, ...others]).size).toBe(5);
  });
});

describe("deposit codes", () => {
  const code = {
    pcashChainId: CHAIN_ID, vault: VAULT, recipientCommitment: recipientCommitment(CHAIN_ID, KAT_ASSET, RECIPIENT, SALT_KAT), nonce: NONCE,
  };
  const expected = { pcashChainId: CHAIN_ID, vault: VAULT };

  it("encodes chain, vault, commitment and nonce after the prefix, with a checksum", () => {
    expect(encodeDepositCode(code)).toBe(CODE_KAT);
    expect(CODE_KAT.startsWith(DEPOSIT_CODE_PREFIX)).toBe(true);
    expect(decodeDepositCode(CODE_KAT, expected)).toEqual(code);
    expect(decodeDepositCode(`  ${CODE_KAT}\n`, expected)).toEqual(code);
  });

  it("refuses a changed character, a missing prefix, another length or a non-canonical spelling", () => {
    const body = CODE_KAT.slice(DEPOSIT_CODE_PREFIX.length);
    const changed = (index: number) => {
      const character = body[index] === "A" ? "B" : "A";
      return DEPOSIT_CODE_PREFIX + body.slice(0, index) + character + body.slice(index + 1);
    };
    for (const index of [0, 10, 60, body.length - 2]) {
      expect(() => decodeDepositCode(changed(index), expected)).toThrow("deposit code checksum mismatch");
    }
    expect(() => decodeDepositCode(body, expected)).toThrow(/starts with pdep:/);
    expect(() => decodeDepositCode(`${CODE_KAT}AAAA`, expected)).toThrow("deposit code has wrong length");
    expect(() => decodeDepositCode(DEPOSIT_CODE_PREFIX + toBase64Url(fromBase64Url(body).subarray(0, 88)), expected))
      .toThrow("deposit code has wrong length");
    // 92 bytes leave two spare bits in the last character; a code sets neither.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const spare = DEPOSIT_CODE_PREFIX + body.slice(0, -1) + alphabet[alphabet.indexOf(body.at(-1)!) ^ 1];
    expect(() => decodeDepositCode(spare, expected)).toThrow(/non-canonical base64/);
  });

  it("refuses a code for another chain or vault even with a valid checksum", () => {
    expect(() => decodeDepositCode(encodeDepositCode({ ...code, pcashChainId: CHAIN_ID + 1n }), expected))
      .toThrow("the deposit code is for another PCASH chain");
    expect(() => decodeDepositCode(encodeDepositCode({ ...code, vault: VAULT + 1n }), expected))
      .toThrow("the deposit code is for another vault");
  });

  it("checksums with the first four bytes of keccak256 of the body", () => {
    const bytes = fromBase64Url(CODE_KAT.slice(DEPOSIT_CODE_PREFIX.length));
    expect(bytes.length).toBe(92);
    expect(bytes.subarray(88)).toEqual(keccak256(bytes.subarray(0, 88)).subarray(0, 4));
    expect(toBase64Url(bytes)).toBe(CODE_KAT.slice(DEPOSIT_CODE_PREFIX.length));
  });

  it("refuses the words the vault refuses: a zero or out-of-field commitment, or an out-of-field nonce", () => {
    // Checksummed codes no encoder would write.
    const checksummed = (words: { recipientCommitment: bigint; nonce: bigint }) => {
      const body = concatBytes(beBytes(CHAIN_ID, 4), beBytes(VAULT, 20), beBytes(words.recipientCommitment, 32), beBytes(words.nonce, 32));
      return DEPOSIT_CODE_PREFIX + toBase64Url(concatBytes(body, keccak256(body).subarray(0, 4)));
    };
    const refused: [{ recipientCommitment: bigint; nonce: bigint }, RegExp][] = [
      [{ recipientCommitment: 0n, nonce: NONCE }, /recipient commitment is zero/],
      [{ recipientCommitment: BN254_SCALAR_MODULUS, nonce: NONCE }, /recipient commitment must be a BN254 scalar field element/],
      [{ recipientCommitment: code.recipientCommitment, nonce: BN254_SCALAR_MODULUS }, /nonce must be a BN254 scalar field element/],
      [{ recipientCommitment: code.recipientCommitment, nonce: (1n << 256n) - 1n }, /nonce must be a BN254 scalar field element/],
    ];
    for (const [words, message] of refused) {
      expect(() => decodeDepositCode(checksummed(words), expected)).toThrow(message);
      expect(() => encodeDepositCode({ ...code, ...words })).toThrow(message);
    }
    const largest = { recipientCommitment: BN254_SCALAR_MODULUS - 1n, nonce: BN254_SCALAR_MODULUS - 1n };
    expect(decodeDepositCode(checksummed(largest), expected)).toEqual({ ...code, ...largest });
    expect(decodeDepositCode(encodeDepositCode({ ...code, nonce: 0n }), expected).nonce).toBe(0n);
  });
});

describe("deposit-mint witness", () => {
  const fixture = depositMintFixture();
  const params = {
    mint: fixture.build, configuration: { vault: VAULT }, log: fixture.log, opening: fixture.opening,
    recipientAddress: fixture.recipient.address, salt: fixture.salt, noteSecret: fixture.noteSecret,
  };

  it("reads the deposit, its opening and the private value", () => {
    const witness = fixture.mintRule.witnessMap;
    const deposit = witness.deposit as Record<string, unknown>;
    expect(witness.vault).toBe(fieldToHex(VAULT));
    expect(witness.recipient_address).toBe(fieldToHex(fixture.recipient.address));
    expect(witness.salt).toBe(fieldToHex(fixture.salt));
    expect(witness.account_address).toBe(fieldToHex(fixture.recipient.address));
    expect(deposit.amount).toBe(fieldToHex(AMOUNT));
    expect(deposit.nonce_high).toBe(fieldToHex(NONCE >> 128n));
    expect(deposit.nonce_low).toBe(fieldToHex(NONCE & ((1n << 128n) - 1n)));
    expect(deposit.depositor_high).toBe(fieldToHex(DEPOSITOR >> 128n));
    expect((deposit.log as Record<string, unknown>).log_index).toBe(fieldToHex(2n));
    expect(((witness.private_value as Record<string, unknown>).nullifiers as string[]).length).toBe(PRIVATE_VALUE_PROFILES.S.inputs);
  });

  it("refuses a log from another emitter or of another event", () => {
    expect(() => depositMintWitness({ ...params, log: { ...fixture.log, emitter: VAULT + 1n } }))
      .toThrow("the deposit log is not from the asset's vault");
    expect(() => depositMintWitness({ ...params, log: { ...fixture.log, topics: [new Uint8Array(32), fixture.log.topics[1]!] } }))
      .toThrow("not a vault Deposit log");
  });

  it("refuses a recipient commitment that does not open to the chain, asset, recipient and salt", () => {
    const refusal = "the deposit's recipient commitment does not open to the chain, asset, recipient and salt";
    expect(() => depositMintWitness({ ...params, salt: fixture.salt + 1n })).toThrow(refusal);
    expect(() => depositMintWitness({ ...params, recipientAddress: fixture.recipient.address + 1n })).toThrow(refusal);
    expect(() => depositMintWitness({ ...params, mint: { ...fixture.build, assetId: fixture.build.assetId + 1n } })).toThrow(refusal);
    expect(() => depositMintWitness({ ...params, mint: { ...fixture.build, pcashChainId: fixture.build.pcashChainId + 1n } })).toThrow(refusal);
  });

  it("opens a commitment word at or above the field modulus as its residue, as the circuit does", () => {
    const decoded = decodeDepositLog(fixture.log);
    const word = decoded.recipientCommitment + BN254_SCALAR_MODULUS;
    expect(word < 1n << 256n).toBe(true);
    const log = depositLog({ ...decoded, recipientCommitment: word, vault: VAULT, transactionIndex: 5, logIndex: 2 });
    expect((depositMintWitness({ ...params, log }).deposit as Record<string, unknown>).recipient_commitment_high)
      .toBe(fieldToHex(word >> 128n));
  });

  it("refuses an asset whose configuration is another vault's", () => {
    expect(() => depositMintWitness({ ...params, configuration: { vault: VAULT + 1n } }))
      .toThrow("the configuration does not open the asset's mint rule");
  });

  it("refuses a note secret that does not open the asset output", () => {
    expect(() => depositMintWitness({ ...params, noteSecret: fixture.noteSecret + 1n }))
      .toThrow("a deposit mint's asset output must go to the deposit's recipient");
  });

  const wallet = deriveTestWallet({ mlKem: "deterministic" });
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  // The fixture's deposit commits to its asset.
  const { descriptor } = fixture;
  const replayId = depositReplayId(fixture.opening.l1BlockNumber, fixture.opening.logLeafIndex, fixture.salt);
  /** A mint of the fixture's deposit asset by `wallet` with these markers and asset outputs to `wallet`. */
  function mint(replayIds: readonly bigint[], amounts: readonly bigint[]): AssetActionBuild {
    const profile = PRIVATE_VALUE_PROFILES.S;
    const rule = defaultUserAccountRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS }).mintRule;
    const configurationCommitment = ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(wallet.nkRoot));
    const set = buildAccountRuleSet([{ entryIndex: rule.entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
      rule.applicationVkHash, configurationCommitment, rule.commitmentBlinder,
    ) }]);
    const outputs = new SparseMerkleTree(40);
    const accounts = new SparseMerkleTree(40);
    outputs.setLeaf(0, fullOutputCommitment({ owner: wallet.address, noteSecret: 99n, assetId: 0n, amount: 10n }, 0));
    accounts.setLeaf(0, accountStateCommitment(wallet.address, nullifierKeyCommitment(wallet.nkRoot), set.accountRuleSetCommitment, 0n, 1n, 0n));
    const recent = syntheticRecentBlockFixture({ outputRoot: outputs.root, outputCount: 1, issuedSoFar: 10n, lagQ: 100n,
      accountStateRoot: accounts.root, accountCount: 1 });
    const inputs: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
    replayIds.forEach((id, slot) => { inputs[slot] = { kind: "mint-marker", replayId: id }; });
    inputs[profile.inputs - 1] = { kind: "native", noteSecret: 99n, amount: 10n, leafIndex: 0, siblings: outputs.proof(0).siblings };
    const outputSlots: AssetActionOutput[] = Array.from({ length: profile.outputs }, (_, slot) => ({
      kind: "dummy", dummySecret: BigInt(slot + 123), amount: 0n, outputData: sizeClassFiller(),
    }));
    amounts.forEach((amount, slot) => {
      outputSlots[slot] = openedAssetActionOutput({ kind: "asset", pcashChainId: chainId, assetId: descriptor.assetId, outputIndex: slot,
        noteSecret: fixture.noteSecret, amount, recipientAddress: wallet.address, recipientMlKemPublicKey: wallet.mlKemPublicKey!,
        authenticatedRecipient: true });
    });
    return buildAssetAction({
      shape: profile.shapeId, pcashChainId: chainId, mint: { descriptor },
      snapshot: {
        recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
        stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
        outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
        accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
      },
      owner: { address: wallet.address, nkRoot: wallet.nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
        accountRuleSetCommitment: set.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n, receiveKeyHash: 0n,
        rule: { configurationCommitment, commitmentBlinder: rule.commitmentBlinder, entryIndex: rule.entryIndex,
          siblings: set.membership(rule.entryIndex).siblings } },
      inputs, outputs: outputSlots, openFeeAmount: 10n, issuanceOwnerCommitment: 0n, validUntilTimestamp: 999_999n, dummyInputSeed: 345n,
    });
  }
  const witnessOf = (build: AssetActionBuild) => depositMintWitness({ ...params, mint: build });

  it("accepts the deposit's one marker and one output of its amount", () => {
    expect(witnessOf(mint([replayId], [AMOUNT])).account_address).toBe(fieldToHex(wallet.address));
  });

  it.each([
    ["a second marker", [replayId, 5n]],
    ["a marker keyed by another salt", [depositReplayId(100, 9, fixture.salt + 1n)]],
    ["a marker keyed by another log position", [depositReplayId(100, 10, fixture.salt)]],
    ["a marker keyed by the log's index within its receipt", [depositReplayId(100, 2, fixture.salt)]],
  ])("refuses a mint with %s", (_name, replayIds) => {
    expect(() => witnessOf(mint(replayIds, [AMOUNT])))
      .toThrow("a deposit mint carries exactly one mint marker, keyed by the deposit's replay ID");
  });

  it("refuses a second asset output or another amount", () => {
    expect(() => witnessOf(mint([replayId], [AMOUNT - 1n, 1n]))).toThrow("a deposit mint carries exactly one asset output");
    expect(() => witnessOf(mint([replayId], [AMOUNT - 1n]))).toThrow("a deposit mint's asset output must be the deposited amount");
  });
});
