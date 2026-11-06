import { useMemo } from "react";
import a from "@/components/admin/Admin.module.css";
import { Empty, ROLE_COLOR } from "@/components/admin/primitives";
import { shortAddress } from "@/lib/admin/format";
import { addU, lenderOf, lenderPositions } from "@/lib/dashboard/derive";
import d from "./Dashboard.module.css";
import { Card, DueLabel, Icons, InvoiceName, KV, Meter, Party, Proof, Stat, StateChip, pct, usd } from "./parts";
import type { RoleViewProps } from "./types";

const TIER: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk", custom: "Custom", none: "No credit offer" };

/** Lender: capital, how much is lent to sellers, the return it earns, its liquidity across strategies and its positions. */
export function LenderView({ me, agents, lenders, mine, wallet, nowMs }: RoleViewProps) {
  const y = lenderOf(lenders, me.address);
  const positions = useMemo(() => lenderPositions(mine, me.address), [mine, me.address]);
  const open = positions.filter((p) => p.invoice.state === "Financed" || p.invoice.state === "Overdue");
  const atRisk = positions.filter((p) => p.invoice.state === "Overdue" || p.invoice.state === "Defaulted");
  const idle = y?.idle ?? wallet.usdc;
  const earned = y ? addU(y.creditFees, y.baseFees) : undefined;
  const creditOn = !!y && (!!y.strategies.credit || y.tier !== "none");
  const baseOn = !!y && (!!y.strategies.base || y.baseApr > 0);

  return (
    <>
      <section className={a.kpis} aria-label="Capital">
        <Stat label="Total capital" value={usd(y?.capital ?? idle)} sub="Idle in your wallet + lent" icon={<Icons.coins />} />
        <Stat label="Lent to sellers" value={usd(y?.lent ?? "0")} sub={`${open.length} open position${open.length === 1 ? "" : "s"}${atRisk.length ? ` · ${atRisk.length} late` : ""}`} tone={atRisk.length ? "warn" : "accent"} icon={<Icons.card />} />
        <Stat label="Blended return" value={pct(y?.blendedApr ?? 0)} sub={`Base ${pct(y?.baseApr ?? 0)} · credit ${pct(y?.boostApr ?? 0)} APR`} tone="accent" icon={<Icons.percent />} />
        <Stat label="Earned so far" value={usd(earned ?? "0")} sub={`${pct(me.lenderReturnPct)} on capital`} icon={<Icons.check />} />
      </section>

      <div className={d.split}>
        <Card title="Liquidity" sub="non-custodial: your USDC stays in your wallet until a strategy fills">
          <div className={d.body}>
            <Meter
              label="Capital allocation"
              segments={[
                { label: `Lent ${usd(y?.lent ?? "0")}`, value: Number(y?.lent ?? 0), color: ROLE_COLOR.lender },
                { label: `Idle ${usd(idle)}`, value: Number(idle ?? 0), color: "var(--accent)" },
              ]}
            />
            <div className={d.strategies}>
              <div className={d.strategy}>
                <h3>Credit strategy</h3>
                <p>
                  {TIER[y?.tier ?? "none"]} · 1inch Aqua{y?.strategies.credit ? ` · ${shortAddress(y.strategies.credit)}` : ""}
                </p>
                <div className={d.strategyApr}>{creditOn ? `${pct(y!.boostApr)} APR` : "Not offered"}</div>
                <p>Lends against buyer-confirmed invoices; the risk tier is enforced at fill time.</p>
              </div>
              <div className={d.strategy}>
                <h3>Base-yield strategy</h3>
                <p>USDC / tUSDT · 30 bps swaps{y?.strategies.base ? ` · ${shortAddress(y.strategies.base)}` : ""}</p>
                <div className={d.strategyApr}>{baseOn ? `${pct(y!.baseApr)} APR` : "Not offered"}</div>
                <p>Idle capital earns swap fees while it waits for credit demand.</p>
              </div>
            </div>
          </div>
        </Card>

        <Card title="Returns" sub="paid on-chain by the repayment router">
          <div className={d.body}>
            <KV
              strong
              rows={[
                { label: "Credit fees", value: usd(y?.creditFees ?? "0"), hint: "interest from sellers, repaid first" },
                { label: "Swap fees", value: usd(y?.baseFees ?? "0"), hint: "from the base-yield strategy" },
                { label: "Total earned", value: usd(earned ?? "0") },
                { label: "Return on capital", value: pct(me.lenderReturnPct) },
                { label: "Defaults on your positions", value: String(positions.filter((p) => p.invoice.state === "Defaulted").length) },
              ]}
            />
          </div>
        </Card>
      </div>

      <Card title="Positions" sub={`${positions.length} invoice${positions.length === 1 ? "" : "s"} you funded`} className={d.section}>
        {positions.length ? (
          <div className={a.tableWrap}>
            <table className={a.table}>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Seller</th>
                  <th className={d.num}>Your principal</th>
                  <th className={d.num}>APR</th>
                  <th className={d.num}>Fee</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th>Proof</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.invoice.id}>
                    <td>
                      <InvoiceName invoice={p.invoice} />
                    </td>
                    <td>
                      <Party address={p.invoice.seller} agents={agents} />
                    </td>
                    <td className={`${d.num} ${a.mono}`}>{usd(p.principal)}</td>
                    <td className={`${d.num} ${a.mono}`}>{p.aprBps !== undefined ? pct(p.aprBps / 100) : "—"}</td>
                    <td className={`${d.num} ${a.mono}`}>{usd(p.fee)}</td>
                    <td>
                      <DueLabel invoice={p.invoice} nowMs={nowMs} />
                    </td>
                    <td>
                      <StateChip state={p.invoice.state} />
                    </td>
                    <td>
                      <Proof url={p.invoice.proofUrl} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No positions yet">When a seller&apos;s invoice fills your credit strategy, the position shows here.</Empty>
        )}
      </Card>
    </>
  );
}
