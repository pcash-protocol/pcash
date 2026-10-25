import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { SelectedRelayHttpClient, inspectPrivateRelayValue } from "@pcash/sdk/relay";
import { transactionIdentity } from "@pcash/sdk/protocol";
import { fromHex } from "@pcash/sdk/utils";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { scanWallet } from "@pcash/sdk/wallet/scanning";
import { createServer } from "node:http";
import { selectedRelayHandler } from "@pcash/relayer/selected-service";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { assertSystemPayoutRecovered } from "./payouts.ts";
import { setupUserWallets } from "./setup.ts";

/** A selected relayer receives an encrypted native fee and separately owns the quoted issuance commitment. */
export async function runSelectedRelayScenario(fixture: ScenarioFixture): Promise<void> {
  await setupUserWallets(fixture, { actors: ["S", "M"], accounts: ["M"], funded: ["S"] });
  const sender = fixture.actors.S;
  const recipient = fixture.actors.M;
  if (sender === undefined || recipient === undefined) throw new Error("selected relay actors are missing");
  const node = fixture.nodeA.client;
  const network = fixture.network;
  const relayerKey = fixture.harness.privateKey;
  const relayer = derivePcashProfileFromPrivateKey(fromHex(relayerKey), network);
  const handler = selectedRelayHandler({
    node, profile: relayer,
    signer: privateKeyPcashActionSigner(fromHex(relayerKey)),
    minPrivateFee: 1n, minValuePerByte: 0n, maxQuoteLifetimeSeconds: 3600n,
  });
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch((cause) => {
      response.writeHead(500); response.end(String(cause));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const listening = server.address();
  if (listening === null || typeof listening === "string") throw new Error("selected relayer HTTP listener has no port");
  const session = await SelectedRelayHttpClient.connect(`http://127.0.0.1:${listening.port}`);
  let contentHash: string;
  let exactEntry: Uint8Array;
  let privateFeeAmount: bigint;
  try {
    const spendable = await sender.balance();
    if (spendable < 10n) throw new Error("sender has no native note for a selected relay payment");
    privateFeeAmount = spendable / 20n;
    // Admit only: the selected relayer must find the paying entry in the public mempool itself.
    const sent = await (await sender.client()).send({
      to: recipient.address,
      amount: spendable / 4n,
      openFeeAmount: 0n,
      privateRelayFeeAmount: privateFeeAmount,
      selectedRelayQuote: session,
      submission: fixture.harness.mempool({ relay: false }),
    });
    contentHash = sent.contentHash;
    exactEntry = fromHex(sent.transactionHex);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
  if (transactionIdentity(exactEntry).contentHash !== contentHash) {
    throw new Error("selected relay did not retain one exact quoted transaction");
  }
  const retained = await node.getMempoolTransaction(contentHash);
  if (retained?.status.toLowerCase() !== "ready") throw new Error("selected transaction was not admitted to the public mempool");
  const status = await node.status();
  const fee = inspectPrivateRelayValue({
    transactionBytes: exactEntry,
    status,
    recipient: relayer,
  });
  if (fee.nativeAmount !== privateFeeAmount || fee.issuanceOwnerCommitment === null
    || !fee.nativeOutputSlots.includes(4)) {
    throw new Error("public mempool entry did not carry the selected relayer's private fee and issuance");
  }
  // An automatic scan, not an exact relay: the private fee is what makes the entry worth taking.
  const relay = await fixture.harness.relay({}, fixture.harness.relayerWith({ minPrivateFee: 1n }));
  if (!relay.selectedContentHashes.some((hash) => hash.toLowerCase() === contentHash.toLowerCase())) {
    throw new Error("relayer scan did not select the private-fee transaction");
  }
  await fixture.waitForAcceptedAcrossNodes(contentHash, "selected-relay-transfer");
  const settled = await assertSystemPayoutRecovered({
    node, chainId: network.pcashChainId, contentHash,
    label: "selected-relay-transfer", sourceKind: "designatedIssuance", recipient: relayer,
  });
  if (settled.receipt.settledOpenFeeAmount !== 0n || settled.receipt.settledIssuanceAmount === 0n) {
    throw new Error("selected relay settled an unexpected public fee or no issuance");
  }
  const recovered = (await scanWallet(node, relayer, network.pcashChainId)).recovered;
  if (!recovered.some((note) => note.amount === privateFeeAmount && note.owner === relayer.address)) {
    throw new Error("selected relayer did not recover its private fee note");
  }
  fixture.artifacts.record("selected-relay-complete", {
    contentHash,
    privateFeeAmount: privateFeeAmount.toString(),
    privateFeeOutputSlots: fee.nativeOutputSlots,
    issuanceOwnerCommitment: fee.issuanceOwnerCommitment.toString(),
  });
}
