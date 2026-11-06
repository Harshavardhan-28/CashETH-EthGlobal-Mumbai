import Link from "next/link";
import { Reveal } from "./Reveal";
import styles from "./Sections.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div
        className={styles.glow}
        style={{ left: "50%", bottom: "-95%", width: 1400, height: 760, transform: "translateX(-50%)", background: "radial-gradient(closest-side, var(--glow-a), transparent)" }}
      />
      <div className={styles.footerFade} />
      <div className={styles.footerInner}>
        <Reveal className={styles.cta}>
          <h2>
            Cash me if you <span>can.</span>
          </h2>
          <div className={styles.buttons}>
            <Link href="/docs" className={styles.primary}>
              Read the docs
              <span className={styles.arrow}>→</span>
            </Link>
            <Link href="/docs#quickstart" className={styles.ghost}>
              <span>$</span>npm run demo
            </Link>
          </div>
        </Reveal>
        <div className={styles.legal}>
          <span className={styles.legalBrand}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/CashETH-white.png" alt="" width={22} height={22} className={styles.logoDark} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/CashETH.png" alt="" width={22} height={22} className={styles.logoLight} />
            CashETH
          </span>
          <span>Hedera testnet demo · not production credit</span>
        </div>
      </div>
    </footer>
  );
}
