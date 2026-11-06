import type { ReactNode } from "react";
import a from "@/components/admin/Admin.module.css";
import { Avatar, Icon } from "@/components/admin/primitives";
import type { AgentStats } from "@/lib/admin/api";
import { formatUsdc, initials, shortAddress } from "@/lib/admin/format";
import { daysUntil, type Invoice, type InvoiceState } from "@/lib/dashboard/derive";
import d from "./Dashboard.module.css";

/** A headline number in the admin KPI style, without the sparkline. */
export function Stat({ label, value, sub, tone = "muted", icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "accent" | "muted" | "warn" | "err"; icon: ReactNode }) {
  const color = tone === "accent" ? undefined : tone === "warn" ? "var(--warn)" : tone === "err" ? "var(--err)" : "var(--faint)";
  return (
    <div className={`${a.card} ${a.kpi}`}>
      <div className={a.kpiLabel}>
        <span className={a.kpiIcon}>{icon}</span>
        {label}
      </div>
      <div className={a.kpiValue}>{value}</div>
      {sub !== undefined && (
        <div className={a.kpiSub} style={color ? { color } : undefined}>
          {sub}
        </div>
      )}
    </div>
  );
}

export type Segment = { label: string; value: number; color: string };

/** Horizontal stacked bar with a legend; segments are relative to `total` (or their sum). */
export function Meter({ segments, total, label }: { segments: Segment[]; total?: number; label: string }) {
  const sum = total ?? segments.reduce((s, x) => s + x.value, 0);
  return (
    <div>
      <div className={d.meter} role="img" aria-label={`${label}: ${segments.map((s) => `${s.label} ${Math.round(sum ? (s.value / sum) * 100 : 0)}%`).join(", ")}`}>
        {segments.map((s) => (
          <i key={s.label} style={{ width: `${sum ? Math.max(0, Math.min(100, (s.value / sum) * 100)) : 0}%`, background: s.color }} />
        ))}
      </div>
      <div className={d.meterLegend}>
        {segments.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function KV({ rows, strong }: { rows: { label: ReactNode; value: ReactNode; hint?: ReactNode }[]; strong?: boolean }) {
  return (
    <ul className={`${d.kv} ${strong ? d.kvStrong : ""}`}>
      {rows.map((r, i) => (
        <li key={i}>
          <span>
            {r.label}
            {r.hint && <span className={d.kvHint}>{r.hint}</span>}
          </span>
          <b>{r.value}</b>
        </li>
      ))}
    </ul>
  );
}

const STATE: Record<InvoiceState, { label: string; cls: string }> = {
  Pending: { label: "Awaiting buyer", cls: a.chipIdle },
  Confirmed: { label: "Confirmed", cls: a.chipGood },
  Financed: { label: "Financed", cls: a.chipGood },
  Repaid: { label: "Repaid", cls: a.chipIdle },
  Overdue: { label: "Overdue", cls: a.chipWarn },
  Defaulted: { label: "Defaulted", cls: a.chipBad },
  Cancelled: { label: "Cancelled", cls: a.chipIdle },
  Rejected: { label: "Rejected", cls: a.chipBad },
};

export function StateChip({ state }: { state: InvoiceState }) {
  const s = STATE[state];
  return (
    <span className={`${a.chip} ${s.cls}`}>
      <i />
      {s.label}
    </span>
  );
}

export function DueLabel({ invoice, nowMs }: { invoice: Invoice; nowMs: number }) {
  if (!invoice.dueDate) return <span className={a.when}>—</span>;
  const date = new Date(invoice.dueDate * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const settled = invoice.state === "Repaid" || invoice.state === "Cancelled" || invoice.state === "Rejected";
  const days = daysUntil(invoice.dueDate, nowMs);
  const cls = settled ? d.dueOk : days < 0 ? d.duePast : days <= 7 ? d.dueSoon : d.dueOk;
  const text = settled ? "settled" : days < 0 ? `${-days} day${days === -1 ? "" : "s"} late` : days === 0 ? "due today" : `in ${days} day${days === 1 ? "" : "s"}`;
  return (
    <span>
      {date}
      <span className={`${d.sub} ${d.due} ${cls}`}>{text}</span>
    </span>
  );
}

export function InvoiceName({ invoice }: { invoice: Invoice }) {
  return (
    <span>
      <b>{invoice.ref ?? `Invoice ${shortAddress(invoice.id)}`}</b>
      {invoice.ref && <span className={`${d.sub} ${a.mono}`}>{shortAddress(invoice.id)}</span>}
    </span>
  );
}

/** Another party shown by its registered label when known, else its short address. */
export function Party({ address, agents }: { address?: string; agents: AgentStats[] }) {
  if (!address) return <span className={a.when}>—</span>;
  const known = agents.find((x) => x.address.toLowerCase() === address);
  const name = known?.label || shortAddress(address);
  return (
    <span className={a.who} style={{ minWidth: 0 }}>
      <Avatar actor={{ name, role: known?.role ?? "mcp", initials: initials(name) }} size={24} />
      <span>{name}</span>
    </span>
  );
}

export function Proof({ url }: { url?: string }) {
  return url ? (
    <a className={a.proof} href={url} target="_blank" rel="noopener noreferrer">
      HashScan ↗
    </a>
  ) : (
    <span className={a.proofNone}>—</span>
  );
}

export const usd = formatUsdc;
export const pct = (n: number, digits = 1) => `${Number.isFinite(n) ? n.toFixed(digits) : "0.0"}%`;

export const Icons = {
  ...Icon,
  wallet: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7a2 2 0 0 1 2-2h12v4" />
      <path d="M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2z" />
      <circle cx="16" cy="14.5" r="1.2" />
    </svg>
  ),
  clock: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  percent: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 5L5 19" />
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="17" r="2.5" />
    </svg>
  ),
  check: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  ),
};
