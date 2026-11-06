"use client";

import { useInView } from "@/lib/useInView";
import styles from "./Sections.module.css";

const ease = "cubic-bezier(.2,.7,.2,1)";

const rows = [
  { n: "1", color: "var(--lender)", who: "Lender A", detail: "4,000.00 + 23.01 fee", amt: "4,023.01" },
  { n: "1", color: "var(--lender-2)", who: "Lender B", detail: "2,000.00 + 13.97 fee", amt: "2,013.97" },
  { n: "2", color: "var(--seller)", who: "Seller agent", detail: "remainder + undrawn credit", amt: "3,963.01" },
];

export function Waterfall() {
  const [ref, on] = useInView<HTMLDivElement>(0.3);

  return (
    <section id="waterfall" className={styles.section} aria-labelledby="wf-title">
      <div className={`container ${styles.wfGrid}`}>
        <div className={styles.wfCopy}>
          <span className="eyebrow">REPAYMENT WATERFALL</span>
          <h2 id="wf-title" className="display">
            Lenders first. <em>Automatically.</em>
          </h2>
          <p className="lede">
            The buyer pays the router named in its own signature. The router pays lenders pro rata — principal plus
            fee — then sends the remainder to the seller agent. Partial, late and post-default payments all reach
            lenders first.
          </p>
          <div className={styles.formula}>
            <div>
              <b>fee_i</b> = principal_i × apr_i × max(elapsed, 30d) / 365d
            </div>
            <div>
              <b>lenderDue</b> = Σ (principal_i + fee_i)
            </div>
          </div>
        </div>

        <div ref={ref} className={styles.wf}>
          <div className={styles.wfTotal}>
            <span>Buyer pays router</span>
            <span className={styles.wfAmount}>$10,000.00</span>
          </div>
          <div className={styles.wfBar} aria-hidden="true">
            <div style={{ width: on ? "40.23%" : "0%", background: "var(--lender)", transition: `width .9s ${ease}` }} />
            <div
              style={{
                width: on ? "20.14%" : "0%",
                background: "var(--lender-2)",
                borderLeft: "1px solid var(--bg)",
                transition: `width .7s ${ease} .9s`,
              }}
            />
            <div
              style={{
                width: on ? "39.63%" : "0%",
                background: "var(--seller)",
                borderLeft: "1px solid var(--bg)",
                transition: `width .7s ${ease} 1.6s`,
              }}
            />
          </div>
          <div className={styles.wfRows}>
            {rows.map((r) => (
              <div key={r.who} className={styles.wfRow}>
                <span>{r.n}</span>
                <span className={styles.wfWho}>
                  <i style={{ background: r.color }} />
                  {r.who}
                  <small>{r.detail}</small>
                </span>
                <span>{r.amt}</span>
              </div>
            ))}
            <div className={styles.wfFoot}>
              <span>state Repaid · debt 0</span>
              <span>USDC 0.0.429274</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
