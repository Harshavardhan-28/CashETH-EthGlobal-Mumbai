"use client";

import { useEffect, useState } from "react";
import { CONSOLE_EVENTS } from "@/lib/content";
import { consoleStats, facilityState } from "@/lib/consoleState";
import { usePrefersReducedMotion } from "@/lib/useInView";
import styles from "./LiveConsole.module.css";

const TOTAL = CONSOLE_EVENTS.length;
const HOLD_TICKS = 4; // pause on the finished state before looping
const TICK_MS = 1400;

export function LiveConsole() {
  const reduce = usePrefersReducedMotion();
  const [r, setR] = useState(0);

  useEffect(() => {
    if (reduce) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setR(TOTAL);
      return;
    }
    let tick = 0;
    const id = setInterval(() => {
      tick = tick >= TOTAL + HOLD_TICKS ? 0 : tick + 1;
      setR(Math.min(tick, TOTAL));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [reduce]);

  const stats = consoleStats(r);
  const maxStep = r ? CONSOLE_EVENTS[r - 1].step : 0;

  return (
    <div className={styles.card}>
      <div className={styles.top}>
        <span className={styles.live}>
          <span className={styles.dot} />
          <span className={styles.liveLabel}>LIVE</span>
          <span>hcs audit · 0.0.48213</span>
        </span>
        <span>receivable 0x7f3a…c21e</span>
      </div>

      <div className={styles.segs} aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
          <div key={n} className={styles.seg}>
            <div
              className={styles.bar}
              style={{
                background:
                  n < maxStep ? "var(--accent)" : n === maxStep ? "var(--ink)" : "rgb(var(--ink-rgb) / 0.12)",
              }}
            />
            <span style={{ color: n <= maxStep ? "var(--ink)" : "var(--faint-2)" }}>0{n}</span>
          </div>
        ))}
      </div>

      <div className={styles.events} role="log" aria-live="off">
        {CONSOLE_EVENTS.map((ev, i) => {
          const shown = i < r;
          return (
            <div
              key={ev.seq}
              className={styles.event}
              style={{ opacity: shown ? 1 : 0, transform: `translateY(${shown ? 0 : 6}px)` }}
            >
              <span className={styles.seq}>{ev.seq}</span>
              <span className={styles.role} style={{ color: ev.color }}>
                {ev.role}
              </span>
              <span className={styles.body}>
                <span className={styles.type} style={{ color: ev.err ? "var(--err)" : "var(--ink)" }}>
                  {ev.type}
                </span>
                <span className={styles.detail}>{ev.detail}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className={styles.stats}>
        <Stat label="STATE" value={facilityState(r)} accent />
        <Stat label="BORROWING BASE" value={stats.base} />
        <Stat label="FUNDED" value={stats.funded} />
        <Stat label="LENDERS OWED" value={stats.owed} last />
      </div>
    </div>
  );
}

function Stat({ label, value, accent, last }: { label: string; value: string; accent?: boolean; last?: boolean }) {
  return (
    <div className={styles.stat} style={last ? { borderRight: 0 } : undefined}>
      <span className={styles.statLabel}>{label}</span>
      <span style={{ fontSize: 14, color: accent ? "var(--accent)" : undefined }}>{value}</span>
    </div>
  );
}
