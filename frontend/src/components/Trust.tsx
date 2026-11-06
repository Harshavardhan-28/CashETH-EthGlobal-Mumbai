import { STACK_TAGS, TRUST_POINTS } from "@/lib/content";
import styles from "./Sections.module.css";

export function Trust() {
  return (
    <section className={`${styles.section} ${styles.surface}`} aria-label="Trust model">
      <div className={`container ${styles.trustInner}`}>
        <div className={styles.trust}>
          {TRUST_POINTS.map((t) => (
            <div key={t.title} className={styles.trustItem}>
              <h3>{t.title}</h3>
              <p>
                {t.body.includes("explain_decision") ? (
                  <>
                    Credit decisions are deterministic. <code>explain_decision</code> narrates why a request passed or
                    failed.
                  </>
                ) : (
                  t.body
                )}
              </p>
            </div>
          ))}
        </div>
        <div className={styles.tags}>
          {STACK_TAGS.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
