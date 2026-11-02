import { Link } from "react-router-dom";
import { routeById } from "../routes/routeManifest.ts";
import { Notice } from "./Notice.tsx";

/**
 * Shown in place of an action that has no PCASH to burn while the network
 * fee is above zero: where to get PCASH, and that the action returns once the
 * fee is zero again. The view keeps reading the fee, so waiting needs no step.
 */
export function NetworkFeeFunding({ action, createsAccount = false }: {
  /** The blocked action, as the subject of a sentence: "Mining", "Setup". */
  action: string;
  /** The account does not exist yet: a link claim creates it, and the marketplace needs it first. */
  createsAccount?: boolean;
}) {
  return <div data-testid="network-fee-funding"><Notice>
    <strong>{action} needs PCASH right now.</strong> The network fee is above zero, and it is paid in PCASH.
    {createsAccount && " Claiming a link also creates your account."}
    <ul>
      <li>Ask someone who holds PCASH to send you some by link.</li>
      {!createsAccount && <li><Link to={routeById("marketplace").path}>Buy PCASH on the marketplace</Link> with ETH.</li>}
      <li>Or wait here. {action} turns back on when the network fee returns to zero.</li>
    </ul>
  </Notice></div>;
}
