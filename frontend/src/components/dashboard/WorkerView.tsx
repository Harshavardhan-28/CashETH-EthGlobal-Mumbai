import { useMemo } from "react";
import a from "@/components/admin/Admin.module.css";
import { Empty, ROLE_COLOR } from "@/components/admin/primitives";
import { shortAddress } from "@/lib/admin/format";
import { workerBudgets } from "@/lib/dashboard/derive";
import d from "./Dashboard.module.css";
import { Card, Icons, Meter, Stat, usd } from "./parts";
import type { RoleViewProps } from "./types";

/** Worker: the budget its seller gave it and where the money went over x402. */
export function WorkerView({ me, events, mine }: RoleViewProps) {
  const w = useMemo(() => workerBudgets(events, mine).find((r) => r.address === me.address.toLowerCase()), [events, mine, me.address]);
  return (
    <>
      <section className={a.kpis} aria-label="Budget">
        <Stat label="Budget" value={usd(w?.budget ?? "0")} sub="Set by your seller" tone="accent" icon={<Icons.coins />} />
        <Stat label="Spent (x402)" value={usd(w?.spent ?? "0")} sub={`${w?.payments ?? 0} payments`} icon={<Icons.card />} />
        <Stat label="Reserved" value={usd(w?.reserved ?? "0")} sub="Waiting to settle" icon={<Icons.clock />} />
        <Stat label="Remaining" value={usd(w?.remaining ?? "0")} sub={w?.blocked ? `${w.blocked} blocked by guardrails` : "No blocked spends"} tone={w?.blocked ? "warn" : "muted"} icon={<Icons.wallet />} />
      </section>
      <Card title="Where the money went" sub="paid through x402 from a 2-of-2 spend wallet" className={d.section}>
        {w && w.merchants.length ? (
          <div className={d.body}>
            <Meter
              label="Budget"
              total={Math.max(Number(w.budget), Number(w.spent) + Number(w.reserved))}
              segments={[
                { label: "Spent", value: Number(w.spent), color: ROLE_COLOR.worker },
                { label: "Reserved", value: Number(w.reserved), color: "var(--warn)" },
                { label: "Left", value: Number(w.remaining), color: "var(--line-2)" },
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
          </div>
        ) : (
          <Empty title="No payments yet">Payments made with reserve_spend, pay_x402 and commit_spend appear here.</Empty>
        )}
      </Card>
    </>
  );
}
