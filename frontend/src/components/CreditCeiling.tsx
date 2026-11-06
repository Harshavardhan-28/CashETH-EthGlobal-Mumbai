"use client";

import { useInView } from "@/lib/useInView";
import { Reveal } from "./Reveal";
import styles from "./Sections.module.css";

type Seg = { label: string; pct: number; delay: number; bg: string; reserve?: boolean };

const FUNDED: Seg[] = [
  { label: "A · 7.00%", pct: 40, delay: 0, bg: "var(--lender)" },
  { label: "B · 8.50%", pct: 20, delay: 0.35, bg: "color-mix(in oklch, var(--lender) 70%, var(--bg))" },
];
const BUDGETS: Seg[] = [
  { label: "Research", pct: 10, delay: 0.7, bg: "var(--worker)" },
  { label: "Compute", pct: 30, delay: 0.85, bg: "color-mix(in oklch, var(--worker) 75%, var(--bg))" },
  { label: "Data", pct: 10, delay: 1, bg: "var(--worker)" },
  { label: "Reserve", pct: 10, delay: 1.15, bg: "rgb(var(--ink-rgb) / 0.2)", reserve: true },
];

function Bars({ segs, on }: { segs: Seg[]; on: boolean }) {
  return (
    <div className={styles.bar}>
      {segs.map((s) => (
        <div
          key={s.label}
          className={`${styles.seg} ${s.reserve ? styles.segReserve : ""}`}
          style={{ width: on ? `${s.pct}%` : "0%", background: s.bg, transitionDelay: `${s.delay}s` }}
        >
          {s.label}
        </div>
      ))}
      <div className={styles.marker} />
    </div>
  );
}

export function CreditCeiling() {
  const [ref, on] = useInView<HTMLDivElement>(0.3);

  return (
    <section id="ceiling" className={styles.section} aria-labelledby="ceiling-title">
      <div className={styles.glow} style={{ right: "-10%", top: "10%", width: 700, height: 600, background: "radial-gradient(closest-side, var(--glow-b), transparent)" }} />
      <div className={styles.inner}>
        <Reveal className={styles.copy}>
          <span className={styles.badge}>
            <i />
            CREDIT CEILING
          </span>
          <h2 id="ceiling-title" className={styles.title} style={{ maxWidth: "12ch" }}>
            More agents never means <span>more credit.</span>
          </h2>
        </Reveal>

        <Reveal>
          <div ref={ref} className={styles.glass}>
            <div className={styles.cardGlow} style={{ right: -120, top: -140, width: 360, height: 300, background: "radial-gradient(closest-side, var(--glow-a), transparent)" }} />
            <div className={styles.group}>
              <div className={styles.groupHead}>
                <span>Receivable</span>
                <span>$10,000</span>
              </div>
              <div className={styles.bar}>
                <div className={styles.hatch} />
                <div className={styles.marker} />
              </div>
            </div>
            <div className={styles.group}>
              <div className={styles.groupHead}>
                <span>Funded · cheapest first</span>
                <span>$6,000</span>
              </div>
              <Bars segs={FUNDED} on={on} />
            </div>
            <div className={styles.group}>
              <div className={styles.groupHead}>
                <span>Agent budgets</span>
                <span>≤ funded</span>
              </div>
              <Bars segs={BUDGETS} on={on} />
            </div>
            <div className={styles.legend}>
              <i />
              75% advance · borrowing base $7,500
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
