import { useMemo } from "react";
import a from "@/components/admin/Admin.module.css";
import { Empty, ROLE_COLOR } from "@/components/admin/primitives";
import type { LenderYield } from "@/lib/admin/api";
import { shortAddress } from "@/lib/admin/format";
import { addU, lenderOf, lenderPositions, type Position } from "@/lib/dashboard/derive";
import { AgentDetails, Connections, Panel, RecentCalls, ToolUsage, WalletPanel } from "./console";
import d from "./Dashboard.module.css";
import { DueLabel, Icons, InvoiceName, KV, Meter, Party, Proof, Stat, StateChip, pct, usd } from "./parts";
import type { RoleViewProps, SectionDef } from "./types";

export const LENDER_NAV: SectionDef[] = [
  { id: "overview", label: "Overview", icon: Icons.overview, title: "Overview", description: "Your capital, what it earns and who it is lent to" },
  { id: "liquidity", label: "Liquidity", icon: Icons.coins, title: "Liquidity", description: "Non-custodial: your USDC stays in your wallet until one of your 1inch Aqua strategies fills" },
  { id: "positions", label: "Positions", icon: Icons.runs, title: "Positions", description: "Invoices your credit strategy funded, and where each loan stands" },
  { id: "returns", label: "Returns", icon: Icons.percent, title: "Returns", description: "Fees earned from sellers' credit and from base-yield swaps" },
];

const TIER: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk", custom: "Custom", none: "No credit offer" };

function Kpis({ y, idle, earned, open, late, me }: { y?: LenderYield; idle?: string; earned: string; open: number; late: number; me: RoleViewProps["me"] }) {
  return (
    <section className={a.kpis} aria-label="Capital">
      <Stat label="Total capital" value={usd(y?.capital ?? idle)} sub="Idle in your wallet + lent" icon={<Icons.coins />} />
      <Stat label="Lent to sellers" value={usd(y?.lent ?? "0")} sub={`${open} open position${open === 1 ? "" : "s"}${late ? ` · ${late} late` : ""}`} tone={late ? "warn" : "accent"} icon={<Icons.card />} />
      <Stat label="Blended return" value={pct(y?.blendedApr ?? 0)} sub={`Base ${pct(y?.baseApr ?? 0)} · credit ${pct(y?.boostApr ?? 0)} APR`} tone="accent" icon={<Icons.percent />} />
      <Stat label="Earned so far" value={usd(earned)} sub={`${pct(me.lenderReturnPct)} on capital`} icon={<Icons.check />} />
    </section>
  );
}

function Allocation({ y, idle }: { y?: LenderYield; idle?: string }) {
  return (
    <Meter
      label="Capital allocation"
      segments={[
        { label: `Lent ${usd(y?.lent ?? "0")}`, value: Number(y?.lent ?? 0), color: ROLE_COLOR.lender },
        { label: `Idle ${usd(idle)}`, value: Number(idle ?? 0), color: "var(--accent)" },
      ]}
    />
  );
}

function Strategies({ y }: { y?: LenderYield }) {
  const creditOn = !!y && (!!y.strategies.credit || y.tier !== "none");
  const baseOn = !!y && (!!y.strategies.base || y.baseApr > 0);
  return (
    <div className={d.strategies}>
      <div className={d.strategy}>
        <h3>
          Credit strategy <span className={`${a.chip} ${creditOn ? a.chipGood : a.chipIdle}`}>{creditOn ? "Active" : "Off"}</span>
        </h3>
        <p>
          {TIER[y?.tier ?? "none"]} · 1inch Aqua{y?.strategies.credit ? ` · ${shortAddress(y.strategies.credit)}` : ""}
        </p>
        <div className={d.strategyApr}>{creditOn ? `${pct(y!.boostApr)} APR` : "Not offered"}</div>
        <p>Lends against buyer-confirmed invoices; the risk tier is enforced at fill time.</p>
      </div>
      <div className={d.strategy}>
        <h3>
          Base-yield strategy <span className={`${a.chip} ${baseOn ? a.chipGood : a.chipIdle}`}>{baseOn ? "Active" : "Off"}</span>
        </h3>
        <p>USDC / tUSDT · 30 bps swaps{y?.strategies.base ? ` · ${shortAddress(y.strategies.base)}` : ""}</p>
        <div className={d.strategyApr}>{baseOn ? `${pct(y!.baseApr)} APR` : "Not offered"}</div>
        <p>Idle capital earns swap fees while it waits for credit demand.</p>
      </div>
    </div>
  );
}

function PositionTable({ positions, agents, nowMs, compact }: { positions: Position[]; agents: RoleViewProps["agents"]; nowMs: number; compact?: boolean }) {
  if (!positions.length) return <Empty title="No positions yet">When a seller&apos;s invoice fills your credit strategy, the position shows here.</Empty>;
  return (
    <div className={a.tableWrap} style={{ paddingTop: 0 }}>
      <table className={a.table}>
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Seller</th>
            <th className={d.num}>Your principal</th>
            <th className={d.num}>APR</th>
            {!compact && <th className={d.num}>Fee</th>}
            <th>Due</th>
            <th>Status</th>
            {!compact && <th>Proof</th>}
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
              {!compact && <td className={`${d.num} ${a.mono}`}>{usd(p.fee)}</td>}
              <td>
                <DueLabel invoice={p.invoice} nowMs={nowMs} />
              </td>
              <td>
                <StateChip state={p.invoice.state} />
              </td>
              {!compact && (
                <td>
                  <Proof url={p.invoice.proofUrl} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Lender console: capital, how much is lent to sellers, the return it earns, its liquidity across strategies and its positions. */
export function LenderPage({ view, ...p }: RoleViewProps & { view: string }) {
  const { me, agents, lenders, mine, wallet, nowMs, go } = p;
  const y = lenderOf(lenders, me.address);
  const positions = useMemo(() => lenderPositions(mine, me.address), [mine, me.address]);
  const open = positions.filter((x) => x.invoice.state === "Financed" || x.invoice.state === "Overdue").length;
  const late = positions.filter((x) => x.invoice.state === "Overdue" || x.invoice.state === "Defaulted").length;
  const idle = y?.idle ?? wallet.usdc;
  const earned = y ? addU(y.creditFees, y.baseFees) : "0";
  const kpis = <Kpis y={y} idle={idle} earned={earned} open={open} late={late} me={me} />;
  const returns = (
    <KV
      strong
      rows={[
        { label: "Credit fees", value: usd(y?.creditFees ?? "0"), hint: "interest from sellers, repaid first" },
        { label: "Swap fees", value: usd(y?.baseFees ?? "0"), hint: "from the base-yield strategy" },
        { label: "Total earned", value: usd(earned) },
        { label: "Return on capital", value: pct(me.lenderReturnPct) },
        { label: "Defaults on your positions", value: String(positions.filter((x) => x.invoice.state === "Defaulted").length) },
      ]}
    />
  );

  switch (view) {
    case "liquidity":
      return (
        <>
          {kpis}
          <div className={d.split}>
            <Panel title="Strategies" description="Published on 1inch Aqua; one wallet backs both">
              <Allocation y={y} idle={idle} />
              <Strategies y={y} />
            </Panel>
            <WalletPanel {...p} />
          </div>
        </>
      );
    case "positions":
      return (
        <Panel title="Positions" description={`${positions.length} invoice${positions.length === 1 ? "" : "s"} you funded`} flush>
          <PositionTable positions={positions} agents={agents} nowMs={nowMs} />
        </Panel>
      );
    case "returns":
      return (
        <>
          {kpis}
          <div className={d.grid2}>
            <Panel title="Earnings" description="Paid on-chain by the repayment router">
              {returns}
            </Panel>
            <Panel title="Return rates" description="Annualised">
              <KV
                rows={[
                  { label: "Base-yield APR", value: pct(y?.baseApr ?? 0), hint: "swap fees on idle capital" },
                  { label: "Credit APR", value: pct(y?.boostApr ?? 0), hint: `${TIER[y?.tier ?? "none"]} tier` },
                  { label: "Blended APR", value: pct(y?.blendedApr ?? 0), hint: "weighted by idle and lent capital" },
                ]}
              />
            </Panel>
          </div>
        </>
      );
    default:
      return (
        <>
          {kpis}
          <div className={d.grid2}>
            <AgentDetails {...p} lenders={lenders} />
            <WalletPanel {...p} />
          </div>
          <div className={d.split}>
            <Panel title="Liquidity" description="Where your capital is right now" more={{ label: "Strategies", onClick: () => go("liquidity") }}>
              <Allocation y={y} idle={idle} />
              <Strategies y={y} />
            </Panel>
            <div className={d.stack}>
              <Panel title="Returns" description="Fees earned so far" more={{ label: "Return details", onClick: () => go("returns") }}>
                {returns}
              </Panel>
              <Connections {...p} />
            </div>
          </div>
          <Panel title="Recent positions" description="Latest three" flush className={d.section} more={{ label: `All ${positions.length} positions`, onClick: () => go("positions") }}>
            <PositionTable positions={positions.slice(0, 3)} agents={agents} nowMs={nowMs} compact />
          </Panel>
          <div className={d.grid2}>
            <RecentCalls {...p} more={{ label: "Open the activity log", onClick: () => go("activity") }} />
            <ToolUsage {...p} />
          </div>
        </>
      );
  }
}
