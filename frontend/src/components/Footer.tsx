import Link from "next/link";
import styles from "./Sections.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.footerInner}`}>
        <Link href="/docs" className={styles.cta}>
          <span className={styles.ctaTitle}>Read the build spec →</span>
          <span className={styles.ctaMeta}>contracts · MCP tools · error codes</span>
        </Link>
        <div className={styles.legal}>
          <span>CashETH · Cash me if you can!</span>
          <span>Hedera testnet demo · not production credit</span>
        </div>
      </div>
    </footer>
  );
}
