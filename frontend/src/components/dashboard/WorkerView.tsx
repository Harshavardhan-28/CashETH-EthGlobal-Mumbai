import { useMemo } from "react";
import a from "@/components/admin/Admin.module.css";
import { Empty, ROLE_COLOR } from "@/components/admin/primitives";
import { shortAddress } from "@/lib/admin/format";
import { workerBudgets, type WorkerBudget } from "@/lib/dashboard/derive";
import { AgentDetails, Connections, Panel, RecentCalls, ToolUsage, WalletPanel } from "./console";
import d from "./Dashboard.module.css";
import { Icons, Meter, Stat, usd } from "./parts";
import type { RoleViewProps, SectionDef } from "./types";

export const WORKER_NAV: SectionDef[] = [
  { id: "overview", label: "Overview", icon: Icons.overview, title: "Overview", description: "The budget your seller gave you and how you spent it" },
  { id: "spending", label: "Spending", icon: Icons.card, title: "Spending", description: "Paid APIs bought through x402 from your 2-of-2 spend wallet" },
];

function Spending({ w }: { w?: WorkerBudget }) {
  if (!w || !w.merchants.length) return <Empty title="No payments yet">Payments made with reserve_spend, pay_x402 and commit_spend appear here.</Empty>;
  return (
    <>
      <Meter
        label="Budget"
        total={Math.max(Number(w.budget), Number(w.spent) + Number(w.reserved))}
        segments={[
          { label: `Spent ${usd(w.spent)}`, value: Number(w.spent), color: ROLE_COLOR.worker },
          { label: `Reserved ${usd(w.reserved)}`, value: Number(w.reserved), color: "var(--warn)" },
          { label: `Left ${usd(w.remaining)}`, value: Number(w.remaining), color: "var(--line-2)" },
        ]}
      />
      <ul className={a.merchants} style={{ padding: "12px 0 0" }}>
        {w.merchants.map((m) => (
          <li key={m.merchant}>
            <span className={a.mono}>{shortAddress(m.merchant)}</span>
            <span className={a.mono}>{usd(m.amount)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Worker console: the budget its seller gave it and where the money went over x402. */
export function WorkerPage({ view, ...p }: RoleViewProps & { view: string }) {
  const { me, events, mine, lenders, go } = p;
  const w = useMemo(() => workerBudgets(events, mine).find((r) => r.address === me.address.toLowerCase()), [events, mine, me.address]);
  const kpis = (
    <section className={a.kpis} aria-label="Budget">
      <Stat label="Budget" value={usd(w?.budget ?? "0")} sub="Set by your seller" tone="accent" icon={<Icons.coins />} />
      <Stat label="Spent (x402)" value={usd(w?.spent ?? "0")} sub={`${w?.payments ?? 0} payments`} icon={<Icons.card />} />
      <Stat label="Reserved" value={usd(w?.reserved ?? "0")} sub="Waiting to settle" icon={<Icons.clock />} />
      <Stat label="Remaining" value={usd(w?.remaining ?? "0")} sub={w?.blocked ? `${w.blocked} blocked by guardrails` : "No blocked spends"} tone={w?.blocked ? "warn" : "muted"} icon={<Icons.wallet />} />
    </section>
  );
  if (view === "spending")
    return (
      <>
        {kpis}
        <Panel title="Where the money went" description="By merchant">
          <Spending w={w} />
        </Panel>
      </>
    );
  return (
    <>
      {kpis}
      <div className={d.grid2}>
        <AgentDetails {...p} lenders={lenders} />
        <WalletPanel {...p} />
      </div>
      <div className={d.grid2}>
        <Panel title="Where the money went" description="By merchant" more={{ label: "Spending", onClick: () => go("spending") }}>
          <Spending w={w} />
        </Panel>
        <Connections {...p} />
      </div>
      <div className={d.grid2}>
        <RecentCalls {...p} more={{ label: "Open the activity log", onClick: () => go("activity") }} />
        <ToolUsage {...p} />
      </div>
    </>
  );
}
