import Link from "next/link";
import styles from "./Logo.module.css";

/** `size` is the wordmark font size in px; the mark scales with it. */
export function Logo({ size = 30 }: { size?: number }) {
  const icon = Math.round(size * 1.54);
  return (
    <Link href="/" className={styles.logo} aria-label="CashETH home">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/CashETH-white.png" alt="" width={icon} height={icon} className={styles.dark} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/CashETH.png" alt="" width={icon} height={icon} className={styles.light} />
      <span className={styles.word} style={{ fontSize: size }}>
        Cash<span>ETH</span>
      </span>
    </Link>
  );
}
