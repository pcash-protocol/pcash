import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import styles from "./MarketplaceRoute.module.css";

export function MarketplaceDialog({ label, closeLabel, onClose, returnFocus, children, open = true, focusKey }: {
  label: string;
  closeLabel: string;
  onClose: () => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
  open?: boolean;
  /** Changes when the dialog swaps its content, so focus returns to the dialog. */
  focusKey?: unknown;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  // The wallet's connect modal is not in the top layer, so the dialog stays non-modal while it is open.
  const { connectModalOpen } = useConnectModal();
  useEffect(() => {
    const element = panel.current;
    if (element === null || !open) return;
    if (connectModalOpen) element.show();
    else element.showModal();
    return () => element.close();
  }, [open, connectModalOpen]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      const target = returnFocus?.current ?? previous;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open, returnFocus]);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open, focusKey]);
  return <dialog className={styles.purchaseDialog} ref={panel} role={open ? "dialog" : undefined} aria-label={label} tabIndex={-1}
    onCancel={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <button type="button" className={styles.purchaseClose} aria-label={closeLabel} onClick={onClose}>×</button>
    {children}
  </dialog>;
}
