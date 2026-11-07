import { useMemo } from "react";
import a from "@/components/admin/Admin.module.css";
import { Avatar, Empty, ROLE_COLOR } from "@/components/admin/primitives";
import { formatOnTime, formatScore, initials, relativeTime, scoreBand, shortAddress } from "@/lib/admin/format";
import { formatRate, slabLabel } from "@/lib/admin/slabs";
import { owedOn, ratio, sellerSummary, workerBudgets, type Invoice, type SellerSummary, type WorkerBudget } from "@/lib/dashboard/derive";
import { AgentDetails, Connections, Panel, RecentCalls, ToolUsage, WalletPanel } from "./console";
import d from "./Dashboard.module.css";
import { DueLabel, Icons, InvoiceName, KV, Meter, Party, Proof, Stat, StateChip, pct, usd } from "./parts";
import type { RoleViewProps, SectionDef } from "./types";

export const SELLER_NAV: SectionDef[] = [
  { id: "overview", label: "Overview", icon: Icons.overview, title: "Overview", description: "Your credit, your agents and your invoices at a glance" },
  { id: "wallet", label: "Wallet & credit", icon: Icons.wallet, title: "Wallet & credit", description: "What you hold, what your invoices raised and what is left to spend" },
  { id: "workers", label: "Worker agents", icon: Icons.agents, title: "Worker agents", description: "Agents spending your credit on paid APIs through x402, within the budgets you set" },
  { id: "invoices", label: "Invoices", icon: Icons.runs, title: "Invoices", description: "Every invoice you financed through the MCP server and where it stands" },
  { id: "payback", label: "Payback", icon: Icons.check, title: "Payback", description: "Buyers repay the loan: lenders are paid principal and fee first, you keep the rest" },
];

function Kpis({ s, mine, workers }: { s: SellerSummary; mine: Invoice[]; workers: WorkerBudget[] }) {
  return (
    <section className={a.kpis} aria-label="Credit">
      <Stat label="Credit raised" value={usd(s.raised)} sub={`${s.open} open facilit${s.open === 1 ? "y" : "ies"} · ${mine.length} invoice${mine.length === 1 ? "" : "s"}`} tone="accent" icon={<Icons.coins />} />
      <Stat label="Credit available" value={usd(s.available)} sub={`${usd(s.reserved)} reserved by workers`} icon={<Icons.wallet />} />
      <Stat label="Spent by your agents" value={usd(s.spent)} sub={`${workers.reduce((n, w) => n + w.payments, 0)} x402 payments`} icon={<Icons.card />} />
      <Stat label="Owed to lenders" value={usd(s.owed)} sub="Principal + fee, repaid first" tone={Number(s.owed) > 0 ? "warn" : "muted"} icon={<Icons.clock />} />
    </section>
  );
}

function WorkerList({ workers, nameOf, nowMs, limit }: { workers: WorkerBudget[]; nameOf(a: string): string; nowMs: number; limit?: number }) {
  if (!workers.length) return <Empty title="No worker budgets yet">Call set_budgets after a facility opens, or buy_with_credit to let a worker spend.</Empty>;
  return (
    <ul className={d.workers}>
      {workers.slice(0, limit).map((w) => {
        const name = nameOf(w.address);
        return (
          <li key={w.address} className={d.worker}>
            <div className={d.workerTop}>
              <Avatar actor={{ name, role: "worker", initials: initials(name) }} size={32} />
              <div>
                <div className={a.whoName}>{name}</div>
                <div className={a.whoJob}>
                  {w.payments} payment{w.payments === 1 ? "" : "s"}
                  {w.blocked ? ` · ${w.blocked} blocked by guardrails` : ""}
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
  );
}

function CreditUsage({ s }: { s: SellerSummary }) {
  return (
    <Meter
      label="Credit usage"
      segments={[
        { label: `Spent ${usd(s.spent)}`, value: Number(s.spent), color: ROLE_COLOR.worker },
        { label: `Reserved ${usd(s.reserved)}`, value: Number(s.reserved), color: "var(--warn)" },
        { label: `Available ${usd(s.available)}`, value: Number(s.available), color: "var(--accent)" },
      ]}
    />
  );
}

function PaybackKV({ s, me }: { s: SellerSummary; me: RoleViewProps["me"] }) {
  return (
    <KV
      rows={[
        { label: "Received from buyers", value: usd(s.receivedFromBuyers) },
        { label: "Paid to lenders", value: usd(s.paidToLenders), hint: "principal + fee" },
        { label: "Kept by you", value: usd(s.keptBySeller), hint: "the remainder after lenders" },
        { label: "On-time repayment", value: formatOnTime(me) },
        { label: "Credit score", value: formatScore(me.score), hint: `${scoreBand(me.score).label} · ${scoreBand(me.score).advance}` },
        { label: "Your credit rate", value: me.slab === "none" ? "Not financeable yet" : `${formatRate(me.aprBps)} APR`, hint: `${slabLabel(me.slab)} · set on chain from your score` },
      ]}
    />
  );
}

function InvoiceTable({ invoices, agents, nowMs, compact }: { invoices: Invoice[]; agents: RoleViewProps["agents"]; nowMs: number; compact?: boolean }) {
  if (!invoices.length) return <Empty title="No invoices yet">Upload one with upload_invoice_document and upload_receivable to raise credit.</Empty>;
  return (
    <div className={a.tableWrap} style={{ paddingTop: 0 }}>
      <table className={a.table}>
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Buyer</th>
            <th className={d.num}>Face value</th>
            <th className={d.num}>Credit raised</th>
            {!compact && <th className={d.num}>Spent</th>}
            <th>Due</th>
            <th>Status</th>
            {!compact && <th className={d.num}>Owed to lenders</th>}
            {!compact && <th>Proof</th>}
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
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
              {!compact && <td className={`${d.num} ${a.mono}`}>{usd(i.spent)}</td>}
              <td>
                <DueLabel invoice={i} nowMs={nowMs} />
              </td>
              <td>
                <StateChip state={i.state} />
              </td>
              {!compact && <td className={`${d.num} ${a.mono}`}>{usd(owedOn(i))}</td>}
              {!compact && (
                <td>
                  <Proof url={i.proofUrl} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Seller console: credit raised, what its worker agents do with it, its invoices and how the loans get paid back. */
export function SellerPage({ view, ...p }: RoleViewProps & { view: string }) {
  const { me, agents, lenders, events, mine, nowMs, go } = p;
  const s = useMemo(() => sellerSummary(mine), [mine]);
  const workers = useMemo(() => workerBudgets(events, mine), [events, mine]);
  const nameOf = (addr: string) => agents.find((x) => x.address.toLowerCase() === addr)?.label || shortAddress(addr);
  const repaid = mine.filter((i) => Number(i.repaid) > 0);

  switch (view) {
    case "wallet":
      return (
        <>
          <Kpis s={s} mine={mine} workers={workers} />
          <div className={d.grid2}>
            <WalletPanel {...p} />
            <Panel title="Credit usage" description="Across your open facilities">
              <CreditUsage s={s} />
            </Panel>
          </div>
        </>
      );
    case "workers":
      return (
        <Panel title="Worker agents" description={`${workers.length} agent${workers.length === 1 ? "" : "s"} spending your credit · bars show spent, reserved and what is left`} flush>
          <WorkerList workers={workers} nameOf={nameOf} nowMs={nowMs} />
        </Panel>
      );
    case "invoices":
      return (
        <Panel title="Invoices" description={`${mine.length} uploaded through the MCP server`} flush>
          <InvoiceTable invoices={mine} agents={agents} nowMs={nowMs} />
        </Panel>
      );
    case "payback":
      return (
        <div className={d.grid2}>
          <Panel title="Payback summary" description="Lenders are always paid first">
            <PaybackKV s={s} me={me} />
          </Panel>
          <Panel title="Repaid invoices" description={`${repaid.length} settled`} flush>
            {repaid.length ? (
              <div className={a.tableWrap} style={{ paddingTop: 0 }}>
                <table className={a.table}>
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th className={d.num}>Buyer paid</th>
                      <th className={d.num}>To lenders</th>
                      <th className={d.num}>To you</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repaid.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <InvoiceName invoice={i} />
                        </td>
                        <td className={`${d.num} ${a.mono}`}>{usd(i.repaid)}</td>
                        <td className={`${d.num} ${a.mono}`}>{usd(i.toLenders)}</td>
                        <td className={`${d.num} ${a.mono}`}>{usd(i.toSeller)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Nothing repaid yet">When a buyer pays, the split shows here.</Empty>
            )}
          </Panel>
        </div>
      );
    default:
      return (
        <>
          <Kpis s={s} mine={mine} workers={workers} />
          <div className={d.grid2}>
            <AgentDetails {...p} lenders={lenders} />
            <WalletPanel {...p} more={{ label: "Wallet & credit", onClick: () => go("wallet") }} />
          </div>
          <div className={d.grid2}>
            <Panel title="Worker agents" description="Budget used by each agent" flush more={{ label: `All ${workers.length} worker agents`, onClick: () => go("workers") }}>
              <WorkerList workers={workers} nameOf={nameOf} nowMs={nowMs} limit={2} />
            </Panel>
            <div className={d.stack}>
              <Panel title="Credit usage" description="Across your open facilities" more={{ label: "Payback", onClick: () => go("payback") }}>
                <CreditUsage s={s} />
              </Panel>
              <Connections {...p} />
            </div>
          </div>
          <Panel title="Recent invoices" description="Latest three" flush className={d.section} more={{ label: `All ${mine.length} invoices`, onClick: () => go("invoices") }}>
            <InvoiceTable invoices={mine.slice(0, 3)} agents={agents} nowMs={nowMs} compact />
          </Panel>
          <div className={d.grid2}>
            <RecentCalls {...p} more={{ label: "Open the activity log", onClick: () => go("activity") }} />
            <ToolUsage {...p} />
          </div>
        </>
      );
  }
}
