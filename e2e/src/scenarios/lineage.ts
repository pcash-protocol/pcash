import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arch, cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { createPublicClient, http, type TransactionReceipt } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { fullOutputCommitment, transactionIdentity } from "@pcash/sdk/protocol";
import { fromHex, toHex, randomFieldEntropy } from "@pcash/sdk/utils";
import { proveTransferTransactionChonk, prepareEventApplication } from "@pcash/sdk/prover";
import { createReleaseChonkCircuitResolver, nativeChonkBackend } from "@pcash/sdk/node";
import { type ResultPosition } from "@pcash/sdk/clients";
import { buildPolicy, claimEvent, type LineagePolicy } from "@pcash/lineage";
import { handoffSchema, LineageStore, type Handoff } from "@pcash/lineage";
import { recoverLineageOutput, restoreLineageFromNode } from "@pcash/lineage";
import { buildLineageWitness } from "@pcash/lineage";
import { ScenarioActor } from "../actors/actor.ts";
import { buildLatestUserTransfer, listSpendableNotes, type SpendableNote } from "../actors/sdk.ts";
import { eventually } from "../framework/eventually.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { setupUserWallets } from "./setup.ts";

interface EvidenceRef { blockNumber: bigint; position: ResultPosition; handoff?: Handoff }
interface HeldNote { note: SpendableNote; commitment: bigint; evidence: EvidenceRef }
interface Publication { receipt: TransactionReceipt; root: bigint }
const json = (value: unknown) => JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2);

function backupKey(actor: ScenarioActor, policy: LineagePolicy): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(actor.wallet.nkRoot.toString(16).padStart(64, "0"), "hex"),
    Buffer.from(policy.root.toString(16).padStart(64, "0"), "hex"), Buffer.from("pcash-lineage-backup"), 32));
}
function encryptBackup(store: LineageStore, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(store.export(), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}
function restoreBackup(bytes: Buffer, key: Buffer): LineageStore {
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return LineageStore.restore(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
}

async function source(fixture: ScenarioFixture, actor: ScenarioActor, selected?: SpendableNote): Promise<HeldNote> {
  const note = selected ?? (await listSpendableNotes(fixture.nodeA.client, actor.wallet, fixture.network.pcashChainId))[0];
  assert.ok(note, `${actor.name} must recover its issuance note`);
  const page = await fixture.nodeA.client.getPayouts({ fromBlock: 0n, limit: 256 });
  const record = page.records.find(row => row.outputIndex === note.leafIndex);
  assert.ok(record, "source payout record missing");
  assert.equal(record.component, "issuance");
  assert.ok(record.amount > 0n);
  const block = await fixture.nodeA.client.getBlockPayouts(record);
  assert.ok(block);
  const payoutIndex = block.payouts.findIndex(row => row.outputIndex === note.leafIndex);
  assert.ok(payoutIndex >= 0);
  return { note, commitment: fullOutputCommitment({ ...note, owner: actor.wallet.address }, note.leafIndex),
    evidence: { blockNumber: record.blockNumber, position: { payoutIndex: BigInt(payoutIndex) } } };
}

function deployProvider(fixture: ScenarioFixture): `0x${string}` {
  assert.ok(fixture.backend.anvil && fixture.mode === "local", "lineage deployment is local Anvil only");
  const output = execFileSync("forge", ["create", "--root", join(fixture.repoRoot, "lineage/l1-contracts"),
    "src/PolicyRoot.sol:PolicyRoot", "--rpc-url", fixture.backend.rpcUrl, "--unlocked", "--from", fixture.harness.address,
    "--broadcast", "--json"], { encoding: "utf8" });
  const deployment = JSON.parse(output.slice(output.indexOf("{"))) as { deployedTo: `0x${string}` };
  assert.match(deployment.deployedTo, /^0x[0-9a-fA-F]{40}$/);
  return deployment.deployedTo;
}

async function publishRoot(fixture: ScenarioFixture, provider: string, root: bigint): Promise<Publication> {
  const output = execFileSync("cast", ["send", provider, "publish(uint256)", root.toString(), "--rpc-url", fixture.backend.rpcUrl,
    "--unlocked", "--from", fixture.harness.address, "--json"], { encoding: "utf8" });
  const response = JSON.parse(output) as { transactionHash: `0x${string}` };
  const client = createPublicClient({ transport: http(fixture.backend.rpcUrl) });
  const receipt = await client.waitForTransactionReceipt({ hash: response.transactionHash });
  assert.equal(receipt.status, "success");
  assert.equal(receipt.logs.length, 1);
  return { receipt, root };
}

async function publicationProof(fixture: ScenarioFixture, publication: Publication, recent: bigint) {
  const log = publication.receipt.logs[0]!;
  return fixture.nodeA.client.getL1LogProof(recent, publication.receipt.blockNumber, publication.receipt.transactionIndex, 0n, {
    transactionIndex: publication.receipt.transactionIndex, logIndex: 0n, emitter: BigInt(log.address),
    topics: log.topics.map(topic => fromHex(topic)), data: fromHex(log.data),
  });
}

/** Each receiver opens its own wallet and receives only a serialized event opening plus public coordinates. */
async function receive(fixture: ScenarioFixture, actor: ScenarioActor, path: string, policy: LineagePolicy, trustedVk: bigint): Promise<HeldNote> {
  const delivered = JSON.parse(await readFile(path, "utf8")) as {
    blockNumber: string; transactionIndex: string; outputIndex: string; commitment: string; outputData: string[]; arena: string; nullifiers: string[]; outputSlot: number;
  };
  const note = await eventually(`${actor.name} receives lineage note`, async () =>
    (await listSpendableNotes(fixture.nodeA.client, actor.wallet, fixture.network.pcashChainId)).find(candidate => candidate.leafIndex === BigInt(delivered.outputIndex)),
  value => value !== undefined, { timeoutMs: 60_000 });
  assert.ok(note);
  const commitment = fullOutputCommitment({ ...note, owner: actor.wallet.address }, note.leafIndex);
  assert.equal(commitment, BigInt(delivered.commitment));
  const status = await fixture.nodeA.client.status();
  const recentHash = BigInt(status.latestBlockHash);
  const position = { pcashTransactionIndex: BigInt(delivered.transactionIndex) };
  const storePath = join(actor.walletDatabasePath, "..", "lineage.backup");
  const key = backupKey(actor, policy);
  let store: LineageStore;
  try { store = restoreBackup(await readFile(storePath), key); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    store = new LineageStore();
  }
  const handoff = await recoverLineageOutput({ node: fixture.nodeA.client, chainId: fixture.network.pcashChainId, recentHash, policy, trustedVk, store,
    owners: [actor.wallet.address], mlKemSecretKeys: [actor.wallet.mlKemSecretKey], candidate: { blockNumber: BigInt(delivered.blockNumber),
      position, outputIndex: note.leafIndex, outputSlot: delivered.outputSlot, commitment,
      outputData: delivered.outputData.map((item) => fromHex(item)), arena: fromHex(delivered.arena), nullifiers: delivered.nullifiers.map(BigInt) } });
  assert.ok(handoff, "receiver must independently recover authenticated lineage from its encrypted note");
  await writeFile(storePath, encryptBackup(store, key), { mode: 0o600 });
  await actor.close();
  assert.ok(await actor.balance() >= note.amount);
  const restored = restoreBackup(await readFile(storePath), key);
  assert.deepEqual(restored.get(commitment), handoff);
  assert.equal(new LineageStore().get(commitment), undefined);
  fixture.artifacts.record("lineage-restored", { actor: actor.name, commitment, encryptedBackupBytes: (await readFile(storePath)).length,
    recoveredSpendability: true, provenanceReconstructibleFromEncryptedOutput: true });
  return { note, commitment, evidence: { blockNumber: BigInt(delivered.blockNumber), position, handoff } };
}

async function transfer(fixture: ScenarioFixture, sender: ScenarioActor, receiver: ScenarioActor, heldInputs: readonly HeldNote[],
  policy: LineagePolicy, publication: Publication, lineageVk: bigint, label: string): Promise<{ received: HeldNote; change: HeldNote }> {
  const node = fixture.nodeA.client;
  const started = performance.now();
  const total = heldInputs.reduce((sum, input) => sum + input.note.amount, 0n);
  const eventSalt = randomFieldEntropy();
  const preparedEvent = await prepareEventApplication({ packageName: "event_lineage", event: claimEvent({ root: policy.root, applicationVkHash: lineageVk, qualificationMask: 3 }), eventSalt, resolve: createReleaseChonkCircuitResolver() });
  const handoffRecord = handoffSchema.encode({ salt: eventSalt, qualificationMask: 3 });
  const build = await buildLatestUserTransfer({ node, network: fixture.network, wallet: sender.wallet, inputNotes: heldInputs.map(input => input.note), preparedEvent, data: { recipients: [receiver, sender].map(actor => ({ recipientAddress: actor.wallet.address, receiveKey: actor.wallet.mlKemPublicKey, records: [handoffRecord] })) },
    recipientAddress: receiver.wallet.address, recipientReceiveKey: receiver.wallet.mlKemPublicKey,
    amount: total / 2n, openFeeAmount: 0n, defaultRuleSecrets: sender.wallet.defaultUserRuleSecrets, signer: sender.signer });
  const [proofs, publicationOpening] = await Promise.all([
    Promise.all(heldInputs.map(held => node.getResultProof(build.recentPcashBlockHash, held.evidence.blockNumber, held.evidence.position))),
    publicationProof(fixture, publication, build.recentPcashBlockHash),
  ]);
  assert.ok(proofs.every(proof => proof !== null));
  const retrieved = performance.now();
  const application = buildLineageWitness({ build, preparedEvent, policy, lineageVk, publication: publicationOpening, rootSequence: 1n,
    inputs: Array.from({ length: 4 }, (_, index) => {
      const held = heldInputs[index];
      return held === undefined ? null : { commitment: held.commitment, proof: proofs[index]!, ...(held.evidence.handoff === undefined ? {} : { handoff: held.evidence.handoff }) };
    }) });
  assert.ok(build.accountRuleWitnessMap);
  const assembled = performance.now();
  const proved = await proveTransferTransactionChonk({ build, eventApplication: application, authorizationPackage: build.authorizationCircuit,
    authorizationWitnessMap: build.accountRuleWitnessMap, resolve: createReleaseChonkCircuitResolver(), backend: nativeChonkBackend() });
  const provedAt = performance.now();
  const entry = build.encodeTransaction(proved.proof);
  await fixture.harness.publish(entry, sender.wallet, "calldata");
  const contentHash = transactionIdentity(entry).contentHash;
  const accepted = await fixture.waitForAcceptedAcrossNodes(contentHash, label);
  const transaction = await eventually(label, () => node.getTransaction(accepted.nodeA.transactionId), value => value !== null);
  assert.ok(transaction);
  assert.notEqual(transaction.summary.outputLeafStart, null);
  const start = transaction.summary.outputLeafStart!;
  const deliver = async (actor: ScenarioActor, slot: number): Promise<string> => {
    const outputIndex = start + BigInt(slot);
    const amount = slot === 0 ? total / 2n : total - total / 2n;
    const commitment = fullOutputCommitment({ owner: actor.wallet.address, noteSecret: build.outputNoteSecrets[slot]!, assetId: 0n, amount }, outputIndex);
    assert.deepEqual(handoffSchema.encode(application.handoff(slot)), handoffRecord);
    const payload = { outputSlot: slot, blockNumber: transaction.summary.block.blockNumber,
      transactionIndex: transaction.summary.pcashTransactionIndex, outputIndex, commitment,
      outputData: build.outputData.map((item) => toHex(item)), arena: toHex(build.arena),
      nullifiers: build.transaction.inputs.map((input) => BigInt(input.nullifier)) };
    const path = fixture.artifacts.path("lineage-handoffs", `${label}-${slot}.json`);
    await writeFile(path, json(payload), { mode: 0o600 });
    fixture.artifacts.record("lineage-handoff", { label, slot, recipient: actor.name, bytes: Buffer.byteLength(json(payload)), eventOpeningBytes: 33 });
    return path;
  };
  const received = await receive(fixture, receiver, await deliver(receiver, 0), policy, lineageVk);
  const change = await receive(fixture, sender, await deliver(sender, 1), policy, lineageVk);
  fixture.artifacts.record("lineage-transfer", { label, contentHash, retrievalMs: retrieved - started, assemblyMs: assembled - retrieved,
    provingMs: provedAt - assembled, endToEndMs: performance.now() - started, proofBytes: proved.proof.length, transactionBytes: entry.length,
    lineageProofRetrievalBytes: Buffer.byteLength(json({ proofs, publicationOpening })), lineageProofRequests: heldInputs.length + 1, inputCount: heldInputs.length, eventWitnessBytes: Buffer.byteLength(json(application.witnessMap)),
    nodeQueryDisclosure: "input creating block and result position; provider publication block, transaction and log position" });
  return { received, change };
}

export async function runLineageScenario(fixture: ScenarioFixture): Promise<void> {
  assert.ok(fixture.mode === "local" && fixture.backend.anvil, "lineage uses an isolated local dev chain");
  fixture.artifacts.record("lineage-runtime", { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.repoRoot, encoding: "utf8" }).trim(),
    bundle: process.env.PCASH_CIRCUIT_BUNDLE, nodeVersion: process.version, platform: platform(), osRelease: release(), arch: arch(), cpu: cpus()[0]?.model, phone: false });
  await mkdir(fixture.artifacts.path("lineage-handoffs"), { recursive: true, mode: 0o700 });
  for (const name of ["Alice", "Bob", "Carol", "Dave", "Eve", "Receiver"]) {
    fixture.actors[name] = await ScenarioActor.create({ name, privateKey: generatePrivateKey(), network: fixture.network,
      artifactsRoot: fixture.artifacts.path("actors", name), node: fixture.nodeA.client, harness: fixture.harness });
  }
  await setupUserWallets(fixture, { actors: [], accounts: Object.keys(fixture.actors), funded: ["Alice"] });
  for (let i = 0; i < 3; i++) {
    const mined = await (await fixture.actors.Alice!.client()).send({ to: fixture.actors.Alice!.address, amount: 0n, openFeeAmount: 0n, submission: fixture.harness.l1Batched() });
    await fixture.waitForAcceptedAcrossNodes(mined.contentHash, `alice-source-${i + 2}`);
  }
  const provider = deployProvider(fixture);
  const aliceNotes = await listSpendableNotes(fixture.nodeA.client, fixture.actors.Alice!.wallet, fixture.network.pcashChainId);
  assert.equal(aliceNotes.length, 4);
  const approved = await Promise.all(aliceNotes.map(note => source(fixture, fixture.actors.Alice!, note)));
  const policy = buildPolicy(BigInt(provider), approved.map(input => input.commitment), []);
  const publication = await publishRoot(fixture, provider, policy.root);
  await eventually("root publication in PCASH", async () => publicationProof(fixture, publication, BigInt((await fixture.nodeA.client.status()).latestBlockHash)), () => true, { timeoutMs: 60_000 });
  await writeFile(fixture.artifacts.path("lineage-policy.json"), json({ provider, root: policy.root, approvedSources: policy.sources, deniedOutputs: policy.denied, publication: publication.receipt.transactionHash }), { mode: 0o600 });
  const material = await createReleaseChonkCircuitResolver()("event_lineage", "app");
  const lineageVk = BigInt(material.vkHash);
  const retire = async (name: string) => { await fixture.actors[name]!.close(); delete fixture.actors[name]; fixture.artifacts.record("lineage-holder-unavailable", { name }); };
  const alice = await transfer(fixture, fixture.actors.Alice!, fixture.actors.Bob!, approved, policy, publication, lineageVk, "alice-bob");
  const aliceChange = await transfer(fixture, fixture.actors.Alice!, fixture.actors.Bob!, [alice.change], policy, publication, lineageVk, "alice-change-bob");
  await retire("Alice");
  const bob = await transfer(fixture, fixture.actors.Bob!, fixture.actors.Carol!, [alice.received, aliceChange.received], policy, publication, lineageVk, "bob-carol");
  await retire("Bob");
  const carol = await transfer(fixture, fixture.actors.Carol!, fixture.actors.Dave!, [bob.received], policy, publication, lineageVk, "carol-dave");
  await retire("Carol");
  const dave = await transfer(fixture, fixture.actors.Dave!, fixture.actors.Eve!, [carol.received], policy, publication, lineageVk, "dave-eve");
  await retire("Dave");
  const eve = await transfer(fixture, fixture.actors.Eve!, fixture.actors.Receiver!, [dave.received], policy, publication, lineageVk, "eve-receiver");
  await retire("Eve");
  const restoreAt = await fixture.nodeA.client.status();
  const fresh = await restoreLineageFromNode({ node: fixture.nodeA.client, target: { pcashNumber: restoreAt.latestBlock, pcashHash: restoreAt.latestBlockHash },
    chainId: fixture.network.pcashChainId, wallet: fixture.actors.Receiver!.wallet, policy, trustedVk: lineageVk });
  assert.deepEqual(fresh.store.get(eve.received.commitment), eve.received.evidence.handoff);
  fixture.artifacts.record("lineage-receive-keys-and-node-restored", { scanned: fresh.scanned, qualified: fresh.qualified, usedBackup: false, seedDerivationExercised: false });
  fixture.artifacts.record("lineage-complete", { root: policy.root, lineageVk, terminalCommitment: eve.received.commitment,
    terminalAmount: eve.received.note.amount, phoneValidated: false, handoffTransport: "one 33-byte application record, identical for both qualified outputs, inline in each holder's arena region; the receiver supplies root and VK from its trust context and the slot from its envelope; fixture also serializes the public envelopes, arena, nullifiers and coordinates" });
}
