import Link from "next/link";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { LifecycleStage } from "./LifecycleStage";
import { HeroFx } from "./HeroFx";
import styles from "./Hero.module.css";

export function Hero() {
  return (
    <section className={styles.hero} aria-label="Hero">
      <div className={`${styles.glow} ${styles.glowA}`} />
      <div className={`${styles.glow} ${styles.glowB}`} />
      <div className={`${styles.glow} ${styles.glowC}`} />
      <div className={styles.lines} />
      <div className={styles.dots} />

      <header className={styles.header}>
        <Logo />
        <nav className={styles.nav} aria-label="Primary">
          <a href="#flow">How it works</a>
          <a href="#ceiling">Credit</a>
          <a href="#waterfall">Repayment</a>
          <Link href="/docs">Docs</Link>
        </nav>
        <div className={styles.actions}>
          <ThemeToggle variant="icon" />
          <Link href="/docs" className={styles.start}>
            Get started
            <span className={styles.arrowSm}>→</span>
          </Link>
        </div>
      </header>

      <HeroFx className={styles.body}>
        <div className={styles.copy}>
          <span className={styles.badge}>
            <span className={styles.badgeDot} />
            CASHETH MCP · LIVE ON HEDERA
          </span>
          <h1 className={styles.title}>
            Invoices your agents can <span>spend.</span>
          </h1>
          <p className={styles.sub}>
            An MCP that turns a buyer-signed invoice into USDC working capital your AI agents can spend - settled on
            Hedera.
          </p>
          <div className={styles.ctas}>
            <Link href="/docs" className={styles.primary}>
              Get started
              <span className={styles.arrow}>→</span>
            </Link>
            <Link href="/docs#quickstart" className={styles.secondary}>
              <span>$</span>npm run demo
            </Link>
          </div>
        </div>

        <div className={styles.stage}>
          <LifecycleStage />
        </div>
      </HeroFx>

      <div className={styles.fade} />
    </section>
  );
}
