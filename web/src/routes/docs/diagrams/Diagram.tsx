import type { ReactNode } from "react";
import styles from "./diagrams.module.css";

export function Diagram({ children, summary }: { children: ReactNode; summary: ReactNode }) {
  return <figure className={styles.diagram}>
    <div className={styles.diagramCanvas}>{children}</div>
    <figcaption>{summary}</figcaption>
  </figure>;
}
