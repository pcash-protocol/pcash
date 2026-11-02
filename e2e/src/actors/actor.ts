import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addressHex,
  createWalletProvers,
  fromHex,
  openNodeWallet,
  privateKeyPcashActionSigner,
  requestPcashProfile,
  type NetworkConfigLike,
  type PcashActionSigner,
  type PcashNodeClient,
  type PcashProfile,
  type Wallet,
} from "../deps.ts";
import type { HarnessL1 } from "../fixture/harness.ts";

/**
 * One scenario participant: an Ethereum key, its derived PCASH profile, and an
 * in-process wallet whose actions the harness publishes.
 */
export class ScenarioActor {
  readonly name: string;
  readonly privateKey: `0x${string}`;
  readonly signer: PcashActionSigner;
  readonly wallet: PcashProfile;
  readonly address: string;
  /** One PGlite database holds every actor's inventory, as a wallet service would. */
  readonly walletDatabasePath: string;
  readonly #node: PcashNodeClient;
  readonly #harness: HarnessL1;
  #client: Promise<Wallet> | undefined;
  #anchored = false;

  private constructor(params: {
    name: string;
    privateKey: `0x${string}`;
    signer: PcashActionSigner;
    wallet: PcashProfile;
    walletDatabasePath: string;
    node: PcashNodeClient;
    harness: HarnessL1;
  }) {
    this.name = params.name;
    this.privateKey = params.privateKey;
    this.signer = params.signer;
    this.wallet = params.wallet;
    this.address = addressHex(params.wallet.address);
    this.walletDatabasePath = params.walletDatabasePath;
    this.#node = params.node;
    this.#harness = params.harness;
  }

  static async create(params: {
    name: string;
    privateKey: `0x${string}`;
    network: NetworkConfigLike;
    artifactsRoot: string;
    node: PcashNodeClient;
    harness: HarnessL1;
  }): Promise<ScenarioActor> {
    const signer = privateKeyPcashActionSigner(fromHex(params.privateKey));
    const wallet = await requestPcashProfile(signer, params.network);
    // Keep each key beside the run's evidence so a preserved run can be inspected or recovered.
    const credentials = join(params.artifactsRoot, "credentials");
    await mkdir(credentials, { recursive: true, mode: 0o700 });
    await chmod(credentials, 0o700);
    await writeFile(join(credentials, `actor-${params.name}.json`), `${JSON.stringify({ privateKey: params.privateKey })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return new ScenarioActor({
      name: params.name,
      privateKey: params.privateKey,
      signer,
      wallet,
      walletDatabasePath: join(params.artifactsRoot, "wallet", "wallet.pglite"),
      node: params.node,
      harness: params.harness,
    });
  }

  /**
   * This actor's wallet, opened on first use. Actions default to the public
   * mempool, which the harness relays; a new account publishes on L1.
   */
  client(): Promise<Wallet> {
    this.#client ??= (async () => {
      const wallet = await openNodeWallet({
        dataDir: this.walletDatabasePath,
        node: this.#node,
        profile: this.wallet,
        signer: this.signer,
        provers: createWalletProvers("native"),
        submission: this.#harness.mempool(),
        userAccountCreationSubmission: this.#harness.l1(this.wallet),
        ...this.#harness.walletSettleWait(),
      });
      if (!this.#anchored) {
        // Every actor key is new to its chain, so there is no history to scan.
        await wallet.sync({ anchorAtCurrentBoundary: true });
        this.#anchored = true;
      }
      return wallet;
    })();
    return this.#client;
  }

  /** Spendable native PCASH after catching up with the node. */
  async balance(options: { rescan?: boolean } = {}): Promise<bigint> {
    const wallet = await this.client();
    await wallet.sync(options.rescan === true ? { rescan: true } : {});
    return (await wallet.balances({ assetId: 0n }))[0]?.spendable ?? 0n;
  }

  /** Release the wallet so a scenario can reopen this actor's inventory with its own settings. */
  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    await (await client?.catch(() => undefined))?.close();
  }
}
