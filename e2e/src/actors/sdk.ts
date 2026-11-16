import type { PreparedEvent } from "@pcash/sdk/protocol";
import type { PrivateValueShape } from "@pcash/sdk/constants";
import { bytesEqual, fromHex } from "@pcash/sdk/utils";
import {
  addressHex,
  bytes32Hex,
  sleep,
  snapshotFromAccountProof,
  authorizeNativeTransferBuild,
  buildNativeTransfer,
  buildAccountRuleSet,
  defaultUserAccountRuleSet,
  fullOutputCommitment,
  noteNk,
  nullifier,
  createReleaseChonkCircuitResolver,
  nativeChonkBackend,
  proveTransferTransactionChonk,
  accountStateCommitment,
  rootFromIndex,
  nullifierKeyCommitment,
  requireSameBoundary,
  scanWallet,
  randomFieldEntropy,
  type AssetAccountAuthorization,
  type AssetSnapshot,
  type DefaultUserRuleSecrets,
  type NativeTransferBuild,
  type NetworkConfigLike,
  type OutputPathResult,
  type PcashNodeClient,
  type PcashActionSigner,
  type AccountProofResult,
  type WalletProfile,
  type WalletProfileWithReceiveKeys,
} from "../deps.ts";

export interface SpendableNote {
  leafIndex: bigint;
  noteSecret: bigint;
  amount: bigint;
  assetId: bigint;
}

interface CoherentUserSnapshot {
  outputPaths: OutputPathResult[];
  accountPath: Extract<AccountProofResult, { status: "present" }>;
}

export async function listSpendableNotes(
  node: PcashNodeClient,
  wallet: WalletProfileWithReceiveKeys,
  chainId: bigint,
  assetId = 0n,
): Promise<SpendableNote[]> {
  const report = await scanWallet(node, wallet, chainId);
  const notes = report.recovered
    .map((note) => ({
      leafIndex: BigInt(note.leafIndex),
      noteSecret: BigInt(note.noteSecret),
      amount: BigInt(note.amount),
      assetId: BigInt(note.assetId),
    }))
    .filter((note) => note.assetId === assetId);
  if (notes.length === 0) return [];
  const nk = noteNk(wallet.nkRoot);
  const candidates = notes
    .sort((left, right) => left.amount > right.amount ? -1 : left.amount < right.amount ? 1 : 0)
    .slice(0, 256);
  const nullifiers = candidates.map((note) => {
    const commitment = fullOutputCommitment(
      { owner: wallet.address, noteSecret: note.noteSecret, assetId: note.assetId, amount: note.amount },
      note.leafIndex,
    );
    return bytes32Hex(nullifier(commitment, nk, note.noteSecret));
  });
  const decision = await node.getCurrentNullifierStatuses(nullifiers);
  if (decision.boundary === null) throw new Error("spend decision returned no current boundary");
  return candidates.filter((_note, index) => !decision.statuses[index]!.spent);
}

async function coherentUserSnapshot(
  node: PcashNodeClient,
  address: string,
  notes: readonly { leafIndex: bigint; commitment: bigint }[],
): Promise<CoherentUserSnapshot> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const [outputPaths, accountPath] = await Promise.all([
      Promise.all(notes.map(note => node.getOutputPath(note.leafIndex, note.commitment))),
      node.getAccountProof(address),
    ]);
    if (outputPaths.every(path => path !== null) && accountPath.status === "present") {
      try {
        for (const outputPath of outputPaths) requireSameBoundary(outputPath.boundary, accountPath.boundary);
        return { outputPaths, accountPath };
      } catch {
        // A normal head advance retries the small coherent snapshot.
      }
    }
    if (attempt < 59) await sleep(250);
  }
  throw new Error("node never exposed coherent note and account openings");
}

export async function buildLatestUserTransfer(params: {
  shape?: PrivateValueShape;
  inputNotes?: readonly SpendableNote[];
  eventSalt?: bigint;
  preparedEvent?: PreparedEvent;
  data?: import("@pcash/sdk/protocol").ResolvedTransactionData;
  node: PcashNodeClient;
  network: NetworkConfigLike & { pcashChainId: bigint };
  /** With an outgoing key, the build writes the wallet's sender region. */
  wallet: WalletProfileWithReceiveKeys & { outgoingKey?: Uint8Array };
  recipientAddress: bigint;
  recipientReceiveKey: Uint8Array;
  amount?: bigint;
  amountDivisor?: bigint;
  openFeeAmount?: bigint;
  /** The carrier context the transfer requires; 0, the default, accepts any delivery. */
  carrierContextHash?: bigint;
  defaultRuleSecrets: DefaultUserRuleSecrets;
  signer: PcashActionSigner;
}): Promise<NativeTransferBuild> {
  const notes = params.inputNotes ?? (await listSpendableNotes(params.node, params.wallet, params.network.pcashChainId)).slice(0, 1);
  if (notes.length === 0) throw new Error(`wallet ${addressHex(params.wallet.address)} has no spendable note`);
  const total = notes.reduce((sum, note) => sum + note.amount, 0n);
  const amount = params.amount ?? total / (params.amountDivisor ?? 8n);
  const openFeeAmount = params.openFeeAmount ?? 0n;
  if (amount <= 0n || amount + openFeeAmount >= total) {
    throw new Error(`payment ${amount} plus fee ${openFeeAmount} must leave positive change from ${total}`);
  }
  const snapshot = await coherentUserSnapshot(params.node, addressHex(params.wallet.address), notes.map(note => ({
    leafIndex: note.leafIndex,
    commitment: fullOutputCommitment({ owner: params.wallet.address, noteSecret: note.noteSecret, assetId: 0n, amount: note.amount }, note.leafIndex),
  })));
  const latest = await params.node.status();
  const material = snapshot.accountPath.account.material;
  if (material.status !== "available") throw new Error("native transfer change requires a registered receive key");
  const selfReceiveKey = fromHex(material.mlKem768PublicKey);
  if (!bytesEqual(selfReceiveKey, params.wallet.mlKemPublicKey)) {
    throw new Error("SDK actor does not own the registered receive key");
  }
  return authorizeNativeTransferBuild(buildNativeTransfer({
    ...(params.shape === undefined ? {} : { shape: params.shape }),
    chainId: params.network.pcashChainId,
    network: params.network,
    wallet: params.wallet,
    selfReceiveKey,
    ...(params.wallet.outgoingKey === undefined ? {} : { sender: { outgoingKey: params.wallet.outgoingKey } }),
    recipientAddress: params.recipientAddress,
    recipientReceiveKey: params.recipientReceiveKey,
    paymentAmount: amount,
    ...(params.eventSalt === undefined ? {} : { eventSalt: params.eventSalt }),
    ...(params.preparedEvent === undefined ? {} : { preparedEvent: params.preparedEvent }),
    ...(params.data === undefined ? {} : { data: params.data }),
    inputs: notes.map((note, index) => ({
      amount: note.amount,
      noteSecret: note.noteSecret,
      outputIndex: Number(note.leafIndex),
      siblings: snapshot.outputPaths[index]!.siblings.map(BigInt),
    })),
    ...snapshotFromAccountProof(snapshot.accountPath),
    openFeeAmount,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: randomFieldEntropy(),
    validUntilTimestamp: latest.latestBlockTimestamp + 1_800n,
    ...(params.carrierContextHash === undefined ? {} : { carrierContextHash: params.carrierContextHash }),
    defaultRuleSecrets: params.defaultRuleSecrets,
    accountIndex: Number(snapshot.accountPath.account.index),
    accountSiblings: snapshot.accountPath.accountSiblings,
    accountRevision: snapshot.accountPath.account.accountRevision,
    receiveKeyHash: BigInt(snapshot.accountPath.account.receiveKeyHash),
  }), params.signer);
}

export async function proveDefaultTransfer(
  build: NativeTransferBuild,
  label: string,
): Promise<Uint8Array> {
  if (build.accountRuleWitnessMap === undefined) {
    throw new Error(`${label}: default user transfer has no ECDSA authorization witness`);
  }
  const proof = await proveTransferTransactionChonk({
    build,
    authorizationPackage: build.authorizationCircuit,
    authorizationWitnessMap: build.accountRuleWitnessMap,
    resolve: createReleaseChonkCircuitResolver(),
    backend: nativeChonkBackend(),
  });
  return build.encodeTransaction(proof.proof);
}

export interface AssetInputNoteSnapshot {
  leafIndex: bigint;
  commitment: bigint;
}

interface PresentAccountProof {
  address: string;
  path: Extract<AccountProofResult, { status: "present" }>;
}

/**
 * Read every requested account and note opening at ONE boundary.
 *
 * An asset action binds all of them to a single `recentPcashBlockHash`, so
 * paths taken from different heads cannot be mixed — and a two-account action
 * has to hold that across both accounts, not just one.
 */
async function readCoherentOpenings(
  node: PcashNodeClient,
  addresses: readonly string[],
  notes: readonly AssetInputNoteSnapshot[],
): Promise<{ accounts: PresentAccountProof[]; noteSiblings: bigint[][] }> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const [accountPaths, outputPaths] = await Promise.all([
      Promise.all(addresses.map((address) => node.getAccountProof(address))),
      Promise.all(notes.map((note) => node.getOutputPath(note.leafIndex, note.commitment))),
    ]);
    const present = accountPaths.filter((path) => path.status === "present");
    if (present.length === accountPaths.length && outputPaths.every((path) => path !== null)) {
      const reference = present[0]!.boundary;
      // Only a head race is retried. Everything the callers below derive is
      // deterministic for a given read, so its failures must escape instead of
      // spinning.
      let coherent = true;
      try {
        for (const path of present) requireSameBoundary(path.boundary, reference);
        for (const outputPath of outputPaths) requireSameBoundary(outputPath!.boundary, reference);
      } catch {
        coherent = false;
      }
      if (coherent) {
        return {
          accounts: present.map((path, index) => ({ address: addresses[index]!, path })),
          noteSiblings: outputPaths.map((outputPath) => outputPath!.siblings.map(BigInt)),
        };
      }
    }
    if (attempt < 59) await sleep(250);
  }
  throw new Error("node never exposed one coherent boundary for the requested openings");
}

interface UserAccount {
  wallet: WalletProfile;
  /** The network the account's installed rules were committed under. */
  network: NetworkConfigLike & { pcashChainId: bigint };
  defaultRuleSecrets: DefaultUserRuleSecrets;
  /** Rules this wallet installed beyond the default ECDSA entries. */
  extraRuleEntries?: readonly { entryIndex: number; accountRuleEntryCommitment: bigint }[];
  /** Which installed rule authorizes this action; the batch-transfer rule by default. */
  selectedRule?: {
    entryIndex: number;
    configurationCommitment: bigint;
    commitmentBlinder: bigint;
  };
}

function userAccountAuthorization(
  accountPath: Extract<AccountProofResult, { status: "present" }>,
  account: UserAccount,
): { authorization: AssetAccountAuthorization } {
  const ruleSet = userRuleSet({
    wallet: account.wallet,
    network: account.network,
    secrets: account.defaultRuleSecrets,
    ...(account.extraRuleEntries === undefined ? {} : { extraEntries: account.extraRuleEntries }),
  });
  const defaults = ruleSet.defaults;
  const selected = account.selectedRule ?? {
    entryIndex: defaults.batchTransferRule.entryIndex,
    configurationCommitment: defaults.batchTransferRule.configurationCommitment,
    commitmentBlinder: defaults.batchTransferRule.commitmentBlinder,
  };
  const membership = ruleSet.membership(selected.entryIndex);
  const receiveKeyHash = BigInt(accountPath.account.receiveKeyHash);
  const leaf = accountStateCommitment(
    account.wallet.address,
    nullifierKeyCommitment(account.wallet.nkRoot),
    ruleSet.accountRuleSetCommitment,
    BigInt(accountPath.account.accountKind),
    accountPath.account.accountRevision,
    receiveKeyHash,
  );
  if (rootFromIndex(leaf, Number(accountPath.account.index), accountPath.accountSiblings) !== accountPath.accountStateRoot) {
    throw new Error(
      "reconstructed account state commitment is not the one in the account state tree; the action would fail on account membership",
    );
  }
  return {
    authorization: {
      address: account.wallet.address,
      nkRoot: account.wallet.nkRoot,
      accountIndex: Number(accountPath.account.index),
      accountSiblings: accountPath.accountSiblings,
      accountRuleSetCommitment: ruleSet.accountRuleSetCommitment,
      accountKind: BigInt(accountPath.account.accountKind),
      accountRevision: accountPath.account.accountRevision,
      receiveKeyHash,
      rule: {
        configurationCommitment: selected.configurationCommitment,
        commitmentBlinder: selected.commitmentBlinder,
        entryIndex: membership.entryIndex,
        siblings: membership.siblings,
      },
    },
  };
}

export interface CoherentAssetSnapshot {
  blockNumber: bigint;
  blockHash: string;
  snapshot: AssetSnapshot;
  /** Note siblings in the order the requested notes were passed. */
  noteSiblings: bigint[][];
  owner: AssetAccountAuthorization;
}

/**
 * One user rule set: the six default ECDSA entries plus any additional
 * rules the wallet installed. Adding an entry changes the set root and every
 * opening, so the defaults' openings come from the combined tree.
 */
function userRuleSet(params: {
  wallet: WalletProfile;
  network: NetworkConfigLike & { pcashChainId: bigint };
  secrets: DefaultUserRuleSecrets;
  extraEntries?: readonly { entryIndex: number; accountRuleEntryCommitment: bigint }[];
}): {
  accountRuleSetCommitment: bigint;
  defaults: ReturnType<typeof defaultUserAccountRuleSet>;
  membership: (entryIndex: number) => { entryIndex: number; siblings: bigint[] };
} {
  const defaults = defaultUserAccountRuleSet({
    wallet: params.wallet,
    network: params.network,
    secrets: params.secrets,
  });
  const set = buildAccountRuleSet([
    ...defaults.entries.map((rule) => ({
        entryIndex: rule.entryIndex,
        accountRuleEntryCommitment: rule.accountRuleEntryCommitment,
      })),
    ...(params.extraEntries ?? []),
  ]);
  return {
    accountRuleSetCommitment: set.accountRuleSetCommitment,
    defaults,
    membership: (entryIndex) => {
      const proof = set.membership(entryIndex);
      return { entryIndex: proof.entryIndex, siblings: proof.siblings };
    },
  };
}

/** Read every asset-action input opening plus the owner's account at ONE boundary. */
export async function coherentAssetSnapshot(params: {
  node: PcashNodeClient;
  wallet: WalletProfile;
  network: NetworkConfigLike & { pcashChainId: bigint };
  notes: readonly AssetInputNoteSnapshot[];
  defaultRuleSecrets: DefaultUserRuleSecrets;
  selectedDefaultRule?: "asset-payment" | "asset-burn" | "batch-transfer" | "asset-creation";
}): Promise<CoherentAssetSnapshot> {
  const defaults = defaultUserAccountRuleSet({
    wallet: params.wallet,
    network: params.network,
    secrets: params.defaultRuleSecrets,
  });
  const selected = params.selectedDefaultRule === "asset-creation"
    ? defaults.assetCreationRule
    : params.selectedDefaultRule === "asset-payment"
    ? defaults.assetPaymentRule
    : params.selectedDefaultRule === "asset-burn"
      ? defaults.assetBurnRule
      : defaults.batchTransferRule;
  const account: UserAccount = {
    wallet: params.wallet,
    network: params.network,
    defaultRuleSecrets: params.defaultRuleSecrets,
    selectedRule: {
      entryIndex: selected.entryIndex,
      configurationCommitment: selected.configurationCommitment,
      commitmentBlinder: selected.commitmentBlinder,
    },
  };
  const { accounts, noteSiblings } = await readCoherentOpenings(
    params.node,
    [addressHex(params.wallet.address)],
    params.notes,
  );
  const accountPath = accounts[0]!.path;
  const { authorization } = userAccountAuthorization(accountPath, account);
  return {
    blockNumber: accountPath.boundary.header.number,
    blockHash: bytes32Hex(accountPath.boundary.blockHash),
    snapshot: snapshotFromAccountProof(accountPath),
    noteSiblings,
    owner: authorization,
  };
}
