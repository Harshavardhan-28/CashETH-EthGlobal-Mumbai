"use client";

import { useState, type ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { HCS_TOPIC_ID } from "@/lib/admin/api";
import type { Range } from "@/lib/admin/derive";
import type { ConnStatus } from "@/lib/admin/useAdminData";
import styles from "./Admin.module.css";
import { Icon } from "./primitives";
import { SignOutButton } from "./SignOutButton";
import type { View } from "./route";

const CONN: Record<ConnStatus, { label: string; cls: string }> = {
  live: { label: "Live · MCP connected", cls: styles.connLive },
  offline: { label: "MCP offline", cls: styles.connOffline },
  loading: { label: "Connecting…", cls: styles.connLoading },
};

export function TopBar({ status, query, onQuery }: { status: ConnStatus; query: string; onQuery(q: string): void }) {
  const [menu, setMenu] = useState(false);
  const conn = CONN[status];
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <Logo size={20} />
        <span className={styles.brandTag}>Admin</span>
      </div>
      <span className={styles.netPill}>
        Network <b>Hedera testnet</b>
      </span>
      <label className={styles.search}>
        <Icon.search />
        <input type="search" placeholder="Search agents, invoices, transactions" value={query} onChange={(e) => onQuery(e.target.value)} aria-label="Search" />
      </label>
      <div className={styles.barRight}>
        <span className={`${styles.conn} ${conn.cls}`} role="status" aria-label={conn.label}>
          <i />
          <span>{conn.label}</span>
        </span>
        <ThemeToggle variant="icon" />
        <div className={styles.me}>
          <button type="button" className={styles.meBtn} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            AD
          </button>
          {menu && (
            <div className={styles.menu} role="menu">
              <p>Signed in as admin</p>
              <SignOutButton />
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

const NAV: { view: View; label: string; icon: () => ReactNode }[] = [
  { view: "overview", label: "Overview", icon: Icon.overview },
  { view: "agents", label: "Agents", icon: Icon.agents },
  { view: "activity", label: "Activity", icon: Icon.activity },
  { view: "runs", label: "Runs", icon: Icon.runs },
];

export function SideNav({ view, onView, counts }: { view: View; onView(v: View): void; counts: Partial<Record<View, number>> }) {
  return (
    <nav className={styles.nav} aria-label="Admin">
      {NAV.map(({ view: v, label, icon: I }) => (
        <button key={v} type="button" className={`${styles.navItem} ${view === v ? styles.navOn : ""}`} aria-current={view === v ? "page" : undefined} onClick={() => onView(v)}>
          <I />
          {label}
          {counts[v] !== undefined && <span className={styles.navCount}>{counts[v]}</span>}
        </button>
      ))}
      <div className={styles.navGroup}>Proof</div>
      <a className={styles.navItem} href={`https://hashscan.io/testnet/topic/${HCS_TOPIC_ID}`} target="_blank" rel="noopener noreferrer">
        <Icon.proof />
        Hedera audit log ↗
      </a>
      <div className={styles.navGroup}>Help</div>
      <a className={styles.navItem} href="/docs">
        <Icon.docs />
        Docs
      </a>
      <div className={styles.navFoot}>Every action here is recorded on the Hedera audit topic {HCS_TOPIC_ID}.</div>
    </nav>
  );
}

const RANGES: { value: Range; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "all", label: "All" },
];

export function RangeControl({ range, onRange }: { range: Range; onRange(r: Range): void }) {
  return (
    <div className={styles.seg} role="group" aria-label="Time range">
      {RANGES.map((r) => (
        <button key={r.value} type="button" aria-pressed={range === r.value} onClick={() => onRange(r.value)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function PageHead({ title, subtitle, children, back }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode; back?: { label: string; onClick(): void } }) {
  return (
    <div className={styles.pageHead}>
      <div>
        {back && (
          <button type="button" className={styles.back} onClick={back.onClick}>
            <Icon.arrowLeft />
            {back.label}
          </button>
        )}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
