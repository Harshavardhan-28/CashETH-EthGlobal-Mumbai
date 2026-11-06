"use client";

import { useEffect, useRef, useState } from "react";
import {
  COINS,
  COUNT_MS,
  COUNT_PHASE,
  FINAL_PHASE,
  INTRO_AMOUNT,
  INTRO_TIMELINE,
  REVEAL_PHASE,
  SKIP_DISSOLVE_MS,
  coinFrame,
  formatAmount,
  introFrame,
} from "@/lib/intro";
import styles from "./Intro.module.css";

/**
 * Opening animation: an invoice is verified, turned into coins and poured into the
 * liquidity pool. Server-rendered opaque so the page never flashes before it plays;
 * skipped entirely for reduced motion.
 */
export function Intro() {
  const [on, setOn] = useState(true);
  const [phase, setPhase] = useState(0);
  const [amount, setAmount] = useState(0);
  const [vh, setVh] = useState(800);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const raf = useRef(0);

  useEffect(() => {
    const root = document.documentElement;
    const release = () => {
      root.style.overflow = "";
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOn(false);
      return;
    }

    setVh(window.innerHeight);
    root.style.overflow = "hidden";

    const countUp = () => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const k = Math.min(1, (now - t0) / COUNT_MS);
        setAmount(Math.round(INTRO_AMOUNT * (1 - Math.pow(1 - k, 3))));
        if (k < 1) raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    };

    timers.current = INTRO_TIMELINE.map(([ms, p]) =>
      setTimeout(() => {
        setPhase(p);
        if (p === COUNT_PHASE) countUp();
        if (p === REVEAL_PHASE) release();
        if (p === FINAL_PHASE) setOn(false);
      }, ms),
    );

    return () => {
      timers.current.forEach(clearTimeout);
      cancelAnimationFrame(raf.current);
      release();
    };
  }, []);

  const skip = () => {
    timers.current.forEach(clearTimeout);
    cancelAnimationFrame(raf.current);
    document.documentElement.style.overflow = "";
    setPhase(REVEAL_PHASE);
    setAmount(INTRO_AMOUNT);
    timers.current = [setTimeout(() => setOn(false), SKIP_DISSOLVE_MS)];
  };

  if (!on) return null;

  const f = introFrame(phase, vh);

  return (
    <div
      data-testid="intro"
      role="dialog"
      aria-label="Intro animation"
      className={styles.overlay}
      style={{
        opacity: f.overlayOpacity,
        transform: f.overlayTransform,
        pointerEvents: f.overlayPointerEvents,
      }}
    >
      <div className={styles.dots} />
      <div className={styles.top}>
        <span className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/CashETH-white.png" alt="" width={26} height={26} className={styles.dark} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/CashETH.png" alt="" width={26} height={26} className={styles.light} />
          <span className={styles.word}>
            Cash<em>ETH</em>
          </span>
        </span>
        <span className={styles.caption} data-testid="intro-caption">
          {f.caption}
        </span>
      </div>

      <div className={styles.invoice} aria-hidden="true" style={{ opacity: f.invoiceOpacity, transform: f.invoiceTransform }}>
        <div className={styles.invHead}>
          <span className={styles.invTitle}>Invoice</span>
          <span className={styles.invId}>INV-2207</span>
        </div>
        <div className={styles.parties}>
          <div>
            <span className={styles.label}>FROM</span>
            <span>Seller agent</span>
            <span className={styles.addr}>0x7f3a…c21e</span>
          </div>
          <div>
            <span className={styles.label}>BILL TO</span>
            <span>Buyer agent</span>
            <span className={styles.addr}>0x91b0…4e07</span>
          </div>
        </div>
        <div className={styles.lines}>
          {[
            ["Research datasets · 12 mo", "6,000.00"],
            ["Compute credits", "3,000.00"],
            ["Integration support", "1,000.00"],
          ].map(([name, amt]) => (
            <div key={name}>
              <span>{name}</span>
              <span className={styles.mono}>{amt}</span>
            </div>
          ))}
        </div>
        <div className={styles.total}>
          <span>Total due · Net 30</span>
          <span className={styles.totalAmt}>$10,000.00</span>
        </div>
        <div className={styles.sig}>
          <span>✓ EIP-712 signed by buyer</span>
          <span>USDC</span>
        </div>
        <div className={styles.stamp} style={{ opacity: f.stampOpacity, transform: f.stampTransform }}>
          VERIFIED
          <br />
          FINANCEABLE
        </div>
      </div>

      <div className={styles.pool} style={{ opacity: f.poolOpacity }}>
        <div className={styles.basin}>
          <div className={styles.liquid} style={{ height: f.poolHeight }}>
            <div className={styles.wave} style={{ opacity: f.waveOpacity }} />
          </div>
        </div>
        <span className={styles.poolLabel}>LIQUIDITY POOL · 1INCH AQUA</span>
      </div>

      {COINS.map((coin, i) => {
        const c = coinFrame(coin, i, phase, vh);
        return (
          <span
            key={i}
            className={styles.coin}
            aria-hidden="true"
            style={{
              background: c.background,
              transform: c.transform,
              opacity: c.opacity,
              transition: c.transition,
            }}
          >
            {c.glyph}
          </span>
        );
      })}

      <div className={styles.headline} style={{ opacity: f.labelOpacity, transform: f.labelTransform }}>
        <span className={styles.amount} data-testid="intro-amount">
          {formatAmount(amount)}
        </span>
        <span className={styles.amountSub}>working capital your agents can spend</span>
      </div>

      <button type="button" className={styles.skip} onClick={skip}>
        Skip intro →
      </button>
    </div>
  );
}
