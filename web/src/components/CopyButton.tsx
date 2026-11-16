import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons.tsx";
import styles from "./CopyButton.module.css";

/** The text to copy: held by the page, or fetched on click with `load`. */
type CopySource = { value: string | undefined; load?: undefined } | { value?: undefined; load: () => Promise<string> };

/**
 * Starts the clipboard write inside the click. Safari refuses a write that
 * starts after an await, so a fetched text goes in as a pending clipboard item
 * where the browser supports one.
 */
function writeLater(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })]);
  }
  return text.then((value) => navigator.clipboard.writeText(value));
}

/**
 * Copies `value`, or the text `load` returns, and reports the outcome on the
 * button and to assistive technology. The button is an icon named by `label`;
 * `showLabel` also shows the label as text, for a button whose value is not on
 * screen beside it.
 */
export function CopyButton({ value, load, label, showLabel = false, className, disabled, onFailed }: CopySource & {
  label: string;
  showLabel?: boolean;
  className?: string | undefined;
  disabled?: boolean | undefined;
  onFailed?: (() => void) | undefined;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => setState("idle"), [value]);
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [state]);
  // The executor runs `write` inside the click, and turns a throw into a failure.
  const copy = (write: () => Promise<void>) => void new Promise<void>((resolve) => resolve(write()))
    .then(() => setState("copied"), () => { setState("failed"); onFailed?.(); });
  // An icon button keeps the icon style; a labelled one takes the caller's.
  const look = showLabel && className !== undefined ? className : className === undefined ? styles.icon : `${styles.icon} ${className}`;
  return <>
    <button type="button" className={`${styles.copy} ${look}`} aria-label={showLabel ? undefined : label}
      disabled={disabled === true || (value === undefined && load === undefined)} data-copy-state={state}
      title={state === "failed" ? "Your browser blocked clipboard access. Select the text and copy it manually." : showLabel ? undefined : label}
      onClick={() => {
        if (load !== undefined) copy(() => writeLater(load()));
        else if (value !== undefined) copy(() => navigator.clipboard.writeText(value));
      }}>
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}{showLabel && <span>{label}</span>}
    </button>
    <span className="sr-only" role="status">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}</span>
  </>;
}
