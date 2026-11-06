import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LoginForm } from "@/components/admin/LoginForm";
import styles from "@/components/admin/Login.module.css";

export const metadata: Metadata = {
  title: "Admin sign in - CashETH",
  robots: { index: false, follow: false },
};

// Static: the proxy sends already-signed-in visitors on to /admin.
export default function AdminLoginPage() {
  return (
    <main className={styles.page}>
      <div className={`${styles.glow} ${styles.glowA}`} />
      <div className={`${styles.glow} ${styles.glowB}`} />
      <div className={styles.theme}>
        <ThemeToggle />
      </div>
      <section className={styles.card}>
        <div className={styles.head}>
          <Logo size={24} />
          <h1 className={styles.title}>Admin console</h1>
          <p className={styles.sub}>Live view of the agents on the CashETH MCP server</p>
        </div>
        <LoginForm />
      </section>
    </main>
  );
}
