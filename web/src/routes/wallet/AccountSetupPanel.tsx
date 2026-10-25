import { useQuery } from "@tanstack/react-query";
import { fasterStandIns, useWallet } from "../../lib/WalletProvider.tsx";
import { usePaymentIssuance } from "../../lib/usePaymentIssuance.ts";
import { querySession } from "../../lib/querySession.ts";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { ProgressIndicator, proofProgressMessage } from "../../components/ProgressIndicator.tsx";
import { TransactionDetails } from "../../components/TransactionDetails.tsx";
import { ConfirmInWallet, useConfirmInWallet } from "../../components/WalletSubmissionLock.tsx";
import { Notice } from "../../components/Notice.tsx";
import { EthereumFaucetLinks, hasEthereumFaucets } from "../../components/EthereumFaucets.tsx";
import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { gasShort } from "../../lib/gasGuard.tsx";
import { AccountActivationStatus } from "./AccountActivationStatus.tsx";
import styles from "./AccountSetupPanel.module.css";

export function AccountSetupPanel() {
  const wallet = useWallet();
  const { phase, accountRecord, activation, setupStep, busy, error } = wallet;
  // Whether the account exists is known only after sign-in, so setup always follows it.
  const setup = phase !== "sign-in-required" && phase !== "signing-in" && accountRecord === "absent";
  // Before setup, what its one mine is expected to earn and what its transaction costs: the
  // account creation and the mine, quoted as the check before proving quotes them.
  const previewing = setup && (phase === "activation-required" || phase === "activation-prepared");
  const reward = usePaymentIssuance(previewing).issuance;
  const { selfPublication, readStatus } = wallet;
  const quote = useQuery({
    queryKey: ["setup-cost", querySession(selfPublication)],
    queryFn: async () => selfPublication!.quoteBatch({ status: await readStatus(), transactions: await fasterStandIns("setup") }),
    enabled: previewing && selfPublication !== undefined,
    retry: false,
    refetchInterval: 36_000,
  }).data;
  const cost = quote?.estimatedCostWei;
  const { l1Chain } = useEthereumNetwork();
  // Short by the maximum setup's own gas check requires. The balance is reread, so the notice clears once test ETH arrives.
  const faucets = previewing && gasShort(wallet.l1Balance, quote?.maximumCostWei) && hasEthereumFaucets(l1Chain.id);
  const confirming = useConfirmInWallet(setupStep === "ethereum");
  if (phase === "ready" || phase === "disconnected") return null;
  const pending = phase === "activation-ambiguous" || phase === "activation-mining" || phase === "activation-pending" || phase === "activation-blocked";
  const reconnect = phase === "wrong-network" || phase === "error";
  const working = busy || ["opening", "connecting", "initializing", "signing-in", "activating", "syncing"].includes(phase);
  const title = phase === "wrong-network" ? "Switch to the account’s Ethereum network"
    : phase === "error" ? "Reconnect your wallet"
    : setup ? "Set up and mine" : "Sign in";
  const action = phase === "wrong-network" ? wallet.switchNetwork
    : phase === "error" ? wallet.connect
    : pending ? wallet.checkAccountActivation
    : setup ? wallet.setupAccount : wallet.signIn;
  const label = phase === "wrong-network" ? "Switch network" : phase === "error" ? "Reconnect"
    : pending ? "Check status" : setup ? "Set up and mine" : "Sign in";
  const progress = phase === "opening" ? "Opening your PCASH wallet…"
    : phase === "syncing" ? "Checking for private payments…"
    : phase === "signing-in" || wallet.awaitingSignature ? "Approve the free signature in your wallet…"
    : setupStep === "ethereum" ? "Sending the Ethereum transaction…"
    : phase === "activating" && wallet.progress ? proofProgressMessage(wallet.progress)
    : phase === "connecting" || phase === "initializing" ? "Checking your account…" : "Preparing your account…";

  return <section className={styles.card} data-testid="account-setup" aria-busy={working}>
    <h2>{title}</h2>
    {!pending && !reconnect && <p>{setup
      ? "One Ethereum transaction publishes your encryption key so people can pay you, lets you spend PCASH, and mines your first PCASH. Gas is paid in ETH."
      : "Sign in with a free signature to unlock your private PCASH keys and find your payments. The signature costs nothing and is not published."}</p>}
    {!pending && <p className={styles.custody}>Keep access to this Ethereum wallet—it controls your PCASH.</p>}
    {!pending && !reconnect && !working && <p className={styles.custody}>This site derives your PCASH keys from your Ethereum wallet. For post-quantum note encryption, <a href="/docs/guides/running-a-node#wallet-service-credentials">use a seed wallet</a> and move funds to it.</p>}
    {!pending && error && <p className={styles.error} role="alert">{error}</p>}
    {previewing && !working && <dl className={styles.preview} aria-label="Set up and mine estimate">
      <dt>Estimated PCASH received</dt><dd>{reward === undefined ? "—" : <>≈ <PcashAmount value={reward} /></>}</dd>
      <dt>Estimated Ethereum cost</dt><dd>{cost === undefined ? "—" : <>≈ <EtherAmount value={cost} /></>}</dd>
    </dl>}
    {faucets && !working && <Notice>
      <strong>Get {l1Chain.name} ETH to set up.</strong>{" "}
      {l1Chain.name} ETH is free test ETH with no value. Claim some from a faucet; this panel updates when it arrives.
      <EthereumFaucetLinks chainId={l1Chain.id} />
    </Notice>}
    {pending ? <AccountActivationStatus /> : working && <>
      <p role="status" aria-live="polite">{progress}</p>
      <ProgressIndicator label={setup ? "Setting up and mining" : "Signing in"} detail={progress} />
      {phase === "activating" && wallet.progress && <TransactionDetails proof={wallet.progress} />}
    </>}
    <button type="button" className="button primary" disabled={working} onClick={() => void action().catch(() => undefined)}>
      {working ? pending ? "Checking status…" : setup ? "Setting up…" : "Signing in…" : label}
    </button>
    {confirming && <ConfirmInWallet />}
    {/* Once the user acts, progress replaces the explanation. */}
    {!pending && !reconnect && !working && <details className={styles.details}>
      <summary>{setup ? "What am I approving?" : "About this signature"}</summary>
      {setup ? <>
        <ul><li>Your public encryption key lets people pay your address privately.</li><li>Your Ethereum wallet authorizes spending from this account.</li><li>The transaction mines PCASH. The reward depends on activity in the block.</li></ul>
        <details><summary>Technical details</summary><dl>
          <dt>Account record</dt><dd>Address, nullifier-key commitment, rule-set commitment and public receive key.</dd>
          <dt>Ethereum chain</dt><dd>{wallet.status?.l1ChainId.toString() ?? "—"}</dd>
          <dt>Inbox</dt><dd><code>{wallet.status?.inboxAddress ?? "—"}</code></dd>
          <dt>Transaction value</dt><dd>0 ETH, plus gas.</dd>
          {wallet.activationContentHash && <><dt>PCASH transaction</dt><dd><code>{wallet.activationContentHash}</code></dd></>}
          {activation && <><dt>Creation expires</dt><dd>{new Date(Number(BigInt(activation.validUntilTimestamp) * 1_000n)).toLocaleString()}</dd></>}
        </dl></details>
      </> : <p>The signature derives your private PCASH keys. Your secret keys are not published. This browser remembers your sign-in until you clear site data in Settings.</p>}
    </details>}
  </section>;
}
