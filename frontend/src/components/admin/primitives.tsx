import type { ReactNode } from "react";
import type { AgentStats, LenderYield } from "@/lib/admin/api";
import type { RunStatus } from "@/lib/admin/derive";
import type { Actor, ActorRole } from "@/lib/admin/narrate";
import { SCORE_MAX, scoreBand } from "@/lib/admin/format";
import styles from "./Admin.module.css";

export const ROLE_COLOR: Record<ActorRole, string> = {
  seller: "var(--seller)",
  buyer: "var(--buyer)",
  worker: "var(--worker)",
  lender: "var(--lender)",
  mcp: "var(--mcp)",
};

export const ROLE_PLURAL: Record<ActorRole, string> = { seller: "Sellers", buyer: "Buyers", worker: "Workers", lender: "Lenders", mcp: "CashETH MCP" };

/** What the agent does, in plain words. */
export function jobOf(role: ActorRole, lender?: LenderYield): string {
  switch (role) {
    case "seller":
      return "Borrows against its invoices";
    case "buyer":
      return "Confirms and pays invoices";
    case "worker":
      return "Spends the loan on paid APIs";
    case "lender":
      return lender && lender.blendedApr > 0 ? `Lends capital · ${lender.blendedApr.toFixed(1)}% return` : "Lends capital";
    default:
      return "The CashETH MCP server";
  }
}

export function lenderOf(stats: AgentStats, lenders: LenderYield[]): LenderYield | undefined {
  return lenders.find((l) => l.address.toLowerCase() === stats.address.toLowerCase());
}

export function Avatar({ actor, size = 32 }: { actor: Pick<Actor, "initials" | "role" | "name">; size?: number }) {
  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, background: ROLE_COLOR[actor.role], fontSize: Math.round(size * 0.38), borderRadius: Math.round(size * 0.28) }}
      aria-hidden="true"
      title={actor.name}
    >
      {actor.initials || "?"}
    </span>
  );
}

export type ChipKind = "active" | "idle" | RunStatus;

const CHIP: Record<ChipKind, { label: string; cls: string }> = {
  active: { label: "Active", cls: styles.chipGood },
  idle: { label: "Idle", cls: styles.chipIdle },
  in_progress: { label: "In progress", cls: styles.chipGood },
  repaid: { label: "Repaid", cls: styles.chipIdle },
  overdue: { label: "Overdue", cls: styles.chipWarn },
  defaulted: { label: "Defaulted", cls: styles.chipBad },
  rejected: { label: "Rejected", cls: styles.chipBad },
};

export function StatusChip({ kind }: { kind: ChipKind }) {
  const { label, cls } = CHIP[kind];
  return (
    <span className={`${styles.chip} ${cls}`}>
      <i />
      {label}
    </span>
  );
}

/** The engine's credit score (0 to 750, not a percentage): the bar fills relative to the best possible score. */
export function ScoreBar({ score }: { score: number }) {
  const known = Number.isFinite(score);
  const value = known ? Math.round(score) : 0;
  const fill = known ? Math.max(0, Math.min(100, (value / SCORE_MAX) * 100)) : 0;
  const band = scoreBand(value);
  return (
    <span className={styles.score} aria-label={known ? `Credit score ${value} of ${SCORE_MAX}, ${band.label}` : "Credit score unknown"} title={known ? `${band.label} · ${band.advance}` : undefined}>
      <span className={styles.track}>
        <b style={{ width: `${fill}%`, background: band.tone === "bad" ? "var(--err)" : band.tone === "warn" ? "var(--warn)" : undefined }} />
      </span>
      {known ? value : "—"}
    </span>
  );
}

/** Area sparkline in the accent colour; flat when every value is equal. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const w = 100;
  const h = 30;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [i * step, h - 3 - ((v - min) / span) * (h - 6)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const id = `spark-${label.replace(/\W+/g, "-")}`;
  return (
    <svg className={styles.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${label} trend`}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {pts.length > 1 && <polygon points={`0,${h} ${line} ${w},${h}`} fill={`url(#${id})`} />}
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <b>{title}</b>
      {children}
    </div>
  );
}

/* ---------- icons (16px line icons, currentColor) ---------- */
const P = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const Icon = {
  overview: () => (
    <svg {...P} aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  agents: () => (
    <svg {...P} aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.6 2.5 3 5.2" />
    </svg>
  ),
  activity: () => (
    <svg {...P} aria-hidden="true">
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  ),
  runs: () => (
    <svg {...P} aria-hidden="true">
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5M9 13h7M9 17h5" />
    </svg>
  ),
  proof: () => (
    <svg {...P} aria-hidden="true">
      <path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  ),
  docs: () => (
    <svg {...P} aria-hidden="true">
      <path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" />
      <path d="M8 7h6M8 11h6" />
    </svg>
  ),
  search: () => (
    <svg {...P} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  ),
  bolt: () => (
    <svg {...P} aria-hidden="true">
      <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
    </svg>
  ),
  coins: () => (
    <svg {...P} aria-hidden="true">
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  ),
  card: () => (
    <svg {...P} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18M7 15h4" />
    </svg>
  ),
  chain: () => (
    <svg {...P} aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  ),
  arrowLeft: () => (
    <svg {...P} aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  ),
};
