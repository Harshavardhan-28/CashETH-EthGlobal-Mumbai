import { useMemo } from "react";
import a from "@/components/admin/Admin.module.css";
import { Empty } from "@/components/admin/primitives";
import { relativeTime } from "@/lib/admin/format";
import { addU, buyerSummary, daysUntil, lc, outstanding, subU } from "@/lib/dashboard/derive";
import d from "./Dashboard.module.css";
import { Card, DueLabel, Icons, InvoiceName, KV, Meter, Party, Proof, Stat, StateChip, pct, usd } from "./parts";
import type { RoleViewProps } from "./types";

/** Buyer: what it owes and when, whether its wallet covers it, and the payments it has made. */
export function BuyerView({ me, agents, events, mine, wallet, nowMs }: RoleViewProps) {
  const s = useMemo(() => buyerSummary(mine), [mine]);
  const due = useMemo(
    () => mine.filter((i) => Number(outstanding(i)) > 0 && i.state !== "Pending").sort((x, y) => (x.dueDate ?? Infinity) - (y.dueDate ?? Infinity)),
    [mine],
  );
  const awaiting = mine.filter((i) => i.state === "Pending");
  const ids = useMemo(() => new Set(mine.map((i) => i.id.toLowerCase())), [mine]);
  const payments = useMemo(() => events.filter((e) => e.type === "Repaid" && ids.has(lc(e.id) ?? "")).sort((x, y) => y.seq - x.seq), [events, ids]);
  const byId = new Map(mine.map((i) => [i.id.toLowerCase(), i]));

  const next = s.nextDue;
  const nextDays = next?.dueDate ? daysUntil(next.dueDate, nowMs) : undefined;
  const short = wallet.usdc !== undefined ? subU(s.due, wallet.usdc) : undefined;

  return (
    <>
      <section className={a.kpis} aria-label="Payables">
        <Stat label="Total due" value={usd(s.due)} sub={`${s.dueCount} invoice${s.dueCount === 1 ? "" : "s"} to pay${s.overdue ? ` · ${s.overdue} late` : ""}`} tone={s.overdue ? "err" : "accent"} icon={<Icons.coins />} />
        <Stat
          label="Next payment"
          value={next ? usd(outstanding(next)) : "—"}
          sub={next && nextDays !== undefined ? (nextDays < 0 ? `${-nextDays} days late · ${next.ref ?? "invoice"}` : `Due in ${nextDays} day${nextDays === 1 ? "" : "s"} · ${next.ref ?? "invoice"}`) : "Nothing scheduled"}
          tone={nextDays !== undefined && nextDays < 0 ? "err" : nextDays !== undefined && nextDays <= 7 ? "warn" : "muted"}
          icon={<Icons.clock />}
        />
        <Stat label="Paid so far" value={usd(s.paid)} sub={`${payments.length} repayment${payments.length === 1 ? "" : "s"} on-chain`} icon={<Icons.check />} />
        <Stat
          label="Wallet covers dues"
          value={short === undefined ? "—" : Number(short) > 0 ? "No" : "Yes"}
          sub={short === undefined ? "Wallet balance unavailable" : Number(short) > 0 ? `Short by ${usd(short)}` : `${usd(subU(wallet.usdc, s.due))} to spare`}
          tone={short === undefined ? "muted" : Number(short) > 0 ? "err" : "accent"}
          icon={<Icons.wallet />}
        />
      </section>

      <div className={d.split}>
        <Card title="Invoices due" sub="soonest first · pay with repay_receivable">
          {due.length ? (
            <div className={a.tableWrap}>
              <table className={a.table}>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Seller</th>
                    <th className={d.num}>Amount due</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th>Proof</th>
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
                      <td>
                        <Proof url={i.proofUrl} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="Nothing to pay">You have no confirmed invoices waiting for payment.</Empty>
          )}
          {awaiting.length > 0 && (
            <div className={d.body} style={{ borderTop: "1px solid var(--line)" }}>
              <span className={a.whoJob}>
                {awaiting.length} invoice{awaiting.length === 1 ? "" : "s"} waiting for your confirmation ({usd(addU(...awaiting.map((i) => i.amount)))}) — sign with confirm_receivable.
              </span>
            </div>
          )}
        </Card>

        <div className={a.stack}>
          <Card title="Payment record" sub="what lenders see before funding">
            <div className={d.body}>
              <KV
                rows={[
                  { label: "On-time payments", value: pct(me.onTimePct, 0) },
                  { label: "Invoices paid", value: String(me.receivablesRepaid) },
                  { label: "Defaults", value: String(me.receivablesDefaulted) },
                  { label: "Average days to pay", value: me.avgDaysToRepay ? `${me.avgDaysToRepay} d` : "—" },
                  { label: "Trust score · KYA level", value: `${Math.round(me.score)} / 100 · L${me.level}` },
                ]}
              />
            </div>
          </Card>
          <Card title="Wallet vs dues" sub="USDC">
            <div className={d.body}>
              <Meter
                label="Wallet against dues"
                segments={[
                  { label: `Due ${usd(s.due)}`, value: Number(s.due), color: "var(--warn)" },
                  { label: `Wallet ${usd(wallet.usdc)}`, value: Number(wallet.usdc ?? 0), color: "var(--accent)" },
                ]}
              />
            </div>
          </Card>
        </div>
      </div>

      <Card title="Payment history" sub="lenders are paid first, the seller gets the rest" className={d.section}>
        {payments.length ? (
          <div className={a.tableWrap}>
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
                        <Proof url={p.hashscan} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No payments yet">Repayments you make through repay_receivable appear here with their HashScan proof.</Empty>
        )}
      </Card>
    </>
  );
}
