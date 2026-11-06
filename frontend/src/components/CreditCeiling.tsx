"use client";

import { useInView } from "@/lib/useInView";
import styles from "./Sections.module.css";

const ease = "cubic-bezier(.2,.7,.2,1)";

function Seg({
  w,
  bg,
  delay,
  dur,
  sep,
  light,
  small,
  children,
}: {
  w: string;
  bg: string;
  delay: number;
  dur: number;
  sep?: boolean;
  light?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`${styles.seg} ${sep ? styles.segSep : ""}`}
      style={{
        width: w,
        background: bg,
        transition: `width ${dur}s ${ease} ${delay}s`,
        color: light ? "var(--ink)" : undefined,
        fontSize: small ? 11 : undefined,
        padding: small ? "0 10px" : undefined,
      }}
    >
      {children}
    </div>
  );
}

export function CreditCeiling() {
  const [ref, on] = useInView<HTMLDivElement>(0.3);
  const w = (v: string) => (on ? v : "0%");

  return (
    <section id="ceiling" className={`${styles.section} ${styles.surface}`} aria-labelledby="ceiling-title">
      <div className={`container ${styles.inner}`}>
        <div className={styles.head}>
          <div className={styles.headStack}>
            <span className="eyebrow">CREDIT CEILING</span>
            <h2 id="ceiling-title" className="display">
              More agents never means <em>more credit.</em>
            </h2>
          </div>
          <p className="lede">
            Budgets are carved out of what lenders funded, never added to it. Every limit is checked by the policy
            engine, then again by the contract — with the same error code.
          </p>
        </div>

        <div ref={ref} className={styles.bars}>
          <div className={styles.row}>
            <div className={styles.rowHead}>
              <span>Receivable · INV-2207 · Net 30</span>
              <span>$10,000.00</span>
            </div>
            <div className={`${styles.track} ${styles.hatched}`}>
              <div className={styles.cap} />
              <span className={styles.capLabel}>75% advance</span>
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.rowHead}>
              <span>Funded through Aqua · cheapest first</span>
              <span>
                $6,000.00 <span style={{ color: "var(--faint)" }}>of $7,500.00 base</span>
              </span>
            </div>
            <div className={styles.track}>
              <Seg w={w("40%")} bg="var(--lender)" dur={1} delay={0}>
                A · 7.00% · $4,000
              </Seg>
              <Seg w={w("20%")} bg="var(--lender-2)" dur={1} delay={0.35} sep>
                B · 8.50% · $2,000
              </Seg>
              <div className={styles.headroom}>headroom</div>
              <div className={styles.cap} />
              <span className={styles.skipped}>C · 13.00%</span>
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.rowHead}>
              <span>Agent budgets · sum ≤ funded</span>
              <span>$6,000.00</span>
            </div>
            <div className={styles.track}>
              <Seg w={w("10%")} bg="var(--worker)" dur={0.8} delay={0.7} small>
                Research
              </Seg>
              <Seg w={w("30%")} bg="var(--worker-2)" dur={0.8} delay={0.85} sep small>
                Compute · $3,000
              </Seg>
              <Seg w={w("10%")} bg="var(--worker)" dur={0.8} delay={1} sep small>
                Data
              </Seg>
              <Seg w={w("10%")} bg="rgb(var(--ink-rgb) / 0.22)" dur={0.8} delay={1.15} sep light small>
                Reserve
              </Seg>
              <div className={styles.cap} />
            </div>
          </div>

          <div className={styles.axis} aria-hidden="true">
            <span>$0</span>
            <span>$2.5k</span>
            <span>$5k</span>
            <span>$7.5k</span>
            <span>$10k</span>
          </div>

          <div className={styles.errors}>
            <div className={styles.errCard}>
              <span>AGENT_BUDGET_EXCEEDED</span>
              <span>compute agent · reserve_spend $5,500 · budget $3,000</span>
            </div>
            <div className={styles.errCard}>
              <span>GLOBAL_CREDIT_LIMIT_EXCEEDED</span>
              <span>any request above the facility&apos;s remaining capacity</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
