import { useEffect, useId, useRef, useState } from "react";
import styles from "./MarketplaceRoute.module.css";

export type TokenOption = { key: string; label: string; name: string; listings: number };

/** A dropdown that narrows the listings to the tokens checked in it; none checked shows every token. */
export function TokenFilter({ options, selected, onChange }: {
  options: readonly TokenOption[];
  selected: ReadonlySet<string>;
  onChange: (selected: ReadonlySet<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const search = query.trim().toLowerCase();
  const matching = options.filter((option) => search === ""
    || option.label.toLowerCase().includes(search) || option.name.toLowerCase().includes(search));
  const chosen = options.filter((option) => selected.has(option.key));
  const summary = chosen.length === 0 ? "All tokens" : chosen.length <= 2 ? chosen.map((option) => option.label).join(", ") : `${chosen.length} tokens`;
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (!next.delete(key)) next.add(key);
    onChange(next);
  };
  return <div className={styles.tokenFilter} ref={root} onKeyDown={(event) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  }}>
    <button type="button" ref={trigger} className={styles.tokenFilterTrigger} aria-expanded={open} aria-controls={menu}
      onClick={() => setOpen((value) => !value)}>
      <span className={styles.muted}>Tokens:</span> {summary} <span aria-hidden="true">▾</span>
    </button>
    {chosen.length > 0 && <button type="button" className={styles.showAll} onClick={() => onChange(new Set())}>Show all</button>}
    {open && <div className={styles.tokenMenu} id={menu} role="group" aria-label="Filter by token">
      <input type="search" autoFocus aria-label="Search tokens" placeholder="Search tokens" value={query}
        onChange={(event) => setQuery(event.target.value)} />
      <ul className={styles.tokenOptions}>
        {search === "" && <li><label>
          <input type="checkbox" checked={chosen.length === 0} onChange={() => onChange(new Set())} />
          <span className={styles.tokenName}><strong>All tokens</strong></span>
        </label></li>}
        {matching.map((option) => <li key={option.key}><label>
          <input type="checkbox" checked={selected.has(option.key)} onChange={() => toggle(option.key)} />
          <span className={styles.tokenName}><strong>{option.label}</strong>{option.name !== option.label && <> <span className={styles.muted}>{option.name}</span></>}</span>
          <span className={styles.tokenCount}>{option.listings}</span>
        </label></li>)}
      </ul>
      {matching.length === 0 && <p className={styles.muted}>No listed token matches “{query.trim()}”.</p>}
    </div>}
  </div>;
}
