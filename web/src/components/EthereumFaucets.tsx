import { ExternalLinkIcon } from "./icons.tsx";
import styles from "./EthereumFaucets.module.css";

interface EthereumFaucet {
  name: string;
  url: string;
  how: string;
}

/** Public faucets for free test ETH, by Ethereum chain ID. Other chains have none to offer. */
const FAUCETS: Readonly<Record<number, readonly EthereumFaucet[]>> = {
  11155111: [
    { name: "PoW faucet", url: "https://sepolia-faucet.pk910.de/", how: "mine in your browser; no account or mainnet ETH needed" },
  ],
};

export function hasEthereumFaucets(chainId: number): boolean {
  return FAUCETS[chainId] !== undefined;
}

export function EthereumFaucetLinks({ chainId }: { chainId: number }) {
  const faucets = FAUCETS[chainId];
  if (faucets === undefined) return null;
  return <ul className={styles.faucets}>{faucets.map((faucet) => <li key={faucet.url}>
    <a href={faucet.url} target="_blank" rel="noreferrer">{faucet.name}<ExternalLinkIcon /></a> — {faucet.how}
  </li>)}</ul>;
}
