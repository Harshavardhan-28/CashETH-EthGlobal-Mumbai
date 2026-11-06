import Link from "next/link";
import { Logo } from "../Logo";
import { ThemeToggle } from "../ThemeToggle";
import styles from "./Docs.module.css";

export function DocsHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <div className={styles.brand}>
          <Logo size={26} />
          <span className={styles.ver}>docs · v0.1</span>
        </div>
        <nav className={styles.nav} aria-label="Docs">
          <Link href="/">Home</Link>
          <a href="#mcp">MCP tools</a>
          <a href="#errors">Error codes</a>
          <ThemeToggle />
          <span className="pill">Hedera testnet · 296</span>
        </nav>
      </div>
    </header>
  );
}
