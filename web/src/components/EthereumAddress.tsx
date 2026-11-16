import { useEthereumName } from "../names/useEthereumName.ts";
import { CopyButton } from "./CopyButton.tsx";
import styles from "./EthereumAddress.module.css";

/** Characters kept visible after the ellipsis when the text does not fit. */
const FITTED_TAIL = 4;

/** An address or link on one line: when it does not fit, its middle gives way (`0x12345…abcd`). */
export function FittedCode({ text }: { text: string }) {
  return <code className={styles.fitted}><span>{text.slice(0, -FITTED_TAIL)}</span><span>{text.slice(-FITTED_TAIL)}</span></code>;
}

/** The raw address with a copy button, for identity headers that already show the name. */
export function CopyableAddress({ address }: { address: string }) {
  return <span className={styles.copyable} title={address}><FittedCode text={address} /><CopyButton value={address} label="Copy address" /></span>;
}

/** Address-only presentation: links and copy buttons keep using the original address. */
export function EthereumAddress({ address, short = false, showAddress = false, head = 10, tail = 8 }: {
  address: string;
  short?: boolean;
  showAddress?: boolean;
  head?: number;
  tail?: number;
}) {
  const identity = useEthereumName(address);
  const shown = short && address.length > head + tail + 1 ? <code>{`${address.slice(0, head)}…${address.slice(-tail)}`}</code> : <FittedCode text={address} />;
  return <span title={address} aria-label={identity === undefined ? address : `${identity.name} (${address})`}>
    {identity === undefined ? shown : identity.name}{showAddress && identity !== undefined && <> ({shown})</>}
  </span>;
}
