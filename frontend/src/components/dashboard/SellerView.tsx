import { useMemo } from "react";
import a from "@/components/admin/Admin.module.css";
import { Avatar, Empty, ROLE_COLOR } from "@/components/admin/primitives";
import { initials, relativeTime, shortAddress } from "@/lib/admin/format";
import { owedOn, ratio, sellerSummary, workerBudgets } from "@/lib/dashboard/derive";
import d from "./Dashboard.module.css";
import { Card, DueLabel, Icons, InvoiceName, KV, Meter, Party, Proof, Stat, StateChip, pct, usd } from "./parts";
import type { RoleViewProps } from "./types";

/** Seller: how much credit its invoices raised, what its worker agents do with it, and how the loans get paid back. */
export function SellerView({ me, agents, events, mine, nowMs }: RoleViewProps) {
  const s = useMemo(() => sellerSummary(mine), [mine]);
  const workers = useMemo(() => workerBudgets(events, mine), [events, mine]);
  const nameOf = (addr: string) => agents.find((x) => x.address.toLowerCase() === addr)?.label || shortAddress(addr);
  const used = Number(s.spent) + Number(s.reserved);

  return (
    <>
      <section className={a.kpis} aria-label="Credit">
        <Stat label="Credit raised" value={usd(s.raised)} sub={`${s.open} open facilit${s.open === 1 ? "y" : "ies"} · ${mine.length} invoice${mine.length === 1 ? "" : "s"}`} tone="accent" icon={<Icons.coins />} />
        <Stat label="Credit available" value={usd(s.available)} sub={`${usd(s.reserved)} reserved by workers`} icon={<Icons.wallet />} />
        <Stat label="Spent by your agents" value={usd(s.spent)} sub={`${workers.reduce((n, w) => n + w.payments, 0)} x402 payments`} icon={<Icons.card />} />
        <Stat label="Owed to lenders" value={usd(s.owed)} sub="Principal + fee, repaid first" tone={Number(s.owed) > 0 ? "warn" : "muted"} icon={<Icons.clock />} />
      </section>

      <div className={d.split}>
        <Card title="Your worker agents" sub={`${workers.length} spending your credit through x402`}>
          {workers.length ? (
            <ul className={d.workers}>
              {workers.map((w) => {
                const name = nameOf(w.address);
                const blocked = w.blocked ? ` · ${w.blocked} blocked by guardrails` : "";
                return (
                  <li key={w.address} className={d.worker}>
                    <div className={d.workerTop}>
                      <Avatar actor={{ name, role: "worker", initials: initials(name) }} size={32} />
                      <div>
                        <div className={a.whoName}>{name}</div>
                        <div className={a.whoJob}>
                          {w.payments} payment{w.payments === 1 ? "" : "s"}
                          {blocked}
                          {w.lastAt ? ` · last ${relativeTime(w.lastAt, nowMs)}` : ""}
                        </div>
                      </div>
                      <div className={d.workerNums}>
                        <b>{usd(w.spent)}</b>
                        <span>of {usd(w.budget)} budget</span>
                      </div>
                    </div>
                    <Meter
                      label={`${name} budget`}
                      total={Math.max(Number(w.budget), Number(w.spent) + Number(w.reserved))}
                      segments={[
                        { label: `Spent ${usd(w.spent)}`, value: Number(w.spent), color: ROLE_COLOR.worker },
                        { label: `Reserved ${usd(w.reserved)}`, value: Number(w.reserved), color: "var(--warn)" },
                        { label: `Left ${usd(w.remaining)}`, value: Number(w.remaining), color: "var(--line-2)" },
                      ]}
                    />
                    {w.merchants.length > 0 && (
                      <div className={a.whoJob} style={{ marginTop: 8 }}>
                        Paid {w.merchants.map((m) => `${shortAddress(m.merchant)} ${usd(m.amount)}`).join(" · ")}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty title="No worker budgets yet">Call set_budgets after a facility opens, or buy_with_credit to let a worker spend.</Empty>
          )}
        </Card>

        <div className={a.stack}>
          <Card title="Credit usage" sub="across your financed invoices">
            <div className={d.body}>
              <Meter
                label="Credit usage"
                total={Math.max(Number(s.raised), used)}
                segments={[
                  { label: "Spent", value: Number(s.spent), color: ROLE_COLOR.worker },
                  { label: "Reserved", value: Number(s.reserved), color: "var(--warn)" },
                  { label: "Available", value: Number(s.available), color: "var(--accent)" },
                ]}
              />
            </div>
          </Card>
          <Card title="Payback" sub="buyers repay; lenders are paid first">
            <div className={d.body}>
              <KV
                rows={[
                  { label: "Received from buyers", value: usd(s.receivedFromBuyers) },
                  { label: "Paid to lenders", value: usd(s.paidToLenders), hint: "principal + fee" },
                  { label: "Kept by you", value: usd(s.keptBySeller), hint: "the remainder after lenders" },
                  { label: "On-time repayment", value: pct(me.onTimePct, 0) },
                  { label: "Trust score · tier", value: `${Math.round(me.score)} / 100 · ${me.tier}` },
                ]}
              />
            </div>
          </Card>
        </div>
      </div>

      <Card title="Your invoices" sub={`${mine.length} uploaded through the MCP server`} className={d.section}>
        {mine.length ? (
          <div className={a.tableWrap}>
            <table className={a.table}>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Buyer</th>
                  <th className={d.num}>Face value</th>
                  <th className={d.num}>Credit raised</th>
                  <th className={d.num}>Spent</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className={d.num}>Owed to lenders</th>
                  <th>Proof</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <InvoiceName invoice={i} />
                    </td>
                    <td>
                      <Party address={i.buyer} agents={agents} />
                    </td>
                    <td className={`${d.num} ${a.mono}`}>{usd(i.amount)}</td>
                    <td className={`${d.num} ${a.mono}`}>
                      {usd(i.funded)}
                      {i.amount && Number(i.funded) > 0 && <span className={d.sub}>{pct(ratio(i.funded, i.amount) * 100, 0)} advance</span>}
                    </td>
                    <td className={`${d.num} ${a.mono}`}>{usd(i.spent)}</td>
                    <td>
                      <DueLabel invoice={i} nowMs={nowMs} />
                    </td>
                    <td>
                      <StateChip state={i.state} />
                    </td>
                    <td className={`${d.num} ${a.mono}`}>{usd(owedOn(i))}</td>
                    <td>
                      <Proof url={i.proofUrl} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No invoices yet">Upload one with upload_invoice_document and upload_receivable to raise credit.</Empty>
        )}
      </Card>
    </>
  );
}
