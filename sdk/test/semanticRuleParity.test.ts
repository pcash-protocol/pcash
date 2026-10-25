import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  ASSET_CREATION_EIP712_TYPE,
  ASSET_BURN_EIP712_TYPE,
  ASSET_PAYMENT_EIP712_TYPE,
  BATCH_TRANSFER_EIP712_TYPE,
  CONTRACT_FEE_SPONSORSHIP_EIP712_TYPE,
  assetBurnTypedData,
  assetCreationTypedData,
  assetPaymentTypedData,
  batchTransferTypedData,
  contractFeeSponsorshipTypedData,
} from "../src/rules/semanticRules.ts";
import {
  PAYMENT_EIP712_TYPE,
  TRANSACTION_DETAIL_EIP712_TYPE,
  paymentTypedData,
} from "../src/rules/readableRules.ts";
import { accountUpdateTypedData, pcashSigningHash, pcashTypedData, signDigest } from "../src/eip712/eip712.ts";
import { assetCreationMarker, standardFungibleAssetId } from "../src/protocol/asset.ts";
import {
  noteBodyCommitment,
  nullifierKeyCommitment,
  outputCommitment,
  ownerCommitment,
} from "../src/protocol/notes.ts";
import { payoutTransactionContext } from "../src/protocol/payout.ts";
import { privateValueCommitment, SlotClass } from "../src/protocol/transaction.ts";

const CIRCUITS = join(import.meta.dirname, "../../circuits");

/**
 * Pull the `global <NAME>: [u8; <length>] = [ ... ];` literal out of a Noir source.
 * The circuits hard-code their type hashes so the signing hash is fixed at
 * compile time; this is the only thing that keeps those literals honest.
 */
function noirBytes(relativePath: string, name: string, length = 32): Uint8Array {
  const source = readFileSync(join(CIRCUITS, relativePath), "utf8");
  const match = source.match(
    new RegExp(`global\\s+${name}:\\s*\\[u8;\\s*${length}\\]\\s*=\\s*\\[([^\\]]*)\\]`),
  );
  if (match === null) throw new Error(`${name} not found in ${relativePath}`);
  const bytes = match[1]!
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 16));
  if (bytes.length !== length) throw new Error(`${name} is not ${length} bytes in ${relativePath}`);
  return Uint8Array.from(bytes);
}

const CASES: ReadonlyArray<[string, string, string, string]> = [
  [
    "PcashAssetCreation",
    "rules/lib/src/generated/reference_rule_constants.nr",
    "S_ASSET_CREATION_TYPE_HASH",
    ASSET_CREATION_EIP712_TYPE,
  ],
  [
    "PcashPayment",
    "rules/payment/src/main.nr",
    "PAYMENT_TYPE_HASH",
    PAYMENT_EIP712_TYPE,
  ],
  [
    "PcashAssetPayment",
    "rules/asset_payment/src/main.nr",
    "ASSET_PAYMENT_TYPE_HASH",
    ASSET_PAYMENT_EIP712_TYPE,
  ],
  [
    "PcashAssetBurn",
    "rules/asset_burn/src/main.nr",
    "ASSET_BURN_TYPE_HASH",
    ASSET_BURN_EIP712_TYPE,
  ],
  [
    "PcashBatchTransfer",
    "rules/lib/src/generated/reference_rule_constants.nr",
    "S_BATCH_TRANSFER_TYPE_HASH",
    BATCH_TRANSFER_EIP712_TYPE,
  ],
  [
    "PcashContractInteraction",
    "rules/lib/src/contract_fee_sponsorship.nr",
    "CONTRACT_FEE_SPONSORSHIP_TYPE_HASH",
    CONTRACT_FEE_SPONSORSHIP_EIP712_TYPE,
  ],
  [
    "PcashTransactionDetail",
    "fixtures/full_transaction/src/main.nr",
    "TRANSACTION_DETAIL_TYPE_HASH",
    TRANSACTION_DETAIL_EIP712_TYPE,
  ],
];

describe("semantic rule EIP-712 parity", () => {
  for (const [primaryType, path, globalName, typeString] of CASES) {
    it(`${primaryType} matches the circuit's compiled type hash`, () => {
      expect(Buffer.from(noirBytes(path, globalName)).toString("hex"))
        .toBe(Buffer.from(keccak_256(new TextEncoder().encode(typeString))).toString("hex"));
    });

    it(`${primaryType} type string starts with its primary type and has no whitespace`, () => {
      expect(typeString.startsWith(`${primaryType}(`)).toBe(true);
      expect(typeString.endsWith(")")).toBe(true);
      expect(/\s/.test(typeString.slice(primaryType.length + 1, -1).replace(/ /g, "")))
        .toBe(false);
      // EIP-712 encodeType puts exactly one space between type and name, and
      // nothing else: no newlines, no double spaces, no trailing comma.
      expect(typeString).not.toMatch(/\n|\r|\t|, | {2}|,\)/);
    });
  }

  it("every semantic message binds pcashChainId", () => {
    for (const [, , , typeString] of CASES) {
      expect(typeString).toContain("uint256 pcashChainId");
    }
  });

  it("semantic messages omit balances and full private-value commitments", () => {
    for (const [primaryType, , , typeString] of CASES) {
      if (primaryType === "PcashTransactionDetail") continue;
      for (const banned of [
        "privateValueCommitment",
        "authorizingAddress",
        "changeAmount",
        "changeOwnerCommitment",
        "actionCommitment",
      ]) {
        expect(typeString, `${primaryType} must not sign ${banned}`).not.toContain(banned);
      }
    }
  });

  it("the type hashes are pairwise distinct so a signature cannot cross rules", () => {
    const hashes = CASES.map(([, , , typeString]) => Buffer.from(keccak_256(new TextEncoder().encode(typeString))).toString("hex"));
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

// The committed signatures of the Noir signed tests, re-derived from the typed
// data the wallet signs. Each signed test proves under its signature, so the
// circuit hashes the digest this message signs. A mismatch prints the signature
// to commit.
describe("signed-test signatures", () => {
  const signingKey = new Uint8Array(32);
  signingKey.set([0x7e, 0x57], 30);
  const SIGNER = 0xaba220742442621625bb1160961d2cfcb64c7682n;
  const RECIPIENT = 0x2222222222222222222222222222222222222222n;
  const pcashChainId = 1346589512n;
  // TEST_CONFIGURATION's domain.
  const network = {
    pcashChainId,
    l1ChainId: 11155111n,
    inboxAddress: 0x5043534800000000000000000000000000000000n,
  };
  const nullifiers = [0x81n, 0x82n, 0x83n, 0x84n];
  const terms = {
    openFeeAmount: 5n,
    issuanceRecipient: 0n,
    issuanceOwnerCommitment: 0n,
    relayFeeAmount: 0n,
    relayFeeOwnerCommitment: 0n,
    transactionContext: payoutTransactionContext(pcashChainId, nullifiers),
    notBefore: 0n,
    validUntil: 2000000000n,
  };
  const undeclared = { recipient: 0n, amount: 0n, assetId: 0n };

  // `signed_case` in fixtures/full_transaction/src/main.nr.
  const detailTypedData = () => {
    const owner = SIGNER;
    const spentAssetId = 0x7777n;
    const spentAssetAmount = 900n;
    const issuanceRecipient = 0x3333333333333333333333333333333333333333n;
    const issuanceOwnerCommitment = ownerCommitment(issuanceRecipient, 0x5101n);
    const outputs = [0n, 1n, 2n, 3n, 4n].map((i) => ({
      recipient: 0x2222222222222222222222222222222222222222n + i,
      amount: 100n + i,
      assetId: 0x7701n + i,
      noteSecret: 0x5001n + i,
    }));
    const privateValue = {
      global: {
        openFeeAmount: 0n,
        issuanceOwnerCommitment,
        notBeforeTimestamp: 10n,
        validUntilTimestamp: 2000000000n,
        carrierContextHash: 0n,
        assetBurnAmount: 7n,
        deliveryCommitment: 0x61n,
      },
      inputs: [
        {
          slotClass: SlotClass.ASSET,
          inputCommitment: outputCommitment(
            noteBodyCommitment(ownerCommitment(owner, 0x6001n), spentAssetId, spentAssetAmount),
            41n,
          ),
          nullifier: nullifiers[0]!,
        },
        { slotClass: SlotClass.NATIVE, inputCommitment: 0x72n, nullifier: nullifiers[1]! },
        { slotClass: SlotClass.DUMMY, inputCommitment: 0n, nullifier: nullifiers[2]! },
        { slotClass: SlotClass.DUMMY, inputCommitment: 0n, nullifier: nullifiers[3]! },
      ],
      outputs: outputs.map((output) => ({
        slotClass: SlotClass.ASSET,
        outputBodyCommitment: noteBodyCommitment(
          ownerCommitment(output.recipient, output.noteSecret),
          output.assetId,
          output.amount,
        ),
      })),
    };
    const message = {
      pcashChainId,
      authorizingAddress: SIGNER,
      spentAssetId,
      spentAssetAmount,
      assetBurnAmount: 7n,
      ...Object.fromEntries(outputs.flatMap((output, index) => [
        [`out${index}Recipient`, output.recipient],
        [`out${index}Amount`, output.amount],
        [`out${index}AssetId`, output.assetId],
      ])),
      openFeeAmount: 0n,
      issuanceRecipient,
      issuanceOwnerCommitment,
      transactionContext: payoutTransactionContext(pcashChainId, nullifiers),
      notBefore: 10n,
      validUntil: 2000000000n,
      privateValueCommitment: privateValueCommitment(privateValue),
    };
    return pcashTypedData(network, TRANSACTION_DETAIL_EIP712_TYPE, message);
  };

  // `run_signed_creation` in rules/lib/src/asset_creation.nr.
  const creationTypedData = () => {
    const assetId = standardFungibleAssetId({ metadataCommitment: 6n, initialSupply: 100n, assetSecretCommitment: 7n });
    return assetCreationTypedData(network, {
      pcashChainId,
      assetId,
      metadataCommitment: 6n,
      initialSupply: 100n,
      assetSecretCommitment: 7n,
      outputs: [{ recipient: RECIPIENT, amount: 100n, assetId }, undeclared, undeclared, undeclared, undeclared],
      ...terms,
      openFeeAmount: 0n,
      transactionContext: payoutTransactionContext(pcashChainId, [assetCreationMarker(assetId, 8n), 11n, 12n, 13n]),
      validUntil: 1000n,
    });
  };

  // Each row is the message its Noir signed test proves.
  const SIGNED: ReadonlyArray<[string, string, () => { primaryType: string }]> = [
    ["rules/payment/src/main.nr", "SIGNED_PAYMENT_SIGNATURE", () =>
      paymentTypedData(network, { pcashChainId, recipient: RECIPIENT, amount: 1000n, ...terms })],
    ["rules/asset_payment/src/main.nr", "SIGNED_ASSET_PAYMENT_SIGNATURE", () =>
      assetPaymentTypedData(network, { pcashChainId, assetId: 0x7777n, recipient: RECIPIENT, amount: 1000n, ...terms })],
    ["rules/asset_burn/src/main.nr", "SIGNED_BURN_SIGNATURE", () =>
      assetBurnTypedData(network, { pcashChainId, assetId: 0x7777n, burnAmount: 600n, ...terms })],
    ["rules/lib/src/contract_fee_sponsorship.nr", "SIGNED_SPONSORSHIP_SIGNATURE", () =>
      contractFeeSponsorshipTypedData(network, { pcashChainId, sponsoredContract: RECIPIENT, ...terms, openFeeAmount: 500n })],
    ["rules/lib/src/batch_transfer.nr", "SIGNED_BATCH_SIGNATURE", () =>
      batchTransferTypedData(network, {
        pcashChainId,
        assetId: 0n,
        assetBurnAmount: 0n,
        outputs: [{ recipient: RECIPIENT, amount: 1000n, assetId: 0n }, undeclared, undeclared, undeclared, undeclared],
        ...terms,
      })],
    ["rules/lib/src/asset_creation.nr", "SIGNED_CREATION_SIGNATURE", creationTypedData],
    // `run_signed_update` in rules/admin/src/main.nr.
    ["rules/admin/src/main.nr", "SIGNED_UPDATE_SIGNATURE", () =>
      accountUpdateTypedData(network, {
        pcashChainId,
        account: SIGNER,
        currentAccountRevision: 7n,
        nullifierKeyCommitment: nullifierKeyCommitment(0x999n),
        currentRuleSetCommitment: 6n,
        currentReceiveKeyHash: 8n,
        newRuleSetCommitment: 10n,
        newReceiveKeyHash: 0n,
        openFeeAmount: 500n,
        relayFeeAmount: 0n,
        relayFeeOwnerCommitment: 0n,
        transactionContext: terms.transactionContext,
        notBefore: 0n,
        validUntil: 12n,
      })],
    ["fixtures/full_transaction/src/main.nr", "SIGNED_DETAIL_SIGNATURE", detailTypedData],
  ];

  for (const [path, globalName, typedData] of SIGNED) {
    it(`${globalName} is TEST_SIGNING_KEY's over the SDK's message`, () => {
      const digest = pcashSigningHash(typedData() as Parameters<typeof pcashSigningHash>[0]);
      expect(Buffer.from(signDigest(signingKey, digest).compact).toString("hex"))
        .toBe(Buffer.from(noirBytes(path, globalName, 64)).toString("hex"));
    });
  }
});
