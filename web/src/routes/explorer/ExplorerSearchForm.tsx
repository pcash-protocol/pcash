import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { searchPath } from "./paths.ts";
import styles from "./ExplorerSearchForm.module.css";

/** Searches the explorer. `/` focuses it from anywhere on the page. */
export function ExplorerSearchForm({ initial = "" }: { initial?: string }) {
  const navigate = useNavigate();
  const [input, setInput] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      field.current?.focus();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (value !== "") navigate(searchPath(value));
  };
  return <div className={styles.searchWrap}>
    <form className={styles.search} role="search" onSubmit={submit}>
      <input
        ref={field}
        type="search"
        aria-label="Explorer search"
        aria-keyshortcuts="/"
        title="Press / to search"
        placeholder="Address, name, block, transaction or batch"
        value={input}
        onChange={(event) => setInput(event.target.value)}
      />
      <button type="submit">Search</button>
    </form>
  </div>;
}
