import { LIFECYCLE } from "@/lib/content";
import styles from "./Sections.module.css";

export function Lifecycle() {
  return (
    <section id="flow" className={`container ${styles.flow}`} aria-labelledby="flow-title">
      <div className={styles.head}>
        <h2 id="flow-title" className="display">
          One verified receivable. One shared credit ceiling. <em>Many agents.</em>
        </h2>
        <p className="lede">
          Eight steps, all on Hedera. Registration, funding, spending and repayment settle on one network — funding
          and the <span className={styles.mono}>Financed</span> state land in the same transaction.
        </p>
      </div>
      <ol className={styles.steps} style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {LIFECYCLE.map((s) => (
          <li key={s.n} className={styles.step}>
            <div className={styles.stepTop}>
              <span>{s.n}</span>
              <span className={styles.actor}>
                <span
                  className={styles.swatch}
                  style={s.outline ? { border: "1px solid var(--ink)" } : { background: s.swatch }}
                />
                {s.actor}
              </span>
            </div>
            <h3 className={styles.stepTitle}>{s.title}</h3>
            <code className={styles.stepCode}>{s.code}</code>
            <p className={styles.stepBody}>{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
