import Link from "next/link";
import styles from "./Logo.module.css";

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <Link href="/" className={styles.logo} aria-label="CashETH home">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/CashETH-white.png" alt="" width={40} height={40} className={styles.dark} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/CashETH.png" alt="" width={40} height={40} className={styles.light} />
      <span className={styles.word} style={{ fontSize: size }}>
        Cash<em>ETH</em>
      </span>
    </Link>
  );
}
