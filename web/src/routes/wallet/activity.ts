import { useEffect } from "react";
import { useGetActivity } from "../../lib/GetActivity.tsx";
import { holdDeploymentReload } from "../../lib/deploymentReload.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { useWalletPanel } from "./OwnerPanels.tsx";

/** Work that continues while the wallet panel is hidden, and results waiting to be seen. */
export function useWalletActivity() {
  const { paymentStage } = useWallet();
  const get = useGetActivity();
  const panel = useWalletPanel();
  const sending = paymentStage.state === "proving" || paymentStage.state === "submitting" || paymentStage.state === "canceling";
  const mining = get.working;
  return {
    sending,
    mining,
    /** Leaving the page now would lose a proof or an unsent transaction. */
    unsafeToLeave: sending || get.unsafeToLeave,
    unseenOutcome: panel.unseenOutcome,
  };
}

/** Asks before the page unloads, and holds automatic deployment reloads, while `active`. */
export function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    holdDeploymentReload(true);
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    addEventListener("beforeunload", guard);
    return () => { holdDeploymentReload(false); removeEventListener("beforeunload", guard); };
  }, [active]);
}
