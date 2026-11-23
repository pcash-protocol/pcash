// The issuer of a deposit-mint stablecoin. Holders mint their own deposits to
// the reserve vault; the issuer credits wires and replacement units through the
// vault, which emits the same deposit event, and decides who may deposit, the
// per-deposit cap, and whether deposits are paused. A holder redeems by sending
// the stablecoin to the issuer with a memo naming its Ethereum payout address;
// the issuer burns what it received and, once that burn is final, pays out.
//
// Redemptions are read only from finalized PCASH blocks. Every burn attempt's
// content hash is stored before the attempt is published, and an attempt is
// reconciled to success or to a definite failure before the issuer makes
// another. Each redemption advances on its own: one that fails waits for a
// later call without holding up the rest, and one that can never succeed is
// rejected.
//
// One issuer process owns a state store; its calls run one at a time. It sends
// the vault's issuer transactions through an `EthereumWriter`, which a deny-list
// admin that uses the same key shares.

import {
  getAddress,
  keccak256,
  toBytes,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  assetDefinitionAssetId,
  memoSchema,
  readRecord,
  type AssetDefinition,
  type FungibleMetadata,
} from "@pcash/sdk/protocol";
import {
  createDepositMintAsset,
  decodeDepositCode,
  recognizeMintRule,
  senderDenyListTransferRule,
  type DenyListConfiguration,
} from "@pcash/sdk/rules";
import { addressHex, bytes32Hex } from "@pcash/sdk/utils";
import type { Wallet } from "@pcash/sdk/wallet";
import { isFinalized, type PcashNodeClient } from "@pcash/sdk/clients";
import { RESERVE_VAULT_ABI } from "./contracts.ts";
import type { EthereumWriter } from "./ethereumWriter.ts";

const MEMO_PAGE = 1000;

/** A stablecoin minted once per deposit to `vault` whose senders the issuer's deny list screens. */
export function stablecoinDefinition(params: {
  metadata: FungibleMetadata;
  vault: Address;
  denyList: DenyListConfiguration;
  startSalt?: bigint;
}): AssetDefinition {
  return createDepositMintAsset({
    metadata: params.metadata,
    vault: BigInt(params.vault),
    transferRule: senderDenyListTransferRule(params.denyList),
    ...(params.startSalt === undefined ? {} : { startSalt: params.startSalt }),
  }).definition;
}

/** A redemption memo: the Ethereum address that receives the payout. */
export function redemptionMemo(payout: Address): string {
  return `redeem ${payout.toLowerCase()}`;
}

/** The payout address a redemption memo names, in any letter case, checksummed. */
function parseRedemptionMemo(memo: string): Address | undefined {
  const match = /^redeem (0x[0-9a-fA-F]{40})$/.exec(memo);
  return match === null ? undefined : getAddress(match[1]!);
}

/**
 * The key of a received redemption note: the content hash of the transaction
 * that paid it and its output slot. A reorganization that re-includes the same
 * transaction leaves the key unchanged.
 */
export function redemptionKey(contentHash: string, slot: number): string {
  return `${contentHash.toLowerCase()}:${slot}`;
}

/** The vault's identifier for a redemption, which it pays out once. */
export function vaultRedemptionId(key: string): Hex {
  return keccak256(toBytes(key));
}

export interface Redemption {
  /** `redemptionKey` of the received note. */
  key: string;
  /** `vaultRedemptionId(key)`. */
  redemptionId: Hex;
  payout: Address;
  amount: string;
  /** The latest burn attempt, stored before it is published. */
  burnContentHash?: string;
  /** The burn executed successfully in a finalized PCASH block. */
  burned: boolean;
  /** The latest payout transaction, stored before it is awaited. */
  payoutTransaction?: Hex;
  /** The vault records the payout as of a final Ethereum block. */
  paid: boolean;
  /** Why this redemption can never be paid. */
  rejected?: string;
  /** The last failure; the redemption is tried again on a later call. */
  lastError?: string;
}

export interface IssuerState {
  redemptions: Redemption[];
}

export interface IssuerStateStore {
  load(): Promise<IssuerState>;
  save(state: IssuerState): Promise<void>;
}

export function memoryIssuerStateStore(): IssuerStateStore {
  let state: IssuerState = { redemptions: [] };
  return {
    load: async () => structuredClone(state),
    save: async (next) => { state = structuredClone(next); },
  };
}

type IssuerWallet = Pick<Wallet, "burnAsset" | "notes" | "transactionData" | "sync" | "snapshot" | "importAssetDefinition">;

export interface StablecoinIssuerParams {
  wallet: IssuerWallet;
  node: PcashNodeClient;
  /** A deposit-mint asset; its mint rule names the vault. */
  definition: AssetDefinition;
  ethereum: {
    publicClient: PublicClient;
    /** Sends from the vault's issuer account; shared with a `DenyListAdmin` that uses the same key. */
    writer: EthereumWriter;
    /**
     * Treat Ethereum blocks this many below the head as final, instead of
     * Ethereum's finalized block. Payouts are counted only through the final
     * block.
     */
    confirmations?: bigint;
  };
  store: IssuerStateStore;
  /** Wallet submission options passed to each burn, such as a publication route. */
  submission?: Record<string, unknown>;
  /**
   * The issuer's customer checks. A redemption burns and pays out only once
   * its check passes; until then it waits for a later call.
   */
  screen?: {
    payout?(payout: Address, amount: bigint): Promise<boolean>;
  };
}

type AttemptOutcome = "succeeded" | "pending" | "failed";

type VaultWrite =
  | { functionName: "credit"; args: readonly [Hex, Hex, bigint] }
  | { functionName: "setAllowed"; args: readonly [Address, boolean] }
  | { functionName: "setDepositCap"; args: readonly [bigint] }
  | { functionName: "setDepositsPaused"; args: readonly [boolean] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class StablecoinIssuer {
  readonly assetId: bigint;
  /** The reserve vault the asset's mint rule names. */
  readonly vault: Address;
  readonly #params: StablecoinIssuerParams;
  #tail: Promise<unknown> = Promise.resolve();
  #definitionImported = false;

  constructor(params: StablecoinIssuerParams) {
    const rule = recognizeMintRule(params.definition.mintRule);
    if (rule.kind !== "deposit-mint") throw new Error("a stablecoin is a deposit-mint asset");
    this.assetId = assetDefinitionAssetId(params.definition);
    this.vault = addressHex(rule.configuration.vault) as Address;
    this.#params = params;
  }

  /**
   * Credit `amount` to the holder whose wallet issued `depositCode`, with no
   * USDC: the vault emits a deposit from the issuer, which the holder's wallet
   * mints like any other. The vault credits a code once: calling again with a
   * code whose credit landed, such as after a call that failed while waiting
   * for its receipt, reverts with `AlreadyCredited`. Each credit takes a fresh
   * code. Returns the Ethereum transaction once it succeeded.
   */
  credit(params: { depositCode: string; amount: bigint }): Promise<Hex> {
    return this.#exclusive(async () => {
      const { pcashChainId } = await this.#params.node.status();
      const code = decodeDepositCode(params.depositCode, { pcashChainId, vault: this.vault });
      return this.#write({ functionName: "credit", args: [bytes32Hex(code.recipientCommitment), bytes32Hex(code.nonce), params.amount] });
    });
  }

  /** Let `depositor` deposit, or stop it. */
  allow(depositor: Address, allowed: boolean): Promise<Hex> {
    return this.#exclusive(() => this.#write({ functionName: "setAllowed", args: [depositor, allowed] }));
  }

  /** The largest single deposit the vault accepts. */
  setDepositCap(cap: bigint): Promise<Hex> {
    return this.#exclusive(() => this.#write({ functionName: "setDepositCap", args: [cap] }));
  }

  /** Pause or resume deposits. Credits and payouts continue. */
  setDepositsPaused(paused: boolean): Promise<Hex> {
    return this.#exclusive(() => this.#write({ functionName: "setDepositsPaused", args: [paused] }));
  }

  /**
   * Record redemptions received in finalized PCASH blocks, burn each one, and
   * pay each burned one out from the vault once. Returns the redemptions whose
   * payout reached a final Ethereum block in this call.
   */
  processRedemptions(): Promise<Redemption[]> {
    return this.#exclusive(async () => {
      const { wallet, store } = this.#params;
      // A restricted asset's burn needs its definition, which carries the
      // transfer rule; the wallet reads the asset's deny list as it syncs only
      // once it holds the definition.
      if (!this.#definitionImported) {
        await wallet.importAssetDefinition(this.#params.definition);
        this.#definitionImported = true;
      }
      await wallet.sync();
      const state = await store.load();
      await this.#discoverRedemptions(state);
      await store.save(state);
      const open = state.redemptions.filter((redemption) => !redemption.paid && redemption.rejected === undefined);
      if (open.length === 0) return [];
      const final = await this.#finalEthereumBlock();
      const paid: Redemption[] = [];
      for (const redemption of open) {
        try {
          if (await this.#advanceRedemption(state, redemption, final)) paid.push(redemption);
          delete redemption.lastError;
        } catch (error) {
          redemption.lastError = errorMessage(error);
        }
        await store.save(state);
      }
      return paid;
    });
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async #write(write: VaultWrite): Promise<Hex> {
    return (await this.#params.ethereum.writer.write({ address: this.vault, abi: RESERVE_VAULT_ABI, ...write })).transactionHash;
  }

  async #finalEthereumBlock(): Promise<bigint> {
    const { publicClient, confirmations } = this.#params.ethereum;
    if (confirmations === undefined) return (await publicClient.getBlock({ blockTag: "finalized" })).number;
    const head = await publicClient.getBlockNumber();
    return head > confirmations ? head - confirmations : 0n;
  }

  /**
   * Where one recorded burn attempt stands. The wallet keeps an attempt
   * pending until it settles or expires in a finalized block, so an attempt
   * the wallet released without a finalized successful receipt failed for
   * good, once the node's index covers the finalized block.
   */
  async #attemptOutcome(contentHash: string): Promise<AttemptOutcome> {
    const { node, wallet } = this.#params;
    const pending = (await wallet.snapshot()).pendingContentHashes.includes(contentHash.toLowerCase());
    const status = await node.status();
    const receipts = (await node.getReceipt({ contentHash })).filter((receipt) => receipt.outcome === "succeeded");
    if (receipts.some((receipt) => isFinalized(receipt.inclusion.l1BlockNumber, status))) return "succeeded";
    if (pending || receipts.length > 0) return "pending";
    if (status.index.cursor === null || status.index.cursor.blockNumber < status.finalizedBlock) return "pending";
    return "failed";
  }

  async #discoverRedemptions(state: IssuerState): Promise<void> {
    const { wallet } = this.#params;
    // Finality read first: rows read later are final at or below it.
    const { finalizedThrough } = await wallet.snapshot();
    if (finalizedThrough === null) return;
    const notes = await wallet.notes({ assetId: this.assetId });
    const known = new Set(state.redemptions.map((redemption) => redemption.key));
    for (let offset = 0; ; offset += MEMO_PAGE) {
      const rows = await wallet.transactionData({ schema: memoSchema.id, limit: MEMO_PAGE, offset });
      for (const row of rows) {
        if (BigInt(row.blockNumber) > finalizedThrough.pcashNumber) continue;
        for (const group of row.received) {
          const memo = readRecord(group.records, memoSchema);
          const payout = memo === undefined ? undefined : parseRedemptionMemo(memo);
          if (payout === undefined) continue;
          const key = redemptionKey(row.contentHash, group.slot);
          if (known.has(key)) continue;
          const note = notes.find((candidate) => candidate.leafIndex === BigInt(row.leafIndex) + BigInt(group.slot));
          if (note === undefined) continue;
          known.add(key);
          state.redemptions.push({
            key, redemptionId: vaultRedemptionId(key), payout, amount: note.amount.toString(), burned: false, paid: false,
            ...(BigInt(payout) === 0n ? { rejected: "the payout address is zero" } : {}),
          });
        }
      }
      if (rows.length < MEMO_PAGE) break;
    }
  }

  /** Returns whether the redemption's payout reached a final Ethereum block in this call. */
  async #advanceRedemption(state: IssuerState, redemption: Redemption, final: bigint): Promise<boolean> {
    if (!redemption.burned && !(await this.#burn(state, redemption))) return false;
    return this.#payout(state, redemption, final);
  }

  /** Returns whether the redemption's burn executed successfully in a finalized PCASH block. */
  async #burn(state: IssuerState, redemption: Redemption): Promise<boolean> {
    const { wallet, store } = this.#params;
    const amount = BigInt(redemption.amount);
    if (redemption.burnContentHash !== undefined) {
      let outcome = await this.#attemptOutcome(redemption.burnContentHash);
      if (outcome === "pending") {
        // Resume the recorded burn's exact bytes; they are published again only if the node holds none of them.
        await wallet.burnAsset({
          assetId: this.assetId, amount, ...this.#params.submission,
          retryContentHash: redemption.burnContentHash, settlePollMaxAttempts: 1,
        });
        outcome = await this.#attemptOutcome(redemption.burnContentHash);
      }
      if (outcome !== "failed") return redemption.burned = outcome === "succeeded";
    }
    if (!(await this.#params.screen?.payout?.(redemption.payout, amount) ?? true)) return false;
    await wallet.burnAsset({
      assetId: this.assetId, amount, ...this.#params.submission, settlePollMaxAttempts: 1,
      onPrepared: async (contentHash: string) => {
        redemption.burnContentHash = contentHash;
        await store.save(state);
      },
    });
    return redemption.burned = await this.#attemptOutcome(redemption.burnContentHash!) === "succeeded";
  }

  /**
   * Pay out once. The vault's `paidOut` decides: as of the final block it
   * completes the redemption, and at the head it means a payout is on its way.
   * A recorded payout transaction that is still pending, or mined and waiting
   * for finality, is not sent again.
   */
  async #payout(state: IssuerState, redemption: Redemption, final: bigint): Promise<boolean> {
    const { publicClient, writer } = this.#params.ethereum;
    const vault = this.vault;
    const paidOut = (blockNumber?: bigint) => publicClient.readContract({
      address: vault, abi: RESERVE_VAULT_ABI, functionName: "paidOut", args: [redemption.redemptionId],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    if (await paidOut(final)) return redemption.paid = true;
    if (await paidOut()) return false;
    if (redemption.payoutTransaction !== undefined && await this.#payoutOnItsWay(redemption.payoutTransaction)) return false;
    redemption.payoutTransaction = await writer.send({
      address: vault, abi: RESERVE_VAULT_ABI, functionName: "payout",
      args: [redemption.payout, BigInt(redemption.amount), redemption.redemptionId],
    });
    await this.#params.store.save(state);
    return false;
  }

  /** Whether `hash` is pending, or mined successfully; false once it reverted or the node no longer knows it. */
  async #payoutOnItsWay(hash: Hex): Promise<boolean> {
    const { publicClient } = this.#params.ethereum;
    try {
      return (await publicClient.getTransactionReceipt({ hash })).status === "success";
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    try {
      await publicClient.getTransaction({ hash });
      return true;
    } catch (error) {
      if (error instanceof TransactionNotFoundError) return false;
      throw error;
    }
  }
}
