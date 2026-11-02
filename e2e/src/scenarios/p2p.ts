import { access } from "node:fs/promises";
import { join } from "node:path";
import type { RelayerResult, RelayJournalEntry } from "@pcash/sdk/relay";
import type { PeerInfoJson } from "../actors/index.ts";
import type { ScenarioActor } from "../actors/actor.ts";
import { buildAuthorizedReferenceUserAccountCreation, encodeUserAccountCreation } from "../deps.ts";
import { l1Rpc } from "../backends/rpc.ts";
import { eventually } from "../framework/eventually.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** P2P identity and peers, gossip of admitted entries, calldata and blob relays, and relay-journal recovery. */
export async function runP2pScenario(fixture: ScenarioFixture): Promise<void> {
  const nodeA = fixture.local("A");
  const nodeB = fixture.local("B");
  const [nodeAInfo, nodeBInfo] = await Promise.all([
    nodeA.cli.nodeInfo<{ peerId: string; bootstrapAddresses: string[] }>(),
    nodeB.cli.nodeInfo<{ peerId: string; bootstrapAddresses: string[] }>(),
  ]);
  const [nodeAIdentity, nodeBIdentity] = await Promise.all([
    nodeA.cli.p2pKeyInspect(join(nodeA.dataDir, "p2p_identity.pb"), `/ip4/127.0.0.1/tcp/${nodeA.p2pPort}`),
    nodeB.cli.p2pKeyInspect(join(nodeB.dataDir, "p2p_identity.pb"), `/ip4/127.0.0.1/tcp/${nodeB.p2pPort}`),
  ]);
  assertIdentity("node A", nodeAIdentity, nodeAInfo);
  assertIdentity("node B", nodeBIdentity, nodeBInfo);

  const initialPeers = await eventually(
    "peer CLI to report the compatible bootstrap connection",
    () => Promise.all([nodeA.cli.peers(), nodeB.cli.peers()]),
    ([a, b]) => hasCompatiblePeer(a, nodeBInfo.peerId, "inbound")
      && hasCompatiblePeer(b, nodeAInfo.peerId, "outbound"),
    { timeoutMs: 60_000 },
  );

  // A wallet publishes a new account on L1. Admit signed creations through
  // node A instead, so node B's relayer must learn them by gossip; the local
  // node accepts unpaid entries for this sponsored relay.
  const admitCreation = async (actor: ScenarioActor) => {
    const head = await fixture.nodeA.client.status();
    const creation = await buildAuthorizedReferenceUserAccountCreation({
      chainId: fixture.network.pcashChainId,
      network: fixture.network,
      wallet: actor.wallet,
      defaultRuleSecrets: actor.wallet.defaultUserRuleSecrets,
      mlKemPublicKey: actor.wallet.mlKemPublicKey!,
      recentPcashBlockHash: head.latestBlockHash,
      validUntilTimestamp: head.latestBlockTimestamp + 1800n,
    }, actor.signer);
    const admission = await nodeA.cli.submitRaw(toHex(
      encodeUserAccountCreation(fixture.network.pcashChainId, creation.body),
    ));
    return admission.contentHash;
  };
  await fixture.createActors(["S", "B"]);
  const contentHash = await admitCreation(fixture.actors.S!);
  await fixture.waitForPeerCopy(contentHash);

  const relayer = fixture.harness.relayer;
  const [mempool, exact] = await Promise.all([
    relayer.getMempool({ limit: 1, kind: "userAccountCreation", minOpenFee: 0n }),
    relayer.getMempoolTransaction(contentHash),
  ]);
  if (mempool.items.length !== 1 || mempool.items[0]?.contentHash.toLowerCase() !== contentHash.toLowerCase()) {
    throw new Error("mempool filters did not return the submitted user account");
  }
  if (
    exact?.contentHash.toLowerCase() !== contentHash.toLowerCase()
    || exact.kind !== "userAccountCreation"
    || exact.status !== "ready"
    || exact.rawTransaction === null
  ) throw new Error("mempool transaction lookup did not return the exact ready entry");

  const dryRun = await fixture.harness.relay({ contentHashes: [contentHash], noSubmit: true, daMode: "calldata", maxBlobs: 1 });
  assertRelaySelection("dry-run", dryRun, contentHash);
  if (dryRun.submitted || dryRun.carrier !== "calldata" || dryRun.quotes?.selected.carrier !== "calldata") {
    throw new Error("relay dry-run did not quote calldata without submitting");
  }
  if ((await relayer.getMempoolTransaction(contentHash))?.contentHash.toLowerCase() !== contentHash.toLowerCase()) {
    throw new Error("relay dry-run removed the selected transaction");
  }

  const relayed = await fixture.harness.relay({ contentHashes: [contentHash], daMode: "calldata", maxBlobs: 1 });
  assertRelaySelection("submission", relayed, contentHash);
  if (
    !relayed.submitted
    || relayed.carrier !== "calldata"
    || relayed.observed !== true
    || relayed.receipt?.status !== 1
    || !/^0x[0-9a-fA-F]{64}$/.test(relayed.txHash ?? "")
  ) throw new Error("relay did not submit and observe a successful calldata transaction");
  const calldataAccepted = await fixture.waitForAcceptedAcrossNodes(contentHash, "p2p-calldata-relay-account");

  const blobContentHash = await admitCreation(fixture.actors.B!);
  await fixture.waitForPeerCopy(blobContentHash);
  const blobRelay = await fixture.harness.relay({ contentHashes: [blobContentHash], daMode: "blobs", maxBlobs: 1 });
  assertRelaySelection("blob submission", blobRelay, blobContentHash);
  const blobQuote = blobRelay.quotes?.selected;
  if (
    !blobRelay.submitted
    || blobRelay.carrier !== "blobs"
    || blobRelay.observed !== true
    || blobRelay.receipt?.status !== 1
    || !/^0x[0-9a-fA-F]{64}$/.test(blobRelay.txHash ?? "")
    || blobQuote?.carrier !== "blobs"
    || blobQuote.blobCount !== 1
    || blobQuote.blobVersionedHashes.length !== 1
  ) throw new Error("relay did not submit and observe a one-blob transaction");
  const minedBlob = await l1Rpc<{
    type: string;
    input: string;
    blobVersionedHashes?: string[];
  }>(fixture.backend.rpcUrl, "eth_getTransactionByHash", [blobRelay.txHash]);
  if (
    BigInt(minedBlob.type) !== 3n
    || minedBlob.input !== "0x"
    || minedBlob.blobVersionedHashes?.length !== 1
    || minedBlob.blobVersionedHashes[0]?.toLowerCase()
      !== blobQuote.blobVersionedHashes[0]?.toLowerCase()
  ) throw new Error("mined relay was not the quoted EIP-7594 blob transaction");
  const blobAccepted = await fixture.waitForAcceptedAcrossNodes(blobContentHash, "p2p-blob-relay-account");

  const recovery = fixture.harness.recovery();
  const emptyJournal = await recovery.show();
  if (emptyJournal.latched || emptyJournal.entries.length !== 0) {
    throw new Error("successful relay left its durable journal latched");
  }

  // Recreate the entry a host that crashed after broadcast would have left behind.
  const status = fixture.initialStatus;
  const relayQuote = relayed.quotes!.selected;
  const minedRelay = await l1Rpc<{ nonce: string }>(fixture.backend.rpcUrl, "eth_getTransactionByHash", [relayed.txHash]);
  const relayNonce = Number(BigInt(minedRelay.nonce));
  const relayerAccount = privateKeyToAccount(fixture.harness.privateKey);
  const signJournalTransaction = (nonce: number) => relayerAccount.signTransaction({
    chainId: Number(status.l1ChainId),
    type: "eip1559",
    nonce,
    gas: relayQuote.gasLimit,
    maxFeePerGas: relayQuote.maxFeePerGas,
    maxPriorityFeePerGas: relayQuote.maxPriorityFeePerGas,
    to: status.inboxAddress as `0x${string}`,
    value: 0n,
    data: relayed.batch as `0x${string}`,
  });
  const recoveredSignedTransaction = await signJournalTransaction(relayNonce);
  if (keccak256(recoveredSignedTransaction).toLowerCase() !== relayed.txHash!.toLowerCase()) {
    throw new Error("reconstructed relay journal transaction does not match the submitted transaction");
  }
  const recoveredEntry: RelayJournalEntry = {
    kind: "batch",
    createdAt: new Date().toISOString(),
    resolutionId: relayed.txHash!,
    phase: "broadcast_accepted",
    submissionKind: "signed_raw",
    transactionHash: relayed.txHash!,
    signedTransaction: recoveredSignedTransaction,
    previousTransactionHashes: [],
    lastBroadcastBlock: relayed.headCheckedBlock.toString(),
    carrier: relayed.carrier!,
    batch: relayed.batch,
    selected: [contentHash],
    batchItemIndexes: ["0"],
    observationMode: "selected",
    collectibleOpenFee: relayed.collectibleOpenFee.toString(),
    relayerAddress: relayerAccount.address,
    chainId: status.l1ChainId.toString(),
    inboxAddress: status.inboxAddress,
    nonce: relayNonce.toString(),
    gasLimit: relayQuote.gasLimit.toString(),
    maxFeePerGas: relayQuote.maxFeePerGas.toString(),
    maxPriorityFeePerGas: relayQuote.maxPriorityFeePerGas.toString(),
    maxFeePerBlobGas: relayQuote.maxFeePerBlobGas?.toString() ?? null,
    genesisL1Block: status.genesisL1Block.toString(),
    genesisL1BlockHash: status.genesisL1BlockHash,
    headCheckedBlock: relayed.headCheckedBlock.toString(),
    headCheckedBlockHash: relayed.headCheckedBlockHash,
  };
  await fixture.harness.journal.create(recoveredEntry);
  const latched = await recovery.show();
  if (!latched.latched || latched.entries[0]?.transactionHash?.toLowerCase() !== relayed.txHash!.toLowerCase()) {
    throw new Error("relay journal show omitted the durable entry");
  }
  const reconciled = await recovery.reconcile();
  const settled = reconciled.entries[0];
  if (
    reconciled.latched
    || settled?.outcome !== "cleared"
    || settled.transactionHash?.toLowerCase() !== relayed.txHash!.toLowerCase()
    || settled.l1Receipt?.status !== 1
  ) throw new Error("relay journal reconcile did not clear the included L1 transaction");

  const unresolvedNonce = relayNonce + 1_000_000;
  const unresolvedSignedTransaction = await signJournalTransaction(unresolvedNonce);
  const syntheticHash = keccak256(unresolvedSignedTransaction);
  await fixture.harness.journal.create({
    ...recoveredEntry,
    resolutionId: syntheticHash,
    phase: "broadcast_attempted",
    transactionHash: syntheticHash,
    signedTransaction: unresolvedSignedTransaction,
    nonce: unresolvedNonce.toString(),
  });
  const resolved = await recovery.resolve(syntheticHash);
  if (
    resolved.latched
    || resolved.resolutionId.toLowerCase() !== syntheticHash
    || resolved.transactionHash?.toLowerCase() !== syntheticHash
  ) {
    throw new Error("relay journal resolve returned the wrong transaction");
  }
  await access(resolved.archivePath);
  const afterResolution = await recovery.show();
  if (afterResolution.latched || afterResolution.entries.length !== 0) {
    throw new Error("relay journal resolve did not clear the unresolved entry");
  }

  const removed = await nodeB.cli.removePeer(nodeAInfo.peerId);
  if (!removed.removed || removed.banned) throw new Error("remove-peer did not disconnect without banning");
  await waitForDisconnected(fixture, nodeAInfo.peerId, nodeBInfo.peerId);

  const nodeBBootstrap = requiredBootstrap("node B", nodeBInfo.bootstrapAddresses, nodeB.p2pPort);
  const added = await nodeA.cli.addPeer(nodeBBootstrap);
  if (added.peerId !== nodeBInfo.peerId) throw new Error("add-peer returned the wrong peer id");
  const reconnectedPeers = await eventually(
    "add-peer to restore a compatible connection",
    () => Promise.all([nodeA.cli.peers(), nodeB.cli.peers()]),
    ([a, b]) => hasCompatiblePeer(a, nodeBInfo.peerId, "outbound")
      && hasCompatiblePeer(b, nodeAInfo.peerId, "inbound"),
    { timeoutMs: 60_000 },
  );

  const banned = await nodeA.cli.removePeer(nodeBInfo.peerId, true);
  if (!banned.removed || !banned.banned) throw new Error("remove-peer --ban did not report the ban");
  await waitForDisconnected(fixture, nodeAInfo.peerId, nodeBInfo.peerId);
  await nodeA.cli.expectedFailure(["add-peer", nodeBBootstrap], /banned/i);

  fixture.artifacts.record("p2p-complete", {
    contentHash,
    calldataRelayTransactionHash: relayed.txHash,
    calldataNodeAReceipt: calldataAccepted.nodeA,
    calldataNodeBReceipt: calldataAccepted.nodeB,
    blobContentHash,
    blobRelayTransactionHash: blobRelay.txHash,
    blobVersionedHashes: blobQuote.blobVersionedHashes,
    blobNodeAReceipt: blobAccepted.nodeA,
    blobNodeBReceipt: blobAccepted.nodeB,
    reconciledJournalTransactionHash: settled.transactionHash,
    nodeAIdentity,
    nodeBIdentity,
    initialPeers,
    reconnectedPeers,
    resolvedJournalArchive: resolved.archivePath,
  });
}

function assertIdentity(
  label: string,
  identity: { peerId: string; bootstrapAddress?: string; insecurePermissions: boolean },
  info: { peerId: string; bootstrapAddresses: string[] },
): void {
  if (
    identity.peerId !== info.peerId
    || identity.bootstrapAddress === undefined
    || !info.bootstrapAddresses.includes(identity.bootstrapAddress)
    || identity.insecurePermissions
  ) throw new Error(`${label} does not match its generated P2P identity`);
}

function hasCompatiblePeer(
  peers: readonly PeerInfoJson[],
  peerId: string,
  direction: PeerInfoJson["direction"],
): boolean {
  return peers.some((peer) => peer.peerId === peerId && peer.compatible && peer.direction === direction);
}

function assertRelaySelection(label: string, relay: RelayerResult, contentHash: string): void {
  if (
    relay.selectedContentHashes.length !== 1
    || relay.selectedContentHashes[0]?.toLowerCase() !== contentHash.toLowerCase()
    || relay.rejected.length !== 0
  ) throw new Error(`relay ${label} did not select the requested transaction exactly`);
}

function requiredBootstrap(label: string, addresses: readonly string[], port: number): string {
  const found = addresses.find((address) => address.includes(`/tcp/${port}/p2p/`));
  if (found === undefined) throw new Error(`${label} did not report a dialable bootstrap address`);
  return found;
}

async function waitForDisconnected(
  fixture: ScenarioFixture,
  nodeAPeerId: string,
  nodeBPeerId: string,
): Promise<void> {
  await eventually(
    "remove-peer to disconnect both nodes",
    () => Promise.all([fixture.nodeA.cli.peers(), fixture.nodeB.cli.peers()]),
    ([a, b]) => !a.some((peer) => peer.peerId === nodeBPeerId)
      && !b.some((peer) => peer.peerId === nodeAPeerId),
    { timeoutMs: 30_000 },
  );
}
