"use client";

import { useInView } from "@/lib/useInView";
import { Reveal } from "./Reveal";
import styles from "./Sections.module.css";

const ease = "cubic-bezier(.2,.7,.2,1)";
const LENDER_B = "color-mix(in oklch, var(--lender) 70%, var(--bg))";

const PAYOUTS = [
  { who: "Lender A", color: "var(--lender)", amount: "4,023.01" },
  { who: "Lender B", color: LENDER_B, amount: "2,013.97" },
  { who: "Seller agent", color: "var(--seller)", amount: "3,963.01" },
];

export function Waterfall() {
  const [ref, on] = useInView<HTMLDivElement>(0.3);
  const w = (pct: string) => (on ? pct : "0%");

  return (
    <section id="waterfall" className={styles.section} aria-labelledby="wf-title">
      <div className={styles.inner}>
        <Reveal>
          <div ref={ref} className={`${styles.glass} ${styles.mono}`} style={{ gap: 24 }}>
            <div className={styles.cardGlow} style={{ left: -140, bottom: -160, width: 380, height: 320, background: "radial-gradient(closest-side, var(--glow-a), transparent)" }} />
            <div className={styles.payTotal}>
              <span>Buyer pays the router</span>
              <span>$10,000</span>
            </div>
            <div className={styles.split} aria-hidden="true">
              <div data-testid="split-a" style={{ width: w("40.23%"), background: "var(--lender)", transition: `width .9s ${ease}` }} />
              <div data-testid="split-b" style={{ width: w("20.14%"), background: LENDER_B, transition: `width .7s ${ease} .9s` }} />
              <div data-testid="split-s" style={{ width: w("39.63%"), background: "var(--seller)", transition: `width .7s ${ease} 1.6s` }} />
            </div>
            <div className={styles.payouts}>
              {PAYOUTS.map((p) => (
                <div key={p.who} data-testid="payout" className={styles.payout}>
                  <span>
                    <i style={{ background: p.color }} />
                    {p.who}
                  </span>
                  <span data-testid="payout-amount">{p.amount}</span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal className={styles.copy}>
          <span className={styles.badge}>
            <i />
            REPAYMENT
          </span>
          <h2 id="wf-title" className={styles.title} style={{ maxWidth: "11ch" }}>
            Lenders first. <span>Automatically.</span>
          </h2>
          <code className={styles.formula}>fee = principal × apr × max(elapsed, 30d) / 365d</code>
        </Reveal>
      </div>
    </section>
  );
}
