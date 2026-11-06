import Link from "next/link";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { PacketCanvas } from "./PacketCanvas";
import { LifecycleStage } from "./LifecycleStage";
import styles from "./Hero.module.css";

export function Hero() {
  return (
    <section className={styles.hero} aria-label="Hero">
      <div className={styles.grid} />
      <PacketCanvas density={12} />
      <div className={styles.fade} />

      <header className={`container ${styles.header}`}>
        <Logo />
        <nav className={styles.nav} aria-label="Primary">
          <a href="#flow">Lifecycle</a>
          <a href="#ceiling">Credit ceiling</a>
          <a href="#waterfall">Repayment</a>
          <Link href="/docs">Docs</Link>
          <ThemeToggle />
          <Link href="/docs" className={styles.net}>
            Hedera testnet · 296
          </Link>
        </nav>
      </header>

      <div className={`container ${styles.body}`}>
        <div className={styles.copy}>
          <div className={styles.kicker}>
            <span className={styles.kickerDot} />
            <span>
              <b>Cash me if you can!</b> · Autonomous working capital
            </span>
          </div>
          <h1 className={styles.title}>
            Invoices your agents can <em>spend.</em>
          </h1>
          <p className={styles.sub}>
            A seller agent turns a buyer-signed receivable into USDC working capital. Worker agents spend it through
            x402. When the buyer pays, lenders are repaid first — automatically.
          </p>
          <div className={styles.ctas}>
            <Link href="/docs" className={styles.primary}>
              Read the docs <span>→</span>
            </Link>
            <Link href="/docs#quickstart" className={styles.secondary}>
              <span>$</span>npm run demo
            </Link>
          </div>
        </div>

        <LifecycleStage />
      </div>
    </section>
  );
}
