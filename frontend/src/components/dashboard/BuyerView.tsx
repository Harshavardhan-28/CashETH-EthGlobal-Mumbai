import { useMemo } from "react";
import a from "@/components/admin/Admin.module.css";
import { Empty } from "@/components/admin/primitives";
import type { AuditEvent } from "@/lib/admin/api";
import { formatOnTime, formatScore, relativeTime, scoreBand } from "@/lib/admin/format";
import { addU, buyerSummary, daysUntil, lc, outstanding, subU, type BuyerSummary, type Invoice } from "@/lib/dashboard/derive";
import type { Wallet } from "@/lib/dashboard/live";
import { AgentDetails, Connections, Panel, RecentCalls, ToolUsage, WalletPanel } from "./console";
import d from "./Dashboard.module.css";
import { DueLabel, EvidenceLinks, Icons, InvoiceName, KV, Meter, Party, Proof, Stat, StateChip, usd } from "./parts";
import type { RoleViewProps, SectionDef } from "./types";

export const BUYER_NAV: SectionDef[] = [
  { id: "overview", label: "Overview", icon: Icons.overview, title: "Overview", description: "What you owe, when it is due and how you have paid" },
  { id: "wallet", label: "Wallet", icon: Icons.wallet, title: "Wallet", description: "Your USDC balance against what is due" },
  { id: "invoices", label: "Invoices due", icon: Icons.runs, title: "Invoices due", description: "Confirmed invoices waiting for payment, soonest first. Pay one with repay_receivable" },
  { id: "payments", label: "Payments", icon: Icons.check, title: "Payments", description: "Repayments you made: lenders are paid first, the seller gets the rest" },
];

function Kpis({ s, wallet, payments, nowMs }: { s: BuyerSummary; wallet: Wallet; payments: number; nowMs: number }) {
  const next = s.nextDue;
  const days = next?.dueDate ? daysUntil(next.dueDate, nowMs) : undefined;
  const short = wallet.usdc !== undefined ? subU(s.due, wallet.usdc) : undefined;
  return (
    <section className={a.kpis} aria-label="Payables">
      <Stat label="Total due" value={usd(s.due)} sub={`${s.dueCount} invoice${s.dueCount === 1 ? "" : "s"} to pay${s.overdue ? ` · ${s.overdue} late` : ""}`} tone={s.overdue ? "err" : "accent"} icon={<Icons.coins />} />
      <Stat
        label="Next payment"
        value={next ? usd(outstanding(next)) : "—"}
        sub={next && days !== undefined ? (days < 0 ? `${-days} days late · ${next.ref ?? "invoice"}` : `Due in ${days} day${days === 1 ? "" : "s"} · ${next.ref ?? "invoice"}`) : "Nothing scheduled"}
        tone={days !== undefined && days < 0 ? "err" : days !== undefined && days <= 7 ? "warn" : "muted"}
        icon={<Icons.clock />}
      />
      <Stat label="Paid so far" value={usd(s.paid)} sub={`${payments} repayment${payments === 1 ? "" : "s"} on-chain`} icon={<Icons.check />} />
      <Stat
        label="Wallet covers dues"
        value={short === undefined ? "—" : Number(short) > 0 ? "No" : "Yes"}
        sub={short === undefined ? "Wallet balance unavailable" : Number(short) > 0 ? `Short by ${usd(short)}` : `${usd(subU(wallet.usdc, s.due))} to spare`}
        tone={short === undefined ? "muted" : Number(short) > 0 ? "err" : "accent"}
        icon={<Icons.wallet />}
      />
    </section>
  );
}

function DueTable({ due, agents, nowMs, compact }: { due: Invoice[]; agents: RoleViewProps["agents"]; nowMs: number; compact?: boolean }) {
  if (!due.length) return <Empty title="Nothing to pay">You have no confirmed invoices waiting for payment.</Empty>;
  return (
    <div className={a.tableWrap} style={{ paddingTop: 0 }}>
      <table className={a.table}>
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Seller</th>
            <th className={d.num}>Amount due</th>
            <th>Due</th>
            <th>Status</th>
            {!compact && <th>Proof</th>}
          </tr>
        </thead>
        <tbody>
          {due.map((i) => (
            <tr key={i.id}>
              <td>
                <InvoiceName invoice={i} />
              </td>
              <td>
                <Party address={i.seller} agents={agents} />
              </td>
              <td className={`${d.num} ${a.mono}`}>
                {usd(outstanding(i))}
                {Number(i.repaid) > 0 && <span className={d.sub}>of {usd(i.amount)}</span>}
              </td>
              <td>
                <DueLabel invoice={i} nowMs={nowMs} />
              </td>
              <td>
                <StateChip state={i.state} />
              </td>
              {!compact && (
                <td>
                  <EvidenceLinks links={i.evidence} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentTable({ payments, byId, nowMs }: { payments: AuditEvent[]; byId: Map<string, Invoice>; nowMs: number }) {
  if (!payments.length) return <Empty title="No payments yet">Repayments you make through repay_receivable appear here with their HashScan proof.</Empty>;
  return (
    <div className={a.tableWrap} style={{ paddingTop: 0 }}>
      <table className={a.table}>
        <thead>
          <tr>
            <th>When</th>
            <th>Invoice</th>
            <th className={d.num}>You paid</th>
            <th className={d.num}>To lenders</th>
            <th className={d.num}>To seller</th>
            <th>Status</th>
            <th>Proof</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => {
            const inv = byId.get(lc(p.id) ?? "");
            return (
              <tr key={p.seq}>
                <td className={a.when} title={new Date(p.ts).toLocaleString()}>
                  {relativeTime(p.ts, nowMs)}
                </td>
                <td>{inv ? <InvoiceName invoice={inv} /> : "—"}</td>
                <td className={`${d.num} ${a.mono}`}>{usd(p.amount)}</td>
                <td className={`${d.num} ${a.mono}`}>{usd(typeof p.toLenders === "string" ? p.toLenders : undefined)}</td>
                <td className={`${d.num} ${a.mono}`}>{usd(typeof p.toSeller === "string" ? p.toSeller : undefined)}</td>
                <td>{inv && <StateChip state={inv.state} />}</td>
                <td>
                  {inv ? <EvidenceLinks links={inv.evidence} /> : <Proof url={p.hashscan} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Record({ me }: { me: RoleViewProps["me"] }) {
  return (
    <KV
      rows={[
        { label: "On-time payments", value: formatOnTime(me) },
        { label: "Invoices paid", value: String(me.receivablesRepaid) },
        { label: "Defaults", value: String(me.receivablesDefaulted) },
        { label: "Average days to pay", value: me.avgDaysToRepay ? `${me.avgDaysToRepay} d` : "—" },
        { label: "Credit score", value: formatScore(me.score), hint: scoreBand(me.score).label },
        { label: "KYA level", value: `Level ${me.level}` },
      ]}
    />
  );
}

/** Buyer console: what it owes and when, whether its wallet covers it, and the payments it has made. */
export function BuyerPage({ view, ...p }: RoleViewProps & { view: string }) {
  const { me, agents, lenders, events, mine, wallet, nowMs, go } = p;
  const s = useMemo(() => buyerSummary(mine), [mine]);
  const due = useMemo(() => mine.filter((i) => Number(outstanding(i)) > 0 && i.state !== "Pending").sort((x, y) => (x.dueDate ?? Infinity) - (y.dueDate ?? Infinity)), [mine]);
  const awaiting = mine.filter((i) => i.state === "Pending");
  const payments = useMemo(() => {
    const ids = new Set(mine.map((i) => i.id.toLowerCase()));
    return events.filter((e) => e.type === "Repaid" && ids.has(lc(e.id) ?? "")).sort((x, y) => y.seq - x.seq);
  }, [events, mine]);
  const byId = new Map(mine.map((i) => [i.id.toLowerCase(), i]));
  const kpis = <Kpis s={s} wallet={wallet} payments={payments.length} nowMs={nowMs} />;
  const walletVsDues = (
    <Panel title="Wallet vs dues" description="Can you pay everything due today?">
      <Meter
        label="Wallet against dues"
        segments={[
          { label: `Due ${usd(s.due)}`, value: Number(s.due), color: "var(--warn)" },
          { label: `Wallet ${usd(wallet.usdc)}`, value: Number(wallet.usdc ?? 0), color: "var(--accent)" },
        ]}
      />
    </Panel>
  );

  switch (view) {
    case "wallet":
      return (
        <>
          {kpis}
          <div className={d.grid2}>
            <WalletPanel {...p} />
            {walletVsDues}
          </div>
        </>
      );
    case "invoices":
      return (
        <>
          <Panel title="Invoices due" description={`${due.length} to pay, soonest first`} flush className={d.section}>
            <DueTable due={due} agents={agents} nowMs={nowMs} />
          </Panel>
          {awaiting.length > 0 && (
            <Panel title="Waiting for your confirmation" description={`${awaiting.length} invoice${awaiting.length === 1 ? "" : "s"} · ${usd(addU(...awaiting.map((i) => i.amount)))} · sign with confirm_receivable`} flush>
              <DueTable due={awaiting} agents={agents} nowMs={nowMs} />
            </Panel>
          )}
        </>
      );
    case "payments":
      return (
        <div className={d.split}>
          <Panel title="Payment history" description={`${payments.length} repayment${payments.length === 1 ? "" : "s"}`} flush>
            <PaymentTable payments={payments} byId={byId} nowMs={nowMs} />
          </Panel>
          <Panel title="Payment record" description="What lenders see before funding">
            <Record me={me} />
          </Panel>
        </div>
      );
    default:
      return (
        <>
          {kpis}
          <div className={d.grid2}>
            <AgentDetails {...p} lenders={lenders} />
            <WalletPanel {...p} more={{ label: "Wallet vs dues", onClick: () => go("wallet") }} />
          </div>
          <div className={d.split}>
            <Panel title="Invoices due" description="Soonest first" flush more={{ label: "All invoices due", onClick: () => go("invoices") }}>
              <DueTable due={due.slice(0, 4)} agents={agents} nowMs={nowMs} compact />
              {awaiting.length > 0 && (
                <div className={d.notice}>
                  {awaiting.length} invoice{awaiting.length === 1 ? "" : "s"} waiting for your confirmation ({usd(addU(...awaiting.map((i) => i.amount)))})
                </div>
              )}
            </Panel>
            <div className={d.stack}>
              <Panel title="Payment record" description="What lenders see before funding" more={{ label: "Payment history", onClick: () => go("payments") }}>
                <Record me={me} />
              </Panel>
              <Connections {...p} />
            </div>
          </div>
          <div className={d.grid2}>
            <RecentCalls {...p} more={{ label: "Open the activity log", onClick: () => go("activity") }} />
            <ToolUsage {...p} />
          </div>
        </>
      );
  }
}
