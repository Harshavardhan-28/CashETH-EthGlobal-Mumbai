import styles from "./Docs.module.css";

export function CodeBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.code}>
      <div className={styles.codeTitle}>{title}</div>
      <pre>{children}</pre>
    </div>
  );
}
