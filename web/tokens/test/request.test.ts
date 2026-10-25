import assert from "node:assert/strict";
import test from "node:test";
import { CIRCUIT_URLS } from "@pcash/sdk/browser-prover/requests";
import { authorizePcashRequestWithPrivateKey } from "@pcash/sdk/eip712";
import { decodePayload, decryptEnvelope, generateMlKemKeyPair, networkForChain } from "@pcash/sdk/protocol";
import {
  TOKENS_CIRCUIT_PROFILES,
  TOKENS_CIRCUITS,
  buildClaimLinkSpend,
  claimLinkSpendSpec,
  planClaimLinks,
  sponsoredTemplatePrimary,
  templateProofRequest,
  type TemplateAction,
} from "../src/index.ts";
import { CHAIN_ID, SyntheticChain } from "./chain.ts";
import { giveNote, registerUser, testToken, testUser, userAuthorization } from "./wallets.ts";

const { definition, assetId } = testToken(5n);

function linkSpend(sponsored: boolean, feeChangeReceiveKey?: Uint8Array): TemplateAction {
  const chain = new SyntheticChain();
  const payer = testUser(3);
  registerUser(chain, payer);
  const plan = planClaimLinks({ creatorSecret: 5n, assetId, amounts: [100n] });
  const contractIndex = chain.addContract(plan.contract);
  const link = plan.links[0]!;
  const leafIndex = chain.appendBody(0n);
  const fee = giveNote(chain, payer, 0n, 50n, 0xfeen);
  chain.seal();
  const rule = payer.rules.contractFeeSponsorshipRule;
  return buildClaimLinkSpend({
    contract: plan.contract,
    pcashChainId: CHAIN_ID,
    snapshot: chain.snapshot(),
    contractOpening: { accountIndex: contractIndex, accountSiblings: chain.accountSiblings(contractIndex) },
    notes: [{ linkKey: link.linkKey, leafIndex, amount: link.amount, siblings: chain.outputSiblings(leafIndex) }],
    recipient: { address: payer.address, receiveKey: payer.mlKemPublicKey },
    role: sponsored
      ? {
          kind: "sponsored",
          feePayer: userAuthorization(chain, payer, rule),
          feePayerWallet: payer,
          feeChangeReceiveKey: feeChangeReceiveKey ?? payer.mlKemPublicKey,
          network: networkForChain(CHAIN_ID),
          nativeInputs: [{ ...fee, siblings: chain.outputSiblings(fee.leafIndex) }],
          openFeeAmount: 5n,
        }
      : { kind: "transfer" },
    assetDefinition: definition,
    validUntilTimestamp: chain.timestamp + 600n,
  });
}

test("a transfer-role action proves through the transfer kernel with its template circuit", () => {
  const action = linkSpend(false);
  assert.equal(action.role, "transfer");
  if (action.role !== "transfer") return;
  const request = templateProofRequest(action);
  assert.equal(request.operation, "transfer");
  if (request.operation !== "transfer") return;
  assert.equal(request.authorization.circuitUrl, TOKENS_CIRCUITS.claimLink);
  assert.ok(TOKENS_CIRCUIT_PROFILES[request.authorization.circuitUrl]);
  assert.deepEqual(request.expectedPublicInputs, action.build.publicInputs);
  assert.equal(request.authorization.witnessMap.fee_paid, false);
});

test("a sponsored action pairs the template circuit with the payer's sponsorship rule", () => {
  const action = linkSpend(true);
  assert.equal(action.role, "sponsored");
  if (action.role !== "sponsored") return;
  assert.throws(() => templateProofRequest(action, undefined as never), /fee payer/);
  const payer = testUser(3);
  const signed = action.sponsorship.authorize(authorizePcashRequestWithPrivateKey(payer.privKey, action.sponsorship.request));
  const request = templateProofRequest(action, signed.witnessMap);
  assert.equal(request.operation, "sponsored-transfer");
  if (request.operation !== "sponsored-transfer") return;
  assert.equal(request.primary.circuitUrl, TOKENS_CIRCUITS.claimLink);
  assert.equal(request.feePayer.circuitUrl, CIRCUIT_URLS.account_rule_contract_fee_sponsorship_ecdsa);
  assert.equal(request.primary.witnessMap.fee_paid, true);
  assert.deepEqual(request.expectedPublicInputs, action.build.publicInputs);
});

test("wallet-sponsored claim side reuses the payout opening for output and journal", () => {
  const chain = new SyntheticChain();
  const recipient = testUser(8);
  registerUser(chain, recipient);
  const plan = planClaimLinks({ creatorSecret: 9n, assetId, amounts: [100n] });
  const accountIndex = chain.addContract(plan.contract);
  const leafIndex = chain.appendBody(0n);
  chain.seal();
  const spec = claimLinkSpendSpec({
    contract: plan.contract,
    pcashChainId: CHAIN_ID,
    snapshot: chain.snapshot(),
    contractOpening: { accountIndex, accountSiblings: chain.accountSiblings(accountIndex) },
    notes: [{ ...plan.links[0]!, leafIndex, siblings: chain.outputSiblings(leafIndex) }],
    recipient: { address: recipient.address, receiveKey: recipient.mlKemPublicKey },
    role: { kind: "transfer" },
    assetDefinition: definition,
    validUntilTimestamp: chain.timestamp + 600n,
  });
  const side = sponsoredTemplatePrimary(spec, { circuitUrl: TOKENS_CIRCUITS.claimLink, label: "claim-link function" }, [0]);
  const nullifiers = [1n, 2n, 3n, 4n];
  const { outputs, ownedOutputs: owned } = side.realizeOutputs(nullifiers);
  assert.equal(outputs.length, 1);
  assert.equal(owned.length, 1);
  assert.equal(owned[0]!.slot, 0);
  assert.equal(owned[0]!.noteSecret, spec.assetOutputs(nullifiers)[0]!.noteSecret);
  const foreign = sponsoredTemplatePrimary(spec, { circuitUrl: TOKENS_CIRCUITS.claimLink, label: "claim-link function" }, []);
  assert.deepEqual(foreign.realizeOutputs(nullifiers).ownedOutputs, []);
});


test("sponsored template fee change uses the supplied current key instead of the payer profile", () => {
  const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(63));
  const action = linkSpend(true, rotated.publicKey);
  if (action.role !== "sponsored" || action.change === null) throw new Error("test requires sponsorship change");
  const envelope = action.build.outputData[action.change.slot]!;
  assert.equal(decryptEnvelope(testUser(3).mlKemSecretKey, envelope), null);
  const plaintext = decryptEnvelope(rotated.secretKey, envelope);
  assert.ok(plaintext);
  const payout = decodePayload(plaintext, { chainId: CHAIN_ID });
  assert.equal(payout.amount, 45n);
  assert.equal(payout.owner, testUser(3).address);
});
