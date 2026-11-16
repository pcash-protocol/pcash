import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import styles from "./Tooltip.module.css";

/**
 * Shows `tip` while the wrapped control is hovered or focused; Escape hides it
 * without reaching an enclosing dialog.
 * `children` receives the tip's id for the control's `aria-describedby`.
 * `block` lets a full-width control keep its width; `className` places the
 * wrapper where its parent lays the control out.
 */
export function Tooltip({ tip, align = "start", placement = "bottom", block = false, className = "", children }: {
  tip: ReactNode;
  align?: "start" | "end";
  placement?: "top" | "bottom";
  block?: boolean;
  className?: string | undefined;
  children: (tipId: string) => ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <span className={`${styles.anchor} ${block ? styles.block : ""} ${className}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
    onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
    {children(id)}
    <span role="tooltip" id={id} className={`${styles.bubble} ${align === "end" ? styles.end : styles.start} ${placement === "top" ? styles.top : ""}`} hidden={!open}>{tip}</span>
  </span>;
}

/**
 * A "?" button for touch screens as well as a mouse: a tap or click toggles
 * `tip`, a mouse hover shows it, and Escape, a tap outside, or moving focus
 * away closes it. The tip spans the nearest positioned ancestor, below it.
 */
export function HelpTip({ label, tip }: { label: string; tip: ReactNode }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!anchor.current?.contains(event.target as Node)) setPinned(false); };
    // Captured at the document so an open tip takes Escape before an enclosing dialog does.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPinned(false);
      setHovered(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  // Only a mouse hovers: a tap's emulated hover would keep the tip open after a second tap.
  const hover = (value: boolean) => (event: PointerEvent) => { if (event.pointerType === "mouse") setHovered(value); };
  // A click that unpins also ends the hover, so the tip stays closed until the pointer re-enters.
  const toggle = () => { if (pinned) setHovered(false); setPinned(!pinned); };
  return <span ref={anchor} className={styles.helpAnchor} onPointerEnter={hover(true)} onPointerLeave={hover(false)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPinned(false); }}>
    <button type="button" className={styles.help} aria-label={label} aria-expanded={open} aria-describedby={id}
      onClick={toggle}>?</button>
    <span role="tooltip" id={id} className={`${styles.bubble} ${styles.helpBubble}`} hidden={!open}>{tip}</span>
  </span>;
}
