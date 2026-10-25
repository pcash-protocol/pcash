// Native CHONK proving for template actions, plus the SDK-built transactions
// the scenarios need around them: funding contract inventory and spending a
// claimed note under the default reference rules.

import assert from "node:assert/strict";
import { join } from "node:path";
import { createChonkCircuitResolver, isProverAvailable, nativeChonkBackend } from "@pcash/sdk/node";
import { proveTransferTransactionChonk, proveSponsoredTransferChonk, type ChonkCircuitResolver } from "@pcash/sdk/prover";
import { authorizePcashRequestWithPrivateKey } from "@pcash/sdk/eip712";
import {
  buildAssetAction,
  openedAssetActionOutput,
  outOfBandAssetActionOutput,
  ownerChangeAssetActionOutput,
  type AssetActionBuild,
  type AssetActionOutput,
} from "@pcash/sdk/builders";
import {
  decodePayload,
  decryptEnvelope,
  fullOutputCommitment,
  sizeClassFiller,
  type NotePayload,
} from "@pcash/sdk/protocol";
import { templateProofRequest, type TemplateAction } from "../src/index.ts";
import { nativeTokensProver } from "../src/tooling/nativeProver.mts";
import { CHAIN_ID, type SyntheticChain } from "./chain.ts";
import { userAuthorization, type TestUser } from "./wallets.ts";

const bundle = process.env.PCASH_CIRCUIT_BUNDLE?.trim();
export const proverAvailable = bundle !== undefined && bundle !== "" && isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !proverAvailable) {
  throw new Error("PCASH_REQUIRE_PROVER=1 but the release-pinned proving stack or circuit bundle is unavailable");
}

let resolver: ChonkCircuitResolver | undefined;
function resolve(): ChonkCircuitResolver {
  resolver ??= createChonkCircuitResolver({
    artifactDirectory: join(bundle!, "prover-assets"),
    verificationKeyDirectory: join(bundle!, "vks"),
  });
  return resolver;
}
const backend = nativeChonkBackend(4);

const templateProver = nativeTokensProver({ threads: 4 });

/** Prove a template action through the app's native prover; a sponsored one is signed by its fee payer. */
export async function proveTemplate(action: TemplateAction, feePayer?: TestUser): Promise<Uint8Array> {
  if (action.role === "transfer") {
    return action.build.encodeTransaction((await templateProver.proveAssetAction(templateProofRequest(action))).proof);
  }
  assert.ok(feePayer, "a sponsored action needs its fee payer's key");
  const signed = action.sponsorship.authorize(authorizePcashRequestWithPrivateKey(feePayer.privKey, action.sponsorship.request));
  return action.build.encodeTransaction((await templateProver.proveAssetAction(templateProofRequest(action, signed.witnessMap))).proof);
}

async function proveOwnerAction(build: AssetActionBuild, user: TestUser): Promise<void> {
  const prepared = build.prepareOwnerAuthorization({ wallet: user });
  const signed = prepared.authorize(authorizePcashRequestWithPrivateKey(user.privKey, prepared.request));
  await proveTransferTransactionChonk({
    build,
    authorizationPackage: prepared.authorizationCircuit,
    authorizationWitnessMap: signed.witnessMap,
    resolve: resolve(),
    backend,
  });
}

function dummies(outputs: AssetActionOutput[]): AssetActionOutput[] {
  while (outputs.length < 5) outputs.push({ kind: "dummy", dummySecret: 0xd0n + BigInt(outputs.length), amount: 0n, outputData: sizeClassFiller() });
  return outputs;
}

/**
 * The creator funds contract inventory with its default batch-transfer rule:
 * each note goes to the contract under the template's explicit secret, and
 * the remainder returns to the creator as owner change.
 */
export async function fundContract(chain: SyntheticChain, creator: TestUser, params: {
  assetId: bigint;
  source: { leafIndex: number; noteSecret: bigint; amount: bigint };
  contract: bigint;
  notes: readonly { noteSecret: bigint; amount: bigint }[];
}): Promise<number[]> {
  const sent = params.notes.reduce((sum, note) => sum + note.amount, 0n);
  const outputs = params.notes.map((note) => outOfBandAssetActionOutput({
    kind: "asset",
    recipientAddress: params.contract,
    noteSecret: note.noteSecret,
    amount: note.amount,
    outputData: sizeClassFiller(),
  }));
  if (sent < params.source.amount) {
    outputs.push(ownerChangeAssetActionOutput({
      kind: "asset",
      pcashChainId: CHAIN_ID,
      assetId: params.assetId,
      amount: params.source.amount - sent,
      receiveKey: creator.mlKemPublicKey,
    }));
  }
  const build = buildAssetAction({
    pcashChainId: CHAIN_ID,
    snapshot: chain.snapshot(),
    owner: userAuthorization(chain, creator, creator.rules.batchTransferRule),
    assetId: params.assetId,
    inputs: [
      { kind: "asset", ...params.source, siblings: chain.outputSiblings(params.source.leafIndex) },
      { kind: "dummy" },
      { kind: "dummy" },
      { kind: "dummy" },
    ],
    outputs: dummies(outputs),
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: chain.timestamp + 3_600n,
  });
  await proveOwnerAction(build, creator);
  const leaves = chain.apply(build.publicInputs, build.outputData);
  chain.seal();
  return leaves.slice(0, params.notes.length);
}

/** Spend a held asset note to another user with the default asset-payment rule. */
export async function payAsset(chain: SyntheticChain, sender: TestUser, params: {
  assetId: bigint;
  note: { leafIndex: number; noteSecret: bigint; amount: bigint };
  recipient: TestUser;
}): Promise<number[]> {
  const build = buildAssetAction({
    pcashChainId: CHAIN_ID,
    snapshot: chain.snapshot(),
    owner: userAuthorization(chain, sender, sender.rules.assetPaymentRule),
    assetId: params.assetId,
    inputs: [
      { kind: "asset", ...params.note, siblings: chain.outputSiblings(params.note.leafIndex) },
      { kind: "dummy" },
      { kind: "dummy" },
      { kind: "dummy" },
    ],
    outputs: dummies([openedAssetActionOutput({
      kind: "asset",
      pcashChainId: CHAIN_ID,
      assetId: params.assetId,
      outputIndex: 0,
      amount: params.note.amount,
      recipientAddress: params.recipient.address,
      recipientMlKemPublicKey: params.recipient.mlKemPublicKey,
      authenticatedRecipient: true,
    })]),
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: chain.timestamp + 3_600n,
  });
  await proveOwnerAction(build, sender);
  const leaves = chain.apply(build.publicInputs, build.outputData);
  chain.seal();
  return leaves;
}

/** Trial-decrypt new outputs as the user's wallet scan does, checking each opening. */
export function receive(chain: SyntheticChain, user: TestUser, leaves: readonly number[]): (NotePayload & { leafIndex: number })[] {
  return leaves.flatMap((leafIndex) => {
    const plaintext = decryptEnvelope(user.mlKemSecretKey, chain.outputData[leafIndex]!);
    if (plaintext === null) return [];
    const payload = decodePayload(plaintext, { chainId: CHAIN_ID });
    assert.equal(fullOutputCommitment(payload, leafIndex), chain.outputCommitments[leafIndex], "delivered opening matches the output");
    return [{ ...payload, leafIndex }];
  });
}
