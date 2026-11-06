import { PRINCIPLES } from "@/lib/content";
import { Reveal } from "./Reveal";
import styles from "./Sections.module.css";

const STACK = [
  { name: "Hedera", mark: "ℏ", style: { background: "#111", borderRadius: "50%", border: "1px solid rgb(var(--ink-rgb) / 0.2)" } },
  { name: "1inch Aqua", mark: "1\"", style: { background: "#0f1a2e", borderRadius: 7, fontSize: 11, fontWeight: 700 } },
  { name: "USDC", mark: "$", style: { background: "#2775CA", borderRadius: "50%", fontSize: 13 } },
  { name: "x402", mark: "402", style: { background: "var(--ink)", color: "var(--bg)", borderRadius: 6, width: "auto", height: "auto", padding: "4px 7px", fontSize: 10.5, fontFamily: "var(--font-mono)" } },
  { name: "MCP", mark: "M", style: { border: "1.5px solid var(--ink-2)", color: "inherit", borderRadius: 7, boxSizing: "border-box", fontSize: 10, fontFamily: "var(--font-mono)" } },
] as const;

export function Principles() {
  return (
    <section className={styles.principles} aria-label="Principles">
      <div className={styles.cards}>
        {PRINCIPLES.map((text, i) => (
          <Reveal key={text} index={i} className={styles.card}>
            {i === 0 && (
              <div
                className={styles.cardGlow}
                style={{ right: -90, top: -110, width: 260, height: 220, filter: "blur(16px)", background: "radial-gradient(closest-side, var(--glow-a), transparent)" }}
              />
            )}
            <span className={styles.cardNo}>{String(i + 1).padStart(2, "0")}</span>
            <span className={styles.cardText}>{text}</span>
          </Reveal>
        ))}
      </div>

      <Reveal className={styles.stack}>
        <span className={styles.stackLabel}>BUILT WITH</span>
        {STACK.map((s) => (
          <span key={s.name} className={styles.brand}>
            <span className={styles.mark} style={s.style}>
              {s.mark}
            </span>
            {s.name}
          </span>
        ))}
      </Reveal>
    </section>
  );
}
