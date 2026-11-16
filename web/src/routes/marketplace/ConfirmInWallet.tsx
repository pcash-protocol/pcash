import styles from "./MarketplaceRoute.module.css";

/** The status line under an action's button while the wallet asks the user to approve its next step. */
export function ConfirmInWallet({ children = "Confirm in your wallet" }: { children?: string }) {
  return <p className={styles.walletPrompt} role="status"><span className="spinner" aria-hidden="true" />{children}</p>;
}
