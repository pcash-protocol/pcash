import styles from "./PageSkeleton.module.css";

export function PageSkeleton() {
  return <section className={styles.page} aria-label="Loading page" aria-busy="true" role="status">
    <div className={styles.title} aria-hidden="true" />
    <div className={styles.subtitle} aria-hidden="true" />
    <div className={styles.summary} aria-hidden="true" />
    <div className={styles.row} aria-hidden="true" />
    <div className={styles.row} aria-hidden="true" />
  </section>;
}
